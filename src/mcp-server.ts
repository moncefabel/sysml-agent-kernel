#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Workspace } from './workspace.js';
import { DEFAULT_POLICY, descriptions, largeDescriptions, largeSchemas, READ_TOOLS, schemas, ToolHost, type LargeToolName, type PermissionMode, type ToolName } from './tools.js';

// Usage: node dist/src/mcp-server.js <model.sysml> [--mode read_only|propose|write] [--audit audit.jsonl] [--save] [--catalog large]
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && !['read_only', 'propose', 'write', 'large'].includes(a) && !a.endsWith('.jsonl'));
if (!file) { console.error('usage: mcp-server <model.sysml> [--mode m] [--audit f] [--save]'); process.exit(1); }
const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

const mode = (flag('--mode') ?? 'write') as PermissionMode;
const catalog = flag('--catalog') === 'large' ? 'large' as const : undefined;
const host = new ToolHost(new Workspace(readFileSync(file, 'utf8')), { ...DEFAULT_POLICY, mode, auditFile: flag('--audit'), ...(catalog ? { catalog } : {}) });
const save = args.includes('--save');

const server = new McpServer({ name: 'sysml-agent-kernel', version: '0.1.0' });

for (const name of Object.keys(schemas) as ToolName[]) {
  if (mode === 'read_only' && !READ_TOOLS.has(name)) continue;
  server.registerTool(
    name,
    {
      description: descriptions[name],
      inputSchema: schemas[name].shape,
      annotations: { readOnlyHint: READ_TOOLS.has(name), destructiveHint: name === 'sysml_apply_edits' },
    },
    async (input: unknown) => {
      const result: any = host.call(name, input);
      if (save && result?.status === 'committed') writeFileSync(file, host.ws.text());
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        isError: Boolean(result?.error) || result?.status === 'rejected',
      };
    },
  );
}

// The large catalog adds sysml_find_elements, served by the same ToolHost (policy, audit).
if (catalog === 'large') for (const name of Object.keys(largeSchemas) as LargeToolName[]) {
  server.registerTool(
    name,
    { description: largeDescriptions[name], inputSchema: largeSchemas[name].shape, annotations: { readOnlyHint: true, destructiveHint: false } },
    async (input: unknown) => {
      const result: any = host.call(name, input);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }], isError: Boolean(result?.error) };
    },
  );
}

await server.connect(new StdioServerTransport());
console.error(`sysml-agent-kernel MCP server on stdio (mode=${mode}, file=${file})`);
