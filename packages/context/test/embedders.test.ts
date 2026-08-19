// Unit tests for the embedder factory + helpers (slice S6, task t3 red→green).
//
// These are the stable, offline assertions from t3's red step; the full
// provider matrix + the guarded real-MiniLM integration test (probe-load
// @huggingface/transformers, `describe.skip` if the native binary is absent —
// mirroring packages/store/test/vec.test.ts' VEC_PROBE) land in t11.
//
// Everything here is deterministic and offline: `fakeEmbedFn` + `l2normalize`
// never touch the network or the model runtime.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
// `fakeEmbedFn` is deliberately not part of the public embedder barrel (it is a
// test-only deterministic double) — import it directly from its module.
import { fakeEmbedFn } from '../src/embedders/fake.js';
import {
  createEmbedFn,
  DEFAULT_LOCAL_MODEL,
  EMBED_DIM,
  l2normalize,
  localEmbedder,
} from '../src/embedders/index.js';

describe('l2normalize', () => {
  it('produces a unit-norm vector and preserves length', () => {
    const v = Float32Array.of(0, 3, 4); // L2 norm = 5
    const n = l2normalize(v);
    expect(n.length).toBe(3);
    const norm = Math.hypot(n[0] ?? 0, n[1] ?? 0, n[2] ?? 0);
    expect(norm).toBeCloseTo(1, 6);
    // 3-4-5 triangle normalized → [0, 0.6, 0.8]
    expect(n[1]).toBeCloseTo(0.6, 6);
    expect(n[2]).toBeCloseTo(0.8, 6);
  });

  it('does not mutate the input', () => {
    const v = Float32Array.of(3, 4);
    l2normalize(v);
    expect(Array.from(v)).toEqual([3, 4]);
  });

  it('returns a zero vector (no invented signal) for an all-zero input', () => {
    const n = l2normalize(new Float32Array(8));
    expect(n.length).toBe(8);
    for (let i = 0; i < 8; i++) expect(n[i]).toBe(0);
  });

  it('EMBED_DIM is 384 (matches the S1 vec0 table — no migration)', () => {
    expect(EMBED_DIM).toBe(384);
  });
});

describe('fakeEmbedFn', () => {
  it('returns a 384-dim unit-norm Float32Array', async () => {
    const embed = fakeEmbedFn();
    const v = await embed('hello world');
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(384);
    let sum = 0;
    for (let i = 0; i < v.length; i++) sum += (v[i] ?? 0) ** 2;
    expect(Math.sqrt(sum)).toBeCloseTo(1, 5);
  });

  it('is deterministic — same text yields bit-identical vectors (NFR-5)', async () => {
    const embed = fakeEmbedFn();
    const a = await embed('context engine');
    const b = await embed('context engine');
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('distinguishes different texts', async () => {
    const embed = fakeEmbedFn();
    const a = await embed('context engine');
    const b = await embed('memory recall');
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('honors a custom dim', async () => {
    const embed = fakeEmbedFn(8);
    expect((await embed('x')).length).toBe(8);
  });
});

describe('createEmbedFn', () => {
  it("kind:'none' reports dim:0 and rejects on embed (degraded path, F8)", async () => {
    const { embed, info } = createEmbedFn({ kind: 'none' });
    expect(info).toEqual({ kind: 'none', dim: 0 });
    await expect(embed('x')).rejects.toThrow(/disabled/);
  });

  it("kind:'local' resolves info with the default model and EMBED_DIM, without loading the model at construction (lazy)", () => {
    // Construction must be synchronous + offline: no dynamic import, no network.
    const { embed, info } = createEmbedFn({ kind: 'local' });
    expect(info.kind).toBe('local');
    expect(info.model).toBe(DEFAULT_LOCAL_MODEL);
    expect(info.dim).toBe(384);
    expect(typeof embed).toBe('function');
  });

  it("kind:'local' honors a custom model in info", () => {
    const { info } = createEmbedFn({ kind: 'local', model: 'Xenova/bge-small-en-v1.5' });
    expect(info.model).toBe('Xenova/bge-small-en-v1.5');
  });

  it("kind:'remote' builds without a key (status can report it) but embed throws 'not configured' (F8)", async () => {
    const { embed, info } = createEmbedFn({
      kind: 'remote',
      provider: 'openai',
      model: 'text-embedding-3-small',
      dim: 384,
    });
    expect(info).toEqual({ kind: 'remote', model: 'text-embedding-3-small', dim: 384 });
    await expect(embed('x')).rejects.toThrow(/not configured/i);
  });

  it("kind:'ollama' builds without error and reports EMBED_DIM (baseURL missing surfaces on embed, F8)", async () => {
    // Empty baseURL triggers the not-configured branch inside embed().
    const { embed, info } = createEmbedFn({
      kind: 'ollama',
      baseURL: '',
      model: 'nomic-embed-text',
    });
    expect(info).toEqual({ kind: 'ollama', model: 'nomic-embed-text', dim: 384 });
    await expect(embed('x')).rejects.toThrow(/not configured/i);
  });
});

describe('localEmbedder (lazy import)', () => {
  it('constructs synchronously with the default model and never loads the model at import time', () => {
    // If the dynamic import ran at module load (or at construction), this file
    // could not be imported offline. Constructing here without throwing is the
    // lazy-load contract (NFR-4).
    const e = localEmbedder();
    expect(e.model).toBe(DEFAULT_LOCAL_MODEL);
    expect(typeof e.embed).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Guarded real-model integration test (slice S6, task t11).
//
// Mirrors packages/store/test/vec.test.ts' VEC_PROBE pattern: the local
// embedder pulls in @huggingface/transformers + the onnxruntime-node native
// binary and downloads ~22 MB of MiniLM weights on first use. The default test
// suite must stay green OFFLINE (NFR-2), so this probe RESOLVES the package
// synchronously at module load (the closest synchronous analog to vec.test.ts'
// `sqliteVec.load` probe) and `describe.skip`s the whole block with a labelled
// reason when the package is not installed — a CI matrix without the native
// runtime then reports a clear skip, not a red build. When the package IS
// installed, the block exercises the real lazy load + embed path end to end.
// ---------------------------------------------------------------------------

const nodeRequire = createRequire(import.meta.url);

const HF_PROBE: { ok: true } | { ok: false; reason: string } = (() => {
  try {
    nodeRequire.resolve('@huggingface/transformers');
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
})();

const describeHf = HF_PROBE.ok ? describe : describe.skip;
const hfLabel = HF_PROBE.ok
  ? 'local embedder integration (real MiniLM-L6-v2)'
  : `local embedder integration (real MiniLM-L6-v2) [SKIPPED — @huggingface/transformers unavailable: ${HF_PROBE.reason}]`;

describeHf(hfLabel, () => {
  it('loads lazily on first embed and returns a 384-dim L2-normalized Float32Array', async () => {
    // Construction must remain offline (lazy import inside embed); the dynamic
    // import + pipeline build + (first-run) model download happen HERE.
    const e = localEmbedder();
    const v = await e.embed('Noir hybrid retrieval over a codebase.');
    expect(v).toBeInstanceOf(Float32Array);
    // 384-dim → matches the S1 vec0 table with ZERO migration.
    expect(v.length).toBe(EMBED_DIM);
    // L2-normalized by the shared helper so vec0's default L2 ≈ cosine.
    let sum = 0;
    for (let i = 0; i < v.length; i++) sum += (v[i] ?? 0) ** 2;
    expect(Math.sqrt(sum)).toBeCloseTo(1, 4);
  });

  it('is deterministic across calls — same text yields the same vector', async () => {
    const e = localEmbedder();
    const a = await e.embed('deterministic embedding output');
    const b = await e.embed('deterministic embedding output');
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('distinguishes semantically different texts', async () => {
    const e = localEmbedder();
    const a = await e.embed('hybrid search and reciprocal rank fusion');
    const b = await e.embed('cross-session memory consolidation');
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });
});
