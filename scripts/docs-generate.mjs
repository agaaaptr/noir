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

import { execFile, execFileSync } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DOCS_DIR = join(ROOT, 'docs');
const PACKAGES_DIR = join(ROOT, 'packages');
const SKILLS_BUILTIN = join(ROOT, 'packages', 'skills', 'builtin');
const SKILLS_INTEGRATIONS = join(ROOT, 'packages', 'skills', 'integrations');
const REGISTRY_PATH = join(ROOT, '.noir', 'docs-registry.json');

// ── Argument parsing ──────────────────────────────────────────────

const USAGE = 'Usage: node scripts/docs-generate.mjs <generate|validate|registry|index>';
const COMMANDS = ['generate', 'validate', 'registry', 'index'];

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

/**
 * Async sibling of `exec`. The CLI reference walk issues one help invocation
 * per command and overlaps them, which needs a non-blocking spawn —
 * `execFileSync` would serialize the event loop and erase the overlap.
 */
async function execAsync(cmd, args, opts = {}) {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: ROOT,
      timeout: 20_000,
      ...opts,
    });
    return stdout.trim();
  } catch (err) {
    if (opts.nullable) return '';
    throw err;
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

/** How many `node <built> --help` processes the walk keeps in flight at once. */
const CLI_HELP_CONCURRENCY = 8;

/** A command token may be an alias list (`install|migrate`); the first is canonical. */
function cliCommandName(token) {
  return token.split('|')[0];
}

/**
 * The lines of the blank-line-delimited block introduced by `header` (e.g.
 * `Commands:`, `Options:`). Commander separates Usage / description /
 * Arguments / Options / Commands / after-text with blank lines, so stopping at
 * the first blank line is what keeps hand-written after-text (command examples)
 * out of the parsed sections.
 */
function helpSection(help, header) {
  const lines = help.split('\n');
  const start = lines.indexOf(header);
  if (start === -1) return [];
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') break;
    body.push(lines[i]);
  }
  return body;
}

/** The `Usage:` line from a help page, without its prefix. */
function helpUsage(help) {
  const line = help.split('\n').find((l) => l.startsWith('Usage: '));
  return line ? line.slice('Usage: '.length).trim() : '';
}

/** The command's description block — the lines between Usage and the first section. */
function helpDescription(help) {
  const lines = help.split('\n');
  const start = lines.findIndex((l) => l.startsWith('Usage: '));
  if (start === -1) return '';
  const parts = [];
  for (let i = start + 2; i < lines.length; i++) {
    if (lines[i].trim() === '') break;
    parts.push(lines[i].trim());
  }
  return parts.join(' ');
}

/**
 * Command tokens from a help page's `Commands:` block, in commander
 * registration order (the order the CLI registers them, which the help prints
 * verbatim). A command entry is indented exactly two spaces; the wrapped
 * remainder of a long description is indented to the description column, so the
 * two-space test separates entries from their own continuations.
 */
function helpCommands(help) {
  const tokens = [];
  for (const line of helpSection(help, 'Commands:')) {
    const entry = line.match(/^ {2}(\S.*)$/);
    if (!entry) continue;
    tokens.push(entry[1].split(/\s+/)[0]);
  }
  return tokens;
}

/**
 * Options from a help page's `Options:` block. Commander pads the flag column
 * and separates it from the description by at least two spaces, so each entry
 * splits at the first run of two-or-more spaces (never inside a flag, whose own
 * space separates `--flag` from its `<value>` placeholder). Wrapped description
 * lines are joined back into one cell. The built-in help/version flags are
 * dropped — this table documents the command's own flags.
 */
function helpOptions(help) {
  const options = [];
  for (const line of helpSection(help, 'Options:')) {
    const entry = line.match(/^ {2}(\S.*)$/);
    if (!entry) {
      // Wrapped description of the previous entry.
      if (options.length > 0) {
        options[options.length - 1].description += ` ${line.trim()}`;
      }
      continue;
    }
    const split = entry[1].search(/\s{2,}/);
    options.push({
      flag: (split === -1 ? entry[1] : entry[1].slice(0, split)).trim(),
      description: split === -1 ? '' : entry[1].slice(split).trim(),
    });
  }
  return options.filter(
    (o) => !/^(-h, )?--help$/.test(o.flag) && !/^(-V, )?--version$/.test(o.flag),
  );
}

/**
 * Bounded-concurrency `--help` runner. Commander documents a subcommand's flags
 * only under that subcommand's own help, so each command needs its own process;
 * the bound keeps the walk from spawning one process per sibling at a level.
 */
function createCliHelpRunner(built) {
  let inFlight = 0;
  const waiting = [];
  const stats = { invocations: 0 };

  const run = async (path) => {
    if (inFlight >= CLI_HELP_CONCURRENCY) {
      await new Promise((resolve) => waiting.push(resolve));
    }
    inFlight++;
    stats.invocations++;
    try {
      return await execAsync('node', [built, ...path, '--help'], { nullable: true });
    } finally {
      inFlight--;
      const next = waiting.shift();
      if (next) next();
    }
  };

  return { run, stats };
}

/**
 * Walk the command tree depth-first in registration order, reading each
 * command's own help. A level's help reads are launched together (bounded by
 * the runner) but consumed in order, so a group's children are rendered
 * directly after the group regardless of which process finishes first. A
 * command whose help cannot be read is recorded in place with a placeholder
 * rather than failing the whole run.
 */
async function walkCliCommands(path, tokens, sections, seen, run) {
  const pending = tokens.map((token) => run([...path, cliCommandName(token)]));

  for (let i = 0; i < tokens.length; i++) {
    const fullPath = [...path, cliCommandName(tokens[i])];
    const key = fullPath.join(' ');
    if (seen.has(key)) continue;
    seen.add(key);

    const help = await pending[i];
    if (!help) {
      sections.push({ path: fullPath, unavailable: true });
      continue;
    }

    const subcommands = helpCommands(help);
    sections.push({
      path: fullPath,
      usage: helpUsage(help),
      description: helpDescription(help),
      options: helpOptions(help),
    });
    if (subcommands.length > 0) {
      await walkCliCommands(fullPath, subcommands, sections, seen, run);
    }
  }
}

/** A literal `|` would close a markdown table cell, so it is escaped in cell text. */
function escapeTableCell(value) {
  return value.replace(/\|/g, '\\|');
}

/** One section per command: its path, usage line, description, and own flags. */
function renderCliSection(section) {
  const out = [`### noir ${section.path.join(' ')}`, ''];

  if (section.unavailable) {
    out.push('_(help unavailable for this command)_', '');
    return out;
  }

  if (section.usage) out.push(`**Usage:** \`${section.usage}\``, '');
  if (section.description) out.push(section.description, '');
  if (section.options.length > 0) {
    out.push('| Flag | Description |');
    out.push('|---|---|');
    for (const option of section.options) {
      out.push(`| \`${option.flag}\` | ${escapeTableCell(option.description)} |`);
    }
    out.push('');
  }
  return out;
}

/**
 * The full CLI reference. The root help alone documents no subcommand flag —
 * commander prints those under `<command> --help` — so this walks the tree and
 * emits one section per command on top of the root block.
 */
async function genCliReference() {
  const built = join(ROOT, 'packages', 'cli', 'dist', 'bin.js');
  const notBuilt = '_(CLI not built — run `pnpm build` to generate CLI reference)_';
  const lines = [
    '# CLI Command Reference',
    '',
    '> Auto-generated from the built CLI: the root `noir --help`, then',
    '> `noir <command> --help` for every command in the tree.',
    '',
  ];

  if (!existsSync(built)) {
    lines.push(notBuilt);
    lines.push('');
    return { markdown: lines.join('\n'), invocations: 0 };
  }

  const { run, stats } = createCliHelpRunner(built);
  const mainHelp = await run([]);

  if (mainHelp) {
    lines.push('```');
    lines.push(mainHelp);
    lines.push('```');
  } else {
    lines.push(notBuilt);
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
  lines.push('| `--cwd <path>` | Working directory |');
  lines.push('| `--tui` / `--no-tui` | Advisory routing for bare `noir` |');
  lines.push('| `--no-tips` | Suppress hints on stderr |');
  lines.push('');
  lines.push('## Commands');
  lines.push('');

  if (mainHelp) {
    const sections = [];
    await walkCliCommands([], helpCommands(mainHelp), sections, new Set(), run);
    for (const section of sections) lines.push(...renderCliSection(section));
  } else {
    lines.push('_(Command help unavailable — run `pnpm build` first.)_');
    lines.push('');
  }

  return { markdown: lines.join('\n'), invocations: stats.invocations };
}

function genConfigSchema() {
  const lines = [
    '# Configuration Reference',
    '',
    '> Auto-generated from `NoirConfigSchema` (Zod v4) in `@noir-ai/core` — the',
    '> schema `.describe()` strings are the single source of truth for these rows.',
    '',
    '## Precedence',
    '',
    '**Environment variables** resolve in this order (highest first):',
    '',
    '```',
    '1. run profile env   run.profiles.<n>.env          (per-invocation; merges OVER)',
    '2. .noir/.env        <- recommended home for project-scoped configuration',
    '3. real environment  CI / container / launchd / shell rc',
    '4. built-in default',
    '```',
    '',
    '`.noir/.env` therefore **wins for every key it defines** — a machine-global',
    'export (`~/.zshrc`, `~/.claude/settings.json`, launchd, CI) cannot shadow it,',
    'and neither can a `VAR=value noir …` prefix (it arrives in `process.env`',
    'indistinguishably from the inherited environment, so it is level 3 — not an',
    'override). A git-*tracked* `.noir/.env` is refused outright, and `noir env`',
    'shows which source won for each key. Full chain + recipes:',
    '[Configuring a project with `.noir/.env`](../how-to/configure-env.md).',
    '',
    '**Config keys** (`.noir/config.yml`) resolve by their own order: CLI flag >',
    'environment variable (`NOIR_PROFILE`) > project `.noir/config.yml` >',
    'built-in default. Integration tokens (e.g. `CLICKUP_API_TOKEN`) are env',
    'vars, never config keys — see',
    '[Environment Variables](environment.md),',
    '[Run profiles](../how-to/host-profiles.md), and',
    '[ClickUp setup](../how-to/clickup.md).',
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
        // Reflect a field, descending into nested object fields so their keys
        // become their own rows (context.embedder.dim,
        // memory.consolidation.provider, workflow.gate.verify.required,
        // run.profiles.<name>, …). Three levels is the budget: the config
        // blocks users actually edit sit at most that deep, and stopping there
        // keeps z.record value shapes from expanding into noise. A record
        // value is reflected from its own depth instead (see the '<name>'
        // block below), so integrations.<name>.auth.tokenEnv is reached in
        // two.
        const describeField = (key, field, depth) => {
          // Zod v4: a wrapped field (optional/nullable/default) keeps its real
          // schema on _def.innerType; the type is a short string on _def.type
          // (e.g. "enum", "object", "string", "boolean") — NOT the v3 typeName.
          const inner = field?._def?.innerType || field?.unwrap?.() || field;
          const typeName = inner?._def?.type || field?._def?.type || 'unknown';
          const dv = field?._def?.defaultValue;
          let defaultValue;
          if (typeof dv === 'function') defaultValue = JSON.stringify(dv());
          else if (dv && typeof dv === 'object' && 'value' in dv) defaultValue = JSON.stringify(dv.value);
          else if (dv !== undefined) defaultValue = JSON.stringify(dv);
          result[key] = {
            type: typeName,
            required: !(field?.isOptional?.() ?? false),
            // This Zod version stores .describe() on the schema's top-level
            // description property, not _def.description — check both.
            description:
              inner?._def?.description ||
              inner?.description ||
              field?._def?.description ||
              field?.description ||
              '',
            default: defaultValue,
          };
          // Zod v4 records expose the per-key value schema as _def.valueType
          // (not valueSchema, which is the v3 name). The valueType carries the
          // record's element schema + its .describe(), so run.profiles.<name>,
          // integrations.<name>, and model.providers.<name> each get a row, and
          // an object-valued record also exposes its own fields (see below).
          // This runs at every depth, so a record nested inside a record value
          // is still reflected.
          const recSchema = inner?._def?.valueType;
          if (recSchema) {
            const recShape = recSchema?._def?.shape;
            const recDesc = recSchema?._def?.description || recSchema?.description || '';
            // Emit the '<name>' row only for records whose value is a real
            // named block (an object shape, or at least a description). A
            // scalar-valued record (run.profiles.<name>.env maps strings to
            // strings) has no per-key identity to document, so a '<name>' row
            // there would be pure noise.
            if ((recShape && typeof recShape === 'object') || recDesc) {
              result[key + '.<name>'] = {
                type: 'record value',
                required: true,
                description: recDesc,
                default: '—',
              };
            }
            // A record whose VALUE is an object (model.providers, run.profiles,
            // integrations) otherwise hides every real setting behind the single
            // '<name>' row. Reflect the value's own fields one level deep — the
            // same depth budget a plain object gets — so a provider block's
            // authTokenEnv / timeoutMs (and its siblings) reach the table
            // straight from their .describe(), with no hand-maintained list to
            // drift. Nested objects INSIDE the value stay one row (e.g.
            // integrations.<name>.auth), matching context.embedder.
            if (recShape && typeof recShape === 'object') {
              for (const [childKey, childField] of Object.entries(recShape)) {
                describeField(key + '.<name>.' + childKey, childField, 1);
              }
            }
          }
          if (depth < 3) {
            const objShape = inner?._def?.shape;
            if (objShape && typeof objShape === 'object') {
              for (const [childKey, childField] of Object.entries(objShape)) {
                describeField(key + '.' + childKey, childField, depth + 1);
              }
            }
          }
        };
        for (const [key, field] of Object.entries(shape)) {
          describeField(key, field, 0);
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
      // Group the flat dotted-key table by top-level section (host/name/mode are
      // "General"; every other key belongs to its top-level block: daemon, context,
      // model, memory, rules, prd, workflow, integrations, update, run).
      const rows = Object.entries(shape);
      const groups = new Map();
      for (const [key, info] of rows) {
        const top = key.split('.')[0];
        const isGeneral = ['host', 'name', 'mode'].includes(top);
        const bucket = isGeneral ? 'General' : top;
        if (!groups.has(bucket)) groups.set(bucket, []);
        groups.get(bucket).push([key, info]);
      }
      for (const [group, groupRows] of groups) {
        lines.push(`### ${group}`);
        lines.push('');
        lines.push('| Field | Type | Required | Default | Description |');
        lines.push('|---|---|---|---|---|');
        for (const [key, info] of groupRows) {
          lines.push(
            `| \`${key}\` | \`${info.type}\` | ${info.required ? 'yes' : 'no'} | ${info.default || '—'} | ${info.description} |`,
          );
        }
        lines.push('');
      }
    }
  } catch {
    lines.push('_(Config schema unavailable — build packages first with `pnpm build`)_');
  }

  lines.push('');
  lines.push('## Conditional requirements');
  lines.push('');
  lines.push(
    '- `model.providers.<name>.apiKeyEnv` — required only when the provider is remote',
    '  (anonymous local providers like Ollama omit it).',
    '- `integrations.<name>.{teamId,listId,spaceId}` — required only when the matching',
    '  ClickUp flow needs workspace binding (see [ClickUp setup](../how-to/clickup.md)).',
    '- `context.embedder.provider` / `context.embedder.model` / `context.embedder.baseURL` —',
    '  `provider` is only meaningful when `kind` is `remote`; `baseURL` when `kind` is',
    '  `ollama`; `model` applies to all three (a HuggingFace repo id for `local`).',
    '- `memory.consolidation.*` — only meaningful when `memory.consolidation.enabled` is true.',
  );
  lines.push('');
  lines.push('## Secrets policy');
  lines.push('');
  // Assembled from parts: biome's `noTemplateCurlyInString` rule flags a literal
  // dollar-brace inside a string, and the rendered reference has to show the
  // WRONG `apiKeyEnv` form verbatim for the trap to be recognizable.
  const brace = '$' + '{';
  lines.push(
    '`.noir/config.yml` is **committable project state** — never paste a token value into it.',
    '`apiKeyEnv` stores a variable **NAME**, never an interpolation — write',
    `\`apiKeyEnv: ANTHROPIC_API_KEY\`, never \`apiKeyEnv: ${brace}ANTHROPIC_API_KEY}\`. The`,
    'same rule covers `authTokenEnv`: a NAME, never the bearer-token value. The',
    'model layer reads `process.env[<that name>]`, so the dollar-brace form resolves to',
    '`undefined` and silently disables the provider. Only `run.profiles.<name>.env`',
    'interpolates a dollar-brace reference. Put the **value** in `.noir/.env` — the',
    'recommended project-scoped home, `0600` and gitignored, and the winner for every key',
    'it defines — or in the real environment. Never pass tokens as CLI arguments (visible',
    'in process lists). See',
    '[Configuring a project with `.noir/.env`](../how-to/configure-env.md) and',
    '[Environment Variables](environment.md) for the full placement + precedence rules.',
  );
  lines.push('');
  lines.push('## Honest notes');
  lines.push('');
  lines.push(
    '- `update.display`, `context.roots`, and `context.budgetTokens`',
    '  are parsed + validated but have no live consumer yet — declaring them now avoids',
    '  schema churn when their feature ships. Do not rely on them.',
    '- `rules.enabled` IS read: when false, `noir init`/`noir create` emit no',
    '  `.noir/rules/RULES.md` (and an upgrade does not backfill one) and `noir doctor`',
    '  reports its budget check as disabled. A RULES.md already on disk is left alone.',
    "- `rules.lengthBudgetKb` IS read: `noir doctor`'s RULES.md budget check.",
    '- `run.*` (host profiles; first surfaced on `beta` as 1.12.0-beta.1) and `workspace.*` (shared cross-repo workspaces, see the [shared-workspaces decision](../decisions/0009-shared-workspaces.md)) are new in 1.13.0. All other blocks predate 1.13.0.',
  );
  lines.push('');
  return lines.join('\n');
}

function genSkillsTable() {
  const lines = [
    '# Builtin Skills',
    '',
    '> Auto-generated from `packages/skills/builtin/*/SKILL.md` and `packages/skills/integrations/*/SKILL.md`.',
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
    `**${skills.length} skills** (${skills.filter((s) => s.type === 'builtin').length} builtins + ${skills.filter((s) => s.type === 'integration').length} integration${skills.filter((s) => s.type === 'integration').length === 1 ? '' : 's'})`,
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
        // Find the description in the options object following the name. Match a
        // full JS string literal (quote-aware) so a description CONTAINING the
        // other quote char (e.g. "Pass {integration:'noir-clickup'}") is captured
        // whole instead of truncated at the first inner quote. Handles single-,
        // double-quoted and template literals, to end-of-line for multi-line
        // single-line strings.
        const afterName = content.slice(m.index + m[0].length, m.index + m[0].length + 2000);
        const descMatch =
          afterName.match(
            /description:\s*(?:'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)")/,
          ) ?? null;
        const desc = descMatch ? (descMatch[1] ?? descMatch[2] ?? '') : '';

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

// ── Document registry ──────────────────────────────────────────────

/**
 * In-flight internal docs (specified/planned, not yet shipped). These stay
 * `active` in the index so a reader is not told the current design doc is
 * history; every other file under docs/internal/ is SDD history and is labelled
 * `[ARCHIVED]`. The status blockquotes inside those files are free-form and go
 * stale (a shipped spec keeps its "not implemented" line), so the marker is this
 * explicit list. Clear an entry when its release ships.
 */
const IN_FLIGHT_INTERNAL = new Set([]);

/**
 * A reference-doc stub line: the generators write an explicit italic
 * parenthetical when the source they read is missing (`_(CLI not built — run
 * \`pnpm build\` to generate CLI reference)_`, `_(… unavailable …)_`). A line
 * that is entirely one of these, inside `docs/reference/`, means a generation
 * step was skipped and the committed reference is half-generated.
 */
const GENERATED_PLACEHOLDER_RE = /^_\([^)]*(?:unavailable|not built)[^)]*\)_\s*$/;

/**
 * Stub lines left in the generated reference docs. Pure (takes the docs, not the
 * filesystem) so the gate's behaviour is pinned by an offline test — the full
 * {@link validateDocs} run also shells out to `npm view`.
 *
 * @param {{ path: string, content: string }[]} docs - repo-relative path + bytes.
 * @returns {string[]} one issue string per stub line found.
 */
export function findGeneratedPlaceholders(docs) {
  const issues = [];
  for (const doc of docs) {
    if (!doc.path.startsWith('docs/reference/') || !doc.path.endsWith('.md')) continue;
    const lines = doc.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (GENERATED_PLACEHOLDER_RE.test(line)) {
        issues.push(
          `[GENERATED-PLACEHOLDER] ${doc.path}:${i + 1}: reference stub "${line}" — regenerate with \`pnpm docs:generate\`.`,
        );
      }
    }
  }
  return issues;
}

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

      // Determine lifecycle: docs/internal/ is SDD history except for the
      // current in-flight spec/plan pair (see IN_FLIGHT_INTERNAL above).
      let lifecycle = 'active';
      if (relPath.startsWith('docs/internal/') && !IN_FLIGHT_INTERNAL.has(relPath))
        lifecycle = 'archived';

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

/**
 * The whole docs registry (every doc + its category/lifecycle). Pure file reads,
 * so it is exported for the offline lifecycle test as well as used by
 * `docs:registry` + `docs:index`.
 */
export function buildRegistry() {
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

  // github-slugger heading-slug replica (what GitHub's rendered anchors use):
  // lowercase → strip punctuation/non-word chars (keeps `_`, `-`, space) → trim
  // → each SPACE becomes a hyphen with NO collapsing (so `A & B` → `a--b`).
  // This is what lets docs:validate catch broken anchors, not just broken files.
  function ghSlug(value) {
    return value
      .toLowerCase()
      .replace(/[^\w\- ]/g, '')
      .trim()
      .replace(/ /g, '-');
  }

  // Cache of every ATX heading slug per doc (relPath → Set of slugs).
  const headingSlugCache = new Map();
  function getHeadingSlugs(relPath) {
    if (headingSlugCache.has(relPath)) return headingSlugCache.get(relPath);
    const slugs = new Set();
    const content = readFile(join(ROOT, relPath));
    if (content) {
      // Skip fenced code blocks: a shell `# comment` or markdown example inside
      // ``` fences must not be mistaken for a real ATX heading.
      let inFence = false;
      for (const line of content.split('\n')) {
        if (/^\s*(```|~~~)/.test(line)) {
          inFence = !inFence;
          continue;
        }
        if (inFence) continue;
        const m = line.match(/^#{1,6}[ \t]+(.+?)[ \t]*$/);
        if (m) slugs.add(ghSlug(m[1]));
      }
    }
    headingSlugCache.set(relPath, slugs);
    return slugs;
  }

  for (const file of allMd) {
    const content = readFile(file.path);
    if (!content) continue;

    // Find markdown links: [text](path)
    const linkRe = /\[([^\]]*)\]\(([^)]+)\)/g;
    const matches = [...content.matchAll(linkRe)];
    for (const match of matches) {
      const linkTarget = match[2];
      // Skip external URLs
      if (linkTarget.startsWith('http://') || linkTarget.startsWith('https://')) continue;

      // In-page anchor (`#fragment`) — target is THIS file.
      if (linkTarget.startsWith('#')) {
        const fragment = linkTarget.slice(1);
        if (fragment && !getHeadingSlugs(file.relPath).has(fragment)) {
          issues.push(
            `[BROKEN-ANCHOR] ${file.relPath}: anchor "#${fragment}" not found in this file.`,
          );
        }
        continue;
      }

      // Resolve relative link, normalizing ./ and ../ but preserving .md extensions
      const fileDir = dirname(file.relPath);
      let resolved = join(fileDir, linkTarget);
      // Strip leading ./ segments only (preserve file extensions)
      resolved = resolved.replace(/(^|\/)\.\//g, '$1');

      // Split the fragment (if any) from the file path.
      const hashIdx = resolved.indexOf('#');
      const cleanTarget = hashIdx >= 0 ? resolved.slice(0, hashIdx) : resolved;
      const fragment = hashIdx >= 0 ? resolved.slice(hashIdx + 1) : '';

      // Check if the file exists.
      if (cleanTarget && !docPaths.has(cleanTarget) && !existsSync(join(ROOT, cleanTarget))) {
        issues.push(
          `[BROKEN-LINK] ${file.relPath}: link to "${linkTarget}" (resolved: ${cleanTarget}) not found.`,
        );
        continue;
      }
      // Check the fragment resolves to a real heading in the target doc.
      if (
        fragment &&
        cleanTarget &&
        docPaths.has(cleanTarget) &&
        !getHeadingSlugs(cleanTarget).has(fragment)
      ) {
        issues.push(
          `[BROKEN-ANCHOR] ${file.relPath}: anchor "#${fragment}" not found in ${cleanTarget}.`,
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

  // 2. Every committed reference doc must be fully generated. A generator that
  // cannot read its source build artefact writes an explicit placeholder instead
  // of failing, so a placeholder that reached docs/reference/ means a generation
  // step was skipped and the reference is a stub. The gate fails on it rather
  // than shipping a half-generated reference.
  issues.push(
    ...findGeneratedPlaceholders(
      findDocs()
        .filter((d) => d.path.startsWith('docs/reference/') && d.path.endsWith('.md'))
        .map((d) => ({ path: d.path, content: readFile(join(ROOT, d.path)) || '' })),
    ),
  );

  // 3. Check npm dist-tags match what docs claim
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

async function cmdGenerate() {
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
    const { markdown, invocations } = await genCliReference();
    writeFileSync(join(ROOT, 'docs', 'reference', 'cli.md'), markdown, 'utf8');
    console.log(`  ✓ docs/reference/cli.md (generated; ${invocations} help invocations)`);
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

  // Regenerate the docs/README.md index too (previously a separate `docs:index`
  // command that drifted — fold it in so `docs:generate` keeps it fresh).
  cmdIndex();

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
      // Links from docs/README.md are relative — strip docs/ prefix. A document
      // that lives outside docs/ (the root README) is one level up instead; the
      // bare path would resolve back to docs/README.md itself, a self-link.
      const isOutsideDocs = !doc.path.startsWith('docs/');
      const relativePath = isOutsideDocs ? `../${doc.path}` : doc.path.replace(/^docs\//, '');
      // Build the suffix from its parts so an archived label never trails a bare
      // space when it is the only part (the old `'[ARCHIVED] '` + `''` join).
      const parts = [];
      if (doc.lifecycle === 'archived') parts.push('[ARCHIVED]');
      if (doc.category === 'root') parts.push('Project overview');
      const suffix = parts.join(' ');
      lines.push(`- [**${doc.title}**](${relativePath}) — ${suffix}`);
    }
    lines.push('');
  }

  writeFileSync(join(DOCS_DIR, 'README.md'), `${lines.join('\n')}\n`, 'utf8');
  console.log('✓ Documentation index generated: docs/README.md');
}

// ── Dispatch ───────────────────────────────────────────────────────

/**
 * True when this module is the Node entry point
 * (`node scripts/docs-generate.mjs <cmd>`). When imported as a module — the
 * test suite does — the CLI dispatch + `process.exit` paths are skipped so the
 * generators and help parsers below are testable. Resolves symlinks.
 */
function isMainModule() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const command = process.argv[2];
  if (!command || !COMMANDS.includes(command)) {
    console.error(USAGE);
    process.exit(1);
  }

  switch (command) {
    case 'generate':
      await cmdGenerate();
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
  }
}

export { genCliReference, genConfigSchema, helpCommands, helpDescription, helpOptions, helpUsage };
