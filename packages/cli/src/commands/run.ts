// v2 — `noir run <prompt>`: drive the host agentic CLI headless and render its
// stream-json. This is the programmatic host-driving line (roadmap v2.0) and the
// v2 orchestrator surface: Noir spawns the host as a subprocess (Archetype B),
// streams its output, and reports the token/cost from the `result` event — it
// never runs its own model + tool loop (D5).
//
// Custom command (D2a): `--command <binary>` lets users with multiple host
// profiles (e.g. two Claude Code installs, `claude` vs `claude-work`) point the
// orchestrator at their own binary without restarting the terminal. The host
// default is used when `--command` is absent.
//
// Contract: `--json` emits one `{ok,data}` envelope to stdout (scriptable);
// otherwise the host's assistant text streams to stdout and the token/cost
// summary + transcript path go to stderr. A transcript of the raw stream-json is
// always persisted to `.noir/transcripts/`.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type HostId, SUPPORTED_HOSTS } from '@noir-ai/adapters';
import { loadNoirEnv, NOIR_DIR, parseConfig } from '@noir-ai/core';
import {
  type NoirEvent,
  type RunHostResult,
  runHost,
  type UsageSnapshot,
} from '../orchestrator.js';
import { type CliOptions, EXIT, fail, json, log, success } from '../output.js';
import { loadRunConfig, resolveRunProfile } from '../run-profiles.js';

/**
 * Anthropic credential / gateway variables that change how a headless (`-p`)
 * host run authenticates. A custom gateway sets `ANTHROPIC_AUTH_TOKEN` +
 * `ANTHROPIC_BASE_URL` and fails exactly like a stale API key, so the auth
 * advice must cover every recognised shape — not just `ANTHROPIC_API_KEY`.
 */
const CREDENTIAL_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
] as const;

/**
 * The auth addendum that names each credential variable in effect AND the
 * source that won for it (`.noir/.env` vs the environment), so the "unset it"
 * advice stays actionable: after consolidation `applyNoirEnv` re-injects a
 * file-scoped key on every invocation, so shell-level unsetting does nothing —
 * the message must point at the file (spec 13.2).
 *
 * NAMES AND SOURCES ONLY (spec G4): the message is loggable and shareable, so
 * no branch here may ever print a variable's value. Returns `''` when no
 * recognised credential variable is set.
 */
function credentialNote(
  env: Record<string, string | undefined>,
  sources: Record<string, 'file' | 'env'>,
): string {
  const named = CREDENTIAL_ENV_VARS.filter((name) => {
    const value = env[name];
    return value !== undefined && value.length > 0;
  }).map(
    (name) => `${name} (from ${sources[name] === 'file' ? `${NOIR_DIR}/.env` : 'the environment'})`,
  );
  if (named.length === 0) return '';
  const one = named.length === 1;
  const subject = one ? `${named[0]} is set` : `${named.join(', ')} are set`;
  const pronoun = one ? 'it' : 'them';
  const verb = one ? 'overrides' : 'override';
  return (
    ` Note: ${subject} — ${pronoun} ${verb} the logged-in account in \`-p\` mode; ` +
    `unset ${pronoun} in the named source (or fix the value) if you meant to use your subscription.`
  );
}

/** Options accepted by `noir run` (globals + host/command/profile knobs). */
export interface RunOptions extends CliOptions {
  /** Host to drive (default `claude`). */
  readonly host?: string;
  /** Custom host binary overriding the per-host default (D2a). */
  readonly command?: string;
  /** Named run profile from .noir/config.yml `run.profiles` (D). */
  readonly profile?: string;
}

/** A single-row token/cost summary (human-readable). */
function formatUsage(u: UsageSnapshot): string {
  const cost = u.totalCostUsd > 0 ? ` $${u.totalCostUsd.toFixed(2)}` : '';
  const turns = u.numTurns > 0 ? ` · ${u.numTurns} turns` : '';
  return `${u.inputTokens.toLocaleString()} in / ${u.outputTokens.toLocaleString()} out${cost}${turns}`;
}

/**
 * Stream an assistant text delta to stdout (non-json mode only). The host's
 * answer is data, so it goes to stdout; diagnostics go to stderr.
 */
function streamEvent(event: NoirEvent, opts: RunOptions): void {
  if (opts.json === true) return; // json mode buffers; no streaming writes
  // API-error assistant text (e.g. "Not logged in · Please run /login") is a
  // diagnostic, not the answer — never stream it to the data channel.
  if (event.kind === 'assistant' && event.text && event.text.length > 0 && event.isError !== true) {
    process.stdout.write(event.text);
  }
}

/**
 * Run the host headless and report. Rejects are translated to a clean CLI
 * failure (exit 1) rather than an unhandled rejection.
 */
export async function run(prompt: string, opts: RunOptions): Promise<void> {
  const host = (opts.host ?? 'claude') as HostId;
  if (!(SUPPORTED_HOSTS as readonly string[]).includes(host)) {
    fail(EXIT.USAGE, `unknown host '${host}' (supported: ${SUPPORTED_HOSTS.join(', ')})`, opts);
  }
  if (prompt.length === 0) {
    const selectors: string[] = [];
    if (opts.command) selectors.push(`--command ${opts.command}`);
    if (opts.profile) selectors.push(`--profile ${opts.profile}`);
    const usage =
      selectors.length > 0 ? `noir run ${selectors.join(' ')} <prompt>` : 'noir run <prompt>';
    fail(EXIT.USAGE, `a prompt is required: \`${usage}\``, opts);
  }

  const root = process.cwd();
  // Credential provenance for the failure advice: `sources` records, per key,
  // whether `.noir/.env` or the ambient environment won (spec 12.4). Names
  // only — never a value. Read from `process.env`, which the bin's preAction
  // has already overlaid with `.noir/.env` (spec 12.1: the file wins).
  const envSources = loadNoirEnv(root).sources;

  // Run-profile resolution: --profile > NOIR_PROFILE > run.defaultProfile >
  // built-in default. Config load is best-effort — `noir run` keeps working
  // outside an initialized project (no profiles, built-in host behavior).
  const config = loadRunConfig(root) ?? parseConfig({});
  const resolved = resolveRunProfile(opts.profile, config, process.env);
  if (!resolved.ok) fail(EXIT.USAGE, resolved.message, opts);
  const profile = resolved.profile;
  // An explicit `--command` (per-invocation override) wins over a profile's
  // binary; the profile's binary is the fallback when --command is absent.
  const customBinary = opts.command ?? profile.binary;
  const extraArgs = profile.args;
  const env = profile.env ? mergeEnv(process.env, profile.env) : undefined;

  // Spec 13.3: running outside an initialized project stays supported, but the
  // gap deserves a word — with no `.noir/.env` there are no project
  // credentials, so an auth failure would read as "noir is broken" instead of
  // "this project has none". One informational stderr line, BEFORE the spawn:
  // never a failure, never a prompt, and silenced by `log()` under
  // --json/--quiet so a machine consumer's output stays pristine.
  if (!existsSync(join(root, NOIR_DIR, '.env'))) {
    log(
      `This project has no ${NOIR_DIR}/.env — that is where Noir reads project credentials and ` +
        `run config from. Run \`noir init\` to scaffold one (\`noir run\` works without it).`,
      opts,
    );
  }

  const transcriptLines: string[] = [];

  let result: RunHostResult;
  try {
    result = await runHost({
      host,
      prompt,
      customBinary,
      extraArgs,
      env,
      onLine: (line) => transcriptLines.push(line),
      onEvent: (event) => streamEvent(event, opts),
    });
  } catch (err) {
    const binary = customBinary && customBinary.length > 0 ? customBinary : host;
    const detail = err instanceof Error ? err.message : String(err);
    const enoent = (err as NodeJS.ErrnoException)?.code === 'ENOENT';
    const guidance = enoent
      ? ` No executable '${binary}' was found. Shell aliases and functions (e.g. from .zshrc) are invisible to noir — use an executable on PATH, an absolute path, or a launcher script such as ~/.local/bin/${binary}.`
      : '';
    const subject =
      customBinary && customBinary.length > 0
        ? `custom command '${customBinary}'`
        : `host '${host}'`;
    fail(EXIT.ERROR, `failed to run ${subject}: ${detail}.${guidance}`, opts);
  }

  const transcript = writeTranscript(host, transcriptLines);
  const failed = result.exitCode !== 0 || result.isError;

  if (failed) {
    // A failed host run is an error, not a success: exit 1, {ok:false} under
    // --json, and no misleading "usage" line. The raw stream-json transcript is
    // still persisted (it is the audit record) and referenced in the message.
    const binary = customBinary && customBinary.length > 0 ? customBinary : host;
    const reason =
      result.errorText && result.errorText.trim().length > 0
        ? result.errorText.trim()
        : result.stderr.trim() || `exit code ${result.exitCode}`;
    // Auth guidance is keyed off the stream's error CATEGORY (authoritative),
    // falling back to a text heuristic only when the category is absent. The
    // login hint names the RESOLVED binary, not a literal 'claude'.
    const isAuth =
      result.errorCategory === 'authentication_failed' ||
      result.errorCategory === 'oauth_org_not_allowed' ||
      /not logged|login|authenticate|invalid api key/i.test(reason);
    let message = `host '${binary}' failed (exit ${result.exitCode}): ${reason}`;
    if (isAuth) {
      message += ` Open a terminal and run \`${binary} /login\` (interactive-only — it cannot run inside \`noir run\`), then retry.`;
      message += credentialNote(env ?? process.env, envSources);
    }
    message += ` If you use another profile, pass \`--command <binary>\` or define a run profile under run.profiles. transcript: ${transcript}`;
    fail(EXIT.ERROR, message, opts);
  }

  if (opts.json === true) {
    json({
      ok: true,
      data: {
        host,
        prompt,
        exitCode: result.exitCode,
        usage: result.usage,
        numTurns: result.usage.numTurns,
        events: result.eventCount,
        transcript,
      },
    });
    return;
  }

  // Separator so the streamed answer and the summary don't run together.
  process.stdout.write('\n');
  success(`usage: ${formatUsage(result.usage)} (API-equivalent estimate, not billed)`, opts);
  log(`transcript: ${transcript}`, opts);
}

/** Merge a profile's env overlay over the base env; `undefined` values delete the key. */
export function mergeEnv(
  base: Record<string, string | undefined>,
  overlay: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const merged = { ...base, ...overlay };
  return Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined));
}

/** Persist the raw stream-json lines to `.noir/transcripts/<host>-<ts>.jsonl`. */
function writeTranscript(host: string, lines: readonly string[]): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(process.cwd(), '.noir', 'transcripts');
  const file = join(dir, `${host}-${ts}.jsonl`);
  try {
    // Transcripts contain raw host prompts/output (may include secrets) — create
    // the dir 0700 and the file 0600 so they are not group/world-readable.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, `${lines.join('\n')}${lines.length > 0 ? '\n' : ''}`, { mode: 0o600 });
  } catch {
    // Transcript persistence is best-effort — a read-only .noir/ must not fail
    // the run.
    return '(not persisted)';
  }
  return file;
}
