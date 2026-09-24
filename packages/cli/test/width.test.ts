// Unit tests for the shared display-width module.
//
// These pin the behaviours the rest of the CLI relies on when it lays text out
// in columns. `String.length` is a UTF-16 code-unit count, so it miscounts in
// three separate ways that all show up in the terminal: it counts ANSI colour
// escapes as if they were printable, it counts an emoji as two cells because it
// is a surrogate pair, and it counts a wide CJK character as one cell when a
// terminal gives it two. Everything below is a case where those three diverge
// from what is actually drawn.
import { describe, expect, it } from 'vitest';
import { displayWidth, padToWidth, truncateMiddle, truncateToWidth } from '../src/width.js';

/** True when `s` contains a high surrogate with no low one after it, or vice versa. */
function hasLoneSurrogate(s: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}

/** Grapheme clusters as a terminal-driven segmenter sees them. */
function graphemeCount(s: string): number {
  return clusterList(s).length;
}

/** Grapheme clusters as a terminal-driven segmenter sees them, in order. */
function clusterList(s: string): string[] {
  return [...new Intl.Segmenter().segment(s)].map(({ segment }) => segment);
}

/**
 * A truncated result may only be whole clusters of its input, in order: the
 * body must equal the input's leading run of clusters, so nothing is split,
 * reordered or invented. `marker` is taken off the end first.
 */
function expectWholeLeadingClusters(text: string, result: string, marker = '…'): void {
  const body = result.endsWith(marker) ? result.slice(0, -marker.length) : result;
  const produced = clusterList(body);
  const original = clusterList(text);

  expect(hasLoneSurrogate(result)).toBe(false);
  expect(produced).toEqual(original.slice(0, produced.length));
}

describe('displayWidth', () => {
  it('does not count ANSI SGR escape sequences', () => {
    const coloured = '\u001b[33m⚠ WARN\u001b[39m';

    expect(displayWidth(coloured)).toBe(6);
  });

  it('measures the coloured and uncoloured forms of the same text alike', () => {
    expect(displayWidth('\u001b[33m⚠ WARN\u001b[39m')).toBe(displayWidth('⚠ WARN'));
  });

  it('counts a wide character as two columns', () => {
    expect(displayWidth('中')).toBe(2);
    expect(displayWidth('中文')).toBe(4);
  });

  it('counts an emoji as two columns, not as its two code units', () => {
    expect('👍'.length).toBe(2);
    expect(displayWidth('👍')).toBe(2);
  });

  it('does not count a combining mark beyond its grapheme', () => {
    const decomposed = 'é';

    expect(decomposed.length).toBe(2);
    expect(displayWidth(decomposed)).toBeLessThanOrEqual(graphemeCount(decomposed));
    expect(displayWidth(decomposed)).toBe(1);
  });

  it('measures a base plus a variation selector as the one emoji cluster it is', () => {
    // The base character alone is one column, but base + VS16 draws as a single
    // two-column emoji. Measuring the code points separately under-counts it,
    // which is the direction that overflows a budget.
    expect(displayWidth('⚠')).toBe(1);
    expect(displayWidth('⚠️')).toBe(2);
    expect(displayWidth('✅')).toBe(2);
    expect(displayWidth('❤️')).toBe(2);
    expect(displayWidth('▶️')).toBe(2);
    expect(displayWidth('ℹ️')).toBe(2);
  });

  it('measures a whole string as the sum of its clusters', () => {
    // The truncators charge cluster by cluster over the ANSI-stripped text and
    // then re-join, so the two measures must agree or a truncated result could
    // land over its budget. Only plain text is listed: an escape sequence is
    // never a cluster `displayWidth` sees, because it is removed before
    // measuring.
    const samples = [
      '⚠️ Deploy failed on prod-cluster',
      '✅ 3 checks passed',
      '👍🏽 shipped',
      '👨👩👧 team',
      '中文字符串',
      'égalité',
      'plain ascii text',
    ];

    for (const sample of samples) {
      const summed = clusterList(sample).reduce(
        (total, cluster) => total + displayWidth(cluster),
        0,
      );

      expect(summed, JSON.stringify(sample)).toBe(displayWidth(sample));
    }
  });

  it('is not fooled by a run of code points that render as nothing', () => {
    expect(displayWidth('')).toBe(0);
    expect(displayWidth('\u001b[0m')).toBe(0);
  });
});

describe('truncateToWidth', () => {
  it('returns the input unchanged when it already fits', () => {
    expect(truncateToWidth('abc', 3)).toBe('abc');
    expect(truncateToWidth('abc', 99)).toBe('abc');
  });

  it('returns an empty string for a non-positive budget', () => {
    expect(truncateToWidth('abcdef', 0)).toBe('');
    expect(truncateToWidth('abcdef', -5)).toBe('');
  });

  it('counts the ellipsis inside the budget, not on top of it', () => {
    const result = truncateToWidth('abcdefgh', 5);

    expect(result).toBe('abcd…');
    expect(displayWidth(result)).toBe(5);
  });

  it('never spends the budget on a partial wide character', () => {
    // Three double-width glyphs need six columns; a five-column budget can
    // afford the ellipsis plus two of them, and never a half of the third.
    const result = truncateToWidth('中中中', 5);

    expect(result).toBe('中中…');
    expect(displayWidth(result)).toBe(5);
  });

  it('never splits a surrogate pair', () => {
    const emoji = '👍'.repeat(4);

    expect(hasLoneSurrogate(truncateToWidth(emoji, 5))).toBe(false);
    expect(truncateToWidth(emoji, 5)).toBe('👍👍…');
  });

  it('stays within budget and never splits a surrogate pair across astral code points', () => {
    // A property sweep rather than a fixed case list: every astral code point
    // is a surrogate pair in UTF-16, so an index-based cut anywhere in the
    // plane would surface here as a lone surrogate or an over-wide result.
    for (let codePoint = 0x1_00_00; codePoint <= 0x10_ff_ff; codePoint += 0x1_00) {
      const text = String.fromCodePoint(codePoint).repeat(6);
      const full = displayWidth(text);

      for (let width = 1; width <= 12; width++) {
        const result = truncateToWidth(text, width);
        const context = `U+${codePoint.toString(16).toUpperCase()} at width ${width}`;

        expect(hasLoneSurrogate(result), context).toBe(false);
        expect(displayWidth(result), context).toBeLessThanOrEqual(width);

        // Truncation may only drop whole code points from the tail and then
        // append the marker, so the body must be a prefix of the input.
        expect(text.startsWith(result.slice(0, -1)), context).toBe(true);
        if (width < full) {
          expect(result.endsWith('…'), context).toBe(true);
        }
      }
    }
  });

  it('uses a custom marker and never lets it overflow the budget', () => {
    expect(truncateToWidth('abcdefgh', 6, '...')).toBe('abc...');
    expect(truncateToWidth('abcdefgh', 2, '...')).toBe('..');
    expect(displayWidth(truncateToWidth('abcdefgh', 1, '...'))).toBeLessThanOrEqual(1);
  });

  it('stays within budget for a variation-selector emoji', () => {
    // Regression: charging the base and its VS16 separately spent one column
    // too few, so the result came out a column wider than asked for.
    const text = '⚠️ Deploy failed on prod-cluster';
    const result = truncateToWidth(text, 12);

    expect(result).toBe('⚠️ Deploy f…');
    expect(displayWidth(result)).toBe(12);
    expectWholeLeadingClusters(text, result);
  });

  it('never splits an emoji cluster, only drops whole ones', () => {
    // A skin-tone modifier and a zero-width joiner sequence are each a single
    // cluster whose parts measure more apart than together: '👍🏽' is four code
    // units and eight columns if you count each one, but one cluster of two.
    const samples = [
      '⚠️ Deploy failed on prod-cluster',
      '✅ 3 checks passed, 1 skipped',
      '❤️ favourited by 12 people',
      '▶️ playing now on the dashboard',
      'ℹ️ see the run log for details',
      '👍🏽 shipped to production',
      '👨👩👧 team dashboard',
      '中文字符串与宽字符',
    ];

    for (const text of samples) {
      const full = displayWidth(text);

      for (let width = 1; width <= 16; width++) {
        const result = truncateToWidth(text, width);
        const context = `${JSON.stringify(text)} at width ${width}`;

        expect(displayWidth(result), context).toBeLessThanOrEqual(width);
        expectWholeLeadingClusters(text, result);
        if (width < full) {
          expect(result.endsWith('…'), context).toBe(true);
        }
      }
    }
  });

  it('returns plain text for coloured input instead of destroying it', () => {
    // Regression: the escape's own bytes were being charged as visible columns,
    // so they ate the budget and starved the text; the closing reset was cut
    // off too, leaving the terminal coloured for whatever followed.
    const result = truncateToWidth('\u001b[32mabcdefgh\u001b[39m', 5);

    expect(result).toBe('abcd…');
    expect(result).not.toContain('\u001b');
    expect(displayWidth(result)).toBe(5);
  });

  it('returns plain text for coloured input that already fits', () => {
    expect(truncateToWidth('\u001b[32mabc\u001b[39m', 10)).toBe('abc');
  });
});

describe('padToWidth', () => {
  it('pads to the requested width', () => {
    expect(padToWidth('abc', 6)).toBe('abc   ');
    expect(displayWidth(padToWidth('中', 4))).toBe(4);
  });

  it('returns the input unchanged when it is already at or over budget', () => {
    expect(padToWidth('abcdef', 3)).toBe('abcdef');
    expect(padToWidth('', 0)).toBe('');
  });

  it('pads a coloured string by its visible width', () => {
    const padded = padToWidth('\u001b[33m⚠ WARN\u001b[39m', 10);

    expect(displayWidth(padded)).toBe(10);
  });
});

describe('truncateMiddle', () => {
  it('returns the input unchanged when it already fits', () => {
    expect(truncateMiddle('/a/b.ts', 20)).toBe('/a/b.ts');
  });

  it('returns an empty string for a non-positive budget', () => {
    expect(truncateMiddle('/a/b.ts', 0)).toBe('');
  });

  it('keeps the leading and trailing segments of a long path', () => {
    const path = '/very/long/directory/tree/final-segment.ts';
    const result = truncateMiddle(path, 22);

    expect(result.startsWith('/very/long/')).toBe(true);
    expect(result.endsWith('segment.ts')).toBe(true);
    expect(result).toContain('…');
    expect(displayWidth(result)).toBeLessThanOrEqual(22);
  });

  it('spends the budget on both ends rather than draining one', () => {
    const result = truncateMiddle('0123456789abcdefghij', 8);

    expect(result).toBe('0123…hij');
  });

  it('never splits a surrogate pair', () => {
    const result = truncateMiddle('👍'.repeat(6), 5);

    expect(hasLoneSurrogate(result)).toBe(false);
    expect(displayWidth(result)).toBeLessThanOrEqual(5);
  });

  it('does not repeat content when head and tail meet', () => {
    expect(truncateMiddle('abcdefgh', 7)).toBe('abc…fgh');
    expect(truncateMiddle('abc', 2)).toBe('a…');
  });

  it('stays within budget for a variation-selector emoji', () => {
    // Regression: the same under-count that broke `truncateToWidth` also let
    // `truncateMiddle` return a result one column wider than asked for.
    const path = '/srv/⚠️/data/some-file.txt';
    const result = truncateMiddle(path, 12);

    expect(result).toBe('/srv/…e.txt');
    expect(displayWidth(result)).toBeLessThanOrEqual(12);
    expect(hasLoneSurrogate(result)).toBe(false);
  });

  it('keeps whole clusters at the head and tail', () => {
    const samples = [
      '⚠️ Deploy failed on prod-cluster',
      '✅ 3 checks passed, 1 skipped',
      '👍🏽 shipped to production',
      '👨👩👧 team dashboard',
    ];

    for (const text of samples) {
      for (let width = 1; width <= 12; width++) {
        const result = truncateMiddle(text, width);
        const context = `${JSON.stringify(text)} at width ${width}`;

        expect(displayWidth(result), context).toBeLessThanOrEqual(width);
        expect(hasLoneSurrogate(result), context).toBe(false);

        const [head, tail] = result.split('…');
        const original = clusterList(text);
        const headClusters = clusterList(head ?? '');
        const tailClusters = clusterList(tail ?? '');

        expect(headClusters, context).toEqual(original.slice(0, headClusters.length));
        expect(tailClusters, context).toEqual(
          original.slice(original.length - tailClusters.length),
        );
      }
    }
  });

  it('returns plain text for coloured input', () => {
    const result = truncateMiddle('\u001b[32m/very/long/path/file.ts\u001b[39m', 12);

    expect(result).not.toContain('\u001b');
    expect(displayWidth(result)).toBeLessThanOrEqual(12);
    expect(result).toBe('/very/…le.ts');
  });
});
