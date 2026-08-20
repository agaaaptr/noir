// .noir/.env loader (Slice E): a Node --env-file dialect parser + the
// precedence rule (real environment always wins; the file fills only unset
// keys). All offline; the parser test matrix is copied from Node's documented
// --env-file behavior so the dialect has an independent conformance oracle.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadNoirEnv, parseEnvFile } from '../src/env-file.js';

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

  it('fills only keys that are unset in the real environment (real env wins)', () => {
    dir = mkdtempSync(join(tmpdir(), 'noir-env-precedence-'));
    mkdirSync(join(dir, '.noir'), { recursive: true });
    writeFileSync(join(dir, '.noir', '.env'), 'ALREADY=file\nNEW=from-file\n', 'utf8');
    const { overlay } = loadNoirEnv(dir, { ALREADY: 'shell', OTHER: 'x' });
    expect(overlay).toEqual({ NEW: 'from-file' });
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
        'CLICKUP_API_TOKEN=pk_fake',
      ].join('\n'),
      'utf8',
    );
    // 0600 so the only warnings are the deny-list refusals (no permission advisory).
    chmodSync(join(dir, '.noir', '.env'), 0o600);
    const { overlay, warnings } = loadNoirEnv(dir, {});
    // All six injection keys are refused + warned; the benign token var passes.
    expect(overlay).toEqual({ CLICKUP_API_TOKEN: 'pk_fake' });
    expect(warnings.length).toBe(6);
    expect(warnings.join('\n')).toMatch(/NODE_OPTIONS/);
    expect(warnings.join('\n')).toMatch(/LD_PRELOAD/);
    expect(warnings.join('\n')).toMatch(/npm_config_registry/);
    expect(warnings.join('\n')).toMatch(/COREPACK_NPM_REGISTRY/);
    expect(warnings.join('\n')).toMatch(/NOIR_SYSTEM_NODE_BIN/);
  });
});
