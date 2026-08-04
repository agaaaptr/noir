# S4 SDD Engine — Manual Acceptance Checklist

> **Living document.** This checklist validates that the SDD lifecycle engine runs end-to-end on a real task, gates record observable decisions, state survives daemon restart, and `--force` / quick mode work. Follow each step; check the box when satisfied.

**Reference:** S4 spec (`docs/internal/specs/2026-07-24-s4-sdd-engine-design.md`) and implementation (`packages/workflow/`, `packages/daemon/src/workflow-seam.ts`, `packages/daemon/src/server.ts`).

---

## Prerequisites

- [ ] Noir toolkit built: `pnpm build` (all packages compile).
- [ ] Tests green: `pnpm test` (117/117 tests pass).
- [ ] Daemon starts: `node packages/cli/dist/bin.js daemon start` (listen on HTTP, stdio fallback).
- [ ] MCP server connects: `node packages/cli/dist/bin.js mcp serve --stdio` (tools round-trip).

---

## 1. Lifecycle end-to-end (Full mode)

**Goal:** Start a task, advance through all 7 phases, approve each gate, and observe the audit trail.

> **Note on artifacts:** The engine's `advance()` does NOT auto-write `.noir/specs/`, `.noir/plans/`, or `.noir/tasks/` files in Full mode — it only advances state + records gates to the audit. Artifact files are written via explicit `ArtifactWriter` calls (`writeSpec`, `writePlan`, etc.) or by `runQuick` (which writes a stub spec). To validate artifact creation, call the `ArtifactWriter` functions explicitly after advancing to the corresponding phase.

### 1.1 Start a task

```bash
# From a fresh project directory (e.g., /tmp/test-noir)
cd /tmp/test-noir
node /path/to/noir/packages/cli/dist/bin.js init  # creates .noir/

# Start the Noir daemon (if not already running)
node /path/to/noir/packages/cli/dist/bin.js daemon start
```

Use the MCP tool `workflow_status` (no args) — should report `{ok: false, error: 'no active task'}`.

Start a task via the CLI (or direct engine call; the CLI wrapper is S5, so use the engine API for this acceptance test):

```typescript
import { Store, openStore } from '@noir-ai/store';
import { WorkflowEngine } from '@noir-ai/workflow';

const store = await openStore({ projectId: 'test-s4', root: '/tmp/test-noir' });
const engine = new WorkflowEngine(store, '/tmp/test-noir', 'test-s4');

// Start a task in Full mode
const task = await engine.startTask('task-1', 'test-s4-full', 'full');
console.log('Task started:', task);
```

**Check:**
- [ ] Task state is `{state: 'draft', phase: 'intake', mode: 'full', history: []}`.
- [ ] `workflow:active` in store KV is `'task-1'`.
- [ ] `workflow_status` returns `{ok: true, taskId: 'task-1', phase: 'intake', ...}`.

### 1.2 Advance through phases

Advance through each phase, calling `engine.advance(taskId)`:

```typescript
// intake → clarify (no gate)
await engine.advance('task-1');
// clarify → spec (no gate; spec gate is at the END of spec phase)
await engine.advance('task-1');
```

**Check at each step:**
- [ ] Phase increments correctly (`intake` → `clarify` → `spec` → `plan` → `execute` → `verify` → `document`).
- [ ] `workflow_status` reflects the current phase and state.
- [ ] `.noir/specs/task-1-test-s4-full.md` is created (artifact write).
- [ ] `.noir/plans/task-1-test-s4-full.md` is created when entering `plan` phase.

### 1.3 Gates record observable decisions

At the three gates (spec, plan, verify), observe the gate decision in the audit log:

```typescript
// After advancing past spec gate (should be 'approved' by default)
const status = engine.status('task-1');
console.log('Gate history:', status.history);
```

**Check:**
- [ ] `history` array has 3 entries after completing all gates.
- [ ] Each gate entry is `{phase: 'spec'|'plan'|'verify', decision: 'approved', at: <timestamp>}`.
- [ ] Store KV `audit:task-1` contains the same `GateResult[]` (source of truth).
- [ ] `.noir/audit/task-1.json` export exists (if audit export is wired in T3).

### 1.4 Terminal state

Advance to the final phase (`document`) and confirm the task is done:

```typescript
await engine.advance('task-1'); // verify → document (verify gate fires)
const final = engine.status('task-1');
console.log('Final state:', final);
```

**Check:**
- [ ] Final state is `{state: 'done', phase: 'document'}`.
- [ ] `nextGate` in `workflow_status` is `null` (no more gates).
- [ ] All artifacts exist: spec, plan, task doc, decision log, audit export.

---

## 2. Observable gates (Force, Skip, Jump)

**Goal:** Verify that gates are escapable and that every escape is recorded (never silently dropped).

### 2.1 `--force` passes a gate with reason

```typescript
// Start a new task, advance to spec phase
await engine.startTask('task-2', 'test-force', 'full');
await engine.advance('task-2'); // intake → clarify
await engine.advance('task-2'); // clarify → spec

// Force past spec gate (requires a reason)
await engine.advance('task-2', { force: { reason: 'time constraints' } });
```

**Check:**
- [ ] Gate history contains `{phase: 'spec', decision: 'forced', reason: 'time constraints', at: <timestamp>}`.
- [ ] Task lands in `specified` state (spec gate admits entry).
- [ ] Reason is non-empty (engine validation enforces this).

### 2.2 `--skip` records a skipped gate (Quick mode uses this)

```typescript
// Start a task in Quick mode (or use runQuick helper)
await engine.startTask('task-3', 'test-quick', 'quick');
// Or: await runQuick(engine, 'task-3');

// Quick mode internally calls advance with skip: true for spec/plan gates
const status = engine.status('task-3');
console.log('Gate history:', status.history);
```

**Check:**
- [ ] Gate history contains `{phase: 'spec', decision: 'skipped', at: <timestamp>}`.
- [ ] Gate history contains `{phase: 'plan', decision: 'skipped', at: <timestamp>}`.
- [ ] Verify gate is NOT in history yet (it fires later when task reaches `done`).
- [ ] Task state is `executing` (quick mode fast-forwards to execute).

### 2.3 `--to <phase>` jumps directly

```typescript
// Start a task, jump directly to execute phase
await engine.startTask('task-4', 'test-jump', 'full');
await engine.advance('task-4', { to: 'execute' });
const status = engine.status('task-4');
```

**Check:**
- [ ] Task lands in `executing` state (jumpEntry recorded).
- [ ] `jumpEntry` field on TaskState is `'execute'`.
- [ ] Phase is `execute`, state is `executing`.

---

## 3. Resume across daemon restart

**Goal:** Verify that state survives a daemon restart and the active task can be resumed.

### 3.1 Start a task and checkpoint

```typescript
// Start a task, advance partway through
await engine.startTask('task-5', 'test-resume', 'full');
await engine.advance('task-5'); // intake → clarify
await engine.advance('task-5'); // clarify → spec
await engine.advance('task-5'); // spec (gate fires → specified)

// Use the MCP checkpoint tool (or direct engine call)
// {action: 'save'} flushes state to store KV (engine.persist already does this on each advance)
const saved = engine.checkpoint('task-5');
console.log('Checkpoint saved:', saved);
```

**Check:**
- [ ] `workflow:active` is `'task-5'`.
- [ ] `workflow:task-5` contains the full TaskState (including `history`).
- [ ] `audit:task-5` contains the gate decision.

### 3.2 Restart the daemon

```bash
# Stop the daemon
pkill -f 'noir.*daemon'

# Start it again
node /path/to/noir/packages/cli/dist/bin.js daemon start
```

**Check:**
- [ ] Daemon starts without errors (HTTP server listens).
- [ ] Store reopens (same `.noir/store/test-s4.db` file).

### 3.3 Resume the task

```typescript
// After daemon restart, rebuild the engine (new engine instance, same store)
const storeAfterRestart = await openStore({ projectId: 'test-s4', root: '/tmp/test-noir' });
const engineAfterRestart = new WorkflowEngine(storeAfterRestart, '/tmp/test-noir', 'test-s4');

// Resume via the store KV (read workflow:active → workflow:<taskId>)
import { resumeTask } from '@noir-ai/workflow/modes';
const resumed = await resumeTask(storeAfterRestart);
console.log('Resumed task:', resumed);
```

**Check:**
- [ ] `resumed` is non-null (active task exists and is not terminal).
- [ ] `resumed.phase` is `'spec'` (or wherever the task was before restart).
- [ ] `resumed.history` matches the pre-restart history (audit survived).
- [ ] `workflow_status` (via MCP) returns the same state.

---

## 4. Quick mode (discipline lite)

**Goal:** Verify quick mode stubs the spec, skips spec/plan gates, and leaves verify gate intact.

### 4.1 Run a task in quick mode

```typescript
import { runQuick } from '@noir-ai/workflow/modes';

await engine.startTask('task-6', 'test-quick-mode', 'quick');
await runQuick(engine, 'task-6');
const status = engine.status('task-6');
console.log('Quick mode task:', status);
```

**Check:**
- [ ] Task state is `executing`.
- [ ] `.noir/specs/task-6-test-quick-mode.md` exists and contains `'<quick-mode stub spec>'` (or custom body if `specBody` passed).
- [ ] Gate history has 2 entries: `{phase: 'spec', decision: 'skipped'}` and `{phase: 'plan', decision: 'skipped'}`.
- [ ] Verify gate is NOT in history (will fire later when task reaches `done`).

### 4.2 Complete the task (verify gate fires as approved)

```typescript
// Advance through execute, verify, document
await engine.advance('task-6'); // executing → verifying
await engine.advance('task-6'); // verify gate fires → done (verify gate: 'approved')
await engine.advance('task-6'); // done → document (no gate)
const final = engine.status('task-6');
```

**Check:**
- [ ] Final state is `done`, phase is `document`.
- [ ] Gate history has 3 entries: spec (skipped), plan (skipped), verify (approved).
- [ ] Verify gate decision is `'approved'` (quick mode only skips spec/plan).

---

## 5. MCP tools round-trip

**Goal:** Verify the 2 MCP tools (`workflow_status`, `checkpoint`) work over stdio/HTTP.

### 5.1 `workflow_status` tool

Call the MCP tool (no args for active task, or pass `taskId`):

```json
// Request
{"name": "workflow_status", "arguments": {}}

// Response
{
  "ok": true,
  "taskId": "task-1",
  "phase": "document",
  "state": "done",
  "nextGate": null,
  "mode": "full",
  "history": [...],
  "updatedAt": 1721789123456,
  "degraded": false
}
```

**Check:**
- [ ] Tool returns `{ok: true, ...}` for a known task.
- [ ] Tool returns `{ok: false, error: 'no active task'}` when no active task.
- [ ] Tool returns `{ok: false, taskId: 'unknown', error: 'unknown task'}` for unknown taskId.
- [ ] `nextGate` is `null` for `done`/`blocked`/`abandoned` tasks.
- [ ] `degraded` matches `store_status.degraded` (true when daemon down, store is read-only).

### 5.2 `checkpoint` tool

Call the MCP tool with `action: 'save'` or `action: 'restore'`:

```json
// Save (flush state)
{"name": "checkpoint", "arguments": {"action": "save"}}

// Restore (read state)
{"name": "checkpoint", "arguments": {"action": "restore"}}
```

**Check:**
- [ ] `save` returns the flushed TaskState (same as `workflow_status`).
- [ ] `restore` returns the TaskState (reads from store KV).
- [ ] Both tools respect `taskId` (default to active task if omitted).
- [ ] `save` throws `"store is read-only (daemon down)"` when store is degraded (caught and surfaced as `{ok: false, error: '...'}`).

---

## 6. Full pipeline validation

**Goal:** Confirm the entire S4 implementation passes lint, typecheck, build, and test.

Run the full pipeline:

```bash
cd /path/to/noir
pnpm lint       # Biome lint (should pass)
pnpm typecheck  # TypeScript tsc (should pass)
pnpm build      # Build all packages (should succeed)
pnpm test       # Vitest unit + integration (117/117 tests green)
```

**Check:**
- [ ] `pnpm lint` exits 0 (no Biome errors).
- [ ] `pnpm typecheck` exits 0 (no TS errors).
- [ ] `pnpm build` succeeds (all packages emit dist/).
- [ ] `pnpm test` reports 117 tests pass (exact count from S4-T1…T6).
- [ ] No warnings or skipped tests.

---

## Final acceptance

- [ ] All lifecycle phases execute in order (Full mode).
- [ ] Gates record observable decisions (`approved`/`forced`/`skipped`).
- [ ] `--force` requires a reason; `--skip` records `skipped`; `--to <phase>` jumps and records `jumpEntry`.
- [ ] Quick mode stubs spec, skips spec/plan gates, verify gate fires as `approved`.
- [ ] State survives daemon restart (resume via `workflow:active` + `workflow:<taskId>`).
- [ ] MCP tools `workflow_status` and `checkpoint` round-trip over stdio/HTTP.
- [ ] Full pipeline green (lint + typecheck + build + test).
- [ ] No scope creep (S4 scope: FSM + gates + audit + modes + MCP; no LLM drafting, no CLI wrapper).

**S4 is accepted when all checkboxes are satisfied.**

---

## Notes for the reviewer

- **Observable checkpoint invariant:** Every gate decision is recorded (`approved`/`forced`/`skipped`) in both `TaskState.history` (in-process view) and store KV `audit:<taskId>` (source of truth). The `.noir/audit/` export is a later helper (T3).
- **Gates are escapable, never blocking:** The engine never halts on a gate; it records the decision and advances. Blocking is a host/policy concern (S5), not engine responsibility.
- **Store discipline:** The engine uses only the public Store API (`getState`/`setState`); it never reaches into store internals. S1 established this contract.
- **MCP tool naming:** Tools are `checkpoint` and `workflow_status` (no dots — MCP spec `^[a-zA-Z0-9_-]+$`).
- **stdout discipline:** No stdout in engine/MCP paths (stderr only for errors).
- **Type consistency:** `Phase`, `WorkflowState`, `GateResult`, `TaskState` are consistent across all tasks (T1–T6).
