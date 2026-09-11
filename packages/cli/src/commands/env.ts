// `noir env [--json]` — which configuration is in effect, and where each value
// comes from.
//
// The command exists to answer the one question the maintainer hit live: "I
// edited `.noir/.env` and nothing changed — so which value is actually in
// effect, and who supplied it?". The resolution rule itself (spec 12.1) is that
// a key `.noir/.env` DEFINES wins and the real environment is the fallback for
// the keys the file omits; this command renders that decision per key instead of
// leaving the user to infer it.
//
// HARD RULE (spec 12.4): NAMES AND SHAPES ONLY, NEVER A VALUE. Each row carries
// the key, the side that won, and a REDACTED shape (`pk_…(42)` = the first three
// characters + the length) so two tokens can be told apart without a secret ever
// being printed. `--json` carries even less — `valueLength` only; the shape
// belongs to the human table and never reaches stdout (see `env`, whose payload
// is an EXPLICIT projection of the resolved rows).
//
// CURATION, NOT A DUMP (spec 12.3). `loadNoirEnv().sources` records every key
// that resolves to something, including every ambient one as `'env'` — under the
// default argument that is the whole of `process.env` (PATH, npm_config_*, …).
// Rendering that inventory would bury the answer this command exists to give, so
// the report is exactly:
//
//   (a) every key `.noir/.env` defines — the user's own short list, and the
//       thing they just edited; plus
//   (b) ambient keys named by {@link CURATED_AMBIENT_KEYS} — the Noir-relevant
//       names a user may have exported from a shell rc; plus
//   (c) ambient keys named by the project's OWN config
//       (`model.providers.<name>.apiKeyEnv`), read through the shipped
//       `resolveModelConfig` mapper so the CLI never re-derives the schema.
//
// READ-ONLY: nothing here writes, spawns, or opens the store.

import { loadNoirEnv, loadProjectInfo } from '@noir-ai/core';
import { resolveModelConfig } from '@noir-ai/model';
import { type CliOptions, info, json, table } from '../output.js';

/**
 * Ambient (environment-only) names worth reporting: the Noir-relevant keys a
 * user might reasonably have exported from a shell rc. Deliberately a SHORT
 * allowlist — see the curation note above. `CLICKUP_API_TOKEN` is the
 * integration token, the four `*_API_KEY` names are the remote embedder /
 * provider keys the docs name, `OLLAMA_BASE_URL` backs a local Ollama embedder,
 * and `NOIR_PROFILE` selects a `run.profiles` entry.
 *
 * An ambient key NOT in this list is still resolved (and still feeds the
 * precedence decision) — it is simply not reported, because "every variable in
 * your shell" is not an answer to "which value is in effect".
 */
export const CURATED_AMBIENT_KEYS: readonly string[] = [
  'CLICKUP_API_TOKEN',
  'OPENAI_API_KEY',
  'VOYAGE_API_KEY',
  'COHERE_API_KEY',
  'OLLAMA_BASE_URL',
  'ANTHROPIC_API_KEY',
  'NOIR_PROFILE',
];

/**
 * The ambient environment as it was BEFORE `.noir/.env` was applied, captured by
 * the bin's `preAction` (see {@link captureAmbientEnv}).
 *
 * The loader APPLIES its overlay to `process.env` in place, and after that the
 * file's own values are indistinguishable from an inherited export for exactly
 * the keys where the question matters — so "is my shell value being overridden?"
 * (the `shadowed` column) can only be answered from a pre-overlay snapshot.
 *
 * A SHALLOW COPY of the environment, values included: the shadow comparison
 * needs the ambient VALUE to tell an override apart from an agreeing export.
 * The copy is in-memory and process-local for the lifetime of one invocation —
 * it is never persisted, never written back to `process.env`, and a value from
 * it reaches the user only as a redacted shape or a length (see
 * {@link redactShape} / {@link EnvVarRow.valueLength}).
 */
let ambientBaseline: Record<string, string | undefined> | undefined;

/**
 * Snapshot the ambient environment before the bin applies `.noir/.env`. Called
 * from `bin.ts`'s `preAction` for `noir env` only — every other command just
 * applies the overlay and never needs the baseline.
 */
export function captureAmbientEnv(env: Record<string, string | undefined> = process.env): void {
  ambientBaseline = { ...env };
}

/** One resolved key: the name, the side that won, and a length — never a value. */
export interface EnvVarRow {
  /** The env-var NAME (safe to print; this is what the user types). */
  key: string;
  /** The side that won: `.noir/.env` (`'file'`) or the ambient environment. */
  source: 'file' | 'env';
  /** Present (true) only when `.noir/.env` defines the key AND the ambient
   *  environment defined it with a DIFFERENT value — i.e. the file is
   *  overriding something. Omitted otherwise (the JSON shape is additive). */
  shadowed?: boolean;
  /** Character count of the value in effect. A length is not a value. */
  valueLength: number;
}

/** The `data` of `noir env --json`. No value, and no fragment of one. */
export interface EnvPayload {
  vars: EnvVarRow[];
  /** Loader diagnostics (malformed lines, shadowed keys, a tracked-file
   *  refusal). Names only — the loader never puts a value in a warning. */
  warnings: string[];
}

/** Resolved rows + the REDACTED display shapes for the human table. */
interface ResolvedEnv {
  vars: EnvVarRow[];
  warnings: string[];
  /** key → redacted shape (first three characters + length). Human-only: it is
   *  never serialized (see the explicit projection in `env`). */
  shapes: Record<string, string>;
}

/**
 * A redacted DISPLAY shape for a value: the first three characters plus the
 * length (`pk_la…(42)`). Enough to tell two tokens apart in a table — the shape
 * a provider dashboard shows for a masked key — and never enough to use one.
 * The length is deliberate: it is what makes "the file's value is in effect, not
 * the one I exported" visible without printing either.
 *
 * SHORT VALUES ARE SHOWN AS LENGTH ONLY. For a value of `SHORT_VALUE_MAX` chars
 * or fewer the prefix would BE the whole value (`dev…(3)` for `NOIR_PROFILE=dev`
 * prints a complete value — and a short one is exactly the kind a user might
 * have picked, or a legacy token might be). The floor is 8 rather than the 3
 * the prefix needs, so a short-but-real value like a hostname or a base URL
 * cannot be reconstructed by guessing the last few characters.
 */
const SHORT_VALUE_MAX = 8;

function redactShape(value: string): string {
  if (value.length <= SHORT_VALUE_MAX) return `…(${value.length})`;
  return `${value.slice(0, 3)}…(${value.length})`;
}

/**
 * The env-var NAMES the project's own model config requests
 * (`model.providers.<name>.apiKeyEnv`), read through the shipped
 * `resolveModelConfig` mapper rather than by reaching into the config shape —
 * so the CLI never re-derives the schema, and a config that names a key the
 * built-in allowlist would never guess still shows up.
 *
 * An uninitialized (or unparseable) project yields `[]`: `noir env` reports what
 * it can from the file + the environment instead of refusing to run — the file
 * is exactly what the user came here to inspect.
 */
function configApiKeyEnvNames(root: string): string[] {
  try {
    const project = loadProjectInfo(root);
    const names = new Set<string>();
    for (const provider of Object.values(resolveModelConfig(project.config.model).providers)) {
      if (provider.apiKeyEnv !== undefined && provider.apiKeyEnv.length > 0) {
        names.add(provider.apiKeyEnv);
      }
    }
    return [...names];
  } catch {
    return [];
  }
}

/**
 * Resolve the reported keys: provenance from `loadNoirEnv` (spec 12.1's single
 * decision point — this command never re-implements the precedence), filtered
 * down to the curated report described at the top of this file.
 *
 * The resolved VALUE is used only for its length and its redacted shape, inside
 * the loop body below — it is never stored on a row, so it cannot leak into the
 * `--json` envelope.
 */
function resolveEnv(root: string, ambientEnv: Record<string, string | undefined>): ResolvedEnv {
  const { overlay, warnings, sources } = loadNoirEnv(root, ambientEnv);
  const curated = new Set<string>(CURATED_AMBIENT_KEYS);
  for (const name of configApiKeyEnvNames(root)) curated.add(name);

  // Candidate keys: everything `sources` records (the loader's authority), plus
  // the curated names that are SET in the ambient environment. The second half
  // exists because `sources` is empty whenever the loader takes one of its two
  // no-op paths — no `.noir/.env` at all, or a git-tracked file refused outright
  // (spec 12.2) — and neither means "nothing is in effect": with no file
  // contributing, an exported `CLICKUP_API_TOKEN` IS the value in effect, and
  // reporting "nothing to report" while it sits in the user's shell would be a
  // lie. It cannot contradict the loader: those are exactly the keys the loader
  // would have recorded as `'env'` had it run its ambient pass.
  const candidates = new Set<string>(Object.keys(sources));
  for (const key of curated) {
    if (ambientEnv[key] !== undefined) candidates.add(key);
  }

  const vars: EnvVarRow[] = [];
  const shapes: Record<string, string> = {};
  // Sorted for a stable table (and a stable `--json` array) across runs.
  for (const key of [...candidates].sort()) {
    const source = sources[key] ?? 'env';
    // (b)/(c): an ambient key is reported ONLY when it is curated. `sources`
    // holds every ambient name, so this filter is what keeps the command from
    // enumerating the environment.
    if (source === 'env' && !curated.has(key)) continue;
    // The value in effect: the file's overlay when the file defined the key
    // (spec 12.1 — the file WINS), else the fallback the file fell through to.
    const value = source === 'file' ? (overlay[key] ?? '') : (ambientEnv[key] ?? '');
    // Shadowing is the same condition the loader warns on: the file defines a
    // key the ambient environment ALSO defines, with a different value. Equal
    // values are not a shadow — nothing the user exported is being overridden.
    const shadowed =
      source === 'file' && ambientEnv[key] !== undefined && ambientEnv[key] !== value;

    vars.push({
      key,
      source,
      ...(shadowed ? { shadowed: true } : {}),
      valueLength: value.length,
    });
    shapes[key] = redactShape(value);
  }
  return { vars, warnings, shapes };
}

/** Human label for the SOURCE column. */
function describeSource(row: EnvVarRow): string {
  if (row.source !== 'file') return 'environment';
  return row.shadowed === true ? '.noir/.env (shadows environment)' : '.noir/.env';
}

/**
 * `noir env [--json]`: report every key that is in effect, its winning source,
 * and a redacted shape of its value.
 *
 * `--json` writes `{ok:true, data:{vars, warnings}}` to STDOUT — the explicit
 * projection below is the redaction boundary (`shapes` is deliberately dropped).
 * The human path renders a KEY/SOURCE/VALUE table to STDERR and writes nothing
 * to stdout.
 *
 * Loader warnings are NOT re-printed here: `bin.ts`'s `preAction` already
 * applies `.noir/.env` through `applyNoirEnv`, which writes every warning
 * (including the tracked-file refusal) to stderr before this action runs — so
 * they are visible in every real invocation, and printing them again would only
 * duplicate them. They are carried in the `--json` payload for consumers.
 *
 * Always exits 0: this is a report, and "your file is not being loaded" is
 * information, not a failure.
 */
export async function env(opts: CliOptions = {}): Promise<void> {
  const report = resolveEnv(process.cwd(), ambientBaseline ?? process.env);

  if (opts.json === true) {
    json({ ok: true, data: { vars: report.vars, warnings: report.warnings } });
    return;
  }

  if (report.vars.length === 0) {
    // "no keys IN EFFECT", not "no keys": a file can define keys that resolve to
    // nothing — a git-tracked file is refused outright (spec 12.2), and a
    // process-injection key (NODE_OPTIONS, npm_*) is skipped by the loader. Both
    // are reported by the loader's own stderr warnings above this line.
    info(
      'nothing to report — .noir/.env defines no keys in effect and no Noir-relevant environment variable is set',
      opts,
    );
    return;
  }

  table(
    report.vars.map((row) => ({
      KEY: row.key,
      SOURCE: describeSource(row),
      VALUE: report.shapes[row.key] ?? '',
    })),
    ['KEY', 'SOURCE', 'VALUE'],
    opts,
  );
}
