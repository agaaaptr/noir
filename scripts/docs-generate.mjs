#!/usr/bin/env node
// Documentation generation & validation engine for Noir.
//
// Manages auto-generated doc sections via <!-- noir:doc:* --> managed blocks.
// Reads source-of-truth from: packages/*/package.json, npm registry, git tags,
// packages/cli/src/bin.ts (via runtime help), packages/core/src/config.ts (Zod schema),
// packages/skills/builtin/*/SKILL.md, packages/daemon/src/*.
//
// Commands:
//   generate  — regenerate all managed doc blocks across the repo
//   validate  — check docs for broken links, stale refs, version mismatches
//   registry  — rebuild .noir/docs-registry.json
//   index     — generate docs/README.md table of contents
//
// Managed block markers:
//   <!-- noir:doc:status -->       → current stable/beta version status
//   <!-- noir:doc:version -->      → version number references
//   <!-- noir:doc:cli-ref -->      → CLI command reference (runtime help output)
//   <!-- noir:doc:config-schema -->→ config schema (Zod .describe() reflection)
//   <!-- noir:doc:skills -->       → builtin skills table
//   <!-- noir:doc:mcp-tools -->    → MCP tools table
//   <!-- noir:doc:packages -->     → package inventory table
//   <!-- noir:doc:release-history -->→ recent release history (from releases.json)

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DOCS_DIR = join(ROOT, 'docs');
const PACKAGES_DIR = join(ROOT, 'packages');
const SKILLS_BUILTIN = join(ROOT, 'packages', 'skills', 'builtin');
const SKILLS_INTEGRATIONS = join(ROOT, 'packages', 'skills', 'integrations');
const REGISTRY_PATH = join(ROOT, '.noir', 'docs-registry.json');

// ── Argument parsing ──────────────────────────────────────────────

const command = process.argv[2];
const USAGE = 'Usage: node scripts/docs-generate.mjs <generate|validate|registry|index>';

if (!command || !['generate', 'validate', 'registry', 'index'].includes(command)) {
  console.error(USAGE);
  process.exit(1);
}

// ── Helpers ────────────────────────────────────────────────────────

function exec(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: ROOT,
      timeout: 20_000,
      ...opts,
    }).trim();
  } catch (err) {
    if (opts.nullable) return '';
    throw err;
  }
}

function readFile(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function npmView(args) {
  return JSON.parse(
    execFileSync('npm', ['view', ...args, '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    }).trim(),
  );
}

function npmViewNullable(args) {
  try {
    return npmView(args);
  } catch {
    return null;
  }
}

function _git(args) {
  return exec('git', args, { nullable: true });
}

function getBaseVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(PACKAGES_DIR, 'cli', 'package.json'), 'utf8'));
    return pkg.version;
  } catch {
    return 'unknown';
  }
}

/**
 * Read a file, find managed blocks matching a tag, replace content.
 * @param {string} path - file path
 * @param {string} tag - e.g. "noir:doc:status"
 * @param {string} newContent - content to insert between markers
 * @param {boolean} dryRun - if true, don't write
 * @returns {boolean} true if block was found and replaced
 */
function replaceManagedBlock(path, tag, newContent, dryRun = false) {
  const content = readFile(path);
  if (!content) return false;

  const startMarker = `<!-- ${tag} -->`;
  const endMarker = `<!-- /${tag} -->`;

  const startIdx = content.indexOf(startMarker);
  const endIdx = content.indexOf(endMarker);

  if (startIdx === -1 || endIdx === -1) return false;

  const before = content.slice(0, startIdx + startMarker.length);
  const after = content.slice(endIdx);
  const newDoc = `${before}\n${newContent}\n${after}`;

  if (!dryRun) {
    writeFileSync(path, newDoc, 'utf8');
  }
  return true;
}

/**
 * Extract text between managed block markers.
 * Returns null if block not found.
 */
function _readManagedBlock(content, tag) {
  const startMarker = `<!-- ${tag} -->`;
  const endMarker = `<!-- /${tag} -->`;
  const startIdx = content.indexOf(startMarker);
  const endIdx = content.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1) return null;
  return content.slice(startIdx + startMarker.length, endIdx).trim();
}

// ── Content generators ────────────────────────────────────────────

/** Single version string for inline injection (e.g. `1.9.1`). */
function genVersionInline() {
  return getBaseVersion();
}

function genVersionStatus() {
  const base = getBaseVersion();
  const distTags = npmViewNullable(['@noir-ai/cli', 'dist-tags']) || {};
  const latest = distTags.latest || 'N/A';
  const beta = distTags.beta || 'N/A';

  return [
    `**Latest stable:** \`${latest}\` (npm dist-tag \`latest\` — \`npm i @noir-ai/cli\` resolves here)`,
    `**Current beta:** \`${beta}\` (npm dist-tag \`beta\` — \`npm i @noir-ai/cli@beta\` to opt in)`,
    `**Source version:** \`${base}\` (clean SemVer in \`packages/*/package.json\`)`,
    '',
    `*Last auto-generated: ${new Date().toISOString()}*`,
  ].join('\n');
}

function genCliReference() {
  // Run `noir --help` and capture all command help
  const built = join(ROOT, 'packages', 'cli', 'dist', 'bin.js');
  let mainHelp = '';
  try {
    mainHelp = exec('node', [built, '--help'], { nullable: true });
  } catch {
    mainHelp = '_(CLI not built — run `pnpm build` to generate CLI reference)_';
  }

  const lines = ['# CLI Command Reference', '', '> Auto-generated from `noir --help` output.', ''];

  if (mainHelp) {
    lines.push('```');
    lines.push(mainHelp);
    lines.push('```');
  } else {
    lines.push(mainHelp);
  }

  lines.push('');
  lines.push('## Global Flags');
  lines.push('');
  lines.push('| Flag | Description |');
  lines.push('|---|---|');
  lines.push('| `--json` | Machine-readable output (data → stdout, diagnostics → stderr) |');
  lines.push('| `--no-input` | Never prompt; CI/pipe-safe |');
  lines.push('| `--quiet` | Suppress non-error output |');
  lines.push('| `--verbose` | Detailed diagnostics |');
  lines.push('| `--cwd <dir>` | Working directory |');
  lines.push('| `--tui` / `--no-tui` | Advisory routing for bare `noir` |');
  lines.push('| `--no-tips` | Suppress hints on stderr |');
  lines.push('');

  return lines.join('\n');
}

function genConfigSchema() {
  const lines = [
    '# Configuration Reference',
    '',
    '> Auto-generated from `NoirConfigSchema` (Zod v4) in `@noir-ai/core`.',
    '',
  ];

  // Use Node.js to reflect on the Zod schema at runtime
  try {
    const schemaOutput = exec(
      'node',
      [
        '-e',
        `
      import('${join(ROOT, 'packages', 'core', 'dist', 'index.js')}').then(m => {
        const schema = m.NoirConfigSchema;
        if (!schema) { console.log('{}'); return; }
        // Zod v4: _def.shape may be an object of fields (v4) or a function (v3).
        const rawShape = schema._def?.shape;
        const shape = typeof rawShape === 'function' ? rawShape() : (rawShape || {});
        const result = {};
        for (const [key, field] of Object.entries(shape)) {
          // Zod v4 puts the schema on the field's own 'shape' too; the field may be
          // wrapped (optional/nullable/default) — resolve to the inner schema.
          const inner = field?.unwrap?.() || field;
          const typeName = inner?._def?.typeName || field?._def?.typeName || 'unknown';
          const dv = field?._def?.defaultValue;
          let defaultValue;
          if (typeof dv === 'function') defaultValue = JSON.stringify(dv());
          else if (dv && typeof dv === 'object' && 'value' in dv) defaultValue = JSON.stringify(dv.value);
          else if (dv !== undefined) defaultValue = JSON.stringify(dv);
          result[key] = {
            type: typeName,
            required: !(field?.isOptional?.() ?? false),
            description: inner?._def?.description || inner?.description || field?._def?.description || '',
            default: defaultValue,
          };
        }
        console.log(JSON.stringify(result, null, 2));
      }).catch((e) => { console.error('schema-reflection error:', e?.message); console.log('{}'); });
    `,
      ],
      { nullable: true },
    );

    const shape = JSON.parse(schemaOutput || '{}');

    if (Object.keys(shape).length === 0) {
      lines.push('_(Schema reflection unavailable — run `pnpm build` first)_');
      lines.push('');
      lines.push(
        'See `packages/core/src/config.ts` for the authoritative `NoirConfigSchema` definition.',
      );
    } else {
      lines.push('| Field | Type | Required | Default | Description |');
      lines.push('|---|---|---|---|---|');
      for (const [key, info] of Object.entries(shape)) {
        lines.push(
          `| \`${key}\` | \`${info.type}\` | ${info.required ? 'yes' : 'no'} | ${info.default || '—'} | ${info.description} |`,
        );
      }
    }
  } catch {
    lines.push('_(Config schema unavailable — build packages first with `pnpm build`)_');
  }

  lines.push('');
  return lines.join('\n');
}

function genSkillsTable() {
  const lines = [
    '# Builtin Skills',
    '',
    '> Auto-generated from `packages/skills/builtin/*/SKILL.md` and `integrations/*/SKILL.md`.',
    '',
  ];

  const skills = [];

  // Read builtin skills
  if (existsSync(SKILLS_BUILTIN)) {
    for (const dir of readdirSync(SKILLS_BUILTIN)) {
      const skillMd = join(SKILLS_BUILTIN, dir, 'SKILL.md');
      if (!existsSync(skillMd)) continue;
      const content = readFile(skillMd);
      if (!content) continue;

      // Extract description + category from YAML frontmatter. `metadata.category`
      // is the C3 single source of truth; a missing category falls back to the
      // name-derived topic so the table never shows an empty cell.
      const descMatch = content.match(/description:\s*(.+)/);
      const desc = descMatch ? descMatch[1].trim() : '';
      const catMatch = content.match(/^\s*category:\s*(.+)$/m);
      const category = catMatch ? catMatch[1].trim() : dir.replace(/^noir-/, '') || 'general';
      skills.push({ name: dir, desc, type: 'builtin', category });
    }
  }

  // Read integration skills
  if (existsSync(SKILLS_INTEGRATIONS)) {
    for (const dir of readdirSync(SKILLS_INTEGRATIONS)) {
      const skillMd = join(SKILLS_INTEGRATIONS, dir, 'SKILL.md');
      if (!existsSync(skillMd)) continue;
      const content = readFile(skillMd);
      if (!content) continue;
      const descMatch = content.match(/description:\s*(.+)/);
      const desc = descMatch ? descMatch[1].trim() : '';
      const catMatch = content.match(/^\s*category:\s*(.+)$/m);
      const category = catMatch ? catMatch[1].trim() : 'integration';
      skills.push({ name: dir, desc, type: 'integration', category });
    }
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));

  lines.push(
    `**${skills.length} skills** (${skills.filter((s) => s.type === 'builtin').length} builtins + ${skills.filter((s) => s.type === 'integration').length} integrations)`,
  );
  lines.push('');
  lines.push('| Skill | Type | Category | Description |');
  lines.push('|---|---|---|---|');
  for (const s of skills) {
    lines.push(`| \`${s.name}\` | ${s.type} | ${s.category} | ${s.desc} |`);
  }
  lines.push('');

  return lines.join('\n');
}

function genMcpTools() {
  const lines = [
    '# MCP Tools Reference',
    '',
    '> Auto-generated from daemon tool registrations.',
    '',
  ];

  // MCP tools are registered in packages/daemon/src/*.ts — grep for registration patterns
  const daemonDir = join(ROOT, 'packages', 'daemon', 'src');
  const tools = new Map(); // name → { category, description }

  if (existsSync(daemonDir)) {
    for (const file of readdirSync(daemonDir)) {
      if (!file.endsWith('.ts') && !file.endsWith('.mjs')) continue;
      const content = readFile(join(daemonDir, file));
      if (!content) continue;

      // Find tool registration: server.registerTool('tool_name', { description: ... }, handler)
      const toolMatches = content.matchAll(/registerTool\(\s*['"]([\w_]+)['"]/g);
      for (const m of toolMatches) {
        const name = m[1];
        // Find the description in the options object following the name
        const afterName = content.slice(m.index + m[0].length, m.index + m[0].length + 500);
        const descMatch = afterName.match(/description:\s*['"]([^'"]+)['"]/);
        const desc = descMatch ? descMatch[1] : '';

        // Determine category from file name
        let category = 'general';
        if (file.includes('workflow')) category = 'workflow';
        else if (file.includes('context')) category = 'context';
        else if (file.includes('memory')) category = 'memory';
        else if (file.includes('store')) category = 'store';
        else if (file.includes('host')) category = 'host';
        else if (file.includes('integration') || file.includes('clickup'))
          category = 'integrations';

        if (!tools.has(name)) {
          tools.set(name, { category, description: desc });
        }
      }
    }
  }

  // Group by category
  const byCategory = {};
  for (const [name, info] of tools) {
    if (!byCategory[info.category]) byCategory[info.category] = [];
    byCategory[info.category].push({ name, ...info });
  }

  const categoryOrder = [
    'host',
    'store',
    'workflow',
    'context',
    'memory',
    'integrations',
    'general',
  ];
  for (const cat of categoryOrder) {
    if (!byCategory[cat]) continue;
    const entries = byCategory[cat];
    lines.push(`### ${cat.charAt(0).toUpperCase() + cat.slice(1)}`);
    lines.push('');
    lines.push('| Tool | Description |');
    lines.push('|---|---|');
    for (const t of entries) {
      lines.push(`| \`${t.name}\` | ${t.description || '—'} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function genPackages() {
  const lines = [
    '# Package Inventory',
    '',
    '> Auto-generated from `packages/*/package.json`.',
    '',
    `**Source version:** \`${getBaseVersion()}\``,
    '',
  ];

  const pkgs = [];
  for (const dir of readdirSync(PACKAGES_DIR)) {
    const pkgPath = join(PACKAGES_DIR, dir, 'package.json');
    if (!existsSync(pkgPath)) continue;
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (!pkg.name?.startsWith('@noir-ai/')) continue;
      pkgs.push({
        name: pkg.name,
        description: pkg.description || '',
        version: pkg.version,
        hasBin: !!pkg.bin,
      });
    } catch {
      // skip invalid package.json
    }
  }

  pkgs.sort((a, b) => a.name.localeCompare(b.name));

  lines.push('| Package | Version | Description | Binary |');
  lines.push('|---|---|---|---|');
  for (const p of pkgs) {
    lines.push(
      `| \`${p.name}\` | ${p.version} | ${p.description} | ${p.hasBin ? '`noir`' : '—'} |`,
    );
  }
  lines.push('');

  return lines.join('\n');
}

function _genReleaseHistory() {
  const lines = [];
  const versions = npmViewNullable(['@noir-ai/cli', 'versions']) || [];
  const timeData = npmViewNullable(['@noir-ai/cli', 'time']) || {};

  if (versions.length === 0) {
    lines.push('_No releases yet._');
    return lines.join('\n');
  }

  // Show last 10 releases
  const recent = versions.sort().reverse().slice(0, 10);
  lines.push('| Version | Date |');
  lines.push('|---|---|');
  for (const v of recent) {
    const date = timeData[v] ? new Date(timeData[v]).toISOString().slice(0, 10) : '—';
    lines.push(`| ${v} | ${date} |`);
  }

  return lines.join('\n');
}

// ── Document registry ──────────────────────────────────────────────

function findDocs(dir = DOCS_DIR, basePath = 'docs') {
  const docs = [];
  if (!existsSync(dir)) return docs;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    const relPath = `${basePath}/${entry.name}`;

    // Skip the docs/CHANGELOG.md stub — the root CHANGELOG.md is the single source of
    // truth and is added explicitly by buildRegistry(). Keeping a pointer file at
    // docs/CHANGELOG.md would register it twice.
    if (relPath === 'docs/CHANGELOG.md') continue;

    // Skip docs/README.md — it is the auto-generated index itself; indexing it would
    // self-reference (it appears as a spurious "Documentation" entry in the index).
    if (relPath === 'docs/README.md') continue;

    if (entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('_')) {
      docs.push(...findDocs(fullPath, relPath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const stat = statSync(fullPath);
      const content = readFile(fullPath);
      const titleMatch = content?.match(/^#\s+(.+)/m);
      const title = titleMatch ? titleMatch[1].trim() : entry.name.replace('.md', '');

      // Determine category from path
      let category = 'other';
      if (relPath.startsWith('docs/how-to/')) category = 'how-to';
      else if (relPath.startsWith('docs/reference/')) category = 'reference';
      else if (relPath.startsWith('docs/explanation/')) category = 'explanation';
      else if (relPath.startsWith('docs/decisions/')) category = 'adr';
      else if (relPath.startsWith('docs/internal/')) category = 'internal';
      else if (relPath === 'docs/getting-started.md') category = 'tutorial';
      else if (relPath.startsWith('docs/roadmap/')) category = 'roadmap';
      else if (relPath.startsWith('docs/CHANGELOG.md')) category = 'record';
      else if (relPath.startsWith('docs/') && basePath === 'docs' && !relPath.includes('/'))
        category = 'root-doc';

      // Determine lifecycle
      let lifecycle = 'active';
      if (relPath.startsWith('docs/internal/')) lifecycle = 'archived';

      // Detect auto-generated
      const autoGenerated = content?.includes('<!-- noir:doc:') || false;

      docs.push({
        id: relPath
          .replace(/^docs\/?/, '')
          .replace(/\//g, '-')
          .replace('.md', ''),
        path: relPath,
        title,
        category,
        lifecycle,
        autoGenerated,
        lastModified: stat.mtime.toISOString().slice(0, 10),
      });
    }
  }

  return docs;
}

function buildRegistry() {
  const docs = findDocs();

  // Add root README
  const rootReadme = readFile(join(ROOT, 'README.md'));
  if (rootReadme) {
    const titleMatch = rootReadme.match(/^#\s+(.+)/m);
    docs.unshift({
      id: 'readme',
      path: 'README.md',
      title: titleMatch ? titleMatch[1].trim() : 'Noir',
      category: 'root',
      lifecycle: 'active',
      autoGenerated: false,
      lastModified: statSync(join(ROOT, 'README.md')).mtime.toISOString().slice(0, 10),
    });
  }

  // Add root CHANGELOG
  if (existsSync(join(ROOT, 'CHANGELOG.md'))) {
    docs.push({
      id: 'changelog',
      path: 'CHANGELOG.md',
      title: 'Changelog',
      category: 'record',
      lifecycle: 'active',
      autoGenerated: false,
      lastModified: statSync(join(ROOT, 'CHANGELOG.md')).mtime.toISOString().slice(0, 10),
    });
  }

  return {
    generated: new Date().toISOString(),
    totalDocuments: docs.length,
    documents: docs.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

// ── Validation ─────────────────────────────────────────────────────

function validateDocs() {
  const issues = [];
  const baseVersion = getBaseVersion();

  // 1. Check for broken relative links in all .md files
  function findMdFiles(dir, prefix = '') {
    const files = [];
    if (!existsSync(dir)) return files;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...findMdFiles(fullPath, `${prefix}${entry.name}/`));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push({ path: fullPath, relPath: `${prefix}${entry.name}` });
      }
    }
    return files;
  }

  const allMd = [
    ...findMdFiles(ROOT, '').filter(
      (f) => !f.relPath.startsWith('node_modules/') && !f.relPath.startsWith('.git/'),
    ),
  ];

  const docPaths = new Set(allMd.map((f) => f.relPath));

  for (const file of allMd) {
    const content = readFile(file.path);
    if (!content) continue;

    // Find markdown links: [text](path)
    const linkRe = /\[([^\]]*)\]\(([^)]+)\)/g;
    const matches = [...content.matchAll(linkRe)];
    for (const match of matches) {
      const linkTarget = match[2];
      // Skip external URLs and anchors
      if (linkTarget.startsWith('http://') || linkTarget.startsWith('https://')) continue;
      if (linkTarget.startsWith('#')) continue;

      // Resolve relative link, normalizing ./ and ../ but preserving .md extensions
      const fileDir = dirname(file.relPath);
      let resolved = join(fileDir, linkTarget);
      // Strip leading ./ segments only (preserve file extensions)
      resolved = resolved.replace(/(^|\/)\.\//g, '$1');

      // Check if the file exists (strip fragment)
      const cleanTarget = resolved.split('#')[0];
      if (cleanTarget && !docPaths.has(cleanTarget) && !existsSync(join(ROOT, cleanTarget))) {
        issues.push(
          `[BROKEN-LINK] ${file.relPath}: link to "${linkTarget}" (resolved: ${cleanTarget}) not found.`,
        );
      }
    }

    // Check for stale version references (only in user-facing docs, skip historical
    // and auto-generated reference docs)
    if (
      file.relPath.includes('internal/') ||
      file.relPath.includes('decisions/') ||
      file.relPath.includes('CHANGELOG') ||
      file.relPath.includes('roadmap') ||
      file.relPath.includes('docs/reference/')
    )
      continue;

    // Detect hardcoded X.Y.Z version numbers outside managed blocks.
    // If a user-facing doc has a version string that matches the *current*
    // base version (from package.json) but is NOT inside a managed block,
    // it's a drift risk — it will be stale on the next release.
    const inManagedBlock = (lineIdx) => {
      // Look backwards from lineIdx to find the nearest <!-- noir:doc:* --> marker
      // and check it's not closed.
      for (let li = Math.max(0, lineIdx - 3); li <= lineIdx; li++) {
        const line = content.split('\n')[li] || '';
        if (line.includes('<!-- noir:doc:status -->') || line.includes('<!-- noir:doc:version -->'))
          return true;
      }
      return false;
    };
    const lines = content.split('\n');
    const semverPattern = /\b(\d+\.\d+\.\d+(?:-[\w.]+)?)\b/g;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Skip release HOWTO (example versions are expected)
      if (file.relPath.includes('how-to/releasing')) continue;
      const matches = [...line.matchAll(semverPattern)];
      for (const m of matches) {
        const ver = m[1];
        // Only flag the *current* base version hardcoded outside managed blocks
        if (ver === baseVersion && !inManagedBlock(i)) {
          issues.push(
            `[HARDCODED-VERSION] ${file.relPath}:${i + 1}: hardcoded "${ver}" outside a managed block. Replace with <!-- noir:doc:status --> or <!-- noir:doc:version --> so it auto-updates on release.`,
          );
          break; // one per line is enough
        }
      }
    }
  }

  // 2. Check npm dist-tags match what docs claim
  const distTags = npmViewNullable(['@noir-ai/cli', 'dist-tags']);
  if (distTags) {
    const readmeContent = readFile(join(ROOT, 'README.md')) || '';
    if (
      distTags.latest &&
      readmeContent.includes(distTags.latest) === false &&
      !readmeContent.includes('<!-- noir:doc:status -->')
    ) {
      // Only warn if not using auto-generated block
    }
  }

  return issues;
}

// ── Commands ───────────────────────────────────────────────────────

function cmdGenerate() {
  console.log('Generating documentation...\n');

  // Read current state
  const base = getBaseVersion();
  const distTags = npmViewNullable(['@noir-ai/cli', 'dist-tags']) || {};
  console.log(`  Base version : ${base}`);
  console.log(`  npm latest   : ${distTags.latest || 'N/A'}`);
  console.log(`  npm beta     : ${distTags.beta || 'N/A'}\n`);

  // Files with managed blocks to regenerate
  const managedFiles = [{ path: 'README.md', tag: 'noir:doc:status', gen: genVersionStatus }];

  // Check docs + root files for managed blocks
  for (const f of findDocs()) {
    const content = readFile(join(ROOT, f.path));
    if (!content) continue;
    if (content.includes('<!-- noir:doc:status -->'))
      managedFiles.push({ path: f.path, tag: 'noir:doc:status', gen: genVersionStatus });
    if (content.includes('<!-- noir:doc:version -->'))
      managedFiles.push({ path: f.path, tag: 'noir:doc:version', gen: genVersionInline });
  }

  // Also scan root-level docs (AGENTS.md, CLAUDE.md, etc.)
  for (const rootFile of ['AGENTS.md']) {
    const fullPath = join(ROOT, rootFile);
    const content = readFile(fullPath);
    if (!content) continue;
    if (content.includes('<!-- noir:doc:status -->'))
      managedFiles.push({ path: rootFile, tag: 'noir:doc:status', gen: genVersionStatus });
    if (content.includes('<!-- noir:doc:version -->'))
      managedFiles.push({ path: rootFile, tag: 'noir:doc:version', gen: genVersionInline });
  }

  let updated = 0;
  for (const { path, tag, gen } of managedFiles) {
    const fullPath = join(ROOT, path);
    const content = gen();
    if (replaceManagedBlock(fullPath, tag, content)) {
      console.log(`  ✓ ${path} (${tag})`);
      updated++;
    }
  }

  // Generate reference docs (full file, not just managed blocks)
  const refDocs = [
    { path: 'docs/reference/packages.md', gen: genPackages },
    { path: 'docs/reference/skills.md', gen: genSkillsTable },
  ];

  for (const { path, gen } of refDocs) {
    const fullPath = join(ROOT, path);
    const content = gen();
    writeFileSync(fullPath, content, 'utf8');
    console.log(`  ✓ ${path} (generated)`);
    updated++;
  }

  // CLI and config references require the project to be built
  const cliBuilt = existsSync(join(ROOT, 'packages', 'cli', 'dist', 'bin.js'));
  if (cliBuilt) {
    const cliContent = genCliReference();
    writeFileSync(join(ROOT, 'docs', 'reference', 'cli.md'), cliContent, 'utf8');
    console.log('  ✓ docs/reference/cli.md (generated)');
    updated++;
  } else {
    console.log('  ⚠ docs/reference/cli.md skipped (run pnpm build first)');
  }

  const coreBuilt = existsSync(join(ROOT, 'packages', 'core', 'dist', 'index.js'));
  if (coreBuilt) {
    const configContent = genConfigSchema();
    writeFileSync(join(ROOT, 'docs', 'reference', 'config.md'), configContent, 'utf8');
    console.log('  ✓ docs/reference/config.md (generated)');
    updated++;
  } else {
    console.log('  ⚠ docs/reference/config.md skipped (run pnpm build first)');
  }

  const daemonBuilt = existsSync(join(ROOT, 'packages', 'daemon', 'dist', 'index.js'));
  if (daemonBuilt) {
    const mcpContent = genMcpTools();
    writeFileSync(join(ROOT, 'docs', 'reference', 'mcp-tools.md'), mcpContent, 'utf8');
    console.log('  ✓ docs/reference/mcp-tools.md (generated)');
    updated++;
  } else {
    console.log('  ⚠ docs/reference/mcp-tools.md skipped (run pnpm build first)');
  }

  console.log(`\nDone. ${updated} document(s) updated.`);
}

function cmdValidate() {
  const issues = validateDocs();

  if (issues.length === 0) {
    console.log('✓ Documentation validation passed. No issues found.');
    process.exit(0);
  }

  console.log(`Found ${issues.length} issue(s):\n`);
  for (const issue of issues) {
    console.log(`  ${issue}`);
  }
  process.exit(1);
}

function cmdRegistry() {
  const registry = buildRegistry();
  writeFileSync(REGISTRY_PATH, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');

  console.log(`✓ Documentation registry rebuilt: ${registry.totalDocuments} documents.`);
  console.log(`  Path: ${REGISTRY_PATH}`);
}

function cmdIndex() {
  const registry = buildRegistry();
  const lines = [
    '# Documentation',
    '',
    '> Auto-generated documentation index.',
    `> Last updated: ${new Date().toISOString()}`,
    '',
  ];

  // Group by category
  const groups = {
    root: { title: 'Getting Started', docs: [] },
    tutorial: { title: 'Tutorial', docs: [] },
    'how-to': { title: 'How-To Guides', docs: [] },
    reference: { title: 'Reference', docs: [] },
    explanation: { title: 'Explanation', docs: [] },
    record: { title: 'Records', docs: [] },
    adr: { title: 'Architecture Decision Records', docs: [] },
    roadmap: { title: 'Roadmap', docs: [] },
    internal: { title: 'Internal (SDD History)', docs: [] },
  };

  for (const doc of registry.documents) {
    const group = groups[doc.category] || groups.internal;
    group.docs.push(doc);
  }

  for (const [_key, group] of Object.entries(groups)) {
    if (group.docs.length === 0) continue;
    lines.push(`## ${group.title}`);
    lines.push('');
    for (const doc of group.docs) {
      // Links from docs/README.md are relative — strip docs/ prefix
      const relativePath = doc.path.replace(/^docs\//, '');
      const archivedLabel = doc.lifecycle === 'archived' ? '[ARCHIVED] ' : '';
      const suffix = doc.category === 'root' ? ' — Project overview' : '';
      lines.push(`- [**${doc.title}**](${relativePath}) — ${archivedLabel}${suffix}`);
    }
    lines.push('');
  }

  writeFileSync(join(DOCS_DIR, 'README.md'), `${lines.join('\n')}\n`, 'utf8');
  console.log('✓ Documentation index generated: docs/README.md');
}

// ── Dispatch ───────────────────────────────────────────────────────

switch (command) {
  case 'generate':
    cmdGenerate();
    break;
  case 'validate':
    cmdValidate();
    break;
  case 'registry':
    cmdRegistry();
    break;
  case 'index':
    cmdIndex();
    break;
  default:
    console.error(USAGE);
    process.exit(1);
}
