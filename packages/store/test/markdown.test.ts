import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectId } from '@noir-ai/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore } from '../src/sqlite-store.js';

let root: string;
let id: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-store-markdown-'));
  id = createProjectId();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const DOCS = [
  {
    id: 'noir-overview',
    source: 'spec',
    content: 'Noir is a discipline layer for agentic CLIs.',
  },
  {
    id: 'clickup-guide',
    source: 'docs',
    content: 'ClickUp integration guide for Noir.',
  },
] as const;

async function openAndIndex() {
  const store = await openStore({ projectId: id, root });
  for (const d of DOCS) {
    store.indexDoc({ id: d.id, source: d.source, content: d.content });
  }
  return store;
}

describe('markdown export', () => {
  it('exports docs to markdown files with frontmatter', async () => {
    const store = await openAndIndex();
    try {
      const exportDir = mkdtempSync(join(tmpdir(), 'noir-export-'));
      const paths = await store.exportMarkdown(exportDir);

      // Should return 2 file paths
      expect(paths).toHaveLength(2);
      expect(paths).toContain(join(exportDir, 'noir-overview.md'));
      expect(paths).toContain(join(exportDir, 'clickup-guide.md'));

      // Files should exist
      for (const p of paths) {
        const content = readFileSync(p, 'utf8');
        // Should contain frontmatter
        expect(content).toMatch(/^---$/m);
        expect(content).toMatch(/^id: /m);
        expect(content).toMatch(/^source: /m);
        expect(content).toMatch(/^---$/m);
        // Should contain the doc content
        expect(content.length).toBeGreaterThan(0);
      }

      // Verify specific frontmatter and content for each file
      const overviewContent = readFileSync(join(exportDir, 'noir-overview.md'), 'utf8');
      expect(overviewContent).toContain('id: noir-overview');
      expect(overviewContent).toContain('source: spec');
      expect(overviewContent).toContain('Noir is a discipline layer for agentic CLIs.');

      const clickupContent = readFileSync(join(exportDir, 'clickup-guide.md'), 'utf8');
      expect(clickupContent).toContain('id: clickup-guide');
      expect(clickupContent).toContain('source: docs');
      expect(clickupContent).toContain('ClickUp integration guide for Noir.');
    } finally {
      await store.close();
    }
  });

  it('works in read-only mode', async () => {
    // Create and populate in read-write mode
    await (await openAndIndex()).close();

    // Reopen in read-only mode
    const store = await openStore({ projectId: id, root, readonly: true });
    try {
      const exportDir = mkdtempSync(join(tmpdir(), 'noir-export-readonly-'));
      const paths = await store.exportMarkdown(exportDir);

      // Should still return 2 file paths
      expect(paths).toHaveLength(2);
      expect(paths).toContain(join(exportDir, 'noir-overview.md'));
      expect(paths).toContain(join(exportDir, 'clickup-guide.md'));

      // Files should exist and contain content
      const overviewContent = readFileSync(join(exportDir, 'noir-overview.md'), 'utf8');
      expect(overviewContent).toContain('Noir is a discipline layer');
    } finally {
      await store.close();
    }
  });
});

// Universal conflict contract. exportMarkdown routes through the SAME
// onConflict seam `regenerate` uses. Default behavior stays v1.2 (overwrite);
// when a resolver is wired + interactive, a differing existing file consults
// it; non-interactive guards prevent a prompt under CI/--json.
describe('markdown export — conflict seam', () => {
  it('default (no opts) overwrites differing content (v1.2 behavior)', async () => {
    const store = await openAndIndex();
    try {
      const exportDir = mkdtempSync(join(tmpdir(), 'noir-export-conflict-'));
      mkdirSync(exportDir, { recursive: true });
      // Pre-populate a user file that exportMarkdown would clobber.
      writeFileSync(join(exportDir, 'noir-overview.md'), 'USER-EDIT', 'utf8');
      const paths = await store.exportMarkdown(exportDir);
      expect(paths).toContain(join(exportDir, 'noir-overview.md'));
      // Overwritten with the rendered template bytes (default policy).
      const after = readFileSync(join(exportDir, 'noir-overview.md'), 'utf8');
      expect(after).toContain('Noir is a discipline layer');
    } finally {
      await store.close();
    }
  });

  it('onConflict=preserve keeps the user file (excluded from written paths)', async () => {
    const store = await openAndIndex();
    try {
      const exportDir = mkdtempSync(join(tmpdir(), 'noir-export-preserve-'));
      mkdirSync(exportDir, { recursive: true });
      writeFileSync(join(exportDir, 'noir-overview.md'), 'USER-EDIT', 'utf8');
      const onConflict = vi.fn((): 'preserve' => 'preserve');
      const paths = await store.exportMarkdown(exportDir, { onConflict, interactive: true });
      expect(onConflict).toHaveBeenCalledTimes(1);
      // The preserved file is NOT in the written list.
      expect(paths).not.toContain(join(exportDir, 'noir-overview.md'));
      expect(readFileSync(join(exportDir, 'noir-overview.md'), 'utf8')).toBe('USER-EDIT');
    } finally {
      await store.close();
    }
  });

  it('does NOT consult under non-interactive (CI/--json never prompts)', async () => {
    const store = await openAndIndex();
    try {
      const exportDir = mkdtempSync(join(tmpdir(), 'noir-export-ni-'));
      mkdirSync(exportDir, { recursive: true });
      writeFileSync(join(exportDir, 'noir-overview.md'), 'USER-EDIT', 'utf8');
      const onConflict = vi.fn((): 'preserve' => 'preserve');
      await store.exportMarkdown(exportDir, { onConflict, interactive: false });
      expect(onConflict).not.toHaveBeenCalled();
    } finally {
      await store.close();
    }
  });
});
