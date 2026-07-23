import { describe, expect, it } from 'vitest';
import { NOIR_VERSION } from '../src/index.js';

describe('monorepo smoke', () => {
  it('exposes a version string', () => {
    expect(typeof NOIR_VERSION).toBe('string');
    expect(NOIR_VERSION.length).toBeGreaterThan(0);
  });
});
