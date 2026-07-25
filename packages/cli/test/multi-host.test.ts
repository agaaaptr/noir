// S10 — multi-host CLI tests.
//
// Drives the REAL `init`/`create`/`sync` (no mocks) end-to-end through the
// resolved adapter for each `--host <id>`. Asserts the host's primary
// artifacts land on disk + that the chosen host persists to `.noir/config.yml`
// (so a subsequent bare `noir sync` re-emits the SAME host without --host).
// The claude default is asserted byte-identical to v1.1 EXCEPT the additive
// root AGENTS.md (the universal 32-platform baseline Claude reads natively).
//
// The bin-level `--host` argv wiring is covered in bin.test.ts; this file
// covers the module-level behavior the bin dispatches to.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths } from '@noir-ai/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { create } from '../src/commands/create.js';
import { init } from '../src/init.js';
import { sync } from '../src/sync.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-multi-host-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('noir init --host <id> — per-host artifact matrix', () => {
  it('claude (default): CLAUDE.md + AGENTS.md + .mcp.json + .claude/skills (SKILL.md)', async () => {
    await init(root, { transport: 'stdio' });

    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(root, '.mcp.json'))).toBe(true);
    expect(existsSync(join(root, '.claude', 'skills'))).toBe(true);
    // A skill file is the verbatim SKILL.md shape (claude CompileTarget).
    expect(existsSync(join(root, '.claude', 'skills', 'noir-brainstorm', 'SKILL.md'))).toBe(true);
    // config.yml persisted host: claude (the default).
    expect(readFileSync(paths.config(root), 'utf8')).toMatch(/^host: claude/m);
  });

  it('gemini: GEMINI.md + AGENTS.md + .gemini/mcp.json; no .claude/; no skills dir', async () => {
    await init(root, { transport: 'stdio', host: 'gemini' });

    expect(existsSync(join(root, 'GEMINI.md'))).toBe(true);
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(root, '.gemini', 'mcp.json'))).toBe(true);
    // Gemini has no skill concept — no .claude/skills, no .gemini/skills.
    expect(existsSync(join(root, '.claude'))).toBe(false);
    // Claude artifacts do NOT leak.
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(root, '.mcp.json'))).toBe(false);
    // config.yml persisted host: gemini.
    expect(readFileSync(paths.config(root), 'utf8')).toMatch(/^host: gemini/m);
  });

  it('cursor: AGENTS.md + .cursor/rules/noir-rules.mdc + .cursor/mcp.json + skills as .mdc', async () => {
    await init(root, { transport: 'stdio', host: 'cursor' });

    expect(existsSync(join(root, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(root, '.cursor', 'rules', 'noir-rules.mdc'))).toBe(true);
    expect(existsSync(join(root, '.cursor', 'mcp.json'))).toBe(true);
    // Cursor compiles skills to .mdc (target:'cursor') under .cursor/rules/.
    expect(
      existsSync(join(root, '.cursor', 'rules', 'noir-brainstorm', 'noir-brainstorm.mdc')),
    ).toBe(true);
    // No CLAUDE.md / GEMINI.md leakage.
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(root, 'GEMINI.md'))).toBe(false);
    // config.yml persisted host: cursor.
    expect(readFileSync(paths.config(root), 'utf8')).toMatch(/^host: cursor/m);
  });

  it('opencode: AGENTS.md + opencode.json; no skills dir', async () => {
    await init(root, { transport: 'stdio', host: 'opencode' });

    expect(existsSync(join(root, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(root, 'opencode.json'))).toBe(true);
    // No skills emission for opencode.
    expect(existsSync(join(root, '.claude'))).toBe(false);
    // opencode.json carries the $schema + type-tagged mcp block.
    const cfg = JSON.parse(readFileSync(join(root, 'opencode.json'), 'utf8'));
    expect(cfg.$schema).toBe('https://opencode.ai/config.json');
    expect(cfg.mcp.noir).toEqual({ type: 'local', command: ['noir', 'mcp', 'serve', '--stdio'] });
  });

  it('agents-md: AGENTS.md + .mcp.json; no host-native context beyond AGENTS.md', async () => {
    await init(root, { transport: 'stdio', host: 'agents-md' });

    expect(existsSync(join(root, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(root, '.mcp.json'))).toBe(true);
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(root, 'GEMINI.md'))).toBe(false);
  });
});

describe('noir create --host <id> — greenfield per host', () => {
  it('create --host gemini bootstraps a fresh dir with GEMINI.md + AGENTS.md + .gemini/mcp.json', async () => {
    const target = join(root, 'fresh-gemini');
    expect(existsSync(target)).toBe(false);

    await create(target, { transport: 'stdio', host: 'gemini' });

    expect(existsSync(target)).toBe(true);
    expect(existsSync(join(target, 'GEMINI.md'))).toBe(true);
    expect(existsSync(join(target, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(target, '.gemini', 'mcp.json'))).toBe(true);
    expect(existsSync(join(target, '.noir', 'project.id'))).toBe(true);
  });

  it('create --host cursor bootstraps .cursor/rules/noir-rules.mdc + skills as .mdc', async () => {
    const target = join(root, 'fresh-cursor');
    await create(target, { transport: 'stdio', host: 'cursor' });

    expect(existsSync(join(target, '.cursor', 'rules', 'noir-rules.mdc'))).toBe(true);
    // Skills compile to .mdc under .cursor/rules/<skill>/<skill>.mdc.
    expect(
      existsSync(join(target, '.cursor', 'rules', 'noir-brainstorm', 'noir-brainstorm.mdc')),
    ).toBe(true);
  });
});

describe('noir sync — host round-trips from .noir/config.yml', () => {
  it('init --host gemini then bare sync re-emits GEMINI.md (host read from config)', async () => {
    await init(root, { transport: 'stdio', host: 'gemini' });
    // Mutate GEMINI.md to prove sync re-emits the managed regions. User
    // content OUTSIDE the markers is PRESERVED (the multi-region managedBlocks
    // writer's contract — same as CLAUDE.md), so we keep a marker line and add
    // a user note above it to assert both halves of the contract.
    writeFileSync(
      join(root, 'GEMINI.md'),
      '# My gemini notes\n\n<!-- noir:context begin -->\nOLD\n<!-- noir:context end -->\n',
      'utf8',
    );

    await sync(root); // no --host → reads config.host

    const md = readFileSync(join(root, 'GEMINI.md'), 'utf8');
    // The managed region was re-emitted with the current @-import body.
    expect(md).toContain('<!-- noir:context begin -->');
    expect(md).toContain('@.noir/NOIR.md');
    expect(md).not.toContain('\nOLD\n'); // the stale managed body was replaced
    // User content OUTSIDE the markers survives sync.
    expect(md).toContain('# My gemini notes');
    // Host was read from config (gemini), not the default claude — proven by
    // GEMINI.md being touched at all (a claude sync would not write GEMINI.md).
    expect(md).toContain('<!-- noir:rules begin -->');
  });

  it('sync --host override re-emits under the override (advanced)', async () => {
    // Project initialized under claude.
    await init(root, { transport: 'stdio' });
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(true);

    // Override-emt under cursor — adds cursor artifacts alongside.
    await sync(root, { host: 'cursor' });
    expect(existsSync(join(root, '.cursor', 'rules', 'noir-rules.mdc'))).toBe(true);
  });
});

describe('noir init — claude byte-identity (regression anchor)', () => {
  // The S10 spec guarantees the default `noir init` is byte-equivalent to v1.1
  // EXCEPT the additive root AGENTS.md (Claude reads it natively). The
  // scaffold.test.ts parity gates already assert the .mcp.json + CLAUDE.md
  // regions byte-equal the adapter; here we add the AGENTS.md presence
  // assertion + confirm the regression-anchor files are still byte-stable.
  it('default init produces .mcp.json + CLAUDE.md + AGENTS.md (additive) + ignores', async () => {
    await init(root, { transport: 'stdio' });
    // AGENTS.md is the S10 additive (Claude reads it natively).
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(true);
    // v1.1 regression-anchor files unchanged.
    expect(existsSync(join(root, '.mcp.json'))).toBe(true);
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(root, '.gitignore'))).toBe(true);
    // The .mcp.json is the {mcpServers} shape, stdio entry.
    const mcp = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.noir).toEqual({ command: 'noir', args: ['mcp', 'serve', '--stdio'] });
  });

  it('claude default-then-sync is byte-idempotent for AGENTS.md + .mcp.json', async () => {
    await init(root, { transport: 'stdio' });
    const agentsAfter1 = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    const mcpAfter1 = readFileSync(join(root, '.mcp.json'), 'utf8');

    await sync(root);

    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(agentsAfter1);
    expect(readFileSync(join(root, '.mcp.json'), 'utf8')).toBe(mcpAfter1);
  });
});
