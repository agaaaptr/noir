// SP-A — `noir doctor` nested-`.noir` detection (TDD). Fast unit tests of the
// check function in isolation (no subprocess).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type CheckResult, checkNestedNoir } from '../src/commands/doctor.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'noir-nested-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('checkNestedNoir (SP-A)', () => {
  it('reports ok + detected=false on a clean project', () => {
    const checks: CheckResult[] = [];
    const res = checkNestedNoir(checks, tmp);
    expect(res.detected).toBe(false);
    expect(res.paths).toEqual([]);
    expect(checks[0]?.status).toBe('ok');
  });

  it('detects a nested .noir/.noir/ directory (the bug fingerprint)', () => {
    mkdirSync(join(tmp, '.noir', '.noir'), { recursive: true });
    const checks: CheckResult[] = [];
    const res = checkNestedNoir(checks, tmp);
    expect(res.detected).toBe(true);
    expect(res.paths).toContain('.noir/.noir');
    expect(checks[0]?.status).toBe('warn');
    expect(checks[0]?.detail).toMatch(/nested/i);
  });

  it('detects nested host artifacts emitted into .noir/ (CLAUDE.md, .mcp.json, .claude)', () => {
    mkdirSync(join(tmp, '.noir', '.claude', 'skills'), { recursive: true });
    writeFileSync(join(tmp, '.noir', 'CLAUDE.md'), 'dup');
    writeFileSync(join(tmp, '.noir', '.mcp.json'), '{}');
    const checks: CheckResult[] = [];
    const res = checkNestedNoir(checks, tmp);
    expect(res.detected).toBe(true);
    expect(res.paths).toHaveLength(3);
    expect(res.paths).toEqual(
      expect.arrayContaining(['.noir/CLAUDE.md', '.noir/.mcp.json', '.noir/.claude']),
    );
  });
});
