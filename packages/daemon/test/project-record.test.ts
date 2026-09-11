import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

const tmpRoot = mkdtempSync(join(tmpdir(), 'noir-project-record-'));
process.env.NOIR_DAEMON_DIR = tmpRoot;

const {
  projectRecordPath,
  readProjectDaemonRecord,
  writeProjectDaemonRecord,
  clearProjectDaemonRecord,
  listProjectDaemonRecords,
} = await import('../src/project-record.js');

describe('project-record', () => {
  beforeEach(() => {
    mkdirSync(tmpRoot, { recursive: true });
  });

  it('honors the NOIR_DAEMON_DIR override', () => {
    expect(projectRecordPath('p1')).toBe(join(tmpRoot, 'p1.json'));
  });

  it('round-trips a record per project', () => {
    writeProjectDaemonRecord('p1', { pid: 1, port: 5001, startedAt: 7, projectId: 'p1' });
    writeProjectDaemonRecord('p2', { pid: 2, port: 5002, startedAt: 8, projectId: 'p2' });
    expect(readProjectDaemonRecord('p1')?.port).toBe(5001);
    expect(readProjectDaemonRecord('p2')?.port).toBe(5002);
  });

  it('is isolated: clearing p1 leaves p2 intact', () => {
    writeProjectDaemonRecord('p1', { pid: 1, port: 5001, startedAt: 7, projectId: 'p1' });
    writeProjectDaemonRecord('p2', { pid: 2, port: 5002, startedAt: 8, projectId: 'p2' });
    clearProjectDaemonRecord('p1');
    expect(readProjectDaemonRecord('p1')).toBeNull();
    expect(readProjectDaemonRecord('p2')?.pid).toBe(2);
  });

  it('returns null for absent or malformed records', () => {
    expect(readProjectDaemonRecord('nope')).toBeNull();
    writeFileSync(projectRecordPath('bad'), '{not json');
    expect(readProjectDaemonRecord('bad')).toBeNull();
  });

  it('lists every project record on the machine', () => {
    writeProjectDaemonRecord('p1', { pid: 1, port: 5001, startedAt: 7, projectId: 'p1' });
    writeProjectDaemonRecord('p2', { pid: 2, port: 5002, startedAt: 8, projectId: 'p2' });
    expect(
      listProjectDaemonRecords()
        .map((r) => r.projectId)
        .sort(),
    ).toEqual(['p1', 'p2']);
  });
});
