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
import { CURRENT_SCAFFOLD_VERSION, scaffoldVersionPath } from '@noir-ai/create';
import { clearDaemonRecord } from '@noir-ai/daemon';
import { openStore, vecAvailability } from '@noir-ai/store';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type CheckResult, checkPublish, doctor } from '../src/commands/doctor.js';
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
  // The expect().toBeDefined() above is the runtime check; this guard makes the
  // narrowing visible to TS (replacing the prior `c!` non-null assertion) and
  // throws with a clear message if a future caller skips the expect.
  if (!c) throw new Error(`check '${name}' not found in doctor payload`);
  return c;
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

describe('noir doctor — initialized but store not yet created (fresh project)', () => {
  it('store WARNS (not fails) when the store DB is absent — no critical from store', async () => {
    const nativeOk = vecAvailability().ok === true;
    mkdirSync(paths.noirDir(root), { recursive: true });
    writeFileSync(paths.projectId(root), 'doctor-fresh-project\n', 'utf8');
    writeFileSync(paths.config(root), 'host: claude\nmode: full\n', 'utf8');
    // Deliberately do NOT seed a store: a bare `noir init`/`create` hasn't opened
    // one yet either (the store DB is created lazily on first daemon run). Doctor
    // must treat this expected fresh state as a warning, NOT a critical failure.

    const r = await run(() => doctor({ json: true }));
    const env = JSON.parse(r.stdout);
    const store = findCheck(env.data.checks, 'store');
    expect(store.status).toBe('warn');
    expect(store.detail).toMatch(/not created yet/);
    // The store absence must NOT drive a critical failure. The only possible
    // `fail` on this host is native-deps when sqlite-vec can't load — and even
    // then the store row stays a warning, not the failure.
    if (nativeOk) {
      expect(env.data.summary.fail).toBe(0);
      expect(r.err).toBeUndefined(); // exit 0 — nothing critical
    } else {
      expect(findCheck(env.data.checks, 'native deps').status).toBe('fail');
      expect(env.data.summary.fail).toBe(1);
      expect(store.status).toBe('warn'); // store is NOT the failing check
    }
  });
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

describe('noir doctor — scaffold-version drift (slice S-T2)', () => {
  it('reports onDisk=null + drift=false (warn) when the stamp is absent', async () => {
    const r = await run(() => doctor({ json: true }));
    const env = JSON.parse(r.stdout);
    expect(env.data.scaffold).toEqual({
      onDisk: null,
      current: CURRENT_SCAFFOLD_VERSION,
      drift: false,
    });
    const row = findCheck(env.data.checks, 'scaffold version');
    expect(row.status).toBe('warn');
    expect(row.detail).toMatch(/no .noir\/scaffold-version stamp/);
  });

  it('reports drift=false (ok) when on-disk == current', async () => {
    mkdirSync(paths.noirDir(root), { recursive: true });
    writeFileSync(paths.projectId(root), 'doctor-scaffold-up-to-date\n', 'utf8');
    writeFileSync(scaffoldVersionPath(root), `noir-scaffold=${CURRENT_SCAFFOLD_VERSION}\n`, 'utf8');

    const r = await run(() => doctor({ json: true }));
    const env = JSON.parse(r.stdout);
    expect(env.data.scaffold).toEqual({
      onDisk: CURRENT_SCAFFOLD_VERSION,
      current: CURRENT_SCAFFOLD_VERSION,
      drift: false,
    });
    expect(findCheck(env.data.checks, 'scaffold version').status).toBe('ok');
  });

  it('reports drift=true (warn) when on-disk != current', async () => {
    mkdirSync(paths.noirDir(root), { recursive: true });
    writeFileSync(paths.projectId(root), 'doctor-scaffold-stale\n', 'utf8');
    // Emulate a project last scaffolded by an older build.
    writeFileSync(scaffoldVersionPath(root), 'noir-scaffold=0.9.0\n', 'utf8');

    const r = await run(() => doctor({ json: true }));
    const env = JSON.parse(r.stdout);
    expect(env.data.scaffold).toEqual({
      onDisk: '0.9.0',
      current: CURRENT_SCAFFOLD_VERSION,
      drift: true,
    });
    const row = findCheck(env.data.checks, 'scaffold version');
    expect(row.status).toBe('warn');
    expect(row.detail).toMatch(/on-disk 0\.9\.0 .* current/);
    expect(row.detail).toMatch(/noir init --upgrade/);
  });

  it('human mode renders the scaffold-version row', async () => {
    mkdirSync(paths.noirDir(root), { recursive: true });
    writeFileSync(paths.projectId(root), 'doctor-scaffold-human\n', 'utf8');
    writeFileSync(scaffoldVersionPath(root), `noir-scaffold=${CURRENT_SCAFFOLD_VERSION}\n`, 'utf8');

    const r = await run(() => doctor({}));
    expect(r.stderr).toMatch(/scaffold version/);
    expect(r.stderr).toMatch(/up to date/);
  });
});

describe('noir doctor — RULES.md budget (R5)', () => {
  it('absent RULES.md → ok informational, data.rules is null', async () => {
    // Initialize the project so the check runs (rather than skip-with-warn).
    mkdirSync(paths.noirDir(root), { recursive: true });
    writeFileSync(paths.projectId(root), 'doctor-rules-absent\n', 'utf8');
    writeFileSync(paths.config(root), 'host: claude\nmode: full\n', 'utf8');

    const r = await run(() => doctor({ json: true }));
    const env = JSON.parse(r.stdout);
    expect(env.data.rules).toBeNull();
    const row = findCheck(env.data.checks, 'rules budget');
    expect(row.status).toBe('ok');
    expect(row.detail).toMatch(/no \.noir\/rules\/RULES\.md/);
  });

  it('under-budget RULES.md → ok with measured bytes/lines, data.rules populated', async () => {
    mkdirSync(paths.noirDir(root), { recursive: true });
    mkdirSync(join(root, '.noir', 'rules'), { recursive: true });
    writeFileSync(paths.projectId(root), 'doctor-rules-under\n', 'utf8');
    writeFileSync(paths.config(root), 'host: claude\nmode: full\n', 'utf8');
    // A small RULES.md: well under the 6 KB / 150-line defaults.
    const body = '# RULES\n\n- Fail loudly.\n- Back every clause with a failure.\n';
    writeFileSync(paths.rulesMd(root), body, 'utf8');

    const r = await run(() => doctor({ json: true }));
    const env = JSON.parse(r.stdout);
    expect(env.data.rules).not.toBeNull();
    const rules = env.data.rules;
    expect(rules.over).toBe(false);
    expect(rules.budget).toEqual({ kb: 6, maxLines: 150 });
    expect(rules.onDisk.bytes).toBe(Buffer.byteLength(body, 'utf8'));
    // 4 lines (no trailing newline offset: body ends with '\n' so 5 split - 1 = 4).
    expect(rules.onDisk.lines).toBe(4);
    const row = findCheck(env.data.checks, 'rules budget');
    expect(row.status).toBe('ok');
    expect(row.detail).toMatch(/within budget/);
  });

  it('over-byte-budget RULES.md → warn, data.rules.over true, hint names the lever', async () => {
    mkdirSync(paths.noirDir(root), { recursive: true });
    mkdirSync(join(root, '.noir', 'rules'), { recursive: true });
    writeFileSync(paths.projectId(root), 'doctor-rules-over-bytes\n', 'utf8');
    // lengthBudgetKb=1 makes it trivial to trip the byte ceiling without
    // generating 150+ lines (keeps the test fast and focused on the byte leg).
    writeFileSync(
      paths.config(root),
      'host: claude\nmode: full\nrules:\n  lengthBudgetKb: 1\n',
      'utf8',
    );
    // 2 KB of content (well past the 1 KB budget) but only a few lines.
    const line = 'x'.repeat(512);
    const body = `# RULES\n\n${line}\n${line}\n${line}\n${line}\n`;
    writeFileSync(paths.rulesMd(root), body, 'utf8');

    const r = await run(() => doctor({ json: true }));
    const env = JSON.parse(r.stdout);
    const rules = env.data.rules;
    expect(rules).not.toBeNull();
    expect(rules.over).toBe(true);
    expect(rules.budget.kb).toBe(1);
    expect(rules.onDisk.bytes).toBeGreaterThan(1024);
    const row = findCheck(env.data.checks, 'rules budget');
    expect(row.status).toBe('warn');
    expect(row.detail).toMatch(/OVER/);
    // The hint names BOTH levers so the user knows the escape hatches.
    expect(row.detail).toMatch(/trim RULES\.md/);
    expect(row.detail).toMatch(/raise rules\.lengthBudgetKb/);
  });

  it('over-line-budget RULES.md → warn (line ceiling tripped, not bytes)', async () => {
    mkdirSync(paths.noirDir(root), { recursive: true });
    mkdirSync(join(root, '.noir', 'rules'), { recursive: true });
    writeFileSync(paths.projectId(root), 'doctor-rules-over-lines\n', 'utf8');
    // Default 6 KB budget. 200 short lines stay well under 6 KB but exceed the
    // 150-line ceiling — exercises the OR leg independently of the byte leg.
    writeFileSync(paths.config(root), 'host: claude\nmode: full\n', 'utf8');
    const body = `${Array.from({ length: 200 }, (_, i) => `rule ${i}`).join('\n')}\n`;
    writeFileSync(paths.rulesMd(root), body, 'utf8');

    const r = await run(() => doctor({ json: true }));
    const env = JSON.parse(r.stdout);
    const rules = env.data.rules;
    expect(rules.over).toBe(true);
    expect(rules.onDisk.lines).toBe(200);
    // Sanity: byte budget NOT tripped for this body.
    expect(rules.onDisk.bytes).toBeLessThan(6 * 1024);
    const row = findCheck(env.data.checks, 'rules budget');
    expect(row.status).toBe('warn');
    expect(row.detail).toMatch(/200\/150 lines/);
  });
});

// ---------------------------------------------------------------------------
// S10 — host-artifacts presence check.
// ---------------------------------------------------------------------------
describe('noir doctor — host artifacts (S10)', () => {
  it('host row warns "skipped" when the project is not initialized; data.host null', async () => {
    const r = await run(() => doctor({ json: true }));
    const env = JSON.parse(r.stdout);
    expect(env.data.host).toBeNull();
    const row = findCheck(env.data.checks, 'host artifacts');
    expect(row.status).toBe('warn');
    expect(row.detail).toMatch(/skipped — not initialized/);
  });

  it('claude project with all artifacts → ok; data.host reports active + expected', async () => {
    mkdirSync(paths.noirDir(root), { recursive: true });
    writeFileSync(paths.projectId(root), 'doctor-host-claude\n', 'utf8');
    writeFileSync(paths.config(root), 'host: claude\nmode: full\n', 'utf8');
    // Seed the expected claude artifacts (what `noir init` would write).
    writeFileSync(join(root, 'AGENTS.md'), '# agents\n', 'utf8');
    writeFileSync(
      join(root, 'CLAUDE.md'),
      '<!-- noir:context begin -->\n@import ".noir/NOIR.md"\n<!-- noir:context end -->\n',
      'utf8',
    );
    writeFileSync(join(root, '.mcp.json'), '{\n  "mcpServers": {}\n}\n', 'utf8');

    const r = await run(() => doctor({ json: true }));
    const env = JSON.parse(r.stdout);
    expect(env.data.host).not.toBeNull();
    expect(env.data.host.active).toBe('claude');
    expect(env.data.host.expected).toEqual(
      expect.arrayContaining(['AGENTS.md', 'CLAUDE.md', '.mcp.json']),
    );
    expect(env.data.host.missing).toEqual([]);
    const row = findCheck(env.data.checks, 'host artifacts');
    expect(row.status).toBe('ok');
    expect(row.detail).toMatch(/host=claude/);
  });

  it('gemini project → expected set is AGENTS.md + GEMINI.md + .gemini/mcp.json', async () => {
    mkdirSync(paths.noirDir(root), { recursive: true });
    writeFileSync(paths.projectId(root), 'doctor-host-gemini\n', 'utf8');
    writeFileSync(paths.config(root), 'host: gemini\nmode: full\n', 'utf8');
    // Seed all three expected gemini artifacts.
    writeFileSync(join(root, 'AGENTS.md'), '# agents\n', 'utf8');
    mkdirSync(join(root, '.gemini'), { recursive: true });
    writeFileSync(join(root, 'GEMINI.md'), '# gemini\n', 'utf8');
    writeFileSync(join(root, '.gemini', 'mcp.json'), '{\n  "mcpServers": {}\n}\n', 'utf8');

    const r = await run(() => doctor({ json: true }));
    const env = JSON.parse(r.stdout);
    expect(env.data.host.active).toBe('gemini');
    expect(env.data.host.expected).toEqual(
      expect.arrayContaining(['AGENTS.md', 'GEMINI.md', '.gemini/mcp.json']),
    );
    expect(env.data.host.missing).toEqual([]);
    expect(findCheck(env.data.checks, 'host artifacts').status).toBe('ok');
  });

  it('cursor project missing .cursor/rules/noir-rules.mdc → warn (NEVER fail); data.host.missing lists it', async () => {
    mkdirSync(paths.noirDir(root), { recursive: true });
    writeFileSync(paths.projectId(root), 'doctor-host-cursor\n', 'utf8');
    writeFileSync(paths.config(root), 'host: cursor\nmode: full\n', 'utf8');
    // Seed AGENTS.md + .cursor/mcp.json but NOT the noir-rules .mdc.
    writeFileSync(join(root, 'AGENTS.md'), '# agents\n', 'utf8');
    mkdirSync(join(root, '.cursor', 'rules'), { recursive: true });
    mkdirSync(join(root, '.cursor'), { recursive: true });
    writeFileSync(join(root, '.cursor', 'mcp.json'), '{\n  "mcpServers": {}\n}\n', 'utf8');

    const r = await run(() => doctor({ json: true }));
    const env = JSON.parse(r.stdout);
    expect(env.data.host.active).toBe('cursor');
    expect(env.data.host.missing).toContain('.cursor/rules/noir-rules.mdc');
    const row = findCheck(env.data.checks, 'host artifacts');
    // warn — NEVER fail (a missing host artifact is restored by `noir sync`,
    // not a critical product failure).
    expect(row.status).toBe('warn');
    expect(row.detail).toMatch(/noir sync/);
    // Even with a missing host artifact, doctor's overall exit reflects only
    // CRITICAL fails — the host row contributed a warn, not a fail.
    expect(env.data.summary.fail).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// S11 — publish-readiness check (advisory; warn-only).
// ---------------------------------------------------------------------------
//
// The check is exercised via `checkPublish(checks, packagesDir)` directly with
// synthetic package dirs (isolated, deterministic — no dependency on the real
// repo's package.json contents or on `npm pack` being available). A final
// integration test confirms `doctor()` wires the publish row into the payload.
describe('noir doctor — publish check (S11)', () => {
  /** Build a synthetic `packages/` dir under a temp root with the given package
   *  shapes. Each entry is `[dirName, package.json-shape]`. Returns the
   *  absolute path of the synthetic packages dir. */
  function syntheticPackages(entries: Array<[string, Record<string, unknown>]>): string {
    const packagesDir = join(root, 'packages');
    mkdirSync(packagesDir, { recursive: true });
    for (const [dir, pkg] of entries) {
      mkdirSync(join(packagesDir, dir), { recursive: true });
      writeFileSync(
        join(packagesDir, dir, 'package.json'),
        `${JSON.stringify(pkg, null, 2)}\n`,
        'utf8',
      );
    }
    return packagesDir;
  }

  it('all packages valid → ok, data.publish { checked, issues: [] }', () => {
    const packagesDir = syntheticPackages([
      ['core', { name: '@noir-ai/core', version: '1.0.0', files: ['dist'] }],
      [
        'cli',
        {
          name: '@noir-ai/cli',
          version: '1.1.0-beta.1',
          files: ['dist', 'README.md'],
          bin: { noir: 'dist/bin.js' },
        },
      ],
    ]);
    const checks: CheckResult[] = [];
    const result = checkPublish(checks, packagesDir, { skipNpmPack: true });
    expect(result).not.toBeNull();
    expect(result?.checked).toBe(2);
    expect(result?.issues).toEqual([]);
    const row = findCheck(checks, 'publish');
    expect(row.status).toBe('ok');
  });

  it('a synthetic broken package.json (bad version) → warn, issue names version', () => {
    const packagesDir = syntheticPackages([
      ['bogus', { name: '@noir-ai/bogus', version: 'latest', files: ['dist'] }],
    ]);
    const checks: CheckResult[] = [];
    const result = checkPublish(checks, packagesDir, { skipNpmPack: true });
    expect(result?.checked).toBe(1);
    expect(result?.issues.length).toBe(1);
    // The issue calls out BOTH the package and the failed check.
    expect(result?.issues[0]).toMatch(/bogus/);
    expect(result?.issues[0]).toMatch(/version/);
    expect(findCheck(checks, 'publish').status).toBe('warn');
    // Publish is advisory: a warn row must NEVER escalate to a critical fail.
    expect(findCheck(checks, 'publish').status).not.toBe('fail');
  });

  it('cli missing bin → warn, issue names bin (cli package must declare a bin)', () => {
    // Everything else valid; only the cli `bin` field is omitted.
    const packagesDir = syntheticPackages([
      ['cli', { name: '@noir-ai/cli', version: '1.0.0', files: ['dist'] }],
    ]);
    const checks: CheckResult[] = [];
    const result = checkPublish(checks, packagesDir, { skipNpmPack: true });
    expect(result?.checked).toBe(1);
    expect(result?.issues.length).toBe(1);
    expect(result?.issues[0]).toMatch(/bin/);
    expect(findCheck(checks, 'publish').status).toBe('warn');
  });

  it('null packagesDir → ok skip + data.publish null (global-install path)', () => {
    // A global `npm install -g` has no `packages/*` workspace to validate; the
    // check still produces a row (always-runs contract) but reports ok-skip and
    // returns null for `data.publish`.
    const checks: CheckResult[] = [];
    const result = checkPublish(checks, null);
    expect(result).toBeNull();
    const row = findCheck(checks, 'publish');
    expect(row.status).toBe('ok');
    expect(row.detail).toMatch(/skipped/);
  });

  it('doctor() wires the publish row into the --json payload', async () => {
    // Integration: running doctor() from the test process resolves the real
    // workspace (the cli test files live under packages/cli/...) and emits a
    // `publish` field + a `publish` check row. The shape is asserted, not the
    // issue list (which depends on the repo's current package.json state + npm
    // availability at test time).
    const r = await run(() => doctor({ json: true }));
    const env = JSON.parse(r.stdout);
    // data.publish is either null (not a monorepo) or {checked, issues}. From
    // the test process we ARE in the monorepo, so it must be the object shape.
    expect(env.data.publish).not.toBeNull();
    expect(typeof env.data.publish.checked).toBe('number');
    expect(env.data.publish.checked).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(env.data.publish.issues)).toBe(true);
    const row = findCheck(env.data.checks, 'publish');
    // Advisory only — the publish row must never be a critical fail.
    expect(row.status).not.toBe('fail');
  });
});
