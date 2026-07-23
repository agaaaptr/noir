import { describe, expect, it } from 'vitest';
import { createProjectId } from '../src/project-id.js';

describe('createProjectId', () => {
  it('returns a non-empty string', () => {
    const id = createProjectId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });
  it('is unique across calls', () => {
    expect(createProjectId()).not.toBe(createProjectId());
  });
});
