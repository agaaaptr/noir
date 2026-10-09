// Shared text-scan helpers for the prose finders. `slopFindings` and
// `humanizerFindings` walk the same shape: prose with fenced code and table
// rows blanked, 1-based lines, paragraph boundaries. The helpers live here once
// instead of duplicated per finder.

/** Strip fenced code and blank markdown table rows, so prose rules never read
 *  inside a ``` block or a table. Tables are layout, not prose, and an
 *  auto-generated inventory can legitimately hold an em-dash in every cell.
 *  Rows are blanked rather than dropped, so a finding still names the line it
 *  sits on in the file. */
export function proseOnly(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .split('\n')
    .map((line) => (/^[ \t]*\|/.test(line) ? '' : line))
    .join('\n');
}

/** The 1-based line of the character at `index`: one plus the count of newlines
 *  before it. */
export function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === '\n') line++;
  return line;
}

/** The index of the first match, or -1 when the pattern matches nothing. */
export function firstMatch(text: string, re: RegExp): number {
  const match = re.exec(text);
  return match ? match.index : -1;
}

/** Yields each paragraph with the 1-based line it starts on. An empty line ends
 *  a paragraph, so a single line break continues the paragraph. */
export function* paragraphsOf(text: string): Generator<{ text: string; line: number }> {
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
