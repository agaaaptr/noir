import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectId } from '@noir-ai/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore } from '../src/sqlite-store.js';

let root: string;
let id: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-store-fts-'));
  id = createProjectId();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// A doc long enough that a 16-token snippet window is strictly shorter than
// the full content — this is what lets the test PROVE snippet != full content.
const OVERVIEW_CONTENT =
  'Noir is a discipline layer for agentic CLIs. The daemon manages the context window, ' +
  'long-term memory, and indexed documents across many concurrent sessions. It coordinates ' +
  'plans, checkpoints, and task handoffs between agents and humans using a shared SQLite store.';

const DOCS = [
  {
    id: 'noir-overview',
    source: 'spec',
    content: OVERVIEW_CONTENT,
    meta: { version: 1 },
  },
  {
    id: 'clickup-guide',
    source: 'docs',
    content:
      'ClickUp integration guide for Noir. Create tasks, update statuses, and sync assignments between ClickUp and the local workflow state file.',
  },
  {
    id: 'daemon-internals',
    source: 'spec',
    content:
      'The daemon process coordinates concurrent sessions, persists key-value state, and runs full-text search over indexed documents for fast recall.',
  },
] as const;

async function openAndIndex() {
  const store = await openStore({ projectId: id, root });
  for (const d of DOCS) {
    store.indexDoc({ id: d.id, source: d.source, content: d.content, meta: d.meta });
  }
  return store;
}

describe('FTS5 index + BM25 search', () => {
  it('returns the doc matching both terms ranked first', async () => {
    const store = await openAndIndex();
    try {
      const hits = store.searchFt('noir daemon');
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]?.id).toBe('noir-overview');
    } finally {
      await store.close();
    }
  });

  it('snippet is a window: shorter than full content, carries the matched term with markers', async () => {
    const store = await openAndIndex();
    try {
      const hits = store.searchFt('daemon');
      expect(hits.length).toBeGreaterThan(0);
      const hit = hits[0];
      if (!hit) throw new Error('no hit');
      // Window: strictly shorter than the full content of any indexed doc.
      expect(hit.snippet.length).toBeLessThan(OVERVIEW_CONTENT.length);
      // Carries the match with open/close markers (<<term>>).
      expect(hit.snippet).toMatch(/<<.*daemon.*>>/i);
      // And it is a real substring window — does NOT equal the full content.
      expect(hit.snippet).not.toBe(OVERVIEW_CONTENT);
    } finally {
      await store.close();
    }
  });

  it('round-trips meta through the hit', async () => {
    const store = await openAndIndex();
    try {
      const hits = store.searchFt('discipline');
      const overview = hits.find((h) => h.id === 'noir-overview');
      expect(overview?.meta).toEqual({ version: 1 });
    } finally {
      await store.close();
    }
  });

  it('opts.source filters by source', async () => {
    const store = await openAndIndex();
    try {
      const docsOnly = store.searchFt('noir', { source: 'docs' });
      expect(docsOnly.every((h) => h.source === 'docs')).toBe(true);
      expect(docsOnly.map((h) => h.id)).toContain('clickup-guide');
      // 'spec'-only filter returns spec docs (overview + internals both mention the daemon/noir).
      const specOnly = store.searchFt('daemon', { source: 'spec' });
      expect(specOnly.length).toBeGreaterThan(0);
      expect(specOnly.every((h) => h.source === 'spec')).toBe(true);
    } finally {
      await store.close();
    }
  });

  it('opts.limit caps the number of results', async () => {
    const store = await openAndIndex();
    try {
      const limited = store.searchFt('the', { limit: 1 });
      expect(limited.length).toBeLessThanOrEqual(1);
    } finally {
      await store.close();
    }
  });

  it('a huge opts.limit is clamped (never materializes unbounded rows)', async () => {
    const store = await openAndIndex();
    try {
      // Pre-fix, limit: 1e9 flowed straight into 'LIMIT ?' — the clamp (MAX_HITS)
      // keeps `.all()` bounded. With 3 docs the observable contract is: sane
      // result set, no crash.
      const huge = store.searchFt('noir', { limit: 1_000_000_000 });
      expect(huge.length).toBeLessThanOrEqual(3);
      expect(huge.length).toBeGreaterThan(0);
    } finally {
      await store.close();
    }
  });

  it('FTS5 operator characters in a query are treated literally (no syntax error)', async () => {
    const store = await openAndIndex();
    try {
      // Pre-fix, these threw 'fts5: syntax error' (bare '*', unbalanced quote,
      // leading ':', parens) or silently changed semantics. Post-fix each term is
      // a quoted literal phrase — never an FTS5 expression.
      expect(() => store.searchFt('*')).not.toThrow();
      expect(() => store.searchFt('noir "daemon')).not.toThrow();
      expect(() => store.searchFt('daemon:')).not.toThrow();
      expect(() => store.searchFt('(noir')).not.toThrow();
      expect(() => store.searchFt('daemon AND')).not.toThrow();
      // A plain term still matches (escaping preserves normal search semantics).
      expect(store.searchFt('daemon').length).toBeGreaterThan(0);
    } finally {
      await store.close();
    }
  });

  it('upserts on conflicting id (indexDoc is idempotent)', async () => {
    const store = await openStore({ projectId: id, root });
    try {
      store.indexDoc({ id: 'd', source: 'spec', content: 'alpha beta gamma' });
      store.indexDoc({ id: 'd', source: 'spec', content: 'delta epsilon zeta' });
      const hits = store.searchFt('epsilon');
      expect(hits.length).toBe(1);
      expect(hits[0]?.id).toBe('d');
      // old content is gone from the index — 'beta' must no longer hit.
      expect(store.searchFt('beta')).toHaveLength(0);
    } finally {
      await store.close();
    }
  });

  it('indexDoc throws in read-only mode (consistent with setState)', async () => {
    // Create + close in read-write so the schema exists.
    await (await openStore({ projectId: id, root })).close();
    const store = await openStore({ projectId: id, root, readonly: true });
    try {
      expect(() => store.indexDoc({ id: 'x', source: 's', content: 'c' })).toThrow(
        'store is read-only (daemon down)',
      );
    } finally {
      await store.close();
    }
  });

  it('searchFt works in read-only mode (read is allowed)', async () => {
    await (await openAndIndex()).close();
    const store = await openStore({ projectId: id, root, readonly: true });
    try {
      const hits = store.searchFt('daemon');
      expect(hits.length).toBeGreaterThan(0);
    } finally {
      await store.close();
    }
  });
});
