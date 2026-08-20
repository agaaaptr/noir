import { describe, expect, it } from 'vitest';
import { createProjectId, isValidProjectId } from '../src/project-id.js';

describe('createProjectId', () => {
  it('returns a non-empty string', () => {
    const id = createProjectId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });
  it('is unique across calls', () => {
    expect(createProjectId()).not.toBe(createProjectId());
  });
  it('produces a path-safe id accepted by isValidProjectId', () => {
    expect(isValidProjectId(createProjectId())).toBe(true);
  });
});

describe('isValidProjectId (path-safe allowlist)', () => {
  it('accepts human-readable slugs and UUIDs', () => {
    for (const id of [
      'proj-test',
      'g1-abc',
      'fixed-id-1234',
      'a',
      '11111111-2222-3333-4444-555555555555',
      'PROJ_123',
      'proj.test',
    ]) {
      expect(isValidProjectId(id)).toBe(true);
    }
  });

  it('rejects path traversal and separators', () => {
    for (const id of ['../etc', '..', '/', '/abs', 'a/b', 'a\\b', '..b', '.', '']) {
      expect(isValidProjectId(id)).toBe(false);
    }
  });

  it('rejects control bytes and the null byte', () => {
    expect(isValidProjectId('a\x00b')).toBe(false);
    expect(isValidProjectId('a\nb')).toBe(false);
    expect(isValidProjectId('a b')).toBe(false);
  });
});
