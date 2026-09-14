/**
 * Template history — the evidence needed to decide whether a shipped seed
 * file may be refreshed during an upgrade.
 *
 * WHY THIS EXISTS
 * ---------------
 * `noir init` writes two files whose only job is to be read by a human:
 * `.noir/.env.example` (documents the variable set) and `.noir/rules/RULES.md`
 * (the AI working-contract seed). Both are emitted create-only-if-absent, and
 * that is normally the right contract: once a file exists, the user owns it and
 * Noir must never overwrite their edits.
 *
 * It has one bad consequence. When a later release adds a variable to
 * `.noir/.env.example`, an already-initialized project keeps the old text
 * forever — the upgrade path cannot tell "the user rewrote this file" apart
 * from "the user never touched it, and the shipped text has moved on". Those
 * two need opposite handling: leave the first alone, refresh the second. A
 * plain-content check cannot distinguish them, and nothing on disk records the
 * bytes that were originally written.
 *
 * This module supplies the missing evidence. It holds the exact bytes of the
 * seed templates as they shipped at each past scaffold version, so a caller can
 * ask: "are the bytes on disk identical to some version Noir once wrote, and
 * different from what Noir writes today?" If yes, the file is an unedited
 * leftover and refreshing it loses nothing.
 *
 * THE CONTRACT
 * ------------
 * {@link isStaleSeed} answers exactly that question. It is deliberately
 * conservative in one direction: it returns `true` only on an exact match
 * against a recorded past version, so ANY other byte difference — a user edit,
 * a re-wrapped line, even a CRLF line-ending conversion from a Windows
 * checkout — reads as "user-owned" and the file is left untouched. A missed
 * refresh is a documentation gap; a wrong refresh destroys user work. The
 * asymmetry is intentional and should not be "fixed" into a fuzzy match.
 *
 * Each entry holds the text of BOTH seeds, so the comparison takes the seed it
 * is about as an argument and scans only that field. Scanning all of them would
 * let a `.env.example` match the recorded working-rules text (or the reverse),
 * and since the caller's response to `true` is an overwrite, a mixed-up pairing
 * would discard an edit the user is entitled to keep. The caller knows which
 * file it just read; the argument makes it say so.
 *
 * RENDERING
 * ---------
 * Seed templates are normally interpolated through `render(template, vars)`
 * before writing. That step is a no-op for the two templates recorded here:
 * neither contains a `{{...}}` token, so `render(text, vars) === text` for
 * every possible `vars`. The registry therefore stores raw template text and
 * {@link isStaleSeed} compares it against raw file bytes — no `vars` argument
 * is needed, and callers do not have to reconstruct the context that wrote the
 * file years ago.
 *
 * That equivalence is load-bearing, so it is asserted rather than merely
 * documented: `template-history.test.ts` fails if any recorded template
 * contains a `{{` token. A future seed template that DOES interpolate needs
 * `render` applied to the history entry (and a `vars` parameter on the
 * comparison) before it is added here — the test exists to make that
 * requirement impossible to overlook.
 *
 * APPENDING TO THE HISTORY
 * ------------------------
 * Record the template bytes as they shipped, keyed by the scaffold version
 * whose `init` wrote them, and never edit an existing entry — a user's disk
 * still holds those old bytes, and rewriting history would silently reclassify
 * their file as "current" (no refresh) or "unknown" (no refresh). The same
 * reasoning that keeps npm versions immutable applies here.
 */

/**
 * Which recorded seed a comparison is about. The values mirror the field names
 * of {@link SeedTemplateHistoryEntry}: every entry carries the text of both
 * seeds, and a caller must name the one whose bytes it read (see
 * {@link isStaleSeed} on why the pairing is load-bearing).
 */
export type SeedKind = 'envExample' | 'rulesSeed';

/**
 * The seed templates as they shipped at one past scaffold version.
 *
 * Only the doc-only seeds are tracked. Files the user is expected to edit
 * heavily (`.noir/config.yml`, `.noir/project.id`) are not candidates for
 * refresh at all, and co-owned files that carry a managed region already have a
 * three-way merge path of their own.
 */
export interface SeedTemplateHistoryEntry {
  /**
   * Bare `x.y.z` scaffold version whose `init` wrote these bytes — the value
   * stamped into `.noir/scaffold-version` at the time, with no `v` prefix and
   * no pre-release suffix.
   *
   * Spelled out literally rather than read from `CURRENT_SCAFFOLD_VERSION`:
   * the version recorded here is a historical fact about these bytes, so it
   * must not advance when the current version does.
   */
  readonly scaffoldVersion: string;
  /** Raw text of the `env.example` template at this version (see the module
   *  header on why raw text equals the rendered file for this template). */
  readonly envExample: string;
  /** Raw text of the `rules-seed.md` template at this version. */
  readonly rulesSeed: string;
}

/**
 * `.noir/.env.example` as shipped by scaffold version 1.1.0 — the first
 * version to emit it. Captured verbatim from the packaged template so the
 * bytes are byte-identical to what landed in users' repositories.
 *
 * `\${` and `` \` `` appear below because the text itself contains those
 * characters; the escape sequences decode back to the original bytes, which
 * `template-history.test.ts` verifies against a recorded digest.
 */
const ENV_EXAMPLE_1_1_0 = `# .noir/.env.example — committable documentation of the format.
#
# This file is a TEMPLATE and is never loaded. Noir reads \`.noir/.env\`, which
# \`noir init\` already created for you at mode 0600 — edit that file and
# uncomment the entries you need. Keep this example in git so the variable set
# stays discoverable.
#
# ---------------------------------------------------------------------------
# The block below is the same header \`.noir/.env\` carries (spec 12.1).
# ---------------------------------------------------------------------------
#
# .noir/.env — project-scoped configuration for this repo.
#
# This file is the recommended home for project-scoped configuration and
# secrets. Precedence:
#   1. run profile env     run.profiles.<n>.env      (per-invocation; merges OVER)
#   2. .noir/.env          <- recommended home for project-scoped configuration
#   3. real environment    CI / container / launchd / shell rc
#   4. built-in default
#
# A real environment variable is a FALLBACK: it applies only to keys this file
# leaves unset. A machine-global export therefore cannot shadow a value here.
# Run \`noir env\` to see which source is winning for each key.
#
# Keep this file private: chmod 600 .noir/.env
# It is gitignored by Noir's managed .gitignore block, and Noir REFUSES to load
# it if it is tracked by git (a cloned repo could redirect credentials).
# Never commit \`.noir/.env\`. (THIS file is the committable one.)

# --- Integrations -----------------------------------------------------------
# ClickUp — only if the noir-clickup integration is enabled.
# CLICKUP_API_TOKEN=pk_00000000000000000000000000000000
#
# CLICKUP_TEAM_ID is NOT an env var — Noir never reads it. Workspace binding
# (team/list/space ids) is config.yml instead:
#   integrations:
#     clickup:
#       teamId: "ABC123"   # optional — only for custom task IDs (#ABC-123)

# --- Remote embedders (context.embedder.kind: remote) -----------------------
# The default local embedder (kind: local) needs no key.
# OPENAI_API_KEY=sk-000000000000000000000000000000000000000000000000
# VOYAGE_API_KEY=pa-0000000000000000000000000000000000000000000000
# COHERE_API_KEY=0000000000000000000000000000000000000000
#
# Ollama (kind: ollama) reads its base URL from config.yml
# (context.embedder.baseURL); this variable is the fallback:
# OLLAMA_BASE_URL=http://localhost:11434

# --- Model provider key -----------------------------------------------------
# There is NO fixed "model key" variable, and setting one is not enough on its
# own. \`apiKeyEnv\` is a NAME, not an interpolation: the config stores the
# variable NAME and Noir reads process.env[<that name>] at call time. Write the
# bare name — never \`\${...}\` — in .noir/config.yml:
#
#   model:
#     providers:
#       anthropic:
#         apiKeyEnv: ANTHROPIC_API_KEY   # -> reads $ANTHROPIC_API_KEY
#     tiers:
#       default:
#         provider: anthropic
#
# Only \`run.profiles.<name>.env\` interpolates \`\${VAR}\`. With no provider
# configured the model layer degrades to templates — Noir never makes a silent
# paid call. \`ANTHROPIC_API_KEY\` is the conventional example, not a variable
# Noir looks up on its own:
# ANTHROPIC_API_KEY=sk-ant-0000000000000000000000000000000000000000000000

# --- Run profile selection --------------------------------------------------
# Selects a \`run.profiles.<name>\` entry for \`noir run\`.
# Precedence: --profile flag > NOIR_PROFILE > run.defaultProfile > host default.
# NOIR_PROFILE=work

# --- Update kill-switches ---------------------------------------------------
# NOIR_DISABLE_UPDATE_CHECK=1   # suppress the background startup check only
# NOIR_DISABLE_UPDATES=1        # make \`noir update\` refuse (exit 2)

# See docs/reference/environment.md for every variable Noir reads.
`;

/**
 * `.noir/.env.example` as shipped by scaffold version 1.2.0 — the env-template
 * redesign (gateway section first, a full purpose/precedence/commit guide, and
 * placeholder values that are clearly placeholders rather than fake keys).
 * Captured verbatim from the packaged template so the bytes are byte-identical
 * to what landed in users' repositories.
 */
const ENV_EXAMPLE_1_2_0 = `# .noir/.env.example — the committable reference for .noir/.env.
#
# What .noir/.env is for
# ----------------------
# .noir/.env is this project's configuration-and-secrets file. \`noir init\`
# creates it at mode 0600 and gitignores it, and Noir loads it on every
# command. For every key it defines, it WINS over your shell environment, so it
# is the recommended home for project-scoped values and secrets.
#
# Precedence (highest wins):
#   1. run profile env     run.profiles.<n>.env      (per-invocation; merges over)
#   2. .noir/.env          the project-scoped file this example documents
#   3. real environment    CI / container / launchd / shell rc
#   4. built-in default
#
# A real environment variable is only a FALLBACK for keys .noir/.env leaves
# unset. For a value scoped to one invocation, add a \`run.profiles.<name>.env\`
# entry and reference it there as \`\${VAR}\`, so the literal value stays out of
# config.yml; values that must not be committed belong in \`.noir/.env\`
# (gitignored) or the real environment. \`noir env\` reports the winning source
# for each key.
#
# What to commit
# --------------
# Keep .noir/.env OUT of git: it holds real secrets, Noir's managed .gitignore
# block excludes it, and Noir refuses to load a copy that IS tracked (a cloned
# repo could redirect credentials). chmod 600 .noir/.env to keep it private.
# Never commit the real file — commit THIS example, so the keys stay
# discoverable and documented.
#
# Every line below is documentation. Copy a key to .noir/.env and set a real
# value to enable it.
#
# Full reference: docs/reference/environment.md

# --- Host gateway (Claude Code via Z.AI / LiteLLM / OpenRouter / Kimi ...) ---
# Point the host at an Anthropic-shaped endpoint instead of api.anthropic.com.
#
# ANTHROPIC_BASE_URL — the gateway's base URL. Host ONLY: give the origin (for
#   example https://gateway.example) and NOT the /v1/messages path — the host
#   appends that itself.
# ANTHROPIC_AUTH_TOKEN — sent as \`Authorization: Bearer <token>\`. It is the
#   HEADER variant of a credential: AUTH_TOKEN becomes Bearer, while
#   ANTHROPIC_API_KEY becomes x-api-key. Do not set BOTH — that is an auth
#   conflict.
# ANTHROPIC_DEFAULT_HAIKU_MODEL / _SONNET_MODEL / _OPUS_MODEL — remap the
#   haiku / sonnet / opus aliases to the model ids your gateway serves.
# API_TIMEOUT_MS — per-request timeout in milliseconds (Claude Code default is
#   600000).
# CLAUDE_CODE_AUTO_COMPACT_WINDOW — auto-compact window (100000 to 1000000).
#
# ANTHROPIC_BASE_URL=https://gateway.example
# ANTHROPIC_AUTH_TOKEN=replace-with-your-gateway-token
# ANTHROPIC_DEFAULT_HAIKU_MODEL=replace-with-your-gateway-haiku-model
# ANTHROPIC_DEFAULT_SONNET_MODEL=replace-with-your-gateway-sonnet-model
# ANTHROPIC_DEFAULT_OPUS_MODEL=replace-with-your-gateway-opus-model
# API_TIMEOUT_MS=600000
# CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000

# --- Integrations ---
# CLICKUP_API_TOKEN — the token for the noir-clickup integration; set it only
#   when that integration is enabled.
# CLICKUP_TEAM_ID is NOT an env var. Noir never reads it — workspace binding
#   (team / list / space ids) belongs in .noir/config.yml under
#   integrations.clickup.
# CLICKUP_API_TOKEN=replace-with-your-clickup-token

# --- Remote embedders (context.embedder.kind: remote) ---
# The default local embedder (kind: local) needs no key. The three API-key
# variables below apply only when config.yml selects a remote embedder.
# OPENAI_API_KEY=replace-with-your-openai-key
# VOYAGE_API_KEY=replace-with-your-voyage-key
# COHERE_API_KEY=replace-with-your-cohere-key
#
# Ollama (kind: ollama) reads its base URL from config.yml
# (context.embedder.baseURL); this variable is the fallback:
# OLLAMA_BASE_URL=http://localhost:11434

# --- Model provider key (read via apiKeyEnv in .noir/config.yml) ---
# There is no fixed "model key" variable, and setting a key is not enough on
# its own. \`apiKeyEnv\` is a NAME, not an interpolation: config.yml stores the
# variable NAME, and Noir reads process.env[<that name>] at call time. Write
# the bare name — never \`\${...}\` — in .noir/config.yml:
#
#   model:
#     providers:
#       anthropic:
#         apiKeyEnv: ANTHROPIC_API_KEY   # -> reads $ANTHROPIC_API_KEY
#
# Only \`run.profiles.<name>.env\` interpolates \`\${VAR}\`. With no provider
# configured the model layer degrades to templates — Noir never makes a silent
# paid call. \`ANTHROPIC_API_KEY\` is the conventional example, not a variable
# Noir looks up on its own.
# ANTHROPIC_API_KEY=replace-with-your-anthropic-key

# --- Run profile selection (noir run) ---
# Selects a \`run.profiles.<name>\` entry for \`noir run\`.
# Precedence: --profile flag > NOIR_PROFILE > run.defaultProfile > host default.
# NOIR_PROFILE=work

# --- Update kill-switches ---
# NOIR_DISABLE_UPDATE_CHECK=1   # suppress the background startup check only
# NOIR_DISABLE_UPDATES=1        # make \`noir update\` refuse (exit 2)

# See docs/reference/environment.md for every variable Noir reads.
`;

/**
 * `.noir/rules/RULES.md` as shipped by scaffold version 1.1.0.
 *
 * Copy this text verbatim when recording a new version's seed: the whole value
 * of the snapshot is byte equality with what users already have on disk.
 */
const RULES_SEED_1_1_0 = `# Noir working rules

> Canonical AI working-contract for this project. The host context file (CLAUDE.md) @imports this.
> Keep LEAN: every line must be failure-backed, tool-enforceable, decision-encoding, or triggerable — else delete it.
> Edit freely — Noir re-emits only the @import pointer, never this body.

## Identity & scope
- This project uses **Noir** (discipline/context/memory layer) inside **Claude Code**.
- Noir is an orchestration layer — the host CLI is the execution engine; Noir is the spec/context/memory brain.
- Stay in scope: do only what the current Noir task (\`.noir/tasks/\`) requires. Surface scope creep BEFORE acting.

## Anti-assumption contract
- **Never fabricate** facts, APIs, file contents, or command output. Use only what you have read or verified.
- **Never assume** — if a path, signature, or convention is unclear, STOP and ask before acting.
- Cite the file/line or command you relied on for any non-obvious claim.
- Detect non-conventional setups; do not paper over them with assumed conventions.

## Spec-Driven Development workflow
- Follow the Noir SDD lifecycle: intake → clarify → spec → plan → execute → verify → document.
- Gates are observable: every gate decision is recorded (approved / forced / skipped). \`--force\` requires a reason.
- Do not edit/run/execute before facts are gathered AND the human confirms understanding.

## Verification (run before claiming done)
- \`pnpm build && pnpm lint && pnpm typecheck && pnpm test\` — all green, with real output. No hedging.
- Report failures truthfully with the actual output; never claim green without evidence.

## Coding standards & architecture
- Follow existing patterns; match surrounding code's style, naming, comment density.
- Architecture decisions live in \`.noir/decisions/\` (ADR-style) — read them before cross-cutting changes.
- See \`docs/roadmap.md\` for direction and \`docs/specs/\` for design.

## Conventions gotchas (project-specific — fill in)
- Commits stay local until explicitly pushed.
- The full test suite runs offline/free (no network in CI).
`;

/**
 * The recorded seed-template bytes, oldest first.
 *
 * Read-only by intent: this is an append-only ledger of shipped bytes, not
 * mutable configuration. Entries are never edited or removed (see the module
 * header on why rewriting a past entry would silently misclassify a user's
 * file), so a version that changed a seed template appends rather than
 * updates.
 */
export const SEED_TEMPLATE_HISTORY: readonly SeedTemplateHistoryEntry[] = [
  {
    scaffoldVersion: '1.1.0',
    envExample: ENV_EXAMPLE_1_1_0,
    rulesSeed: RULES_SEED_1_1_0,
  },
  {
    scaffoldVersion: '1.2.0',
    envExample: ENV_EXAMPLE_1_2_0,
    rulesSeed: RULES_SEED_1_1_0,
  },
];

/**
 * Does `fileBytes` look like an unedited `seed` left over from an older scaffold
 * version?
 *
 * `true` iff the bytes are an exact match for that seed's text in a recorded
 * history entry AND differ from `currentRender` (what Noir writes for that seed
 * today). Callers pass `currentRender` rather than this module deriving it,
 * because the current template text is the business of the manifest and the
 * template loader — and because the compile-time constant that names the
 * current scaffold version advances independently of the bytes recorded here.
 *
 * `seed` names the file the bytes came from. It is a safety argument, not
 * bookkeeping: because each entry records both seeds, a comparison that scanned
 * every field would report the recorded working-rules bytes as a stale
 * `.env.example`, and the caller's response to `true` is to overwrite the file.
 * Naming the seed keeps the comparison inside its own column, so a mixed-up
 * pairing cannot silently destroy an edit the user is entitled to keep.
 *
 * The `currentRender` guard is checked FIRST: it is what keeps a no-op from
 * being reported as a refresh. A project initialized at the current version
 * already holds the current bytes; those bytes also match their own history
 * entry, so without the second condition every up-to-date project would be told
 * to rewrite its seeds.
 *
 * Callers own the other half of the decision: a file that does not exist has no
 * bytes to compare and is a plain "create the seed", not a refresh.
 */
export function isStaleSeed(seed: SeedKind, fileBytes: string, currentRender: string): boolean {
  if (fileBytes === currentRender) return false;
  return SEED_TEMPLATE_HISTORY.some((entry) => entry[seed] === fileBytes);
}
