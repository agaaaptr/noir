import { describe, expect, it } from 'vitest';
import { buildUpdateTarget } from '../src/commands/update.js';

describe('buildUpdateTarget (pure)', () => {
  it('uses the active method + target channel', () => {
    const t = buildUpdateTarget({
      method: 'npm',
      channel: 'latest',
      spec: undefined,
      currentVersion: '1.5.0',
      latestKnown: '1.6.0',
    });
    expect(t).toEqual({
      method: 'npm',
      targetSpec: 'latest',
      currentVersion: '1.5.0',
      latestKnown: '1.6.0',
      isUpgrade: true,
    });
  });
  it('isUpgrade false when already current', () => {
    const t = buildUpdateTarget({
      method: 'native',
      channel: 'latest',
      spec: undefined,
      currentVersion: '1.6.0',
      latestKnown: '1.6.0',
    });
    expect(t.isUpgrade).toBe(false);
  });
});
