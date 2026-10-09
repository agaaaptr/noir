// Prose tells: the markers that make generated prose read as machine output,
// from em-dash density to hedging openers and formulaic not-X-but-Y contrasts.
// `humanizerFindings` is a pure scan of a text that has had fenced code
// stripped, so the rules never read inside ``` blocks.
import type { HygieneFinding } from './hygiene.js';
import { firstMatch, lineOf, paragraphsOf, proseOnly } from './text-scan.js';

const HEDGES = [
  'it is worth mentioning',
  'it should be noted',
  'it goes without saying',
  'arguably',
] as const;

// More em-dashes than this in one paragraph is the tell the finder reports.
const EM_DASH_PER_PARAGRAPH = 2;

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
