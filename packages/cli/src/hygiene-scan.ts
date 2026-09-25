// Output hygiene — the repository-facing scan.
//
// The repository's own source and documents are checked against the hygiene
// rules @noir-ai/skills declares: the patterns that make text read as machine
// output. A fail-tier pattern is objectively mechanical (a divider drawn in
// punctuation, numbered narration, a decorative emoji, a forbidden residue
// token), so it blocks; a warn-tier pattern is a judgement call (a long comment
// block, a marker nobody can act on), which would stall legitimate work if it
// blocked, so it warns.
//
// The scan reads the repository's own text only. Generated and vendored trees,
// the planning corpus, and formats the rules cannot read (JSON, an image
// fixture) are out of scope; a file states its own exemption with the marker
// the rules honour, so no path list is kept here.
//
// The scan runs only where the layout it is written for exists: a package
// tree, `scripts/`, or `docs/`. Anywhere else — an ordinary application
// repository, which is a README and little more — it reports an empty result
// and reads nothing, root documents included. These rules judge the text this
// project writes, not the prose of whoever happened to run the command.
//
// This module is the single source of truth for that scope: which files are
// read, which directories are excluded, and the caps. `noir doctor` (via
// `checkOutputHygiene` in ./commands/doctor.ts) and the CI gate
// (scripts/hygiene-gate.mjs) both call `scanOutputHygiene`, so the two cannot
// drift apart.

import { type Dirent, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { checkHygiene, type HygieneKind, type HygieneTier } from '@noir-ai/skills';

/** How many findings the detail cell names before it reports the rest as a
 *  count. A tree that has drifted can carry hundreds, and the row is a signal
 *  to act on, not an inventory; the counts still cover every finding. */
export const HYGIENE_FINDING_CAP = 5;

/** The largest file the scan reads. A file this big is generated data or a
 *  bundle rather than the source and prose the rules are written for. */
export const HYGIENE_MAX_FILE_BYTES = 512 * 1024;

/** The most files one scan reads, so the check stays responsive in a tree far
 *  larger than this repository's. Reaching it is reported in the row. */
export const HYGIENE_MAX_FILES = 2000;

/** The source extensions the check reads. Anything else is skipped: the rules
 *  are written for comments and for prose, and a data format (JSON, YAML) has
 *  no comment for them to read, while a binary fixture would only produce
 *  nonsense. */
const HYGIENE_CODE_EXTENSIONS = /\.(?:ts|tsx|js|jsx|mjs|cjs|sh)$/i;

/** The document extensions the check reads as prose. */
const HYGIENE_MARKDOWN_EXTENSIONS = /\.(?:md|mdx)$/i;

/** Directories the walk never descends into: dependencies, build output and
 *  coverage. A dot-directory is skipped too (`.git`, `.noir`, local scratch
 *  directories), which is how the maintainer's exclusion of session scratch is
 *  honoured by construction rather than by naming it here. */
const HYGIENE_SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage']);

/** Directories excluded from the scan by the maintainer's decision: the
 *  planning corpus, where decisions are recorded in the maintainer's own
 *  shorthand. Root-relative POSIX paths. */
const HYGIENE_EXCLUDED_DIRS = new Set(['docs/internal', 'docs/decisions', 'docs/roadmap']);

/** The release log, excluded by basename wherever it sits: the root copy is the
 *  single source of truth and `docs/CHANGELOG.md` is a pointer to it. */
const HYGIENE_EXCLUDED_FILES = new Set(['CHANGELOG.md']);

/** A file the scan will read, with the kind of text it holds. */
interface HygieneScanFile {
  /** Root-relative POSIX path. */
  path: string;
  kind: HygieneKind;
}

/** One finding, reduced to what the report needs. */
export interface HygieneScanFinding {
  path: string;
  /** 1-based line number. */
  line: number;
  /** The rule id, exactly as the rule table declares it. */
  id: string;
  tier: HygieneTier;
}

export interface HygieneScanResult {
  /** Files read. */
  scanned: number;
  /** Files the scan did not read because they exceed the size cap. */
  skipped: number;
  /** True when the file cap stopped the scan before it read the whole tree, so
   *  the counts below describe a prefix of it. */
  truncated: boolean;
  /** Every finding, failures first, then in reading order across the tree. */
  findings: HygieneScanFinding[];
  fail: number;
  warn: number;
}

/** A walk in progress: the files it has accepted, and whether the file cap has
 *  stopped it. */
interface HygieneWalk {
  files: HygieneScanFile[];
  truncated: boolean;
}

/** `readdirSync` entries, or none when the directory does not exist. */
function readDirEntries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // absent or unreadable — there is nothing to scan
  }
}

/** Whether `path` is an existing directory. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The kind of text a path holds, or `null` when the rules cannot read it. */
function hygieneKindOf(path: string): HygieneKind | null {
  if (HYGIENE_MARKDOWN_EXTENSIONS.test(path)) return 'markdown';
  if (HYGIENE_CODE_EXTENSIONS.test(path)) return 'code';
  return null;
}

/** The layout this check exists for: a package source or test tree, `scripts/`,
 *  or a documentation tree. A repository that has none of them is not the
 *  audience of these rules, and nothing is read there. */
function hasScannableLayout(root: string): boolean {
  if (isDirectory(join(root, 'docs')) || isDirectory(join(root, 'scripts'))) return true;
  for (const entry of readDirEntries(join(root, 'packages'))) {
    if (!entry.isDirectory()) continue;
    if (isDirectory(join(root, 'packages', entry.name, 'src'))) return true;
    if (isDirectory(join(root, 'packages', entry.name, 'test'))) return true;
  }
  return false;
}

/** Adds `rel` to the walk when it is a file the rules can read and the walk has
 *  room for it. A dot-file is never read (a dot-directory is skipped by the
 *  walk itself), and once the file cap is reached the walk records the
 *  truncation instead of adding more. */
function addHygieneFile(rel: string, walk: HygieneWalk): void {
  const name = rel.slice(rel.lastIndexOf('/') + 1);
  if (name.startsWith('.') || HYGIENE_EXCLUDED_FILES.has(name)) return;
  const kind = hygieneKindOf(rel);
  if (kind === null) return;
  if (walk.files.length >= HYGIENE_MAX_FILES) {
    walk.truncated = true;
    return;
  }
  walk.files.push({ path: rel, kind });
}

/** Offers every readable file under `root`/`relDir` to the walk. Symlinked
 *  directories are not followed: a link out of the tree is not the
 *  repository's own source, and a link to an ancestor would not terminate. */
function walkScannable(
  root: string,
  relDir: string,
  skip: ReadonlySet<string>,
  walk: HygieneWalk,
): void {
  if (walk.truncated) return;
  for (const entry of readDirEntries(join(root, relDir))) {
    if (walk.truncated) return;
    const rel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (HYGIENE_SKIP_DIRS.has(entry.name) || entry.name.startsWith('.') || skip.has(rel)) {
        continue;
      }
      walkScannable(root, rel, skip, walk);
    } else if (entry.isFile()) {
      addHygieneFile(rel, walk);
    }
  }
}

const NO_SKIP_DIRS: ReadonlySet<string> = new Set();

/** The files the check reads: documents at the root and under `docs/` (minus
 *  the planning corpus), the repository-authored agent skills, each package's
 *  sources and tests, and `scripts/`. Sorted by path so a report is the same on
 *  every run. Called only where {@link hasScannableLayout} holds. */
function collectHygieneFiles(root: string): HygieneWalk {
  const walk: HygieneWalk = { files: [], truncated: false };
  for (const entry of readDirEntries(root)) {
    if (entry.isFile()) addHygieneFile(entry.name, walk);
  }
  walkScannable(root, 'docs', HYGIENE_EXCLUDED_DIRS, walk);
  walkScannable(root, '.claude/skills', NO_SKIP_DIRS, walk);
  for (const entry of readDirEntries(join(root, 'packages'))) {
    if (!entry.isDirectory()) continue;
    walkScannable(root, `packages/${entry.name}/src`, NO_SKIP_DIRS, walk);
    walkScannable(root, `packages/${entry.name}/test`, NO_SKIP_DIRS, walk);
  }
  walkScannable(root, 'scripts', NO_SKIP_DIRS, walk);
  walk.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return walk;
}

/** What the scan left out, in one parenthesis. Empty when it left out nothing,
 *  so a complete report carries no note. */
function hygieneOmissions(result: HygieneScanResult): string {
  const notes: string[] = [];
  if (result.skipped > 0) {
    notes.push(
      `${result.skipped} file${result.skipped === 1 ? '' : 's'} over ${HYGIENE_MAX_FILE_BYTES / 1024} KiB skipped`,
    );
  }
  if (result.truncated) notes.push(`stopped at ${HYGIENE_MAX_FILES} files`);
  return notes.length > 0 ? ` (${notes.join('; ')})` : '';
}

/** The counts line: how many findings of each tier, in how many files, and what
 *  the scan itself omitted. It names no location, so a caller that prints every
 *  finding on a line of its own pairs this with those lines instead of printing
 *  the same findings twice. */
export function hygieneCounts(result: HygieneScanResult): string {
  const omitted = hygieneOmissions(result);
  if (result.scanned === 0) {
    return `nothing to scan (no packages/*/src, packages/*/test, scripts/ or documents found)${omitted}`;
  }
  if (result.findings.length === 0) {
    return `clean — ${result.scanned} file${result.scanned === 1 ? '' : 's'} scanned${omitted}`;
  }
  const files = new Set(result.findings.map((f) => f.path)).size;
  return `${result.fail} fail, ${result.warn} warn in ${files} file${files === 1 ? '' : 's'}${omitted}`;
}

/** The counts line followed by the locations that carry them, up to the cap.
 *  Failures are named before warnings, so a truncated list still shows what
 *  blocks. This is the doctor row, which has one line to work with. */
export function hygieneDetail(result: HygieneScanResult): string {
  const counts = hygieneCounts(result);
  if (result.scanned === 0 || result.findings.length === 0) return counts;
  const named = result.findings.slice(0, HYGIENE_FINDING_CAP);
  const hidden = result.findings.length - named.length;
  const where = named.map((f) => `${f.path}:${f.line} ${f.id}`).join('; ');
  return `${counts} — ${where}${hidden > 0 ? ` (+${hidden} more)` : ''}`;
}

/**
 * Reads the repository's own source and documents through `checkHygiene` and
 * returns the scan result: the files read, the findings (failures first), and
 * the fail/warn counts. It pushes no doctor row — that is the caller's
 * business (`checkOutputHygiene` in the doctor command, or the CI gate's own
 * report).
 *
 * Nothing is read unless {@link hasScannableLayout} holds, so a repository
 * without the layout gets an empty result and pays one `stat` per candidate.
 *
 * Each file is read once, and a file that carries the exemption marker comes
 * back from `checkHygiene` with no findings at all, so the marker costs one
 * scan of a file's text rather than a path list kept here. Files past the size
 * cap and files past the count cap are left out; the result says so.
 *
 * The scan never throws and never writes: an unreadable file is skipped, and
 * the commands that repair the tree (`noir skills lint`, the repository's own
 * sweep) are the caller's business.
 */
export function scanOutputHygiene(root: string): HygieneScanResult {
  const empty: HygieneScanResult = {
    scanned: 0,
    skipped: 0,
    truncated: false,
    findings: [],
    fail: 0,
    warn: 0,
  };
  if (!hasScannableLayout(root)) return empty;
  const walk = collectHygieneFiles(root);
  const findings: HygieneScanFinding[] = [];
  let scanned = 0;
  let skipped = 0;
  for (const file of walk.files) {
    const abs = join(root, file.path);
    try {
      if (statSync(abs).size > HYGIENE_MAX_FILE_BYTES) {
        skipped++;
        continue;
      }
      const text = readFileSync(abs, 'utf8');
      scanned++;
      for (const found of checkHygiene(text, file.kind)) {
        findings.push({ path: file.path, line: found.line, id: found.id, tier: found.tier });
      }
    } catch {
      // An unreadable path says nothing about hygiene — the store check owns
      // broken files — so the scan moves on to the next one.
    }
  }
  findings.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier === 'fail' ? -1 : 1;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.line - b.line;
  });
  const fail = findings.filter((f) => f.tier === 'fail').length;
  return {
    scanned,
    skipped,
    truncated: walk.truncated,
    findings,
    fail,
    warn: findings.length - fail,
  };
}
