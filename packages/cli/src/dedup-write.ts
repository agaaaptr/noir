// TIER B3 — write-path semantic dedup. After `scaffold()` writes host-context
// files (CLAUDE.md / AGENTS.md / GEMINI.md / .noir/rules/RULES.md), embed the
// just-written file and compare it against the OTHER existing host-context
// files. Surface a near-duplicate as a NON-BLOCKING recommendation:
//
//   - cosine ≥ 0.95  → ACTION prompt (interactive): Replace the existing /
//                      Mirror into it / Skip (delete the new file) / Create
//                      anyway. Under --json/--no-input the action tier records
//                      the near-dup in ScaffoldResult.conflicts[] (mode=
//                      'artifact', similarity set) and proceeds with the
//                      default (Create anyway); NEVER prompts.
//   - 0.85–0.95      → INFO-only hint to stderr, write proceeds.
//   - < 0.85         → silent.
//
// GRACEFUL DEGRADATION (the make-orreak constraint): the embedder (ONNX
// Runtime + the ~22 MB all-MiniLM-L6-v2 model) is lazy-loaded with a 5s ping
// timeout; if it is unavailable, slow, OR throws, the hook prints a one-line
// stderr warn-skip and returns an empty result. `noir init`/`sync`/`create`
// NEVER block on a model download or fail because the embedder is missing —
// dedup is an ENHANCEMENT, not a gate. A fresh project with no existing
// host-context candidates short-circuits BEFORE any embedding (fast path).
//
// CONTENT-HASH GATE: candidate embeddings are cached under
// `.noir/dedup-cache.json` keyed by SHA-256(content); only changed candidates
// re-embed. The proposed file's embedding is cached the same way, so a repeat
// `noir sync` that re-emits byte-identical content does NOT re-embed. Cache
// entries are scoped to the resolved model id (a model change invalidates them).
//
// Connect to B2: when a near-dup is found, the conflict record (mode 'artifact'
// — the closest generic in ConflictContext['mode']) is appended to the
// ScaffoldResult.conflicts[] the caller returns, so `--json` consumers see the
// near-dup with its cosine `similarity` without a prompt.
//
// Stream discipline: every hint / warn-skip → STDERR; the CLI's `json()` is the
// sole stdout writer. Colors via the A2 theme (`c.warn`/`c.dim`) so NO_COLOR /
// non-TTY strip cleanly.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectInfo } from '@noir-ai/core';
import type { ConflictRecord, ScaffoldResult } from '@noir-ai/create';
import { collectDedupCandidates } from './commands/doctor.js';
import { c } from './theme.js';

/** Local embedder shape (@noir-ai/context's `EmbedFn`). */
export type EmbedLike = (text: string) => Promise<Float32Array>;

/** Host-context files dedup scans (mirrors `collectDedupCandidates`). */
const HOST_CONTEXT_RELS = new Set(['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.noir/rules/RULES.md']);

/** Cosine ≥ this → ACTION prompt (interactive) or conflict record (--json). */
export const ACTION_THRESHOLD = 0.95;
/** Cosine ≥ this (and < ACTION) → INFO-only hint. Below → silent. */
export const INFO_THRESHOLD = 0.85;
/** The first embed() call triggers ONNX load + possibly a model download; bound
 *  it so init/sync/create never block indefinitely on a cold cache. */
export const EMBEDDER_PING_TIMEOUT_MS = 5000;
/** Bump on disk-format changes; an older file is discarded (no migration). */
const DEDUP_CACHE_VERSION = 1;

export interface DedupWriteOpts {
  /** B1/B2 explicit interactivity flag (the engine + skills emit read the same). */
  interactive: boolean;
  /** Project info — read from `.noir/config.yml` by the caller. When undefined
   *  OR when the resolved embedder is `kind:'none'`, the hook warn-skips. */
  project?: ProjectInfo;
  /** Testability seam (mirrors `checkSemanticDupDoctor`'s `opts.embed`): when
   *  set, the hook uses this embedder directly and skips the lazy ONNX load +
   *  ping-timeout. Production omits it. */
  embed?: EmbedLike;
}

export interface DedupWriteResult {
  /** Near-duplicates found, one entry per (proposed, matched) pair. */
  found: Array<{ proposedRel: string; matchedRel: string; similarity: number }>;
  /** Conflict records to append to {@link ScaffoldResult.conflicts}. */
  conflicts: ConflictRecord[];
}

/**
 * Run the write-path semantic dedup over the host-context files in
 * `res.written`. Does NOT mutate `res`; the caller decides whether to splice
 * `result.conflicts` into `res.conflicts`. Non-blocking: any embedder failure
 * degrades to a stderr warn-skip and an empty result.
 */
export async function checkWritePathDedup(
  root: string,
  res: ScaffoldResult,
  opts: DedupWriteOpts,
): Promise<DedupWriteResult> {
  const result: DedupWriteResult = { found: [], conflicts: [] };
  // Fast path: only host-context files we JUST wrote are eligible. Fresh
  // projects (first init/create) typically write ONE host pointer + RULES.md;
  // if no other host-context file exists, candidates is empty → no embedding.
  const writtenHostFiles = res.written.filter((p) => HOST_CONTEXT_RELS.has(p));
  if (writtenHostFiles.length === 0) return result;

  const cache = loadCache(root);
  const embed = await resolveEmbedder(opts, cache);
  if (embed === undefined) return result; // warn-skip already emitted

  // Wrap the embedder with the content-hash cache so unchanged candidates (and
  // a repeat-emit of byte-identical proposed bytes) skip the underlying call.
  const cachedEmbed = makeCachedEmbed(cache, embed);

  for (const proposedRel of writtenHostFiles) {
    const proposedAbs = join(root, proposedRel);
    let proposedText: string;
    try {
      proposedText = readFileSync(proposedAbs, 'utf8');
    } catch {
      continue;
    }
    if (proposedText.trim().length === 0) continue;

    // Candidates = existing host-context files MINUS this proposed path. A
    // first-run init writing CLAUDE.md while AGENTS.md already exists compares
    // the new CLAUDE.md against AGENTS.md + RULES.md (not against itself).
    const candidates = collectDedupCandidates(root).filter((c) => c.path !== proposedRel);
    if (candidates.length === 0) continue; // fresh project, nothing to compare

    const ctx = await import('@noir-ai/context');
    const proposed = { path: proposedRel, text: proposedText };
    // Graceful degradation INSIDE the loop too: an embedder that loads (passes
    // the ping) but throws mid-batch (transient remote failure, OOM, …) must
    // never break the write. Catch, warn-skip this proposal, keep going.
    let best: Awaited<ReturnType<typeof ctx.findNearestDuplicate>>;
    try {
      best = await ctx.findNearestDuplicate(
        proposed,
        candidates,
        async (t) => cachedEmbed(t),
        INFO_THRESHOLD,
      );
    } catch (e) {
      process.stderr.write(
        `${c.dim(`noir: semantic-dedup skipped for ${proposedRel} (${errMsg(e)}).`)}\n`,
      );
      continue;
    }
    if (best === null) continue;

    const matchedRel = best.a === proposedRel ? best.b : best.a;
    const sim = best.similarity;
    result.found.push({ proposedRel, matchedRel, similarity: sim });

    if (sim >= ACTION_THRESHOLD) {
      if (opts.interactive) {
        await promptDedupAction(root, proposedRel, matchedRel, proposedText, sim);
      } else {
        // --json / --no-input: record + proceed with the default (Create
        // anyway). Never prompt under non-interactive.
        process.stderr.write(
          `${c.warn('noir: near-duplicate')} ${proposedRel} ≈ ${matchedRel} (cosine ${sim.toFixed(2)}); creating anyway.\n`,
        );
      }
    } else {
      // 0.85 – 0.95: INFO-only hint. Write already succeeded; just surface.
      process.stderr.write(
        `${c.dim(`noir: hint  ${proposedRel} looks similar to existing ${matchedRel} (cosine ${sim.toFixed(2)}).`)}\n`,
      );
    }

    // Connect to B2: append a structured record so --json consumers see the
    // near-dup with its cosine similarity without a prompt. The path is the
    // file we just wrote (consistent with B2's "path = the file being
    // written"); existingSha is the MATCHED file's hash, proposedSha the new
    // bytes'. Resolution 'preserve' = we kept both as-is under Create-anyway.
    const matchedText = safeRead(join(root, matchedRel));
    result.conflicts.push({
      path: proposedRel,
      mode: 'artifact',
      similarity: sim,
      existingSha: sha256Hex12(matchedText ?? ''),
      proposedSha: sha256Hex12(proposedText),
      resolution: 'preserve',
    });
  }

  saveCache(root, cache);
  return result;
}

/**
 * Resolve the embedder: injected (test seam) > local-embedder from the user's
 * `context.embedder` config. Returns undefined (after a stderr warn-skip) when
 * kind='none', the factory throws, OR the first ping exceeds the timeout.
 *
 * Model-id tracking runs in BOTH paths so a config change invalidates the
 * on-disk cache even when the caller injected an embedder (the test seam
 * still flows through the same cache discipline as production).
 */
async function resolveEmbedder(
  opts: DedupWriteOpts,
  cache: DedupCache,
): Promise<EmbedLike | undefined> {
  const ctx = await import('@noir-ai/context');
  // Resolve the model id from config when available; an injected embedder
  // without project info skips invalidation (cache stays model-scoped to '' —
  // a fresh cache, which is fine for tests that always inject).
  let modelId: string | undefined;
  if (opts.project !== undefined) {
    const cfg = ctx.resolveEmbedderConfig(opts.project.config.context);
    if (cfg.kind === 'none') {
      process.stderr.write(`${c.dim('noir: semantic-dedup skipped (embedder kind=none).')}\n`);
      return undefined;
    }
    modelId =
      cfg.kind === 'local' ? (cfg.model ?? ctx.DEFAULT_LOCAL_MODEL) : (cfg.model ?? cfg.kind);
    // Invalidate cache on a model change BEFORE deciding the embedder source.
    if (modelId !== undefined && cache.model !== modelId) {
      cache.model = modelId;
      cache.entries = {};
    }
  }
  // Test seam: an injected embedder bypasses the lazy ONNX load + ping.
  if (opts.embed !== undefined) return opts.embed;
  if (modelId === undefined) return undefined; // no project + no inject → skip

  let embed: EmbedLike;
  try {
    const project = opts.project;
    if (project === undefined) return undefined;
    const cfg = ctx.resolveEmbedderConfig(project.config.context);
    embed = ctx.createEmbedFn(cfg).embed as EmbedLike;
  } catch (e) {
    process.stderr.write(
      `${c.dim(`noir: semantic-dedup skipped (embedder unavailable: ${errMsg(e)}).`)}\n`,
    );
    return undefined;
  }
  // Pre-warm with a ping under a timeout. The first call triggers the ONNX
  // load + (on a cold ~/.noir/models/) a ~22 MB model download; bound it so
  // init/sync never block on the network. A throw OR a timeout → warn-skip.
  const ping = await withTimeout(
    embed('ping').then(() => true),
    EMBEDDER_PING_TIMEOUT_MS,
  );
  if (ping !== true) {
    process.stderr.write(
      `${c.dim('noir: semantic-dedup skipped (embedder load too slow or unavailable).')}\n`,
    );
    return undefined;
  }
  return embed;
}

/** ACTION prompt for the ≥0.95 tier (interactive only). */
async function promptDedupAction(
  root: string,
  proposedRel: string,
  matchedRel: string,
  proposedText: string,
  sim: number,
): Promise<void> {
  const clack = await import('@clack/prompts');
  type Choice = 'create' | 'skip' | 'replace' | 'mirror';
  const choice = await clack.select({
    message: `${proposedRel} is near-duplicate of existing ${matchedRel} (cosine ${sim.toFixed(2)}). Create anyway?`,
    initialValue: 'create' as Choice,
    options: [
      {
        value: 'create' as Choice,
        label: 'Create anyway',
        hint: 'keep the new file as-is (default)',
      },
      { value: 'skip' as Choice, label: 'Skip', hint: `delete ${proposedRel}; keep ${matchedRel}` },
      {
        value: 'replace' as Choice,
        label: 'Replace existing',
        hint: `overwrite ${matchedRel} with this content`,
      },
      {
        value: 'mirror' as Choice,
        label: 'Mirror into existing',
        hint: `append this content to ${matchedRel}`,
      },
    ],
  });
  if (clack.isCancel(choice)) return; // cancel = keep the default (Create anyway)
  if (choice === 'skip') {
    try {
      rmSync(join(root, proposedRel), { force: true });
    } catch {
      /* best-effort; the write already happened */
    }
  } else if (choice === 'replace') {
    try {
      writeFileSync(join(root, matchedRel), proposedText, 'utf8');
    } catch {
      /* best-effort */
    }
  } else if (choice === 'mirror') {
    try {
      const existing = readFileSync(join(root, matchedRel), 'utf8');
      writeFileSync(
        join(root, matchedRel),
        `${existing}\n\n<!-- mirrored from ${proposedRel} -->\n${proposedText}\n`,
        'utf8',
      );
    } catch {
      /* best-effort */
    }
  }
  // 'create' → no-op (the just-written file stands).
}

// ---------------------------------------------------------------------------
// Content-hash cache (.noir/dedup-cache.json).
// ---------------------------------------------------------------------------

interface DedupCache {
  version: number;
  model: string;
  entries: Record<string, { v: number[] }>;
}

function emptyCache(): DedupCache {
  return { version: DEDUP_CACHE_VERSION, model: '', entries: {} };
}

function cachePath(root: string): string {
  return join(root, '.noir', 'dedup-cache.json');
}

function loadCache(root: string): DedupCache {
  try {
    const raw = readFileSync(cachePath(root), 'utf8');
    const parsed = JSON.parse(raw) as Partial<DedupCache>;
    if (parsed.version !== DEDUP_CACHE_VERSION) return emptyCache();
    if (typeof parsed.entries !== 'object' || parsed.entries === null) return emptyCache();
    return {
      version: DEDUP_CACHE_VERSION,
      model: typeof parsed.model === 'string' ? parsed.model : '',
      entries: parsed.entries,
    };
  } catch {
    return emptyCache();
  }
}

function saveCache(root: string, cache: DedupCache): void {
  try {
    mkdirSync(join(root, '.noir'), { recursive: true });
    writeFileSync(cachePath(root), JSON.stringify(cache), 'utf8');
  } catch {
    // Best-effort; cache persistence is an enhancement, never a gate.
  }
}

/** Wrap `embed` with a SHA-256 content-hash cache. Cache hits return the
 *  stored vector WITHOUT calling `embed`; misses call `embed` and store. */
function makeCachedEmbed(cache: DedupCache, embed: EmbedLike): EmbedLike {
  return async (text: string): Promise<Float32Array> => {
    const key = createHash('sha256').update(text, 'utf8').digest('hex');
    const cached = cache.entries[key];
    if (cached !== undefined) return Float32Array.from(cached.v);
    const v = await embed(text);
    cache.entries[key] = { v: Array.from(v) };
    return v;
  };
}

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

/** SHA-256 hex of content, first 12 chars (matches B2's sha convention). */
function sha256Hex12(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
}

function safeRead(abs: string): string | undefined {
  try {
    return readFileSync(abs, 'utf8');
  } catch {
    return undefined;
  }
}

/** Resolve `p` OR undefined on timeout/throw (never rejects). The underlying
 *  promise keeps running in the background; we just stop awaiting it. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(undefined), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(undefined);
      },
    );
  });
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
