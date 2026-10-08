// Lexical anti-slop rules: the words and phrases that make generated prose read
// as machine output. `slopFindings` is a pure scan of a text that has had
// fenced code stripped, so prose rules never read inside ``` blocks.
import type { HygieneFinding } from './hygiene.js';

export const KILL_ON_SIGHT = [
  'delve',
  'utilize',
  'leverage',
  'facilitate',
  'elucidate',
  'embark',
  'endeavor',
  'encompass',
  'multifaceted',
  'tapestry',
  'testament',
  'paradigm',
  'synergy',
  'holistic',
  'catalyze',
  'juxtapose',
  'realm',
  'landscape',
  'myriad',
  'plethora',
] as const;

export const CLUSTER_WORDS = [
  'robust',
  'comprehensive',
  'seamless',
  'cutting-edge',
  'innovative',
  'streamline',
  'empower',
  'foster',
  'enhance',
  'elevate',
  'optimize',
  'scalable',
  'pivotal',
  'intricate',
  'profound',
  'resonate',
  'underscore',
  'harness',
  'navigate',
  'cultivate',
  'bolster',
  'galvanize',
  'cornerstone',
  'game-changer',
] as const;

export const FILLER_PHRASES = [
  'it is important to note',
  "it's important to note",
  'it is worth noting',
  "in today's",
  'in conclusion',
  'needless to say',
] as const;

export const SLOP_TRIGRAMS = [
  'a testament to',
  'a tapestry of',
  'in the realm of',
  'the power of',
  'serves as a',
  'in order to',
  'the fact that',
  'plays a crucial',
] as const;

// `harness` is a legitimate technical term (e.g. "test harness"); it is never flagged.
export const SLOP_ALLOWLIST: readonly string[] = ['harness'];

// Strip fenced code so prose rules never read inside ``` blocks.
function proseOnly(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '');
}

// Whole words only; case-insensitive. A hyphen or apostrophe inside the word may
// appear as the character or as a space, so "cutting-edge" and "cutting edge"
// both match.
function wordRe(word: string): RegExp {
  return new RegExp(`\\b${word.replace(/[-']/g, '[-\\s]?')}\\b`, 'i');
}

const CLUSTER_THRESHOLD = 3;

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

export function slopFindings(text: string): HygieneFinding[] {
  const prose = proseOnly(text);
  const findings: HygieneFinding[] = [];

  for (const word of KILL_ON_SIGHT) {
    if (SLOP_ALLOWLIST.includes(word)) continue;
    const index = firstMatch(prose, wordRe(word));
    if (index !== -1) {
      findings.push({
        id: 'slop-kill',
        tier: 'warn',
        line: lineOf(prose, index),
        text: word,
        rationale: 'a word LLMs overuse, flagged on first use',
        fix: `replace "${word}" with a plain verb or noun`,
      });
    }
  }

  for (const { text: paragraph, line } of paragraphsOf(prose)) {
    const hits = CLUSTER_WORDS.filter(
      (w) => !SLOP_ALLOWLIST.includes(w) && wordRe(w).test(paragraph),
    ).length;
    if (hits >= CLUSTER_THRESHOLD) {
      findings.push({
        id: 'slop-cluster',
        tier: 'warn',
        line,
        text: `${hits} cluster words`,
        rationale: 'a paragraph dense with abstract praise reads machine-written',
        fix: 'rewrite in concrete terms; keep at most one such word',
      });
    }
  }

  for (const phrase of [...FILLER_PHRASES, ...SLOP_TRIGRAMS]) {
    const index = firstMatch(prose, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    if (index !== -1) {
      findings.push({
        id: 'slop-phrase',
        tier: 'warn',
        line: lineOf(prose, index),
        text: phrase,
        rationale: 'a filler phrase or slop trigram',
        fix: 'delete it or state the point directly',
      });
    }
  }

  return findings;
}
