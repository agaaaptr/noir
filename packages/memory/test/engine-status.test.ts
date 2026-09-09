import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectId } from '@noir-ai/core';
import { openStore } from '@noir-ai/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryEngine } from '../src/engine.js';
import { fakeEmbedFn } from './fake-embed.js';

let root: string;
let store: Awaited<ReturnType<typeof openStore>>;
let projectId: string;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'noir-mem-status-'));
  projectId = createProjectId();
  store = await openStore({ projectId, root });
});
afterEach(async () => {
  await store.close();
  rmSync(root, { recursive: true, force: true });
});

describe('memory provenance + lifecycle', () => {
  it('stamps repo and marks superseded targets inactive; recall hides them unless includeInactive', async () => {
    const mem = createMemoryEngine({ store, root, projectId, embed: fakeEmbedFn() });
    const first = await mem.save({ content: 'GET /users returns {items: User[]}', repo: 'be' });
    expect(first.repo).toBe('be');
    await mem.save({ content: 'pagination param is page, not offset', repo: 'be', supersedes: first.id });
    // first is now superseded -> hidden by default
    const hidden = await mem.recall('pagination offset users');
    expect(hidden.some((h) => h.id === first.id)).toBe(false);
    const shown = await mem.recall('pagination offset users', { includeInactive: true });
    expect(shown.some((h) => h.id === first.id)).toBe(true);
    expect(shown.find((h) => h.id === first.id)?.status).toBe('superseded');
  });

  it('softForget marks forgotten (not deleted) and hides from recall', async () => {
    const mem = createMemoryEngine({ store, root, projectId, embed: fakeEmbedFn(), softForget: true });
    const obs = await mem.save({ content: 'scratch note to drop' });
    const res = mem.forget([obs.id]);
    expect(res.deleted).toBe(1);
    const gone = await mem.recall('scratch note');
    expect(gone.some((h) => h.id === obs.id)).toBe(false);
    const raw = mem.get(obs.id);
    expect(raw?.status).toBe('forgotten');
  });

  it('default (non-soft) forget keeps hard-delete semantics', async () => {
    const mem = createMemoryEngine({ store, root, projectId, embed: fakeEmbedFn() });
    expect(mem.softForget).toBe(false);
    const obs = await mem.save({ content: 'to hard delete' });
    expect(mem.forget([obs.id]).deleted).toBe(1);
    expect(mem.get(obs.id)).toBeNull();
  });
});
