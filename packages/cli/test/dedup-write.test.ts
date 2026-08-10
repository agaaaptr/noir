// Write-path semantic dedup + CLI-wiring tests.
//
// Two surfaces:
//   1. `checkWritePathDedup` (the hook) — direct unit tests with hand-crafted
//      ScaffoldResults + injected fake embedders (no onnx). Covers the two-tier
//      threshold, the content-hash cache gate, graceful-degrade when the
//      embedder throws, the fresh-project fast path, and the conflict
//      connect (conflicts[] record with similarity).
//   2. `init`/`sync` TASK 1 wiring — pre-populate a skill target with a
//      differing file, then assert the clack resolver fires under interactive
//      and is bypassed under --no-input.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScaffoldResult } from '@noir-ai/create';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkWritePathDedup, type EmbedLike } from '../src/dedup-write.js';

// ---------------------------------------------------------------------------
// @clack/prompts mock — `select` returns a per-test value; `isCancel` recognises
// the CANCEL sentinel. Hoisted so the factory closure can reference it.
// ---------------------------------------------------------------------------
const { clackMock } = vi.hoisted(() => {
  const CANCEL = Symbol('cancel');
  return {
    clackMock: {
      // `select` returns a per-test value (default 'preserve'); widened to
      // `string` so individual tests can mockResolvedValueOnce('skip' / 'replace').
      // The `_arg: unknown` lets assertions reach `mock.calls[0]?.[0]`.
      select: vi.fn(async (_arg: unknown): Promise<string> => Promise.resolve('preserve')),
      isCancel: vi.fn((v: unknown) => v === CANCEL),
    },
  };
});
vi.mock('@clack/prompts', () => clackMock);

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'noir-b3-'));
  clackMock.select.mockClear();
  clackMock.isCancel.mockClear();
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Build a minimal ScaffoldResult — the hook reads only `written` and pushes to
 *  `conflicts`, so the rest is zero-filled. Aliased as `res(...)` at the bottom. */
function fakeRes(written: string[]): ScaffoldResult {
  return {
    written,
    skipped: [],
    identical: [],
    noop: false,
    migrationsRan: [],
    migrationConflicts: [],
    stack: {} as unknown as ScaffoldResult['stack'],
    projectId: 'test',
    fromVersion: null,
    toVersion: '1.3.0-beta.7',
    host: 'claude',
    conflicts: [],
  } as ScaffoldResult;
}

/** Fake embedder that maps the literal texts 'A' and 'B' to vectors whose
 *  cosine is exactly `sim`. Anything else → zero vector. Both vectors are
 *  pre-normalized so l2normalize is idempotent and cosine = dot product. */
function fakeEmbedAtSim(sim: number): EmbedLike {
  const s = Math.sqrt(Math.max(0, 1 - sim * sim));
  const map: Record<string, number[]> = { A: [1, 0], B: [sim, s] };
  return async (text: string) => Float32Array.from(map[text] ?? [0, 0, 0]);
}

/** Identical-content fake: same text → same one-hot vector → cosine 1.0. */
function fakeEmbedIdentical(): EmbedLike {
  return async (text: string) => {
    const v = new Float32Array(384);
    v[text.length % 384] = 1;
    return v;
  };
}

// ---------------------------------------------------------------------------
// 1. Two-tier threshold.
// ---------------------------------------------------------------------------
describe('checkWritePathDedup — two-tier threshold', () => {
  it('≥ 0.95: under --no-input records the near-dup AND proceeds with Create anyway', async () => {
    // CLAUDE.md is the file we just "wrote"; AGENTS.md is the existing near-dup.
    writeFileSync(join(tmp, 'CLAUDE.md'), 'A', 'utf8');
    writeFileSync(join(tmp, 'AGENTS.md'), 'A', 'utf8'); // identical ⇒ cosine 1.0
    const res = fakeRes(['CLAUDE.md']);

    const result = await checkWritePathDedup(tmp, res, {
      interactive: false,
      embed: fakeEmbedIdentical(),
    });

    expect(result.found).toHaveLength(1);
    expect(result.found[0]?.proposedRel).toBe('CLAUDE.md');
    expect(result.found[0]?.matchedRel).toBe('AGENTS.md');
    expect(result.found[0]?.similarity).toBeGreaterThanOrEqual(0.95);
    // Create anyway default: the proposed file is still on disk.
    expect(existsSync(join(tmp, 'CLAUDE.md'))).toBe(true);
    // @clack never prompted under --no-input.
    expect(clackMock.select).not.toHaveBeenCalled();
  });

  it('≥ 0.95: under interactive, the ACTION prompt fires (Replace/Skip/Mirror/Create)', async () => {
    writeFileSync(join(tmp, 'CLAUDE.md'), 'A', 'utf8');
    writeFileSync(join(tmp, 'AGENTS.md'), 'A', 'utf8');
    const res = fakeRes(['CLAUDE.md']);

    await checkWritePathDedup(tmp, res, { interactive: true, embed: fakeEmbedIdentical() });

    expect(clackMock.select).toHaveBeenCalledTimes(1);
    const call = clackMock.select.mock.calls[0]?.[0] as unknown as {
      options: Array<{ value: string }>;
    };
    const values = call.options.map((o) => o.value).sort();
    expect(values).toEqual(['create', 'mirror', 'replace', 'skip']);
  });

  it('≥ 0.95 interactive — Skip deletes the just-written proposed file', async () => {
    writeFileSync(join(tmp, 'CLAUDE.md'), 'A', 'utf8');
    writeFileSync(join(tmp, 'AGENTS.md'), 'A', 'utf8');
    clackMock.select.mockResolvedValueOnce('skip');
    await checkWritePathDedup(tmp, res(['CLAUDE.md']), {
      interactive: true,
      embed: fakeEmbedIdentical(),
    });
    expect(existsSync(join(tmp, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(tmp, 'AGENTS.md'))).toBe(true); // matched stays
  });

  it('≥ 0.95 interactive — Replace overwrites the matched existing file', async () => {
    writeFileSync(join(tmp, 'CLAUDE.md'), 'FRESH-BYTES', 'utf8');
    writeFileSync(join(tmp, 'AGENTS.md'), 'OLD', 'utf8');
    clackMock.select.mockResolvedValueOnce('replace');
    // identical-by-content fake: same length⇒same vec; FRESH-BYTES (11) vs OLD (3) are orthogonal.
    // Use a fake that maps any non-empty text to the SAME vector so cosine = 1.0.
    const sameVec: EmbedLike = async () => {
      const v = new Float32Array(384);
      v[0] = 1;
      return v;
    };
    await checkWritePathDedup(tmp, res(['CLAUDE.md']), { interactive: true, embed: sameVec });
    expect(readFileSync(join(tmp, 'AGENTS.md'), 'utf8')).toBe('FRESH-BYTES');
  });

  it('0.85–0.95: INFO-only hint, write proceeds, no @clack prompt (conflict record still lands)', async () => {
    writeFileSync(join(tmp, 'CLAUDE.md'), 'A', 'utf8');
    writeFileSync(join(tmp, 'AGENTS.md'), 'B', 'utf8'); // cosine ≈ 0.9
    const embed = fakeEmbedAtSim(0.9);
    const result = await checkWritePathDedup(tmp, res(['CLAUDE.md']), {
      interactive: true,
      embed,
    });
    // Hint tier: found entry recorded; NO interactive prompt fired (info-only).
    expect(result.found).toHaveLength(1);
    expect(result.found[0]?.similarity).toBeLessThan(0.95);
    expect(result.found[0]?.similarity).toBeGreaterThanOrEqual(0.85);
    expect(clackMock.select).not.toHaveBeenCalled();
    // The conflict connect records EVERY near-dup (info tier too), so a --json caller
    // sees the 0.85–0.95 band with its cosine without a prompt.
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.similarity).toBeGreaterThanOrEqual(0.85);
    expect(result.conflicts[0]?.similarity).toBeLessThan(0.95);
    expect(existsSync(join(tmp, 'CLAUDE.md'))).toBe(true);
  });

  it('< 0.85: silent (no found, no prompt, no record)', async () => {
    writeFileSync(join(tmp, 'CLAUDE.md'), 'A', 'utf8');
    writeFileSync(join(tmp, 'AGENTS.md'), 'B', 'utf8'); // cosine ≈ 0.5 (below info band)
    const result = await checkWritePathDedup(tmp, res(['CLAUDE.md']), {
      interactive: true,
      embed: fakeEmbedAtSim(0.5),
    });
    expect(result.found).toHaveLength(0);
    expect(result.conflicts).toHaveLength(0);
    expect(clackMock.select).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. Fresh-project fast path: empty candidate set → no embedding.
// ---------------------------------------------------------------------------
describe('checkWritePathDedup — fast path', () => {
  it('empty candidate set (fresh project): embedder is never called', async () => {
    writeFileSync(join(tmp, 'CLAUDE.md'), 'A', 'utf8'); // proposed; no other host files
    const embed = vi.fn(fakeEmbedIdentical());
    const result = await checkWritePathDedup(tmp, res(['CLAUDE.md']), {
      interactive: false,
      embed,
    });
    expect(embed).not.toHaveBeenCalled();
    expect(result.found).toHaveLength(0);
    expect(result.conflicts).toHaveLength(0);
  });

  it('no host-context files in res.written: hook short-circuits (no embedding)', async () => {
    const embed = vi.fn(fakeEmbedIdentical());
    const result = await checkWritePathDedup(tmp, res(['.mcp.json']), {
      interactive: false,
      embed,
    });
    expect(embed).not.toHaveBeenCalled();
    expect(result.found).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Graceful degradation: embedder unavailable → warn-skip, write still ok.
// ---------------------------------------------------------------------------
describe('checkWritePathDedup — graceful degradation', () => {
  it('embedder throws → warn-skip, empty result, exit-0-shaped (no throw)', async () => {
    writeFileSync(join(tmp, 'CLAUDE.md'), 'A', 'utf8');
    writeFileSync(join(tmp, 'AGENTS.md'), 'A', 'utf8');
    const throwing: EmbedLike = async () => {
      throw new Error('onnx absent');
    };
    const result = await checkWritePathDedup(tmp, res(['CLAUDE.md']), {
      interactive: false,
      embed: throwing,
    });
    expect(result.found).toHaveLength(0);
    expect(result.conflicts).toHaveLength(0);
    // The proposed file stands (the write already happened; dedup didn't gate).
    expect(existsSync(join(tmp, 'CLAUDE.md'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Content-hash gate: repeat run with unchanged candidates doesn't re-embed.
// ---------------------------------------------------------------------------
describe('checkWritePathDedup — content-hash cache', () => {
  it('second run with unchanged candidates does NOT re-embed (cache hits)', async () => {
    writeFileSync(join(tmp, 'CLAUDE.md'), 'PROPOSED-CONTENT', 'utf8');
    writeFileSync(join(tmp, 'AGENTS.md'), 'PROPOSED-CONTENT', 'utf8');
    const embed = vi.fn(fakeEmbedIdentical());

    await checkWritePathDedup(tmp, res(['CLAUDE.md']), { interactive: false, embed });
    const callsAfterFirst = embed.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0); // embedded proposed + candidate(s)

    // Second run: same on-disk content → cache hits → embedder NOT called.
    await checkWritePathDedup(tmp, res(['CLAUDE.md']), { interactive: false, embed });
    expect(embed.mock.calls.length).toBe(callsAfterFirst);
  });

  it('a model change invalidates the cache (entries dropped on model mismatch)', async () => {
    writeFileSync(join(tmp, 'CLAUDE.md'), 'X', 'utf8');
    writeFileSync(join(tmp, 'AGENTS.md'), 'X', 'utf8');
    const embed = vi.fn(fakeEmbedIdentical());
    // Production path: project.config drives the model id stored in the cache.
    // Simulate a model change by passing two different projects whose config
    // resolves to a different model id. The cache loader keys entries on the
    // model; a mismatch clears them, forcing a re-embed.
    const projectA = {
      config: { context: { embedder: { kind: 'local', model: 'model-A' } } },
    } as unknown as Parameters<typeof checkWritePathDedup>[2]['project'];
    const projectB = {
      config: { context: { embedder: { kind: 'local', model: 'model-B' } } },
    } as unknown as Parameters<typeof checkWritePathDedup>[2]['project'];

    await checkWritePathDedup(tmp, res(['CLAUDE.md']), {
      interactive: false,
      embed,
      project: projectA,
    });
    const afterFirst = embed.mock.calls.length;
    // Same model → cache hits → no new embed calls.
    await checkWritePathDedup(tmp, res(['CLAUDE.md']), {
      interactive: false,
      embed,
      project: projectA,
    });
    expect(embed.mock.calls.length).toBe(afterFirst);
    // Different model → cache invalidated → re-embeds.
    await checkWritePathDedup(tmp, res(['CLAUDE.md']), {
      interactive: false,
      embed,
      project: projectB,
    });
    expect(embed.mock.calls.length).toBeGreaterThan(afterFirst);
  });
});

// ---------------------------------------------------------------------------
// 5. --json connect: near-dup recorded in conflicts[] with similarity.
// ---------------------------------------------------------------------------
describe('checkWritePathDedup — conflict connect (conflicts[])', () => {
  it('action tier records a ConflictRecord (mode=artifact, similarity set, 12-char shas)', async () => {
    writeFileSync(join(tmp, 'CLAUDE.md'), 'A', 'utf8');
    writeFileSync(join(tmp, 'AGENTS.md'), 'A', 'utf8');
    const result = await checkWritePathDedup(tmp, res(['CLAUDE.md']), {
      interactive: false,
      embed: fakeEmbedIdentical(),
    });
    expect(result.conflicts).toHaveLength(1);
    const rec = result.conflicts[0];
    expect(rec?.mode).toBe('artifact');
    expect(rec?.path).toBe('CLAUDE.md');
    expect(typeof rec?.similarity).toBe('number');
    expect(rec?.similarity).toBeGreaterThanOrEqual(0.95);
    expect(rec?.existingSha).toMatch(/^[0-9a-f]{12}$/);
    expect(rec?.proposedSha).toMatch(/^[0-9a-f]{12}$/);
    expect(rec?.resolution).toBe('preserve');
  });
});

// ---------------------------------------------------------------------------
// 6. TASK 1 wiring: init/sync forward onConflict to emitSkillsToDir.
// Spying on the producer (rather than @clack) isolates the WIRING under test
// from the clack menu's own behavior — the contract TASK 1 closes is "the
// CLI threads buildConflictOpts().onConflict into emitSkillsToDir", and the
// spy asserts EXACTLY that at the call boundary.
// ---------------------------------------------------------------------------
describe('TASK 1 — init/sync forward onConflict to skills emit', () => {
  it('interactive init: emitSkillsToDir is called with onConflict + interactive=true', async () => {
    const skills = await import('@noir-ai/skills');
    const spy = vi.spyOn(skills, 'emitSkillsToDir').mockResolvedValue({
      dir: tmp,
      emitted: [],
      references: 0,
      conflicts: [],
    });
    const restore = setTtyInteractive();
    try {
      const { init } = await import('../src/init.js');
      await init(tmp, { transport: 'stdio' });
      expect(spy).toHaveBeenCalled();
      const arg = spy.mock.calls[0]?.[1] as {
        interactive?: boolean;
        onConflict?: unknown;
        conflictPolicy?: string;
      };
      expect(arg.interactive).toBe(true);
      expect(typeof arg.onConflict).toBe('function'); // TASK 1: resolver wired
      expect(arg.conflictPolicy).toBe('preserve');
    } finally {
      spy.mockRestore();
      restore();
    }
  });

  it('interactive sync: emitSkillsToDir is called with onConflict + interactive=true', async () => {
    // sync() reads host from .noir/config.yml; first init seeds it.
    const { init } = await import('../src/init.js');
    await init(tmp, { transport: 'stdio' });
    const skills = await import('@noir-ai/skills');
    const spy = vi.spyOn(skills, 'emitSkillsToDir').mockResolvedValue({
      dir: tmp,
      emitted: [],
      references: 0,
      conflicts: [],
    });
    const restore = setTtyInteractive();
    try {
      const { sync } = await import('../src/sync.js');
      await sync(tmp);
      expect(spy).toHaveBeenCalled();
      const arg = spy.mock.calls[0]?.[1] as {
        interactive?: boolean;
        onConflict?: unknown;
        conflictPolicy?: string;
      };
      expect(arg.interactive).toBe(true);
      expect(typeof arg.onConflict).toBe('function'); // TASK 1: resolver wired
    } finally {
      spy.mockRestore();
      restore();
    }
  });

  it('--no-input (NOIR_NON_INTERACTIVE): onConflict is NOT threaded (prompt-free)', async () => {
    const saved = process.env.NOIR_NON_INTERACTIVE;
    process.env.NOIR_NON_INTERACTIVE = '1';
    const skills = await import('@noir-ai/skills');
    const spy = vi.spyOn(skills, 'emitSkillsToDir').mockResolvedValue({
      dir: tmp,
      emitted: [],
      references: 0,
      conflicts: [],
    });
    try {
      const { init } = await import('../src/init.js');
      await init(tmp, { transport: 'stdio' });
      expect(spy).toHaveBeenCalled();
      const arg = spy.mock.calls[0]?.[1] as {
        interactive?: boolean;
        onConflict?: unknown;
      };
      // Under --no-input, buildConflictOpts returns no onConflict; the producer
      // sees interactive=false and never prompts.
      expect(arg.interactive).toBe(false);
      expect(arg.onConflict).toBeUndefined();
    } finally {
      spy.mockRestore();
      if (saved === undefined) delete process.env.NOIR_NON_INTERACTIVE;
      else process.env.NOIR_NON_INTERACTIVE = saved;
    }
  });

  it('end-to-end: interactive init + injected preserve-resolver keeps user skill bytes', async () => {
    // Inject a stub onConflict at the producer boundary by spying on
    // emitSkillsToDir: when the spy sees the call, it forwards to the REAL
    // producer with a stub resolver returning 'preserve'. This proves TASK 1
    // end-to-end: the CLI's threaded onConflict reaches the producer's
    // conflict branch AND its decision drives the on-disk outcome.
    const skills = await import('@noir-ai/skills');
    const realEmit = skills.emitSkillsToDir;
    const stubOnConflict = vi.fn((): 'preserve' => 'preserve');
    const spy = vi.spyOn(skills, 'emitSkillsToDir').mockImplementation(async (dir, opts) => {
      const interactive = (opts as { interactive?: boolean }).interactive ?? false;
      // Forward to the real producer with the STUB resolver when the CLI wired
      // one (interactive=true); otherwise pass through unchanged.
      const forwarded = interactive ? { ...(opts as object), onConflict: stubOnConflict } : opts;
      return realEmit(dir, forwarded as Parameters<typeof realEmit>[1]);
    });
    const restore = setTtyInteractive();
    try {
      const { init } = await import('../src/init.js');
      await init(tmp, { transport: 'stdio' });
      const skillPath = join(tmp, '.claude', 'skills', 'noir-brainstorming', 'SKILL.md');
      writeFileSync(
        skillPath,
        '---\nname: noir-brainstorming\ndescription: x.\n---\nUSER-EDIT',
        'utf8',
      );

      await init(tmp, { transport: 'stdio', force: true });

      // The stub resolver fired (proving the CLI threaded onConflict through
      // the spy into the producer's conflict branch).
      expect(stubOnConflict).toHaveBeenCalled();
      // Its 'preserve' decision drove the outcome: user bytes stand.
      expect(readFileSync(skillPath, 'utf8')).toContain('USER-EDIT');
    } finally {
      spy.mockRestore();
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** Force isInteractive()=true for the duration of a test (both streams TTY,
 *  no CI / NO_COLOR / NOIR_NON_INTERACTIVE). Returns a restore closure. */
function setTtyInteractive(): () => void {
  const savedCi = process.env.CI;
  const savedNoColor = process.env.NO_COLOR;
  const savedNonInt = process.env.NOIR_NON_INTERACTIVE;
  const savedOut = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const savedIn = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  delete process.env.CI;
  delete process.env.NO_COLOR;
  delete process.env.NOIR_NON_INTERACTIVE;
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  return () => {
    if (savedCi === undefined) delete process.env.CI;
    else process.env.CI = savedCi;
    if (savedNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = savedNoColor;
    if (savedNonInt === undefined) delete process.env.NOIR_NON_INTERACTIVE;
    else process.env.NOIR_NON_INTERACTIVE = savedNonInt;
    if (savedOut !== undefined) Object.defineProperty(process.stdout, 'isTTY', savedOut);
    if (savedIn !== undefined) Object.defineProperty(process.stdin, 'isTTY', savedIn);
  };
}

/** Narrow alias for the table-driven tests above. */
function res(written: string[]): ScaffoldResult {
  return fakeRes(written);
}
