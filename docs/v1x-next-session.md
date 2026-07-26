# Noir — next-session handoff & playbook

> **Status (2026-07-26): v1.2.0-beta.2 PUBLISHED on npm (dist-tag `beta`) + verified working.** The global-install no-op (which broke every prior beta) is FIXED and live: `npx @noir-ai/cli@beta --version` → `1.2.0-beta.2`, exit 0; `noir init` scaffolds. All 11 `@noir-ai/*` packages at `1.2.0-beta.2`; CI GREEN (`release.yml` conclusion=success); `develop` in sync, tree clean. This doc + `docs/CHANGELOG.md` + `docs/roadmap.md` + `/recall noir` = full context.

## The critical fix that shipped in 1.2.0-beta.2
Every published beta before 1.2.0-beta.2 (1.0.0/1.1.0/1.2.0-beta.1) had a **broken global install**: `noir` (the npm-global symlink) silently exited 0 with **no output** — `--version`, `--help`, `init`, bare `noir` all no-ops. Two root causes, both fixed in commit `1bbab63`:
1. **`isMainModule` guard** (`packages/cli/src/bin.ts`): compared `pathToFileURL(process.argv[1]).href` to `import.meta.url`. A global install invokes the bin via a symlink (`…/bin/noir` → `…/lib/node_modules/@noir-ai/cli/dist/bin.js`), so `argv[1]` is the **symlink** path while `import.meta.url` is the **resolved real** path → never matched → `main()` never ran. **Fix:** `realpathSync(argv[1])` before comparing.
2. **`noir --version` exited 2** (usage): commander v12 throws error code `commander.version` (NOT `commander.versionDisplayed`); `commanderExitCode` in `packages/cli/src/output.ts` missed it. **Fix:** map `commander.version` → `EXIT.OK`.

Regression test: `global-install symlink invocation` in `packages/cli/test/bin.test.ts` (spawns the bin via a symlink — guards both fixes). **Why the in-repo dogfood never caught it:** the dogfood ran `node packages/cli/dist/bin.js` (real path → guard matched → worked); the bug only manifested via the npm-global **symlink**.

## What shipped across the two sessions (all on `develop`, pushed; 1.2.0-beta.2 PUBLISHED)
- **v1.2.0-beta.1 → 1.2.0-beta.2 (the comprehensive v1.x beta):** Slice S (intelligent scaffold, `@noir-ai/create`, `noir create`) · Slice X (ClickUp integration: `integrations_auth` + `noir.clickup_write` gated-write-proxy + K3) · debt batch (R4/R5/P3/P4 + W1/W2/W3 + C1 + T2 + T1-pilot + lint→0) · **S10 multi-host** (`resolveAdapter` registry: claude/agents-md/gemini/cursor/opencode via `--host`; opencode.json verified vs opencode.ai docs; AGENTS.md universal w/ no-duplication gating; claude byte-identical to v1.1) · **S11** (`docs/sdk.md` + `noir doctor` publish check) · **1.2.0-beta.2**: the global-install no-op + `--version` exit-code fix.
- Also: README hero (badges + ASCII TUI preview of the home menu) + separated install blocks + `init`/`create` "Next: run `noir`…" hint (clarifies `noir init` ≠ the TUI home menu). ADR-0003 (v1.x capabilities) + ADR-0004 (multi-host).
- **1090/1090 tests green**, 11 packages, 34 skills (33 builtins + 1 integration).

## Consuming it
```bash
npm install -g @noir-ai/cli@beta     # one time (puts `noir` on PATH)
noir init                            # scaffolds .noir/ + 34 skills (non-interactive; status line)
noir                                 # ← the @clack home menu (interactive)
```
Multi-host: `noir init --host gemini|cursor|opencode|agents-md`.

## Next-session candidates
1. **Validate 1.2.0-beta.2 in a real project per host** (`noir init --host gemini|cursor|opencode|agents-md`), exercise context/memory/workflow end-to-end.
2. **Promote to stable `1.x`**: merge `develop`→`main`, `node scripts/bump-version.mjs 1.x.0`, tag on `main` → CI publishes `--tag latest`.
3. **Optionally deprecate the broken prior betas**: `npm deprecate @noir-ai/cli@1.2.0-beta.1 "global install no-op — use 1.2.0-beta.2+"` (and 1.0.0-beta.1 / 1.1.0-beta.1 similarly if desired).
4. **v1.x backlog**: qwen/agy adapters; daemon detach/socket/auth; full-screen TUI; embedding-model upgrade (needs model-version stamp + re-index-on-change); `tsconfig.test` rollout to 9 pkgs; S1/S5 micro-items.

## Release-process notes (for the next release)
- The `release.yml` `publish` job uses `environment: release` with `required_reviewers`. To auto-publish betas without per-release approval: GitHub **Settings → Environments → `release` → remove Required reviewers**. (Re-add for stable releases if you want the gate.)
- **Always smoke-test the PUBLISHED package via `npx @noir-ai/cli@beta --version`** (not just `node bin.js`) — the symlink-invocation path is what broke 1.2.0-beta.1 and is now regression-tested.

## Resume recipe
1. `/recall noir` → lands here.
2. Confirm state: `npm view @noir-ai/cli dist-tags` (beta=1.2.0-beta.2) + `git log --oneline -1` (HEAD on develop) + `pnpm test` (1090 green).
3. Pick a next-session goal (above); follow the dogfooded SDD cadence (brainstorm→spec→plan→subagent-driven implement+review→main-loop validates→opus review→docs/memory checkpoint→commit).

## Conventions (unchanged)
Sub-agents **Opus** (review/design) + **Sonnet** (implementation) only; main loop runs all `pnpm` validation; commits local on `develop` until a release push; dogfood SDD; graceful degradation; no silent paid calls; adopt ideas, not copies.
