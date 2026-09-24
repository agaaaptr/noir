// Refreshing doc-only seeds on the upgrade path.
//
// `noir init` writes two files whose only job is to be read by a human:
// `.noir/.env.example` (documents the variable set) and `.noir/rules/RULES.md`
// (the working-contract seed). Both are create-only-if-absent, so before this
// behavior they froze at the bytes of whichever Noir version initialized the
// project — a release that added a variable to the example reached new projects
// only, and an initialized project could not obtain the newer text from any
// command.
//
// An upgrade may now replace such a file, but only when the bytes on disk are
// still an exact copy of a seed an older Noir shipped, i.e. the user never
// touched it. Every other byte pattern is the user's file and goes through the
// ordinary conflict flow, which keeps their bytes unless someone says otherwise.
//
// WHY THE TEMPLATES ARE SUBSTITUTED
// The report is decided by comparing two things: the bytes on disk and what the
// current template renders to. The packaged templates still render to exactly
// the bytes recorded for the initial scaffold version, so against them a refresh
// could never trigger — there would be nothing newer to write. Pointing the
// loader at a copy whose two seed templates carry one added line reproduces the
// state a later release is in, without editing the templates this repo ships.
// `NOIR_TEMPLATES_DIR` exists for exactly this (see `template-loader.ts`), and
// the loader reads it once at import time, hence the dynamic import of the
// engine below.
//
// Offline/free: no network, no API key, no embedder.
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CURRENT_SCAFFOLD_VERSION, writeScaffoldVersion } from '../src/scaffold-version.js';
import { SEED_TEMPLATE_HISTORY, type SeedKind } from '../src/template-history.js';

/** The recorded initial seed bytes — what a user who initialized long ago and
 *  never edited the file still has on disk. */
const recorded = SEED_TEMPLATE_HISTORY.find((e) => e.scaffoldVersion === '1.1.0');
if (!recorded) throw new Error('template history is missing the initial entry');

/** A plausible render of the same seeds in a LATER release: the recorded text
 *  plus one added line, which is the shape every seed change takes (document one
 *  more variable, add one more rule). */
const SHIPPED_ENV_EXAMPLE = `${recorded.envExample}# NEW_VAR=1\n`;
const SHIPPED_RULES_SEED = `${recorded.rulesSeed}\n- A rule added after the recorded snapshot.\n`;

const PACKAGED_TEMPLATES = fileURLToPath(new URL('../templates/', import.meta.url));
const TEMPLATES = mkdtempSync(join(tmpdir(), 'noir-refresh-templates-'));
cpSync(PACKAGED_TEMPLATES, TEMPLATES, { recursive: true });
writeFileSync(join(TEMPLATES, 'env.example.tmpl'), SHIPPED_ENV_EXAMPLE, 'utf8');
writeFileSync(join(TEMPLATES, 'rules-seed.tmpl'), SHIPPED_RULES_SEED, 'utf8');
writeFileSync(join(TEMPLATES, 'rules-seed.md.tmpl'), SHIPPED_RULES_SEED, 'utf8');
process.env.NOIR_TEMPLATES_DIR = TEMPLATES;

// Imported AFTER the template dir is redirected: the loader resolves its dir once
// at module load, so a static import would pin the packaged templates.
const { scaffold } = await import('../src/scaffold.js');
type ScaffoldResult = Awaited<ReturnType<typeof scaffold>>;
type ScaffoldOptions = Parameters<typeof scaffold>[0];

afterAll(() => {
  rmSync(TEMPLATES, { recursive: true, force: true });
});

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-seed-refresh-'));
  // Pin the MCP command so this suite is deterministic across machines: a native
  // install's absolute shim path would otherwise land in `.mcp.json`.
  process.env.NOIR_MCP_COMMAND = 'noir';
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** POSIX-only assertions (permission bits) are skipped on Windows, where
 *  permissions are ACL-based and the mode is not expressible. */
const posixIt = it.skipIf(process.platform === 'win32');

const abs = (...parts: string[]): string => join(root, ...parts);
const envExample = (): string => abs('.noir', '.env.example');
const rulesSeed = (): string => abs('.noir', 'rules', 'RULES.md');
const mcp = (): string => abs('.mcp.json');

const sha256 = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

/** Initialize the project to the state the old behavior leaves behind: a valid
 *  project id and a CURRENT scaffold stamp, but the seed files still holding the
 *  text an older Noir shipped.
 *
 *  The stamp is deliberately current. That is precisely the shape the bug
 *  produced: `init --upgrade` stamps the running version and, before this
 *  behavior, never rewrote a seed — so a project could be stamped current with
 *  seed bytes from years earlier. It also keeps migrations out of these tests:
 *  the refresh is decided by the bytes on disk, not by the recorded version. */
function seedInitializedProject(files: Partial<Record<SeedKind, string>> = {}): void {
  writeScaffoldVersion(root, CURRENT_SCAFFOLD_VERSION);
  writeFileSync(abs('.noir', 'project.id'), '9f1c0b7e-0000-4000-8000-000000000000\n', 'utf8');
  for (const [kind, bytes] of Object.entries(files) as Array<[SeedKind, string]>) {
    const target = kind === 'envExample' ? envExample() : rulesSeed();
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes, 'utf8');
  }
}

const upgrade = (opts: ScaffoldOptions = {}): Promise<ScaffoldResult> =>
  scaffold({ root, mode: 'init', upgrade: true, host: 'claude', ...opts });

describe('upgrade — a seed nobody edited is refreshed', () => {
  it('replaces the older text of an untouched .noir/.env.example', async () => {
    seedInitializedProject({ envExample: recorded.envExample });

    const res = await upgrade();

    expect(readFileSync(envExample(), 'utf8')).toBe(SHIPPED_ENV_EXAMPLE);
    expect(res.refreshed).toEqual(['.noir/.env.example']);
    // Reported as a refresh, never as a file that was created or left alone —
    // and never as a conflict: nobody was asked anything.
    expect(res.written).not.toContain('.noir/.env.example');
    expect(res.skipped).not.toContain('.noir/.env.example');
    expect(res.conflicts).toEqual([]);
  });

  it('refreshes both seeds in one run', async () => {
    seedInitializedProject({
      envExample: recorded.envExample,
      rulesSeed: recorded.rulesSeed,
    });

    const res = await upgrade();

    expect(readFileSync(envExample(), 'utf8')).toBe(SHIPPED_ENV_EXAMPLE);
    expect(readFileSync(rulesSeed(), 'utf8')).toBe(SHIPPED_RULES_SEED);
    expect(res.refreshed).toEqual(['.noir/.env.example', '.noir/rules/RULES.md']);
    expect(res.conflicts).toEqual([]);
  });

  it('refreshes the file for its OWN seed kind, comparing against its own history column', async () => {
    // The rules seed holds the ENV text (a pathological mixed-up state). It must
    // not be read as a stale rules seed and replaced: the comparison stays inside
    // the seed the file belongs to, so this is a user edit like any other.
    seedInitializedProject({ rulesSeed: recorded.envExample });

    const res = await upgrade();

    expect(readFileSync(rulesSeed(), 'utf8')).toBe(recorded.envExample);
    expect(res.refreshed).toEqual([]);
    expect(res.skipped).toContain('.noir/rules/RULES.md');
  });

  it('leaves a seed that already holds the current text alone, with no conflict', async () => {
    seedInitializedProject({ envExample: SHIPPED_ENV_EXAMPLE });

    const res = await upgrade();

    expect(readFileSync(envExample(), 'utf8')).toBe(SHIPPED_ENV_EXAMPLE);
    expect(res.refreshed).toEqual([]);
    expect(res.skipped).toContain('.noir/.env.example');
    expect(res.conflicts).toEqual([]);
  });

  it('creates an absent seed instead of refreshing it (the backfill case)', async () => {
    seedInitializedProject();

    const res = await upgrade();

    expect(readFileSync(envExample(), 'utf8')).toBe(SHIPPED_ENV_EXAMPLE);
    expect(res.written).toContain('.noir/.env.example');
    expect(res.refreshed).toEqual([]);
  });

  posixIt('keeps the refreshed file’s permission bits', async () => {
    // A refresh is a content change only. The seed's mode is whatever it was
    // created with (or whatever the user later set).
    seedInitializedProject({ envExample: recorded.envExample });
    chmodSync(envExample(), 0o640);

    await upgrade();

    expect(statSync(envExample()).mode & 0o777).toBe(0o640);
  });
});

describe('upgrade — a seed the user edited belongs to the user', () => {
  const EDITED_ENV = `${recorded.envExample}\n# our own gateway token\nANTHROPIC_AUTH_TOKEN=secret\n`;

  it('keeps an edited seed and reports it as surviving (no resolver available)', async () => {
    seedInitializedProject({ envExample: EDITED_ENV });

    const res = await upgrade();

    expect(readFileSync(envExample(), 'utf8')).toBe(EDITED_ENV);
    expect(res.refreshed).toEqual([]);
    expect(res.skipped).toContain('.noir/.env.example');
    // The divergence is recorded even though nobody was prompted, so a CI or
    // `--json` caller can see that this file is out of date and why.
    expect(res.conflicts).toHaveLength(1);
    expect(res.conflicts[0]?.path).toBe('.noir/.env.example');
    expect(res.conflicts[0]?.mode).toBe('skipIfExists');
    expect(res.conflicts[0]?.resolution).toBe('preserve');
  });

  it('keeps an edited seed on a non-interactive run (the CI default)', async () => {
    // `preserve` is what the CLI passes when there is no TTY / `--no-input` is
    // set. A piped upgrade must never rewrite a file the user owns.
    seedInitializedProject({ envExample: EDITED_ENV });

    const res = await upgrade({ conflictPolicy: 'preserve' });

    expect(readFileSync(envExample(), 'utf8')).toBe(EDITED_ENV);
    expect(res.skipped).toContain('.noir/.env.example');
    expect(res.conflicts[0]?.resolution).toBe('preserve');
  });

  it('an "apply to all" answer about seeds does not carry over to the pointer files', async () => {
    // One answer covers the run's remaining conflicts OF ITS OWN CLASS. A seed
    // answer keyed into the pointer-file class would let a single "replace"
    // decision silently overwrite `.mcp.json` too.
    seedInitializedProject({ envExample: EDITED_ENV, rulesSeed: EDITED_ENV });
    writeFileSync(mcp(), 'USER-EDIT\n', 'utf8');
    const asked: string[] = [];

    const res = await upgrade({
      onConflict: (ctx) => {
        asked.push(`${ctx.mode}:${ctx.relPath}`);
        return ctx.mode === 'skipIfExists'
          ? { resolution: 'replace', applyToAll: true }
          : 'preserve';
      },
    });

    // The seeds were decided together (one prompt), the pointer file separately.
    expect(asked).toEqual(['skipIfExists:.noir/.env.example', 'regenerate:.mcp.json']);
    expect(readFileSync(envExample(), 'utf8')).toBe(SHIPPED_ENV_EXAMPLE);
    expect(readFileSync(rulesSeed(), 'utf8')).toBe(SHIPPED_RULES_SEED);
    expect(readFileSync(mcp(), 'utf8')).toBe('USER-EDIT\n');
    expect(res.written).toEqual(
      expect.arrayContaining(['.noir/.env.example', '.noir/rules/RULES.md']),
    );
    expect(res.refreshed).toEqual([]);
  });

  it('replaces an edited seed when the resolver explicitly says so', async () => {
    seedInitializedProject({ envExample: EDITED_ENV });

    const res = await upgrade({
      onConflict: (ctx) => (ctx.mode === 'skipIfExists' ? 'replace' : 'preserve'),
    });

    expect(readFileSync(envExample(), 'utf8')).toBe(SHIPPED_ENV_EXAMPLE);
    // A replacement the user asked for is an ordinary write, not a silent
    // refresh — the two are reported apart on purpose.
    expect(res.written).toContain('.noir/.env.example');
    expect(res.refreshed).toEqual([]);
    expect(res.conflicts[0]?.resolution).toBe('replace');
  });

  it('keeps an edited seed when the resolver says keep', async () => {
    seedInitializedProject({ envExample: EDITED_ENV });

    const res = await upgrade({ onConflict: () => 'preserve' });

    expect(readFileSync(envExample(), 'utf8')).toBe(EDITED_ENV);
    expect(res.skipped).toContain('.noir/.env.example');
  });

  it('honors an explicit overwrite policy (--force), which is an instruction rather than a missing answer', async () => {
    seedInitializedProject({ envExample: EDITED_ENV });

    const res = await upgrade({ conflictPolicy: 'overwrite' });

    expect(readFileSync(envExample(), 'utf8')).toBe(SHIPPED_ENV_EXAMPLE);
    expect(res.written).toContain('.noir/.env.example');
    expect(res.refreshed).toEqual([]);
  });

  it('the resolver is handed the real bytes of the conflicting seed', async () => {
    seedInitializedProject({ envExample: EDITED_ENV });
    const seen: Array<{ existing: string; proposed: string; mode?: string }> = [];

    await upgrade({
      onConflict: (ctx) => {
        seen.push({ existing: ctx.existing, proposed: ctx.proposed, mode: ctx.mode });
        return 'preserve';
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.existing).toBe(EDITED_ENV);
    expect(seen[0]?.proposed).toBe(SHIPPED_ENV_EXAMPLE);
    expect(seen[0]?.mode).toBe('skipIfExists');
  });
});

describe('upgrade — the refresh is confined to the upgrade path', () => {
  it('a forced re-init (no upgrade) does not refresh a stale seed', async () => {
    seedInitializedProject({ envExample: recorded.envExample });

    const res = await scaffold({ root, mode: 'init', host: 'claude', force: true });

    expect(readFileSync(envExample(), 'utf8')).toBe(recorded.envExample);
    expect(res.refreshed).toEqual([]);
    expect(res.skipped).toContain('.noir/.env.example');
  });

  it('sync neither refreshes nor touches seeds', async () => {
    seedInitializedProject({ envExample: recorded.envExample });

    const res = await scaffold({ root, mode: 'sync', host: 'claude' });

    expect(readFileSync(envExample(), 'utf8')).toBe(recorded.envExample);
    expect(res.refreshed).toEqual([]);
    expect(res.written).not.toContain('.noir/.env.example');
  });

  it('a dry run reports the planned refresh and writes nothing', async () => {
    seedInitializedProject({ envExample: recorded.envExample });
    const before = sha256(envExample());

    const res = await upgrade({ dryRun: true });

    expect(res.refreshed).toEqual(['.noir/.env.example']);
    expect(res.written).not.toContain('.noir/.env.example');
    expect(sha256(envExample())).toBe(before);
  });

  it('a dry run reports an edited seed as surviving, exactly as the run would', async () => {
    seedInitializedProject({ envExample: `${recorded.envExample}\n# mine\n` });

    const res = await upgrade({ dryRun: true });

    expect(res.refreshed).toEqual([]);
    expect(res.skipped).toContain('.noir/.env.example');
  });
});

describe('upgrade — user-owned seeds are never opened', () => {
  it('leaves .noir/.env, .noir/config.yml and .noir/project.id untouched', async () => {
    seedInitializedProject({ envExample: recorded.envExample });
    const env = abs('.noir', '.env');
    const config = abs('.noir', 'config.yml');
    const projectId = abs('.noir', 'project.id');
    writeFileSync(env, 'CLICKUP_API_TOKEN=pk_keepme\n', 'utf8');
    writeFileSync(config, 'host: claude\nmode: solo\n', 'utf8');
    const before = { env: sha256(env), config: sha256(config), projectId: sha256(projectId) };

    const res = await upgrade();

    expect(sha256(env)).toBe(before.env);
    expect(sha256(config)).toBe(before.config);
    expect(sha256(projectId)).toBe(before.projectId);
    for (const rel of ['.noir/.env', '.noir/config.yml', '.noir/project.id']) {
      expect(res.written).not.toContain(rel);
      expect(res.refreshed).not.toContain(rel);
      expect(res.skipped).toContain(rel);
    }
  });

  posixIt('completes even when the user-owned seeds cannot be read at all', async () => {
    // The strongest available form of "the engine never opens this file": with
    // the bytes unreadable, any read would throw instead of producing a report.
    // (Skipped on Windows — no POSIX modes — and vacuous when run as root.)
    seedInitializedProject({ envExample: recorded.envExample });
    const env = abs('.noir', '.env');
    const config = abs('.noir', 'config.yml');
    const envBody = 'CLICKUP_API_TOKEN=pk_keepme\n';
    const configBody = 'host: claude\nmode: solo\n';
    writeFileSync(env, envBody, 'utf8');
    writeFileSync(config, configBody, 'utf8');
    chmodSync(env, 0o000);
    chmodSync(config, 0o000);

    try {
      const res = await upgrade();
      expect(res.skipped).toContain('.noir/.env');
      expect(res.skipped).toContain('.noir/config.yml');
      // The refresh that this run DOES perform still happened.
      expect(res.refreshed).toEqual(['.noir/.env.example']);
    } finally {
      chmodSync(env, 0o600);
      chmodSync(config, 0o600);
    }
    expect(readFileSync(env, 'utf8')).toBe(envBody);
    expect(readFileSync(config, 'utf8')).toBe(configBody);
  });
});

describe('upgrade — an unreadable seed is left alone, never an abort', () => {
  // Deciding whether to replace a seed requires reading it. The seed writers
  // this behavior sits on top of only ever asked "does it exist?", so they
  // survived anything unreadable; asking for the bytes instead must not turn a
  // file permission into a half-finished upgrade. Letting the read error escape
  // would abort the emit loop mid-flight — after some entries were already
  // written, and before the version stamp — which is strictly worse than
  // leaving one doc file alone.

  posixIt('completes the upgrade, preserves the seed and reports it as skipped', async () => {
    // (Skipped on Windows — no POSIX modes — and vacuous when run as root.)
    seedInitializedProject({ envExample: recorded.envExample });
    const seed = envExample();
    chmodSync(seed, 0o000);

    try {
      const res = await upgrade();

      // Not a crash, and not a refresh: the bytes could not be compared, so
      // they cannot be shown to be Noir's own.
      expect(res.refreshed).toEqual([]);
      expect(res.written).not.toContain('.noir/.env.example');
      expect(res.skipped).toContain('.noir/.env.example');
      // The run finished its other work rather than stopping at this file.
      expect(res.written).toContain('.noir/NOIR.md');
      expect(res.conflicts).toEqual([]);
    } finally {
      chmodSync(seed, 0o600);
    }
    // The bytes are the ones that were there before, touched by nothing.
    expect(readFileSync(seed, 'utf8')).toBe(recorded.envExample);
  });

  posixIt('a dry run over an unreadable seed reports it as surviving too', async () => {
    seedInitializedProject({ envExample: recorded.envExample });
    const seed = envExample();
    chmodSync(seed, 0o000);

    try {
      const res = await upgrade({ dryRun: true });
      expect(res.refreshed).toEqual([]);
      expect(res.skipped).toContain('.noir/.env.example');
    } finally {
      chmodSync(seed, 0o600);
    }
  });
});

describe('upgrade — the refresh is reported on the result, not inferred', () => {
  it('a run with nothing to refresh reports an empty refreshed list', async () => {
    seedInitializedProject();
    const res = await upgrade();
    expect(res.refreshed).toEqual([]);
    expect(existsSync(envExample())).toBe(true);
  });
});
