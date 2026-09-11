// .noir/.env loader (Slice E): a Node --env-file dialect parser + the
// precedence rule (spec 12.1 — a key the file DEFINES wins; the real
// environment is the fallback for keys the file omits). All offline; the
// parser test matrix is copied from Node's documented --env-file behavior so
// the dialect has an independent conformance oracle. The parser dialect is
// still Node's, and deliberately so; only the PRECEDENCE departs from it.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyNoirEnv, loadNoirEnv, parseEnvFile } from '../src/env-file.js';

// Build a `${NAME}` placeholder at runtime so the source never contains a
// literal `${` (the noTemplateCurlyInString lint would flag it).
const REF = (name: string): string => `${'$'}{${name}}`;

describe('parseEnvFile — Node --env-file dialect', () => {
  it('parses KEY=VALUE pairs, blank lines, and full-line comments', () => {
    const { vars, warnings } = parseEnvFile(
      ['# a comment', '', 'FOO=bar', '   ', 'BAZ=qux'].join('\n'),
    );
    expect(vars).toEqual({ FOO: 'bar', BAZ: 'qux' });
    expect(warnings).toEqual([]);
  });

  it('strips an optional export prefix', () => {
    expect(parseEnvFile('export TOKEN=pk_abc').vars).toEqual({ TOKEN: 'pk_abc' });
  });

  it('a trailing # in an unquoted value starts a comment (Node dialect)', () => {
    expect(parseEnvFile('PORT=3000 # the port').vars).toEqual({ PORT: '3000' });
    expect(parseEnvFile('KEY=a#b').vars).toEqual({ KEY: 'a' });
  });

  it('single/double quotes are stripped; whitespace and # inside quotes survive', () => {
    expect(parseEnvFile('A="two words"').vars).toEqual({ A: 'two words' });
    expect(parseEnvFile("B='has#hash'").vars).toEqual({ B: 'has#hash' });
  });

  it('a quoted value with a TRAILING # comment unquotes correctly (iter-5 fix)', () => {
    // The closing quote is the boundary — a `# …` after it is a comment, a `#`
    // inside the quotes is literal.
    expect(parseEnvFile('TOKEN="abc # not-a-comment" # real comment').vars).toEqual({
      TOKEN: 'abc # not-a-comment',
    });
    expect(parseEnvFile("K='v' # trailing").vars).toEqual({ K: 'v' });
  });

  it('EMPTY= yields an empty string; last definition wins', () => {
    const { vars } = parseEnvFile('EMPTY=\nK=one\nK=two');
    expect(vars).toEqual({ EMPTY: '', K: 'two' });
  });

  it('tolerates CRLF line endings', () => {
    expect(parseEnvFile('A=1\r\nB=2\r\n').vars).toEqual({ A: '1', B: '2' });
  });

  it('warns (with a line number) and skips malformed lines instead of crashing', () => {
    const { vars, warnings } = parseEnvFile(
      'GOOD=1\nno-equals-here\n1BAD=startswith-digit\nGOOD=2',
    );
    expect(vars).toEqual({ GOOD: '2' });
    expect(warnings.length).toBe(2);
    expect(warnings[0]).toContain(':2');
    expect(warnings[1]).toContain(':3');
  });

  it('does NOT interpolate dollar-brace refs or run command substitution (by design)', () => {
    expect(parseEnvFile(`A=${REF('OTHER')}\nB=$(whoami)`).vars).toEqual({
      A: REF('OTHER'),
      B: '$(whoami)',
    });
  });
});

describe('loadNoirEnv — precedence + missing file', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('a missing .noir/.env is a silent no-op (never an error)', () => {
    dir = mkdtempSync(join(tmpdir(), 'noir-env-missing-'));
    const { overlay, warnings } = loadNoirEnv(dir, {});
    expect(overlay).toEqual({});
    expect(warnings).toEqual([]);
  });

  it('a file key WINS over the ambient environment', () => {
    dir = mkdtempSync(join(tmpdir(), 'noir-env-wins-'));
    mkdirSync(join(dir, '.noir'), { recursive: true });
    writeFileSync(join(dir, '.noir', '.env'), 'CLICKUP_API_TOKEN=from_file\n');
    const env = { CLICKUP_API_TOKEN: 'from_env' };
    const { overlay, sources } = loadNoirEnv(dir, env);
    expect(overlay.CLICKUP_API_TOKEN).toBe('from_file');
    expect(sources.CLICKUP_API_TOKEN).toBe('file');
  });

  it('a key absent from the file still falls back to the environment', () => {
    dir = mkdtempSync(join(tmpdir(), 'noir-env-fallback-'));
    mkdirSync(join(dir, '.noir'), { recursive: true });
    writeFileSync(join(dir, '.noir', '.env'), 'A=file\n');
    const env = { B: 'from_env' };
    expect(loadNoirEnv(dir, env).sources.B).toBe('env');
  });

  it('an ambient value is NOT in the overlay once the file defines the key', () => {
    // The inversion, stated as the observable difference: pre-12.1 this
    // overlay was `{ NEW: 'from-file' }` — the file lost.
    dir = mkdtempSync(join(tmpdir(), 'noir-env-precedence-'));
    mkdirSync(join(dir, '.noir'), { recursive: true });
    writeFileSync(join(dir, '.noir', '.env'), 'ALREADY=file\nNEW=from-file\n', 'utf8');
    const { overlay, sources } = loadNoirEnv(dir, { ALREADY: 'shell', OTHER: 'x' });
    expect(overlay).toEqual({ ALREADY: 'file', NEW: 'from-file' });
    // Provenance: both file keys are 'file'; the ambient-only key is 'env'.
    expect(sources).toEqual({ ALREADY: 'file', NEW: 'file', OTHER: 'env' });
  });

  it('confines the overlay to the object it is given', () => {
    dir = mkdtempSync(join(tmpdir(), 'noir-env-confine-'));
    mkdirSync(join(dir, '.noir'), { recursive: true });
    writeFileSync(join(dir, '.noir', '.env'), 'CLI_ENV_CONFINE_TEST=file\n', 'utf8');
    const env: Record<string, string | undefined> = {};
    applyNoirEnv(dir, env);
    expect(env.CLI_ENV_CONFINE_TEST).toBe('file');
    expect(process.env.CLI_ENV_CONFINE_TEST).toBeUndefined(); // never leaks to the real process env
    expect(loadNoirEnv(dir, {}).sources.CLI_ENV_CONFINE_TEST).toBe('file');
  });

  it('warns once per shadowed key — naming the KEY, never a value', () => {
    dir = mkdtempSync(join(tmpdir(), 'noir-env-shadow-'));
    mkdirSync(join(dir, '.noir'), { recursive: true });
    writeFileSync(
      join(dir, '.noir', '.env'),
      'SHADOWED_ONE=file_one\nSHADOWED_TWO=file_two\nSAME_VALUE=identical\n',
      'utf8',
    );
    chmodSync(join(dir, '.noir', '.env'), 0o600); // no permission advisory noise
    const written: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        written.push(String(chunk));
        return true;
      });
    try {
      const env: Record<string, string | undefined> = {
        SHADOWED_ONE: 'env_one',
        SHADOWED_TWO: 'env_two',
        SAME_VALUE: 'identical',
      };
      applyNoirEnv(dir, env);
    } finally {
      spy.mockRestore();
    }
    const stderr = written.join('');
    // Both differing keys warned; the key whose value already matched did not.
    expect(stderr).toContain('SHADOWED_ONE');
    expect(stderr).toContain('SHADOWED_TWO');
    expect(stderr).not.toContain('SAME_VALUE');
    // POSIX-only: on win32 `chmod` is a no-op (permissions are ACL-based and the
    // mode is dropped), so the 0o600 above never takes effect and the loader's
    // group/world-readable advisory adds a third line. The shadowing count right
    // below is asserted identically on every platform.
    if (process.platform !== 'win32') expect(written.length).toBe(2);
    expect(written.filter((l) => l.includes('overrides the environment value'))).toHaveLength(2);
    // The invariant: a warning names the key only — no value from either side.
    for (const value of ['env_one', 'env_two', 'file_one', 'file_two']) {
      expect(stderr).not.toContain(value);
    }
  });

  it('reads the file under .noir/.env in the given root', () => {
    dir = mkdtempSync(join(tmpdir(), 'noir-env-read-'));
    mkdirSync(join(dir, '.noir'), { recursive: true });
    writeFileSync(join(dir, '.noir', '.env'), 'CLICKUP_API_TOKEN=pk_fake\n', 'utf8');
    const { overlay } = loadNoirEnv(dir, {});
    expect(overlay).toEqual({ CLICKUP_API_TOKEN: 'pk_fake' });
  });

  it('refuses process-injection keys (exact names AND npm_/COREPACK_ descendants) with a warning', () => {
    dir = mkdtempSync(join(tmpdir(), 'noir-env-deny-'));
    mkdirSync(join(dir, '.noir'), { recursive: true });
    writeFileSync(
      join(dir, '.noir', '.env'),
      [
        'NODE_OPTIONS=--require=/tmp/evil.js',
        'LD_PRELOAD=/tmp/evil.so',
        'npm_config_registry=https://evil.example/',
        'npm_loglevel=debug',
        'COREPACK_NPM_REGISTRY=https://evil.example/',
        'NOIR_SYSTEM_NODE_BIN=./evil',
        'NOIR_WORKSPACES_DIR=/tmp/evil-workspaces',
        'CLICKUP_API_TOKEN=pk_fake',
      ].join('\n'),
      'utf8',
    );
    // 0600 so the only warnings are the deny-list refusals (no permission advisory).
    chmodSync(join(dir, '.noir', '.env'), 0o600);
    const { overlay, warnings } = loadNoirEnv(dir, {});
    // All seven injection keys are refused + warned; the benign token var passes.
    expect(overlay).toEqual({ CLICKUP_API_TOKEN: 'pk_fake' });
    expect(warnings.length).toBe(7);
    expect(warnings.join('\n')).toMatch(/NODE_OPTIONS/);
    expect(warnings.join('\n')).toMatch(/LD_PRELOAD/);
    expect(warnings.join('\n')).toMatch(/npm_config_registry/);
    expect(warnings.join('\n')).toMatch(/COREPACK_NPM_REGISTRY/);
    expect(warnings.join('\n')).toMatch(/NOIR_SYSTEM_NODE_BIN/);
    expect(warnings.join('\n')).toMatch(/NOIR_WORKSPACES_DIR/);
  });

  it('refuses NOIR_DAEMON_DIR from .noir/.env', () => {
    dir = mkdtempSync(join(tmpdir(), 'noir-env-daemon-dir-'));
    mkdirSync(join(dir, '.noir'), { recursive: true });
    writeFileSync(join(dir, '.noir', '.env'), 'NOIR_DAEMON_DIR=/tmp/evil\n');
    chmodSync(join(dir, '.noir', '.env'), 0o600);
    const { overlay, warnings } = loadNoirEnv(dir, {});
    expect(overlay.NOIR_DAEMON_DIR).toBeUndefined();
    expect(warnings.join()).toMatch(/process-injection/);
  });
});
