import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectId } from '@noir-ai/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore } from '../src/sqlite-store.js';

let root: string;
let id: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-store-kv-'));
  id = createProjectId();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('KV state store', () => {
  it('round-trips a JSON value', async () => {
    const store = await openStore({ projectId: id, root });
    try {
      const workflow = { phase: 'plan', steps: 3 };
      store.setState('workflow', workflow);
      const retrieved = store.getState<typeof workflow>('workflow');
      expect(retrieved).toEqual(workflow);
    } finally {
      await store.close();
    }
  });

  it('returns null for missing keys', async () => {
    const store = await openStore({ projectId: id, root });
    try {
      const missing = store.getState<unknown>('missing');
      expect(missing).toBeNull();
    } finally {
      await store.close();
    }
  });

  it('overwrites existing keys', async () => {
    const store = await openStore({ projectId: id, root });
    try {
      store.setState('counter', { count: 1 });
      store.setState('counter', { count: 2 });
      const retrieved = store.getState<{ count: number }>('counter');
      expect(retrieved).toEqual({ count: 2 });
    } finally {
      await store.close();
    }
  });

  it('throws when setState in read-only mode', async () => {
    // First create the DB in read-write mode
    await (await openStore({ projectId: id, root })).close();
    // Then open in read-only mode
    const store = await openStore({ projectId: id, root, readonly: true });
    try {
      expect(() => store.setState('key', 'value')).toThrow('store is read-only (daemon down)');
    } finally {
      await store.close();
    }
  });
});

describe('countDocs/countVecs', () => {
  it('reflect indexed docs and vecs on the public Store surface', async () => {
    const store = await openStore({ projectId: id, root });
    try {
      expect(store.countDocs()).toBe(0);
      expect(store.countVecs()).toBe(0);

      store.indexDoc({ id: 'd1', source: 'spec', content: 'one' });
      store.indexDoc({ id: 'd2', source: 'spec', content: 'two three' });
      store.upsertVec('v1', new Float32Array(384).fill(0));
      store.upsertVec('v2', new Float32Array(384).fill(0));

      expect(store.countDocs()).toBe(2);
      expect(store.countVecs()).toBe(2);
    } finally {
      await store.close();
    }
  });
});
