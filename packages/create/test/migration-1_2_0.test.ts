// The 1.1.0 → 1.2.0 migration: an unedited doc seed frozen at the older text
// is brought forward on `noir init --upgrade`.
//
// `.noir/.env.example` is written once at init and then never opened again by
// the manifest (it is a doc-only seed the user owns). When a later release
// changes the text it ships, a project initialized before that release keeps
// the old text forever unless a migration moves it. This pins exactly that:
// the older bytes on disk, an upgrade, and the current bytes after. A
// user-edited file (or one already current) must be left alone.
//
// Offline/free: no network, no API key, no embedder.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/migrations/index.js';
import { scaffold } from '../src/scaffold.js';
import { readScaffoldVersion, writeScaffoldVersion } from '../src/scaffold-version.js';
import { SEED_TEMPLATE_HISTORY } from '../src/template-history.js';
import { loadTemplate } from '../src/template-loader.js';

/** The `.noir/.env.example` text an older Noir shipped — what a project
 *  initialized at 1.1.0 and never edited still holds on disk. */
const ENV_EXAMPLE_1_1_0 = SEED_TEMPLATE_HISTORY.find(
  (e) => e.scaffoldVersion === '1.1.0',
)?.envExample;
if (ENV_EXAMPLE_1_1_0 === undefined) {
  throw new Error('template history is missing the 1.1.0 env example');
}

const CURRENT_ENV_EXAMPLE = loadTemplate('env.example.tmpl');

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-mig-1-2-0-'));
  // Pin the MCP command so the emitted `.mcp.json` is machine-independent.
  process.env.NOIR_MCP_COMMAND = 'noir';
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const examplePath = (): string => join(root, '.noir', '.env.example');

/** A project stamped 1.1.0 whose `.env.example` still holds the older text. */
function seedStaleSeed(): void {
  mkdirSync(join(root, '.noir'), { recursive: true });
  writeFileSync(examplePath(), ENV_EXAMPLE_1_1_0, 'utf8');
  writeScaffoldVersion(root, '1.1.0');
}

describe('migration 1.1.0 → 1.2.0 — the doc seeds', () => {
  it('brings an unedited older .env.example forward on --upgrade, and restamps', async () => {
    seedStaleSeed();

    const res = await scaffold({ root, mode: 'init', host: 'claude', upgrade: true });

    expect(res.migrationsRan).toContain('1.1.0→1.2.0');
    expect(res.migrationConflicts).toEqual([]);
    expect(readFileSync(examplePath(), 'utf8')).toBe(CURRENT_ENV_EXAMPLE);
    expect(readScaffoldVersion(root)).toBe('1.2.0');
  });

  it('refreshes the stale seed through the migration itself', () => {
    // Pins the migration's own wiring: the end-to-end upgrade could be
    // satisfied by the manifest's refresh path alone, which would leave this
    // migration untested and free to rot.
    seedStaleSeed();

    const res = runMigrations(root, '1.1.0', '1.2.0');

    expect(res.ran).toContain('1.1.0→1.2.0');
    expect(res.changed).toContain('.noir/.env.example');
    expect(res.conflicts).toEqual([]);
    expect(readFileSync(examplePath(), 'utf8')).toBe(CURRENT_ENV_EXAMPLE);
  });

  it('leaves a user-edited .env.example alone', () => {
    seedStaleSeed();
    const edited = `${ENV_EXAMPLE_1_1_0}\n# our own gateway token\n`;
    writeFileSync(examplePath(), edited, 'utf8');

    const res = runMigrations(root, '1.1.0', '1.2.0');

    expect(res.changed).not.toContain('.noir/.env.example');
    expect(readFileSync(examplePath(), 'utf8')).toBe(edited);
  });

  it('is idempotent — a second run over the refreshed bytes changes nothing', () => {
    seedStaleSeed();
    runMigrations(root, '1.1.0', '1.2.0');
    const once = readFileSync(examplePath(), 'utf8');

    const again = runMigrations(root, '1.1.0', '1.2.0');

    expect(again.changed).not.toContain('.noir/.env.example');
    expect(readFileSync(examplePath(), 'utf8')).toBe(once);
  });

  it('reports the refresh as planned under --dry-run and touches nothing', () => {
    seedStaleSeed();
    const before = readFileSync(examplePath(), 'utf8');

    const res = runMigrations(root, '1.1.0', '1.2.0', { dryRun: true });

    expect(res.changed).toContain('.noir/.env.example');
    expect(readFileSync(examplePath(), 'utf8')).toBe(before);
  });
});
