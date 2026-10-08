// Prose tells: the markers that make generated prose read as machine output,
// from em-dash density to hedging openers and formulaic not-X-but-Y contrasts.
// `humanizerFindings` is a pure scan of a text that has had fenced code
// stripped, so the rules never read inside ``` blocks.
import type { HygieneFinding } from './hygiene.js';

const HEDGES = [
  'it is worth mentioning',
  'it should be noted',
  'it goes without saying',
  'arguably',
] as const;

// More em-dashes than this in one paragraph is the tell the finder reports.
const EM_DASH_PER_PARAGRAPH = 2;

// Strip fenced code so prose rules never read inside ``` blocks.
function proseOnly(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '');
}

/** The 1-based line of the character at `index`: one plus the count of newlines
 *  before it. */
function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === '\n') line++;
  return line;
}

/** The index of the first match, or -1 when the pattern matches nothing. */
function firstMatch(text: string, re: RegExp): number {
  const match = re.exec(text);
  return match ? match.index : -1;
}

/** Yields each paragraph with the 1-based line it starts on. An empty line ends
 *  a paragraph, so a single line break continues the paragraph. */
function* paragraphsOf(text: string): Generator<{ text: string; line: number }> {
  let paragraph = '';
  let startLine = 1;
  let line = 1;
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') {
      if (paragraph.trim() !== '') yield { text: paragraph, line: startLine };
      paragraph = '';
      startLine = line + 1;
    } else {
      if (paragraph === '') startLine = line;
      paragraph += (paragraph === '' ? '' : '\n') + raw;
    }
    line++;
  }
  if (paragraph.trim() !== '') yield { text: paragraph, line: startLine };
}

export function humanizerFindings(text: string): HygieneFinding[] {
  const prose = proseOnly(text);
  const findings: HygieneFinding[] = [];

  for (const hedge of HEDGES) {
    const index = firstMatch(prose, new RegExp(hedge, 'i'));
    if (index !== -1) {
      findings.push({
        id: 'humanizer-hedge',
        tier: 'warn',
        line: lineOf(prose, index),
        text: hedge,
        rationale: 'a hedging opener',
        fix: 'delete it',
      });
    }
  }

  const contrastIndex = firstMatch(prose, /\bnot\s+\w+[\w\s,]{0,40}\bbut\b/i);
  if (contrastIndex !== -1) {
    findings.push({
      id: 'humanizer-contrast',
      tier: 'warn',
      line: lineOf(prose, contrastIndex),
      text: 'not X but Y',
      rationale: 'a formulaic contrast',
      fix: 'state the second clause alone',
    });
  }

  for (const { text: paragraph, line } of paragraphsOf(prose)) {
    const count = (paragraph.match(/—/g) ?? []).length;
    if (count > EM_DASH_PER_PARAGRAPH) {
      findings.push({
        id: 'humanizer-em-dash',
        tier: 'warn',
        line,
        text: `${count} em-dashes`,
        rationale: 'em-dash density is an AI tell',
        fix: 'use periods or parentheticals',
      });
    }
  }

  return findings;
}
