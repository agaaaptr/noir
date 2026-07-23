import type { ProjectInfo } from '@noir-ai/core';
import { describe, expect, it } from 'vitest';
import { buildStatus } from '../src/status.js';

const project: ProjectInfo = {
  id: '11111111-2222-3333-4444-555555555555',
  name: 'demo',
  root: '/tmp/demo',
  config: { host: 'claude', mode: 'full', daemon: { idleTimeoutSec: 900 } },
};

describe('buildStatus', () => {
  it('stdio, no daemon', () => {
    const s = buildStatus(project, { transport: 'stdio', daemon: false });
    expect(s).toMatchObject({
      noir: expect.any(String),
      host: 'claude',
      transport: 'stdio',
      daemon: false,
    });
    expect(s.project).toEqual({ id: project.id, name: 'demo' });
    expect(s).not.toHaveProperty('pid');
    expect(s).not.toHaveProperty('uptimeSec');
  });
  it('daemon includes pid and uptime', () => {
    const startedAt = Date.now() - 5_000;
    const s = buildStatus(project, {
      transport: 'streamable-http',
      daemon: true,
      pid: 1234,
      startedAt,
    });
    expect(s.daemon).toBe(true);
    expect(s.transport).toBe('streamable-http');
    expect(s.pid).toBe(1234);
    expect(s.uptimeSec).toBeGreaterThanOrEqual(5);
  });
});
