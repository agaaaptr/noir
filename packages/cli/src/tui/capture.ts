// Stream capture for the dashboard's command dispatch.
//
// While the dashboard runs, Ink owns the terminal (raw-mode stdin + ANSI render
// writes to stdout). When the user submits a `/<command>`, the EXISTING command
// dispatch seam is reused verbatim — the dispatched command writes to
// `process.stdout` / `process.stderr` via the same centralized output helpers
// (`log`, `json`, `table`, `definitionList`, …) every other invocation uses.
// To keep that contract AND render the result inside the dashboard's output
// pane (instead of corrupting Ink's render), the dispatched command's writes
// are captured for the duration of the dispatch and restored after.
//
// Invariant: Ink does not rerender mid-dispatch, because the App does not
// `setState` between the stream swap and its restore (the only state change is
// the single `setOutput` AFTER the await resolves). So the captured text is
// exactly the dispatched command's bytes — no Ink frames leak in.

/** Capture everything written to stdout/stderr during `fn`, plus the exit code. */
export interface CapturedOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run `fn` with `process.stdout.write` / `process.stderr.write` temporarily
 * replaced by string collectors. Restores the original writers in a `finally`
 * (so an unexpected throw still restores them). `process.exitCode` set by the
 * dispatched command is captured and then RESET to its pre-call value, so a
 * failing sub-command does not poison the dashboard's own process exit.
 */
export async function captureProcessOutput(fn: () => Promise<void>): Promise<CapturedOutput> {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const prevExitCode = process.exitCode;

  // Type narrower: Node's Write result is `boolean`. The captured writers
  // always succeed (they just buffer), so return `true`.
  process.stdout.write = ((chunk: unknown) => {
    outChunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    errChunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    await fn();
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }

  const exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0;
  // Reset so the dashboard's own process exit is not affected by a sub-command.
  process.exitCode = prevExitCode;
  return { stdout: outChunks.join(''), stderr: errChunks.join(''), exitCode };
}
