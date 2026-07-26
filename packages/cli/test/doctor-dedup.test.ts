// SP-C deferred — `noir doctor --dedup` semantic dedup (TDD). The embedder is
// INJECTED (a deterministic one-hot fake) so candidate-collection + reporting
// are tested without loading the real MiniLM/onnx embedder.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectInfo } from '@noir-ai/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type CheckResult,
  checkSemanticDupDoctor,
  collectDedupCandidates,
} from '../src/commands/doctor.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'noir-dedup-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const project = { config: { context: {} } } as unknown as ProjectInfo;

// One-hot by text length: identical text → identical vector ⇒ cosine 1.0;
// different lengths ⇒ orthogonal (cosine ~0). Deterministic, no onnx.
const fakeEmbed = async (text: string): Promise<Float32Array> => {
  const v = new Float32Array(384);
  v[text.length % 384] = 1;
  return v;
};

describe('collectDedupCandidates', () => {
  it('collects existing host-context files + RULES.md; skips missing + whitespace-only', () => {
    writeFileSync(join(tmp, 'CLAUDE.md'), 'alpha');
    writeFileSync(join(tmp, 'AGENTS.md'), 'alpha');
    mkdirSync(join(tmp, '.noir', 'rules'), { recursive: true });
    writeFileSync(join(tmp, '.noir', 'rules', 'RULES.md'), 'rules');
    writeFileSync(join(tmp, 'GEMINI.md'), '   '); // whitespace → skipped
    const c = collectDedupCandidates(tmp);
    expect(c.map((x) => x.path).sort()).toEqual(['.noir/rules/RULES.md', 'AGENTS.md', 'CLAUDE.md']);
  });
});

describe('checkSemanticDupDoctor (--dedup)', () => {
  it('warns on a near-duplicate pair (identical host-context files)', async () => {
    writeFileSync(join(tmp, 'CLAUDE.md'), 'same content'); // identical ⇒ cosine 1.0
    writeFileSync(join(tmp, 'AGENTS.md'), 'same content');
    const checks: CheckResult[] = [];
    await checkSemanticDupDoctor(checks, tmp, project, { embed: fakeEmbed });
    const row = checks[checks.length - 1];
    expect(row?.name).toBe('semantic dup');
    expect(row?.status).toBe('warn');
    expect(row?.detail).toMatch(/AGENTS.md≈CLAUDE.md/);
  });

  it('ok when candidates are dissimilar (different lengths ⇒ orthogonal)', async () => {
    writeFileSync(join(tmp, 'CLAUDE.md'), 'project alpha notes'); // len 19
    writeFileSync(join(tmp, 'AGENTS.md'), 'entirely separate beta roadmap content'); // len 36
    const checks: CheckResult[] = [];
    await checkSemanticDupDoctor(checks, tmp, project, { embed: fakeEmbed });
    expect(checks[checks.length - 1]?.status).toBe('ok');
  });

  it('ok "nothing to compare" when fewer than 2 candidates', async () => {
    writeFileSync(join(tmp, 'CLAUDE.md'), 'only one file');
    const checks: CheckResult[] = [];
    await checkSemanticDupDoctor(checks, tmp, project, { embed: fakeEmbed });
    expect(checks[checks.length - 1]?.detail).toMatch(/nothing to compare/);
  });

  it('skips when not initialized (no project)', async () => {
    const checks: CheckResult[] = [];
    await checkSemanticDupDoctor(checks, tmp, undefined, { embed: fakeEmbed });
    expect(checks[checks.length - 1]?.detail).toMatch(/not initialized/);
  });
});
