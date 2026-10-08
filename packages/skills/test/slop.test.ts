import { describe, expect, it } from 'vitest';
import { slopFindings } from '../src/slop.js';

describe('slopFindings', () => {
  it('flags a kill-on-sight word', () => {
    const f = slopFindings('We will leverage this insight.');
    expect(f.map((x) => x.id)).toContain('slop-kill');
    expect(f[0]?.line).toBe(1);
  });

  it('flags a paragraph with three cluster words but not two', () => {
    const three = slopFindings('A robust, seamless, and scalable platform.');
    const two = slopFindings('A robust and seamless platform.');
    expect(three.some((x) => x.id === 'slop-cluster')).toBe(true);
    expect(two.some((x) => x.id === 'slop-cluster')).toBe(false);
  });

  it('does not scan fenced code blocks', () => {
    const f = slopFindings('```ts\nconst robust = seamless();\n```');
    expect(f).toEqual([]);
  });

  it('allows an allowlisted cluster word used legitimately', () => {
    const f = slopFindings(
      'The test harness runs the test harness, then the test harness reports.',
    );
    expect(f.some((x) => x.id === 'slop-cluster')).toBe(false);
    expect(f).toEqual([]);
  });

  it('reports 1-based lines for every finding', () => {
    const f = slopFindings(
      'First line.\n\nSecond paragraph uses leverage.\n\nThird paragraph is robust, seamless, and scalable.',
    );
    expect(f.find((x) => x.id === 'slop-kill')?.line).toBe(3);
    expect(f.find((x) => x.id === 'slop-cluster')?.line).toBe(5);
  });
});
