// Failure-path coverage for the host orchestrator: API-error assistant events
// must be flagged (so run.ts never streams them as answers), and runHost must
// surface isError + errorText from the stream so the CLI can fail honestly.
// Uses small offline fixture hosts — no real claude, no network.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { type HostChild, normalizeStreamEvent, runHost } from '../src/orchestrator.js';
import { INTERRUPT_GRACE_MS, RunInterrupt } from '../src/run-interrupt.js';

const fix = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

const hasZsh = ((): boolean => {
  try {
    return spawnSync('zsh', ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
})();

describe('normalizeStreamEvent — API-error assistant events', () => {
  it('flags an assistant event that is an API error message (is_api_error_message + error category)', () => {
    const e = normalizeStreamEvent({
      type: 'assistant',
      message: { id: 'm1', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] },
      error: 'authentication_failed',
      is_api_error_message: true,
    });
    expect(e?.kind).toBe('assistant');
    if (e?.kind === 'assistant') expect(e.isError).toBe(true);
  });

  it('flags an assistant event carrying an error category even without the boolean flag', () => {
    const e = normalizeStreamEvent({
      type: 'assistant',
      message: { id: 'm1', content: [{ type: 'text', text: 'rate limited' }] },
      error: 'rate_limit',
    });
    expect(e?.kind).toBe('assistant');
    if (e?.kind === 'assistant') expect(e.isError).toBe(true);
  });

  it('leaves clean assistant events unflagged', () => {
    const e = normalizeStreamEvent({
      type: 'assistant',
      message: { id: 'm1', content: [{ type: 'text', text: 'hello' }] },
    });
    expect(e?.kind).toBe('assistant');
    if (e?.kind === 'assistant') expect(e.isError).toBeUndefined();
  });
});

describe('runHost — failure surfacing (fixture hosts)', () => {
  it('surfaces isError + errorText for an auth-error host that exits 1', async () => {
    const r = await runHost({
      host: 'claude',
      prompt: 'x',
      customBinary: fix('host-auth-error.sh'),
    });
    expect(r.exitCode).toBe(1);
    expect(r.isError).toBe(true);
    expect(r.errorText).toContain('Not logged in · Please run /login');
  });

  it('reports isError=true even when the host exits 0 (is_error is the signal, not the exit code)', async () => {
    const r = await runHost({
      host: 'claude',
      prompt: 'x',
      customBinary: fix('host-exit0-error.sh'),
    });
    expect(r.exitCode).toBe(0);
    expect(r.isError).toBe(true);
  });

  it('reports isError=false and no errorText for a clean run', async () => {
    const r = await runHost({ host: 'claude', prompt: 'x', customBinary: fix('host-ok.sh') });
    expect(r.exitCode).toBe(0);
    expect(r.isError).toBe(false);
    expect(r.errorText).toBeUndefined();
  });

  it('reports a signal-killed host (no result event, code null) as a failure, not exit 0', async () => {
    const r = await runHost({ host: 'claude', prompt: 'x', customBinary: fix('host-killed.sh') });
    expect(r.isError).toBe(true);
    expect(r.exitCode).not.toBe(0);
    expect(r.errorText).toContain('terminated by signal');
  });
});

describe('runHost — shell-bridge ENOENT fallback (zsh alias)', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  // A custom binary that is a zsh alias (invisible to spawn()) must be resolved
  // through the user's interactive shell and produce the host stream-json.
  it.skipIf(!hasZsh)('bridges a zsh alias to the real host fixture', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noir-bridge-host-'));
    writeFileSync(join(dir, '.zshrc'), `alias myhost="${fix('host-ok.sh')}"\n`, { mode: 0o644 });
    const r = await runHost({
      host: 'claude',
      prompt: 'x',
      customBinary: 'myhost',
      env: { ...process.env, SHELL: '/bin/zsh', ZDOTDIR: dir, HOME: dir },
    });
    expect(r.exitCode).toBe(0);
    expect(r.isError).toBe(false);
    expect(r.eventCount).toBeGreaterThan(0); // stream-json was parsed
  });

  it.skipIf(!hasZsh)('an unresolvable name still surfaces the original ENOENT', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noir-bridge-miss-'));
    writeFileSync(join(dir, '.zshrc'), '', { mode: 0o644 });
    await expect(
      runHost({
        host: 'claude',
        prompt: 'x',
        customBinary: 'no-such-command-abc',
        env: { ...process.env, SHELL: '/bin/zsh', ZDOTDIR: dir, HOME: dir },
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('runHost — cancellation', () => {
  it('kills the host on abort and resolves through the ordinary close path', async () => {
    const controller = new AbortController();
    // Abort as soon as the host has announced itself: the run is provably
    // running, and the child would otherwise sleep far past the test.
    const r = await runHost({
      host: 'claude',
      prompt: 'x',
      customBinary: fix('host-slow.sh'),
      onLine: () => controller.abort(),
      signal: controller.signal,
    });
    // Cancelled is not "clean": the result says the host did not finish, so no
    // caller can mistake a cancelled run for a completed one.
    expect(r.isError).toBe(true);
    expect(r.exitCode).not.toBe(0);
    expect(r.errorText).toContain('terminated by signal');
  });

  it('kills an already-aborted run instead of leaking the child', async () => {
    // The race a caller can always lose: the user escapes before the spawn has
    // even happened. The child must not survive the decision.
    const controller = new AbortController();
    controller.abort();
    const r = await runHost({
      host: 'claude',
      prompt: 'x',
      customBinary: fix('host-slow.sh'),
      signal: controller.signal,
    });
    expect(r.isError).toBe(true);
    expect(r.exitCode).not.toBe(0);
  });

  it('leaves a run with no signal alone', async () => {
    const r = await runHost({ host: 'claude', prompt: 'x', customBinary: fix('host-ok.sh') });
    expect(r.exitCode).toBe(0);
    expect(r.isError).toBe(false);
  });

  it.skipIf(!hasZsh)('cancels a host that was reached through the shell bridge', async () => {
    // The name that was spawned never existed; the child actually driving the
    // run is the shell running the alias. Cancelling has to reach THAT one, or
    // a user who cancels a bridged run watches it keep working.
    const bridgeDir = mkdtempSync(join(tmpdir(), 'noir-bridge-cancel-'));
    writeFileSync(join(bridgeDir, '.zshrc'), `alias slowbridge="exec '${fix('host-slow.sh')}'"\n`, {
      mode: 0o644,
    });
    const controller = new AbortController();
    const spawns: HostChild[] = [];
    let atBridge!: () => void;
    const bridgeUp = new Promise<void>((resolve) => {
      atBridge = resolve;
    });
    const done = runHost({
      host: 'claude',
      prompt: 'x',
      customBinary: 'slowbridge',
      env: { ...process.env, SHELL: '/bin/zsh', ZDOTDIR: bridgeDir, HOME: bridgeDir },
      signal: controller.signal,
      onChild: (child) => {
        spawns.push(child);
        if (spawns.length === 2) atBridge();
      },
    });

    await bridgeUp;
    expect(spawns.length).toBe(2); // the name, then the bridge
    controller.abort();
    const r = await done;
    rmSync(bridgeDir, { recursive: true, force: true });

    expect(r.isError).toBe(true);
    expect(r.exitCode).toBe(143); // 128 + SIGTERM
  });

  it.skipIf(!hasZsh)(
    'cancels a bridged host when the stop lands before the bridge exists',
    async () => {
      // The window a run cannot close by listening: the stop arrives while the
      // command is still being resolved, so there is no child to signal yet. The
      // bridge that appears afterwards has to be stopped on the way in — and it
      // is the user's INTERACTIVE shell until it execs the host, so the stop has
      // to survive that shell's startup too. What matters is the outcome: the run
      // ends, on the polite signal, well inside the grace a stoppable host gets.
      const bridgeDir = mkdtempSync(join(tmpdir(), 'noir-bridge-early-'));
      writeFileSync(
        join(bridgeDir, '.zshrc'),
        `alias slowbridge="exec '${fix('host-slow.sh')}'"\n`,
        { mode: 0o644 },
      );
      const controller = new AbortController();
      controller.abort();
      const stoppedAt = Date.now();
      const r = await runHost({
        host: 'claude',
        prompt: 'x',
        customBinary: 'slowbridge',
        env: { ...process.env, SHELL: '/bin/zsh', ZDOTDIR: bridgeDir, HOME: bridgeDir },
        signal: controller.signal,
      });
      const elapsed = Date.now() - stoppedAt;
      rmSync(bridgeDir, { recursive: true, force: true });

      expect(r.isError).toBe(true);
      // The polite signal is what ended it — not the forceful one after a grace.
      expect(r.errorText).toContain('terminated by signal SIGTERM');
      expect(elapsed).toBeLessThan(INTERRUPT_GRACE_MS);
    },
  );

  it.skipIf(!hasZsh)(
    'offers the polite signal again when a bridged host refuses the first one',
    async () => {
      // A host that sits out the polite signal must not be able to outlast the
      // stop: the signal is offered again until it lands. This host refuses the
      // first one it receives and exits 7 on the second, so the run ending at all
      // — well inside the grace, and ending on the polite signal rather than the
      // escalation — is the proof that the signal was offered a second time.
      const bridgeDir = mkdtempSync(join(tmpdir(), 'noir-bridge-resend-'));
      writeFileSync(
        join(bridgeDir, '.zshrc'),
        `alias slowbridge="exec '${fix('host-refuses-first-term.sh')}'"\n`,
        { mode: 0o644 },
      );
      const controller = new AbortController();
      const stoppedAt = Date.now();
      // Stop on the host's first line: the fixture arms its refusal before it
      // says anything, so this is the earliest moment the stop is provably
      // addressed to a host that counts signals rather than to a shell starting
      // up (which is a case the test above already covers).
      const r = await runHost({
        host: 'claude',
        prompt: 'x',
        customBinary: 'slowbridge',
        env: { ...process.env, SHELL: '/bin/zsh', ZDOTDIR: bridgeDir, HOME: bridgeDir },
        signal: controller.signal,
        onLine: () => controller.abort(),
      });
      const elapsed = Date.now() - stoppedAt;
      rmSync(bridgeDir, { recursive: true, force: true });

      expect(r.exitCode).toBe(7); // the host counted two polite signals
      expect(elapsed).toBeLessThan(INTERRUPT_GRACE_MS);
    },
  );

  it('forces a host that ignores the polite signal, and leaves nothing running', async () => {
    // The whole point of the ladder: a host that will not listen to SIGTERM
    // must not hold the terminal — and must not outlive Noir either.
    const interrupt = new RunInterrupt({ graceMs: 200 });
    let child: HostChild | undefined;
    let atRunning!: () => void;
    // The fixture installs its refusal before it says anything, so the first
    // line is what proves the host is actually up and ignoring signals — a
    // signal sent before that would land on a process that never refused.
    const running = new Promise<void>((resolve) => {
      atRunning = resolve;
    });
    const done = runHost({
      host: 'claude',
      prompt: 'x',
      customBinary: fix('host-ignores-term.sh'),
      onLine: () => atRunning(),
      onChild: (spawnedChild) => {
        child = spawnedChild;
        interrupt.track(spawnedChild);
      },
    });

    await running;
    const pid = child?.pid;
    expect(pid).toBeDefined();
    interrupt.terminate();
    const r = await done;

    // 128 + SIGKILL: the run ended because the forceful signal landed, and the
    // run does not resolve until it has — so the child is reaped, not orphaned.
    expect(r.exitCode).toBe(137);
    expect(interrupt.escalated).toBe(true);
    expect(() => process.kill(pid as number, 0)).toThrow();
  });
});
