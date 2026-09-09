import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectId } from '@noir-ai/core';
import { openStore } from '@noir-ai/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureSource } from '../src/capture.js';
import { createMemoryEngine } from '../src/engine.js';
import { fakeEmbedFn } from './fake-embed.js';

let root: string;
let store: Awaited<ReturnType<typeof openStore>>;
let projectId: string;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'noir-mem-cap-'));
  projectId = createProjectId();
  store = await openStore({ projectId, root });
});
afterEach(async () => {
  await store.close();
  rmSync(root, { recursive: true, force: true });
});

describe('saveCaptured', () => {
  it('persists with a capture provenance source', async () => {
    const mem = createMemoryEngine({ store, root, projectId, embed: fakeEmbedFn() });
    const obs = await mem.saveCaptured({ content: 'BE session distilled decision: drop offset param' }, captureSource('Stop'));
    expect(obs.source).toBe('auto:stop');
    const hit = await mem.recall('offset param decision');
    expect(hit[0]?.source).toBe('auto:stop');
  });
});
