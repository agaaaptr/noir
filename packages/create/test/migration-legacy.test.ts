// The migration gate for stamp-less legacy projects.
//
// A project initialized before the scaffold-version stamp existed carries a
// valid `.noir/project.id` but no `.noir/scaffold-version`. For a long time the
// upgrade gate keyed off the stamp alone, so such a project skipped every
// migration and was then stamped current — permanently locked out of the one
// mechanism that can transform existing files. The gate now keys off identity:
// a valid project.id counts, and a `null` stamp is handed to the runner, which
// treats it as `0.0.0` and runs the full registered chain.
//
// Offline/free: no network, no API key, no embedder.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ENV_POINTER_MARKER } from '../src/migrations/index.js';
import { scaffold } from '../src/scaffold.js';
import { CURRENT_SCAFFOLD_VERSION, readScaffoldVersion } from '../src/scaffold-version.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-mig-legacy-'));
  // Pin the MCP command so the emitted `.mcp.json` is machine-independent.
  process.env.NOIR_MCP_COMMAND = 'noir';
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const projectIdPath = (): string => join(root, '.noir', 'project.id');
const configPath = (): string => join(root, '.noir', 'config.yml');
const configBody = (): string => readFileSync(configPath(), 'utf8');

/** A pre-stamp legacy project: a valid project.id + config.yml, but no
 *  scaffold-version stamp. The config deliberately lacks the env-pointer
 *  marker so the real migration has work to do. */
function seedLegacyProject(config = 'host: claude\nmode: full\n'): void {
  mkdirSync(join(root, '.noir'), { recursive: true });
  writeFileSync(projectIdPath(), '9f1c0b7e-0000-4000-8000-000000000000\n', 'utf8');
  writeFileSync(configPath(), config, 'utf8');
}

const upgrade = (): ReturnType<typeof scaffold> =>
  scaffold({ root, mode: 'init', host: 'claude', upgrade: true });

describe('upgrade — a stamp-less legacy project runs the full migration chain', () => {
  it('runs the real migration and appends the env-pointer block to config.yml', async () => {
    seedLegacyProject();

    const res = await upgrade();

    // The runner treats the absent stamp as `0.0.0`, so the whole chain ran.
    expect(res.fromVersion).toBeNull();
    expect(res.migrationsRan).toEqual(['1.0.0→1.0.0', '1.0.0→1.1.0']);
    expect(res.migrationConflicts).toEqual([]);

    // The real migration appended the pointer; user content is preserved.
    const after = configBody();
    expect(after).toContain(ENV_POINTER_MARKER);
    expect(after).toMatch(/\.noir\/\.env/);
    expect(after).toContain('host: claude');
    expect(after).toContain('mode: full');
  });

  it('restamps the project to CURRENT afterwards', async () => {
    seedLegacyProject();

    await upgrade();

    expect(readScaffoldVersion(root)).toBe(CURRENT_SCAFFOLD_VERSION);
  });

  it('a fresh/empty tree still runs no migrations on --upgrade', async () => {
    // No project.id AND no stamp: there is no identity to migrate from.
    const res = await upgrade();

    expect(res.fromVersion).toBeNull();
    expect(res.migrationsRan).toEqual([]);
    expect(res.migrationConflicts).toEqual([]);
  });
});
