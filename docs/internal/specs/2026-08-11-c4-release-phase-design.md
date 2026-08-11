# C4 Release Phase + Tool — an optional lifecycle close-out and a guided `noir release` (spec)

> Capability-04 delta: the lifecycle terminates at `document`/`done` and releases run **outside** via the patch-release flow (`scripts/bump-version.mjs` → `pnpm release:tag` → GitHub Actions with a human-required reviewer → Homebrew/Scoop bump → branch sync). The audit confirmed the s4 spec never designed a release phase — this is a new capability, not a missing ship. The repo's release pipeline is deliberately human-gated (the `release` GitHub Environment requires approval from agaaaptr; Claude cannot approve it), so the phase and tool must **close the lifecycle loop and drive the existing machinery** rather than re-implement publishing.
>
> This spec adds an **optional** release phase (the one deliberate FSM extension across the C4 spec suite — every other spec is zero-FSM-change) plus a `noir release` guided orchestrator built on SRE release-engineering principles: build once, push on green, idempotent artifacts, pre-planned rollback.
>
> Internal docs follow `docs/internal/specs/`. Research basis: Google SRE Book Ch. 8 (release engineering: build-once, rollback, gradual rollout), idempotent-artifact + pre-planned-rollback patterns, and the "publish failure → blocked, resumable" recovery integration (verify-gate spec).

## Goal

1. **An optional `release` phase** in the FSM — a task bound for release closes its lifecycle as `document → release → released`, recording release metadata (version, channel, dist-tags, publish SHA) in the audit. Default tasks never enter it (`done` remains terminal — backward compatible).
2. **`noir release`** — a guided orchestrator that runs every step of the existing patch-release flow it safely can (preflight, bump, gate, commit, push, tag, verify, Homebrew/Scoop bump, branch sync), **hands off to the human at each GitHub-approval gate**, verifies each stage (`npm view`), and records failures as structured, resumable blocks.
3. **Build-once / idempotent / rollback** — `bump-version.mjs` idempotency, immutable tags (never reuse — deprecate-and-patch on a bad release), checksummed + Sigstore-attested artifacts (already shipped), and a pre-planned rollback (git revert + npm deprecate + rebuild).
4. **Publish-failure recovery** — a failed release step sets the release task `blocked` with a structured reason; `noir task resume` re-runs the failed step (integrates with the verify-gate recovery spec).

## Scope

### S1 — Optional `release` phase in the FSM (the one deliberate FSM extension)

**`packages/workflow/src/types.ts`** — additive:

```ts
// PHASES gains 'release' (last, after 'document'); STATES gains 'released' (terminal).
export type Phase = ... | 'release';
export type WorkflowState = ... | 'released';
```

**`packages/workflow/src/state-machine.ts`** — one new edge: `done → released` (the release gate admits `released`). `released` is terminal (`[]`), like `done`/`abandoned`. `document` still maps to `done`; `release` maps to `released` via `stateForPhase`. No other transitions change — **a task at `done` may stay `done` forever** (release is opt-in, engaged only by `noir task release`).

**`packages/workflow/src/engine.ts`** — a **release gate** (mirrors the spec/plan/verify gate pattern): entering `released` records a `GateResult` with `phase: 'release'` and the decision `approved` (publish verified) / `forced` (override with reason) / `skipped` (release declined after start). The gate's `reason`/evidence carries the release metadata: `{ version, channel: 'beta' | 'latest', distTags: { beta, latest }, publishSha }` (via the evidence field from the verify-gate spec). Observable + escapable, exactly like the other gates.

- **Gated reachability:** `advance` into `released` only from `done`, and only when the task is release-bound (a `release` phase in its path — engaged by `noir task release`, see S2). A plain `done` task calling `advance` has no `release` next phase and returns as before (the `nextPhase` map only gains `done → 'release'` when the task carries the release marker).
- **Backward compatibility:** every existing test that walks `done` as terminal passes unchanged — the new state/edge is reachable only via the new tool.

### S2 — `noir release` — guided orchestrator

**`packages/cli/src/commands/release.ts`** (new) — `noir release [<version>] [--channel beta|stable]`:

The orchestrator walks the existing patch-release flow (CLAUDE.md "Patch release flow") as a **stateful checklist**, recording progress in `release:<taskId>` KV. Each step either runs, skips-with-reason, or hands off:

| Step | Action | Who |
|---|---|---|
| 1 Preflight | clean tree, on `develop`, HEAD pushed, gate green (`pnpm lint/build/typecheck/test/docs:validate`), `pnpm release:compute <v> <channel>` no-collision | `noir release` |
| 2 Bump | `node scripts/bump-version.mjs <v>` (idempotent) + CHANGELOG/docs sync | `noir release` (guided) |
| 3 Gate + commit | run the full gate again; commit `chore(release): vX.Y.Z + docs sync`; push `develop` | `noir release` |
| 4 CI (develop) | `gh run list --branch develop` → wait green | `noir release` (waits) |
| 5 Beta tag | `pnpm release:tag` → `vX.Y.Z-beta.N`; push | `noir release` |
| 6 **Human approval** | GitHub Actions `publish` job paused for the required reviewer | **human** — `noir release` prints the approve URL + waits, verifies `npm view @noir-ai/cli dist-tags beta` on completion |
| 7 Merge to main | `git merge --ff-only` develop→main; push; wait CI | `noir release` |
| 8 Stable tag | `vX.Y.Z`; push | `noir release` |
| 9 **Human approval** | GitHub Actions again | **human** — verifies `latest` |
| 10 Dist bump | Homebrew `packaging/homebrew/noir.rb` + Scoop `packaging/scoop/noir.json` from npm; commit; push main | `noir release` (guided — url/sha256 from npm) |
| 11 Sync | merge main→develop; verify `git ls-remote origin develop main` same SHA | `noir release` |

- **Handoffs are first-class:** at steps 6/9 the tool blocks (prints the approval URL) until the human approves, then **verifies** via `npm view` before continuing — it never assumes success.
- **Step state:** each step's result (ok/skipped/failed + reason + timestamp) is recorded in `release:<taskId>` (append-only, observable) and surfaced by `noir task status`/`resume`. On `done` task, `noir release` engages the release phase (S1).
- **Failures:** any step failure records a structured reason and sets the task `blocked` (S3). `noir release --resume` re-runs from the first failed step (state is the KV, not the transcript — research: state, not transcript, is authoritative).

### S3 — Publish-failure recovery (integration)

- A failed step (e.g. npm publish 403, `release:tag` refuses a dirty tree, Homebrew checksum mismatch) → the release task becomes `blocked` with `blockReason: 'release-step-failed: <step>: <reason>'` via the surface-wiring `workflow_block`.
- `noir task resume` (surface-wiring spec S2) surfaces the release task with the failed step as the next action; `noir release --resume` re-enters at that step. Retry budget = the verify-gate recovery spec's bounded-retry model, reused.
- This closes the loop the roadmap asked for: **"recovery flows for CI/test/publish failure"** now includes publish.

### S4 — Build-once / idempotent / rollback

- **Build once:** the workspace build happens once per gate run; artifacts (npm tarballs, Homebrew formula, Scoop manifest, installer + `SHA256SUMS` + Sigstore attestation) are produced from a pinned ref and not rebuilt piecemeal.
- **Idempotent:** `bump-version.mjs` re-running at the same version is a no-op (guarded); `release:tag` refuses to create a tag that exists (`pnpm release:tag` already enforces clean + pushed); a re-run of a completed step reports "already done" rather than re-doing.
- **Immutable tags:** a bad release is **never re-tagged** — the flow is deprecate-and-patch (`npm deprecate` the bad version, ship `vX.Y.Z+1`). `noir release` documents this in its rollback help.
- **Rollback (pre-planned):** `git revert` the release commit + `npm deprecate` + rebuild at the prior tag; the Homebrew/Scoop bump is reverted in the same commit. The rollback procedure is recorded in the release task's `rollbackPlan` (decomposition spec S3 pattern) so it is a designed property, not an emergency.

## Non-goals

- **No bypass of the human approval gate.** The GitHub Environment required-reviewer is load-bearing (provenance + authorization); `noir release` hands off, waits, and verifies — it never auto-approves. (Claude cannot approve it; this is documented, not automated.)
- **No re-implementation of the publish pipeline.** The existing `release.yml` workflow, npm provenance, Sigstore, installer, Homebrew/Scoop mechanics all stay; `noir release` orchestrates + verifies them.
- **No `winget`/`chocolatey`** (deferred in C1, ADR-0005) — the tool syncs the two shipped dist channels only.
- **No release for every task.** Release is opt-in per release-bound task; a `bugfix` that never ships never enters the release phase.
- **No CI/CD replacement inside the daemon** — `noir release` is a CLI orchestrator that shells to git/npm/gh (user-invoked, explicit), not a daemon service.

## Acceptance criteria

1. `noir task release <id>` on a `done` task moves it `document → release → released`, recording a release-gate `GateResult` with metadata `{version, channel, distTags, publishSha}` in the audit; a `done` task not release-bound stays `done` on plain `advance` (backward compatible).
2. `noir release --dry-run` walks the checklist and prints each step + who runs it, making no changes.
3. `noir release v1.10.0 --channel beta` (against a clean, gated tree) performs preflight→bump→gate→commit→push→CI-wait→tag→push, then **blocks at the human-approval handoff** printing the approve URL; after approval it verifies `npm view` before proceeding.
4. A step failure (simulated: dirty tree, tag exists, npm 403) records `release-step-failed: <step>: <reason>` and sets the task `blocked`; `noir release --resume` re-enters at the failed step from the KV state.
5. `bump-version.mjs` at an existing version is a no-op; `release:tag` for an existing tag fails with a clear "immutable — deprecate and patch" error; rollback steps are documented in the release task's `rollbackPlan`.
6. Full gate green: lint → build → typecheck → test → docs:validate. **Offline suite** — `noir release` steps that hit network (gh/npm) are exercised against mocks/cassettes; the dry-run + failure paths are fully offline.

## Testing strategy

- **Engine unit:** release phase — `done → released` transition, release-gate recording with metadata, `released` terminal, backward-compat (`done` unchanged for non-release-bound tasks, `nextPhase` gating on the release marker).
- **Orchestrator unit:** step-machine — each step ok/skipped/failed/report state transitions, `--dry-run`, `--resume` re-entry from a failed step (KV-driven), idempotency (completed step = "already done"), tag-immutability error.
- **Handoff/verification:** mocked `gh`/`npm` — blocks at approval, verifies on completion; no real network, no real publish (cassette/mocks).
- **Recovery:** publish-failure → blocked with structured reason; `noir task resume` + `noir release --resume` re-entry.
- **Docs:** capability-04 delta #5 status; `docs/reference/cli-auto.md` (`noir release`); `docs/roadmap/releases.md` "How to use" (release now via `noir release`); CLAUDE.md patch-release flow gets a note that `noir release` automates the mechanical steps.

## Rollback

- **Engine:** the release phase/state/edge is additive and reachable only via the release marker — removing it (or just not engaging it) restores the v1.9.4 `done`-terminal behavior. Existing FSM tests are untouched.
- **Orchestrator:** `noir release` records state but makes no irreversible change without the human handoffs; a bad release follows the documented deprecate-and-patch path (immutable tags). `--dry-run` makes zero changes.
- **Migration:** none — new KV keys (`release:<taskId>`) and a new state are additive; no store schema change.

## References

- `packages/workflow/src/types.ts` — `PHASES`/`STATES` gain `release`/`released`
- `packages/workflow/src/state-machine.ts` — `done → released` edge; `nextPhase` gating on the release marker
- `packages/workflow/src/engine.ts` — release-gate recording (mirrors spec/plan/verify gate pattern)
- `packages/cli/src/commands/release.ts` — new `noir release` orchestrator
- `scripts/bump-version.mjs`, `pnpm release:tag`/`release:compute` — the existing mechanics being orchestrated
- `.github/workflows/release.yml` — the human-gated publish job (load-bearing, not bypassed)
- `packaging/homebrew/noir.rb`, `packaging/scoop/noir.json` — dist bumps
- Cross-ref: `docs/internal/specs/2026-08-11-c4-surface-wiring-design.md` (S4 `workflow_block`), `docs/internal/specs/2026-08-11-c4-verify-gate-recovery-design.md` (recovery + blocked integration)
- Docs to sync: `docs/roadmap/capability-04-ai-development-workflow.md`, `docs/reference/cli-auto.md`, `docs/roadmap/releases.md`, `CLAUDE.md`
