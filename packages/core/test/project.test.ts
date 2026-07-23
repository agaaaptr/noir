import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { paths } from '../src/layout.js';
import { loadProjectInfo } from '../src/project.js';
import { createProjectId } from '../src/project-id.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('loadProjectInfo', () => {
  it('reads project.id + config.yml', () => {
    const id = createProjectId();
    mkdirSync(paths.noirDir(root), { recursive: true });
    writeFileSync(paths.projectId(root), id, 'utf8');
    writeFileSync(paths.config(root), 'host: claude\nmode: quick\n', 'utf8');
    const info = loadProjectInfo(root);
    expect(info.id).toBe(id);
    expect(info.config.mode).toBe('quick');
    expect(info.root).toBe(root);
    expect(typeof info.name).toBe('string');
    expect(info.name.length).toBeGreaterThan(0);
  });
  it('throws clearly when not initialized', () => {
    expect(() => loadProjectInfo(root)).toThrow(/noir init/i);
  });
});
