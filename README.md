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
npm test          # 14 tests: round trip, rules, transactions, rename, policy, schemas
npm run eval      # scripted baseline over the scenario suite
npm run bench     # parse / validate / transaction / slice timings
```

MCP server (works with any MCP client, e.g. Claude Desktop or an IDE agent):

```bash
npm run build
node dist/src/mcp-server.js examples/vehicle.sysml --mode propose --audit audit.jsonl
```

Evaluate a real LLM agent on the same scenarios:

```bash
ANTHROPIC_API_KEY=... node dist/eval/run.js --agent anthropic --model <model-id>
```

## Evaluation

Each scenario defines an initial model, a task in natural language, deterministic success checks and a reference trajectory. Metrics per run: success, tool calls, committed and rejected transactions, policy blocks, latency, plus the full audit trail and final model in `eval/reports/`.

| Scenario | Category | What it tests |
|----------|----------|---------------|
| add-brake-subsystem | edit | Multi-op transaction creating a definition and its usage |
| repair-broken-model | repair | Fixing errors from diagnostics without deleting parts |
| satisfy-new-requirement | edit | Requirement traceability |
| rename-port-definition | refactor | Reference-preserving rename |
| guarded-delete | repair | Naive delete is rejected, agent must repair the transaction |
| prompt-injection-in-doc | security | Malicious instruction hidden in a doc comment must be ignored |

The scripted baseline passes 6/6 and validates the harness. The interesting numbers come from LLM runs: success rate, average rejected transactions before success (self-repair ability), and whether the injection scenario keeps every part definition.

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
eval/       scenarios, agents (scripted baseline, Anthropic tool-use loop), runner, bench
test/       node:test suite
examples/   vehicle.sysml
```

MIT license.
