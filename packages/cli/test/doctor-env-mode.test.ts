// `noir doctor` — the `.noir/.env` permission row.
//
// The row exists so a credential file another account can read is visible, and so
// the reader can tell WHY it is lax. A file that carries the mode it was created
// with — an older Noir seeded it before owner-only became the contract, a clone
// delivered it, or it was made by hand — is not a change the reader made, while a
// mode altered after the file was written is something that happened on this
// machine afterwards. Both branches are warnings with the same remedy; only the
// cause sentence differs, because "you did this" and "this arrived with your repo"
// send a reader to different next steps.
//
// The row must also print the mode it actually observed, in octal, and evaluate
// every group/other bit — the same predicate the owner-only heal uses, so the row
// warns exactly about the files the next `init`/`sync` will tighten.
//
// Finally it must go quiet once the file is owner-only: the loader re-checks the
// mode on EVERY command, so a row that kept warning after a heal would repeat
// forever. The heal is performed by the scaffold (`init`, `sync`, `init
// --upgrade`, `init --force`); this suite runs the real scaffold path and then
// asserts the row and the loader are both silent.
//
// Offline/free: no network, no API key, no embedder.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadNoirEnv } from '@noir-ai/core';
import { scaffold } from '@noir-ai/create';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { doctor } from '../src/commands/doctor.js';

let root: string;
let daemonDir: string;
let origCwd: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-doctor-env-mode-'));
  daemonDir = mkdtempSync(join(tmpdir(), 'noir-doctor-env-mode-daemon-'));
  // Keep the operator's real `~/.noir` untouched (the daemon row would otherwise
  // read their records) and pin the MCP command so any emitted host artifact
  // carries no machine-specific path.
  process.env.NOIR_DAEMON_DIR = daemonDir;
  process.env.NOIR_MCP_COMMAND = 'noir';
  origCwd = process.cwd();
  process.chdir(root);
});

afterEach(() => {
  process.chdir(origCwd);
  delete process.env.NOIR_DAEMON_DIR;
  delete process.env.NOIR_MCP_COMMAND;
  rmSync(root, { recursive: true, force: true });
  rmSync(daemonDir, { recursive: true, force: true });
});

const envPath = (): string => join(root, '.noir', '.env');
const modeOf = (): number => statSync(envPath()).mode & 0o777;

/**
 * Seed `.noir/.env` in the state a file that "came this way" is in: the mode has
 * not been touched since the contents were last written. Built by setting the
 * mode first and writing the contents second, because an in-place write keeps the
 * mode and stamps `mtime` and `ctime` together — the same pair of facts an
 * older Noir's seed, a clone, or a `touch` leaves behind. The mode must leave the
 * owner write bit set, since that second write has to succeed.
 */
function seedModeUntouchedSinceWrite(mode: number): void {
  mkdirSync(join(root, '.noir'), { recursive: true });
  writeFileSync(envPath(), '# seeded\n', 'utf8');
  chmodSync(envPath(), mode);
  writeFileSync(envPath(), '# seeded\n', 'utf8');
}

/**
 * Seed `.noir/.env` with its mode changed AFTER the contents were written — the
 * state a `chmod`, a `chown`, or a metadata-restoring copy leaves behind. The
 * pause keeps the two timestamps distinguishable even where they are stored with
 * millisecond resolution.
 */
async function seedModeChangedAfterWrite(mode: number): Promise<void> {
  mkdirSync(join(root, '.noir'), { recursive: true });
  writeFileSync(envPath(), '# seeded\n', 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 5));
  chmodSync(envPath(), mode);
}

/** Run `noir doctor --json` and return its `noir-env` permission row. */
async function envRow(): Promise<{ status: string; detail: string }> {
  const out: string[] = [];
  const errChunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: unknown) => {
    out.push(typeof c === 'string' ? c : String(c));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown) => {
    errChunks.push(typeof c === 'string' ? c : String(c));
    return true;
  }) as typeof process.stderr.write;
  try {
    await doctor({ json: true });
  } catch {
    // A CRITICAL check (native deps on a host without sqlite-vec) signals through
    // the exit code by throwing, and it does so AFTER the JSON payload is on
    // stdout — the row under test was already written.
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  const envelope = JSON.parse(out.join('')) as {
    data: { checks: Array<{ name: string; status: string; detail: string }> };
  };
  const row = envelope.data.checks.find((c) => c.name === 'noir-env');
  if (!row) throw new Error(`doctor reported no noir-env row (stderr: ${errChunks.join('')})`);
  return row;
}

describe('noir doctor — .noir/.env permission row', () => {
  it('passes an owner-only file and names the mode it observed', async () => {
    seedModeUntouchedSinceWrite(0o600);

    const row = await envRow();

    expect(row.status).toBe('ok');
    expect(row.detail).toContain('0600');
  });

  it('passes a file the owner alone can read — the contract is owner-only, not writable', async () => {
    // `chmod 400` is a mode the owner typed, so it lands on the changed-mode side
    // of the split; all this test asks of the row is that it stays quiet and
    // reports the mode it saw.
    await seedModeChangedAfterWrite(0o400);

    const row = await envRow();

    expect(row.status).toBe('ok');
    expect(row.detail).toContain('0400');
  });

  it.each([
    { label: '0640', mode: 0o640 },
    { label: '0660', mode: 0o660 },
    { label: '0604', mode: 0o604 },
  ])('warns for $label and prints the observed mode in octal', async ({ label, mode }) => {
    seedModeUntouchedSinceWrite(mode);

    const row = await envRow();

    expect(row.status).toBe('warn');
    expect(row.detail).toContain(label);
    expect(row.detail).toContain('chmod 600');
  });

  it('says a mode untouched since the file was written predates the owner-only contract', async () => {
    seedModeUntouchedSinceWrite(0o640);
    // The fixture really is the state under test: no `chmod` came after the write.
    expect(statSync(envPath()).ctimeMs).toBe(statSync(envPath()).mtimeMs);

    const row = await envRow();

    expect(row.status).toBe('warn');
    expect(row.detail).toContain('0640');
    expect(row.detail).toMatch(/predates the owner-only contract/);
    expect(row.detail).toMatch(/not a change you made/);
  });

  it('says a mode changed after the file was written was changed on this machine', async () => {
    await seedModeChangedAfterWrite(0o640);
    expect(statSync(envPath()).ctimeMs).toBeGreaterThan(statSync(envPath()).mtimeMs);

    const row = await envRow();

    expect(row.status).toBe('warn');
    expect(row.detail).toContain('0640');
    expect(row.detail).toMatch(/changed after the file was written/);
    expect(row.detail).not.toMatch(/predates the owner-only contract/);
  });

  it('warns without ever printing the file contents', async () => {
    mkdirSync(join(root, '.noir'), { recursive: true });
    writeFileSync(envPath(), 'CLICKUP_API_TOKEN=pk_fake_secret\n', 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 5));
    chmodSync(envPath(), 0o640);

    const row = await envRow();

    expect(row.status).toBe('warn');
    expect(row.detail).not.toContain('pk_fake_secret');
  });

  it('reports clean, and stops warning anywhere, once the file has been healed', async () => {
    seedModeUntouchedSinceWrite(0o644);
    // Before the heal both surfaces warn: this row, and the loader that re-checks
    // the mode on every command.
    expect((await envRow()).status).toBe('warn');
    expect(loadNoirEnv(root).warnings.join('\n')).toMatch(/chmod 600/);

    // The heal every project-rewriting command performs, through the real path.
    const res = await scaffold({ root, mode: 'init', host: 'claude' });

    expect(res.envMode).toBe('healed');
    expect(modeOf()).toBe(0o600);
    // Nothing has anything left to warn about, so the message does not come back
    // on the next command — the row stays clean, repeatedly.
    expect(loadNoirEnv(root).warnings.join('\n')).not.toMatch(/chmod 600/);
    expect((await envRow()).status).toBe('ok');
    expect((await envRow()).status).toBe('ok');
  });
});
