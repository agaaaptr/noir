// `noir mcp serve` (HTTP branch) — the two defects the final verification found:
//
//   1. `daemon.port` was dropped on the floor: serve called ensureDaemonRunning
//      with only idleTimeoutSec, so a project that pins a stable daemon port got
//      an ephemeral one — the configured address never matched.
//   2. The success line named the URL alone, but `/mcp` requires
//      `Authorization: Bearer <token>` (T5) — a client handed only the URL gets
//      a 401. The line must point at `noir daemon token` WITHOUT printing it.
//
// The daemon boundary is mocked (no daemon, no HTTP, no store); `@noir-ai/core`
// is importOriginal'd with only loadProjectInfo/applyNoirEnv overridden so
// `parseConfig` still builds a REAL config object (typed NoirConfig).
import type { NoirConfig, ProjectInfo } from '@noir-ai/core';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

const { ensureDaemonRunningMock, startStdioServerMock } = vi.hoisted(() => ({
  ensureDaemonRunningMock: vi.fn(async () => ({
    port: 4321,
    url: 'http://127.0.0.1:4321/mcp',
  })),
  startStdioServerMock: vi.fn(async () => {}),
}));
vi.mock('@noir-ai/daemon', () => ({
  ensureDaemonRunning: ensureDaemonRunningMock,
  startStdioServer: startStdioServerMock,
}));

const { loadProjectInfoMock, applyNoirEnvMock } = vi.hoisted(() => ({
  loadProjectInfoMock: vi.fn(),
  applyNoirEnvMock: vi.fn(() => ({})),
}));
vi.mock('@noir-ai/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@noir-ai/core')>();
  return { ...actual, applyNoirEnv: applyNoirEnvMock, loadProjectInfo: loadProjectInfoMock };
});

import { parseConfig } from '@noir-ai/core';
import { serve } from '../src/serve.js';

function fakeProject(config: NoirConfig): ProjectInfo {
  return { id: 'serve-test', name: 'serve-test', root: '/tmp/noir-serve-test', config };
}

describe('noir mcp serve — daemon wiring', () => {
  let stderr: MockInstance<typeof process.stderr.write>;

  beforeEach(() => {
    // Default: a project that PINS daemon.port (the value the fix threads).
    loadProjectInfoMock.mockReturnValue(
      fakeProject(parseConfig({ daemon: { idleTimeoutSec: 900, port: 4321 } })),
    );
  });

  afterEach(() => {
    stderr?.mockRestore();
    vi.clearAllMocks();
  });

  /** Capture stderr for one `serve({stdio:false})` call. */
  async function runServe(): Promise<string> {
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await serve({ stdio: false });
    return stderr.mock.calls.map((c) => String(c[0])).join('');
  }

  it('threads the configured daemon.port into ensureDaemonRunning', async () => {
    await runServe();
    expect(ensureDaemonRunningMock).toHaveBeenCalledWith({
      project: expect.objectContaining({ id: 'serve-test' }),
      idleTimeoutSec: 900,
      port: 4321,
    });
  });

  it('omits port when the project does not configure one', async () => {
    loadProjectInfoMock.mockReturnValue(
      fakeProject(parseConfig({ daemon: { idleTimeoutSec: 900 } })),
    );
    await runServe();
    expect(ensureDaemonRunningMock).toHaveBeenCalledWith({
      project: expect.objectContaining({ id: 'serve-test' }),
      idleTimeoutSec: 900,
    });
  });

  it('tells the client how to authenticate (bearer token) without printing it', async () => {
    const err = await runServe();
    expect(err).toContain('http://127.0.0.1:4321/mcp');
    expect(err).toContain('headersHelper');
    expect(err).toContain('noir daemon token');
  });
});
