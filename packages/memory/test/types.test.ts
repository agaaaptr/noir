import { describe, expect, it } from 'vitest';
import type {
  ConsolidateOptions,
  ConsolidationResult,
  EmbedderConfig,
  EmbedFn,
  ForgetResult,
  MemoryConfig,
  MemoryEngine,
  MemoryHit,
  MemorySource,
  MemoryStatus,
  MemoryType,
  Observation,
  RecallOptions,
  SaveInput,
  SearchOptions,
  SessionInfo,
} from '../src/types.js';
import { MEMORY_TYPES } from '../src/types.js';

// Type-only contracts for the t1 scaffold. The value of these tests is twofold:
// (a) they lock the SHAPE of the data model + the open enum + the consolidation
// refusal envelope, and (b) they prove the type re-exports
// (EmbedFn/EmbedderConfig/ProjectId via @noir-ai/context + @noir-ai/core) resolve
// through the memory barrel without a cycle. No store, no network, no LLM.

describe('@noir-ai/memory types (t1 scaffold)', () => {
  describe('MEMORY_TYPES (open enum)', () => {
    it('lists the 8 dev-flavored known types in the documented order', () => {
      expect(MEMORY_TYPES).toEqual([
        'pattern',
        'preference',
        'architecture',
        'bug',
        'workflow',
        'fact',
        'decision',
        'lesson',
      ]);
      expect(MEMORY_TYPES).toHaveLength(8);
    });

    it('reserves `lesson` for consolidation output', () => {
      expect(MEMORY_TYPES).toContain('lesson');
    });

    it('MemoryType accepts unknown strings (open enum — forward-compat)', () => {
      // Unknown values accepted + stored. Both a known literal and an
      // arbitrary user-defined string must be assignable to MemoryType.
      const known: MemoryType = 'pattern';
      const unknown: MemoryType = 'cognitive-note';
      expect(known).toBe('pattern');
      expect(unknown).toBe('cognitive-note');
    });
  });

  describe('MemorySource', () => {
    it("'explicit' is the default capture provenance", () => {
      const source: MemorySource = 'explicit';
      expect(source).toBe('explicit');
    });

    it('accepts auto:<hook> provenances (opt-in hooks template only)', () => {
      const stop: MemorySource = 'auto:stop';
      const post: MemorySource = 'auto:posttooluse';
      expect(stop).toBe('auto:stop');
      expect(post).toBe('auto:posttooluse');
    });
  });

  describe('Observation (canonical row)', () => {
    it('constructs with full (never-truncated) content; provenance optional', () => {
      const obs: Observation = {
        id: '01J00000000000000000000001',
        type: 'pattern',
        content: 'always resolve the embedder once per serve lifecycle',
        project: 'proj-uuid',
        sessionId: 'sess-1',
        ts: 1_700_000_000_000,
        lastAccessTs: 1_700_000_000_000,
        importance: 0.8,
        concepts: ['embedder', 'lifecycle'],
        files: ['packages/context/src/contextEngine.ts'],
        source: 'explicit',
      };
      expect(obs.id).toBe('01J00000000000000000000001');
      expect(obs.type).toBe('pattern');
      expect(obs.project).toBe('proj-uuid');
      expect(obs.concepts).toHaveLength(2);
      // provenance is optional — absent on user-saved observations.
      expect(obs.provenance).toBeUndefined();
    });

    it('carries provenance on a derived lesson (consolidation output)', () => {
      const lesson: Observation = {
        id: '01J00000000000000000000002',
        type: 'lesson',
        content: 'derived: prefer local embeddings for offline runs',
        project: 'proj-uuid',
        sessionId: null,
        ts: 1_700_000_000_001,
        lastAccessTs: 1_700_000_000_001,
        importance: 0.9,
        concepts: ['embeddings'],
        files: [],
        source: 'explicit',
        provenance: ['01J00000000000000000000001'],
      };
      expect(lesson.type).toBe('lesson');
      expect(lesson.provenance).toEqual(['01J00000000000000000000001']);
      expect(lesson.sessionId).toBeNull();
    });
  });

  describe('SaveInput', () => {
    it('requires only content; the rest is optional (engine applies defaults)', () => {
      const input: SaveInput = { content: 'remember this' };
      expect(input.content).toBe('remember this');
      expect(input.type).toBeUndefined();
      expect(input.importance).toBeUndefined();
      expect(input.concepts).toBeUndefined();
    });

    it('accepts the full optional surface', () => {
      const input: SaveInput = {
        content: 'remember this',
        type: 'decision',
        concepts: ['auth'],
        files: ['src/auth.ts'],
        importance: 0.7,
        sessionId: 'sess-1',
      };
      expect(input.type).toBe('decision');
      expect(input.importance).toBe(0.7);
      expect(input.files).toEqual(['src/auth.ts']);
    });
  });

  describe('recall / search options + MemoryHit (full content)', () => {
    it('RecallOptions carries limit/type/sessionId filters', () => {
      const opts: RecallOptions = { limit: 5, type: 'bug', sessionId: 'sess-1' };
      expect(opts.limit).toBe(5);
      expect(opts.type).toBe('bug');
    });

    it('SearchOptions is the BM25-only instant path', () => {
      const opts: SearchOptions = { limit: 3 };
      expect(opts.limit).toBe(3);
    });

    it('MemoryHit carries full content + a rank-based score', () => {
      const hit: MemoryHit = {
        id: 'obs-1',
        type: 'fact',
        content: 'the full observation text, never the FTS snippet',
        score: 0.5 / 61,
        concepts: [],
        files: [],
        ts: 1_700_000_000_000,
        importance: 0.5,
        source: 'explicit',
      };
      // full content is present verbatim — not a windowed preview.
      expect(hit.content).toBe('the full observation text, never the FTS snippet');
      expect(hit.score).toBeCloseTo(0.5 / 61, 10);
    });
  });

  describe('SessionInfo', () => {
    it('rolls up count + lastTs per session, scoped to a ProjectId', () => {
      const s: SessionInfo = {
        id: 'sess-1',
        project: 'proj-uuid',
        count: 3,
        lastTs: 1_700_000_000_000,
      };
      expect(s.count).toBe(3);
      expect(s.lastTs).toBe(1_700_000_000_000);
    });
  });

  describe('MemoryConfig + consolidation gate (D5)', () => {
    it('defaults to no consolidation block (offline, free)', () => {
      const cfg: MemoryConfig = {};
      expect(cfg.consolidation).toBeUndefined();
    });

    it('requires an explicit provider to enable consolidation (never env-inferred)', () => {
      const cfg: MemoryConfig = {
        consolidation: { enabled: true, provider: 'anthropic', model: 'claude-3-5' },
      };
      expect(cfg.consolidation?.enabled).toBe(true);
      expect(cfg.consolidation?.provider).toBe('anthropic');
    });
  });

  describe('op results', () => {
    it('ForgetResult echoes deleted count + ids', () => {
      const r: ForgetResult = { deleted: 2, ids: ['a', 'b'] };
      expect(r.deleted).toBe(2);
      expect(r.ids).toEqual(['a', 'b']);
    });

    it('ConsolidateOptions passes types + limit', () => {
      const o: ConsolidateOptions = { types: ['bug', 'decision'], limit: 50 };
      expect(o.types).toEqual(['bug', 'decision']);
    });

    it('MemoryStatus mirrors ContextStatus (projectId + degraded)', () => {
      const s: MemoryStatus = {
        ok: true,
        projectId: 'proj-uuid',
        observations: 7,
        degraded: false,
      };
      expect(s.observations).toBe(7);
      expect(s.degraded).toBe(false);
    });
  });

  describe('ConsolidationResult (provider gate — never a silent paid call)', () => {
    it('expresses the no-provider refusal + logged flag', () => {
      const res: ConsolidationResult = { ok: false, reason: 'no-provider', logged: true };
      expect(res.ok).toBe(false);
      if (!res.ok) {
        // narrowing: reason is one of the documented refusal causes.
        expect(res.reason).toBe('no-provider');
        expect(res.logged).toBe(true);
      }
    });

    it('expresses the model-unavailable refusal (S8 not yet wired)', () => {
      const res: ConsolidationResult = { ok: false, reason: 'model-unavailable', logged: true };
      if (!res.ok) expect(res.reason).toBe('model-unavailable');
    });

    it('expresses a successful append of derived lessons (originals untouched)', () => {
      const lesson: Observation = {
        id: 'l1',
        type: 'lesson',
        content: 'derived insight',
        project: 'p',
        sessionId: null,
        ts: 1,
        lastAccessTs: 1,
        importance: 0.5,
        concepts: [],
        files: [],
        source: 'explicit',
        provenance: ['obs-1', 'obs-2'],
      };
      const res: ConsolidationResult = { ok: true, lessons: [lesson], from: ['obs-1', 'obs-2'] };
      if (res.ok) {
        expect(res.lessons[0]?.type).toBe('lesson');
        expect(res.from).toEqual(['obs-1', 'obs-2']);
      }
    });
  });

  describe('MemoryEngine contract', () => {
    it('is structurally implementable; consolidate is optional (no LLM by default)', () => {
      // The interface is the ctx.memory contract. `consolidate` is OPTIONAL —
      // its absence is the static signal that no LLM surface is wired.
      // A mock without consolidate must satisfy the interface.
      const engine: MemoryEngine = {
        async save(input: SaveInput): Promise<Observation> {
          return {
            id: '1',
            type: input.type ?? 'fact',
            content: input.content,
            project: 'p',
            sessionId: input.sessionId ?? null,
            ts: 0,
            lastAccessTs: 0,
            importance: input.importance ?? 0.5,
            concepts: input.concepts ?? [],
            files: input.files ?? [],
            source: 'explicit',
          };
        },
        async recall(): Promise<MemoryHit[]> {
          return [];
        },
        async search(): Promise<MemoryHit[]> {
          return [];
        },
        sessions(): SessionInfo[] {
          return [];
        },
        forget(ids: string[]): ForgetResult {
          return { deleted: 0, ids };
        },
        status(): MemoryStatus {
          return { ok: true, projectId: 'p', observations: 0, degraded: false };
        },
      };
      expect(engine.consolidate).toBeUndefined(); // optional — not wired
      expect(typeof engine.save).toBe('function');
      expect(typeof engine.forget).toBe('function');
    });

    it('accepts a consolidate implementation when a provider is wired', async () => {
      const engine: MemoryEngine = {
        async save() {
          return {
            id: '1',
            type: 'fact',
            content: 'x',
            project: 'p',
            sessionId: null,
            ts: 0,
            lastAccessTs: 0,
            importance: 0.5,
            concepts: [],
            files: [],
            source: 'explicit',
          };
        },
        async recall() {
          return [];
        },
        async search() {
          return [];
        },
        sessions() {
          return [];
        },
        forget() {
          return { deleted: 0, ids: [] };
        },
        status() {
          return { ok: true, projectId: 'p', observations: 0, degraded: false };
        },
        async consolidate(): Promise<ConsolidationResult> {
          // provider-gated: a real engine refuses here when no provider is set.
          return { ok: false, reason: 'no-provider', logged: true };
        },
      };
      const out = await engine.consolidate?.();
      expect(out?.ok).toBe(false);
    });
  });

  describe('re-exports (single import surface)', () => {
    it('exposes EmbedFn + EmbedderConfig re-exported from @noir-ai/context', () => {
      // Type-only re-exports — the value of this test is that the imports
      // resolve through the memory types barrel without a cycle. The runtime
      // assertions just confirm the bindings are usable.
      const embed: EmbedFn = async (text: string) =>
        new Float32Array(384).fill(text.length ? 1 : 0);
      const cfg: EmbedderConfig = { kind: 'none' };
      expect(typeof embed).toBe('function');
      expect(cfg.kind).toBe('none');
    });
  });
});
