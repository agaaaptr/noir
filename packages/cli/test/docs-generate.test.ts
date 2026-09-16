// Offline test for scripts/docs-generate.mjs — the docs generator seam.
//
// Two structural generator defects lived here: the CLI reference ran only the
// root `noir --help` (so no subcommand flag was ever documented), and the
// config reflector stopped one level down (so third-level fields such as
// `workflow.gate.verify.required` were dropped). This file pins the fix at the
// two seams that stay cheap and offline:
//
//   - the help parsers are exercised against fixture help pages (no subprocess,
//     covering the fragile parts: wrapped descriptions, hand-written after-text,
//     alias tokens, flag/description splitting);
//   - the config generator runs end-to-end against the real Zod schema
//     (`node -e` reflection only — no network, no key), so the depth budget is
//     asserted against the schema rather than a snapshot;
//   - the CLI reference is asserted on the committed `docs/reference/cli.md`,
//     which `pnpm docs:generate` writes — a walker regression re-run at release
//     time drops these rows and fails here.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Walk up to the nearest dir carrying pnpm-workspace.yaml (monorepo root). */
function repoRoot(): string {
  let here = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(here, 'pnpm-workspace.yaml'))) return here;
    const parent = dirname(here);
    if (parent === here) break;
    here = parent;
  }
  return process.cwd();
}

// The generator is an ESM `.mjs` script. Import its exported generators +
// parsers — the `isMainModule()` guard keeps the CLI dispatch from firing on
// import, so this is safe + side-effect-free.
const GENERATOR_URL = pathToFileURL(join(repoRoot(), 'scripts', 'docs-generate.mjs')).href;
const {
  buildRegistry,
  findGeneratedPlaceholders,
  genConfigSchema,
  helpCommands,
  helpDescription,
  helpOptions,
  helpUsage,
} = (await import(GENERATOR_URL)) as {
  buildRegistry: () => {
    documents: { path: string; lifecycle: 'active' | 'archived'; category: string }[];
  };
  findGeneratedPlaceholders: (docs: { path: string; content: string }[]) => string[];
  genConfigSchema: () => string;
  helpCommands: (help: string) => string[];
  helpDescription: (help: string) => string;
  helpOptions: (help: string) => { flag: string; description: string }[];
  helpUsage: (help: string) => string;
};

const coreBuilt = existsSync(join(repoRoot(), 'packages', 'core', 'dist', 'index.js'));
const cliReferencePath = join(repoRoot(), 'docs', 'reference', 'cli.md');
const cliReference = existsSync(cliReferencePath) ? readFileSync(cliReferencePath, 'utf8') : '';

// A group help page mirroring `noir daemon --help`: a wrapped subcommand
// description, and hand-written example text AFTER the Commands block.
const GROUP_HELP = `Usage: noir daemon [options] [command]

control the Noir daemon

Options:
  -h, --help             display help for command

Commands:
  start [options]        start the Noir daemon (foreground, or background with
                         --detach)
  join [options] <name>  join a shared workspace from this repo
  stop                   stop the Noir daemon

Shared workspaces (two repos, one product — e.g. backend + frontend):
  noir daemon start --workspace <name> --detach   found a workspace from this repo
  noir daemon join <name>                         join it from the other repo
`;

// A leaf help page mirroring `noir init --help`: a wrapped option description,
// and a flag placeholder whose own space must not split the flag cell.
const LEAF_HELP = `Usage: noir init [options]

scaffold Noir in the current project (.noir/, .mcp.json, CLAUDE.md, skills)

Options:
  --transport <transport>  stdio | streamable-http (default: stdio) (default:
                           "stdio")
  --force                  re-scaffold even if already initialized (bypasses
                           the already-init no-op)
  -h, --help               display help for command
`;

describe('docs generator — help parsers', () => {
  it('lists only real subcommands, ignoring hand-written after-text', () => {
    expect(helpCommands(GROUP_HELP)).toEqual(['start', 'join', 'stop']);
  });

  it('extracts the usage line and the description block', () => {
    expect(helpUsage(LEAF_HELP)).toBe('noir init [options]');
    expect(helpDescription(LEAF_HELP)).toBe(
      'scaffold Noir in the current project (.noir/, .mcp.json, CLAUDE.md, skills)',
    );
  });

  it('splits each option into flag + description and drops the built-in help flag', () => {
    expect(helpOptions(LEAF_HELP)).toEqual([
      {
        flag: '--transport <transport>',
        description: 'stdio | streamable-http (default: stdio) (default: "stdio")',
      },
      {
        flag: '--force',
        description: 're-scaffold even if already initialized (bypasses the already-init no-op)',
      },
    ]);
  });
});

describe('docs generator — reference stub gate', () => {
  // The generators write an italic placeholder when the build artefact they read
  // is missing, so a placeholder surviving into docs/reference/ means the doc was
  // committed half-generated. The gate must fail on it.
  it('flags a generated placeholder left in a reference doc', () => {
    const issues = findGeneratedPlaceholders([
      {
        path: 'docs/reference/cli.md',
        content:
          '# CLI Command Reference\n\n_(CLI not built — run `pnpm build` to generate CLI reference)_\n',
      },
      { path: 'docs/reference/packages.md', content: '# Packages\n\n| a | b |\n|---|---|\n' },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('docs/reference/cli.md');
    expect(issues[0]).toContain('[GENERATED-PLACEHOLDER]');
  });

  it('ignores a placeholder-looking line outside docs/reference/ and prose inside one', () => {
    const issues = findGeneratedPlaceholders([
      { path: 'docs/how-to/x.md', content: '_(help unavailable for this command)_\n' },
      {
        path: 'docs/reference/mcp-tools.md',
        content: '| tool | Degrades to BM25-only when the embedder is unavailable. |\n',
      },
    ]);
    expect(issues).toEqual([]);
  });

  it('flags the committed reference docs only when they really carry a stub', () => {
    // The committed docs are fully generated, so the live check is a no-op today;
    // the assertion pins that the scan sees the real tree (not an empty list).
    const registry = buildRegistry();
    const reference = registry.documents
      .filter((d) => d.path.startsWith('docs/reference/') && d.path.endsWith('.md'))
      .map((d) => ({
        path: d.path,
        content: readFileSync(join(repoRoot(), d.path), 'utf8'),
      }));
    expect(reference.length).toBeGreaterThan(0);
    expect(findGeneratedPlaceholders(reference)).toEqual([]);
  });
});

describe('docs generator — internal-doc lifecycle', () => {
  it('marks a shipped spec/plan pair archived alongside the SDD history', () => {
    const lifecycle = new Map(buildRegistry().documents.map((d) => [d.path, d.lifecycle]));
    // The 2026-09-14 spec + plan pair shipped in 1.15.0, so it is history now.
    expect(
      lifecycle.get(
        'docs/internal/specs/2026-09-14-env-templates-upgrade-provider-run-ux-design.md',
      ),
    ).toBe('archived');
    expect(
      lifecycle.get('docs/internal/plans/2026-09-14-env-templates-upgrade-provider-run-ux.md'),
    ).toBe('archived');
    // An older, shipped plan is history too.
    expect(lifecycle.get('docs/internal/plans/2026-07-25-s7-memory.md')).toBe('archived');
  });
});

describe('docs generator — config reference', () => {
  it.skipIf(!coreBuilt)('reflects third-level fields without losing earlier levels', () => {
    const markdown = genConfigSchema();

    // Fields the previous depth budget dropped.
    for (const field of [
      'context.embedder.dim',
      'context.embedder.kind',
      'model.tiers.consolidate',
      'memory.consolidation.provider',
      'workflow.gate.verify.required',
      'workflow.gate.verify.retryBudget',
      'workflow.gate.verify.checks',
      'workflow.gate.research.recommendFor',
      'workflow.gate.research.requireSource',
      'integrations.<name>.auth.tokenEnv',
    ]) {
      expect(markdown, `expected the config reference to document \`${field}\``).toContain(
        `\`${field}\``,
      );
    }

    // Earlier levels must survive the deeper recursion.
    for (const field of [
      'daemon.idleTimeoutSec',
      'context.embedder',
      'workflow.gate',
      'model.providers.<name>.model',
    ]) {
      expect(markdown).toContain(`\`${field}\``);
    }
  });
});

describe('docs generator — CLI reference', () => {
  it('documents subcommand flags beyond the root help', () => {
    // The root block and the global section survive alongside the walk.
    expect(cliReference).toContain('# CLI Command Reference');
    expect(cliReference).toContain('## Global Flags');
    expect(cliReference).toContain('## Commands');

    // A top-level leaf and one of its own flags.
    expect(cliReference).toContain('### noir init');
    expect(cliReference).toContain('`--transport <transport>`');
    // A `|` inside a description is escaped so it cannot close the table cell.
    expect(cliReference).toContain('stdio \\| streamable-http');

    // A nested leaf, and an aliased command that keeps its alias visible.
    expect(cliReference).toContain('### noir task research-record');
    expect(cliReference).toContain('`--source <ref>`');
    expect(cliReference).toContain('noir install|migrate [options] [spec]');
  });
});
