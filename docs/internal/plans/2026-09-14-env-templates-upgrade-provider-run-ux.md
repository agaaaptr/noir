# Env Templates + Upgrade Completeness + Provider Gateways + `noir run` UX — Implementation Plan

> Plan for spec `docs/internal/specs/2026-09-14-env-templates-upgrade-provider-run-ux-design.md`.
> Execution order: Slice B → A → C → D. Rationale: B's upgrade machinery (refreshIfStale +
> migration) is what distributes A's new templates to existing projects; C and D are
> independent of B but ride the same release.

## Global Constraints

- Full gate per checkpoint: `pnpm lint && pnpm build && pnpm typecheck && pnpm test && pnpm docs:validate`.
- Every fix ships a regression test (standing rule since 1.12.0).
- Tests offline/free — never network or key.
- Docs sync at every checkpoint (no drift).
- Conventional Commits, scope per package; commits stay local; `develop` branch.

## File Structure (touched)

| Area | Files |
|---|---|
| Templates | `packages/create/templates/{config.env.tmpl,env.example.tmpl,noir-readme.md.tmpl}`, `docs/getting-started.md` |
| Upgrade | `packages/create/src/{manifest.ts,scaffold.ts,template-history.ts(new),migrations/index.ts}`, `packages/cli/src/init.ts`, `packages/cli/src/commands/doctor.ts` |
| Security | `packages/cli/src/run-profiles.ts`, `packages/cli/src/commands/run.ts` (mergeEnv path) |
| Provider | `packages/core/src/config.ts`, `packages/model/src/{types.ts,config.ts,complete.ts}`, `packages/model/src/providers/anthropic.ts`, `packages/cli/src/commands/env.ts` |
| Run UX | `packages/cli/src/{commands/run.ts,orchestrator.ts,output.ts(new: run-status.ts)}`, `packages/cli/src/tui/{App.tsx,StatusBar.tsx,OutputPane.tsx}`, `packages/cli/src/tui/palette/{types.ts,rows.ts,Palette.tsx}`, `packages/cli/src/tui/commands/{registry.ts,sections.ts}`, `packages/cli/src/tui/overlays/PostRunOverlay.tsx(new)`, `packages/cli/src/tui/modes/run.tsx(new)` |
| Docs | `docs/reference/{environment.md,config.md}`, `docs/how-to/gateways.md(new)`, `CHANGELOG.md`, roadmap files, ADR-0012 (written) |

---

## Slice B — Upgrade completeness (first: the distribution machinery)

### Task 1: B1 — template-history + refreshIfStale primitive
- New `packages/create/src/template-history.ts`: registry `scaffoldVersion → template bytes`
  for the doc-only seeds (`.env.example`, `rules-seed.md`); snapshot the 1.1.0 templates
  (from git tag `v1.14.0` — verify bytes against the tag, not memory).
- `isStaleSeed(currentBytes, currentRender)`: true iff bytes match a non-current history entry.
- Unit tests: absent / stale-match / edited / current-render cases.

### Task 2: B2 — manifest + scaffold wiring
- `manifest.ts`: `refreshIfStale: true` on `.env.example` + `rules-seed.md` entries.
- `scaffold.ts` upgrade path: absent → create; stale-match → silent refresh (+ `refreshed`
  report list); edited → existing conflict flow (default preserve; non-interactive reports).
- `.env`/`config.yml`/`project.id` untouched (pure skipIfExists — assert in test).
- Tests: triple-state × interactive/non-interactive matrix; summary lists `refreshed`.

### Task 3: B3 — host-aware upgrade
- `packages/cli/src/init.ts`: host = `--host` flag > config.yml `host:` > `'claude'` (mirror
  `sync`'s resolution).
- Test: cursor project upgraded bare refreshes cursor artifacts, writes no claude surface.

### Task 4: B4 — honest skill + summary reporting
- `emitted` counts only written skills; preserved-stale reported (human line + `--json`
  `skillConflicts` records).
- Tests: non-interactive preserve path prints the stale line; `--json` carries conflicts.

### Task 5: B5 — legacy migration gate + doctor drift
- Stamp-less project → `fromVersion = '0'` (full chain).
- `doctor.ts checkScaffoldVersion`: report doc-seed staleness via `isStaleSeed` (hint:
  `noir init --upgrade`).
- Tests for both.

### Task 6: B6 — profile deny-list (security)
- `run-profiles.ts`: apply `PROCESS_INJECTION_ENV_RE` to resolved profile env (after
  `${VAR}` expansion); refuse at resolution (exit 2, key named). Export the check for reuse.
- `run.ts mergeEnv`: defense-in-depth assertion (belt) — the resolution refusal is the
  suspenders.
- Test: profile with `NODE_OPTIONS` (direct + via expanded `${V}`) fails cleanly.

**Checkpoint B:** full gate + commit `feat(create,cli): upgrade completeness — refreshIfStale, host-aware upgrade, honest reporting, legacy migrations, profile deny-list`.

---

## Slice A — Template redesign (uses B's machinery)

### Task 7: A1 — write the new templates
- `config.env.tmpl`: per spec §4.1 (≤ 60 lines, gateway section first, descriptive
  placeholders, no YAML, no `sk-` shapes).
- `env.example.tmpl`: per spec §4.1 (purpose header, precedence ladder, per-key detail,
  gateway semantics incl. Bearer vs x-api-key + both-set conflict, apiKeyEnv-name rule,
  CLICKUP_TEAM_ID anti-doc note, environment.md link).
- Register both under template-history as the new current (scaffold `1.2.0`).

### Task 8: A2 — rewrite the test gate
- `packages/create/test/env-seed.test.ts`: delete the doctrine-verbatim test; new assertions
  per spec §4.2 (both all-comment; `.env` ≤ 60 lines, > 200 bytes; `.env.example` contains
  purpose header + precedence + 9 documented vars + gateway trio + apiKeyEnv rule + link;
  no active `KEY=` lines; no `sk-`-prefixed placeholders; warnings-empty POSIX pin kept).

### Task 9: A3 — migration + stamp + surface sync
- `migrations/index.ts`: `1.1.0 → 1.2.0` using refreshIfStale; `CURRENT_SCAFFOLD_VERSION =
  '1.2.0'`; fix the literal-version test.
- Update `noir-readme.md.tmpl` (managedBlock re-emit propagates), `getting-started.md` table
  row, and the two templates' self-references — all four "same variable set" surfaces gone.

**Checkpoint A:** full gate + commit `feat(create): env template redesign — concise uncomment-to-enable .env + detailed .env.example + 1.2.0 migration`.

---

## Slice C — Provider gateway transport (ADR-0012)

### Task 10: C1 — schema + types
- `core/config.ts`: `authTokenEnv`, `timeoutMs` (int, min 1000) with `.describe()`.
- `model/types.ts`: `CompleteRequest` gains `authToken?`, `timeoutMs?` (forwarded fields).
- Tests: schema accepts/rejects; describe-text regeneration lands in config.md.

### Task 11: C2 — anthropic adapter
- Construct client with `{apiKey, authToken, baseURL, timeout, maxRetries}` from the
  request; explicit defaults for absent fields so SDK env fallbacks are inert
  (`baseURL: req.baseURL ?? 'https://api.anthropic.com'`; credential absence → null
  degradation BEFORE client construction).
- Fold `authTokenEnv`/`timeoutMs` in `complete.ts` dispatch (like `baseURL` today).
- Tests: client-options seam asserts forwarded fields; ambient-env inertness (env set, no
  config → null); timeout mapping; existing byte-frozen anthropic test updated deliberately.

### Task 12: C3 — surfacing
- `cli/commands/env.ts`: gateway section (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`,
  `ANTHROPIC_API_KEY`, `API_TIMEOUT_MS`) with winning source; profile-sourced label.
- `docs/reference/environment.md`: ANTHROPIC_* entries + corrected deny-list table + SHELL +
  npm_config_user_agent + NOIR_NON_INTERACTIVE ambient note; `docs/how-to/gateways.md` new
  (Z.AI / LiteLLM / OpenRouter worked examples, host path vs model path).
- Tests: env command output.

**Checkpoint C:** full gate + commit `feat(model,core,cli): provider gateway transport — authTokenEnv/timeoutMs/baseURL honored, ambient env neutralized (ADR-0012)`.

---

## Slice D — `noir run` UX (D1→D2→D4→D3→D5)

### Task 13: D1 — terminal status line
- New `packages/cli/src/run-status.ts`: `RunStatusLine` (start/model/tokens/tool/end; stderr;
  redraw on event boundary only; TTY-gated; `--json`/`--quiet` fully silent; non-TTY = one
  start line + one end line). No cursor warping while stdout lacks a trailing newline —
  clear-line only when the last stdout write ended with `\n` (track it).
- `run.ts`: wire into `onEvent`; bounded host-stderr tail on failure (last 20 lines);
  UsageReducer #2 for running totals (dedup rule shared).
- Tests: writer unit tests (gating, boundaries, newline tracking); `--json`/`--quiet`
  byte-pins re-asserted; failure-tail test.

### Task 14: D2 — palette argument collection
- `palette/types.ts`: `PaletteRow.needsArg?: string`; `registry.ts`: derive from commander
  `_args` introspection (required positional ⇒ label); `rows.ts`: stop dropping it;
  `Palette.tsx`/`App.tsx`: Enter with `needsArg` → inline arg step (existing input line,
  placeholder = label) → dispatch `[...argv, arg]`; Esc returns to filter.
- `sections.ts`: add curated `run` action ("Ask the host", `needsArg: 'prompt'`).
- Tests: ink-testing-library flow for `run` + `context search`; seven dead leaves fixed;
  destructive confirm unchanged.

### Task 15: D4 — post-run actions (before D3 — the terminal menu ships independent of the TUI mode)
- `run.ts`: plain-text answer accumulator; `--json` envelope += `answerText`, `sessionId`.
- New `packages/cli/src/run-actions.ts`: `offerPostRunActions({answer, transcript, sessionId,
  opts})` — `@clack/select` (lazy) gated by `isInteractive()`; actions per spec §7.4
  (memory capture via daemon client; research-record; handoff; `--resume` re-invocation;
  save answer to file; dismiss default). Degrades to exact current behavior non-interactively
  (byte-pin).
- Tests: each action's happy path (mocked daemon client), non-interactive no-op,
  daemon-down degradation, memory receives distilled text (not raw JSONL).

### Task 16: D3 — TUI run mode (live progress)
- `tui/modes/run.tsx`: new App mode `run` — in-process `runHost` (import from
  `orchestrator.js`), event stream → React state; OutputPane live append region; StatusBar
  `run · model · elapsed · tokens`; `Esc` cancel (D5 path); does NOT go through
  `captureProcessOutput` (capture invariant preserved by construction).
- `App.tsx`: mode machine + transitions (palette `/run` action, typed `/run`, home section);
  `Ctrl+T` transcript picker (recent `.noir/transcripts/` list) folded in.
- `orchestrator.ts`: add `--include-partial-messages` to claude HOST_FLAGS; normalizer
  recognizes `stream_event` (tool name from `content_block_start.content_block.name`);
  `messageText()` tool-use-only lines yield tool events; `other` gains `subtype`.
- `PostRunOverlay.tsx`: the D4 action set rendered as an overlay (ConfirmOverlay pattern);
  wired from run mode completion.
- Tests: mock `runHost` event source → rendered frames; normalizer tool-event tests; usage
  reducer unaffected; capture invariant test (dispatched non-run commands still captured).

### Task 17: D5 — interrupt contract
- `run.ts`: SIGINT/SIGTERM handlers — transcript best-effort write, child SIGTERM → 5 s →
  SIGKILL, `interrupted · transcript: <path>`, exit 130/143.
- TUI run mode: `Esc` + raw-mode Ctrl+C mapped to the same path; child tracking so unmount
  cannot orphan.
- Tests: signal simulation (child kill ordering, transcript written, exit codes), Esc path.

**Checkpoint D:** full gate + commit(s) `feat(cli): noir run UX — status line, palette args, post-run actions, TUI run mode, interrupt contract`.

---

## Final checkpoint

- CHANGELOG 1.15.0 section; roadmap STATUS/releases/backlog/manifest updates (resolve
  profile-deny-list item; record mergeJson doctor decision; mark ADR-0008 deferred items
  delivered where covered).
- `pnpm docs:validate` clean; agentmemory refresh (session-end hygiene).
- Release itself follows the patch-release flow ONLY on explicit user request (beta →
  stable, user-approval gates in GitHub Actions).

---

### Task 18: Jargon-comment cleanup (backlog, same-shape mechanical batch)

One batch dispatch. Rewrite every internal-jargon comment line in `packages/*/src`
(`//`, `*`, `/*` comments referencing: spec/plan/ADR section citations like `spec §11.1`
or `plan 12.4`, task/slice codes like `B1`/`D5`/`K3`/`Slice X`, codenames like
`Archetype B`/`SP-A`/`D2a`) into self-contained plain-language WHY comments that keep the
same depth and rationale. Verified scale: ~268 lines across 83 files (cli 16, daemon 11,
create 8, context 8, memory 7, workflow 4, skills 3, core 3, adapters 3, store 1). Do not
change any code semantics, identifiers, or strings — comments only. Full gate after
(comments can break lint/doc-validate). Conventional commit: `docs: replace internal
jargon references with self-contained comments across packages`.
