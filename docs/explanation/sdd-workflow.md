# Spec-Driven Development Workflow

Noir's SDD engine (`@noir-ai/workflow`) is a hand-rolled FSM that enforces discipline without getting in the way. Every gate decision is recorded; every gate is escapable.

## Lifecycle (7 phases)

```
intake → clarify → spec → plan → execute → verify → document
```

| Phase | Artifact | Purpose |
|---|---|---|
| **Intake** | `.noir/tasks/<id>-<slug>/intake.md` | What & why — user story, scope, constraints |
| **Clarify** | (refines intake) | Resolve ambiguities before committing to a spec |
| **Spec** | `.noir/tasks/<id>-<slug>/spec.md` | Technical specification — architecture, data model, API contract |
| **Plan** | `.noir/tasks/<id>-<slug>/plan.md` | Implementation plan — steps, dependencies, risk assessment |
| **Execute** | `.noir/tasks/<id>-<slug>/task.md` | Build it — code, tests, documentation |
| **Verify** | (gated) | Run tests, validate against spec acceptance criteria |
| **Document** | (gated) | Finalize changelog, decisions, cleanup |

## Modes

- **full (default)** — Every gate fires. Spec, plan, and verify are authored AND reviewed. For real features or risky changes.
- **quick** — Spec and plan are skipped (stubs written). Verify still fires. For small/trivial/spike tasks. Override per task: `noir task new --slug <s> --mode quick`.

## Gates (3 decision points)

Gates fire at the transition INTO a phase and record a `GateResult` in the audit KV:

| Gate | Transition | Decision options |
|---|---|---|
| **spec gate** | clarify → spec | `approved` / `forced` (--force <reason>) / `skipped` (quick) |
| **plan gate** | spec → plan | `approved` / `forced` / `skipped` |
| **verify gate** | execute → verify | `approved` / `forced` / `skipped` |

Each decision is timestamped and auditable. `--force <reason>` bypasses soft checks (like the PRD recommendation) while recording the rationale. Quick mode skips gates transparently.

## Task states (9)

| State | Phase | Legal transitions |
|---|---|---|
| `draft` | intake | → clarifying |
| `clarifying` | clarify | → specified |
| `specified` | spec | → planned |
| `planned` | plan | → executing |
| `executing` | execute | → verifying |
| `verifying` | verify | → done |
| `done` | document | (terminal) |
| `blocked` | (set directly) | → any phase |
| `abandoned` | (set directly) | (terminal) |

## PRD recommendation (soft gate)

For `feature` and `epic` task classes in full mode: if no `.noir/prd/<id>-<slug>.md` exists when entering the spec phase, the engine surfaces an observable recommendation. You can:
- Write a PRD via the `noir-prd` skill
- Bypass with `--force <reason>` (records `decision: 'forced'`)

## Transports

Noir's MCP server runs in one of two modes. Independent of the SDD mode above.

| | **stdio** (default) | **daemon** (persistent HTTP) |
|---|---|---|
| **Lifecycle** | Host spawns per session | Long-lived, survives sessions |
| **Setup** | Zero — `noir init` writes `.mcp.json` | `noir daemon start` on a fixed port |
| **CLI access** | Store-touching commands auto-start daemon | Host + CLI share one server |
| **Use case** | Almost everyone | Persistent server, multi-session |

## Engine API

The `WorkflowEngine` class (`@noir-ai/workflow`) exposes:
- `startTask(taskId, slug, mode, taskClass?)` — create task at draft/intake
- `advance(taskId, opts?)` — advance phase or jump with `opts.to`
- `status(taskId)` — read persisted TaskState
- `activeTaskId()` — current active task
- `checkpoint(taskId)` — flush state + write audit export

## Artifact layout

```
.noir/tasks/<id>-<slug>/
├── intake.md
├── spec.md
├── plan.md
└── task.md
.noir/prd/<id>-<slug>.md          (optional)
.noir/audit/<taskId>.json          (gate audit trail)
```

## MCP tools

The daemon exposes `workflow_status`, `workflow_start`, `workflow_advance`, and `checkpoint` as MCP tools — gated on the engine context.
