// S9 t6 — `noir doctor` behavior tests.
//
// Covers the check matrix + exit-code contract (exit 1 iff any CRITICAL fail)
// and the --json `{ok,data}` envelope. Expectations are driven by
// `vecAvailability()` so the suite is honest on hosts where the sqlite-vec
// native binary is unavailable (the store simply cannot open there → exit 1,
// which is exactly what doctor should report).
//
// The daemon record is isolated per worker via NOIR_DAEMON_JSON so the daemon
// check is deterministic (no record → warn, never fail).
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths } from '@noir-ai/core';
import { clearDaemonRecord } from '@noir-ai/daemon';
import { openStore, vecAvailability } from '@noir-ai/store';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { doctor } from '../src/commands/doctor.js';
import { EXIT, inferExitCode } from '../src/output.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'noir-doctor-test-'));
process.env.NOIR_DAEMON_JSON = join(tmpRoot, 'daemon.json');

/** Capture stdout/stderr around `fn`, returning the streams + any thrown value. */
async function run(
  fn: () => Promise<void>,
): Promise<{ stdout: string; stderr: string; err: unknown }> {
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
  let err: unknown;
  try {
    await fn();
  } catch (e) {
    err = e;
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { stdout: out.join(''), stderr: errChunks.join(''), err };
}

/** @returns the env-var NAME used to probe provider key resolution. */
const PROV_KEY_ENV = 'NOIR_DOCTOR_PROVIDER_KEY';

let root: string;
let origCwd: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-doctor-cwd-'));
  origCwd = process.cwd();
  process.chdir(root);
  clearDaemonRecord();
  delete process.env[PROV_KEY_ENV];
});
afterEach(() => {
  process.chdir(origCwd);
  clearDaemonRecord();
  delete process.env[PROV_KEY_ENV];
  rmSync(root, { recursive: true, force: true });
});
afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function findCheck(checks: Array<{ name: string; status: string; detail: string }>, name: string) {
  const c = checks.find((x) => x.name === name);
  expect(c, `check '${name}' should be present`).toBeDefined();
  return c!;
}

describe('noir doctor — uninitialized project', () => {
  it('reports config warn + skips project-dependent checks; exit reflects native deps', async () => {
    const nativeOk = vecAvailability().ok === true;
    const r = await run(() => doctor({ json: true }));
    const envelope = JSON.parse(r.stdout);
    expect(envelope.ok).toBe(true);
    expect(Array.isArray(envelope.data.checks)).toBe(true);
    const cfg = findCheck(envelope.data.checks, 'config');
    expect(cfg.status).toBe('warn');
    expect(cfg.detail).toMatch(/run `noir init`/);
    // store/embedder/provider are skipped (warn) when not initialized.
    expect(findCheck(envelope.data.checks, 'store').status).toBe('warn');
    expect(findCheck(envelope.data.checks, 'provider').status).toBe('warn');
    // Exit 1 only when a CRITICAL (native/store/config) check failed. On a
    // vec-less host native-deps is fail → exit 1; otherwise exit 0. When native
    // is OK doctor returns cleanly (no throw → r.err undefined → exit 0);
    // inferExitCode maps an unknown/undefined thrown value to 1, so the success
    // branch must be asserted via r.err directly, not inferExitCode(undefined).
    if (nativeOk) {
      expect(r.err).toBeUndefined();
    } else {
      expect(inferExitCode(r.err)).toBe(EXIT.ERROR);
    }
  });

  it('human mode renders the table to stderr with a STATUS column', async () => {
    const r = await run(() => doctor({}));
    // doctor throws NoirCliError on fail with a summary line already printed;
    // on an uninitialized project it exits 0 only when native deps are healthy.
    expect(r.stderr).toMatch(/noir doctor —/);
    expect(r.stderr).toMatch(/Check.*Status.*Detail/);
    expect(r.stderr).toMatch(/runtime/);
    expect(r.stderr).toMatch(/config/);
  });
});

describe('noir doctor — invalid config (CRITICAL fail → exit 1)', () => {
  it('a config that fails zod → config FAIL + exit 1', async () => {
    mkdirSync(paths.noirDir(root), { recursive: true });
    writeFileSync(paths.projectId(root), 'bad-cfg-project\n', 'utf8');
    // host must be the literal 'claude'; anything else fails the schema.
    writeFileSync(paths.config(root), 'host: notclaude\nmode: full\n', 'utf8');

    const r = await run(() => doctor({ json: true }));
    expect(inferExitCode(r.err)).toBe(EXIT.ERROR);
    const envelope = JSON.parse(r.stdout);
    const cfg = findCheck(envelope.data.checks, 'config');
    expect(cfg.status).toBe('fail');
    expect(cfg.detail).toMatch(/parse error/);
    expect(envelope.data.summary.fail).toBeGreaterThanOrEqual(1);
  });
});

describe('noir doctor — initialized project (vec-gated store open)', () => {
  it.skipIf(vecAvailability().ok !== true)(
    'config ok + store opens + exit 0 (sqlite-vec native available)',
    async () => {
      mkdirSync(paths.noirDir(root), { recursive: true });
      writeFileSync(paths.projectId(root), 'doctor-init-project\n', 'utf8');
      writeFileSync(paths.config(root), 'host: claude\nmode: full\n', 'utf8');
      // doctor opens the store READONLY (a non-mutating health probe), and
      // openStore only creates `.noir/store/` on a read-WRITE open. Seed a real
      // store once so the readonly open succeeds — mirroring a project that has
      // been used (a bare `noir init` hasn't opened the store yet either).
      const seed = await openStore({ projectId: 'doctor-init-project', root, readonly: false });
      await Promise.resolve(seed.close());

      const r = await run(() => doctor({ json: true }));
      // doctor returns cleanly (no throw) when no CRITICAL check fails; assert
      // success via r.err directly (inferExitCode(undefined) maps to 1, not 0).
      expect(r.err).toBeUndefined();
      const envelope = JSON.parse(r.stdout);
      expect(findCheck(envelope.data.checks, 'config').status).toBe('ok');
      expect(findCheck(envelope.data.checks, 'store').status).toBe('ok');
      expect(envelope.data.summary.fail).toBe(0);
      // Human table renders the same facts.
      const human = await run(() => doctor({}));
      expect(human.stderr).toMatch(/all.*check.*passed/);
    },
  );
});

describe('noir doctor — provider status (no live call)', () => {
  it.skipIf(vecAvailability().ok !== true)(
    'reports configured provider + hasKey from env (never a live call)',
    async () => {
      mkdirSync(paths.noirDir(root), { recursive: true });
      writeFileSync(paths.projectId(root), 'doctor-prov-project\n', 'utf8');
      writeFileSync(
        paths.config(root),
        `host: claude\nmode: full\nmodel:\n  providers:\n    anthropic:\n      model: claude-sonnet-4\n      apiKeyEnv: ${PROV_KEY_ENV}\n`,
        'utf8',
      );

      // Key missing → provider warns (model layer degrades to templates).
      delete process.env[PROV_KEY_ENV];
      const rMissing = await run(() => doctor({ json: true }));
      const missing = findCheck(JSON.parse(rMissing.stdout).data.checks, 'provider');
      expect(missing.status).toBe('warn');
      expect(missing.detail).toContain('anthropic');
      expect(missing.detail).toMatch(/missing NOIR_DOCTOR_PROVIDER_KEY/);

      // Key present → provider ok. Setting an env var is NOT a live call.
      process.env[PROV_KEY_ENV] = 'test-key';
      const rOk = await run(() => doctor({ json: true }));
      const ok = findCheck(JSON.parse(rOk.stdout).data.checks, 'provider');
      expect(ok.status).toBe('ok');
      expect(ok.detail).toMatch(/key present/);
    },
  );
});

describe('noir doctor — --json envelope shape', () => {
  it('emits {ok:true, data:{noir, checks[], summary}} with consistent counts', async () => {
    const r = await run(() => doctor({ json: true }));
    const envelope = JSON.parse(r.stdout);
    expect(envelope.ok).toBe(true);
    expect(typeof envelope.data.noir).toBe('string');
    const checks = envelope.data.checks as Array<{ status: string }>;
    expect(Array.isArray(checks)).toBe(true);
    expect(checks.length).toBeGreaterThan(0);
    const summary = envelope.data.summary;
    const recompute = { ok: 0, warn: 0, fail: 0 } as Record<string, number>;
    for (const c of checks) recompute[c.status] = (recompute[c.status] ?? 0) + 1;
    expect(summary).toEqual(recompute);
    expect(existsSync(paths.config(root))).toBe(false); // sanity: still uninitialized
  });
});
