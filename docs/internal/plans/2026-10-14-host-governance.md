# Host governance — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Noir real control over the host agent: prime it with a complete, budgeted project baseline at sync time, and enforce hard constraints through the host lifecycle hooks, claude-first with honest per-host degradation.

**Architecture:** One `noir hook` dispatcher carries all policy; each host adapter emits thin wiring that invokes it with a `--host` dialect. SessionStart injects a compiled brief; PreToolUse evaluates a deny-list; Stop gates SDD verification (opt-in). The derivable baseline is serialized into `.noir/NOIR.md`.

**Tech Stack:** TypeScript (ESM), vitest, biome. Node 22.x runtime. Offline/free suite.

**Spec:** `docs/internal/specs/2026-10-14-host-governance-design.md`

## Global Constraints

- Offline/free tests only — no network, no key, no live host. Hook behavior is pinned with stdin-JSON fixtures piped to `hookOutput`/`dispatch`.
- The daemon is never presented as enforcement; only hooks gate native tools.
- Per-host enforcement claims are stated per host, never as a blanket "Noir enforces X".
- `enforcement.enabled` gates the whole enforcement layer; the built-in deny set is minimal and protects only Noir's own invariants.
- No plugin/marketplace surface (ADR-0002). No OpenCode plugin this slice (unverified API drift).
- Conventional commits, one scope per commit; commits stay local.
- Done = `pnpm lint && pnpm build && pnpm typecheck && pnpm test && pnpm docs:validate && pnpm hygiene:gate` all green.

## Review Focus

- **Deny never over-blocks** — a normal Write to a source file must pass; only `.noir/.env` and `.noir/store/` are denied by default.
- **Envelope exactness** — each host's deny shape is byte-pinned: claude `permissionDecision:"deny"` (JSON), gemini/cursor exit 2 + stderr reason.
- **Fail-open on unknown** — an unrecognized event or an unreadable store must exit 0 with no decision, never block.
- **Budget** — the compiled brief self-truncates under the 10,000-character cap and never throws when files are missing.
- **No regression on the injector** — SessionStart still emits `hookSpecificOutput.hookEventName` + `additionalContext` exactly as today when enforcement is off.

---

## File Structure

**Slice 1 — enforcement engine (`@noir-ai/core`):**
- Create `packages/core/src/enforcement.ts` — deny rule type + `evaluateDeny` + built-in deny set.
- Modify `packages/core/src/config.ts` — add `enforcement` block to `NoirConfigSchema` (`.describe()`).

**Slice 2 — dispatcher (`@noir-ai/cli`):**
- Modify `packages/cli/src/commands/hook.ts` — event dispatcher with `--host` dialect, deny eval, stop gate, budgeted brief.
- Modify `packages/cli/test/hook.test.ts` + new fixtures.

**Slice 3 — baseline (`@noir-ai/create`):**
- Modify `packages/create/src/stack-detect.ts` — add canonical commands + entry points.
- Create `packages/create/src/baseline.ts` — compile the baseline markdown.
- Modify `packages/create/templates/noir.md.tmpl` + `manifest.ts` — serialize the baseline into the NOIR.md brief block.

**Slice 4 — adapter seam (`@noir-ai/adapters` + `@noir-ai/create`):**
- Modify `packages/adapters/src/types.ts` — add `emitHooks` seam + `HookEmission`.
- Modify `packages/adapters/src/claude.ts`, `gemini.ts`, `cursor.ts` — per-host hook wiring; `opencode.ts`/`agents-md-adapter.ts` return none.
- Modify `packages/create/src/manifest.ts` — replace claude-only hook entry with per-host `emitHooks`.
- Modify `packages/create/src/scaffold-version.ts` + `migrations/index.ts` — `1.4.0 → 1.5.0` adds the new events to existing claude installs.

**Slice 5 — `noir sync --check` (`@noir-ai/cli`):**
- Modify `packages/cli/src/sync.ts` — `--check` regenerates and exits non-zero on drift.

**Slice 6 — `noir doctor` coverage (`@noir-ai/cli`):**
- Modify `packages/cli/src/commands/doctor.ts` — per-host enforcement coverage report.

**Slice 7 — gate + docs:**
- Regenerate `docs/reference/config.md`; update `STATUS.md` current sprint; run the full gate.

---

## Slice 1 — enforcement engine

### Task 1: deny evaluator + built-in set

**Files:** `packages/core/src/enforcement.ts` (new), `packages/core/test/enforcement.test.ts` (new), `packages/core/src/config.ts` (add schema).

**Interfaces:** `DenyRule { tool?: string; pattern: string; reason: string }`,
`BUILTIN_DENY: readonly DenyRule[]`, `evaluateDeny(rules, toolName, toolInput) → { denied: true; reason: string } | null`.

- [ ] **Step 1: write the failing test** for `evaluateDeny` — a Write to `.noir/.env` denies; a Write to `src/index.ts` passes; a Bash `rm -rf` with a config rule denies; `tool` scoping applies.
- [ ] **Step 2: implement** `evaluateDeny` and `BUILTIN_DENY` (`.noir/.env`, `.noir/store/`).
- [ ] **Step 3: add** the `enforcement` block to `NoirConfigSchema` with `.describe()` on every field.

## Slice 2 — dispatcher

### Task 2: event dispatch + host dialect + budgeted brief

**Files:** `packages/cli/src/commands/hook.ts`, `packages/cli/test/hook.test.ts`.

**Interfaces:** `dispatch(input, host) → { stdout?: string; exitCode: number }` (testable),
per-host envelope builders `claudeDeny`, `geminiDeny`, `cursorDeny`, `compileBrief`.

- [ ] **Step 1: failing tests** — PreToolUse deny per host (claude JSON deny, gemini/cursor exit 2 + stderr reason); SessionStart brief = router + anti-slop; unknown event exits 0 empty; brief truncates under budget.
- [ ] **Step 2: implement** the switch on `hook_event_name`, `--host` parsing, config load, deny eval, stop-gate read, and the budgeted compiler.
- [ ] **Step 3: keep** the existing `hookOutput` contract for SessionStart/SubagentStart.

## Slice 3 — baseline

### Task 3: canonical commands + entry points + serialization

**Files:** `packages/create/src/stack-detect.ts`, `packages/create/src/baseline.ts` (new), `packages/create/templates/noir.md.tmpl`, `packages/create/src/manifest.ts`, tests.

- [ ] **Step 1: failing tests** — `detectCommands` finds `build`/`test`/`lint`/`typecheck` scripts; `compileBaseline` renders stack + commands + entry points without throwing on an empty dir.
- [ ] **Step 2: implement** the detectors and `compileBaseline`.
- [ ] **Step 3: wire** the baseline into the NOIR.md brief block (managed, regenerated on sync).

## Slice 4 — adapter seam

### Task 4: `emitHooks` + per-host wiring + migration

**Files:** `packages/adapters/src/types.ts`, `claude.ts`, `gemini.ts`, `cursor.ts`, `opencode.ts`, `agents-md-adapter.ts`, `packages/create/src/manifest.ts`, `scaffold-version.ts`, `migrations/index.ts`, tests.

- [ ] **Step 1: failing tests** — each adapter's `emitHooks` returns the correct file + shape; claude has SessionStart/SubagentStart/PreToolUse/Stop; gemini has SessionStart/BeforeTool; cursor has sessionStart/preToolUse; opencode/agents-md return none.
- [ ] **Step 2: implement** the seam and per-host emitters; wire manifest to emit per host.
- [ ] **Step 3: add** the `1.4.0 → 1.5.0` migration to append the new events to existing claude installs without duplicating.

## Slice 5 — `noir sync --check`

### Task 5: drift gate

**Files:** `packages/cli/src/sync.ts`, tests.

- [ ] **Step 1: failing test** — `sync --check` exits non-zero when a managed artifact would change.
- [ ] **Step 2: implement** the regenerate-and-compare path.

## Slice 6 — `noir doctor` coverage

### Task 6: per-host coverage report

**Files:** `packages/cli/src/commands/doctor.ts`, tests.

- [ ] **Step 1: failing test** — doctor reports ENFORCED for claude deny, ADVISORY/context-only for agents-md, and the resolved fail-mode.
- [ ] **Step 2: implement** the coverage check.

## Slice 7 — docs + gate

### Task 7: regenerate + checkpoint

- [ ] Regenerate `docs/reference/config.md` (the `enforcement` block is `.describe()`-driven).
- [ ] Update `docs/roadmap/STATUS.md` current sprint with the new capability.
- [ ] Run the full gate and fix until green.
