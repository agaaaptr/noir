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

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type HostId, SUPPORTED_HOSTS } from '@noir-ai/adapters';
import { type NoirEvent, runHost, type UsageSnapshot } from '../orchestrator.js';
import { type CliOptions, EXIT, fail, json, log, success } from '../output.js';

/** Options accepted by `noir run` (globals + host/command knobs). */
export interface RunOptions extends CliOptions {
  /** Host to drive (default `claude`). */
  readonly host?: string;
  /** Custom host binary overriding the per-host default (D2a). */
  readonly command?: string;
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
  if (event.kind === 'assistant' && event.text && event.text.length > 0) {
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
    fail(EXIT.USAGE, 'a prompt is required: `noir run <prompt>`', opts);
  }

  const transcriptLines: string[] = [];

  try {
    const result = await runHost({
      host,
      prompt,
      customBinary: opts.command,
      onLine: (line) => transcriptLines.push(line),
      onEvent: (event) => streamEvent(event, opts),
    });

    if (opts.json !== true) {
      // Separator so the streamed answer and the summary don't run together.
      process.stdout.write('\n');
    }

    const transcript = writeTranscript(host, transcriptLines);

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

    if (result.exitCode !== 0) {
      log(`host exited ${result.exitCode}`, opts);
      if (result.stderr.length > 0) log(result.stderr.trim(), opts);
    }
    success(`usage: ${formatUsage(result.usage)} (API-equivalent estimate, not billed)`, opts);
    log(`transcript: ${transcript}`, opts);
  } catch (err) {
    fail(
      EXIT.ERROR,
      `failed to run host '${host}': ${err instanceof Error ? err.message : String(err)}`,
      opts,
    );
  }
}

/** Persist the raw stream-json lines to `.noir/transcripts/<host>-<ts>.jsonl`. */
function writeTranscript(host: string, lines: readonly string[]): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(process.cwd(), '.noir', 'transcripts');
  const file = join(dir, `${host}-${ts}.jsonl`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${lines.join('\n')}${lines.length > 0 ? '\n' : ''}`);
  } catch {
    // Transcript persistence is best-effort — a read-only .noir/ must not fail
    // the run.
    return '(not persisted)';
  }
  return file;
}
