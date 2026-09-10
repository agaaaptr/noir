// `noir memory capture` regression — content/file/eventType resolution → the
// daemon `memory_capture` tool, with capture provenance (ADR-0009). daemon-client
// is mocked at the boundary (no real daemon); the CLI command under test is real.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { payloads } = vi.hoisted(() => ({
  payloads: { current: {} as Record<string, unknown> },
}));

vi.mock('../src/daemon-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/daemon-client.js')>();
  return {
    ...actual,
    callDaemonTool: vi.fn(
      async (_opts: unknown, name: string, _args?: Record<string, unknown>) =>
        payloads.current[name],
    ),
    probeDaemon: vi.fn(async () => ({ running: true })),
  };
});

import { memoryCapture } from '../src/commands/memory.js';
import { callDaemonTool } from '../src/daemon-client.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-mem-cap-'));
  payloads.current = {
    memory_capture: {
      ok: true,
      id: 'cap-1',
      observation: { id: 'cap-1', content: 'captured', source: 'auto:stop' },
    },
  };
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('noir memory capture', () => {
  it('--content + --event-type forward to memory_capture', async () => {
    await memoryCapture({ content: 'distilled decision', eventType: 'Stop' });
    expect(vi.mocked(callDaemonTool)).toHaveBeenCalledWith(expect.anything(), 'memory_capture', {
      content: 'distilled decision',
      eventType: 'Stop',
    });
  });

  it('--file reads the file and forwards its content', async () => {
    const f = join(root, 'notes.md');
    writeFileSync(f, 'session summary text', 'utf8');
    await memoryCapture({ file: f });
    expect(vi.mocked(callDaemonTool)).toHaveBeenCalledWith(expect.anything(), 'memory_capture', {
      content: 'session summary text',
    });
  });
});
