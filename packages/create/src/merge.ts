// SP-D follow-up — three-way merge for managed-block regions.
//
// When a user hand-edits the INSIDE of a `<!-- noir:* -->` managed region and a
// later `noir init`/`sync` updates the template, this merges (base/ours/theirs)
// instead of strip-replacing (which would silently clobber the user's edit).
// Line-level diff3: disjoint line changes merge cleanly; overlapping changes
// surface as inline `<<<<<<< / ======= / >>>>>>>` markers for manual resolution.
// Never silently drops either side.

export interface MergeResult {
  /** The merged text. When `conflict` is true, contains inline markers. */
  merged: string;
  /** True when ours and theirs diverged in the same region (markers emitted). */
  conflict: boolean;
}

/** Whole-string short-circuits for the trivial cases (also covers empty). */
function trivial(base: string, ours: string, theirs: string): MergeResult | null {
  if (ours === base) return { merged: theirs, conflict: false };
  if (theirs === base) return { merged: ours, conflict: false };
  if (ours === theirs) return { merged: ours, conflict: false };
  return null;
}

/** Read index `i` of `arr` as a number (0 when out of range) — sidesteps
 *  noUncheckedIndexedAccess without non-null assertions. */
function numAt(arr: readonly number[], i: number): number {
  return arr[i] ?? 0;
}

/** Longest-common-subsequence match pairs between two line arrays. */
export function lcsMatch(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const dpi = dp[i] ?? [];
    const dpi1 = dp[i + 1] ?? [];
    const ai = a[i] ?? '';
    for (let j = m - 1; j >= 0; j--) {
      const bj = b[j] ?? '';
      dpi[j] = ai === bj ? numAt(dpi1, j + 1) + 1 : Math.max(numAt(dpi1, j), numAt(dpi, j + 1));
    }
  }
  const out: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if ((a[i] ?? '') === (b[j] ?? '')) {
      out.push([i, j]);
      i++;
      j++;
    } else if (numAt(dp[i + 1] ?? [], j) >= numAt(dp[i] ?? [], j + 1)) {
      i++;
    } else {
      j++;
    }
  }
  return out;
}

/**
 * B2 — unified line diff for the conflict resolver's stderr preview. Returns a
 * sequence of {type:'eq'|'del'|'add', line} records, LCS-based, equivalent in
 * shape to `git diff --no-color`. Pure (no IO) so it unit-tests cleanly and the
 * resolver can render it through {@link packages/cli/src/theme.ts} (`+` green,
 * `-` red, context dim). Reuses the SAME LCS machinery {@link mergeThreeWay}
 * does so there is exactly one line-diff algorithm in the package.
 *
 * `context` (default 3) — number of unchanged lines to keep around each hunk
 * (git-style). 0 → every non-equal line stands alone; large → whole-file blob.
 * The resolver uses the default; tests pin to a specific shape.
 */
export interface DiffLine {
  type: 'eq' | 'del' | 'add';
  line: string;
}
export function lineDiff(base: string, head: string, context = 3): DiffLine[] {
  const A = base.split('\n');
  const B = head.split('\n');
  const pairs = lcsMatch(A, B);
  const inA = new Set<number>(pairs.map((p) => p[0]));
  const inB = new Set<number>(pairs.map((p) => p[1]));
  // Walk both sequences in lockstep, emitting del/eq/add per the LCS anchors.
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  // Build a baseIdx→headIdx map so we can advance along matched pairs.
  const bToH = new Map<number, number>();
  for (const [bi, hi] of pairs) bToH.set(bi, hi);
  while (i < A.length || j < B.length) {
    const matched = bToH.get(i);
    if (matched !== undefined && matched === j) {
      out.push({ type: 'eq', line: A[i] ?? '' });
      i++;
      j++;
    } else if (matched !== undefined) {
      // Head is behind — emit adds up to the matched head index.
      out.push({ type: 'add', line: B[j] ?? '' });
      j++;
    } else if (i < A.length && !inA.has(i)) {
      // A-only line (deleted).
      out.push({ type: 'del', line: A[i] ?? '' });
      i++;
    } else if (j < B.length && !inB.has(j)) {
      // B-only line (added).
      out.push({ type: 'add', line: B[j] ?? '' });
      j++;
    } else {
      // Both at matched anchors but not paired — advance the smaller index.
      if (i < A.length) i++;
      else j++;
    }
  }
  return context > 0 ? collapseContext(out, context) : out;
}

/** Collapse runs of >2*`context` unchanged lines into a single `...` hunk
 *  separator so the preview stays readable on long files. Pure trim — never
 *  drops a del/add. */
function collapseContext(lines: readonly DiffLine[], context: number): DiffLine[] {
  const out: DiffLine[] = [];
  const keep = new Array<boolean>(lines.length).fill(false);
  // Mark `context` lines around each del/add.
  for (let i = 0; i < lines.length; i++) {
    const dl = lines[i];
    if (dl && dl.type !== 'eq') {
      for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) {
        keep[k] = true;
      }
    }
  }
  let inRun = false;
  for (let i = 0; i < lines.length; i++) {
    const dl = lines[i];
    if (!dl) continue;
    if (keep[i]) {
      out.push(dl);
      inRun = false;
    } else {
      if (!inRun) {
        out.push({ type: 'eq', line: '…' });
        inRun = true;
      }
    }
  }
  return out;
}

/**
 * B2 — zdiff3-style conflict markers for an unresolved overlap. Shape:
 *   `<<<<<<< ours`
 *   <ours lines>
 *   `||||||| base`
 *   <base lines>
 *   `=======`
 *   <theirs lines>
 *   `>>>>>>> theirs`
 *
 * `diff3(zdiff3)` writes the SAME shape — included here so the engine + clack
 * resolver have a single source of truth for marker layout. Returns the marked
 * region body (no outer delimiters); the caller wraps it with surrounding
 * context.
 */
export function zdiff3Region(
  ours: readonly string[],
  base: readonly string[],
  theirs: readonly string[],
): string[] {
  return ['<<<<<<< ours', ...ours, '||||||| base', ...base, '=======', ...theirs, '>>>>>>> theirs'];
}

const eq = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((v, k) => v === b[k]);

/**
 * Three-way merge of `ours` (the user's current region) against `theirs` (the
 * new template) with `base` (the last-emitted ancestor). Line-level diff3:
 * changes in disjoint line ranges merge; overlapping changes become inline
 * conflict markers. Default marker shape is the minimal diff3 form
 * (`<<<<<<< ours` / `=======` / `>>>>>>> theirs`) — byte-identical to v1.2 so
 * {@link mergeManagedRegion} stays regression-anchored. Pass `'zdiff3'` to
 * include the base section (`||||||| base`) — used by the conflict resolver's
 * 6th "merge (with conflict markers)" option (B2 task 4). Pure + deterministic
 * (no IO) so it's unit-testable.
 */
export function mergeThreeWay(
  base: string,
  ours: string,
  theirs: string,
  style: 'minimal' | 'zdiff3' = 'minimal',
): MergeResult {
  const t = trivial(base, ours, theirs);
  if (t) return t;

  const B = base.split('\n');
  const O = ours.split('\n');
  const T = theirs.split('\n');
  const oMap = new Map<number, number>(); // baseIdx → oursIdx
  for (const [bi, oi] of lcsMatch(B, O)) oMap.set(bi, oi);
  const tMap = new Map<number, number>(); // baseIdx → theirsIdx
  for (const [bi, ti] of lcsMatch(B, T)) tMap.set(bi, ti);
  const isAnchor = (bi: number): boolean => oMap.has(bi) && tMap.has(bi);

  const anchors: number[] = [];
  for (let b = 0; b < B.length; b++) if (isAnchor(b)) anchors.push(b);
  const pts: number[] = [-1, ...anchors, B.length];

  const out: string[] = [];
  let conflict = false;
  for (let k = 0; k < pts.length - 1; k++) {
    const aBase = pts[k];
    const bBase = pts[k + 1];
    if (aBase === undefined || bBase === undefined) break;
    const baseSeg = B.slice(aBase + 1, bBase);
    const oStart = aBase >= 0 ? (oMap.get(aBase) ?? -1) + 1 : 0;
    const oEnd = bBase < B.length ? (oMap.get(bBase) ?? 0) : O.length;
    const tStart = aBase >= 0 ? (tMap.get(aBase) ?? -1) + 1 : 0;
    const tEnd = bBase < B.length ? (tMap.get(bBase) ?? 0) : T.length;
    const oSeg = O.slice(oStart, oEnd);
    const tSeg = T.slice(tStart, tEnd);
    if (eq(oSeg, baseSeg) && eq(tSeg, baseSeg)) out.push(...baseSeg);
    else if (eq(oSeg, baseSeg)) out.push(...tSeg);
    else if (eq(tSeg, baseSeg)) out.push(...oSeg);
    else if (eq(oSeg, tSeg)) out.push(...oSeg);
    else {
      conflict = true;
      if (style === 'zdiff3') {
        out.push(...zdiff3Region(oSeg, baseSeg, tSeg));
      } else {
        out.push('<<<<<<< ours', ...oSeg, '=======', ...tSeg, '>>>>>>> theirs');
      }
    }
    if (bBase < B.length) out.push(B[bBase] ?? '');
  }
  return { merged: out.join('\n'), conflict };
}
