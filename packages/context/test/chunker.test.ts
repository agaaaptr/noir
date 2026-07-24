import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  chunkFile,
  DEFAULT_CHUNK_MAX_TOKENS,
  DEFAULT_CHUNK_OVERLAP,
  estimateTokens,
  explodeIdentifiers,
  inferLanguage,
  withIdentifierExplosion,
} from '../src/chunker.js';
import type { Chunk } from '../src/types.js';

// Independent SHA-256 (not the chunker's own helper) so tests cross-check the
// contract rather than re-stating the implementation.
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// Build a code-shaped string of `count` distinct, word-padded lines (~9 tokens
// each → ~512 tokens every ~57 lines). Used to exercise multi-window chunking.
function codeLines(count: number): string {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(`const variableNumber${String(i).padStart(4, '0')} = computeValue(opts, ctx, depth);`);
  }
  return out.join('\n');
}

describe('explodeIdentifiers', () => {
  it('splits camelCase into lowercase tokens', () => {
    expect(explodeIdentifiers('contextEngine')).toBe('context engine');
  });

  it('splits PascalCase into lowercase tokens', () => {
    expect(explodeIdentifiers('ContextEngine')).toBe('context engine');
  });

  it('splits snake_case and kebab-case (separators excluded from word match)', () => {
    expect(explodeIdentifiers('snake_case_field')).toBe('snake case field');
    expect(explodeIdentifiers('kebab-case-attr')).toBe('kebab case attr');
  });

  it('handles acronym runs (XMLHttp → XML Http)', () => {
    expect(explodeIdentifiers('XMLHttpRequest')).toBe('xml http request');
  });

  it('handles lowercase-run before an acronym (myHTTPSConnection)', () => {
    expect(explodeIdentifiers('myHTTPSConnection')).toBe('my https connection');
  });

  it('preserves alphanumeric tokens (v2, sha256) without over-splitting', () => {
    expect(explodeIdentifiers('sha256')).toBe('sha256');
    expect(explodeIdentifiers('engine_v2')).toBe('engine v2');
  });

  it('splits a mixed prose + identifier sentence into lowercase tokens', () => {
    const out = explodeIdentifiers('use the ContextEngine helper for HttpRequests');
    const tokens = out.split(' ');
    expect(tokens).toEqual(
      expect.arrayContaining([
        'use',
        'the',
        'context',
        'engine',
        'helper',
        'for',
        'http',
        'requests',
      ]),
    );
  });

  it('breaks on punctuation (ctx:file:<path> → ctx file path)', () => {
    expect(explodeIdentifiers('ctx:file:<path>')).toBe('ctx file path');
  });

  it('returns "" for empty / whitespace-only text', () => {
    expect(explodeIdentifiers('')).toBe('');
    expect(explodeIdentifiers('   \n\t ')).toBe('');
  });

  it('keeps duplicate tokens (BM25 term-frequency signal reflects usage)', () => {
    // `contextEngine contextEngine` legitimately appears twice → the exploded
    // stream carries `context` twice, not deduped.
    expect(explodeIdentifiers('contextEngine contextEngine')).toBe('context engine context engine');
  });
});

describe('withIdentifierExplosion', () => {
  it('appends the explosion on a trailing line when there is identifier signal', () => {
    const out = withIdentifierExplosion('const ContextEngine = 1;');
    expect(out.startsWith('const ContextEngine = 1;\n')).toBe(true);
    expect(out.endsWith('const context engine 1')).toBe(true);
  });

  it('returns the content unchanged when there is no identifier signal', () => {
    expect(withIdentifierExplosion('   ')).toBe('   ');
  });
});

describe('estimateTokens', () => {
  it('returns 0 for empty / whitespace-only text', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('   \n\t ')).toBe(0);
  });

  it('approximates words * 1.3 (ceil)', () => {
    // 10 whitespace-separated words → ceil(13.0) = 13
    expect(estimateTokens('one two three four five six seven eight nine ten')).toBe(13);
  });
});

describe('inferLanguage', () => {
  it('maps common extensions to language tags', () => {
    expect(inferLanguage('src/engine.ts')).toBe('typescript');
    expect(inferLanguage('src/index.mjs')).toBe('javascript');
    expect(inferLanguage('README.md')).toBe('markdown');
    expect(inferLanguage('doc.mdx')).toBe('markdown');
    expect(inferLanguage('app.py')).toBe('python');
    expect(inferLanguage('Cargo.rs')).toBe('rust'); // case-insensitive ext
    expect(inferLanguage('cfg.yml')).toBe('yaml');
  });

  it('falls back to "text" for unknown extensions / no extension', () => {
    expect(inferLanguage('weird.zzz')).toBe('text');
    expect(inferLanguage('Makefile')).toBe('text');
  });
});

describe('chunkFile — markdown', () => {
  const THREE_HEADING_DOC = [
    '# Title',
    'intro paragraph about noir.',
    '',
    '## Section A',
    'body of section a.',
    '',
    '## Section B',
    'body of section b.',
  ].join('\n');

  it('emits one chunk per ATX heading section (3 headings → 3 chunks)', () => {
    const chunks = chunkFile({ path: 'README.md', content: THREE_HEADING_DOC });
    expect(chunks).toHaveLength(3);
    // each chunk carries its heading as the first line + its body
    expect(chunks[0]?.content).toBe('# Title\nintro paragraph about noir.');
    expect(chunks[1]?.content).toBe('## Section A\nbody of section a.');
    expect(chunks[2]?.content).toBe('## Section B\nbody of section b.');
  });

  it('assigns stable, sequential ids and parentDocId from sha256(path)', () => {
    const chunks = chunkFile({ path: 'README.md', content: THREE_HEADING_DOC });
    const parent = sha256('README.md');
    expect(chunks.map((c) => c.id)).toEqual([
      `${parent}#chunk-0`,
      `${parent}#chunk-1`,
      `${parent}#chunk-2`,
    ]);
    for (const c of chunks) {
      expect(c.meta.parentDocId).toBe(parent);
    }
  });

  it('is deterministic: same path + content yields identical chunks (stable ids)', () => {
    const a = chunkFile({ path: 'docs/x.md', content: THREE_HEADING_DOC });
    const b = chunkFile({ path: 'docs/x.md', content: THREE_HEADING_DOC });
    expect(a).toEqual(b);
  });

  it('different paths produce different ids (content-identical, path-keyed)', () => {
    const a = chunkFile({ path: 'docs/a.md', content: THREE_HEADING_DOC });
    const b = chunkFile({ path: 'docs/b.md', content: THREE_HEADING_DOC });
    expect(a[0]?.id).not.toBe(b[0]?.id);
  });

  it('treats `#`-comment lines inside a code fence as non-headings', () => {
    // The `# not a heading` line sits inside a ```js fence; without fence
    // tracking it would split into 3 sections. With tracking → 2.
    const fenced = [
      '# Title',
      'intro.',
      '',
      '```js',
      '# not a heading',
      'const x = 1;',
      '```',
      '',
      '## Real Section',
      'body.',
    ].join('\n');
    const chunks = chunkFile({ path: 'doc.md', content: fenced });
    expect(chunks).toHaveLength(2);
    // The fenced `#` line is preserved in the first section's body.
    expect(chunks[0]?.content).toContain('# not a heading');
    expect(chunks[1]?.content).toBe('## Real Section\nbody.');
  });

  it('emits a non-empty preamble before the first heading as its own chunk', () => {
    const withPreamble = ['preamble line one', 'preamble line two', '', '# Heading', 'body'].join(
      '\n',
    );
    const chunks = chunkFile({ path: 'doc.md', content: withPreamble });
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.content).toBe('preamble line one\npreamble line two');
    expect(chunks[1]?.content).toBe('# Heading\nbody');
  });

  it('classifies .md as source "docs" and infers language "markdown"', () => {
    const chunks = chunkFile({ path: 'README.md', content: '# H\nbody' });
    expect(chunks[0]?.source).toBe('docs');
    expect(chunks[0]?.meta.language).toBe('markdown');
  });

  it('respects an explicit language="markdown" override on a non-.md path', () => {
    const chunks = chunkFile({ path: 'notes.txt', content: '# H\nbody', language: 'markdown' });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.source).toBe('docs');
  });
});

describe('chunkFile — code / general text', () => {
  it('emits a single chunk for content under the token budget', () => {
    const content = 'const greeting = "hello world";\nconsole.log(greeting);\n';
    const chunks = chunkFile({ path: 'src/hello.ts', content });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toBe(content);
    expect(chunks[0]?.source).toBe('codebase');
    expect(chunks[0]?.meta.language).toBe('typescript');
  });

  it('emits ≥2 overlapping windows for content over the token budget', () => {
    // ~130 lines × ~9 tokens/line ≈ ~1170 tokens → at least 2 windows.
    const content = codeLines(130);
    const chunks = chunkFile({ path: 'src/big.ts', content });
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    // Overlap contract: the LAST line of window[0] must appear in window[1]
    // (consecutive multi-line windows overlap by ≥1 line).
    const firstContent = chunks[0]?.content ?? '';
    const secondContent = chunks[1]?.content ?? '';
    const firstLines = firstContent.split('\n');
    const lastLine = firstLines[firstLines.length - 1];
    expect(lastLine).toBeTruthy();
    if (!lastLine) throw new Error('expected a last line in chunk[0]');
    expect(secondContent).toContain(lastLine);

    // And the second window must not simply re-emit the first window verbatim
    // (it extends past it).
    expect(secondContent.length).toBeGreaterThan(lastLine.length);
  });

  it('respects a small maxTokens override to force multiple windows', () => {
    // ~9 tokens/line; maxTokens=20 → ~2 lines per window → many windows.
    const content = codeLines(10);
    const chunks = chunkFile({ path: 'src/x.ts', content, maxTokens: 20, overlap: 8 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // chunkIndex is contiguous and 0-based, ids match `${parent}#chunk-${i}`.
    const parent = sha256('src/x.ts');
    chunks.forEach((c, i) => {
      expect(c.meta.chunkIndex).toBe(i);
      expect(c.id).toBe(`${parent}#chunk-${i}`);
    });
  });

  it('emits a single oversized line as its own chunk (no mid-line split)', () => {
    // One very long line well over the default 512-token budget.
    const longLine = `${Array.from({ length: 600 }, (_, i) => `tok${i}`).join(' ')}`;
    const chunks = chunkFile({ path: 'src/one.ts', content: longLine });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toBe(longLine);
  });

  it('classifies code as source "codebase"', () => {
    const chunks = chunkFile({ path: 'src/a.ts', content: 'export const x = 1;' });
    expect(chunks[0]?.source).toBe('codebase');
  });

  it('honors an explicit source override (e.g. "spec")', () => {
    const chunks = chunkFile({
      path: 'specs/s.md',
      content: '# H\nbody',
      source: 'spec',
    });
    expect(chunks[0]?.source).toBe('spec');
  });
});

describe('chunkFile — meta + degenerate cases', () => {
  it('meta.sha256 = sha256(content + identifier explosion)', () => {
    const content = 'const ContextEngine = make();';
    const chunks = chunkFile({ path: 'src/a.ts', content });
    const expected = sha256(`${content}\n${explodeIdentifiers(content)}`);
    expect(chunks[0]?.meta.sha256).toBe(expected);
    // and the clean content is what's stored on the chunk (no explosion in it)
    expect(chunks[0]?.content).toBe(content);
  });

  it('meta.path + parentDocId are populated for every chunk', () => {
    const chunks = chunkFile({ path: 'src/a.ts', content: codeLines(130) });
    const parent = sha256('src/a.ts');
    for (const c of chunks) {
      expect(c.meta.path).toBe('src/a.ts');
      expect(c.meta.parentDocId).toBe(parent);
      expect(c.meta.language).toBe('typescript');
    }
  });

  it('returns [] for empty content', () => {
    expect(chunkFile({ path: 'src/empty.ts', content: '' })).toEqual([]);
  });

  it('returns [] for whitespace-only content', () => {
    expect(chunkFile({ path: 'src/ws.ts', content: '   \n\t  \n' })).toEqual([]);
  });

  it('defaults maxTokens/overlap to the exported constants when omitted', () => {
    // Indirect: a single line of < DEFAULT_CHUNK_MAX_TOKENS tokens → 1 chunk.
    // Construct content that crosses the default boundary only at the default
    // size by checking the constants are the documented values.
    expect(DEFAULT_CHUNK_MAX_TOKENS).toBe(512);
    expect(DEFAULT_CHUNK_OVERLAP).toBe(64);
    const single = `x ${Array.from({ length: 10 }, (_, i) => `w${i}`).join(' ')}`;
    const chunks: Chunk[] = chunkFile({ path: 's.ts', content: single });
    expect(chunks).toHaveLength(1);
  });
});
