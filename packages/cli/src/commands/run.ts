// `noir run <prompt>`: drive the host agentic CLI headless and render its
// stream-json. This is the programmatic host-driving line and the
// headless orchestrator surface: Noir spawns the host as a subprocess,
// streams its output, and reports the token/cost from the `result` event — it
// never runs its own model + tool loop (an agent loop is impossible by
// construction: the model request type has no tools/stream parameter).
//
// Custom command: `--command <binary>` lets users with multiple host
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
import { isDeniedEnvKey, loadNoirEnv, NOIR_DIR, parseConfig } from '@noir-ai/core';
import {
  type NoirEvent,
  type RunHostResult,
  runHost,
  type UsageSnapshot,
} from '../orchestrator.js';
import { type CliOptions, EXIT, fail, failAndExit, json, log, success } from '../output.js';
import { offerPostRunActions } from '../run-actions.js';
import { exitCodeForSignal, interruptedNotice, RunInterrupt } from '../run-interrupt.js';
import { loadRunConfig, resolveRunProfile } from '../run-profiles.js';
import { HOST_STDERR_TAIL_LINES, hostStderrTail, RunStatusLine } from '../run-status.js';

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
 * the message must point at the file.
 *
 * NAMES AND SOURCES ONLY: the message is loggable and shareable, so
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
  /** Custom host binary overriding the per-host default. */
  readonly command?: string;
  /** Named run profile from .noir/config.yml `run.profiles`. */
  readonly profile?: string;
}

/** A single-row token/cost summary (human-readable). */
function formatUsage(u: UsageSnapshot): string {
  const cost = u.totalCostUsd > 0 ? ` $${u.totalCostUsd.toFixed(2)}` : '';
  const turns = u.numTurns > 0 ? ` · ${u.numTurns} turns` : '';
  return `${u.inputTokens.toLocaleString()} in / ${u.outputTokens.toLocaleString()} out${cost}${turns}`;
}

/**
 * The answer text an event carries, or `undefined` when it carries none.
 * API-error assistant text (e.g. "Not logged in · Please run /login") is a
 * diagnostic, not the answer. One predicate for both the live stream and the
 * accumulator, so what the user reads and what a post-run action can save are
 * always the same words.
 */
function answerText(event: NoirEvent): string | undefined {
  if (event.kind === 'assistant' && event.text && event.text.length > 0 && event.isError !== true) {
    return event.text;
  }
  return undefined;
}

/**
 * Stream an assistant text delta to stdout (non-json mode only). The host's
 * answer is data, so it goes to stdout; diagnostics go to stderr. The status
 * line is told first, so it can finish its own row before the answer is written
 * — the answer must never start glued to the tail of the progress text.
 */
function streamEvent(event: NoirEvent, opts: RunOptions, status: RunStatusLine): void {
  if (opts.json === true) return; // json mode buffers; no streaming writes
  const text = answerText(event);
  if (text !== undefined) {
    status.beforeStdout(text);
    process.stdout.write(text);
  }
}

/**
 * Run the host headless and report. Rejects are translated to a clean CLI
 * failure (exit 1) rather than an unhandled rejection.
 */
export async function run(prompt: string, opts: RunOptions): Promise<void> {
  await runOnce(prompt, opts, undefined);
}

/**
 * One host invocation, from validation to summary.
 *
 * `resumeSessionId` continues a session an earlier invocation started: the
 * child is spawned with `--resume <id>` and a prompt collected fresh, and
 * everything else — the stream, the transcript, the summary — is this same
 * code path. It stays a single-shot invocation: the host answers and exits,
 * and Noir holds no session open between turns.
 */
async function runOnce(
  prompt: string,
  opts: RunOptions,
  resumeSessionId: string | undefined,
): Promise<void> {
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
  // whether `.noir/.env` or the ambient environment won. Names
  // only — never a value. Read from `process.env`, which the bin's preAction
  // has already overlaid with `.noir/.env` (the file wins).
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
  // A continuation appends `--resume <id>` after the profile's own args, so a
  // profile's flags stay in effect on the resumed turn too.
  const extraArgs =
    resumeSessionId === undefined
      ? profile.args
      : [...(profile.args ?? []), '--resume', resumeSessionId];
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
  // The answer as plain text, accumulated as it streams. The transcript is raw
  // stream-json, so it cannot feed a post-run action; this can. Accumulating
  // does not touch what is written to stdout — the same text still goes out
  // live, byte for byte.
  const answer: string[] = [];
  // The host's own id for this session, when it reports one — the handle a
  // continuation needs.
  let sessionId: string | undefined;

  // The binary the user is actually driving — a per-invocation `--command` or
  // profile override wins over the host default. Named in the status line and
  // in every failure message, so it is resolved once here.
  const binary = customBinary && customBinary.length > 0 ? customBinary : host;

  // Live progress on stderr for the wait before the host's first token. Silent
  // under --json/--quiet; two plain markers instead of an animated line when
  // stderr is not a terminal.
  const status = new RunStatusLine({
    host: binary,
    json: opts.json,
    quiet: opts.quiet,
    stderrIsTty: process.stderr.isTTY === true,
    stdoutSharesCursor: process.stdout.isTTY === true,
  });
  status.begin();

  // The interrupt contract for this run, installed for exactly as long as a
  // host child is live. A Ctrl+C in the terminal — or a SIGTERM from whatever
  // started Noir — stops the HOST and then reports it, rather than killing Noir
  // and leaving the host running behind it.
  // One verdict per run, whichever path reaches it first. The second-signal path
  // below writes its envelope and leaves, but it leaves only once that write has
  // landed — and the child it forced can resolve this run inside that window, so
  // the run's own interrupted path can arrive at the verdict second. A run that
  // wrote two verdicts would hand a scripted consumer two answers to one run.
  let verdictWritten = false;
  const claimVerdict = (): boolean => {
    if (verdictWritten) return false;
    verdictWritten = true;
    return true;
  };

  const interrupt = new RunInterrupt({
    // A second interrupt leaves at once, and leaves the same verdict behind as
    // the first: the run owes its consumer an envelope under --json, and this is
    // the one path where `fail()` cannot write it (there is no caller left to
    // catch its throw). The child is forced first, so leaving does not leave a
    // host behind.
    exitNow: (code) => {
      interrupt.forceNow();
      if (claimVerdict()) {
        failAndExit(code, interruptedNotice(safeTranscript(host, transcriptLines)), opts);
      }
    },
  });
  interrupt.watch();

  let result: RunHostResult;
  try {
    result = await runHost({
      host,
      prompt,
      customBinary,
      extraArgs,
      env,
      onLine: (line) => transcriptLines.push(line),
      onEvent: (event) => {
        if (event.kind === 'init' && sessionId === undefined) sessionId = event.sessionId;
        status.event(event);
        streamEvent(event, opts, status);
        const text = answerText(event);
        if (text !== undefined) answer.push(text);
      },
      signal: interrupt.signal,
      onChild: (child) => interrupt.track(child),
    });
  } catch (err) {
    // Clear the status line before the failure text so the error is not printed
    // onto the tail of a half-drawn progress row, and finish the row the host's
    // answer may have left open so the error is not read as part of it.
    status.end();
    status.finishRow();
    // A stop that landed while the spawn was still failing is still a stop. The
    // run was asked to end, and why the host never got going is beside the point
    // — reporting it as a failure would blame the host for doing as it was told.
    if (interrupt.interruptedBy !== undefined) {
      if (claimVerdict()) {
        failInterrupted(interrupt.interruptedBy, host, transcriptLines, opts);
      }
      // The verdict is already written by the path that left the process; this
      // one has nothing to add but a second answer.
      return;
    }
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
  } finally {
    // Whatever happened, the process's own signal handling comes back: a later
    // command must not inherit an interrupt contract with nothing to interrupt.
    interrupt.unwatch();
  }

  // An interrupt is not a host failure. The run was stopped on purpose, so the
  // verdict is the stop itself plus the record of what the host had produced —
  // never a "failed" line about a host that was doing as it was told. The child
  // is already reaped (the kill ladder above waits it out), so this is the last
  // thing the run does.
  if (interrupt.interruptedBy !== undefined) {
    // Leave the answer's line, and the status row, closed before the verdict is
    // written: it is read as the run's last word, not as more of the stream.
    status.end();
    status.finishRow();
    if (claimVerdict()) {
      failInterrupted(interrupt.interruptedBy, host, transcriptLines, opts);
    }
    // The leaving path already wrote the verdict this run owes its consumer.
    return;
  }

  const transcript = safeTranscript(host, transcriptLines);
  const failed = result.exitCode !== 0 || result.isError;

  if (failed) {
    // A failed host run is an error, not a success: exit 1, {ok:false} under
    // --json, and no misleading "usage" line. The raw stream-json transcript is
    // still persisted (it is the audit record) and referenced in the message.
    status.end();
    // The answer, if any, stopped mid-line, and a failure printed onto it reads
    // as the tail of the answer rather than as the run's verdict.
    status.finishRow();
    // The host's own stderr is where its progress and its deeper error detail
    // live, and it is otherwise withheld entirely — a bounded tail is what makes
    // the failure diagnosable. It is a human diagnostic: under --json the
    // message stays the one concise sentence a machine consumer reads, and the
    // transcript path is what points at the rest.
    const stderrTail = hostStderrTail(result.stderr);
    const reason =
      result.errorText && result.errorText.trim().length > 0
        ? result.errorText.trim()
        : `exit code ${result.exitCode}`;
    // Auth guidance is keyed off the stream's error CATEGORY (authoritative),
    // falling back to a text heuristic only when the category is absent. A host
    // that could not authenticate tends to say so on its stderr rather than in
    // the stream, so the tail feeds the heuristic too. The login hint names the
    // RESOLVED binary, not a literal 'claude'.
    const isAuth =
      result.errorCategory === 'authentication_failed' ||
      result.errorCategory === 'oauth_org_not_allowed' ||
      /not logged|login|authenticate|invalid api key/i.test(`${reason}\n${stderrTail}`);
    let message = `host '${binary}' failed (exit ${result.exitCode}): ${reason}`;
    if (isAuth) {
      message += ` Open a terminal and run \`${binary} /login\` (interactive-only — it cannot run inside \`noir run\`), then retry.`;
      message += credentialNote(env ?? process.env, envSources);
    }
    message += ` If you use another profile, pass \`--command <binary>\` or define a run profile under run.profiles. transcript: ${transcript}`;
    if (opts.json !== true && stderrTail.length > 0) {
      message += `\n${binary} stderr (last ${HOST_STDERR_TAIL_LINES} lines):\n${stderrTail}`;
    }
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
        // The answer as plain words, so a consumer does not have to reassemble
        // it from the stream-json transcript.
        answerText: answer.join(''),
        ...(sessionId === undefined ? {} : { sessionId }),
      },
    });
    return;
  }

  // The answer, if any, left the cursor mid-line; the summary starts on a line
  // of its own, and the status line (when it still held the row) is erased here.
  status.end();
  process.stdout.write('\n');
  success(`usage: ${formatUsage(result.usage)} (API-equivalent estimate, not billed)`, opts);
  log(`transcript: ${transcript}`, opts);

  // Everything past this point is an offer, not part of the run. The menu
  // returns immediately unless this is a terminal that allows prompts, so a
  // piped or scripted run keeps the output it has always had.
  await offerPostRunActions({
    answer: answer.join(''),
    transcript,
    sessionId,
    host: binary,
    opts,
    // Only the first run of a session can be continued: a resumed run is
    // itself the continuation, so the menu never nests more than one deep.
    ...(resumeSessionId === undefined && sessionId !== undefined
      ? { resume: (nextPrompt: string, id: string) => runOnce(nextPrompt, opts, id) }
      : {}),
  });
}

/**
 * Merge a profile's env overlay over the base env; `undefined` values delete
 * the key. This is the single place a profile env becomes a child environment,
 * so it also refuses a process-injection key — a second net behind profile
 * resolution, in case some future path builds a child env without resolving the
 * profile first. The overlay keys are scanned (never the base, whose
 * `NODE_OPTIONS`/`LD_LIBRARY_PATH` etc. are the user's own ambient environment).
 */
export function mergeEnv(
  base: Record<string, string | undefined>,
  overlay: Record<string, string | undefined>,
): Record<string, string | undefined> {
  for (const key of Object.keys(overlay)) {
    if (isDeniedEnvKey(key)) {
      fail(
        EXIT.ERROR,
        `refusing to run the host: the profile env defines process-injection key "${key}" ` +
          `(it can inject into the spawned host process)`,
      );
    }
  }
  const merged = { ...base, ...overlay };
  return Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined));
}

/**
 * The verdict of a run that was stopped on purpose: the conventional exit code
 * for the signal that stopped it, where the part of the run that happened is,
 * and nothing about failure. One function so every path that ends a run this way
 * says the same thing in the same shape.
 */
function failInterrupted(
  signal: NodeJS.Signals,
  host: string,
  lines: readonly string[],
  opts: RunOptions,
): never {
  return fail(exitCodeForSignal(signal), interruptedNotice(safeTranscript(host, lines)), opts);
}

/**
 * {@link writeTranscript} with its failure folded in rather than raised. The
 * interrupt path writes a transcript while the run is on its way out, so a
 * throw there would replace the verdict (and, in a signal handler, the exit)
 * with a stack trace about a file. `(not persisted)` is already the writer's
 * own answer for "it did not land"; this just makes it the only answer.
 */
function safeTranscript(host: string, lines: readonly string[]): string {
  try {
    return writeTranscript(host, lines);
  } catch {
    return '(not persisted)';
  }
}

/**
 * Persist the raw stream-json lines to `.noir/transcripts/<host>-<ts>.jsonl`.
 * Exported because the TUI's run screen persists a run the same way, and the
 * directory mode / file mode / best-effort rules below are the whole contract
 * for a transcript on disk — a second implementation would be a second answer
 * to "who can read this file".
 */
export function writeTranscript(host: string, lines: readonly string[]): string {
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
