// The single source of truth for output hygiene: the patterns that make agent
// output look machine-generated, each with the tier that decides whether it
// blocks, the reason it is noise, and what to write instead. Consumers are the
// skills quality gate, the repository doctor check and continuous integration.

// Self-exemption convention: the rule source, the token table it projects and
// the gate's own fixtures are exempt from the rules they define, because they
// must be able to name what they forbid. Any such file carries the exemption
// marker below, so no consumer needs a path list of its own. This file declares
// the rules, so it carries the marker:
// noir-hygiene: exempt

import { RESIDUE_RULES } from './residue.js';

export type HygieneTier = 'fail' | 'warn';

/** The two kinds of text a rule can be written for: source, or prose. */
export type HygieneKind = 'code' | 'markdown';

export interface HygieneRule {
  id: string;
  tier: HygieneTier;
  /** Anchored: a pattern that matches ordinary writing is the failure this
   *  rule source exists to prevent, so every pattern below is reviewed against
   *  plain prose and against string literals. */
  pattern: RegExp;
  rationale: string;
  fix: string;
  appliesTo: HygieneKind | 'both';
}

export interface HygieneFinding {
  /** The id of the rule that matched, exactly as `HYGIENE_RULES` declares it. */
  id: string;
  tier: HygieneTier;
  /** 1-based number of the line the pattern matched. */
  line: number;
  /** The matched line, trimmed of surrounding whitespace. */
  text: string;
  rationale: string;
  fix: string;
}

/** The line that exempts a file from every rule. A file that must keep what the
 *  rules flag — the rule source, the token table, a document that states the
 *  ban — carries the line matching its kind near the top. */
export const HYGIENE_EXEMPT_MARKERS: Readonly<Record<HygieneKind, string>> = {
  code: '// noir-hygiene: exempt',
  markdown: '<!-- noir-hygiene: exempt -->',
};

/** A run of this many consecutive comment lines counts as a comment block. A
 *  blank comment line is a paragraph break and a divider is reported on its
 *  own, so neither one extends a block. */
export const MAX_COMMENT_BLOCK_LINES = 12;

// A comment opener that sits at the start of a line or after whitespace.
// Requiring that position is what keeps the rules below off ordinary writing:
// the `//` of `https://example.com` follows a colon, so it opens no comment.
const MARKER = String.raw`(?:^[ \t]*|[ \t])(?:\/\/|#|\/\*|\*)`;

/** The emoji presentation selector. It is invisible in source, so it is named
 *  here rather than written; it follows a character that also has a text
 *  presentation, as the warning sign does. */
const VARIATION_SELECTOR = String.fromCharCode(0xfe0f);

/** The pictograph block, where the icons that decorate generated text live. */
const PICTOGRAPH = String.raw`[\u{1F300}-\u{1FAFF}]`;

// The decoration set: the icons that arrive as flourishes in generated text and
// tell a reader nothing they can act on. They are unambiguous on their own, so
// they are flagged wherever they appear in a comment.
const DECORATION_EMOJI = `[⚠✅🎉✨🔥🚀🧠💡🔧📌]${VARIATION_SELECTOR}?`;

/** The backtick. It is named rather than written so the template literal that
 *  builds the quote class below does not end early; see VARIATION_SELECTOR. */
const BACKTICK = String.fromCharCode(0x60);

/** A quote or a backtick. A comment may legitimately quote the glyph it
 *  describes, as the badge documentation quotes its own `⚠ warn` output, so a
 *  glyph wrapped in one of these is not decoration. */
const QUOTE_OR_BACKTICK = `[${BACKTICK}'"]`;

/** The markers a reader is expected to act on later. */
const MARKER_WORDS = ['TODO', 'FIXME'];

/** Words that give a marker a reason to exist, and so make it actionable. */
const REASON_WORDS = [
  'because',
  'since',
  'until',
  'once',
  'when',
  'unless',
  'blocked',
  'otherwise',
  'revisit',
];

/** An owner for a marker: a handle, a bracketed name, or a tracked issue. */
const OWNER = String.raw`(?:@[A-Za-z0-9_-]|\([A-Za-z][A-Za-z0-9_-]*\)|#\d+)`;

/** A run of divider punctuation after a comment opener, which turns a label
 *  into a banner: `==== Fetch users ====`. */
const DECORATIVE_BANNER: HygieneRule = {
  id: 'decorative-banner',
  tier: 'fail',
  pattern: new RegExp(String.raw`${MARKER}[ \t]*[-=*_~]{4,}`, 'm'),
  rationale:
    'A divider drawn in punctuation marks a section for the person writing the file, not for the reader: it carries no information, and it makes the file read as machine output.',
  fix: 'Delete the divider. If the label names a section a reader needs, make it a heading or name it in the declaration below.',
  appliesTo: 'both',
};

/** Narration that walks a reader through the code in the order it runs:
 *  `Step 1: load the config`, `First, …`, `Next, …`, `Finally, …`. Two shapes
 *  are exempt: an ordinal followed by a relative clause ("first, which is all
 *  the test needs") describes a position rather than a procedure, and an
 *  ordinal that goes on to give the reason ("first, init so sync can read it")
 *  is the note this rule's own fix asks a reader to keep. */
const WORKFLOW_NARRATION: HygieneRule = {
  id: 'workflow-narration',
  tier: 'fail',
  pattern: new RegExp(
    String.raw`${MARKER}[ \t]*(?:step[ \t]*\d+[ \t]*[:.)]|(?:first|second|third|then|next|finally|lastly)[ \t]*[,:](?![ \t]*(?:which|that|who)\b)(?![^\n]*\b(?:so|because|since)\b))`,
    'im',
  ),
  rationale:
    'Numbered narration restates what the code already says in the order it already says it, and it goes stale the moment that order changes.',
  fix: 'Drop the step markers. Keep only what the code cannot show: why this order, which invariant is held, or what breaks otherwise.',
  appliesTo: 'code',
};

/** An emoji from the decoration set anywhere in a comment — the common flourish
 *  in generated comments, opening the comment or trailing it. A glyph the
 *  comment has put in quotes is being talked about rather than used, so it is
 *  left alone; the trailing check allows for the presentation selector the
 *  pattern may have consumed. */
const DECORATIVE_EMOJI_IN_COMMENT: HygieneRule = {
  id: 'decorative-emoji-comment',
  tier: 'fail',
  pattern: new RegExp(
    String.raw`${MARKER}[^\n]*(?<!${QUOTE_OR_BACKTICK})${DECORATION_EMOJI}(?!${VARIATION_SELECTOR}?${QUOTE_OR_BACKTICK})`,
    'mu',
  ),
  rationale:
    'A decorative emoji in a comment adds no information a reader needs, and it is the clearest single sign that the text was generated rather than written.',
  fix: 'Remove the emoji and let the sentence carry the emphasis. If it marked a state, name the state in a word.',
  appliesTo: 'code',
};

/** A pictograph that opens a comment, for the emoji outside the decoration
 *  set: only that position is unambiguously decorative, since a comment may
 *  legitimately quote a character it is describing. */
const DECORATIVE_PICTOGRAPH: HygieneRule = {
  id: 'decorative-pictograph-comment',
  tier: 'fail',
  pattern: new RegExp(
    String.raw`${MARKER}[ \t]*(?!${DECORATION_EMOJI})${PICTOGRAPH}${VARIATION_SELECTOR}?`,
    'mu',
  ),
  rationale:
    'A comment that opens with a pictograph is decoration: the pictograph marks nothing a reader can act on, and it reads as a generated flourish.',
  fix: 'Remove the pictograph. If it stood for a state or a result, write that in words.',
  appliesTo: 'code',
};

/** A document line that opens with a decorative emoji or pictograph, after any
 *  heading or bullet marker. Only that opening position counts: an emoji inside
 *  a sentence is usually something the sentence is talking about. */
const DECORATIVE_EMOJI_IN_PROSE: HygieneRule = {
  id: 'decorative-emoji-doc',
  tier: 'fail',
  pattern: new RegExp(
    String.raw`^[ \t]{0,3}(?:#{1,6}[ \t]+)?(?:[-*+][ \t]+)?(?:${DECORATION_EMOJI}|${PICTOGRAPH}${VARIATION_SELECTOR}?)`,
    'mu',
  ),
  rationale:
    'A heading or a bullet that opens with a decorative emoji spends a reader attention on the emoji and none of it on the point of the line.',
  fix: 'Remove the emoji and put the point of the line in its words.',
  appliesTo: 'markdown',
};

/** Consecutive comment lines long enough to be narration rather than a note. */
const LONG_COMMENT_BLOCK: HygieneRule = {
  id: 'long-comment-block',
  tier: 'warn',
  pattern: new RegExp(
    String.raw`(?:^[ \t]*(?:\/\/|\/\*|\*|#[ \t])(?![ \t]*[-=*_~]{4})[ \t]*\S[^\n]*(?:\n|$)){${MAX_COMMENT_BLOCK_LINES},}`,
    'm',
  ),
  rationale: `A run of ${MAX_COMMENT_BLOCK_LINES} or more comment lines with no break between them is usually narration or a restatement of the code below it, which a reader skips and which drifts out of date.`,
  fix: 'Cut the block to the part a reader cannot get from the code, and move reference detail into the document that owns it.',
  appliesTo: 'code',
};

/** A TODO or FIXME marker with no owner and no reason, which nobody can act on
 *  and nobody can retire. */
const BARE_TODO: HygieneRule = {
  id: 'bare-todo',
  tier: 'warn',
  pattern: new RegExp(
    String.raw`${MARKER}[ \t]*(?:${MARKER_WORDS.join('|')})\b(?![^\n]*${OWNER})(?![^\n]*\b(?:${REASON_WORDS.join('|')})\b)`,
    'im',
  ),
  rationale:
    'A TODO with no owner and no reason cannot be acted on: no one knows who will do it, or what would make it unnecessary.',
  fix: 'Name an owner or a tracked issue and the condition that retires the marker, such as "revisit once the v2 client lands".',
  appliesTo: 'code',
};

/** Every rule the gate enforces: the deterministic patterns first, then the
 *  judgement calls, then the tokens this project must never ship again. */
export const HYGIENE_RULES: readonly HygieneRule[] = [
  DECORATIVE_BANNER,
  WORKFLOW_NARRATION,
  DECORATIVE_EMOJI_IN_COMMENT,
  DECORATIVE_PICTOGRAPH,
  DECORATIVE_EMOJI_IN_PROSE,
  LONG_COMMENT_BLOCK,
  BARE_TODO,
  ...RESIDUE_RULES,
];

/** Checks `text` against every rule that applies to `kind`, and returns the
 *  findings in reading order: one per rule per line.
 *
 *  A file is exempt from every rule when it carries the marker
 *  `HYGIENE_EXEMPT_MARKERS` declares for its kind on a line above the first
 *  finding — the rule source itself, the token table, and any guidance or
 *  fixture file that has to name what the rules forbid. Such a file states its
 *  own exemption, so no consumer keeps a list of paths to skip. A marker placed
 *  at or below the first finding exempts nothing.
 *
 *  Pure and deterministic: each pattern is recompiled per call, so no
 *  `lastIndex` state escapes and the same text always gives the same findings. */
export function checkHygiene(text: string, kind: HygieneKind): HygieneFinding[] {
  const findings = collectFindings(text, kind);
  const exemptAt = exemptionLine(text, kind);
  if (exemptAt !== 0 && exemptAt < (findings[0]?.line ?? Number.POSITIVE_INFINITY)) return [];
  return findings;
}

/** Every finding `text` produces under `kind`, in reading order. */
function collectFindings(text: string, kind: HygieneKind): HygieneFinding[] {
  const lineStarts = lineStartOffsets(text);
  const findings: HygieneFinding[] = [];
  for (const rule of HYGIENE_RULES) {
    if (rule.appliesTo !== 'both' && rule.appliesTo !== kind) continue;
    let reportedLine = 0;
    for (const match of text.matchAll(globalPattern(rule.pattern))) {
      const line = lineNumberAt(lineStarts, match.index ?? 0);
      // A line with three emoji is one defect, not three.
      if (line === reportedLine) continue;
      reportedLine = line;
      findings.push({
        id: rule.id,
        tier: rule.tier,
        line,
        text: lineTextAt(text, lineStarts, line),
        rationale: rule.rationale,
        fix: rule.fix,
      });
    }
  }
  // Reading order; lines that share a number keep rule-table order, because
  // Array.prototype.sort is stable.
  return findings.sort((a, b) => a.line - b.line);
}

/** The 1-based line the exemption marker for `kind` sits on, or 0 when the text
 *  carries none. The marker is recognised with surrounding whitespace ignored,
 *  so an indented comment counts. */
function exemptionLine(text: string, kind: HygieneKind): number {
  const marker = HYGIENE_EXEMPT_MARKERS[kind];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) if ((lines[i] ?? '').trim() === marker) return i + 1;
  return 0;
}

/** The offset each line starts at, so a match offset maps to a line number
 *  without rescanning the text once per match. */
function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

function lineNumberAt(lineStarts: readonly number[], index: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((lineStarts[mid] ?? 0) <= index) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

function lineTextAt(text: string, lineStarts: readonly number[], line: number): string {
  const start = lineStarts[line - 1] ?? 0;
  const end = text.indexOf('\n', start);
  return text.slice(start, end === -1 ? text.length : end).trim();
}

/** A fresh global copy of a rule's pattern: sharing one would leave `lastIndex`
 *  behind and make the next call start mid-line. */
function globalPattern(pattern: RegExp): RegExp {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return new RegExp(pattern.source, flags);
}
