import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openStore } from '../src/sqlite-store.js';

describe('openStore dbPath override', () => {
  it('opens the db at an explicit path when dbPath is given', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noir-store-dbpath-'));
    const target = join(root, 'custom', 'ws.db');
    try {
      const store = await openStore({ projectId: 'ws-a', root, dbPath: target });
      await store.close();
      expect(existsSync(target)).toBe(true);
      // no nested <root>/.noir created when dbPath overrides
      expect(readdirSync(root)).not.toContain('.noir');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
