// `noir sync --check` — the CI drift gate: a dry-run that flips the exit code
// when any managed artifact would change. Never writes.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffold } from '@noir-ai/create';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sync } from '../src/sync.js';

let root: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'noir-sync-check-'));
  process.exitCode = 0;
  await scaffold({ root, mode: 'init', transport: 'stdio' });
});

afterEach(() => {
  process.exitCode = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe('noir sync --check', () => {
  it('leaves exit code 0 when every managed file is current', async () => {
    await sync(root, { check: true });
    expect(process.exitCode).toBe(0);
  });

  it('exits 1 when a managed file would change (missing .mcp.json)', async () => {
    rmSync(join(root, '.mcp.json'));
    await sync(root, { check: true });
    expect(process.exitCode).toBe(1);
  });
});
