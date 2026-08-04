# S4 SDD Workflow Engine Implementation Plan (`@noir-ai/workflow`)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `@noir-ai/workflow` — the opinionated-but-escapable SDD lifecycle engine: a per-task state machine driving `Intake→Clarify→Spec→Plan→Execute→Verify→Document` through **observable, escapable gates**, with Full/Quick/Resume modes, persisted in the store KV + `.noir/` markdown artifacts, surfaced via `noir.checkpoint` + `noir.workflow_status` MCP tools.

**Architecture:** New 6th package `@noir-ai/workflow` (depends `core` + `store`). A hand-rolled FSM (explicit transition table + guards) models task state; gates are programmatic checkpoints recording `{phase, decision, reason?, at}` to the store KV (exported to `.noir/audit/`); an `ArtifactWriter` scaffolds `.noir/{intake,clarifications,specs,plans,tasks,decisions}/` markdown. The daemon constructs a `WorkflowEngine` backed by its store and registers the 2 MCP tools.

**Tech Stack:** TypeScript ESM, vitest, Biome, tsup. Reuses `@noir-ai/core` (ProjectId, paths) + `@noir-ai/store` (KV + audit). No LLM (drafting is S8).

**Spec:** `docs/internal/specs/2026-07-24-s4-sdd-engine-design.md` (OQ-1…6 resolved).

## Global Constraints

(Copied from the S4 spec. Every task implicitly includes these.)

- **Engine location = `@noir-ai/workflow`** (new package; depends `@noir-ai/core` + `@noir-ai/store`). `core` stays I/O-pure. (OQ-1/DS-1)
- **State machine = hand-rolled FSM** (explicit `TRANSITIONS` table + guards; no xstate). (OQ-2/DS-2)
- **Gates = observable + escapable**: a programmatic checkpoint records `GateResult { phase, decision: 'approved'|'forced'|'skipped', reason?, at }` to audit (store KV + `.noir/audit/<taskId>.json`). `--force` requires a reason. (OQ-3/DS-3, §9.1)
- **Persistence:** machine state in **store KV** (`workflow:active`, `workflow:<taskId>`); human artifacts under **`.noir/`** (markdown); audit KV + export. Single source of truth = store + artifacts. (OQ-5/DS-4)
- **Modes:** Full (all gates), Quick (`--quick`: skip→execute, stub spec, still verify), Resume (detect in-flight). (DS-5)
- **MCP surface = `noir.checkpoint` + `noir.workflow_status`** only (authoring tools defer to S8). (OQ-4/DS-6)
- **Document phase = stubs** (CHANGELOG-entry stub, ADR stub via `docs/decisions/` pattern); full generation later. (OQ-6)
- **Module = ESM** (`"type":"module"`, relative `.js`, NodeNext). **TDD:** failing test first.
- **stdout discipline:** no stdout writes in engine/MCP paths.

---

## File Structure

```
packages/
├─ workflow/
│  ├─ package.json            # @noir-ai/workflow  (deps: @noir-ai/core, @noir-ai/store)
│  ├─ tsconfig.json / tsup.config.ts
│  ├─ src/
│  │  ├─ index.ts             # public barrel
│  │  ├─ types.ts             # Phase, State, Mode, GateResult, TaskState, Transition
│  │  ├─ state-machine.ts     # FSM: STATES, TRANSITIONS, canTransition, applyTransition
│  │  ├─ engine.ts            # WorkflowEngine (advance/gate/checkpoint/status)
│  │  ├─ gates.ts             # observable gate checkpoint + audit recording
│  │  ├─ artifacts.ts         # ArtifactWriter (.noir/ markdown scaffolding)
│  │  └─ modes.ts             # Full/Quick/Resume path selection
│  └─ test/
│     ├─ state-machine.test.ts
│     ├─ gates.test.ts
│     ├─ engine.test.ts
│     ├─ modes.test.ts
│     └─ resume.test.ts
└─ (core, store, daemon, adapters, cli — existing)
```

Daemon wiring: `packages/daemon/src/workflow-seam.ts` (construct `WorkflowEngine` from the daemon's store) + register `noir.checkpoint` + `noir.workflow_status` in the server factory.

---

## Task 1: `@noir-ai/workflow` scaffold + types + FSM

**Files:**
- Create: `packages/workflow/{package.json,tsconfig.json,tsup.config.ts}`, `packages/workflow/src/{index.ts,types.ts,state-machine.ts}`, `packages/workflow/test/state-machine.test.ts`

**Interfaces:**
- Consumes (core): `ProjectId`.
- Produces: `Phase`/`WorkflowState` enums; `TRANSITIONS` table; `canTransition(from,to)`, `nextPhase(state)`, `applyTransition(state, input)`.

- [ ] **Step 1: Failing test** (`state-machine.test.ts`):
```ts
import { describe, it, expect } from 'vitest';
import { PHASES, STATES, canTransition, nextPhase, applyTransition } from '../src/state-machine.js';
import type { WorkflowState } from '../src/types.js';

describe('SDD state machine', () => {
  it('lists phases in lifecycle order', () => {
    expect(PHASES).toEqual(['intake','clarify','spec','plan','execute','verify','document']);
  });
  it('advances through the happy path', () => {
    let s: WorkflowState = 'draft';
    for (const target of ['clarifying','specified','planned','executing','verifying','done']) {
      expect(canTransition(s, target)).toBe(true);
      s = applyTransition(s, target);
      expect(s).toBe(target);
    }
  });
  it('rejects illegal transitions (e.g. draft→planned skips spec gate)', () => {
    expect(canTransition('draft', 'planned')).toBe(false);
    expect(() => applyTransition('draft', 'planned')).toThrow(/spec/i);
  });
  it('nextPhase maps spec→plan, plan→execute, verify→document', () => {
    expect(nextPhase('specified')).toBe('planned'); // state -> next
  });
  it('allows terminal/abandoned states', () => {
    expect(STATES).toContain('blocked'); expect(STATES).toContain('abandoned');
  });
});
```

- [ ] **Step 2: Run → FAIL** (`../src/state-machine.js` not found).

- [ ] **Step 3: Implement**

`packages/workflow/package.json`:
```json
{
  "name": "@noir-ai/workflow",
  "version": "0.1.0",
  "license": "MIT",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "files": ["dist"],
  "scripts": { "build": "tsup", "typecheck": "tsc --noEmit" },
  "dependencies": { "@noir-ai/core": "workspace:*", "@noir-ai/store": "workspace:*" }
}
```
`packages/workflow/tsconfig.json` + `tsup.config.ts`: same shape as `store` (extends base; entry `src/index.ts`; esm; dts; no `references` — resolves via pnpm symlink).

`packages/workflow/src/types.ts`:
```ts
import type { ProjectId } from '@noir-ai/core';

export const PHASES = ['intake','clarify','spec','plan','execute','verify','document'] as const;
export type Phase = typeof PHASES[number];

export const STATES = ['draft','clarifying','specified','planned','executing','verifying','done','blocked','abandoned'] as const;
export type WorkflowState = typeof STATES[number];

export type Mode = 'full' | 'quick';

export interface GateResult { phase: Phase; decision: 'approved' | 'forced' | 'skipped'; reason?: string; at: number; }

export interface TaskState {
  taskId: string;
  slug: string;
  projectId: ProjectId;
  state: WorkflowState;
  phase: Phase;
  mode: Mode;
  history: GateResult[];      // gate decisions (audit in-process view)
  jumpEntry?: Phase;          // recorded if a jump-to-phase happened
  updatedAt: number;
}
```

`packages/workflow/src/state-machine.ts`:
```ts
import { STATES, type WorkflowState, type Phase } from './types.js';

// Legal state transitions (happy path + terminal). Gates (spec/plan/verify) are
// modeled as the transition INTO specified/planned/done — the engine records a
// GateResult at that point (see gates.ts).
const TRANSITIONS: Record<WorkflowState, WorkflowState[]> = {
  draft:       ['clarifying'],
  clarifying:  ['specified'],
  specified:   ['planned'],
  planned:     ['executing'],
  executing:   ['verifying'],
  verifying:   ['done'],
  done:        [],
  blocked:     ['draft', 'clarifying', 'specified', 'planned', 'executing', 'verifying'],
  abandoned:   [],
};

export function canTransition(from: WorkflowState, to: WorkflowState): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function applyTransition(from: WorkflowState, to: WorkflowState): WorkflowState {
  if (!canTransition(from, to)) {
    const hint = to === 'planned' ? ' (the spec gate must be passed first)'
      : to === 'executing' ? ' (the plan gate must be passed first)'
      : to === 'done' ? ' (the verify gate must be passed first)' : '';
    throw new Error(`Illegal transition ${from} → ${to}${hint}`);
  }
  return to;
}

// Phase <-> state mapping for the engine.
export function stateForPhase(p: Phase): WorkflowState {
  switch (p) {
    case 'intake': return 'draft';
    case 'clarify': return 'clarifying';
    case 'spec': return 'specified';
    case 'plan': return 'planned';
    case 'execute': return 'executing';
    case 'verify': return 'verifying';
    case 'document': return 'done';
  }
}
export function nextPhase(state: WorkflowState): Phase | null {
  const map: Partial<Record<WorkflowState, Phase>> = {
    draft: 'clarify', clarifying: 'spec', specified: 'plan', planned: 'execute', executing: 'verify', verifying: 'document',
  };
  return map[state] ?? null;
}
```
`packages/workflow/src/index.ts`:
```ts
export { PHASES, STATES, canTransition, applyTransition, stateForPhase, nextPhase } from './state-machine.js';
export type { Phase, WorkflowState, Mode, GateResult, TaskState } from './types.js';
```

- [ ] **Step 4: Run → PASS**; `pnpm typecheck`; `pnpm lint`. (`pnpm install` to link the new package first.)

- [ ] **Step 5: Commit** — `feat(workflow): scaffold @noir-ai/workflow + SDD state machine`

---

## Task 2: Observable gates + audit recording

**Files:** Create `packages/workflow/src/{gates.ts}`, `packages/workflow/test/gates.test.ts`; modify `index.ts`.

**Interfaces:** `recordGate(store, taskId, result: GateResult): Promise<void>` (writes to store KV `audit:<taskId>` list + marks `decision`); `gateFor(phase)` (spec→entering `specified`, plan→`planned`, verify→`done`).

- [ ] **Step 1: Failing test** (`gates.test.ts`): using a real store (temp dir), `recordGate` appends an `approved` result; then a `forced` result (with reason) — assert the KV list has 2 entries, ordered, with correct `decision`/`reason`/`at`. Assert `skipped` (quick mode) is recorded too.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** — `gates.ts` reads the store KV `audit:<taskId>` (array), appends the `GateResult`, writes back. `at = Date.now()`. Export `recordGate`. (Audit KV is the source; export-to-`.noir/audit/` is a later helper — keep T2 to KV.)

- [ ] **Step 4: Run → PASS**; typecheck; lint.

- [ ] **Step 5: Commit** — `feat(workflow): observable gates + audit recording (store KV)`

---

## Task 3: ArtifactWriter (`.noir/` markdown scaffolding)

**Files:** Create `packages/workflow/src/artifacts.ts`, `packages/workflow/test/artifacts.test.ts`; modify `index.ts`.

**Interfaces:** `ArtifactWriter` writes phase artifacts: `writeIntake(root, taskId, content)`, `writeSpec(root, taskId, slug, body)`, `writePlan(...)`, `writeTask(...)`, `writeDecisionStub(...)`, `writeChangelogStub(...)`, `writeAuditExport(root, taskId, results)` (`.noir/audit/<taskId>.json`). Uses `paths` from core where possible; new layout helpers added to core as needed (e.g. `paths.spec(root, taskId, slug)`).

- [ ] **Step 1: Failing test** (`artifacts.test.ts`): `writeSpec` creates `.noir/specs/<taskId>-<slug>.md` with a frontmatter + body; `writeAuditExport` writes `.noir/audit/<taskId>.json` from a `GateResult[]`. Assert paths + content + idempotency (re-write doesn't duplicate frontmatter).

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** — `artifacts.ts` (pure file writes via `node:fs`; markdown with marker blocks for idempotent re-write, like the CLI's CLAUDE.md block). Add `.noir/specs|plans|tasks|decisions|audit` path helpers to `@noir-ai/core` `layout.ts` (one helper per dir, or a `paths.workflowArtifacts(root)` object).

- [ ] **Step 4: Run → PASS**; typecheck; lint.

- [ ] **Step 5: Commit** — `feat(workflow): ArtifactWriter (.noir/ markdown scaffolding + audit export)`

---

## Task 4: `WorkflowEngine` — advance/gate/status (Full mode + `--force` + jump)

**Files:** Create `packages/workflow/src/engine.ts`, `packages/workflow/test/engine.test.ts`; modify `index.ts`.

**Interfaces:** `class WorkflowEngine { constructor(store, root, projectId); startTask(id, slug, mode): Promise<TaskState>; advance(taskId, opts?: { force?: { reason }; to?: Phase }): Promise<TaskState>; status(taskId): TaskState | null; checkpoint(taskId): Promise<void>; }`. `advance` applies the FSM transition; at a gate phase it records a `GateResult` (`approved`, or `forced` if `opts.force` with reason); `opts.to` jumps (records `jumpEntry`).

- [ ] **Step 1: Failing test** (`engine.test.ts`): start a task (state `draft`); `advance` to clarify→spec (records `approved` gate at spec); advance to plan (gate at plan); `--force` past a gate records `forced` + reason; jump-to-verify records `jumpEntry`; illegal advance throws.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** — `engine.ts` uses the FSM (`applyTransition`) + `recordGate` (T2) + persists `TaskState` to store KV `workflow:<taskId>` (+ `workflow:active`). `advance` with `force` requires a reason (throw if missing). `checkpoint` flushes state to KV (for resume, T5 deepens).

- [ ] **Step 4: Run → PASS**; typecheck; lint.

- [ ] **Step 5: Commit** — `feat(workflow): WorkflowEngine — advance, observable gates, --force, jump-to-phase`

---

## Task 5: Modes (Full/Quick/Resume) + cross-session resume

**Files:** Create `packages/workflow/src/modes.ts`, `packages/workflow/test/{modes.test.ts, resume.test.ts}`; modify `engine.ts`/`index.ts`.

**Interfaces:** `quickPath(engine, taskId)` — stubs a spec + jumps to execute (gates `skipped`, still verify); `resumeTask(store, root, projectId)` — reads `workflow:active`, reconstructs the `TaskState`, returns it (or null).

- [ ] **Step 1: Failing test** (`modes.test.ts`): `quickPath` leaves gates `skipped`, writes a stub spec, lands at `executing`. `resume.test.ts`: start a task, advance to `specified`, close the store, reopen, `resumeTask` returns the in-flight `TaskState` with `phase:'spec'`.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** — `modes.ts`: `quickPath` calls `engine.advance` with `skipped` gates (a mode flag) + `ArtifactWriter.writeSpec` stub; `resumeTask` reads `workflow:active` + `workflow:<taskId>` from KV. Ensure the engine persists enough to reconstruct on resume.

- [ ] **Step 4: Run → PASS**; typecheck; lint.

- [ ] **Step 5: Commit** — `feat(workflow): Full/Quick/Resume modes + cross-session resume`

---

## Task 6: Daemon seam + `noir.checkpoint` + `noir.workflow_status` MCP tools

**Files:** Create `packages/daemon/src/workflow-seam.ts`; modify `packages/daemon/src/server.ts` (register the 2 tools), `packages/daemon/package.json` (dep `@noir-ai/workflow`); create `packages/daemon/test/workflow-status.test.ts`.

**Interfaces:** The daemon constructs a `WorkflowEngine` from its store (+ root + projectId) and registers `noir.checkpoint` (`{ action:'save'|'restore', taskId? }`) + `noir.workflow_status` (`{ taskId? }` → current task/phase/gate/mode/history). Degraded: if the store is read-only (daemon-down fallback), the tools report state read-only (no advance).

- [ ] **Step 1: Failing test** (`workflow-status.test.ts`): start a task, advance to spec; call `workflow_status` → returns `phase:'spec'`, history has the spec gate; call `checkpoint {action:'save'}` then `restore` → state round-trips.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** — `workflow-seam.ts` builds the engine; `server.ts` registers the 2 tools (inputSchema `{}` / minimal) when a store is present (same pattern as `store_status`). `host_status`/`store_status` unchanged.

- [ ] **Step 4: Run → PASS**; typecheck; lint; full `pnpm test`.

- [ ] **Step 5: Commit** — `feat(daemon,workflow): noir.checkpoint + noir.workflow_status MCP tools`

---

## Task 7: Docs + final verification + roadmap bump

**Files:** Modify `README.md` (workflow section); create `docs/internal/plans/2026-07-24-s4-sdd-engine-acceptance.md` (manual: start task → advance through gates → `--force` → resume across daemon restart); update `docs/roadmap/` "Current status" (S4 → built).

- [ ] **Step 1:** README "Noir workflow" subsection (the lifecycle, modes, observable gates, the 2 MCP tools).
- [ ] **Step 2:** Manual acceptance checklist (lifecycle runs end-to-end on a real task; gates record decisions; resume across daemon restart; `--force` + quick mode).
- [ ] **Step 3:** Final pipeline: `pnpm lint && pnpm typecheck && pnpm build && pnpm test` — all green. **S4 acceptance: the lifecycle runs end-to-end** (task progresses through phases, gates record observable decisions, state survives resume, `--force` + quick mode work).
- [ ] **Step 4:** Bump roadmap current-status (S4 → built; next = S5). Refresh agentmemory.
- [ ] **Step 5:** Commit — `feat(docs): S4 workflow README + acceptance; roadmap status bump`

---

## Notes for the implementer

- **`@noir-ai/workflow` is pure-ish logic + file/KV I/O.** Inject the `Store` (from `@noir-ai/store`) into the engine; never reach into store internals (use `getState`/`setState`/the public API — S1 established the contract).
- **Gates are observable, not blocking:** the engine always records a `GateResult` (approved/forced/skipped); it never silently drops a gate. `--force` requires a reason.
- **Audit = store KV source + `.noir/audit/` export** (T2 writes KV; T3/T-artifacts writes the export).
- **No LLM in S4:** artifacts are scaffolded (templates/stubs); drafting is S8.
- **stdout discipline:** no stdout in engine/MCP paths (stderr only).
- **MCP tool names** are `checkpoint` + `workflow_status` (no dots — MCP spec `^[a-zA-Z0-9_-]+$`; lesson from S1-T7).

## Self-review (controller, after writing)
- Spec coverage: FSM (T1), gates+audit (T2), artifacts (T3), engine+force+jump (T4), modes+resume (T5), MCP (T6), docs+verify (T7). All OQ decisions reflected (new pkg, hand-rolled FSM, observable gates, minimal MCP, store KV audit, Document stubs). ✓
- Placeholders: none — real code per task (with "trust installed types" only where the MCP SDK may differ).
- Type consistency: `Phase`/`WorkflowState`/`GateResult`/`TaskState` consistent across tasks; `paths` workflow helpers added to core once (T3).

## Execution handoff
Plan saved to `docs/internal/plans/2026-07-24-s4-sdd-engine.md`. On approval → subagent-driven-development (implementer + reviewer per task + final whole-branch review), same as S1.
