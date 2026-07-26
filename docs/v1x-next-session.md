# Noir — next-session handoff & playbook

> **Status (2026-07-26): v1.2.0-beta.2 TAGGED + pushed + CI build GREEN, but PUBLISH BLOCKED.** npm `beta` still points at the **BROKEN `1.2.0-beta.1`** (global `noir` install = silent no-op). The `1.2.0-beta.2` critical fix is committed (`1bbab63`), tagged `v1.2.0-beta.2`, pushed to `develop`; CI build+test pass (**1090/1090**). The `release.yml` `publish` job is gated on the `release` environment's **`required_reviewers`** — it's waiting for a deployment approval. This doc + `docs/CHANGELOG.md` + `/recall noir` = full context.

## The critical bug + the 1.2.0-beta.2 fix
**Every published beta (1.0.0-beta.1 / 1.1.0-beta.1 / 1.2.0-beta.1) shipped a broken global install:** `noir` (the npm-global symlink) silently exited 0 with **no output** — `--version`, `--help`, `init`, bare `noir` all no-ops. Two root causes:
1. **`isMainModule` guard** (`packages/cli/src/bin.ts`): compared `pathToFileURL(process.argv[1]).href` to `import.meta.url`. A global install invokes the bin through a symlink (`…/bin/noir` → `…/lib/node_modules/@noir-ai/cli/dist/bin.js`), so `argv[1]` is the **symlink** path while `import.meta.url` is the **resolved real** path → they never matched → `main()` never ran. **Fix:** `realpathSync(argv[1])` before comparing.
2. **`noir --version` exited 2** (usage): commander v12 throws error code `commander.version` (NOT `commander.versionDisplayed`); `commanderExitCode` in `packages/cli/src/output.ts` missed it. **Fix:** map `commander.version` → `EXIT.OK`.

Both fixed in commit `1bbab63`; a **regression test** (`global-install symlink invocation` in `packages/cli/test/bin.test.ts`) spawns the bin via a symlink — guards both. **Why the in-repo dogfood never caught it:** the dogfood ran `node packages/cli/dist/bin.js` (real path → guard matched → worked); the bug only manifests via the npm-global **symlink**, which no test exercised until now.

## PUBLISH BLOCKED — resume here
`release.yml`'s publish job has `environment: release` with `required_reviewers` (verified: `gh api repos/agaaaptr/noir/environments/release` → `protection_rules: required_reviewers`). So `1.2.0-beta.2`'s publish is WAITING for a deployment approval. To complete:
- **Option A — approve once:** open https://github.com/agaaaptr/noir/actions/runs/30185065072 → **Review deployments** → `release` → **Approve**. (⚠ GitHub blocks self-approval of your own deployment — needs a *different* designated reviewer. If you're the sole reviewer, use Option B.)
- **Option B — remove the gate for betas (recommended):** GitHub **Settings → Environments → `release` → Required reviewers → remove** → save. Then re-trigger: `gh run rerun 30185065072` (or `git push origin v1.2.0-beta.2 --force` to re-tag at HEAD) → publish auto-runs (~1–2 min).
After publish: verify `npm view @noir-ai/cli dist-tags` → `beta: 1.2.0-beta.2` (all 11 packages); `npm i -g @noir-ai/cli@beta` → `noir --version` prints `1.2.0-beta.2` + exit 0; `noir init` scaffolds. Then optionally deprecate the broken `1.2.0-beta.1`: `npm deprecate @noir-ai/cli@1.2.0-beta.1 "global install no-op — use 1.2.0-beta.2+"`.

## What shipped across the two sessions (all on `develop`, pushed)
- **v1.2.0-beta.1 (PUBLISHED but broken for global installs):** Slice S (intelligent scaffold, `@noir-ai/create`, `noir create`) · Slice X (ClickUp integration: `integrations_auth` + `noir.clickup_write` gated-write-proxy + K3) · debt batch (R4/R5/P3/P4 + W1/W2/W3 + C1 + T2 + T1-pilot + lint→0) · **S10 multi-host** (`resolveAdapter` registry: claude/agents-md/gemini/cursor/opencode via `--host`; opencode.json verified vs opencode.ai docs; AGENTS.md universal w/ no-duplication gating) · **S11** (`docs/sdk.md` + `noir doctor` publish check). 1089 tests. ADR-0003 + ADR-0004.
- **v1.2.0-beta.2 (TAGGED, publish pending):** the global-install no-op + `--version` exit-code fix. 1090 tests.
- Also shipped post-beta.1: README hero (badges + ASCII TUI preview of the home menu) + separated install blocks + `init`/`create` "Next: run `noir`…" hint (clarifies `noir init` ≠ the TUI home menu).

## Next-session candidates
1. **Complete the 1.2.0-beta.2 publish** (Option A/B above) → validate in a real project per host (`noir init --host gemini|cursor|opencode|agents-md`).
2. **Promote to stable `1.x`**: merge `develop`→`main`, `node scripts/bump-version.mjs 1.x.0`, tag on `main` → CI publishes `--tag latest`.
3. **v1.x backlog** (qwen/agy adapters; daemon detach/socket/auth; full-screen TUI; embedding-model upgrade — needs model-version stamp; `tsconfig.test` rollout to 9 pkgs; the S1/S5 micro-items).

## Resume recipe
1. `/recall noir` → lands here.
2. Check publish state: `gh run list --workflow=release.yml --limit 1` + `npm view @noir-ai/cli dist-tags` (is `beta` = `1.2.0-beta.2` yet?).
3. If still unpublished → Option A or B above.
4. If published → validate end-to-end, then pick the next goal.

## Conventions (unchanged)
Sub-agents **Opus** (review/design) + **Sonnet** (implementation) only; main loop runs all `pnpm` validation; commits local on `develop` until a release push; `release` env requires a human deployment approval per publish (remove the gate for auto-betas); dogfood SDD; graceful degradation; no silent paid calls; adopt ideas, not copies.
