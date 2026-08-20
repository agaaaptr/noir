// Indexer for @noir-ai/context.
//
// SHA-256 content-hash incremental indexer over the existing Store. The daemon
// is the single writer; the indexer never opens a second connection — it walks
// the given paths through the INJECTED store handle only (blueprint D6:
// in-process, no sidecar, canonical ProjectId).
//
// Per file the indexer:
//   1. chunks it (chunker.ts: markdown-heading | line/token windows);
//   2. appends the identifier-exploded token stream to form the CANONICAL
//      indexed content — the SAME string feeds `indexDoc` (FTS) and `upsertVec`
//      (embedding) so BM25 and kNN join on identical material under the SAME
//      chunk id;
//   3. writes one `docs` row + one `vec0` row per chunk, keyed by the chunk's
//      own SourceKind (`'docs'` | `'codebase'` | …) so the retriever's
//      per-source filter stays meaningful.
//
// Incremental discipline: each file's UTF-8 SHA-256 is the
// skip key. Unchanged files are skipped wholesale (their chunk count rolls into
// `skipped`); changed files have their old chunks + vectors deleted, then
// re-inserted; files removed since the last scan (and under a re-scanned root)
// have their chunks + vectors deleted and are dropped from the registry. The
// first call on a fresh store naturally seeds a full reindex (registry empty ⇒
// everything is new).
//
// State lives in the store KV, namespaced `ctx:` to stay disjoint from
// `workflow:*` and store meta:
//   ctx:registry        → string[]             indexed path keys (sorted)
//   ctx:file:<key>      → FileRecord           per-file {sha256, chunkIds, language}
//   ctx:embedder        → EmbedderInfo         recorded once; model swap ⇒ warn (never silent)
//
// Degraded path (spec F8, mirrored for indexing): when the embedder is
// `kind:'none'` or `embed()` throws (native load failed / misconfigured remote),
// the indexer disables embedding for the rest of the run, still indexes the
// `docs` rows, and reports `degraded:true` — it never crashes on a bad embedder.

import type { Dirent } from 'node:fs';
import { readFileSync, realpathSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { chunkFile, inferLanguage, withIdentifierExplosion } from './chunker.js';
import { sha256Hex } from './hash.js';
import type { ChunkMeta, EmbedderInfo, EmbedFn, IndexResult, SourceKind, Store } from './types.js';

// ---------------------------------------------------------------------------
// KV schema (namespaced `ctx:` — disjoint from `workflow:*` / store meta)
// ---------------------------------------------------------------------------

/** KV key holding the sorted list of indexed path keys. */
export const CTX_REGISTRY_KEY = 'ctx:registry';
/** KV key holding the recorded {@link EmbedderInfo} (model-swap detection). */
export const CTX_EMBEDDER_KEY = 'ctx:embedder';
/** Per-file record key prefix; the value is a {@link FileRecord} (or `null` tombstone). */
export const CTX_FILE_PREFIX = 'ctx:file:';

/**
 * Per-file tracking record stored under {@link ctxFileKey}. `sha256` is the
 * content-hash skip key; `chunkIds` lets a change/removal delete exactly the
 * rows that belong to this file; `language` mirrors the chunker's inference.
 */
export interface FileRecord {
  /** SHA-256 of the file's UTF-8 content — the content-hash skip key. */
  sha256: string;
  /** Chunk ids belonging to this file (for exact delete on change/removal). */
  chunkIds: string[];
  /** Detected language tag (mirrors the chunker's inference). */
  language: string;
}

/** Build a `ctx:file:<key>` KV key. */
export function ctxFileKey(pathKey: string): string {
  return `${CTX_FILE_PREFIX}${pathKey}`;
}

// ---------------------------------------------------------------------------
// Walk skips (VCS / Noir state / build artifacts / dependency trees)
// ---------------------------------------------------------------------------

/**
 * Directory names never descended into during a walk (spec F1). Covers the
 * common `.gitignore` entries without needing a gitignore parser — full
 * `.gitignore` intersection (and `git diff --name-only` for incremental scope)
 * is deferred v0 debt (grounds §10 indexing trigger).
 */
export const SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  '.noir',
  'node_modules',
  'bower_components',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'coverage',
  '.nyc_output',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.idea',
  '.vscode',
]);

/**
 * Extensions treated as binary and therefore unindexable (counted as `failed`,
 * never read in full — the extension check is cheap and avoids slurping large
 * assets). The null-byte guard below catches mis-extensioned binaries.
 */
const BINARY_EXTS = new Set([
  // Images
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'ico',
  'bmp',
  'tif',
  'tiff',
  'svgz',
  'heic',
  'avif',
  // Audio / video
  'mp3',
  'mp4',
  'mov',
  'avi',
  'mkv',
  'flac',
  'wav',
  'ogg',
  'webm',
  'aac',
  'm4a',
  // Archives
  'zip',
  'gz',
  'tar',
  'tgz',
  'br',
  'lz',
  'lzma',
  '7z',
  'rar',
  'bz2',
  // Documents (binary)
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  // Compiled / native
  'wasm',
  'exe',
  'dll',
  'so',
  'dylib',
  'a',
  'o',
  'obj',
  'lib',
  'class',
  'jar',
  'war',
  'pyc',
  'pyo',
  'pyd',
  // ML / model artifacts
  'onnx',
  'pickle',
  'pt',
  'bin',
  // Databases / locks
  'db',
  'sqlite',
  'sqlite3',
  'db-shm',
  'db-wal',
  'lock',
  // Fonts
  'ttf',
  'otf',
  'woff',
  'woff2',
  'eot',
]);

/** True if the path's extension is a known binary type. */
export function isBinaryExt(pathOrName: string): boolean {
  const m = pathOrName.toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!m?.[1]) return false;
  return BINARY_EXTS.has(m[1]);
}

// ---------------------------------------------------------------------------
// Sensitive-file denylist (post-review hardening: prevent secret exposure via
// context_search). These files are NEVER chunked/embedded/indexed even when
// they are plain text — indexing a `.env` or `id_rsa` would leak its contents
// into FTS + vector snippets. Covers env files, private keys, credential
// stores, and OS junk. Path-aware: pass a basename or a `/`-separated rel path.
// ---------------------------------------------------------------------------

/** Exact basenames never indexed (case-insensitive). */
const SENSITIVE_NAMES = new Set([
  '.env',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  '.netrc',
  '.ds_store',
  'thumbs.db',
]);

/**
 * Basename prefixes (covers `.env.local` / `.env.production`, `id_rsa` /
 * `id_rsa.pub`, `id_ed25519` / `id_ed25519.pub`). Matched against the basename
 * only so a path segment like `deploy/` does not false-negative.
 */
const SENSITIVE_PREFIXES = ['.env.', 'id_rsa', 'id_ed25519'];

/** Basename suffixes (covers `*.pem`, `*.key`, `*.secret`, `*.p12`, `*.pfx`, `*.local`). */
const SENSITIVE_SUFFIXES = ['.pem', '.key', '.secret', '.p12', '.pfx', '.local'];

/**
 * Relative-path patterns not caught by a basename check — `.aws/credentials`
 * has the generic basename `credentials`, so it is anchored on the path suffix
 * instead (a bare `credentials` basename is intentionally NOT flagged).
 */
const SENSITIVE_PATHS = ['.aws/credentials'];

/**
 * True if `name` is a sensitive file that must NEVER be chunked, embedded, or
 * indexed. Accepts a bare basename (`id_rsa`, `.env`, `cert.pem`) OR a
 * `/`-separated relative path (`deploy/id_rsa`, `.aws/credentials`); the
 * basename is extracted internally so prefix/suffix checks anchor on the file
 * name rather than a path segment. Wired into the walk's skip decision
 * alongside {@link isBinaryExt} so secrets never reach `indexDoc` / `upsertVec`.
 */
export function isSensitive(name: string): boolean {
  const lower = name.toLowerCase();
  // Path-anchored first (basename `credentials` alone is too generic to flag).
  for (const p of SENSITIVE_PATHS) {
    if (lower === p || lower.endsWith(`/${p}`)) return true;
  }
  const base = lower.slice(lower.lastIndexOf('/') + 1);
  if (SENSITIVE_NAMES.has(base)) return true;
  for (const pf of SENSITIVE_PREFIXES) {
    if (base.startsWith(pf)) return true;
  }
  for (const sf of SENSITIVE_SUFFIXES) {
    if (base.endsWith(sf)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Small path helpers (stable, cross-platform keys)
// ---------------------------------------------------------------------------

/** Normalize OS separators to `/` so registry keys match across platforms. */
function posix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

// ---------------------------------------------------------------------------
// Options + return types
// ---------------------------------------------------------------------------

/** Construction options for {@link createIndexer}. */
export interface IndexerOptions {
  /** The daemon's store handle — the ONLY storage surface used (single writer). */
  store: Store;
  /** The resolved embedder. Failures here degrade the run (F8-style), never crash. */
  embed: EmbedFn;
  /** Active embedder description; recorded in KV for model-swap detection. */
  info: EmbedderInfo;
  /**
   * Optional repository root. When provided, paths passed to
   * {@link Indexer.indexPaths} are resolved against it AND stored repo-relative
   * (portable `meta.path`, stable across checkouts). When omitted, paths resolve
   * against `process.cwd()` and are stored absolute.
   */
  root?: string;
}

/** Per-call options for {@link Indexer.indexPaths}. */
export interface IndexPathOptions {
  /** Chunk size override (flows from `context.chunk.maxTokens`). */
  maxTokens?: number;
  /** Chunk overlap override (flows from `context.chunk.overlap`). */
  overlap?: number;
  /**
   * Override the source bucket for every file in this call (otherwise the
   * chunker infers `'docs'` for markdown and `'codebase'` for everything else).
   */
  source?: SourceKind;
}

/** Return value of {@link Indexer.forget}. */
export interface ForgetResult {
  /** Files removed from the index (their chunks + vectors were deleted). */
  deleted: number;
  /** Total chunks now tracked. */
  totalChunks: number;
}

/** The indexer surface returned by {@link createIndexer}. */
export interface Indexer {
  /**
   * Walk + incrementally index `paths` (files or directories). Removed files
   * under a re-scanned root are reconciled (deleted). Returns chunk/file counts
   * + the `degraded` flag (spec F1/F3/F4, AC-1).
   */
  indexPaths(paths: string[], opts?: IndexPathOptions): Promise<IndexResult>;
  /** Remove `paths` (files or dirs) from the index; deletes their chunks + vectors. */
  forget(paths: string[]): Promise<ForgetResult>;
  /** Drop every indexed chunk + vector, then re-index the registered roots from scratch. */
  reindex(): Promise<IndexResult>;
  /**
   * Read a single chunk's CLEAN content + meta by id, by re-reading the source
   * file from disk and re-chunking it (the indexer writes the post-identifier-
   * explosion form to the `docs` table for FTS — the CLEAN pre-explosion text
   * is what a kNN-only-hit snippet wants, since it is what humans read). This
   * is the read side of the indexer's own writer: it knows the registry layout
   * (`ctx:registry` + `ctx:file:<key>`) and the chunk-id format
   * (`<sha256(path)>#chunk-<n>`), so it is the natural place to look up a
   * chunk by id.
   *
   * Used by the engine to hydrate kNN-only retriever hits — wired as the
   * retriever's `readDoc`. Returns `null` when:
   *   • the chunk id is not in any tracked FileRecord (deleted, or never
   *     indexed — e.g. a vec row whose `docs` row came from a foreign source);
   *   • the source file is missing/unreadable on disk (deleted/moved/perm);
   *   • the file's content changed and the re-chunk no longer yields this id.
   *
   * In all miss cases the caller (retriever) emits an empty snippet and the
   * payload's `mode` honestly reflects `'knn'` — never crashes.
   */
  readChunkContent(id: string): { content: string; meta: ChunkMeta } | null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build an {@link Indexer} bound to a single store handle. Construction does no
 * I/O and touches no KV — all work happens inside `indexPaths`/`forget`/`reindex`.
 */
export function createIndexer(opts: IndexerOptions): Indexer {
  const { store, embed, info } = opts;
  // Canonicalize the root ONCE so every confinement comparison and stored key
  // operates on the same canonical namespace. Without this, on macOS (where
  // `/var` → `/private/var` and `/tmp` → `/private/tmp` are symlinks) a
  // realpath'd input lands in `/private/var/…` while `base` stays lexical
  // `/var/…` — isWithinRoot would then reject every input. A nonexistent root
  // falls back to the lexical path (the indexer will simply index nothing).
  const lexicalBase = opts.root ?? process.cwd();
  let base: string;
  try {
    base = realpathSync(lexicalBase);
  } catch {
    base = lexicalBase;
  }

  // Single-flight serialization of mutating ops (post-review: prevent registry
  // KV races). `indexPaths` / `forget` / `reindex` do read-modify-write on the
  // `ctx:registry` / `ctx:file:*` KV across `await readdir` / `readFile` /
  // `embed` suspension points; without serialization, two CONCURRENT calls each
  // load the same registry snapshot, mutate their own copy, and persist
  // last-write-wins — orphaning the loser's chunks + vectors in `docs`/`vec0`
  // with no registry entry to ever reconcile them away. This promise chain
  // forces ALL mutating ops to run strictly one at a time over the shared
  // handle. Reads (the retriever's `search`, the engine's `status`) bypass the
  // chain entirely and stay concurrent.
  let chain: Promise<unknown> = Promise.resolve();
  function serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = chain.then(work);
    // Advance the chain regardless of whether `work` resolves or rejects: a
    // failed op must not poison the queue for the next caller. The caller
    // observes the real outcome via `result`; the chain only tracks readiness.
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  // path helpers --------------------------------------------------------------
  // Canonicalize inputs too (base is already realpath'd above): a symlinked
  // input resolves to its TARGET, so confinement + keys + forget all operate on
  // the same canonical namespace. A missing path falls back to the lexical form
  // (forget/reconcile reference deleted files that no longer realpath).
  const resolveAbs = (p: string): string => {
    const abs = resolve(base, p);
    try {
      return realpathSync(abs);
    } catch {
      return abs;
    }
  };
  // When `root` is given, keys are repo-relative to the CANONICAL base
  // (portable); otherwise absolute. `relative(base, …)` — base is canonical, so
  // this matches the canonical abs from resolveAbs/walk (not the lexical root).
  const toKey = (abs: string): string => (opts.root ? relative(base, abs) : abs);
  const keyAbs = (key: string): string => posix(resolve(base, key));

  /**
   * Path confinement (post-review): resolve-then-confine. True only when `abs`
   * is the project root itself or lives beneath it. Applied to BOTH the
   * explicit `paths` arguments and the walk's yielded entries so an absolute
   * out-of-root path (`/etc/passwd`) or a `../sibling` traversal is skipped —
   * never ingested, never stored as a `../../...` or absolute `meta.path`.
   */
  function isWithinRoot(abs: string): boolean {
    const r = resolve(base);
    const a = resolve(abs);
    return a === r || a.startsWith(`${r}${sep}`);
  }

  // store helpers -------------------------------------------------------------
  function deleteChunks(ids: string[]): void {
    for (const id of ids) {
      store.deleteDoc(id);
      store.deleteVec(id);
    }
  }

  /** Load every per-file record currently in the registry into a Map. */
  function loadRecords(): Map<string, FileRecord> {
    const registry = store.getState<string[]>(CTX_REGISTRY_KEY) ?? [];
    const records = new Map<string, FileRecord>();
    for (const p of registry) {
      const rec = store.getState<FileRecord>(ctxFileKey(p));
      if (rec) records.set(p, rec);
    }
    return records;
  }

  // chunkId → owner-key reverse index. Built lazily from the registry and
  // invalidated on every persist, so readChunkContent is O(1) instead of an
  // O(N) registry scan per kNN-only hit (which cost tens of thousands of KV
  // reads per query on a large repo).
  let chunkOwner: Map<string, string> | null = null;
  function ownerOfChunk(id: string): string | null {
    if (chunkOwner === null) {
      chunkOwner = new Map();
      for (const [key, rec] of loadRecords()) {
        for (const cid of rec.chunkIds) chunkOwner.set(cid, key);
      }
    }
    return chunkOwner.get(id) ?? null;
  }

  /** Write back the registry + per-file records; tombstone the removed keys. */
  function persist(records: Map<string, FileRecord>, tombstones: string[]): void {
    store.setState(CTX_REGISTRY_KEY, [...records.keys()].sort());
    for (const [key, rec] of records) store.setState(ctxFileKey(key), rec);
    for (const key of tombstones) store.setState(ctxFileKey(key), null);
    chunkOwner = null; // invalidate the reverse index — the registry changed
  }

  /**
   * Record the active embedder in KV. On a model swap (kind/model/dim change),
   * warn loudly — vectors may now be incompatible — but NEVER auto-reindex; the
   * caller decides via `reindex()` (spec §7: "warn + offer reindex, not silent").
   */
  function recordEmbedder(): void {
    const prev = store.getState<EmbedderInfo>(CTX_EMBEDDER_KEY);
    if (prev === null) {
      store.setState(CTX_EMBEDDER_KEY, info);
      return;
    }
    if (!sameEmbedder(prev, info)) {
      console.warn(
        `[noir-context] embedder changed (${describeEmbedder(prev)} → ${describeEmbedder(info)}); ` +
          'existing vectors may be stale — call reindex() to refresh',
      );
      store.setState(CTX_EMBEDDER_KEY, info);
    }
  }

  // walk ----------------------------------------------------------------------
  /** Recursively collect files under `rootAbs`, skipping {@link SKIP_DIRS}. */
  async function walk(rootAbs: string): Promise<string[]> {
    const out: string[] = [];
    const stack: string[] = [rootAbs];
    while (stack.length > 0) {
      const dir = stack.pop();
      if (dir === undefined) break;
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable / restricted → skip silently (don't fail the run)
      }
      for (const ent of entries) {
        if (ent.isDirectory()) {
          if (SKIP_DIRS.has(ent.name)) continue;
          stack.push(join(dir, ent.name));
        } else if (ent.isFile()) {
          out.push(join(dir, ent.name));
        }
      }
    }
    return out;
  }

  /** Is `absKey` underneath (or equal to) any of the re-scanned `absRoots`? */
  function inScope(absKey: string, absRoots: string[]): boolean {
    for (const r of absRoots) {
      const rp = posix(r);
      if (absKey === rp || absKey.startsWith(`${rp}/`)) return true;
    }
    return false;
  }

  // --- indexPaths ------------------------------------------------------------
  async function indexPaths(inputPaths: string[], o?: IndexPathOptions): Promise<IndexResult> {
    recordEmbedder();
    const records = loadRecords();

    // Resolve inputs → absolute roots; walk dirs / admit files into `scanned`.
    const absRoots: string[] = [];
    const scanned = new Map<string, string>(); // key -> abs
    for (const input of inputPaths) {
      // resolveAbs CANONICALIZES the input (realpath) — so a symlink whose
      // target escapes `base` (e.g. `noir context index <symlink-to-/etc>`)
      // resolves OUTSIDE and is skipped by the confinement check below. Walk
      // entries are already safe: Dirent.isFile()/isDirectory() are false for
      // symlinks, so the walk never follows an inner symlink.
      const abs = resolveAbs(input);
      // Path confinement: reject traversal / out-of-root ingestion. An absolute
      // path (`/etc/passwd`) or a `../sibling` (or a symlink escaping root)
      // resolves outside `base`; skip it entirely — never stat, never walk,
      // never store a `../` meta.path.
      if (!isWithinRoot(abs)) continue;
      // Register the input as a reconcile ROOT even when it no longer exists: a
      // previously-indexed FILE that was deleted must still be in-scope for the
      // reconcile step (which removes stale chunks/records). Without this, a
      // deleted single-file input is skipped here, never lands in absRoots, and
      // its stale chunks survive forever.
      absRoots.push(abs);
      const st = await stat(abs).catch(() => null);
      if (st === null) continue; // missing path — nothing to index (reconcile handles it)
      if (st.isDirectory()) {
        for (const file of await walk(abs)) {
          // Defensive confinement on walk entries: the walk starts in-root, but
          // a symlink resolved by stat/readdir could point outside — re-check.
          if (!isWithinRoot(file)) continue;
          scanned.set(posix(toKey(file)), file);
        }
      } else if (st.isFile()) {
        scanned.set(posix(toKey(abs)), abs);
      }
    }

    let indexed = 0;
    let skipped = 0;
    let failed = 0;
    let deleted = 0;
    // `kind:'none'` ⇒ no vectors from the start; a thrown embed() flips this mid-run.
    let embedDisabled = info.kind === 'none';
    // A successful embed whose vector write FAILED (vec native layer absent /
    // incompatible width) also degrades the run to BM25-only — same F8 policy,
    // just from the store side instead of the embed side.
    let vecStoreUnavailable = false;
    const tombstones: string[] = [];

    const tryEmbed = async (content: string): Promise<Float32Array | null> => {
      if (embedDisabled) return null;
      try {
        return await embed(content);
      } catch {
        // First failure (native load / config / network) ⇒ disable for the rest
        // of the run. Docs still get indexed; their vectors are skipped (F8).
        embedDisabled = true;
        return null;
      }
    };

    // 1. Reconcile removals: registry entries under a re-scanned root that are
    //    no longer on disk get their chunks + vectors deleted. Files indexed
    //    under OTHER roots are left untouched (incremental, scoped reconcile).
    for (const key of [...records.keys()]) {
      if (scanned.has(key)) continue;
      if (!inScope(keyAbs(key), absRoots)) continue;
      const rec = records.get(key);
      if (rec) deleteChunks(rec.chunkIds);
      records.delete(key);
      tombstones.push(key);
      deleted += 1;
    }

    // 2. Index scanned files (skip unchanged by content-hash; re-chunk changed).
    for (const [key, abs] of scanned) {
      // Binary by extension ⇒ unindexable (cheap check, no full read). Counts as
      // `failed` per the IndexResult contract (binary / IO / encoding).
      if (isBinaryExt(key)) {
        failed += 1;
        continue;
      }
      // Sensitive file (secret / key / credential) ⇒ NEVER chunked, embedded, or
      // indexed, even when plain text — prevents secret exposure via
      // `context_search` snippets. Counts as `failed` (deliberately excluded by
      // policy, like the binary guard above). Post-review hardening.
      if (isSensitive(key)) {
        failed += 1;
        continue;
      }
      let content: string;
      try {
        content = await readFile(abs, 'utf8');
      } catch {
        failed += 1;
        continue;
      }
      if (content.includes(String.fromCharCode(0))) {
        // Null byte ⇒ binary masquerading as text (extension check missed it).
        failed += 1;
        continue;
      }

      const fileHash = sha256Hex(content);
      const prev = records.get(key);
      if (prev !== undefined && prev.sha256 === fileHash) {
        // Content-hash hit: skip wholesale (AC-1). Roll the chunk count into `skipped`.
        skipped += prev.chunkIds.length;
        continue;
      }
      // Changed or new: delete the file's prior chunks before re-inserting.
      if (prev !== undefined) deleteChunks(prev.chunkIds);

      const chunks = chunkFile({
        path: key,
        content,
        source: o?.source,
        maxTokens: o?.maxTokens,
        overlap: o?.overlap,
      });
      const chunkIds: string[] = [];
      let language = inferLanguage(key);
      for (const chunk of chunks) {
        // Canonical indexed content: clean text + identifier explosion.
        // Both FTS and the embedding consume this exact string; chunk.meta.sha256
        // (computed by the chunker) is the hash of this same form.
        const indexedContent = withIdentifierExplosion(chunk.content);
        store.indexDoc({
          id: chunk.id,
          source: chunk.source,
          content: indexedContent,
          meta: chunk.meta,
        });
        language = chunk.meta.language;
        const vec = await tryEmbed(indexedContent);
        if (vec !== null) {
          try {
            store.upsertVec(chunk.id, vec, { source: chunk.source });
          } catch {
            // vec store write failed (sqlite-vec native binary absent, or the
            // vector width mismatches the fixed vec0 table) — degrade THIS run
            // to BM25-only instead of aborting the whole index. Docs already
            // indexed above stay; the remaining files keep indexing without
            // vectors (mirrors memory's indexObservation try/catch).
            vecStoreUnavailable = true;
          }
        }
        chunkIds.push(chunk.id);
        indexed += 1;
      }
      records.set(key, { sha256: fileHash, chunkIds, language });
    }

    persist(records, tombstones);

    let totalChunks = 0;
    for (const rec of records.values()) totalChunks += rec.chunkIds.length;

    return {
      indexed,
      skipped,
      deleted,
      failed,
      totalChunks,
      // `degraded` is truthful about "docs indexed without vectors": only set
      // when embedding was off (or its writes failed) AND at least one doc went
      // in without one.
      degraded: (embedDisabled || vecStoreUnavailable) && indexed > 0,
    };
  }

  // --- forget ----------------------------------------------------------------
  async function forget(inputPaths: string[]): Promise<ForgetResult> {
    const records = loadRecords();
    const targets = inputPaths.map((p) => posix(resolveAbs(p)));
    const tombstones: string[] = [];
    for (const key of [...records.keys()]) {
      const abs = keyAbs(key);
      const hit = targets.some((t) => abs === t || abs.startsWith(`${t}/`));
      if (!hit) continue;
      const rec = records.get(key);
      if (rec) deleteChunks(rec.chunkIds);
      records.delete(key);
      tombstones.push(key);
    }
    persist(records, tombstones);
    let totalChunks = 0;
    for (const rec of records.values()) totalChunks += rec.chunkIds.length;
    return { deleted: tombstones.length, totalChunks };
  }

  // --- reindex ---------------------------------------------------------------
  async function reindex(): Promise<IndexResult> {
    // Wipe the registry + every per-file record, deleting all chunks + vectors,
    // then re-index the SAME roots from scratch (typically after a model swap).
    const registry = store.getState<string[]>(CTX_REGISTRY_KEY) ?? [];
    const tombstones: string[] = [];
    for (const key of registry) {
      const rec = store.getState<FileRecord>(ctxFileKey(key));
      if (rec) deleteChunks(rec.chunkIds);
      tombstones.push(key);
    }
    persist(new Map(), tombstones);
    // `registry` holds the prior path keys (relative-to-root or absolute); they
    // resolve back to absolute via `base` inside indexPaths.
    return indexPaths(registry);
  }

  // --- readChunkContent ------------------------------------------------------
  /**
   * Read-side companion to `indexPaths`/`forget`/`reindex`. Look up a chunk's
   * CLEAN content + meta by id, by re-reading the source file from disk and
   * re-chunking it (the CLEAN pre-explosion text is what a kNN-only snippet
   * wants — humans read it; the post-identifier-explosion form is FTS-only).
   *
   * The chunk-id format is `<parentDocId>#chunk-<n>` where `parentDocId =
   * sha256(path)`, but the indexer keys FileRecords by PATH KEY (which may be
   * repo-relative OR absolute depending on `opts.root`), NOT by sha256(path).
   * So the lookup walks the registry's FileRecords and picks the one whose
   * `chunkIds` contains `id`. Returns `null` on any miss (no entry, missing
   * file, content drift) so the retriever degrades honestly to `mode:'knn'`.
   *
   * Pure-read: no KV mutation, no `await` (synchronous file reads via
   * `readFileSync`). Bypasses the serialized mutation queue — reads can run
   * freely concurrent with each other AND with a concurrent `indexPaths`
   * (SQLite WAL handles read concurrency; the worst case is a transient
   * content-mismatch miss, which surfaces honestly as `mode:'knn'`).
   */
  function readChunkContent(id: string): { content: string; meta: ChunkMeta } | null {
    // O(1) lookup via the chunkId → owner reverse index (built lazily, invalidated
    // on persist) instead of scanning every FileRecord per hit.
    const ownerKey = ownerOfChunk(id);
    if (ownerKey === null) return null;
    // Resolve the path key back to an absolute path the same way indexPaths
    // does (`base` is the indexer's `opts.root ?? process.cwd()`). POSIX-form
    // the result to match the on-disk key separator. Confine the READ the same
    // way writes are confined — a corrupted/foreign registry entry must never
    // read a file outside the project root.
    const abs = keyAbs(ownerKey);
    if (!isWithinRoot(abs)) return null;
    let content: string;
    try {
      content = readFileSync(abs, 'utf8');
    } catch {
      // Missing/unreadable file (deleted, moved, permissions). Surface as a
      // null miss — the retriever reports mode:'knn'.
      return null;
    }
    // Null-byte guard mirrors indexPaths: don't trust a file that turned binary
    // under us (would yield garbage chunks); treat as a miss.
    if (content.includes(String.fromCharCode(0))) return null;
    // Re-chunk and pick the chunk whose id matches. If the file's content
    // drifted (chunkIds no longer line up), this returns null honestly.
    const chunks = chunkFile({ path: ownerKey, content });
    const found = chunks.find((c) => c.id === id);
    if (!found) return null;
    return { content: found.content, meta: found.meta };
  }

  // Mutating ops are wrapped in `serialized` so they run strictly one at a time
  // over the shared store handle (see `chain` above). The inner closures call
  // the un-wrapped functions directly: `reindex` invokes `indexPaths` inline
  // within its own serialized slot, so there is no re-queue / deadlock.
  // `readChunkContent` is a pure read and bypasses the queue (see its JSDoc).
  return {
    indexPaths: (inputPaths: string[], o?: IndexPathOptions) =>
      serialized(() => indexPaths(inputPaths, o)),
    forget: (inputPaths: string[]) => serialized(() => forget(inputPaths)),
    reindex: () => serialized(reindex),
    readChunkContent,
  };
}

// ---------------------------------------------------------------------------
// Embedder comparison (model-swap detection)
// ---------------------------------------------------------------------------

function sameEmbedder(a: EmbedderInfo, b: EmbedderInfo): boolean {
  return a.kind === b.kind && a.model === b.model && a.dim === b.dim;
}

function describeEmbedder(e: EmbedderInfo): string {
  return e.model ? `${e.kind}:${e.model}(${e.dim})` : `${e.kind}(${e.dim})`;
}
