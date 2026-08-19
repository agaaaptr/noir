# 2026-08-19 — v2 TUI fixes + `noir run` orchestration + configuration surface

> **Status:** approved-for-implementation (this session). Supersedes none; builds on ADR-0008.
> **Scope:** fix two shipped v1.11.2 defects, harden `noir run` host-error handling, add three
> run/config features (shell-bridge fallback, run profiles, `.noir/.env`), and make the
> configuration surface fully documented. No release in this session — commits stay local.

## Context

Three independent problems surfaced in one session:

1. **Palette help corpus wraps** (shipped regression, v1.11.2): the two-column row budgets
   `LABEL_WIDTH(26) + HINT_WIDTH(34) = 60` columns, but the actual text width inside the panel
   is **58** (`PALETTE_WIDTH 64 − round border 2 − panel paddingX 2 − row paddingX 2`). Ink
   word-wraps the truncated hint's tail onto a flush-left second line — the description appears
   to "move to the left column". The two-column constants landed in `c47d1e3` (final 1.11.2).
2. **`noir run` misreports host failures** (reproduced end-to-end against the built CLI):
   - an assistant event carrying `error:"authentication_failed"` / `is_api_error_message:true`
     is streamed to stdout as if it were the answer (`normalizeStreamEvent` drops the fields);
   - the `result` event's `is_error:true` is parsed but dropped by `runHost`;
   - `run.ts` checks only `exitCode`, logs to stderr, returns normally → **process exits 0**
     on a failed host run; `--json` always emits `{ok:true}` (S9 contract violation);
   - the "usage: 0 in / 0 out · 1 turns" line reports an errored auth turn as usage.
3. **Configuration is undocumented / misdocumented**: `CLICKUP_API_TOKEN` and `CLICKUP_TEAM_ID`
   never appear in user-facing docs; `CLICKUP_TEAM_ID` is a **dead env var** (nothing reads it —
   team binding is `integrations.clickup.teamId`). `docs/reference/config.md` is generated from a
   Zod schema with no `.describe()` text → empty description columns and invisible nested keys.
   Users keep config in `.zshrc`, whose **aliases are invisible to `spawn()`** (ENOENT), and whose
   env vars are **not inherited** by non-interactive/GUI-launched processes.

## Decisions

### A. Palette width + help detail line (`packages/cli/src/tui/palette/Palette.tsx`)

- Derive the row budget from one constant so it cannot drift again:
  ```ts
  const PALETTE_WIDTH = 64;
  const ROW_OVERHEAD = 6; // round border (2) + Panel paddingX (2) + row paddingX (2)
  const ROW_TEXT_WIDTH = PALETTE_WIDTH - ROW_OVERHEAD; // 58
  const LABEL_WIDTH = 26;
  const HINT_WIDTH = ROW_TEXT_WIDTH - LABEL_WIDTH; // 32
  ```
- **Help corpus shows the full description as a wrapped detail line on the active row**
  (matches command-row UX, solves "can't read the truncated description"). Relax the detail-line
  gate from `isActive && row.argv && row.secondary` to
  `isActive && row.secondary && (row.argv || corpus === 'help')` — **not** all `argv`-null rows
  (output corpus uses `secondary` for line numbers / empty-state text).
- Detail-line wrap width derived from the budget: `wrap(row.secondary, ROW_TEXT_WIDTH - 4)`
  (prefix is `'  ↳ '` = 4) = 54.
- Regression test: render the help corpus via ink-testing-library and assert **no frame line
  inside the panel exceeds `ROW_TEXT_WIDTH`** and no help row wraps to two lines.
- Narrow-terminal (<64 cols) degradation stays as-is (pre-existing fixed-overlay limitation).
- Terminal <64 cols aside, the 58-col budget is identical in tests (`columns=100`) and any real
  terminal ≥64 cols, so the test is faithful.

### B. `noir run` host-error contract (`orchestrator.ts`, `commands/run.ts`)

- `normalizeStreamEvent` (assistant branch): add `isError: true` when
  `r.is_api_error_message === true || typeof r.error === 'string'`. Optional-when-true keeps
  existing exact-shape consumers happy.
- `RunHostResult`: add `isError: boolean` and `errorText?: string` (first errored assistant text).
  `runHost` accumulates `errored ||= result.isError || assistant.isError` and captures `errorText`.
- `run.ts`:
  - `streamEvent` skips assistant events with `isError === true` (error text never reaches stdout).
  - `failed = result.exitCode !== 0 || result.isError`. On `failed`:
    - persist transcript first (unchanged, keep on failure);
    - `fail(EXIT.ERROR, msg, opts)` — throws `CommanderError` → `handleError` sets exit 1; under
      `--json` emits `{ok:false,error:{code:1,message}}`. Message embeds: resolved binary
      (`opts.command ?? host`), `errorText` (or stderr), auth hint when the category is auth
      (`run \`claude /login\`` / `\`claude auth login\`` — interactive-only so it cannot run
      inside `noir run`; note `ANTHROPIC_API_KEY` override if set), and the generic
      "pass `--command <binary>` for another profile" hint. Include `exitCode` + `transcript` in
      the message so `--json` consumers still see them (do not extend shared `fail()`).
    - do **not** print the usage line on failure; print it only on success.
  - **ENOENT / spawn error** (`catch`, run.ts:102): message names the **custom binary** when
    `--command` is set (today it wrongly names the host), and when
    `err.code === 'ENOENT'` adds: aliases/functions from the shell rc are invisible to `spawn()`
    — use an executable on `PATH`, an absolute path, or a launcher script (`~/.local/bin/<name>`).
  - Empty-prompt polish: when `--command` is set, echo it in the usage message
    (`a prompt is required: \`noir run --command <binary> <prompt>\``). Exit 2 / `{ok:false,code:2}`
    unchanged.
- Detection is `exitCode !== 0 || isError` (never trust `subtype:"success"` or exit 0 alone —
  claude can exit 0 with `is_error:true`, issue anthropics/claude-code#79500).

### C. Shell-bridge fallback for `--command` ENOENT (new `shell-bridge.ts`)

Only when the initial `spawn(binary)` fails **ENOENT**, and all guards pass:
- **Guards (skip → plain error):** win32; name contains `/`; name fails
  `^[A-Za-z0-9][A-Za-z0-9._+-]*$`; `$SHELL` unset or not `zsh|bash|fish`.
- **Probe (one-shot):** spawn `$SHELL` with `-lic` (login+interactive) and the **name passed only
  via argv** (never in the `-c` string), parsing sentinel-marked lines from stdout:
  - zsh: `-lic 'printf "\nN:%s" "$(whence -p "$1")"; printf "\nK:%s" "$(whence -w "$1")"' noirbridge NAME`
  - bash: `-lic 'shopt -s expand_aliases; [ -r "$HOME/.bashrc" ] && . "$HOME/.bashrc"; printf "\nN:%s" "$(type -P "$1")"; printf "\nK:%s" "$(type -t "$1")"' noirbridge NAME`
  - fish: `-ic 'printf "\nN:%s" (type -P "$argv[1]"); printf "\nK:%s" (type -t "$argv[1]")' noirbridge NAME`
  - `stdio:['ignore','pipe','pipe']`, Node-side timeout ~3000 ms + SIGKILL, kill via process group.
- **Outcome:**
  - `N:` resolves an absolute path (PATH visible only after rc) → **respawn that path directly**
    (plain `spawn`, no shell). Cache per name.
  - `K:` is `alias` or `function` → **bridge execution**: `$SHELL -lic 'NAME "$@"' noirbridge
    <flags...> <prompt>` — the prompt and flags arrive as positional args (`"$@"`), never parsed
    by the shell (injection-proof; verified against hostile prompts). Do **not** `exec NAME`
    (aliases don't expand from variables; bash can't exec functions).
  - otherwise → friendly "not found" error with launcher-script guidance.
- Wire into `runHost`: on spawn `error` with `code === 'ENOENT'` and guards pass, run the probe;
  on success re-enter the same spawn-and-consume pipeline (share the readline/usage/event logic).
- Never `shell:true` for user-influenced input (DEP0190); the prompt is always argv.

### D. Run profiles registry (`core/config.ts`, `bin.ts`, `commands/run.ts`)

- Config shape (`.noir/config.yml`), name-keyed map + sibling default key (VS Code / AWS / ssh):
  ```yaml
  run:
    defaultProfile: work        # optional; NOIR_PROFILE / --profile override it
    profiles:
      work:
        binary: /Users/me/bin/claude-work   # required
        env:                                # optional map<string,string|null>
          CLAUDE_CONFIG_DIR: /Users/me/.claude-work
          ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}   # ${VAR} expands from Noir's process env
        args: []                              # optional
  ```
- **`profiles`, not `commands`/`hosts`** (research: `profiles` is the established term for a
  name→{executable+settings} bundle; `hosts` collides with the adapter concept).
- Validation: name `^[A-Za-z0-9_-]+$` (no dots/spaces); reject duplicate keys at load; no magic
  `default` profile name.
- Selection precedence: `--profile <name>` flag > `NOIR_PROFILE` env > `run.defaultProfile` >
  built-in host default (unchanged). Explicitly named-but-missing → **hard error** listing
  available names (botocore semantics + inline list = Noir improvement).
- `env` merged over inherited env (null deletes the var); `${VAR}` expansion before spawn so
  literal secrets never need to be committed (`.noir/config.yml` is committable project state —
  only `.noir/store/` is gitignored).
- Listing surface: `noir run --list-profiles` printing `NAME  DEFAULT  BINARY`.
- Docs: `docs/how-to/host-profiles.md` (define → list → select → remove) + reference rows.

### E. `.noir/.env` loading (new `core/env-file.ts`, `daemon`, `cli/bin.ts`, `ignore-manager`)

- Single path: `<projectRoot>/.noir/.env`. Never read the project-root `.env` (belongs to the
  user's app). Missing file = silent no-op.
- Precedence: real env always wins; `.noir/.env` fills **unset** keys only (dotenv/Node default).
- Parser (shared core module, ~40 LOC, no new dependency): Node `--env-file` dialect —
  `KEY=VALUE`; skip blank lines; `#` full-line comments; trailing `#` starts a comment in
  unquoted values; single/double quotes stripped (whitespace preserved); `export ` prefix
  ignored; `EMPTY=` → `''`; last definition wins; **no** `${}` interpolation or command
  substitution (documented); malformed line → one-line stderr warning with line number + skip.
- Load eagerly **once**, before MCP server construction, in the **daemon** (covers
  GUI/launchd/detached) and at CLI bin entry (covers `noir run` host spawns).
- Security: add `/.noir/.env` to `ignore-manager` `IGNORE_ENTRIES` (scaffold gitignore); ship a
  `.noir/.env.example` placeholder in the scaffold; `noir doctor` warns (names only, never
  values) if the file is group/world-readable; 0600 when Noir creates it.

### F. Configuration documentation overhaul

- Root-cause: add `.describe()` to every field of `NoirConfigSchema`
  (`packages/core/src/config.ts`) and extend `scripts/docs-generate.mjs` to walk nested
  object/record fields (1–2 levels) so `docs/reference/config.md` becomes self-maintaining with
  real descriptions.
- New `docs/reference/environment.md`: one grouped table (Integrations / Provider keys /
  Updates / Terminal behavior / Advanced-test-only) — columns `Variable | Default | Required |
  Description`; conditional requirements inline ("required only when the noir-clickup
  integration is enabled"). Includes `CLICKUP_API_TOKEN` (placement + daemon-restart rule +
  **explicit note that team/list/space ids are config.yml keys, NOT env vars**) and every
  `NOIR_*` var from the audit.
- New `docs/how-to/clickup.md`: token acquisition, the three placement options ranked,
  daemon-restart rule, `integrations.clickup.*` example, audit-trail location.
- New `docs/how-to/host-profiles.md`: profile registry guide.
- `docs/reference/config.md` (generated + hand sections): precedence ladder intro
  (flag > env > config > default), grouped key tables with `Type | Default | Required |
  Description`, conditional rows, annotated default config (lazygit-style), version-since
  markers, secrets policy (`${VAR}` expansion; never commit literals; never pass tokens as CLI
  args). Mark parsed-but-inert keys honestly (`rules.enabled`, `update.display`,
  `context.roots`, `context.budgetTokens`, `daemon.port`) as not-yet-wired with a backlog note.
- `docs/getting-started.md`: add a `noir run` section (headline v1.11.0 feature, currently
  undocumented user-facing) + link the config/environment references.
- Fix drifts found by the audit: update-cache path is `~/.noir/update-cache.json` (docs said
  `update.json`); verify the `config.mode` claim; reword the `memory capture` template reference.
- Docs chain: getting-started → config reference → environment reference → clickup/how-to;
  list all from `docs/README.md`; `pnpm docs:validate` green.

## Out of scope (backlog)

- Wiring the parsed-but-inert keys (`rules.enabled`, `update.display`, `context.roots`,
  `context.budgetTokens`, `daemon.port`) — recorded as backlog, not implemented here.
- `memory capture` command (referenced by a template) — reword the template to the
  explicit-save reality; shipping the command is backlog.
- Windows PowerShell bridge for aliases — error-only on win32 for now.
- A gitignored secrets-split file (`.noir/config.local.yml`) — `${VAR}` expansion covers v1.

## Docs impact

CHANGELOG, `docs/roadmap/{releases.md,STATUS.md,backlog.md,roadmap.manifest.yaml}` update at the
checkpoint (Slice G). No release/tag this session.

## Verification

Full gate (`pnpm lint → build → typecheck → test → docs:validate`) green; new tests are all
offline/free. Run `noir run` failure + ENOENT + `--json` cases and palette render verified via
tests, not live host calls.
