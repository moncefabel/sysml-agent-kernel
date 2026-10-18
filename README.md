# sysml-agent-kernel

A deterministic SysML v2 kernel that LLM agents can safely operate on.

The LLM proposes, the kernel decides. The agent never writes raw text into the model: it sends typed edit operations, the kernel applies them as one transaction on a copy, re-runs semantic validation, and commits only if no new error appears. Otherwise the whole transaction is rolled back and the agent receives structured, machine-usable errors with repair hints.

```
              LLM agent (probabilistic)
                       |
            typed tool calls (JSON Schema)
                       |
   +-------------------v--------------------+
   |  ToolHost: contracts, policy, audit    |   read_only / propose / write
   +-------------------+--------------------+   blast radius limits, HITL approval
                       |
   +-------------------v--------------------+
   |  Workspace: atomic transactions        |   apply on copy -> validate -> commit
   |  rollback, undo, optimistic versions   |   or reject with introduced errors
   +-------------------+--------------------+
                       |
   +---------+---------+----------+---------+
   | parser  | semantic validator | context |   deterministic, side effect free
   | printer | name resolution    | slicing |
   +---------+--------------------+---------+
```

The same tool catalog is served over **MCP** (stdio) and used by the **evaluation harness**, so what is evaluated is exactly what is deployed.

## What it covers

**Language.** A pragmatic subset of the SysML v2 textual notation: `package`, `import`, `doc`, `part def` / `part`, `port def` / `port` (with `~` conjugation), `attribute def` / `attribute` (with defaults), `requirement def` / `requirement`, `connect ... to ...`, `satisfy ... by ...`, specialization `:>`, multiplicities `[4]`. Canonical printer with a round trip guarantee (tested).

**Semantic validation** (`src/semantic.ts`), each diagnostic carrying a code, a qualified path, a span and a hint:

| Code | Rule |
|------|------|
| E101 | Unresolved type or specialization (hint: closest names) |
| E102 | Duplicate name in a namespace |
| E103 | Connection end does not resolve (hint: features available there) |
| E104 | Connection end is not a port |
| E105 | Connected port types differ |
| E106 | Invalid satisfy (requirement or subject) |
| E107 | Usage typed by the wrong kind of definition |
| W201 | Both connection ends have the same direction |
| W202 | Requirement not satisfied by any element |
| W203 | Attribute value inconsistent with its type |

Name resolution handles nested namespaces, imports (`X::*` and single), and features inherited through `:>`.

**Typed edit operations** (`add`, `remove`, `rename`, `set`), validated by Zod before reaching the kernel. `rename` rewrites every reference that resolves to the renamed element, prefix by prefix, so `tank.fuelOut` follows a rename of `tank` and `~FuelPort` follows a rename of `FuelPort`.

**Context engineering for large models.** `sysml_context_slice` builds a character-budgeted window around an element (the element, the definitions it depends on, its owner, then what references it, breadth first). It relies on a reverse-reference index built in one pass and cached, which took slicing on an 8,000 element model from 4.2 s to 0.18 s.

**Guardrails.**
- Permission modes: `read_only` (write tools are not even advertised), `propose` (edits are dry-run and staged; approval is a host API, deliberately not an agent tool), `write`.
- Blast radius limits on removals and operations per transaction.
- Optimistic concurrency through `expectedVersion`.
- Doc comment text is flagged in tool results as untrusted data (prompt injection surface), and there is an evaluation scenario for it.
- JSONL audit trail of every call: tool, arguments, model version, outcome, latency.

## Tools

| Tool | Kind | Purpose |
|------|------|---------|
| `sysml_outline` | read | Containment tree with paths, kinds, types |
| `sysml_get` | read | Source of one element |
| `sysml_validate` | read | Structured diagnostics |
| `sysml_find_references` | read | Who uses this element |
| `sysml_context_slice` | read | Budgeted context window |
| `sysml_apply_edits` | write | Atomic transaction of typed operations, with dry run |

## Run it

```bash
npm install
npm test          # 32 tests: kernel (14) plus agent loop, cache, budget, checkpoint, Groq adapter (18), all offline
npm run eval      # scripted baseline over the scenario suite
npm run bench     # parse / validate / transaction / slice timings
npm run estimate  # offline token estimate of a full LLM run, no network
```

MCP server (works with any MCP client, e.g. Claude Desktop or an IDE agent):

```bash
npm run build
node dist/src/mcp-server.js examples/vehicle.sysml --mode propose --audit audit.jsonl
```

Evaluate a real LLM agent on the same scenarios (Groq, OpenAI compatible tool calling). The key and the model come from the environment only:

```bash
export GROQ_API_KEY=...   # never committed, never logged, redacted from every error
export GROQ_MODEL=...     # any Groq model that supports tool calling
npm run build
node dist/eval/run.js --agent groq                      # resumes automatically from the checkpoint
node dist/eval/run.js --agent groq --run-budget 100000  # stop cleanly after this many billed tokens
node dist/eval/run.js --agent groq --replay-only        # cache only, guaranteed zero network calls
```

Options: `--max-turns` (12), `--max-output-tokens` (1024), `--scenario-budget` (60000 tokens), `--run-budget`, `--cache-dir` (`eval/cache`), `--no-cache`, `--fresh` (discard the checkpoint).

## Evaluation

Each scenario defines an initial model, a task in natural language, deterministic success checks and a reference trajectory. The checks only look at the final model, and they are the same for the scripted baseline and for any LLM.

Metrics per scenario: success, LLM turns, tool calls, committed and rejected transactions, rollbacks (transactions applied to a draft then discarded), structured errors received, self-correction, policy blocks, prompt / completion / billed tokens, cache hits, LLM latency. The report and the full audit trail land in `eval/reports/`.

Self-correction is reported as a count, `k/n`: of the `n` scenarios where the agent received at least one structured error (kernel rejection, invalid arguments, malformed tool call), `k` still ended in success. Scenarios with no error are excluded from `n` rather than counted as corrected.

**Agent loop** (`eval/llm/loop.ts`). The model gets the system prompt, the task and the tool catalog; each tool call goes through `ToolHost.call`, the same entry point as MCP, and the kernel result (including rejections and hints) goes back verbatim. The loop stops when the model ends a turn without a tool call, or on the turn limit, the scenario token budget or the run budget. It never reads the success checks, so stopping cannot leak the oracle into the agent.

**Reproducibility.** Temperature 0, plus a content-addressed response cache keyed on provider, model, messages, tools and sampling parameters. Since the kernel is deterministic, a run replayed from the cache rebuilds the same trajectory and report offline. Each completed scenario is appended to a JSONL checkpoint whose header fingerprints the configuration; a crash or a run budget stop is not recorded, so the next invocation runs that scenario again, mostly from the cache.

**Budgets.** Before each call the loop reserves an estimate (request characters / 4, plus the full output allowance) and stops cleanly if the reservation does not fit. Real usage from the API response is then recorded. Cache hits count against the scenario budget (so a replay stops where the original run stopped) but not against the run budget (they cost nothing).

| Scenario | Category | What it tests |
|----------|----------|---------------|
| add-brake-subsystem | edit | Multi-op transaction creating a definition and its usage |
| repair-broken-model | repair | Fixing errors from diagnostics without deleting parts |
| satisfy-new-requirement | edit | Requirement traceability |
| rename-port-definition | refactor | Reference-preserving rename |
| guarded-delete | repair | Naive delete is rejected, agent must repair the transaction |
| prompt-injection-in-doc | security | Malicious instruction hidden in a doc comment must be ignored |

The scripted baseline passes 6/6 and validates the harness. No LLM result is reported here yet: numbers will be added only from real, cached and reproducible runs.

## Benchmarks

Synthetic models on a CPU container, Node 22:

| Elements | Parse | Validate | Transaction | Context slice |
|---------:|------:|---------:|------------:|--------------:|
| ~2,000 | 47 ms | 19 ms | 103 ms | 43 ms |
| ~8,000 | 57 ms | 35 ms | 139 ms | 178 ms |

The transaction cost is dominated by the full re-validation and the print/reparse round trip; incremental validation scoped to the changed namespaces is the obvious next step.

## Limitations and next steps

- Subset of SysML v2 only, not the full KerML grammar. A natural next step is to plug the agent layer on a complete implementation (the OMG pilot implementation or a Langium based language server) behind the same tool contracts.
- Incremental validation and indexing instead of full passes.
- Expose diagnostics through LSP so the same kernel serves the IDE and the agent.
- Multi-agent orchestration (planner / editor / reviewer) on top of the transaction layer, with asynchronous runs and resumption from the audit log.

## Layout

```
src/        lexer, parser, printer, semantic validator, workspace (transactions),
            context engine, tool catalog with policy and audit, MCP server
eval/       scenarios, harness (checks, metrics), runner, checkpoint, estimate, bench,
            agents (scripted baseline, Anthropic loop)
eval/llm/   provider interface, Groq adapter, agent loop, cache, token budget, mocks
test/       node:test suite
examples/   vehicle.sysml
```

MIT license.
