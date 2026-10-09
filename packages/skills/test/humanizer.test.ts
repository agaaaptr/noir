import { describe, expect, it } from 'vitest';
import { humanizerFindings } from '../src/humanizer.js';

describe('humanizerFindings', () => {
  it('flags em-dash density above two per paragraph', () => {
    const f = humanizerFindings('One — two — three — four.');
    expect(f.map((x) => x.id)).toContain('humanizer-em-dash');
  });

  it('flags a hedging opener', () => {
    const f = humanizerFindings('It is worth mentioning that this works.');
    expect(f.map((x) => x.id)).toContain('humanizer-hedge');
  });

  it('flags a not-X-but-Y contrast', () => {
    const f = humanizerFindings('This is not a bug but a feature.');
    expect(f.map((x) => x.id)).toContain('humanizer-contrast');
  });

  it('reports 1-based lines for every finding', () => {
    const f = humanizerFindings(
      'First paragraph.\n\nSecond paragraph has an — em dash — here — and — more.\n\nIt is worth mentioning a hedge.\n\nThis is not a bug but a feature.',
    );
    expect(f.find((x) => x.id === 'humanizer-em-dash')?.line).toBe(3);
    expect(f.find((x) => x.id === 'humanizer-hedge')?.line).toBe(5);
    expect(f.find((x) => x.id === 'humanizer-contrast')?.line).toBe(7);
  });

  it('does not count em-dashes inside a markdown table', () => {
    const table = [
      '| Package | Description | Binary |',
      '|---|---|---|',
      '| `a` | one — two | — |',
      '| `b` | three — four | — |',
      '| `c` | five — six | — |',
    ].join('\n');
    expect(humanizerFindings(table)).toEqual([]);
  });

  it('keeps line numbers past a blanked table', () => {
    const text = [
      '| Package | Description |',
      '|---|---|',
      '| `a` | one — two |',
      '',
      'Three — four — five — six.',
    ].join('\n');
    expect(humanizerFindings(text).find((x) => x.id === 'humanizer-em-dash')?.line).toBe(5);
  });
});
