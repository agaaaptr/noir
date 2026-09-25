// `noir doctor --fix` — the owner-only permission heal.
//
// The pass re-asserts owner-only permissions on the files Noir keeps private
// (`.noir/.env` and, for an initialized project, the store DB + directory)
// BEFORE the checks that read them run, so every row reports the post-heal
// state and the `--json` payload carries exactly what changed in a `fixes`
// array. Three things are under test: a lax `.env` is tightened to 0600 and
// the `noir-env` row flips to ok; a clean root is a no-op (every entry
// `unchanged`); and the `--json` shape stays stable — `fixes` appears only
// when `--fix` was passed.
//
// Offline/free: no network, no API key, no embedder.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { doctor } from '../src/commands/doctor.js';

let root: string;
let daemonDir: string;
let origCwd: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-doctor-fix-'));
  daemonDir = mkdtempSync(join(tmpdir(), 'noir-doctor-fix-daemon-'));
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

/** The `--json` data payload, reduced to the fields these tests assert on. */
interface FixPayload {
  fixes?: Array<{ path: string; outcome: string }>;
  checks: Array<{ name: string; status: string; detail: string }>;
}

/** Run `noir doctor --json` (optionally with `--fix`) and return its payload. */
async function runDoctor(opts: { fix?: boolean } = {}): Promise<FixPayload> {
  const out: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((c: unknown) => {
    out.push(typeof c === 'string' ? c : String(c));
    return true;
  }) as typeof process.stdout.write;
  try {
    await doctor({ json: true, ...opts });
  } catch {
    // A CRITICAL check (e.g. native deps on a host without sqlite-vec) signals
    // through the exit code by throwing AFTER the JSON payload is on stdout —
    // the fix pass under test already ran.
  } finally {
    process.stdout.write = origOut;
  }
  const envelope = JSON.parse(out.join('')) as { data: FixPayload };
  return envelope.data;
}

describe('noir doctor --fix — owner-only permission heal', () => {
  it('heals a lax .env to 0600, flips the row to ok, and reports the heal', async () => {
    mkdirSync(join(root, '.noir'), { recursive: true });
    writeFileSync(envPath(), '# seeded\n', 'utf8');
    chmodSync(envPath(), 0o644);

    const payload = await runDoctor({ fix: true });

    expect(modeOf()).toBe(0o600);
    const row = payload.checks.find((c) => c.name === 'noir-env');
    expect(row?.status).toBe('ok');
    expect(row?.detail).toContain('0600');
    expect(payload.fixes).toContainEqual({ path: '.noir/.env', outcome: 'healed' });
  });

  it('is a no-op on a clean root: every fix entry is unchanged', async () => {
    const payload = await runDoctor({ fix: true });

    expect(payload.fixes).toBeDefined();
    const fixes = payload.fixes ?? [];
    expect(fixes.length).toBeGreaterThan(0);
    for (const fix of fixes) {
      expect(fix.outcome).toBe('unchanged');
    }
  });

  it('keeps the --json shape stable: fixes appears only when --fix is passed', async () => {
    mkdirSync(join(root, '.noir'), { recursive: true });
    writeFileSync(envPath(), '# seeded\n', 'utf8');
    chmodSync(envPath(), 0o644);

    // Without --fix the payload carries no `fixes` key and the lax mode is left
    // alone — the heal is opt-in, not a side effect of a plain diagnosis.
    const plain = await runDoctor({});
    expect('fixes' in plain).toBe(false);
    expect(modeOf()).toBe(0o644);

    // With --fix the key appears (and the file has been tightened).
    const fixed = await runDoctor({ fix: true });
    expect(fixed.fixes).toBeDefined();
  });
});
