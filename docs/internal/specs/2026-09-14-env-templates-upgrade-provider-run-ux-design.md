# Env Templates + Upgrade Completeness + Provider Gateways + `noir run` UX — Design

> **Status:** implemented (shipped 2026-09-16 in v1.15.0)
> **Target:** v1.15.0
> **Capability:** C2 CLI Runtime & UX + C5 Runtime Infrastructure (partial: model layer sits in
> `@noir-ai/model`, consumed by C7 consolidation) + C6 Documentation & Knowledge System
> **Slice id:** `env-upgrade-provider-runux`
> **Requires ADR:** ADR-0012 (provider transport fields + neutralizing SDK ambient env reads).
> No ADR needed for the template redesign (ADR-0011 already owns the doctrine surface) or for
> the upgrade fixes (they implement the §11 intent of the 2026-09-11 spec).
>
> **Provenance:** two multi-agent analysis workflows (2026-09-14), 30 agents total: 10 read-only
> codebase auditors, 6 web researchers, 12 adversarial verifiers + completeness critics. 3
> workflow-1 claims were adversarially corrected before landing here. User decisions locked
> before this spec: (D1) `refreshIfStale` for doc-only seeds, (D2) all of run-UX D1–D5 this
> release, (D3) config-driven gateway support with SDK ambient env reads neutralized.

---

## 1. Problem & motivation

Four user-reported defects, one root each: Noir's "one command keeps you current" promise is
not yet true, and its most-used surfaces (`.noir/.env`, `noir init --upgrade`, provider
config, `noir run`) predate the 1.13/1.14 hardening wave.

### 1.1 The env templates are two copies of one noisy file

`packages/create/templates/config.env.tmpl` (75 lines, renders `.noir/.env`) and
`packages/create/templates/env.example.tmpl` (79 lines, renders `.noir/.env.example`) share
67 of their bytes verbatim — 85% duplication. Only ~9 lines in either file are actionable
(uncommentable assignments); ~87% is prose. The "Model provider key" section embeds a 7-line
YAML block (config.yml syntax) inside an env file — a user who uncomments it gets a
`no "=" — skipped` parser warning per line. The doctrine header occupies 16 lines of both
files, and a shipped test (`packages/create/test/env-seed.test.ts:175-190`) *requires* the two
files to carry it verbatim ("one body, two files").

The user-visible consequence: a gateway user opening the scaffolded `.noir/.env` finds no
pointer to `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` / timeouts / model remaps at all —
the single most common non-conventional configuration today (verified across Z.AI, LiteLLM,
OpenRouter, Kimi, DeepSeek, Ollama, LM Studio official docs: a recurring five-slot pattern of
base URL + credential var + model-remap family + timeout + long-context window).

### 1.2 `noir init --upgrade` leaves six classes of artifact stale

Verified against the current tree (`packages/create/src/scaffold.ts`, `packages/create/src/manifest.ts`,
`packages/cli/src/init.ts`, `packages/cli/src/commands/doctor.ts`):

1. **`skipIfExists` seeds freeze forever.** `.noir/.env.example`, `.noir/config.yml`,
   `.noir/rules/RULES.md` stay at the bytes of the initializing Noir version. A 1.12-era
   `.env.example` documents the pre-ADR-0011 precedence (real-env-wins) that 1.14.0 explicitly
   inverted — no command short of hand-editing can fix it.
2. **`mergeJson` is backfilled by nothing.** Pre-C3 projects cannot obtain the SessionStart
   hook via `--upgrade`. (Recorded OPEN in backlog since 1.14.0; this slice keeps that
   decision — user-owned, write-once — but makes `doctor` report it instead of hiding it.)
3. **`--upgrade` ignores the configured host.** `init.ts` resolves `opts.host ?? 'claude'`
   with no config fallback, while `sync` and `doctor` both read `host:` from `config.yml`. On
   a cursor/gemini project, `--upgrade` writes a spurious claude surface and refreshes none of
   the real host artifacts.
4. **Skill refresh is silent-by-default and mis-reported.** Skills are re-emitted, but the
   non-interactive conflict default is `preserve`, so a CI/piped upgrade keeps stale skill
   bodies while the run still prints "Emitted N Noir skills"; the `--json` envelope omits
   skill conflict records entirely.
5. **The version stamp lies.** `checkScaffoldVersion` compares the stamp only, and the stamp
   is written to current after any successful upgrade regardless of what was refreshed, so
   `noir doctor` reports "up to date" on a stale tree.
6. **Pre-1.3.0 projects run zero migrations.** The migration gate is `fromVersion !== null`;
   a project with `project.id` but no stamp is stamped current without ever running a
   migration — permanently locked out of the one mechanism that can transform existing files.

### 1.3 The model layer has no first-class gateway transport, and one decoy field

`model.providers.<name>.baseURL` is accepted by the config schema
(`packages/core/src/config.ts:138-141`) and folded onto the dispatched request
(`packages/model/src/complete.ts:168`), but only the `openai-compatible` adapter ever reads
it. For a provider named exactly `anthropic`, the adapter constructs the SDK client with only
`{apiKey, maxRetries}` and silently drops `baseURL` (`packages/model/src/providers/anthropic.ts:102-105`,
pinned by test). The request therefore goes to the **wrong host**, not the wrong wire format.

The corporate-gateway case *works today by accident*: the `@anthropic-ai/sdk` constructor reads
`ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` from `process.env` on its own when the client
is built without them — which **contradicts the module's own stated invariant** that env-var
presence is never consulted ("provider-explicit, no silent paid calls" governs provider
*selection*, but `anthropic.ts:18-24` and `complete.ts:5-9` promise no env fallback at all;
the guard at `anthropic.ts:91-93` blocks only the `apiKey` env fallback).

Capability matrix today: custom baseURL for an Anthropic-shaped endpoint = partial (ambient
env only; config field is a decoy); Bearer auth from config = impossible (schema has exactly
`model`/`baseURL`/`apiKeyEnv`); per-tier model ids = partial; request timeout = impossible
(`API_TIMEOUT_MS` is read nowhere in `packages/*/src`; the anthropic SDK default is 600 s,
`openai-compatible` hardcodes 120 s); custom headers = impossible via config.

### 1.4 `noir run` UX: a dead palette row, a frozen indicator, and a dead end after the answer

Empirically reproduced against the built CLI (15 agents, all adversarial verdicts CONFIRMED):

- **The palette row for `run` is dead-on-arrival.** Selecting it dispatches bare `['run']`
  and fails with exit 2 ("a prompt is required"). The palette has no argument-collection
  capability: rows carry a fixed argv, typing only filters. The `needsArg` mechanism exists
  (`packages/cli/src/tui/commands/sections.ts:42-45`) but is honored only by the @clack home
  menu and dropped by the Ink palette (`rows.ts:147`). Six leaves with required positionals are
  affected (`context search`, `daemon join`, `memory forget`, `memory recall`, `task block`,
  `task decompose`). `run` declares its prompt as optional (`[prompt...]`, so `--list-profiles`
  works with no argument) and therefore is NOT one of them — it instead gets its requirement from
  the curated palette action. `run` is also absent from the home sections. The only working path
  today is typing `/run <prompt>` in the dashboard.
- **No visual feedback at either layer.** In the TUI, `capture.ts:31-59` swaps
  `process.stdout.write` and `process.stderr.write` for string collectors for the whole
  dispatch; the OutputPane is filled only after the await resolves. The dashboard shows a
  static "…" and "running… (Ctrl+C to force exit)"; status polling is paused; Ink never
  re-renders (a load-bearing invariant — Ink itself renders through the same swapped
  `process.stdout.write`). In the terminal, assistant text streams, but the gap before the
  first token is dead air — worst case unbounded (no timeout, no watchdog; host stderr is
  buffered and withheld until the end).
- **Post-run is dump-and-exit.** The answer text is streamed and discarded; the only persisted
  artifact is the raw stream-json transcript. `noir memory capture` exists end-to-end but
  stores content verbatim (no distill), so feeding it a raw transcript would ingest garbage.
  Session continuation (`--continue`/`--resume`) is a first-class follow-up action across the
  ecosystem (Claude Code, Codex `exec resume`, Gemini `/resume`) and `session_id` already
  arrives in the `init` event — but Noir never surfaces it.

---

## 2. Research grounding (selected, all official-source verified)

- **Claude Code credential semantics:** `ANTHROPIC_AUTH_TOKEN` → `Authorization: Bearer`;
  `ANTHROPIC_API_KEY` → `x-api-key`; setting both produces an auth-conflict warning (official
  precedence unstated; community-ranked AUTH_TOKEN above API_KEY). `ANTHROPIC_BASE_URL` is a
  host-only base (Claude Code appends `/v1/messages`); a non-first-party host disables MCP
  tool-search by default (`ENABLE_TOOL_SEARCH=true` re-enables).
- **Model remap family (current, non-deprecated):** `ANTHROPIC_MODEL` +
  `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` (+ `_FABLE`, `_DEFAULT_MODEL`).
  `ANTHROPIC_SMALL_FAST_MODEL` is deprecated. `API_TIMEOUT_MS` is Claude Code-only
  (default 600000 ms). `CLAUDE_CODE_AUTO_COMPACT_WINDOW` exists (100000–1000000).
- **Gateway pattern set:** Z.AI `https://api.z.ai/api/anthropic` + AUTH_TOKEN; LiteLLM port
  4000 (unified or `/anthropic` pass-through); OpenRouter `openrouter.ai/api` + AUTH_TOKEN +
  `ANTHROPIC_API_KEY` explicitly empty; Kimi `api.moonshot.ai/anthropic`; LM Studio now ships
  an Anthropic-shaped `/v1/messages` on :1234 (AUTH_TOKEN=lmstudio). OpenAI side:
  `OPENAI_BASE_URL` (current) vs `OPENAI_API_BASE` (legacy).
- **stream-json contract:** event union = `system` (init + subtypes incl. `api_retry`,
  `tool_progress`, `thinking_tokens`, `task_progress`), `assistant`, `user` (tool_result),
  `stream_event` (only with `--include-partial-messages`), `result`. Partial text deltas are
  OFF by default; tool name streams live at `content_block_start.content_block.name`;
  per-message `usage.output_tokens` is a placeholder (the reducer's max-per-message.id rule is
  therefore load-bearing). `result` carries `duration_ms`, `usage`, `total_cost_usd`
  (client-side estimate), `num_turns`, `session_id`, `subtype` union. `--continue`/`--resume`
  documented; headless exit contract: SIGTERM → exit 143, transcript preserved.
- **Progress UX conventions:** progress → stderr (curl/npm/docker/POSIX diagnostic-stream
  precedent; clig.dev data-vs-messaging split); humanized elapsed (`2m 18s`, not `125s`);
  Claude Code's own status convention `✳ verb… (2m 18s · ↓ 4.8k tokens)`; non-TTY fallback =
  plain periodic status lines, no ANSI; NO_COLOR governs color only, not motion.
- **Spinner/stream coexistence:** ora v9 hooks `write()` and defers re-render 200 ms after a
  non-newline write — the exact hazard when composing with mid-line assistant text. The safe
  pattern for our terminal progress is a **single status line on stderr, redrawn only on
  event boundaries**, never overlapping an in-flight stdout text write without a newline.
- **Post-run UX precedent:** pipeline-first ecosystem (`gh --json | jq`, `codex exec | tee`,
  official Claude Code `session_id=$(claude -p --output-format json | jq -r .session_id)`
  round-trip); `git add -p` fixed-keystroke vocabulary for item menus; clig.dev
  conditional-interactivity law (TTY-gate prompts; `--no-input` never prompts; degrade with
  exit + message, never a hang).
- **`.env` practice:** "keep `.env` minimal, explanation in `.env.example`" is a community
  pattern, not framework consensus (only Laravel prescribes it officially). Adoptable rules:
  state precedence in the header; declare what a commented line means (Grafana: "Everything
  has defaults so you only need to uncomment things you want to change"); quote values with
  `#`/whitespace; descriptive placeholders over realistic prefixes (secret-scanner
  friendly); keep `.env.example` a compact contract linking to the reference page.

---

## 3. Goals & non-goals

### Goals

1. Two **deliberately different** env templates: a concise uncomment-to-enable `.noir/.env`
   and a detailed purpose-documenting `.noir/.env.example`, both accurate to the shipped
   reader set (including the gateway block).
2. `noir init --upgrade` becomes the one command that makes an existing project current:
   host-aware, honest reporting, `refreshIfStale` for doc-only seeds, migrations that reach
   legacy projects, a doctor that sees content drift.
3. A config-driven, provider-explicit gateway transport in `@noir-ai/model`
   (`baseURL`/`authTokenEnv`/`timeoutMs` honored by the anthropic adapter; SDK ambient env
   reads neutralized to match the stated invariant).
4. A `noir run` that is drivable from the palette (argument collection), visibly alive
   (terminal status line + TUI live progress), safe to interrupt (Ctrl+C contract), and
   useful after the answer (post-run actions incl. save-to-memory and session continuation).

### Non-goals (this slice)

- No multi-turn orchestration loop in Noir (single-shot law stands; `--continue` is a
  *follow-up invocation*, not a conversation).
- No new spinner library; the terminal status line is hand-rolled against the existing
  output helpers.
- No change to the `mergeJson` write-once decision (backlog OPEN stands; `doctor` visibility
  only).
- No Windows-specific work (the case-folding backlog items stay deferred).
- No streaming of *thinking* blocks or token-exact billing (usage stays the reducer's
  max-per-message.id estimate).
- The daemon/MCP layer gains no run tool — TUI run rides the CLI dispatch seam.

---

## 4. Part A — Env template redesign

### 4.1 Design split

**`config.env.tmpl` → `.noir/.env` (concise, uncomment-to-enable):**

```
# .noir/.env — project configuration & secrets (chmod 600, gitignored).
# This file WINS over your shell environment for every key it defines.
# Run `noir env` to see the winning source per key.
#
# Everything below is commented out: Noir works with defaults.
# Uncomment a line and set a real value to enable it.
# Full reference: docs/reference/environment.md

# --- Host gateway (Claude Code via Z.AI / LiteLLM / OpenRouter / Kimi ...) ---
# Point the host at an Anthropic-shaped endpoint. BASE_URL is host-only
# (no /v1). AUTH_TOKEN is sent as Authorization: Bearer.
# ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic
# ANTHROPIC_AUTH_TOKEN=replace-with-your-gateway-token
# Remap the haiku/sonnet/opus aliases to gateway model ids:
# ANTHROPIC_DEFAULT_HAIKU_MODEL=glm-5.3-flash
# ANTHROPIC_DEFAULT_SONNET_MODEL=glm-5.3
# ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5.3
# API_TIMEOUT_MS=3000000
# CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000

# --- Integrations ---
# CLICKUP_API_TOKEN=replace-with-your-clickup-token

# --- Remote embedders (context.embedder.kind: remote) ---
# OPENAI_API_KEY=replace-with-your-openai-key
# VOYAGE_API_KEY=replace-with-your-voyage-key
# COHERE_API_KEY=replace-with-your-cohere-key
# OLLAMA_BASE_URL=http://localhost:11434

# --- Model provider key (read via apiKeyEnv in .noir/config.yml) ---
# ANTHROPIC_API_KEY=replace-with-your-anthropic-key

# --- Run profile selection (noir run) ---
# NOIR_PROFILE=work

# --- Update kill-switches ---
# NOIR_DISABLE_UPDATE_CHECK=1
# NOIR_DISABLE_UPDATES=1
```

Rules applied (research-grounded): precedence stated in-header in 3 lines; the meaning of a
commented line declared once; sections separated by `---` banners; every placeholder
descriptive (`replace-with-your-…`) — no `sk-`-shaped fakes (secret-scanner friendly); the
gateway section first (the most common customization); no YAML inside the env file.

**`env.example.tmpl` → `.noir/.env.example` (detailed, committable documentation):** opens
with the file's purpose (what `.noir/.env` is for, the precedence ladder incl. run profiles,
the 0600/gitignore/tracked-refusal contract, "never commit the real file, commit this one"),
then documents each section in one-to-three lines per key — including the header-semantics of
each gateway variable (`Bearer` vs `x-api-key`, host-only BASE_URL, both-set conflict), the
`apiKeyEnv`-is-a-name rule, and the anti-documentation note that `CLICKUP_TEAM_ID` is
config.yml, not env. Ends with the link to `docs/reference/environment.md`. No doctrine
verbatim shared with `.env` — the "one body, two files" assertion is retired.

### 4.2 Constraint compliance

- Parser: every line stays a full-line `#` comment (the emitted `.env` must keep
  `loadNoirEnv` warnings exactly empty — POSIX test). No value contains `#` unquoted.
- `env-seed.test.ts` rewritten: doctrine-verbatim test deleted; new assertions — both files
  all-comment; `.env` ≤ 60 lines and ≥ 200 bytes; `.env.example` contains the purpose
  header, the precedence ladder, all documented variable names, the gateway block
  (BASE_URL + AUTH_TOKEN + one DEFAULT_*_MODEL), the apiKeyEnv-name rule, and the
  environment.md link; no `sk-`-shaped placeholders; no active `KEY=` lines.
- `CURRENT_SCAFFOLD_VERSION` → `1.2.0` with a registered migration (Part B).
- Four "same variable set" surfaces updated in-change: `config.env.tmpl` (self-reference),
  `env.example.tmpl` header, `packages/create/templates/noir-readme.md.tmpl` (managedBlock —
  re-emit propagates to existing projects on next sync), `docs/getting-started.md`.

---

## 5. Part B — `noir init --upgrade` completeness

### 5.1 Host-aware upgrade

`init.ts` host resolution becomes `--host flag > .noir/config.yml host: > 'claude'` — the
same precedence `sync` already implements. Regression test: a scaffolded cursor project
upgraded without `--host` refreshes cursor artifacts and writes no claude surface.

### 5.2 `refreshIfStale` for doc-only seeds

New write mode semantics (implementation detail: a `refreshIfStale: true` flag on the
manifest entries for `.noir/.env.example` and `.noir/rules/RULES.md`, honored by the
upgrade path only):

- File absent → create (existing `skipIfExists` behavior).
- File present and byte-equal to the render of the *previous* Noir version's template
  (looked up from the packaged template history — see 5.5) → **auto-refresh silently**; the
  user never edited it.
- File present and edited → existing conflict flow (interactive prompt,
  `preserve`/`regenerate`, default `preserve`; non-interactive → `preserve` + reported).
- `.noir/.env`, `.noir/config.yml`, `.noir/project.id` keep pure `skipIfExists` — user-owned,
  never auto-touched.

### 5.3 Honest skill + summary reporting

`emitted` counts only skills actually written (not preserved); the human summary and the
`--json` envelope both carry per-skill conflict records. Non-interactive upgrades print a
`N skill(s) preserved as stale (interactive TTY required to refresh)` line when > 0.

### 5.4 Legacy + stamp honesty

- Migration gate: a stamp-less project (project.id present, no stamp) is treated as
  `fromVersion = '0'` (runs the full registered chain), not skipped-then-stamped-current.
- `checkScaffoldVersion` (doctor) additionally reports doc-seed drift: an `.env.example`
  byte-equal to an *older* template render is reported as stale with the fix hint
  (`noir init --upgrade`).

### 5.5 Template history (the `refreshIfStale` primitive)

`packages/create/src/template-history.ts`: a small registry mapping
`scaffoldVersion → { envExample, rulesSeed }` template bytes (the 1.1.0 templates are
snapshotted from the git tag at authoring time and committed as literals — a published
tarball cannot read a git tag; each future template change appends an entry).
`isStaleSeed(fileBytes, currentRender)`: stale iff the file bytes match a history entry that is
not the current render — pure, no I/O, so the caller owns the read and the absent case. The
`currentRender` guard is checked first, so a file already at the current render is never
stale. This is the "rewrite only if still equal to the old template" primitive the 1.14.0
audit identified as missing.

### 5.6 Migration `1.1.0 → 1.2.0`

Registered migration performs the Part A template swap via `refreshIfStale` (the mechanism,
not a bespoke rewrite) and appends nothing to `config.yml`. Stamp bumped to `1.2.0`.

### 5.7 Security fix: deny-list `run.profiles.<n>.env`

`mergeEnv` in `run.ts` (and the profile interpolation path in `run-profiles.ts`) applies the
same `PROCESS_INJECTION_ENV_RE` refusal as `.noir/.env`: a profile defining a deny-listed key
is refused at profile-resolution time (exit 2, naming the key), closing the committable-
config.yml → `NODE_OPTIONS` spawn-injection hole. Regression test: a profile with
`NODE_OPTIONS` fails cleanly.

---

## 6. Part C — Provider gateway transport (ADR-0012)

### 6.1 Config schema (`packages/core/src/config.ts` + `@noir-ai/model` types)

`model.providers.<name>` gains:

```ts
{
  model?: string
  baseURL?: string          // now honored by BOTH anthropic and openai-compatible adapters
  apiKeyEnv?: string        // x-api-key (anthropic) / Bearer (openai-compatible) — unchanged semantics
  authTokenEnv?: string     // NEW — Authorization: Bearer for anthropic-shaped endpoints
  timeoutMs?: number        // NEW — per-request timeout, min 1000, default: SDK default
}
```

`authTokenEnv` follows the same name-indirection rule as `apiKeyEnv` (the config stores a
NAME; the value is read from the overlaid `process.env` at call time).

### 6.2 Adapter changes (`packages/model/src/providers/anthropic.ts`)

- The SDK client is constructed with `{apiKey?, authToken?, baseURL?, timeout?, maxRetries}`
  from the resolved request fields — `baseURL` is no longer dropped.
- **Ambient env neutralized:** the client is constructed with explicit `baseURL:
  req.baseURL ?? defaultBaseURL` and, when neither `apiKey` nor `authToken` resolved, the
  existing null-degradation fires *before* the client is built — so the SDK's own
  constructor-time reads of `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY`
  can never route a request the provider-explicit path did not choose. (Mechanism: pass
  explicit `apiKey: null`-equivalents per SDK option semantics — verified against the SDK's
  precedence: constructor args beat env.)
- `timeoutMs` maps to the SDK `timeout` option (milliseconds — SDK-native unit).

### 6.3 Invariants preserved

- Single-shot: unchanged (no tools/stream parameters exist).
- No silent paid call: provider selection remains config-only; the null-degradation contract
  is *strengthened* (ambient env can no longer produce a paid call the config did not ask
  for). `ANTHROPIC_API_KEY` set with no model config still returns `null` at
  `complete.ts:135-136`.
- Provider-explicit: now true in the letter, not just the intent.

### 6.4 Surfacing

`noir env` gains a gateway section (curated keys: `ANTHROPIC_BASE_URL`,
`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `API_TIMEOUT_MS` — with winning source, names
only). Its provenance is file-vs-environment: run profiles are resolved at `noir run` time, so
a profile-sourced value is not a source `noir env` can attribute, and `noir run` surfaces it in
its own credential note instead. `docs/reference/environment.md` + `config.md` gain the
ANTHROPIC_* entries and the `authTokenEnv`/`timeoutMs` fields (self-maintaining via
`.describe()`).

---

## 7. Part D — `noir run` UX

### 7.1 D1: terminal status line (stderr)

A hand-rolled status line — no ora — written to stderr, redrawn only at event boundaries:

- Seeded at spawn: `▶ claude · waiting for first event…`
- `init`: `▶ claude · {model} · {mm:ss elapsed}`
- `assistant`: `● {model} · {elapsed} · ↓{input}↑{output} tokens` (running totals from a
  second UsageReducer fed in `onEvent`; max-per-message.id dedup preserved).
- Tool activity (normalizer extension, 7.3): `⚙ {toolName}…`
- End: the line is cleared and replaced by the existing summary.
- Gated: `!opts.json && !opts.quiet && stderr.isTTY` — otherwise silent (non-TTY fallback:
  nothing; `--json`/`--quiet` pins preserved byte-for-byte). Non-TTY interactive runs print
  one plain line at start and one at end.
- Host stderr is no longer fully withheld: a bounded tail (last ~20 lines) surfaces on
  failure, and progress-bearing stderr lines pass through live when stderr is a TTY.

### 7.2 D2: palette argument collection

`PaletteRow` grows `needsArg?: string` (the label shown in the input placeholder). On Enter
with `needsArg`, the palette enters an inline argument step (the existing input line,
placeholder `prompt for run…`), then dispatches `[...argv, arg]`. Registry derives `needsArg`
from commander's own `requiredArgument`s introspection (no hand-maintained list). Fixes all
six dead leaves. `run` gains a curated home-section entry ("Ask the host"). Destructive
confirm unchanged.

### 7.3 D3: TUI live progress (run mode)

New App mode `run`. Entry: palette/home `/run` action, or typed `/run <prompt>`. Execution is
**in-process**: the mode imports `runHost` from `orchestrator.js` (already in the TUI bundle)
and streams events into React state — OutputPane grows a live region (append-only lines),
StatusBar shows `run · {model} · {elapsed} · {tokens}` (the deferred ADR-0008 token/cost
bar), and the mode owns input (`Esc` cancel → child SIGTERM, 7.5). The capture invariant is
respected by construction: the run mode does NOT dispatch through `captureProcessOutput` —
host output flows through the event stream into Ink state, never through the swapped
`process.stdout.write`. The `/run` dispatch path (non-run-mode) keeps today's capture
behavior for backward compatibility. The 2026-08-14 v2-orchestrator spec's deferred items
(transcript picker: the run mode lists recent transcripts behind `Ctrl+T`) are folded in
where cheap.

Normalizer extension (feeds D1 + D3): recognize `stream_event` frames when
`--include-partial-messages` is active (added to HOST_FLAGS for claude), surfacing
`content_block_start.tool_use.name` as a tool-activity event; `messageText()` no longer drops
tool_use-only assistant lines (they yield a tool event instead of text). The `other` kind
gains an optional `subtype` discriminator. UsageReducer contract unchanged.

### 7.4 D4: post-run action menu

After a successful interactive run (terminal and TUI run-mode alike), offer actions —
terminal: `@clack/select` (lazy import, existing pattern); TUI: a `PostRunOverlay` modeled on
`ConfirmOverlay`:

1. **Save to memory** — distills via `memory_capture` (plain-text answer accumulator built in
   `run.ts`; `--json` envelope gains `answerText`), provenance `capture`.
2. **Add as task research** — `workflow_research_record` (source = `noir run`).
3. **Write handoff artifact** — `noir handoff --write` seam.
4. **Continue session** — re-invokes the host with `--resume <sessionId>` (sessionId surfaced
   from the `init` event; the prompt is collected fresh). Single-shot law preserved: this is
   a *new* invocation.
5. **Copy/save answer** — writes the accumulated answer text to a file or stdout.
6. **Dismiss** (default).

Law: interactive-only — `isInteractive()` gate (stdin+stdout TTY, false under
`--json`/`--no-input`/CI/NO_COLOR); non-interactive runs behave exactly as today. Memory
write goes through the daemon client (single-writer), degrading to a reported skip when the
daemon is unavailable. `memory_capture` receives the distilled answer, never raw stream-json.

### 7.5 D5: Ctrl+C / interrupt contract

- Terminal: `SIGINT`/`SIGTERM` handlers write the transcript (best-effort), terminate the
  child (`SIGTERM`, then `SIGKILL` after 5 s), print `interrupted · transcript: <path>`, exit
  130/143 per convention. (Host contract: `claude -p` on SIGTERM exits 143 and preserves its
  own transcript — documented, relied upon.)
- TUI run mode: `Esc` = the same path in-process (child kill + transcript + return to
  dashboard). TUI raw-mode Ctrl+C (0x03) is mapped to the same handler while a run is
  in-flight (Ink's default unmount is intercepted for the run mode only).
- No orphaned children: the child is spawned non-detached in noir's process group (current
  behavior verified correct in a terminal); the run mode adds explicit child tracking so the
  kill path works regardless of how the TUI exits.

---

## 8. Security & isolation

- Part B 5.7 closes a real injection hole (profile env → spawn).
- Part C neutralizes ambient-env routing in the model layer (a `.noir/.env` key can no longer
  silently redirect consolidation traffic to an attacker-chosen host *via the SDK*; it can
  only do so via explicit config, which is the auditable path).
- Part D adds no new secret-bearing output: status lines carry names/counts only; transcripts
  stay 0600; `answerText` in `--json` is the answer, not the environment.
- The post-run memory write goes through the daemon (single-writer invariant).

---

## 9. Compatibility & migration

- **Breaking (template semantics):** the two templates' content changes; existing projects
  are migrated by the `1.1.0 → 1.2.0` refreshIfStale migration. No file format changes.
- **Breaking (model layer, narrow):** the anthropic adapter no longer honors ambient
  `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` — users relying on the accidental path must
  add `baseURL`/`authTokenEnv` to `model.providers` (documented in CHANGELOG + config docs;
  the host-passthrough path via `.noir/.env` for `noir run` is unaffected).
- `noir run` output contract: stdout unchanged; stderr gains the status line (TTY-gated);
  `--json`/`--quiet` byte-pinned by existing tests.
- Palette UX: rows that needed args now prompt instead of failing exit 2 — strictly wider.

---

## 10. Acceptance criteria

1. Fresh `noir init`: `.env` ≤ 60 lines, all-comment, warnings-empty, gateway section
   present; `.env.example` detailed + different; all four "same variable set" surfaces
   updated; full gate green.
2. A 1.14.0-era project: `noir init --upgrade` → host-aware artifacts, `.env.example`
   auto-refreshed (unedited case) / conflict-prompted (edited case), skills honestly
   reported, doctor shows drift before / clean after; pre-1.3.0 project runs migrations.
3. Gateway config (`providers.anthropic { baseURL, authTokenEnv, timeoutMs }`) reaches the
   configured endpoint with Bearer auth and the configured timeout; ambient env is inert;
   `ANTHROPIC_API_KEY` + no config still returns `null`.
4. `noir run` from the palette prompts for the prompt and works; terminal runs show the
   status line (TTY) and nothing under `--json`; TUI run mode streams live output + tokens;
   Ctrl+C/Esc leaves a transcript, no orphan; post-run menu saves to memory / continues the
   session; non-interactive behavior byte-identical to 1.14.0.
5. Profile with `NODE_OPTIONS` refused at resolution (exit 2).

---

## 11. Testing plan (offline — never network/key)

- Template: rewritten `env-seed.test.ts` (structure, all-comment, warnings-empty, no
  active lines, placeholder hygiene); template-history unit tests (stale/edited/absent).
- Upgrade: host-fallback test; refreshIfStale triple-state test (absent/stale/edited ×
  interactive/non-interactive); honest skill-count test; stamp-less migration test; doctor
  drift test; profile deny-list test.
- Provider: anthropic adapter constructs with forwarded fields (assert client options via a
  seam — the adapters already take an SDK-client factory in tests); ambient-env inertness
  test (set env, no config → null); timeoutMs mapping test; `noir env` gateway section test.
- Run UX: status-line writer unit tests (TTY gating, boundaries, clear-on-end); palette
  needsArg flow test (ink-testing-library, existing harness); normalizer tool-event tests;
  run-mode streaming test (mock runHost event source); post-run menu tests (interactive
  select paths + non-interactive no-op + daemon-unavailable degradation); interrupt tests
  (SIGINT → transcript + exit 130, child kill, 5 s SIGKILL escalation); `--json`/`--quiet`
  byte-pins re-asserted.

## 12. Documentation plan

- `docs/reference/environment.md`: ANTHROPIC_* entries, gateway section, corrected deny-list
  table, `SHELL`/`npm_config_user_agent` entries, `NOIR_NON_INTERACTIVE` ambient-delete note.
- `docs/reference/config.md`: `authTokenEnv`/`timeoutMs` (via `.describe()` regeneration).
- `docs/getting-started.md` + `docs/how-to/`: the two-file split, gateway how-to (Z.AI /
  LiteLLM / OpenRouter examples), `noir run` progress + post-run actions.
- `docs/roadmap/`: STATUS + releases entry; backlog: resolve the profile-deny-list item,
  record the `mergeJson` doctor-visibility decision.
- ADR-0012 written before implementation of Part C.
