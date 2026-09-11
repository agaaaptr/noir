// Slice E4 / task 11 — the FIRST REAL migration: `1.0.0 → 1.1.0`.
//
// Why this migration exists at all (spec §11.2): `.noir/config.yml` is a
// `skipIfExists` seed — the manifest writes it once, at init, and then never
// opens it again (it is user-owned). So when `CURRENT_SCAFFOLD_VERSION` moves
// to 1.1.0, every project already on disk has a `config.yml` that predates the
// `.noir/.env` pointer comment, and NO manifest mechanism can ever add it. The
// migration is the only mechanism for existing projects; `config.yml.tmpl` is
// the mechanism for new ones. Both are pinned here, along with the two
// registry-wide contracts every migration must honor: idempotent and
// non-throwing.
//
// Offline/free: no network, no API key, no embedder.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ENV_POINTER_MARKER, MIGRATIONS, runMigrations } from '../src/migrations/index.js';
import { scaffold } from '../src/scaffold.js';
import {
  CURRENT_SCAFFOLD_VERSION,
  readScaffoldVersion,
  writeScaffoldVersion,
} from '../src/scaffold-version.js';
import { loadTemplate } from '../src/template-loader.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-mig-1-0-0-'));
  // Pin the MCP command so the emitted `.mcp.json` is machine-independent —
  // these tests run a full upgrade, not just the migration.
  process.env.NOIR_MCP_COMMAND = 'noir';
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const configPath = (): string => join(root, '.noir', 'config.yml');
const configBody = (): string => readFileSync(configPath(), 'utf8');

/** The maintainer's real shape: a project last scaffolded by 1.0.0-era Noir.
 *  The stamp is what puts the project INSIDE the migration window —
 *  `scaffold()` skips migrations entirely when `fromVersion === null` (M4), so
 *  a fixture without a stamp would exercise nothing. */
function seedStaleProject(config = 'host: claude\nmode: full\n'): void {
  mkdirSync(join(root, '.noir'), { recursive: true });
  writeFileSync(configPath(), config, 'utf8');
  writeScaffoldVersion(root, '1.0.0');
}

const upgrade = (): ReturnType<typeof scaffold> =>
  scaffold({ root, mode: 'init', host: 'claude', upgrade: true });

describe('migration 1.0.0 → 1.1.0 — the .noir/.env pointer on an existing config.yml', () => {
  it('adds the .env pointer to an existing config.yml, idempotently', async () => {
    seedStaleProject();

    const res = await upgrade();
    // The migration is on the path from the fixture's stamp to current.
    expect(res.migrationsRan).toContain('1.0.0→1.1.0');
    // R1: the literal assertion that pins THIS bump. `--upgrade` restamps, so a
    // 1.0.0 project is 1.1.0 afterwards and doctor stops reporting drift.
    expect(readScaffoldVersion(root)).toBe('1.1.0');

    const once = configBody();
    expect(once).toMatch(/\.noir\/\.env/);
    expect(once).toMatch(/host: claude/); // user content preserved
    expect(once).toMatch(/mode: full/);

    // Byte-level idempotency. A second upgrade with the stamp still at current
    // has an EMPTY migration window, so it would pass vacuously — rewind the
    // stamp so the SAME migration actually runs a second time and must decide,
    // by its marker guard, to change nothing.
    writeScaffoldVersion(root, '1.0.0');
    const again = await upgrade();
    expect(again.migrationsRan).toContain('1.0.0→1.1.0');
    expect(configBody()).toBe(once);
  });

  it('is a byte-level no-op when the marker is already present', () => {
    const mine = `host: claude\nmode: full\n\n${ENV_POINTER_MARKER}\n# noted\n`;
    seedStaleProject(mine);

    const res = runMigrations(root, '1.0.0', '1.1.0');

    expect(res.ran).toContain('1.0.0→1.1.0');
    expect(res.changed).not.toContain('.noir/config.yml');
    expect(res.conflicts).toEqual([]);
    // Untouched — never even opened for writing.
    expect(configBody()).toBe(mine);
  });

  it('appends without reordering or rewriting the user content', () => {
    const mine = '# my own notes\nhost: gemini\nmode: quick\n\nintegrations:\n  clickup: {}\n';
    seedStaleProject(mine);

    runMigrations(root, '1.0.0', '1.1.0');

    const after = configBody();
    // The user's bytes are a PREFIX of the result — an append, never a rewrite.
    expect(after.startsWith(mine)).toBe(true);
    // Exactly one blank line of separation, then the marker block.
    expect(after.slice(mine.length)).toMatch(/^\n# noir:env-pointer\n/);
    expect(after.split(ENV_POINTER_MARKER).length - 1).toBe(1); // exactly once
  });

  it('appends exactly the block config.yml.tmpl ships (one shared definition)', () => {
    // Both mechanisms must produce the same bytes, or a project created by this
    // build and a project migrated into it would differ. The template cannot
    // import the TS constant, so this is the guard that keeps them in step.
    const tmpl = loadTemplate('config.yml.tmpl');
    const tmplBlock = tmpl.slice(tmpl.indexOf(ENV_POINTER_MARKER));
    seedStaleProject();

    runMigrations(root, '1.0.0', '1.1.0');

    const after = configBody();
    expect(after.slice(after.indexOf(ENV_POINTER_MARKER))).toBe(tmplBlock);
  });

  it('handles a config.yml that does not end in a newline without gluing lines', () => {
    seedStaleProject('host: claude\nmode: full'); // no trailing \n

    runMigrations(root, '1.0.0', '1.1.0');

    const after = configBody();
    expect(after.startsWith('host: claude\nmode: full\n')).toBe(true);
    // The YAML key is never glued to the marker (`mode: full# noir:env-pointer`).
    expect(after).not.toMatch(/full# noir/);
    expect(after.split(ENV_POINTER_MARKER).length - 1).toBe(1);
  });

  it('does not create a config.yml that is absent (the skipIfExists emit does)', async () => {
    writeScaffoldVersion(root, '1.0.0'); // a project with no config.yml at all
    expect(existsSync(configPath())).toBe(false);

    const res = await upgrade();

    // The migration left it alone…
    expect(res.migrationConflicts).toEqual([]);
    // …and the upgrade's `skipIfExists` phase seeded it from the template,
    // which already carries the pointer — so the project ends up correct
    // either way, with the creation owned by exactly one mechanism.
    expect(res.written).toContain('.noir/config.yml');
    expect(configBody()).toContain(ENV_POINTER_MARKER);
  });

  it('reports the file as a PLANNED change under --dry-run and touches nothing', () => {
    seedStaleProject();
    const before = configBody();

    const res = runMigrations(root, '1.0.0', '1.1.0', { dryRun: true });

    expect(res.changed).toContain('.noir/config.yml');
    expect(configBody()).toBe(before);
  });

  it('NEVER throws when config.yml cannot be read — records a conflict instead', () => {
    // A directory named `config.yml`: exists, unreadable as a file. The
    // non-throwing contract (registry convention) exercised without mocks.
    mkdirSync(join(root, '.noir', 'config.yml'), { recursive: true });
    writeScaffoldVersion(root, '1.0.0');

    const res = runMigrations(root, '1.0.0', '1.1.0');

    expect(res.conflicts).toContain('.noir/config.yml');
    expect(res.changed).not.toContain('.noir/config.yml');
  });
});

describe('config.yml.tmpl carries the same pointer (new projects)', () => {
  it('ships the marker so the migration is a no-op on a project it created', () => {
    const tmpl = loadTemplate('config.yml.tmpl');
    expect(tmpl).toContain(ENV_POINTER_MARKER);
    expect(tmpl).toMatch(/\.noir\/\.env/);
  });

  it('a FRESH init emits a config.yml that already carries the marker', async () => {
    const res = await scaffold({ root, mode: 'init', host: 'claude' });
    expect(res.written).toContain('.noir/config.yml');
    expect(configBody()).toContain(ENV_POINTER_MARKER);
    // The marker guard and the template agree, so a project created by THIS
    // build has nothing left for the migration to do.
    writeScaffoldVersion(root, '1.0.0');
    const after = await upgrade();
    expect(after.migrationConflicts).toEqual([]);
    expect(configBody().split(ENV_POINTER_MARKER).length - 1).toBe(1);
  });
});

describe('registry — the 1.0.0 → 1.1.0 entry', () => {
  it('is registered exactly once with a bare x.y.z window and a description', () => {
    const entries = MIGRATIONS.filter((m) => m.to === '1.1.0');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.from).toBe('1.0.0');
    expect(entries[0]?.description.length).toBeGreaterThan(0);
  });

  it('ends where the build is, so the bump and the migration cannot drift apart', () => {
    // A bump that forgets the migration (or a migration that forgets the bump)
    // fails here rather than silently leaving projects with no upgrade path.
    expect(MIGRATIONS.some((m) => m.to === CURRENT_SCAFFOLD_VERSION)).toBe(true);
  });
});
