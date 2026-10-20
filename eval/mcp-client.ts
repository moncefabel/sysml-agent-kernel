import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ToolEndpoint } from './agents.js';

const SERVER = fileURLToPath(new URL('../src/mcp-server.js', import.meta.url));

/**
 * The tool catalog reached through the real MCP server: spawns `mcp-server` over stdio with
 * the official SDK client, so the agent loop exercises the deployed path end to end. The
 * server keeps the authoritative model; the client reads back the server's audit file after
 * each call and the saved model at the end, so the harness can apply the same checks.
 */
export class McpToolClient implements ToolEndpoint {
  readonly auditTrail: Array<Record<string, unknown>> = [];
  private auditOffset = 0;

  private constructor(
    private readonly client: Client,
    private readonly transport: StdioClientTransport,
    private readonly dir: string,
    private readonly tools: Array<{ name: string; description: string; input_schema: unknown }>,
    readonly stderr: string[],
  ) {}

  private get modelFile() { return join(this.dir, 'model.sysml'); }
  private get auditFile() { return join(this.dir, 'audit.jsonl'); }
  get pid(): number | null { return this.transport.pid; }

  static async start(model: string, opts: { catalog?: 'large' } = {}): Promise<McpToolClient> {
    const dir = mkdtempSync(join(tmpdir(), 'sysml-mcp-'));
    writeFileSync(join(dir, 'model.sysml'), model);
    const args = [SERVER, join(dir, 'model.sysml'), '--mode', 'write', '--audit', join(dir, 'audit.jsonl'), '--save', ...(opts.catalog ? ['--catalog', opts.catalog] : [])];
    const transport = new StdioClientTransport({ command: process.execPath, args, stderr: 'pipe' });
    const stderr: string[] = [];
    transport.stderr?.on('data', (d) => stderr.push(String(d)));
    const client = new Client({ name: 'sysml-agent-eval', version: '0.1.0' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    // The server adds a $schema key to each input schema; the in-process catalog strips the
    // same key (ToolHost.toolDefinitions), so stripping it here keeps both catalogs identical.
    const defs = tools.map((t) => {
      const { $schema, ...input_schema } = t.inputSchema as Record<string, unknown>;
      return { name: t.name, description: t.description ?? '', input_schema };
    });
    return new McpToolClient(client, transport, dir, defs, stderr);
  }

  toolDefinitions() { return this.tools; }

  async call(name: string, args: unknown): Promise<unknown> {
    const res = await this.client.callTool({ name, arguments: (args ?? {}) as Record<string, unknown> });
    const text = (res.content as Array<{ type: string; text?: string }>)?.[0]?.text ?? '';
    const fresh = this.readAudit();
    if (res.isError && text.startsWith('MCP error')) {
      // The SDK rejected the call before the kernel saw it (unknown tool, schema mismatch), so
      // the server audited nothing. Record it here so no attempt disappears from the metrics.
      const result = { error: { code: 'MCP_ERROR', message: text } };
      this.auditTrail.push({ ts: new Date().toISOString(), tool: name, args, outcome: 'error:MCP_ERROR', recordedBy: 'mcp-client' });
      return result;
    }
    this.auditTrail.push(...fresh);
    return JSON.parse(text);
  }

  private readAudit(): Array<Record<string, unknown>> {
    if (!existsSync(this.auditFile)) return [];
    const all = readFileSync(this.auditFile, 'utf8');
    const lines = all.slice(this.auditOffset).split('\n').filter(Boolean);
    this.auditOffset = all.length;
    return lines.map((l) => JSON.parse(l));
  }

  /** Stops the server and returns the model it last saved. */
  async close(): Promise<string> {
    const finalModel = readFileSync(this.modelFile, 'utf8');
    await this.client.close();
    rmSync(this.dir, { recursive: true, force: true });
    return finalModel;
  }
}
