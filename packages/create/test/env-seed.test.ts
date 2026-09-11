// Slice E / Task 8 — `noir init` seeds a REAL `.noir/.env` (0600, all-comment)
// and `.noir/.env.example` carries the doctrine + the full documented variable
// set. Offline/free: no network, no API key, no embedder.
//
// Why both files exist (§8.1): the example is the committable documentation of
// the format; `.env` is the working file, created so the user never has to copy
// the example by hand. `.env` is all-comment, so it parses to an EMPTY overlay
// and creating it changes no behaviour — asserted via the real loader
// (`loadNoirEnv`), not by eyeballing the template.
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadNoirEnv } from '@noir-ai/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scaffold } from '../src/scaffold.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-env-seed-'));
  // Pin the MCP command so this suite is deterministic across machines (a
  // native install's absolute shim path would otherwise bleed into .mcp.json).
  process.env.NOIR_MCP_COMMAND = 'noir';
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 0600 is a POSIX permission. Windows permissions are ACL-based and the mode
 *  is dropped there, so every mode assertion is skipped on win32 rather than
 *  asserting something the platform cannot express. */
const posixIt = it.skipIf(process.platform === 'win32');

const envPath = (): string => join(root, '.noir', '.env');
const examplePath = (): string => join(root, '.noir', '.env.example');

/** Every non-blank line of a dotenv-style file, paired with its 1-based number. */
function activeLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l, i) => `${i + 1}:${l}`)
    .filter((l) => l.slice(l.indexOf(':') + 1).trim().length > 0)
    .filter(
      (l) =>
        !l
          .slice(l.indexOf(':') + 1)
          .trimStart()
          .startsWith('#'),
    );
}

describe('noir init — .noir/.env seed (slice E, §8.1)', () => {
  it('creates .noir/.env and reports it as written', async () => {
    const res = await scaffold({ root, mode: 'init', host: 'claude' });
    expect(res.written).toContain('.noir/.env');
    expect(existsSync(envPath())).toBe(true);
    // Not a zero-byte stub — it carries the doctrine + the commented set.
    expect(readFileSync(envPath(), 'utf8').length).toBeGreaterThan(200);
  });

  posixIt('creates .noir/.env at 0600', async () => {
    await scaffold({ root, mode: 'init', host: 'claude' });
    const mode = statSync(envPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('parses to an empty overlay — no active value was written', async () => {
    await scaffold({ root, mode: 'init', host: 'claude' });
    expect(loadNoirEnv(root).overlay).toEqual({});
  });

  posixIt('emits no loader warning — no malformed line, no permission advisory', async () => {
    // POSIX-only: `loadNoirEnv` pushes a group/world-readable advisory whenever
    // `mode & 0o077 !== 0`, and Windows drops the requested mode (ACL-based
    // permissions), so the advisory would fire there for a file that is in fact
    // private. Exact equality, so BOTH a silently-skipped malformed line (a
    // rejected key, an unterminated quote) and a lax permission fail this.
    await scaffold({ root, mode: 'init', host: 'claude' });
    expect(loadNoirEnv(root).warnings).toEqual([]);
  });

  it('is all-comment — not one line is an active assignment', async () => {
    await scaffold({ root, mode: 'init', host: 'claude' });
    const text = readFileSync(envPath(), 'utf8');
    expect(activeLines(text)).toEqual([]);
    expect(text).not.toMatch(/^[A-Za-z_][A-Za-z0-9_]*=/m);
    // Specifically: the model key is shown as a NAME, never as a live value.
    expect(text).not.toMatch(/^ANTHROPIC_API_KEY=/m);
  });

  it('documents the precedence doctrine (spec §12.1) in .noir/.env', async () => {
    await scaffold({ root, mode: 'init', host: 'claude' });
    const t = readFileSync(envPath(), 'utf8');
    expect(t).toMatch(/recommended home for project-scoped/);
    expect(t).toMatch(/A real environment variable is a FALLBACK/);
    expect(t).toMatch(/never commit it\./i);
    expect(t).toMatch(/docs\/reference\/environment\.md/);
  });

  it('never overwrites an existing .noir/.env (or its mode) — skipIfExists', async () => {
    await scaffold({ root, mode: 'init', host: 'claude' });
    const edited = '# user-edited\nCLICKUP_API_TOKEN=pk_user_value\n';
    writeFileSync(envPath(), edited, 'utf8');
    chmodSync(envPath(), 0o640); // the user's own choice — must stand

    const res = await scaffold({ root, mode: 'init', host: 'claude', force: true });
    expect(res.written).not.toContain('.noir/.env');
    expect(res.skipped).toContain('.noir/.env');
    expect(readFileSync(envPath(), 'utf8')).toBe(edited);
    // fileMode is a CREATION-only contract: an existing file is not even opened.
    if (process.platform !== 'win32') expect(statSync(envPath()).mode & 0o777).toBe(0o640);
  });

  it('reports the planned 0600 without writing anything under --dry-run', async () => {
    const res = await scaffold({ root, mode: 'init', host: 'claude', dryRun: true });
    expect(res.written).toContain('.noir/.env');
    expect(res.fileModes?.['.noir/.env']).toBe(0o600);
    expect(existsSync(envPath())).toBe(false);
    // Only the declared-mode entry is reported; the field is opt-in.
    expect(Object.keys(res.fileModes ?? {})).toEqual(['.noir/.env']);
  });
});

describe('noir init — .noir/.env.example doctrine + full variable set (spec §8)', () => {
  it('documents the doctrine and the full variable set', async () => {
    await scaffold({ root, mode: 'init', host: 'claude' });
    const t = readFileSync(examplePath(), 'utf8');
    expect(t).toMatch(/recommended home for project-scoped/);
    expect(t).toMatch(/CLICKUP_API_TOKEN/);
    expect(t).toMatch(/OPENAI_API_KEY/);
    expect(t).toMatch(/NOIR_PROFILE/);
    expect(t).toMatch(/apiKeyEnv/); // the NAME-not-interpolation note
    expect(t).not.toMatch(/^ANTHROPIC_API_KEY=/m); // never an active value
  });

  it('covers every documented variable group, all commented out', async () => {
    await scaffold({ root, mode: 'init', host: 'claude' });
    const t = readFileSync(examplePath(), 'utf8');
    for (const name of [
      'CLICKUP_API_TOKEN',
      'OPENAI_API_KEY',
      'VOYAGE_API_KEY',
      'COHERE_API_KEY',
      'OLLAMA_BASE_URL',
      'ANTHROPIC_API_KEY',
      'NOIR_PROFILE',
      'NOIR_DISABLE_UPDATE_CHECK',
      'NOIR_DISABLE_UPDATES',
    ]) {
      expect(t, name).toContain(name);
    }
    // The ClickUp non-variable is called out as a config.yml key, not an env var.
    expect(t).toMatch(/CLICKUP_TEAM_ID is NOT an env var/);
    // `apiKeyEnv` is a NAME, not `${...}` interpolation — state it, never write
    // an interpolated form that would silently resolve to undefined.
    expect(t).toMatch(/`apiKeyEnv` is a NAME, not an interpolation/);
    expect(t).not.toMatch(/apiKeyEnv:\s*\$\{/);
    // Provider-explicit: no provider ⇒ templates, never a silent paid call.
    expect(t).toMatch(/never makes a silent/);
    // Closing pointer to the single complete reference.
    expect(t).toMatch(/docs\/reference\/environment\.md/);
    // Still documentation-only: not one active assignment.
    expect(activeLines(t)).toEqual([]);
  });

  it('carries the same doctrine as the real env file (one body, two files)', async () => {
    await scaffold({ root, mode: 'init', host: 'claude' });
    const example = readFileSync(examplePath(), 'utf8');
    const real = readFileSync(envPath(), 'utf8');
    // The doctrine block is shared verbatim.
    const doctrine = [
      '# This file is the recommended home for project-scoped configuration and',
      '# secrets. Precedence:',
      '#   1. run profile env     run.profiles.<n>.env      (per-invocation; merges OVER)',
      '#   2. .noir/.env          <- recommended home for project-scoped configuration',
      '#   3. real environment    CI / container / launchd / shell rc',
      '#   4. built-in default',
    ].join('\n');
    expect(real).toContain(doctrine);
    expect(example).toContain(doctrine);
  });

  it('never overwrites an existing .env.example — skipIfExists', async () => {
    await scaffold({ root, mode: 'init', host: 'claude' });
    const edited = '# my own notes\n';
    writeFileSync(examplePath(), edited, 'utf8');
    const res = await scaffold({ root, mode: 'init', host: 'claude', force: true });
    expect(res.written).not.toContain('.noir/.env.example');
    expect(readFileSync(examplePath(), 'utf8')).toBe(edited);
  });
});
