#!/usr/bin/env node
// Release registry manager for Noir.
//
// Manages `.noir/releases/releases.json` (machine-readable) and
// `.noir/releases/releases.md` (human-readable). The npm registry
// is the authoritative source — git tags are cross-referenced for
// metadata enrichment only.
//
// Commands:
//   add       — Record a release entry (called from CI after publish).
//   rebuild   — Full rebuild from npm + git tags (recovery mechanism).
//   validate  — Check registry integrity against npm + git tags.
//   history   — Print formatted release history to stdout.
//
// Usage:
//   node scripts/release-registry.mjs add
//     Environment: FULL_VERSION CHANNEL BASE_VERSION DIST_TAG GIT_TAG
//                  GIT_SHA GIT_BRANCH
//   node scripts/release-registry.mjs rebuild
//   node scripts/release-registry.mjs validate [--quiet]
//   node scripts/release-registry.mjs history

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const RELEASES_DIR = join(ROOT, '.noir', 'releases');
const JSON_PATH = join(RELEASES_DIR, 'releases.json');
const MD_PATH = join(RELEASES_DIR, 'releases.md');

// ── Argument parsing ──────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];
const QUIET = args.includes('--quiet');

/**
 * True when this module is the Node entry point (`node scripts/release-registry.mjs …`).
 * When imported as a module (e.g. by the offline test), the CLI dispatch +
 * `process.exit` paths are skipped so the pure helpers below are testable.
 * Resolves symlinks (`node` may invoke via a realpath'd script path on some platforms).
 */
function isMainModule() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

function usage() {
  console.error('Usage: node scripts/release-registry.mjs <command>');
  console.error('Commands: add | rebuild | validate [--quiet] | history');
  process.exit(1);
}

if (isMainModule() && (!command || !['add', 'rebuild', 'validate', 'history'].includes(command))) {
  usage();
}

// ── Helpers ────────────────────────────────────────────────────────

function git(args_) {
  try {
    return execFileSync('git', args_, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

function npmView(args_) {
  return JSON.parse(
    execFileSync('npm', ['view', ...args_, '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    }).trim(),
  );
}

function npmViewNullable(args_) {
  try {
    return npmView(args_);
  } catch {
    return null;
  }
}

/** Parse "2026-07-28T10:30:00.000Z" or npm time format */
function parseNpmTime(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Extract beta iteration from version string: "1.4.0-beta.3" → 3 */
function betaIteration(version) {
  const match = version.match(/^\d+\.\d+\.\d+-beta\.(\d+)$/);
  return match ? parseInt(match[1], 10) : null;
}

/** Extract base version: "1.4.0-beta.3" → "1.4.0", "1.4.0" → "1.4.0" */
function baseVersion(version) {
  const match = version.match(/^(\d+\.\d+\.\d+)/);
  return match ? match[1] : version;
}

/**
 * Build the GitHub-generated anchor for a CHANGELOG.md version heading.
 *
 * CHANGELOG headings follow the style `## <version> (<YYYY-MM-DD>)` (verified
 * against the actual headings — see `packages/cli/test/release-registry.test.ts`).
 * GitHub derives heading anchors by: downcasing → stripping everything that
 * isn't [a-z0-9 -] → spaces to hyphens. Applied to `1.4.0-beta.1 (2026-07-27)`
 * that yields `140-beta1-2026-07-27`. We can't reproduce that from the version
 * alone, so the publish date (YYYY-MM-DD) is required.
 *
 * When the date is unknown (null/empty/unparseable), we fall back to the
 * version-only core (`140-beta1`) — still a useful human identifier even though
 * it won't auto-resolve on github.com.
 *
 * Examples:
 *   anchorFor('1.6.0',        '2026-07-28')           → '160-2026-07-28'
 *   anchorFor('1.4.0-beta.1', '2026-07-27T00:30:23Z') → '140-beta1-2026-07-27'
 *   anchorFor('1.4.0-beta.1', null)                   → '140-beta1'
 */
function anchorFor(version, dateStr) {
  // Version core: strip everything that isn't alphanumeric or hyphen.
  // `1.6.0` → `160`; `1.4.0-beta.1` → `140-beta1` (the dot inside the
  // prerelease is stripped, the hyphen is kept).
  const versionCore = version.toLowerCase().replace(/[^a-z0-9-]/g, '');

  // Date core: accept a full ISO timestamp OR a bare YYYY-MM-DD; emit YYYY-MM-DD.
  let dateCore = '';
  if (dateStr) {
    const d = new Date(dateStr);
    if (!Number.isNaN(d.getTime())) {
      dateCore = d.toISOString().slice(0, 10); // YYYY-MM-DD
    }
  }

  return dateCore ? `${versionCore}-${dateCore}` : versionCore;
}

/**
 * Build the canonical CHANGELOG.md deep link for a release.
 * `main` is the only branch that carries published CHANGELOG rows.
 */
function changelogRefFor(version, dateStr) {
  return `https://github.com/agaaaptr/noir/blob/main/CHANGELOG.md#${anchorFor(version, dateStr)}`;
}

/** SemVer sort: prerelease < release, numeric comparison */
function semverCompare(a, b) {
  const parse = (v) => {
    const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z]+)\.(\d+))?$/);
    if (!m) return { major: 0, minor: 0, patch: 0, preId: null, preNum: 0 };
    return {
      major: parseInt(m[1], 10),
      minor: parseInt(m[2], 10),
      patch: parseInt(m[3], 10),
      preId: m[4] || null,
      preNum: m[5] ? parseInt(m[5], 10) : 0,
    };
  };
  const pa = parse(a);
  const pb = parse(b);

  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pb[key] - pa[key];
  }
  // Both are same core version — prerelease comes AFTER non-prerelease
  if (!pa.preId && !pb.preId) return 0;
  if (!pa.preId) return -1; // a is release, should come first
  if (!pb.preId) return 1; // b is release, should come first
  return pb.preNum - pa.preNum;
}

// ── Data collection (shared across commands) ──────────────────────

/** Get all versions published on npm for @noir-ai/cli */
function getNpmVersions() {
  const versions = npmViewNullable(['@noir-ai/cli', 'versions']);
  if (!versions || !Array.isArray(versions)) return [];
  return versions;
}

/** Get npm dist-tags */
function getNpmDistTags() {
  return npmViewNullable(['@noir-ai/cli', 'dist-tags']) || {};
}

/** Get npm publish timestamps */
function getNpmTime() {
  return npmViewNullable(['@noir-ai/cli', 'time']) || {};
}

/** Get all git tags matching v* with their commit SHAs */
function getGitTags() {
  const output = git([
    'tag',
    '-l',
    'v*',
    '--format=%(refname:strip=2) %(objectname:short) %(creatordate:iso-strict)',
  ]);
  if (!output) return [];
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(' ');
      return {
        name: parts[0] || '',
        sha: parts[1] || '',
        date: parts.slice(2).join(' ') || '',
      };
    });
}

/**
 * Build the complete release entry for one version.
 * Enriches npm data with git metadata where available.
 *
 * channel + npmDistTag are derived from the version's TYPE (stable vs
 * prerelease), NOT from an npm dist-tags lookup — the dist-tags pointer is a
 * moving target (it advances on every publish) and historically mislabeled
 * already-shipped stable releases as `beta` (1.4.0/1.5.0 were tagged `latest`
 * on npm but the old `distTags.latest === version` check left them `beta` in
 * the registry). The version string is the immutable source of truth.
 */
function buildEntry(version, _distTags, timeData, gitTagMap) {
  const baseVer = baseVersion(version);
  const isStable = !version.includes('-');
  const preId = isStable ? null : 'beta';
  const betaIt = isStable ? null : betaIteration(version);

  // Derive channel + dist-tag from the type (immutable), not distTags.
  const channel = isStable ? 'stable' : 'beta';
  const distTag = isStable ? 'latest' : 'beta';

  // Git metadata
  const gitTagName = `v${version}`;
  const gitInfo = gitTagMap[gitTagName] || gitTagMap[version] || null;

  // Timestamp from npm
  const timestamp = timeData[version] ? parseNpmTime(timeData[version]) : null;

  // Build the entry
  return {
    baseVersion: baseVer,
    fullVersion: version,
    prereleaseIdentifier: preId,
    betaIteration: betaIt,
    type: isStable ? 'stable' : 'prerelease',
    channel,
    npmDistTag: distTag,
    gitTag: gitInfo ? `v${version}` : null,
    gitSha: gitInfo?.sha || null,
    gitBranch: null, // we cannot reliably determine this from tags alone
    timestamp,
    publishStatus: 'published',
    changelogRef: changelogRefFor(version, timestamp),
  };
}

/** Full data structure: collect ALL releases from npm + cross-ref git */
function collectReleases() {
  const versions = getNpmVersions();
  const distTags = getNpmDistTags();
  const timeData = getNpmTime();
  const gitTags = getGitTags();

  // Map git tags by name for O(1) lookup
  const gitTagMap = {};
  for (const tag of gitTags) {
    gitTagMap[tag.name] = tag;
  }

  const releases = versions.map((v) => buildEntry(v, distTags, timeData, gitTagMap));
  releases.sort((a, b) => semverCompare(a.fullVersion, b.fullVersion));

  return { releases, distTags, versions };
}

// ── Current state helpers ──────────────────────────────────────────

function computeCurrentState(releases) {
  const stableReleases = releases.filter((r) => r.type === 'stable');
  const betaReleases = releases.filter((r) => r.type === 'prerelease');

  // Read base version from source (always strip prerelease suffix —
  // the source may still have a beta suffix before migration, but the
  // "base" is always the clean X.Y.Z core).
  let currentBase = 'unknown';
  try {
    const cliPkg = JSON.parse(readFileSync(join(ROOT, 'packages', 'cli', 'package.json'), 'utf8'));
    currentBase = baseVersion(cliPkg.version);
  } catch {
    /* ignore */
  }

  const latestStable = stableReleases.length > 0 ? stableReleases[0].fullVersion : null;
  const latestBeta = betaReleases.length > 0 ? betaReleases[0].fullVersion : null;

  // Compute next beta for current base
  let nextBeta = null;
  const basePrefix = `${currentBase}-beta.`;
  const matchingBetas = betaReleases
    .filter((r) => r.fullVersion.startsWith(basePrefix))
    .map((r) => r.betaIteration)
    .filter((n) => n !== null);
  if (matchingBetas.length > 0) {
    nextBeta = `${currentBase}-beta.${Math.max(...matchingBetas) + 1}`;
  } else if (currentBase !== 'unknown') {
    nextBeta = `${currentBase}-beta.1`;
  }

  return { currentBase, latestStable, latestBeta, nextBeta };
}

// ── Generate releases.json ─────────────────────────────────────────

function generateJson(releases) {
  const state = computeCurrentState(releases);
  return {
    $schema:
      'https://raw.githubusercontent.com/agaaaptr/noir/main/schemas/release-registry.schema.json',
    generated: new Date().toISOString(),
    source: 'npm',
    currentBaseVersion: state.currentBase,
    latestStable: state.latestStable,
    latestBeta: state.latestBeta,
    nextBeta: state.nextBeta,
    releases,
  };
}

// ── Generate releases.md ───────────────────────────────────────────

function generateMd(releases) {
  const state = computeCurrentState(releases);
  const stableReleases = releases.filter((r) => r.type === 'stable');
  const betaReleases = releases.filter((r) => r.type === 'prerelease');

  const lines = [];
  lines.push('# Noir Release Registry');
  lines.push('');
  lines.push('> Auto-generated on every successful release from npm registry + git tags.');
  lines.push(`> Last updated: ${new Date().toISOString()}`);
  lines.push('');

  // Current state
  lines.push('## Current');
  lines.push('');
  lines.push(`- **Base Version:** \`${state.currentBase}\``);
  lines.push(`- **Latest Stable:** \`${state.latestStable || 'none'}\``);
  lines.push(`- **Latest Beta:** \`${state.latestBeta || 'none'}\``);
  lines.push(`- **Next Beta:** \`${state.nextBeta || 'N/A'}\``);
  lines.push('');

  // Stable releases
  lines.push('## Stable Releases');
  lines.push('');
  if (stableReleases.length > 0) {
    lines.push('| Version | Date | Git Tag | Commit |');
    lines.push('|---|---|---|---|');
    for (const r of stableReleases) {
      const date = r.timestamp ? new Date(r.timestamp).toISOString().slice(0, 10) : '—';
      const tag = r.gitTag || '—';
      const sha = r.gitSha || '—';
      lines.push(`| ${r.fullVersion} | ${date} | ${tag} | ${sha} |`);
    }
  } else {
    lines.push('_No stable releases yet._');
  }
  lines.push('');

  // Beta releases
  lines.push('## Beta Releases');
  lines.push('');
  if (betaReleases.length > 0) {
    lines.push('| Version | Base | Iteration | Date | Git Tag | Commit |');
    lines.push('|---|---|---|---|---|---|');
    for (const r of betaReleases) {
      const date = r.timestamp ? new Date(r.timestamp).toISOString().slice(0, 10) : '—';
      const tag = r.gitTag || '—';
      const sha = r.gitSha || '—';
      lines.push(
        `| ${r.fullVersion} | ${r.baseVersion} | ${r.betaIteration ?? '—'} | ${date} | ${tag} | ${sha} |`,
      );
    }
  } else {
    lines.push('_No beta releases yet._');
  }
  lines.push('');

  return `${lines.join('\n')}\n`;
}

// ── Validation ─────────────────────────────────────────────────────

function validate(releases) {
  const issues = [];

  // Check for duplicate entries
  const seen = new Set();
  for (const r of releases) {
    if (seen.has(r.fullVersion)) {
      issues.push(`[DUPLICATE] version ${r.fullVersion} appears more than once.`);
    }
    seen.add(r.fullVersion);
  }

  // Check semver ordering
  for (let i = 1; i < releases.length; i++) {
    const cmp = semverCompare(releases[i - 1].fullVersion, releases[i].fullVersion);
    if (cmp > 0) {
      issues.push(
        `[ORDER] ${releases[i - 1].fullVersion} before ${releases[i].fullVersion} — wrong sort order.`,
      );
    }
  }

  // Cross-check with npm
  const npmVersions = getNpmVersions();
  if (npmVersions.length > 0) {
    const registryVersions = new Set(releases.map((r) => r.fullVersion));
    for (const v of npmVersions) {
      if (!registryVersions.has(v)) {
        issues.push(`[MISSING] npm has ${v} but registry does not.`);
      }
    }
    for (const r of releases) {
      if (!npmVersions.includes(r.fullVersion)) {
        issues.push(`[ORPHAN] registry has ${r.fullVersion} but npm does not.`);
      }
    }
  }

  // Check dist-tag consistency
  const distTags = getNpmDistTags();
  if (distTags.latest) {
    const latestEntry = releases.find((r) => r.fullVersion === distTags.latest);
    if (latestEntry && latestEntry.type !== 'stable') {
      issues.push(
        `[DIST-TAG] npm latest=${distTags.latest} but registry says type=${latestEntry.type}.`,
      );
    }
  }
  if (distTags.beta) {
    const betaEntry = releases.find((r) => r.fullVersion === distTags.beta);
    if (betaEntry && betaEntry.type !== 'prerelease') {
      issues.push(`[DIST-TAG] npm beta=${distTags.beta} but registry says type=${betaEntry.type}.`);
    }
  }

  // Check prerelease numbering is sequential per base version
  const byBase = {};
  for (const r of releases) {
    if (r.type !== 'prerelease') continue;
    if (!byBase[r.baseVersion]) byBase[r.baseVersion] = [];
    byBase[r.baseVersion].push(r);
  }
  for (const [base, entries] of Object.entries(byBase)) {
    const iterations = entries
      .map((e) => e.betaIteration)
      .filter((n) => n !== null)
      .sort((a, b) => a - b);
    for (let i = 1; i < iterations.length; i++) {
      if (iterations[i] !== iterations[i - 1] + 1) {
        issues.push(
          `[GAP] ${base} beta iterations jump from ${iterations[i - 1]} to ${iterations[i]} (gap detected).`,
        );
      }
    }
  }

  return issues;
}

// ── Commands ───────────────────────────────────────────────────────

async function cmdAdd() {
  const version = process.env.FULL_VERSION;
  const channel = process.env.CHANNEL;
  const baseVer = process.env.BASE_VERSION;
  const distTag = process.env.DIST_TAG;
  const gitTag = process.env.GIT_TAG;
  const gitSha = process.env.GIT_SHA;
  const gitBranch = process.env.GIT_BRANCH;

  if (!version || !channel) {
    console.error('Error: FULL_VERSION and CHANNEL environment variables are required.');
    console.error('This command is designed to be called from CI (release.yml).');
    process.exit(1);
  }

  // Read existing registry or initialize
  let data;
  if (existsSync(JSON_PATH)) {
    try {
      data = JSON.parse(readFileSync(JSON_PATH, 'utf8'));
    } catch {
      console.error('Warning: existing releases.json is corrupt. Starting fresh.');
      data = { releases: [] };
    }
  } else {
    data = { releases: [] };
  }

  const isStable = channel === 'stable';

  // Derive channel + npmDistTag from the type (immutable), identical to
  // buildEntry(). The env-supplied CHANNEL/DIST_TAG must agree with the
  // version string — a `vX.Y.Z` tag is always stable/latest, a `-beta.N`
  // suffix is always beta/beta — so we normalize to the type-derived values
  // (the env values are kept only as a fallback for malformed inputs).
  const derivedChannel = isStable ? 'stable' : 'beta';
  const derivedDistTag = isStable ? 'latest' : 'beta';

  // Remove existing entry for this version (idempotent) and add new one
  data.releases = data.releases.filter((r) => r.fullVersion !== version);

  const now = new Date().toISOString();

  const entry = {
    baseVersion: baseVer || baseVersion(version),
    fullVersion: version,
    prereleaseIdentifier: isStable ? null : 'beta',
    betaIteration: isStable ? null : betaIteration(version),
    type: isStable ? 'stable' : 'prerelease',
    channel: derivedChannel,
    npmDistTag: distTag || derivedDistTag,
    gitTag: gitTag || null,
    gitSha: gitSha || null,
    gitBranch: gitBranch || null,
    timestamp: now,
    publishStatus: 'published',
    changelogRef: changelogRefFor(version, now),
  };

  data.releases.push(entry);
  data.releases.sort((a, b) => semverCompare(a.fullVersion, b.fullVersion));

  // Update top-level metadata
  const state = computeCurrentState(data.releases);
  data.currentBaseVersion = state.currentBase;
  data.latestStable = state.latestStable;
  data.latestBeta = state.latestBeta;
  data.nextBeta = state.nextBeta;
  data.generated = new Date().toISOString();

  // Write
  mkdirSync(RELEASES_DIR, { recursive: true });
  writeFileSync(JSON_PATH, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  writeFileSync(MD_PATH, generateMd(data.releases), 'utf8');

  console.error(`✓ Release registry updated: ${version}`);
  console.error(`  JSON: ${JSON_PATH}`);
  console.error(`  MD:   ${MD_PATH}`);
}

function cmdRebuild() {
  const { releases } = collectReleases();

  const data = generateJson(releases);

  mkdirSync(RELEASES_DIR, { recursive: true });
  writeFileSync(JSON_PATH, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  writeFileSync(MD_PATH, generateMd(releases), 'utf8');

  console.error(`✓ Release registry rebuilt from npm + git tags.`);
  console.error(`  ${releases.length} releases recorded.`);
  console.error(`  JSON: ${JSON_PATH}`);
  console.error(`  MD:   ${MD_PATH}`);
}

function cmdValidate() {
  let data;
  if (!existsSync(JSON_PATH)) {
    console.error('Error: releases.json not found. Run "rebuild" first.');
    process.exit(1);
  }

  try {
    data = JSON.parse(readFileSync(JSON_PATH, 'utf8'));
  } catch (err) {
    console.error(`Error: releases.json is corrupt: ${err.message}`);
    console.error('Run "rebuild" to regenerate.');
    process.exit(1);
  }

  const releases = data.releases || [];
  const issues = validate(releases);

  if (issues.length === 0) {
    if (!QUIET) console.error('✓ Release registry is valid.');
    process.exit(0);
  }

  for (const issue of issues) {
    console.error(`  ${issue}`);
  }
  console.error(`\n${issues.length} issue(s) found.`);
  console.error('Run "rebuild" to fix automatically.');
  process.exit(1);
}

function cmdHistory() {
  let data;
  if (!existsSync(JSON_PATH)) {
    // Fall back to collecting from npm directly
    const { releases } = collectReleases();
    data = generateJson(releases);
  } else {
    try {
      data = JSON.parse(readFileSync(JSON_PATH, 'utf8'));
    } catch {
      console.error('Warning: releases.json is corrupt. Falling back to npm query.');
      const { releases } = collectReleases();
      data = generateJson(releases);
    }
  }

  const stableReleases = (data.releases || []).filter((r) => r.type === 'stable');
  const betaReleases = (data.releases || []).filter((r) => r.type === 'prerelease');

  // Stable releases
  console.log('Stable Releases');
  console.log('');
  if (stableReleases.length > 0) {
    for (const r of stableReleases) {
      const date = r.timestamp ? new Date(r.timestamp).toISOString().slice(0, 10) : '—';
      console.log(`  ${r.fullVersion}  ${date}`);
    }
  } else {
    console.log('  (none)');
  }
  console.log('');

  // Beta releases
  console.log('Beta Releases');
  console.log('');
  if (betaReleases.length > 0) {
    for (const r of betaReleases) {
      const date = r.timestamp ? new Date(r.timestamp).toISOString().slice(0, 10) : '—';
      console.log(`  ${r.fullVersion}  ${date}`);
    }
  } else {
    console.log('  (none)');
  }
  console.log('');

  // Current
  console.log('Current');
  console.log('');
  console.log(`  Base Version : ${data.currentBaseVersion || 'unknown'}`);
  console.log(`  Latest Stable: ${data.latestStable || 'none'}`);
  console.log(`  Latest Beta  : ${data.latestBeta || 'none'}`);
  console.log(`  Next Beta    : ${data.nextBeta || 'N/A'}`);
}

// ── Dispatch ───────────────────────────────────────────────────────

// Pure helpers exported for offline testing (see packages/cli/test/release-registry.test.ts).
// When imported as a module the dispatch below is skipped.
export { anchorFor, baseVersion, betaIteration, changelogRefFor };

if (isMainModule()) {
  switch (command) {
    case 'add':
      await cmdAdd();
      break;
    case 'rebuild':
      cmdRebuild();
      break;
    case 'validate':
      cmdValidate();
      break;
    case 'history':
      cmdHistory();
      break;
    default:
      usage();
  }
}
