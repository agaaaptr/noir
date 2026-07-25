import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeAdapter } from '@noir-ai/adapters';
import { CONTEXT_BLOCK, createProjectId, paths, writeManagedRegion } from '@noir-ai/core';
import { emitSkillsToDir } from '@noir-ai/skills';

export interface InitOptions {
  transport: 'stdio' | 'streamable-http';
  url?: string;
}

export async function init(root: string, opts: InitOptions): Promise<void> {
  if (opts.transport === 'streamable-http' && opts.url === undefined) {
    throw new Error('--transport streamable-http requires --url');
  }
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

  writeManagedRegion(join(root, 'CLAUDE.md'), CONTEXT_BLOCK, claudeAdapter.emitContext({ root }));

  if (claudeAdapter.skillsDir) {
    const summary = await emitSkillsToDir(claudeAdapter.skillsDir({ root }));
    process.stderr.write(`Emitted ${summary.emitted.length} Noir skills to .claude/skills/.\n`);
  }

  process.stderr.write(`Noir initialized in ${root} (transport: ${opts.transport}).\n`);
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
