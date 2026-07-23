import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeAdapter } from '@noir-ai/adapters';
import { CONTEXT_BLOCK_BEGIN, CONTEXT_BLOCK_END, createProjectId, paths } from '@noir-ai/core';

export interface InitOptions {
  transport: 'stdio' | 'streamable-http';
  url?: string;
}

export async function init(root: string, opts: InitOptions): Promise<void> {
  if (opts.url !== undefined) {
    assertLocalhostUrl(opts.url);
  }

  mkdirSync(paths.noirDir(root), { recursive: true });

  const id = createProjectId();
  writeFileSync(paths.projectId(root), `${id}\n`, 'utf8');
  writeFileSync(paths.config(root), 'host: claude\nmode: full\n', 'utf8');
  writeFileSync(
    paths.noirMd(root),
    `# Noir context\n\nProject id: \`${id}\`\n\n<!-- Noir auto-manages this file. Host context files @import it. -->\n`,
    'utf8',
  );

  writeFileSync(
    join(root, '.mcp.json'),
    `${claudeAdapter.emitMcpConfig({ root }, opts)}\n`,
    'utf8',
  );

  const existing = safeRead(join(root, 'CLAUDE.md'));
  writeFileSync(
    join(root, 'CLAUDE.md'),
    replaceBlock(existing, claudeAdapter.emitContext({ root })),
    'utf8',
  );

  process.stderr.write(`Noir initialized in ${root} (transport: ${opts.transport}).\n`);
}

function safeRead(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}
function replaceBlock(content: string, block: string): string {
  const begin = CONTEXT_BLOCK_BEGIN;
  const end = CONTEXT_BLOCK_END;
  const re = new RegExp(`${escapeRe(begin)}[\\s\\S]*?${escapeRe(end)}\\n?`, 'g');
  const stripped = content.replace(re, '');
  return `${stripped ? `${stripped.trimEnd()}\n\n` : ''}${block}`;
}
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Validate a streamable-http --url is http(s) and localhost-only. Gate 2's
// daemon binds 127.0.0.1, so persisting a non-localhost URL is a footgun.
// Not exported: the single call site is init(); thrown errors propagate to
// bin.ts's main().catch (stderr + exitCode 1).
function assertLocalhostUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only http/https URLs are supported');
  }
  if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    throw new Error(`Only localhost URLs are supported (got ${url.hostname})`);
  }
}
