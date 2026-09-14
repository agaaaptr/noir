// `noir init` seeds two `.noir/.env` files, and this suite pins the contract
// between them.
//
// `.noir/.env` is the working configuration-and-secrets file: created at 0600,
// gitignored, and all-comment so it parses to an EMPTY overlay — creating it
// changes no behaviour (asserted through the real `loadNoirEnv`, not by
// eyeballing the template). `.noir/.env.example` is the committable reference:
// it explains what `.env` is for, the precedence order, what to commit, and
// every variable — but never carries a real (or fake) secret.
//
// The two files are deliberately DIFFERENT. `.env` is a short, copy-paste-ready
// starter the user uncomments; `.env.example` is the long-form documentation
// that stays in git. They must not share a verbatim block, and neither may
// smuggle in an active value or a fake `sk-`-shaped key.
//
// Offline/free: no network, no API key, no embedder.
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

describe('noir init — .noir/.env seed', () => {
  it('creates .noir/.env and reports it as written', async () => {
    const res = await scaffold({ root, mode: 'init', host: 'claude' });
    expect(res.written).toContain('.noir/.env');
    expect(existsSync(envPath())).toBe(true);
  });

  it('is a short starter: at most 60 lines and more than 200 bytes', async () => {
    await scaffold({ root, mode: 'init', host: 'claude' });
    const text = readFileSync(envPath(), 'utf8');
    // Trim the trailing newline before counting so a file that ends in `\n`
    // is counted by its content lines, not the empty split element.
    expect(text.trimEnd().split('\n').length).toBeLessThanOrEqual(60);
    expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(200);
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

  it('is all-comment with no active assignment and no fake key shape', async () => {
    await scaffold({ root, mode: 'init', host: 'claude' });
    const text = readFileSync(envPath(), 'utf8');
    expect(activeLines(text)).toEqual([]);
    expect(text).not.toMatch(/^[A-Za-z_][A-Za-z0-9_]*=/m);
    // Placeholders must read as instructions, never as a plausible secret.
    expect(text).not.toMatch(/sk-/);
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

describe('noir init — .noir/.env.example reference', () => {
  it('is all-comment with no active assignment and no fake key shape', async () => {
    await scaffold({ root, mode: 'init', host: 'claude' });
    const t = readFileSync(examplePath(), 'utf8');
    expect(activeLines(t)).toEqual([]);
    expect(t).not.toMatch(/^[A-Za-z_][A-Za-z0-9_]*=/m);
    expect(t).not.toMatch(/sk-/);
  });

  it('opens with the purpose header and the precedence ladder, and links the full reference', async () => {
    await scaffold({ root, mode: 'init', host: 'claude' });
    const t = readFileSync(examplePath(), 'utf8');
    expect(t).toMatch(/What \.noir\/\.env is for/);
    expect(t).toMatch(/Precedence \(highest wins\)/);
    expect(t).toMatch(/run\.profiles\.<n>\.env/);
    expect(t).toMatch(/never commit the real file/i);
    expect(t).toMatch(/docs\/reference\/environment\.md/);
  });

  it('names all nine documented variables', async () => {
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
  });

  it('documents the host-gateway trio: base URL, auth token, and a default model', async () => {
    await scaffold({ root, mode: 'init', host: 'claude' });
    const t = readFileSync(examplePath(), 'utf8');
    expect(t).toContain('ANTHROPIC_BASE_URL');
    expect(t).toContain('ANTHROPIC_AUTH_TOKEN');
    expect(t).toMatch(/ANTHROPIC_DEFAULT_(HAIKU|SONNET|OPUS)_MODEL/);
    // The auth-token header semantics: AUTH_TOKEN -> Authorization: Bearer,
    // while ANTHROPIC_API_KEY -> x-api-key; setting both is a conflict.
    expect(t).toMatch(/Authorization: Bearer/);
    expect(t).toMatch(/Do not set BOTH/);
  });

  it('states the apiKeyEnv rule: a NAME, never an interpolation', async () => {
    await scaffold({ root, mode: 'init', host: 'claude' });
    const t = readFileSync(examplePath(), 'utf8');
    expect(t).toMatch(/`apiKeyEnv` is a NAME, not an interpolation/);
    expect(t).not.toMatch(/apiKeyEnv:\s*\$\{/);
    // The ClickUp non-variable is called out as a config.yml key, not an env var.
    expect(t).toMatch(/CLICKUP_TEAM_ID is NOT an env var/);
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
