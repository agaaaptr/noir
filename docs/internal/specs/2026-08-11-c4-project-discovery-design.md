# C4 Project Discovery Completion — CI detection, AI-tooling probe, onboarding confirm, create-noir (spec)

> Capability-04 delta: `detectStack()` (`packages/create/src/stack-detect.ts`) is shipped and wired — but only for ignore-file selection (`.npmignore`/`.prettierignore`/`.dockerignore`). The audit confirmed the gaps: **no CI detection + opt-in CI templates**, **no existing-AI-tooling probe** (AGENTS.md/CLAUDE.md/.cursorrules/…), **no onboarding confirm step**, and detection output does **not** feed the workflow (the C4 acceptance: "init/create detects the project's framework, package manager, CI, and existing AI tooling **and seeds the workflow accordingly**").
>
> This spec completes discovery under the field's governing principle — **detection fills defaults and pre-selections; it never silently mutates** (the kaikenlabs/tag #29 failure: hooks ran with zero confirmation) — and keeps Noir local-first (no network-dependent detection).
>
> Internal docs follow `docs/internal/specs/`. Research basis: two-half PM detection (`which-pm-runs` / create-t3-app invoke-time pattern + lockfile/`packageManager`/`devEngines` project-state, per antfu's package-manager-detector), the per-agent AI-file mapping standard (AGENTS.md = open cross-agent convention; CLAUDE.md/.cursorrules/GEMINI.md/.github/copilot-instructions.md), degit-style template copy, create-t3-app's confirmable defaults + CI flags + PM-correct next-steps, and the "generated files are derived artifacts, regenerable from a single source" model.

## Goal

1. **Complete `detectStack()`** — a two-half package-manager cascade, CI detection, and an existing-AI-tooling probe, all local and offline.
2. **Onboarding confirm step** — every detection result is a prefilled, confirmable default; every scaffold mutation is gated behind confirmation or an explicit flag ("no surprises").
3. **Opt-in CI generation** — detect the existing CI, default to GitHub Actions when none, generate into the detected platform with a `--dry-run` diff preview; never overwrite an existing workflow.
4. **Never clobber user AI-instruction files** — presence is reported; writing a Noir section / AGENTS.md is opt-in.
5. **`create-noir` bin** — `npm create noir@latest` / `pnpm create noir` / `bun create noir` all work (npm init alias convention); templates copied degit-style.
6. **Seeds the workflow** — detection output feeds the verify-gate check defaults (spec `2026-08-11-c4-verify-gate-recovery-design.md` S4) and print-PM-correct next steps.

## Scope

### S1 — Two-half package-manager detection in `detectStack()`

**`packages/create/src/stack-detect.ts`** — the current PM detection reads the lockfile only (`StackInfo.packageManager`). Widen it to a defined cascade:

1. **Project state (authoritative):** `packageManager` field in `package.json` (e.g. `pnpm@9.x`) → `devEngines.packageManager` → lockfile (`pnpm-lock.yaml`/`package-lock.json`/`yarn.lock`/`bun.lockb`/`bun.lock`). Highest-precedence present signal wins.
2. **Invoke-time (fallback):** `process.env.npm_config_user_agent` (the `which-pm-runs` / create-t3-app pattern) → resolves the PM that invoked the CLI.
3. **Precedence & conflict:** `packageManager` field > `devEngines` > lockfile > invoke-time. When the invoke-time PM **conflicts** with project state, surface the ambiguity in the onboarding summary (the "no surprises" principle) rather than silently assuming — create-t3-app silently assumes `npm`; Noir instead shows both and lets the user pick.
4. **No new runtime dependency.** Detection stays self-contained in `stack-detect.ts` (hand-rolled lockfile/user-agent parsing — the repo already carries `better-sqlite3` + `sqlite-vec`; the detection surface stays minimal, per the "don't import sprawl" rule). A unit test pins the precedence + parse cases.

`StackInfo` gains the resolved PM + a `detectionSource` field (`'packageManager-field' | 'devEngines' | 'lockfile' | 'user-agent' | 'unknown'`).

### S2 — Existing-AI-tooling probe

**`packages/create/src/stack-detect.ts`** — add a probe that walks the target dir (and, for monorepos, nearest-file-wins up the tree) for the per-agent instruction files:

- `AGENTS.md` (open cross-agent convention), `CLAUDE.md`, `.cursorrules` + `.cursor/rules/**/*.md`, `GEMINI.md`, `.github/copilot-instructions.md`, `.codex/` (Codex config).
- Result added to `StackInfo.existingAiFiles: { path, kind }[]`.

**`packages/create/src/scaffold.ts`** — the probe result feeds a new onboarding step:

- **Never clobber.** A detected `AGENTS.md`/`CLAUDE.md`/… is never overwritten. The AI-file write strategy is a confirmable choice: (a) write a **Noir section** into the existing file (append-only, marked `<!-- noir:managed -->`), (b) write a **standalone `AGENTS.md`** (only when none exists), or (c) **skip**. Default: `skip` when any file exists, `standalone AGENTS.md` when none — both confirmable.
- The emitter stays a pointer/transform from `.noir/` (the single-source-of-truth invariant): generated AI files reference `.noir/NOIR.md` rather than duplicating content (ADR-0004 universal emitter pattern).

### S3 — CI detection + opt-in CI templates

- **Detection (`stack-detect.ts`):** probe `.github/workflows/*.yml|yaml`, `.gitlab-ci.yml`, `.circleci/config.yml`, `Jenkinsfile`. Result → `StackInfo.ci: 'github' | 'gitlab' | 'circleci' | 'jenkins' | null`.
- **Generation (`packages/create/src/`):** add opt-in CI templates (`templates/ci/github-actions.yml`, `gitlab-ci.yml`, `circleci.yml`) keyed to the detected platform; default to **GitHub Actions** when none is detected. Generation is:
  - **opt-in** — a confirmed onboarding step (or `--ci` flag), never automatic;
  - **previewed** — `--dry-run` prints the YAML diff before writing;
  - **non-destructive** — an existing workflow file is never overwritten without an explicit diff preview + `--force`.
- **Derived-artifact model (research):** a generated workflow is a derived artifact from a single Noir-owned template, regenerable on demand — not a one-way copy that drifts. The workflow content references the detected PM's commands (e.g. `corepack enable` + `pnpm install`).
- **Scoping note:** CI generation lives in `@noir-ai/create` (scaffold), NOT the workflow FSM. Cross-referenced from the verify-gate spec only as a source of check commands.

### S4 — Onboarding confirm step ("no surprises")

**`packages/create/src/scaffold.ts`** — every detection output becomes a **prefilled, confirmable summary**:

```
Detected: TypeScript · Vite · pnpm (packageManager field) · monorepo
AI files: AGENTS.md (present — write strategy: skip)
CI: none detected → default GitHub Actions
Overrides: [--pm <pm>] [--ci <none|github|gitlab|circleci>] [--ai <section|standalone|skip>]
Proceed? [y/N]   (--yes skips; --dry-run previews)
```

- Every mutation (file writes, `git init`, dependency install, CI generation, AI-file merge) is gated behind confirmation or an explicit flag: `--yes`, `--dry-run`, `--no-install`, `--no-git`, `--force`, `--CI` (non-interactive defaults, create-t3-app style).
- **Empty-directory check:** refuse (exit 2) to scaffold into a non-empty dir unless `--force` (sv-style; create-t3-app requires explicit opt-out). `.noir/` presence from a prior init is respected (idempotent upgrade path via `noir init --upgrade`).
- The existing `--dry-run`/`--preview` on `init`/`create`/`sync` (C2 shipped) is the preview surface; this spec adds the **confirm step** that the C2 delta deliberately deferred.

### S5 — `create-noir` bin + degit-style template copy

**`packages/create/package.json`** — add a `create-noir` bin (alias of the `noir` create command) so `npm create noir@latest` / `pnpm create noir` / `bun create noir` work (npm init alias convention). `npm create` resolves `create-noir` via the `create-*` convention, and the detected invoke-time PM (S1) pre-selects the install command.

**`packages/create/src/templates.ts`** — copy templates **degit-style**: fetch a tarball of a pinned ref (no `.git`), cached locally under `~/.noir/`, rather than `git clone`; verify against the shipped `SHA256SUMS` pattern (the C1 installer invariant). This keeps scaffold start fast and hermetic, offline-repeatable after first fetch.

### S6 — Seeds the workflow

- **Verify-check defaults:** `StackInfo` (detected PM + framework) feeds the default check commands for `noir task verify` (spec `2026-08-11-c4-verify-gate-recovery-design.md` S3/S4) — e.g. `pnpm test`/`pnpm lint`/`pnpm typecheck` for a pnpm TS project. The workflow consumes detection output through the same resolved-config bridge.
- **Scaffold completion output** (create-t3-app `logNextSteps` pattern): after scaffolding, print next steps with the **detected PM's exact commands** (`pnpm dev`, not `npm run dev`).

## Non-goals

- **No network-dependent detection.** `detectStack()` stays strictly local/offline — indicator files, lockfiles, user-agent. No linguist-style language stats, no registry probes, no module-registry lookups (local-first platform invariant; the fetch is only for opt-in template download in S5, which is a runtime asset, not detection).
- **No automated CI generation at workflow time.** CI generation is a scaffold-time opt-in; the workflow only consumes the *detected* state.
- **No AGENTS.md-canonical re-architecture** of the emitters. The existing 5-adapter emitter (ADR-0004) stays; this spec only adds the *probe* + non-destructive write strategy. (The "generate CLAUDE.md from AGENTS.md via symlink" model — agi-cli — is a documented alternative, not adopted here: this repo itself uses CLAUDE.md as its instruction file.)
- **No dependency additions.** Detection stays hand-rolled; template fetch reuses the C1 fetch/verify machinery.
- **No workflow-FSM participation.** Scaffold detection feeds config; it is not a workflow state.

## Acceptance criteria

1. `detectStack()` resolves the PM via the documented precedence and reports `detectionSource`; conflicting invoke-time vs project-state PM surfaces in the summary (not silently assumed). No new runtime dependency.
2. The AI-tooling probe reports `existingAiFiles` (AGENTS.md/CLAUDE.md/.cursorrules/.cursor/rules/**/GEMINI.md/.github/copilot-instructions.md); an existing file is **never** overwritten; the write strategy defaults to `skip` when present, `standalone AGENTS.md` when none, both confirmable.
3. `noir init`/`noir create` in a target dir prints the confirmable detection summary; `--yes`/`--dry-run`/`--no-install`/`--no-git`/`--force`/`--CI` behave as specified; scaffolding into a non-empty dir refuses (exit 2) without `--force`.
4. CI detection reports the platform (`github`/`gitlab`/`circleci`/`jenkins`/null); `--ci github` generates a GitHub Actions workflow with the detected PM's commands; `--dry-run` prints the diff before writing; an existing workflow file is not overwritten without `--force`.
5. `npm create noir@latest` / `pnpm create noir` / `bun create noir` resolve to the create command; templates copy degit-style (no `.git`, cached, hash-verified).
6. A scaffolded pnpm project's `noir task verify` default check set resolves to `pnpm …` commands (detection feeds the workflow); scaffold completion prints the detected PM's commands.
7. Full gate green: lint → build → typecheck → test → docs:validate. Offline suite only (no network in tests — template fetch is mocked/cassette).

## Testing strategy

- **Unit (`stack-detect.test.ts`):** PM precedence ladder (field > devEngines > lockfile > user-agent), conflict surfacing, `detectionSource`; AI-file probe (each kind + nearest-file-wins + monorepo subtree); CI probe (each platform + none).
- **Scaffold integration:** confirm-summary rendering; every flag path (`--yes`/`--dry-run`/`--no-install`/`--no-git`/`--force`/`--CI`); empty-dir refusal; CI generation diff + non-overwrite; AGENTS.md write strategies (section/standalone/skip) with no-clobber assertions. **No network** — template fetch + checksum verification are cassette/mocked.
- **Bin wiring:** `create-noir` resolves via the npm convention (a unit test on the bin mapping; not a real registry call).
- **Docs:** `docs/reference/cli-auto.md` (create-noir), capability-04 delta #3 status, `AGENTS.md` toolchain section if it references scaffold flags.

## Rollback

- **Detection + probe are additive** (new `StackInfo` fields, new tests) — removing them restores the shipped ignore-file behavior byte-for-byte.
- **Behavior changes are all gated:** the confirm step can be bypassed with `--yes` (the prior behavior was effectively `--yes`); CI generation is opt-in `--ci`; AI-file writes default to `skip`/non-clobber. No path forces a mutation a user did not request.
- **`create-noir` bin + templates:** additive packaging; reverting removes the bin without affecting `noir init`.
- **Migration:** none — `StackInfo` widens; no store schema change.

## References

- `packages/create/src/stack-detect.ts` — `StackInfo`, PM/language/framework detection (today lockfile-only)
- `packages/create/src/scaffold.ts` — scaffold orchestration, `--dry-run`/`--preview` (C2), manifest emission
- `packages/create/src/manifest.ts` — ignore-file selection (the current sole consumer of `detectStack`)
- `packages/create/package.json` — new `create-noir` bin
- `packages/create/templates/` — new `ci/` templates; degit-style fetch machinery (reuse C1 fetch/verify)
- `packages/adapters/src/` — universal AGENTS.md emitter (ADR-0004), non-destructive write strategy
- `docs/roadmap/capability-04-ai-development-workflow.md` — delta #3
- Cross-ref: `docs/internal/specs/2026-08-11-c4-verify-gate-recovery-design.md` S4 (check defaults)
