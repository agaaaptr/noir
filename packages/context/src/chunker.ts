// Chunker for @noir-ai/context (slice S6, task t4).
//
// Splits a file's content into embeddable/indexable `Chunk`s:
//   • Markdown (`.md`/`.mdx`) → one chunk per ATX-heading-delimited section
//     (code-fence-aware, so `#`-comment lines inside ``` blocks are NOT treated
//     as headings). The heading line is kept with its body so the heading text
//     carries a BM25 signal (spec DS-5).
//   • Everything else → line/token-bounded windows (~512 tokens, 64-token
//     overlap by default) via a cheap whitespace token estimate. Windows align
//     to line boundaries (never split mid-line); consecutive windows overlap by
//     roughly `overlap` tokens of trailing lines so retrieval has continuity.
//
// `id = \`${sha256(path)}#chunk-${n}\`` and `meta.parentDocId = sha256(path)`
// are stable across re-indexing — same path + content always yields the same
// chunk ids, which is what makes the indexer's content-hash skip/delete exact
// (spec DS-4, §7).
//
// `explodeIdentifiers` (DS-7) is exported here and used to derive
// `meta.sha256` (post-identifier-explosion, per the ChunkMeta contract): the
// indexer appends the same explosion stream to chunk content before
// `indexDoc`/`upsertVec` so camelCase/snake_case identifier queries get a BM25
// signal under the existing `porter unicode61` tokenizer — with NO schema
// migration (trigram is deferred, OQ-6). `withIdentifierExplosion` is the
// single canonical form of that append, so the chunker's hash and the
// indexer's stored content stay byte-identical.

import { sha256Hex } from './hash.js';
import type { Chunk, SourceKind } from './types.js';

// ---------------------------------------------------------------------------
// Tunable defaults (mirror the `context.chunk` config block, task t10)
// ---------------------------------------------------------------------------

/** Default maximum estimated tokens per non-markdown chunk (spec DS-5). */
export const DEFAULT_CHUNK_MAX_TOKENS = 512;

/** Default token overlap between consecutive non-markdown chunks (spec DS-5). */
export const DEFAULT_CHUNK_OVERLAP = 64;

/**
 * Cheap token estimate factor: ~1.3 tokens per whitespace-separated word (the
 * canonical "1 word ≈ 1.3 tokens" heuristic). Good enough for windowing/budget
 * packing without pulling in a tokenizer dep.
 */
export const TOKEN_ESTIMATE_FACTOR = 1.3;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Input to {@link chunkFile}. `path` + `content` are required; everything else
 * has a sensible default. `maxTokens`/`overlap` flow from the resolved
 * `context.chunk` config (task t10); `language`/`source` are inferred from the
 * path when omitted so a bare `chunkFile({path, content})` call just works.
 */
export interface ChunkOptions {
  /** Repo-relative or absolute path of the source file. */
  path: string;
  /** Full text content of the file (the caller reads it; the chunker never does I/O). */
  content: string;
  /**
   * Language hint (e.g. `'typescript'`, `'markdown'`). Inferred from the path
   * extension when absent (see {@link inferLanguage}).
   */
  language?: string;
  /**
   * Override the inferred {@link SourceKind}. Defaults to `'docs'` for
   * markdown and `'codebase'` otherwise; pass `'spec'`/`'memory'` when indexing
   * those trees explicitly.
   */
  source?: SourceKind;
  /** Max estimated tokens per code chunk (default {@link DEFAULT_CHUNK_MAX_TOKENS}). */
  maxTokens?: number;
  /** Token overlap between consecutive code chunks (default {@link DEFAULT_CHUNK_OVERLAP}). */
  overlap?: number;
}

// ---------------------------------------------------------------------------
// Identifier explosion (DS-7)
// ---------------------------------------------------------------------------

/**
 * Split the identifiers in `text` into lowercase tokens, expanding
 * camelCase / PascalCase / snake_case / kebab-case / digit boundaries.
 *
 * Examples:
 *   `contextEngine`   → `context engine`
 *   `ContextEngine`   → `context engine`
 *   `XMLHttpRequest`  → `xml http request`
 *   `myHTTPSConnection` → `my https connection`
 *   `snake_case`/`kebab-case` → `snake case` / `kebab case`
 *   `ctx:file:<path>` → `ctx file path`
 *
 * The stream is APPENDED to chunk content at index time (see
 * {@link withIdentifierExplosion}) so identifier queries match under
 * `porter unicode61` without a tokenizer migration. Pure/deterministic.
 */
export function explodeIdentifiers(text: string): string {
  // Match runs of [A-Za-z0-9]. '-' and '_' are intentionally excluded so
  // kebab/snake identifiers split at their separators for free; camelCase /
  // PascalCase boundaries are then split with two case-transition regexes.
  const words = text.match(/[A-Za-z0-9]+/g);
  if (!words) return '';
  const tokens: string[] = [];
  for (const word of words) {
    const spaced = word
      // lowercase|digit → uppercase:  myVar -> my Var | HttpContext -> Http Context
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      // uppercase-run → uppercase+lowercase:  XMLHttp -> XML Http | HTTPSConn -> HTTPS Conn
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
    for (const piece of spaced.split(/\s+/)) {
      if (piece.length > 0) tokens.push(piece.toLowerCase());
    }
  }
  return tokens.join(' ');
}

/**
 * The canonical index-time content for a chunk: its clean text followed by the
 * identifier-exploded token stream on a trailing line. Both the FTS row and
 * the embedding are produced from this exact string (so identifier queries get
 * a BM25 AND a semantic signal), and {@link chunkSha256} hashes this form to
 * match the `ChunkMeta.sha256` contract ("post-identifier-explosion").
 *
 * `chunk.content` itself stays CLEAN (no explosion) so FTS5 window-extracted
 * snippets read naturally — explosion is index-time-only (spec §7, DS-7).
 */
export function withIdentifierExplosion(content: string): string {
  const exploded = explodeIdentifiers(content);
  return exploded.length > 0 ? `${content}\n${exploded}` : content;
}

// ---------------------------------------------------------------------------
// Token estimation (shared with the retriever's budget packer)
// ---------------------------------------------------------------------------

/**
 * Cheap token-count proxy: ~1.3 tokens per whitespace-separated word (see
 * {@link TOKEN_ESTIMATE_FACTOR}). Empty/whitespace-only text → 0. Used both
 * for chunk windowing and (exported) for the retriever's budget packing.
 */
export function estimateTokens(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  const words = trimmed.split(/\s+/).filter((w) => w.length > 0);
  return Math.ceil(words.length * TOKEN_ESTIMATE_FACTOR);
}

// ---------------------------------------------------------------------------
// Language + source inference
// ---------------------------------------------------------------------------

const EXT_TO_LANGUAGE: Readonly<Record<string, string>> = {
  ts: 'typescript',
  tsx: 'tsx',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  md: 'markdown',
  mdx: 'markdown',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  json: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  sql: 'sql',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  xml: 'xml',
  txt: 'text',
};

/**
 * Best-effort language tag from the path extension (e.g. `.ts` → `'typescript'`).
 * Unknown extensions fall back to `'text'`. Used as the `language` default and
 * recorded per-file in the indexer's KV.
 */
export function inferLanguage(path: string): string {
  const ext = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (!ext) return 'text';
  return EXT_TO_LANGUAGE[ext] ?? 'text';
}

/** Markdown is detected by extension OR an explicit `language: 'markdown'`. */
function isMarkdown(path: string, language?: string): boolean {
  if (language === 'markdown') return true;
  return /\.(md|mdx)$/i.test(path);
}

/**
 * Default {@link SourceKind}: markdown → `'docs'`, everything else →
 * `'codebase'`. Callers indexing the spec tree or (S7) memory override via
 * {@link ChunkOptions.source}.
 */
function defaultSource(path: string, language?: string): SourceKind {
  return isMarkdown(path, language) ? 'docs' : 'codebase';
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/** `parentDocId` + `chunkId` root — `sha256(path)`, stable across re-index. */
function parentDocIdOf(path: string): string {
  return sha256Hex(path);
}

/**
 * SHA-256 over a chunk's POST-identifier-explosion content (the exact string
 * the indexer stores/embeds), per the `ChunkMeta.sha256` contract. Reproducible
 * via {@link withIdentifierExplosion}.
 */
function chunkSha256(content: string): string {
  return sha256Hex(withIdentifierExplosion(content));
}

// ---------------------------------------------------------------------------
// Markdown sectioning (code-fence-aware ATX-heading split)
// ---------------------------------------------------------------------------

const ATX_HEADING = /^(#{1,6})\s/;
const FENCE_OPEN = /^\s*(`{3,}|~{3,})/;

/**
 * Split markdown into one section per ATX heading. Each section's body is the
 * heading line + its non-heading lines. `#`-comment lines inside a `` ` `` or
 * `~~~` code fence are NOT treated as headings (common in docs with code
 * samples — guards against false splits). A non-empty preamble before the
 * first heading becomes its own section.
 */
function markdownSections(content: string): string[] {
  const lines = content.split('\n');
  const sections: string[] = [];
  let current: string[] = [];
  let inFence = false;
  let fenceMarker = '';

  const flush = (): void => {
    if (current.length === 0) return;
    const body = current.join('\n').replace(/\s+$/, '');
    if (body.length > 0) sections.push(body);
    current = [];
  };

  for (const line of lines) {
    // Track code fences so `#` lines inside them don't read as headings.
    const fence = FENCE_OPEN.exec(line);
    if (fence && fence[1]) {
      const marker = fence[1].charAt(0);
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = '';
      }
      current.push(line);
      continue;
    }
    if (!inFence && ATX_HEADING.test(line)) {
      flush();
      current = [line];
    } else {
      current.push(line);
    }
  }
  flush();
  return sections;
}

// ---------------------------------------------------------------------------
// Code windowing (line-bounded, token-budgeted, overlapping)
// ---------------------------------------------------------------------------

/**
 * Split code/general text into line-bounded windows of ~`maxTokens` estimated
 * tokens with ~`overlap` tokens of trailing-line overlap between consecutive
 * windows.
 *
 * Properties:
 *   • Windows never split a line mid-line — a single line that alone exceeds
 *     `maxTokens` is emitted as its own chunk (rather than being dropped).
 *   • Consecutive multi-line windows always overlap by at least one line, so a
 *     retrieval hit near a boundary isn't lost (and the overlap is observable).
 *   • Pure/deterministic: identical input → identical windows. Forward progress
 *     is guaranteed (each iteration advances `start` by ≥ 1).
 */
function codeWindows(content: string, maxTokens: number, overlap: number): string[] {
  const lines = content.split('\n');
  const n = lines.length;
  if (n === 0) return [];

  const windows: string[] = [];
  let start = 0;
  // Safety guard against any logic error turning this into a spin (each
  // iteration advances `start`, so `n` iterations is the real bound).
  let safety = 2 * n + 8;

  while (start < n && safety > 0) {
    safety -= 1;
    // Extend [start, end): accumulate lines while estimated tokens ≤ maxTokens.
    // The first line is always admitted (even if it alone exceeds the budget).
    let end = start;
    let body = '';
    for (let i = start; i < n; i++) {
      const line = lines[i];
      if (line === undefined) break;
      const trial = body.length === 0 ? line : `${body}\n${line}`;
      if (i > start && estimateTokens(trial) > maxTokens) break;
      body = trial;
      end = i + 1;
    }
    if (body.length > 0) windows.push(body);

    if (end >= n) break;
    // Single-line window or no-progress: advance past it (no overlap possible).
    if (end - 1 <= start) {
      start = end;
      continue;
    }
    // Multi-line window: step back from `end` toward `start` carrying lines
    // until their estimated tokens reach `overlap`. Clamp into (start, end-1]
    // for guaranteed overlap + forward progress.
    let carryStart = end - 1;
    let carried = 0;
    while (carryStart > start && carried < overlap) {
      const line = lines[carryStart];
      if (line === undefined) {
        carryStart -= 1;
        continue;
      }
      carried += estimateTokens(line);
      if (carried >= overlap) break;
      carryStart -= 1;
    }
    if (carryStart <= start) carryStart = start + 1;
    if (carryStart > end - 1) carryStart = end - 1;
    start = carryStart;
  }
  return windows;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Split a file's content into {@link Chunk}s.
 *
 * Markdown → heading-delimited sections; everything else → overlapping
 * line/token windows. Each chunk's `id` is `<sha256(path)>#chunk-<n>` and
 * `meta.parentDocId` is `sha256(path)` (stable across re-indexing), with
 * `meta.sha256` over the post-identifier-explosion content (see
 * {@link withIdentifierExplosion}). Empty content yields no chunks.
 */
export function chunkFile(opts: ChunkOptions): Chunk[] {
  const { path, content } = opts;
  // Reject empty AND whitespace-only content (whitespace has length > 0 but
  // carries no chunk signal — would otherwise yield a spurious blank chunk).
  if (content.trim().length === 0) return [];

  const language = opts.language ?? inferLanguage(path);
  const source = opts.source ?? defaultSource(path, language);
  const maxTokens = opts.maxTokens ?? DEFAULT_CHUNK_MAX_TOKENS;
  const overlap = opts.overlap ?? DEFAULT_CHUNK_OVERLAP;
  const parentDocId = parentDocIdOf(path);

  const bodies = isMarkdown(path, language)
    ? markdownSections(content)
    : codeWindows(content, maxTokens, overlap);

  const chunks: Chunk[] = [];
  for (let i = 0; i < bodies.length; i++) {
    const body = bodies[i];
    if (body === undefined || body.length === 0) continue;
    chunks.push({
      id: `${parentDocId}#chunk-${i}`,
      source,
      content: body,
      meta: {
        path,
        parentDocId,
        chunkIndex: i,
        language,
        sha256: chunkSha256(body),
      },
    });
  }
  return chunks;
}
