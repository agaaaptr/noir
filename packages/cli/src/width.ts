// The single authority for how wide text will actually draw in the terminal.
//
// `String.length` is a UTF-16 code-unit count, which is the wrong unit for
// layout: an ANSI colour escape measures as visible even though it draws
// nothing, an emoji is a surrogate pair yet occupies two columns, and a wide
// CJK glyph occupies two columns while counting as one. Every call site that
// lays text out in columns must measure through here so the answer is the
// number of terminal columns the text will occupy, not the number of code
// units it happens to be made of.
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';

/** Terminal grapheme clusters, in order — the unit a renderer draws whole. */
const segmenter = new Intl.Segmenter();

function clusters(s: string): string[] {
  return [...segmenter.segment(s)].map(({ segment }) => segment);
}

/**
 * The number of terminal columns `s` occupies when drawn. ANSI escape
 * sequences are not counted; wide and emoji glyphs count as two columns.
 */
export function displayWidth(s: string): number {
  return stringWidth(s);
}

/**
 * How many of the leading `parts` fit within `width` columns. Each part is
 * charged its whole-cluster width, so a cluster is kept or dropped whole and
 * a surrogate pair can never be split.
 */
function fitLeading(parts: readonly string[], width: number): number {
  let used = 0;
  let count = 0;

  for (const part of parts) {
    const w = displayWidth(part);
    if (used + w > width) {
      break;
    }
    used += w;
    count++;
  }

  return count;
}

/**
 * `s` cut to at most `width` columns, with `ellipsis` marking the cut. The
 * marker is charged against the budget, so the result never exceeds `width`.
 * A marker wider than the budget is itself trimmed rather than allowed to
 * overflow.
 *
 * The result is plain text: ANSI colour escapes are stripped before measuring
 * and are not carried into the output, so the caller must re-apply colour
 * after truncating if it is wanted.
 */
export function truncateToWidth(s: string, width: number, ellipsis = '…'): string {
  const plain = stripAnsi(s);

  if (width <= 0) {
    return '';
  }
  if (displayWidth(plain) <= width) {
    return plain;
  }

  const markerParts = clusters(ellipsis);
  const marker = markerParts.slice(0, fitLeading(markerParts, width)).join('');
  const budget = width - displayWidth(marker);

  const parts = clusters(plain);
  return parts.slice(0, fitLeading(parts, budget)).join('') + marker;
}

/**
 * `s` cut to at most `width` columns by removing the middle, so both the
 * leading and trailing text survive — used for long paths where the start
 * (directory) and end (file name) are the parts that identify it.
 *
 * Like `truncateToWidth`, the result is plain text with ANSI escapes
 * stripped; the caller re-applies colour after truncating.
 */
export function truncateMiddle(s: string, width: number, ellipsis = '…'): string {
  const plain = stripAnsi(s);

  if (width <= 0) {
    return '';
  }
  if (displayWidth(plain) <= width) {
    return plain;
  }

  const markerParts = clusters(ellipsis);
  const marker = markerParts.slice(0, fitLeading(markerParts, width)).join('');
  const remaining = width - displayWidth(marker);
  const headBudget = Math.ceil(remaining / 2);
  const tailBudget = remaining - headBudget;

  const parts = clusters(plain);
  const headCount = fitLeading(parts, headBudget);

  // The tail is drawn from the clusters the head left behind, walking
  // backwards, so the two halves can never claim the same text twice.
  const tail: string[] = [];
  let tailUsed = 0;
  for (const part of parts.slice(headCount).reverse()) {
    const w = displayWidth(part);
    if (tailUsed + w > tailBudget) {
      break;
    }
    tail.push(part);
    tailUsed += w;
  }

  return parts.slice(0, headCount).join('') + marker + tail.reverse().join('');
}

/**
 * `s` right-padded with spaces to exactly `width` columns, measured by
 * display width. Returns `s` untouched when it already fills the width.
 */
export function padToWidth(s: string, width: number): string {
  const pad = width - displayWidth(s);

  return pad > 0 ? s + ' '.repeat(pad) : s;
}
