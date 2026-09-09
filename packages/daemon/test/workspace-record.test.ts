import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { clearWorkspaceDaemonRecord, readWorkspaceDaemonRecord, writeWorkspaceDaemonRecord } from '../src/workspace-record.js';

const home = mkdtempSync(join(tmpdir(), 'noir-wsrec-'));
process.env.NOIR_WORKSPACES_DIR = join(home, 'workspaces');
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('workspace daemon record', () => {
  it('round-trips and is keyed by workspace name', () => {
    clearWorkspaceDaemonRecord('my-app');
    expect(readWorkspaceDaemonRecord('my-app')).toBeNull();
    writeWorkspaceDaemonRecord('my-app', { pid: 1234, port: 4321, startedAt: 1, workspace: 'my-app' });
    const rec = readWorkspaceDaemonRecord('my-app');
    expect(rec?.pid).toBe(1234);
    expect(rec?.workspace).toBe('my-app');
    // other workspace's record unaffected
    expect(readWorkspaceDaemonRecord('other')).toBeNull();
    clearWorkspaceDaemonRecord('my-app');
    expect(readWorkspaceDaemonRecord('my-app')).toBeNull();
  });
});
