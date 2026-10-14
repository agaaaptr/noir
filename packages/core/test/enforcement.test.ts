import { describe, expect, it } from 'vitest';
import { type DenyRule, evaluateDeny } from '../src/enforcement.js';

describe('evaluateDeny', () => {
  it('denies a Write to the .noir/.env secrets file', () => {
    const out = evaluateDeny([], 'Write', { file_path: '.noir/.env', content: 'X=1' });
    expect(out?.denied).toBe(true);
  });

  it('does not deny a Write to .noir/.env.example', () => {
    const out = evaluateDeny([], 'Write', { file_path: '.noir/.env.example' });
    expect(out).toBeNull();
  });

  it('denies an Edit under .noir/store/ (single-writer invariant)', () => {
    const out = evaluateDeny([], 'Edit', {
      file_path: '.noir/store/db.sqlite',
      old_string: 'a',
      new_string: 'b',
    });
    expect(out?.denied).toBe(true);
  });

  it('matches an absolute spelling of a protected path', () => {
    const out = evaluateDeny([], 'Write', { file_path: '/repo/.noir/.env' });
    expect(out?.denied).toBe(true);
  });

  it('allows a normal source write', () => {
    expect(evaluateDeny([], 'Write', { file_path: 'src/index.ts' })).toBeNull();
  });

  it('applies a config rule to a Bash command with its reason', () => {
    const rules: DenyRule[] = [{ pattern: 'rm -rf', reason: 'no recursive deletes' }];
    const out = evaluateDeny(rules, 'Bash', { command: 'rm -rf dist' });
    expect(out).toEqual({ denied: true, reason: 'no recursive deletes' });
  });

  it('scopes a rule to one tool name', () => {
    const rules: DenyRule[] = [{ tool: 'Bash', pattern: 'secret', reason: 'no' }];
    expect(evaluateDeny(rules, 'Write', { file_path: 'secret.txt' })).toBeNull();
    expect(evaluateDeny(rules, 'Bash', { command: 'echo secret' })?.denied).toBe(true);
  });

  it('never throws on an unfamiliar tool input', () => {
    expect(evaluateDeny([], 'Read', { file_path: 'README.md' })).toBeNull();
    expect(evaluateDeny([], 'SomeTool', null)).toBeNull();
    expect(evaluateDeny([], 'SomeTool', 42)).toBeNull();
  });

  it('normalizes . and duplicate separators before matching', () => {
    expect(evaluateDeny([], 'Write', { file_path: '.noir/./.env' })?.denied).toBe(true);
    expect(evaluateDeny([], 'Write', { file_path: '.noir//.env' })?.denied).toBe(true);
    expect(evaluateDeny([], 'Edit', { file_path: '.noir/./store/db.sqlite' })?.denied).toBe(true);
  });

  it('denies a Bash command that touches a protected path', () => {
    expect(evaluateDeny([], 'Bash', { command: 'cat .noir/.env' })?.denied).toBe(true);
    expect(evaluateDeny([], 'Bash', { command: 'rm -rf .noir/store' })?.denied).toBe(true);
    expect(evaluateDeny([], 'Bash', { command: 'echo x > .noir/.env' })?.denied).toBe(true);
    expect(evaluateDeny([], 'Bash', { command: 'cat .noir/./.env' })?.denied).toBe(true);
    expect(evaluateDeny([], 'Bash', { command: 'rm -rf .noir//store' })?.denied).toBe(true);
  });

  it('does not deny a Bash command that names a sibling path', () => {
    expect(evaluateDeny([], 'Bash', { command: 'cat .noir/.env.example' })).toBeNull();
    expect(evaluateDeny([], 'Bash', { command: 'pnpm test' })).toBeNull();
  });
});
