import { describe, expect, it } from 'vitest';
import { DAEMON_MODE_ENV, pidAlive } from '../src/lifecycle.js';

// The legacy global record (`~/.noir/daemon.json`) and its read/write/clear
// helpers were removed with the per-project-record migration (spec 4.3); those
// round-trip behaviours are covered by `project-record.test.ts` and
// `migrate-legacy-record.test.ts`. What remains in lifecycle.ts is the
// detached-mode marker + the pid liveness probe.
describe('daemon lifecycle helpers', () => {
  it('pidAlive is true for the current process', () => {
    expect(pidAlive(process.pid)).toBe(true);
  });
  it('pidAlive is false for an unlikely pid', () => {
    expect(pidAlive(2_000_000)).toBe(false);
  });
  it('DAEMON_MODE_ENV is the detached-mode marker', () => {
    expect(DAEMON_MODE_ENV).toBe('NOIR_DAEMON_MODE');
  });
});
