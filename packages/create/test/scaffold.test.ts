import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeAdapter, emitAgentsMd } from '@noir-ai/adapters';
import { CONTEXT_BLOCK, paths, RULES_BLOCK, readManagedBlock, syncIgnores } from '@noir-ai/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scaffold } from '../src/scaffold.js';
import { CURRENT_SCAFFOLD_VERSION, readScaffoldVersion } from '../src/scaffold-version.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-scaffold-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function init(
  r: string,
  opts: Parameters<typeof scaffold>[0] = {},
): Promise<ReturnType<typeof scaffold>> {
  return scaffold({ root: r, mode: 'init', transport: 'stdio', ...opts });
}

describe('scaffold init — full AI foundation', () => {
  it('produces every manifest artifact under .noir/ + root pointers', async () => {
    const res = await init(root);
    expect(existsSync(paths.projectId(root))).toBe(true);
    expect(existsSync(paths.config(root))).toBe(true);
    expect(existsSync(paths.noirMd(root))).toBe(true);
    expect(existsSync(paths.rulesMd(root))).toBe(true);
    expect(existsSync(join(root, '.mcp.json'))).toBe(true);
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(root, '.gitignore'))).toBe(true);
    expect(existsSync(join(root, '.dockerignore'))).toBe(true);
    expect(existsSync(join(root, '.npmignore'))).toBe(true);
    expect(existsSync(join(root, '.prettierignore'))).toBe(true);
    expect(existsSync(join(root, '.noir', 'scaffold-version'))).toBe(true);
    // Every emitted path is reported.
    expect(res.written).toEqual(
      expect.arrayContaining([
        '.noir/project.id',
        '.noir/config.yml',
        '.noir/NOIR.md',
        '.noir/rules/RULES.md',
        '.mcp.json',
        'CLAUDE.md',
        '.gitignore',
        '.dockerignore',
        '.npmignore',
        '.prettierignore',
      ]),
    );
    expect(res.projectId.length).toBeGreaterThan(0);
  });

  it('stamps .noir/scaffold-version with CURRENT_SCAFFOLD_VERSION', async () => {
    await init(root);
    expect(readScaffoldVersion(root)).toBe(CURRENT_SCAFFOLD_VERSION);
  });

  it('parses .mcp.json to the expected noir server config (stdio)', async () => {
    await init(root, { transport: 'stdio' });
    const mcp = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.noir).toEqual({ command: 'noir', args: ['mcp', 'serve', '--stdio'] });
  });

  it('parses .mcp.json to the expected noir server config (streamable-http)', async () => {
    await init(root, { transport: 'streamable-http', url: 'http://127.0.0.1:4321/mcp' });
    const mcp = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.noir).toEqual({ type: 'http', url: 'http://127.0.0.1:4321/mcp' });
  });

  it('rejects streamable-http without a url', async () => {
    await expect(init(root, { transport: 'streamable-http' })).rejects.toThrow(/url/);
  });

  it('CLAUDE.md contains both CONTEXT_BLOCK + RULES_BLOCK @import regions', async () => {
    await init(root);
    const md = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    expect(md).toContain(CONTEXT_BLOCK.begin);
    expect(md).toContain('@import ".noir/NOIR.md"');
    expect(md).toContain(RULES_BLOCK.begin);
    expect(md).toContain('@import ".noir/rules/RULES.md"');
  });

  it('NOIR.md contains the project id inside the BRIEF_BLOCK region', async () => {
    const res = await init(root);
    const md = readFileSync(paths.noirMd(root), 'utf8');
    expect(md).toContain('<!-- noir:brief begin -->');
    expect(md).toContain(`Project id: \`${res.projectId}\``);
  });

  it('seeds RULES.md with the working-rules content', async () => {
    await init(root);
    const rules = readFileSync(paths.rulesMd(root), 'utf8');
    expect(rules).toContain('# Noir working rules');
    expect(rules).toContain('Anti-assumption contract');
  });
});

describe('scaffold init — idempotency', () => {
  it('re-run preserves project.id (skipIfExists: store DB stays stable) — documented behavior change vs predecessor init.ts', async () => {
    const first = await init(root);
    const idAfterFirst = readFileSync(paths.projectId(root), 'utf8');
    expect(idAfterFirst.trim()).toBe(first.projectId);
    const second = await init(root);
    const idAfterSecond = readFileSync(paths.projectId(root), 'utf8');
    // project.id is NOT regenerated on re-run.
    expect(idAfterSecond.trim()).toBe(first.projectId);
    expect(second.projectId).toBe(first.projectId);
    expect(second.skipped).toEqual(
      expect.arrayContaining(['.noir/project.id', '.noir/config.yml', '.noir/rules/RULES.md']),
    );
  });

  it('re-run is byte-idempotent for single-region managed files (NOIR.md, ignore files) and regenerate (.mcp.json)', async () => {
    await init(root);
    const noirAfter1 = readFileSync(paths.noirMd(root), 'utf8');
    const giAfter1 = readFileSync(join(root, '.gitignore'), 'utf8');
    const mcpAfter1 = readFileSync(join(root, '.mcp.json'), 'utf8');
    await init(root);
    expect(readFileSync(paths.noirMd(root), 'utf8')).toBe(noirAfter1);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe(giAfter1);
    expect(readFileSync(join(root, '.mcp.json'), 'utf8')).toBe(mcpAfter1);
  });

  it('dryRun writes nothing to disk but reports intent', async () => {
    const res = await init(root, { dryRun: true });
    expect(res.written.length).toBeGreaterThan(0);
    expect(existsSync(paths.noirMd(root))).toBe(false);
    expect(existsSync(join(root, '.mcp.json'))).toBe(false);
    expect(existsSync(join(root, '.noir', 'scaffold-version'))).toBe(false); // stamp not written on dryRun
  });
});

describe('scaffold sync — runtime subset only', () => {
  it('throws when Noir is not initialized (no .noir/project.id)', async () => {
    await expect(scaffold({ root, mode: 'sync' })).rejects.toThrow(/not initialized/);
  });

  it('emits ONLY regenerate + managedBlock; never seeds skipIfExists files', async () => {
    // First, init to establish .noir/project.id so sync can read it.
    await init(root);
    // Wipe the skipIfExists artifacts to prove sync will NOT recreate them.
    rmSync(paths.rulesMd(root), { force: true });
    rmSync(paths.config(root), { force: true });

    const res = await scaffold({ root, mode: 'sync' });
    // sync's written list contains only runtime modes.
    const allEntries = res.written;
    expect(allEntries).toContain('.mcp.json');
    expect(allEntries).toContain('.noir/NOIR.md');
    expect(allEntries).toContain('CLAUDE.md');
    expect(allEntries).toContain('.gitignore');
    // skipIfExists seeds were NOT recreated.
    expect(existsSync(paths.rulesMd(root))).toBe(false);
    expect(existsSync(paths.config(root))).toBe(false);
    // No skipIfExists entries in written OR skipped (they were filtered out, not no-op'd).
    expect(res.skipped).not.toContain('.noir/config.yml');
    expect(res.skipped).not.toContain('.noir/rules/RULES.md');
  });

  it('does NOT stamp scaffold-version (sync is runtime, not a scaffold event)', async () => {
    await init(root);
    rmSync(join(root, '.noir', 'scaffold-version'), { force: true });
    await scaffold({ root, mode: 'sync' });
    expect(existsSync(join(root, '.noir', 'scaffold-version'))).toBe(false);
  });
});

describe('scaffold create — greenfield', () => {
  it('bootstraps a non-existent target dir with the full AI foundation', async () => {
    const target = join(root, 'new-project');
    expect(existsSync(target)).toBe(false);
    const res = await scaffold({ root: target, mode: 'create', transport: 'stdio' });
    expect(existsSync(join(target, '.noir', 'project.id'))).toBe(true);
    expect(existsSync(join(target, 'CLAUDE.md'))).toBe(true);
    expect(res.written.length).toBeGreaterThan(0);
    expect(res.projectId.length).toBeGreaterThan(0);
  });
});

describe('scaffold upgrade — migrations', () => {
  it('runs migrations and reports them; emits runtime subset only (skipIfExists left alone)', async () => {
    await init(root);
    // Mutate a skipIfExists file so we can prove upgrade did NOT rewrite it.
    rmSync(paths.config(root), { force: true });

    const res = await scaffold({ root, mode: 'init', upgrade: true });
    expect(res.migrationsRan).toContain('1.0.0→1.0.0');
    expect(res.written).toContain('.mcp.json');
    expect(res.written).toContain('.noir/NOIR.md');
    // config.yml was deleted and upgrade did NOT re-seed it.
    expect(existsSync(paths.config(root))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PARITY: scaffold output must equal the live adapter + syncIgnores byte-for-byte
// so S-T2 can swap init.ts/sync.ts for scaffold() without producing a git diff.
// ---------------------------------------------------------------------------
describe('scaffold parity with @noir-ai/adapters + syncIgnores (S-T2 refactor gate)', () => {
  it('.mcp.json (stdio) byte-equals claudeAdapter.emitMcpConfig output + trailing newline', async () => {
    await init(root, { transport: 'stdio' });
    const expected = `${claudeAdapter.emitMcpConfig({ root }, { transport: 'stdio' })}\n`;
    expect(readFileSync(join(root, '.mcp.json'), 'utf8')).toBe(expected);
  });

  it('.mcp.json (http) byte-equals claudeAdapter.emitMcpConfig output + trailing newline', async () => {
    await init(root, { transport: 'streamable-http', url: 'http://127.0.0.1:7777/mcp' });
    const expected = `${claudeAdapter.emitMcpConfig({ root }, { transport: 'streamable-http', url: 'http://127.0.0.1:7777/mcp' })}\n`;
    expect(readFileSync(join(root, '.mcp.json'), 'utf8')).toBe(expected);
  });

  it('CLAUDE.md CONTEXT_BLOCK region byte-equals claudeAdapter.emitContext', async () => {
    await init(root);
    const region = readManagedBlock(join(root, 'CLAUDE.md'), CONTEXT_BLOCK);
    // `readManagedBlock`'s regex stops at — and does not include the newline
    // after — the end marker; `claudeAdapter.emitContext` appends one trailing
    // `\n`. (The scaffold's `buildRegion` output is already byte-equal to
    // emitContext — the gap is purely core's read-semantics vs. the adapter's
    // emit-semantics, neither of which this package owns.) `trimEnd` both
    // sides so the gate STILL fails on ANY real content drift (markers, the
    // @import path, inner newlines) without failing on the lone trailing
    // newline that is read-semantics, not scaffold content.
    expect(region?.trimEnd()).toBe(claudeAdapter.emitContext({ root }).trimEnd());
  });

  it('CLAUDE.md RULES_BLOCK region byte-equals claudeAdapter.emitRules', async () => {
    await init(root);
    const region = readManagedBlock(join(root, 'CLAUDE.md'), RULES_BLOCK);
    // See CONTEXT_BLOCK test: readManagedBlock drops emitRules's trailing `\n`.
    expect(region?.trimEnd()).toBe(claudeAdapter.emitRules({ root }).trimEnd());
  });

  it('every ignore file byte-equals what syncIgnores writes', async () => {
    await init(root);
    // Run syncIgnores into a sibling temp root and compare each file verbatim.
    const sib = mkdtempSync(join(tmpdir(), 'noir-parity-'));
    try {
      syncIgnores(sib);
      for (const name of ['.gitignore', '.dockerignore', '.npmignore', '.prettierignore']) {
        const mine = readFileSync(join(root, name), 'utf8');
        const theirs = readFileSync(join(sib, name), 'utf8');
        expect(mine, name).toBe(theirs);
      }
    } finally {
      rmSync(sib, { recursive: true, force: true });
    }
  });
});

describe('scaffold result shape', () => {
  it('returns stack info (read-only detect always runs)', async () => {
    const res = await init(root);
    expect(res.stack).toBeDefined();
    expect(Array.isArray(res.stack.languages)).toBe(true);
  });

  it('returns fromVersion (null on first init) and toVersion (CURRENT)', async () => {
    const res = await init(root);
    expect(res.fromVersion).toBeNull();
    expect(res.toVersion).toBe(CURRENT_SCAFFOLD_VERSION);
  });

  it('honors an explicit projectId override', async () => {
    const res = await init(root, { projectId: 'fixed-id-1234' });
    expect(res.projectId).toBe('fixed-id-1234');
    expect(readFileSync(paths.projectId(root), 'utf8').trim()).toBe('fixed-id-1234');
  });
});

// ---------------------------------------------------------------------------
// Fix-wave coverage (adversarial review of Slice S).
// ---------------------------------------------------------------------------

describe('scaffold — project.id integrity (C1)', () => {
  it('heals a corrupt (empty) .noir/project.id so the file and NOIR.md agree', async () => {
    // Pre-seed a corrupt stamp: the file EXISTS but trims to empty. The
    // manifest's `skipIfExists` would preserve this empty file while NOIR.md's
    // BRIEF_BLOCK renders a freshly-generated id → silent identity split.
    mkdirSync(join(root, '.noir'), { recursive: true });
    writeFileSync(paths.projectId(root), '', 'utf8');

    const res = await init(root);
    const idOnDisk = readFileSync(paths.projectId(root), 'utf8').trim();
    // The empty file was overwritten (healed, not preserved).
    expect(idOnDisk.length).toBeGreaterThan(0);
    expect(idOnDisk).toBe(res.projectId);
    // NOIR.md's brief states the SAME id — the store DB (named after it) and
    // the brief agree; no split.
    const md = readFileSync(paths.noirMd(root), 'utf8');
    expect(md).toContain(`Project id: \`${res.projectId}\``);
  });

  it('heals a whitespace-only .noir/project.id the same way', async () => {
    mkdirSync(join(root, '.noir'), { recursive: true });
    writeFileSync(paths.projectId(root), '   \n\t\n', 'utf8');
    const res = await init(root);
    expect(readFileSync(paths.projectId(root), 'utf8').trim()).toBe(res.projectId);
  });

  it('sync still rejects a corrupt project.id (cannot trust the store name)', async () => {
    mkdirSync(join(root, '.noir'), { recursive: true });
    writeFileSync(paths.projectId(root), '', 'utf8');
    await expect(scaffold({ root, mode: 'sync' })).rejects.toThrow(/not initialized/);
  });
});

describe('scaffold — CLAUDE.md multi-region byte stability (I1)', () => {
  it('5 consecutive inits leave CLAUDE.md byte-identical; CONTEXT before RULES; no duplication', async () => {
    await init(root);
    const snapshot = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    const size = Buffer.byteLength(snapshot, 'utf8');

    for (let i = 0; i < 4; i++) {
      await init(root);
    }
    const after = readFileSync(join(root, 'CLAUDE.md'), 'utf8');

    // Exact byte-equality across runs (the old per-block write drifted +2
    // bytes/run from a leading-\n accumulator).
    expect(after).toBe(snapshot);
    expect(Buffer.byteLength(after, 'utf8')).toBe(size);

    // Stable order: CONTEXT region appears before RULES region.
    const ctxIdx = after.indexOf(CONTEXT_BLOCK.begin);
    const rulesIdx = after.indexOf(RULES_BLOCK.begin);
    expect(ctxIdx).toBeGreaterThanOrEqual(0);
    expect(rulesIdx).toBeGreaterThan(ctxIdx);

    // Each marker appears exactly once (no region duplication).
    expect((after.match(/<!-- noir:context begin -->/g) ?? []).length).toBe(1);
    expect((after.match(/<!-- noir:rules begin -->/g) ?? []).length).toBe(1);
  });

  it('CLAUDE.md multi-region write preserves user content outside both markers', async () => {
    const target = join(root, 'CLAUDE.md');
    mkdirSync(root, { recursive: true });
    writeFileSync(target, '# My project\n\nPersonal notes before Noir.\n', 'utf8');

    await init(root);
    const after = readFileSync(target, 'utf8');
    expect(after).toContain('# My project');
    expect(after).toContain('Personal notes before Noir.');
    expect(after).toContain(CONTEXT_BLOCK.begin);
    expect(after).toContain(RULES_BLOCK.begin);
  });
});

describe('scaffold — legacy NOIR.md self-heal (I2)', () => {
  it('legacy unmarked NOIR.md → init → exactly ONE brief, inside markers', async () => {
    // Pre-seed a legacy whole-file auto-brief with NO BRIEF_BLOCK markers,
    // matching a pre-Slice-S .noir/NOIR.md.
    mkdirSync(join(root, '.noir'), { recursive: true });
    const legacy = [
      '# Project',
      '',
      'Project id: `legacy-stale-id`',
      '',
      'Some old auto-brief body.',
      '',
    ].join('\n');
    writeFileSync(paths.noirMd(root), legacy, 'utf8');

    const res = await init(root);
    const md = readFileSync(paths.noirMd(root), 'utf8');

    // Exactly ONE "Project id:" line, inside markers, matching the new id.
    const idLines = md.match(/^Project id:.*$/gm) ?? [];
    expect(idLines.length).toBe(1);
    expect(md).toContain(`Project id: \`${res.projectId}\``);
    expect(md).toContain('<!-- noir:brief begin -->');
    expect(md).toContain('<!-- noir:brief end -->');
    // The stale legacy brief was replaced (not appended-to).
    expect(md).not.toContain('legacy-stale-id');
    expect(md).not.toContain('Some old auto-brief body.');
  });

  it('already-marked NOIR.md keeps user content outside the brief (normal path)', async () => {
    // A managed-shape NOIR.md with user notes after the brief.
    mkdirSync(join(root, '.noir'), { recursive: true });
    const marked = [
      '<!-- noir:brief begin -->',
      'Project id: `old-id`',
      '<!-- noir:brief end -->',
      '',
      '# My project notes',
      '',
      'Personal detail.',
      '',
    ].join('\n');
    writeFileSync(paths.noirMd(root), marked, 'utf8');

    const res = await init(root);
    const md = readFileSync(paths.noirMd(root), 'utf8');
    // Brief refreshed to the new id…
    expect(md).toContain(`Project id: \`${res.projectId}\``);
    expect(md).not.toContain('`old-id`');
    // …and the user content outside the markers survives.
    expect(md).toContain('# My project notes');
    expect(md).toContain('Personal detail.');
  });
});

describe('scaffold — migrations skip on fresh project (M4)', () => {
  it('fresh project (fromVersion null) skips migrations entirely on --upgrade', async () => {
    const res = await scaffold({ root, mode: 'init', upgrade: true });
    expect(res.fromVersion).toBeNull();
    expect(res.migrationsRan).toEqual([]);
    expect(res.migrationConflicts).toEqual([]);
  });

  it('upgrade on an already-initialized project still runs migrations', async () => {
    await init(root); // stamps fromVersion = CURRENT
    const res = await scaffold({ root, mode: 'init', upgrade: true });
    expect(res.fromVersion).not.toBeNull();
    expect(res.migrationsRan).toContain('1.0.0→1.0.0');
  });
});

// ---------------------------------------------------------------------------
// S10 — host-parametric scaffold. The default (claude) is BYTE-IDENTICAL to
// v1.1 (fix-wave I1 REMOVED the additive root AGENTS.md — claude's CLAUDE.md
// already @-imports .noir/; emitting AGENTS.md too double-imported them). Each
// non-claude host emits its own native context surface + the host MCP config.
// AGENTS.md is emitted only for agents-md/cursor/opencode (whose native context
// surface IS AGENTS.md); claude/gemini use their own CLAUDE.md/GEMINI.md.
// ---------------------------------------------------------------------------
describe('scaffold — host-parametric (--host <id>)', () => {
  it('default host (no opts.host) is claude; CLAUDE.md + .mcp.json present; NO AGENTS.md (I1)', async () => {
    const res = await scaffold({ root, mode: 'init', transport: 'stdio' });
    expect(res.host).toBe('claude');
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(root, '.mcp.json'))).toBe(true);
    // I1 regression anchor: claude NO LONGER emits AGENTS.md (would double-
    // import .noir/ sources via CLAUDE.md's existing @-imports).
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
  });

  it('host:gemini → GEMINI.md + .gemini/mcp.json; NO AGENTS.md (I1); no CLAUDE.md leakage', async () => {
    await scaffold({ root, mode: 'init', transport: 'stdio', host: 'gemini' });
    expect(existsSync(join(root, 'GEMINI.md'))).toBe(true);
    // I1: gemini NO LONGER emits AGENTS.md (would double-import via GEMINI.md).
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(root, '.gemini', 'mcp.json'))).toBe(true);
    // The canonical store is host-agnostic.
    expect(existsSync(paths.projectId(root))).toBe(true);
    expect(existsSync(paths.noirMd(root))).toBe(true);
    // Claude artifacts do NOT leak into a gemini project.
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(root, '.mcp.json'))).toBe(false);
    // GEMINI.md carries both CONTEXT_BLOCK + RULES_BLOCK markers (the multi-
    // region atomic write — same write path as CLAUDE.md).
    const md = readFileSync(join(root, 'GEMINI.md'), 'utf8');
    expect(md).toContain(CONTEXT_BLOCK.begin);
    expect(md).toContain('@.noir/NOIR.md');
    expect(md).toContain(RULES_BLOCK.begin);
    expect(md).toContain('@.noir/rules/RULES.md');
    // .gemini/mcp.json is the {mcpServers} shape (stdio entry).
    const mcp = JSON.parse(readFileSync(join(root, '.gemini', 'mcp.json'), 'utf8'));
    expect(mcp.mcpServers.noir).toEqual({ command: 'noir', args: ['mcp', 'serve', '--stdio'] });
  });

  it('host:cursor → AGENTS.md + .cursor/mcp.json; no CLAUDE.md/GEMINI.md; no host-rules .mdc', async () => {
    await scaffold({ root, mode: 'init', transport: 'stdio', host: 'cursor' });
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(root, '.cursor', 'mcp.json'))).toBe(true);
    expect(existsSync(paths.projectId(root))).toBe(true);
    // Cursor has NO separate native context file (AGENTS.md IS the context).
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(root, 'GEMINI.md'))).toBe(false);
    // Regression anchor: NO host-rules .mdc emitted. The prior
    // `noir-contract.mdc` pointer was REMOVED — it was `noir-`-prefixed, so
    // the C3 cursor flat-skill prune deleted it on every
    // `noir init/create/sync --host cursor`. Cursor's rules ride AGENTS.md's
    // `@.noir/rules/RULES.md` import instead.
    expect(existsSync(join(root, '.cursor', 'rules', 'noir-contract.mdc'))).toBe(false);
  });

  it('host:opencode → AGENTS.md + opencode.json (mcp block, type-tagged)', async () => {
    await scaffold({ root, mode: 'init', transport: 'stdio', host: 'opencode' });
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(root, 'opencode.json'))).toBe(true);
    const cfg = JSON.parse(readFileSync(join(root, 'opencode.json'), 'utf8'));
    expect(cfg.$schema).toBe('https://opencode.ai/config.json');
    expect(cfg.mcp.noir).toEqual({ type: 'local', command: ['noir', 'mcp', 'serve', '--stdio'] });
    // No Claude/Gemini leakage.
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(root, '.mcp.json'))).toBe(false);
  });

  it('host:agents-md → AGENTS.md + .mcp.json (Claude-shape; broadly compatible)', async () => {
    await scaffold({ root, mode: 'init', transport: 'stdio', host: 'agents-md' });
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(root, '.mcp.json'))).toBe(true);
    // No host-native context file beyond AGENTS.md.
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(root, 'GEMINI.md'))).toBe(false);
  });

  it('config.yml persists the chosen host (so `noir sync` reads it back)', async () => {
    await scaffold({ root, mode: 'init', transport: 'stdio', host: 'gemini' });
    const cfg = readFileSync(paths.config(root), 'utf8');
    expect(cfg).toMatch(/^host: gemini/m); // yaml literal — `noir sync` reads this
  });

  it('M1: AGENTS.md byte-equals emitAgentsMd({root}) for an AGENTS.md-emitting host (agents-md)', async () => {
    // M1 parity anchor: when a host DOES emit AGENTS.md, the bytes on disk
    // equal the shared `emitAgentsMd({root})` helper output (single source of
    // truth). For claude/gemini the file is ABSENT — covered by the I1 cases.
    await scaffold({ root, mode: 'init', transport: 'stdio', host: 'agents-md' });
    const expected = emitAgentsMd({ root });
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(expected);
  });
});
