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
function lcsMatch(a: readonly string[], b: readonly string[]): Array<[number, number]> {
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

const eq = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((v, k) => v === b[k]);

/**
 * Three-way merge of `ours` (the user's current region) against `theirs` (the
 * new template) with `base` (the last-emitted ancestor). Line-level diff3:
 * changes in disjoint line ranges merge; overlapping changes become inline
 * conflict markers (`<<<<<<< ours` / `=======` / `>>>>>>> theirs`). Pure +
 * deterministic (no IO) so it's unit-testable.
 */
export function mergeThreeWay(base: string, ours: string, theirs: string): MergeResult {
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
      out.push('<<<<<<< ours', ...oSeg, '=======', ...tSeg, '>>>>>>> theirs');
    }
    if (bBase < B.length) out.push(B[bBase] ?? '');
  }
  return { merged: out.join('\n'), conflict };
}
