// `noir context index --force` CLI threading tests (task E1).
//
// daemon-client is mocked at the module boundary (no real daemon / HTTP — NF4),
// mirroring context.test.ts. These pin the CLI contract:
//   • --force → `context_index` is called with `{force:true}` (the daemon does
//     the full reindex);
//   • no --force → the `force` key is omitted from the tool args (incremental);
//   • the old "recognized but not yet honored" notice is GONE — no stderr output
//     on the force path beyond the normal rendering.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { payloads } = vi.hoisted(() => ({ payloads: { current: {} as Record<string, unknown> } }));

vi.mock('../src/daemon-client.js', () => ({
  callDaemonTool: vi.fn(
    async (_opts: unknown, name: string, _args?: Record<string, unknown>) => payloads.current[name],
  ),
  withDaemon: vi.fn(async (_opts: unknown, fn: (c: unknown) => Promise<unknown>) =>
    fn({ listTools: async () => Object.keys(payloads.current) }),
  ),
}));

import { contextIndex } from '../src/commands/context.js';
import { callDaemonTool } from '../src/daemon-client.js';

function reset(): void {
  payloads.current = {
    context_index: {
      ok: true,
      indexed: 7,
      skipped: 3,
      deleted: 1,
      failed: 0,
      totalChunks: 10,
      degraded: false,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  reset();
});

const base = {};

describe('context index --force', () => {
  it('--force threads {force:true} to the daemon context_index call', async () => {
    await contextIndex({ ...base, force: true });
    expect(vi.mocked(callDaemonTool)).toHaveBeenCalledWith(expect.anything(), 'context_index', {
      force: true,
    });
  });

  it('omits the force key (incremental) when --force is absent', async () => {
    await contextIndex({ ...base });
    expect(vi.mocked(callDaemonTool)).toHaveBeenCalledWith(expect.anything(), 'context_index', {});
  });

  it('omits the force key when --force is false', async () => {
    await contextIndex({ ...base, force: false });
    expect(vi.mocked(callDaemonTool)).toHaveBeenCalledWith(expect.anything(), 'context_index', {});
  });

  it('--force with paths sends both force and paths', async () => {
    await contextIndex({ ...base, force: true, paths: ['src'] });
    expect(vi.mocked(callDaemonTool)).toHaveBeenCalledWith(expect.anything(), 'context_index', {
      force: true,
      paths: ['src'],
    });
  });

  it('--force no longer prints the "recognized but not yet honored" notice', async () => {
    const err: string[] = [];
    const e = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: unknown) => {
      err.push(typeof c === 'string' ? c : String(c));
      return true;
    }) as typeof process.stderr.write;
    try {
      await contextIndex({ ...base, force: true });
      expect(err.join('')).not.toContain('not yet honored');
    } finally {
      process.stderr.write = e;
    }
  });
});
