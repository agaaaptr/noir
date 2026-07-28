#!/usr/bin/env node
// Developer-facing release tag creation tool.
//
// Automates creating the correct git release tag for Noir's "source=clean,
// CI=suffix" model. The developer never manually computes beta numbers —
// this script queries npm and creates the right tag.
//
// Usage:
//   pnpm release:tag                  # auto-detects branch + computes version
//   pnpm release:tag --dry-run        # preview only, no tag created
//   pnpm release:tag --force          # skip safety checks
//   pnpm release:tag --delete-stale   # clean up failed/unpublished tags
//
// Behavior (version-string-based, branch-validated):
//   - On `develop`: reads base version from source → computes next beta from
//     npm → creates tag `vX.Y.Z-beta.N` → prints push instruction.
//   - On `main`:    reads base version from source → creates tag `vX.Y.Z`
//     (plain, no suffix) → prints push instruction.
//   - On any other branch: error (release tags only from main or develop).
//
// Safety checks (skippable with --force):
//   - Clean working tree (no uncommitted changes).
//   - HEAD is pushed to origin (no dangling local commits).
//   - Computed version is NOT already published on npm.
//   - Git tag does NOT already exist for this version.

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── Argument parsing ──────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FORCE = args.includes('--force');
const DELETE_STALE = args.includes('--delete-stale');

if (DRY_RUN && DELETE_STALE) {
  console.error('Error: --dry-run and --delete-stale are mutually exclusive.');
  process.exit(1);
}

// ── Helpers ────────────────────────────────────────────────────────

function git(args) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitNullable(args) {
  try {
    return git(args);
  } catch {
    return '';
  }
}

function npmViewJson(args) {
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
    return npmViewJson(args);
  } catch {
    return null;
  }
}

// ── Check preconditions ───────────────────────────────────────────

// 1. Clean working tree
const status = gitNullable(['status', '--porcelain']);
if (status && !FORCE) {
  console.error('Error: working tree is not clean. Uncommitted changes:');
  console.error(status);
  console.error('Commit or stash changes first, or use --force to skip this check.');
  process.exit(1);
}

// 2. HEAD is pushed to origin
try {
  git(['rev-parse', '@{u}']);
} catch {
  if (!FORCE) {
    console.error('Error: HEAD has no upstream tracking branch.');
    console.error('Push first, or use --force to skip this check.');
    process.exit(1);
  }
}

const head = git(['rev-parse', 'HEAD']);
const upstream = gitNullable(['rev-parse', '@{u}']);
if (head !== upstream && !FORCE) {
  console.error('Error: HEAD contains unpushed commits.');
  console.error(`Local  : ${head}`);
  console.error(`Origin : ${upstream || '(no upstream)'}`);
  console.error('Push first, or use --force to skip this check.');
  process.exit(1);
}

// ── Determine branch and base version ─────────────────────────────

const branch = git(['branch', '--show-current']);
if (!branch) {
  console.error('Error: not on any branch (detached HEAD).');
  console.error('Checkout main or develop first.');
  process.exit(1);
}

if (branch !== 'main' && branch !== 'develop') {
  console.error(`Error: branch "${branch}" is not a release branch.`);
  console.error('Release tags can only be created from `main` or `develop`.');
  process.exit(1);
}

// Read base version from source (the canonical @noir-ai/cli package.json)
const cliPkgPath = join(ROOT, 'packages', 'cli', 'package.json');
let baseVersion;
try {
  const pkg = JSON.parse(await readFile(cliPkgPath, 'utf8'));
  baseVersion = pkg.version;
} catch (err) {
  console.error(`Error: cannot read ${cliPkgPath}: ${err.message}`);
  process.exit(1);
}

// Validate base version is clean semver (no prerelease suffix)
const PLAIN_SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
if (!PLAIN_SEMVER_RE.test(baseVersion)) {
  console.error(
    `Error: base version "${baseVersion}" in package.json is not clean SemVer (X.Y.Z).`,
  );
  console.error('The source must contain a plain version — no prerelease suffixes.');
  console.error('Run: node scripts/bump-version.mjs <X.Y.Z>  to fix.');
  process.exit(1);
}

// ── Compute full version ──────────────────────────────────────────

let fullVersion;
let channel;

if (branch === 'main') {
  channel = 'stable';
  fullVersion = baseVersion;
} else {
  // branch === 'develop'
  channel = 'beta';
  // Call compute-version.mjs to determine the next beta number
  const computeScript = join(ROOT, 'scripts', 'compute-version.mjs');
  try {
    fullVersion = execFileSync('node', [computeScript, baseVersion, 'beta'], {
      cwd: ROOT,
      encoding: 'utf8',
      // compute-version.mjs prints diagnostics to stderr, version ONLY to stdout
      stdio: ['ignore', 'pipe', 'inherit'],
    }).trim();
  } catch (err) {
    console.error(`Error: compute-version.mjs failed. Exit code: ${err.status}`);
    process.exit(err.status || 1);
  }
}

// ── Safety: check version not already on npm ──────────────────────

const tagName = `v${fullVersion}`;

if (!FORCE) {
  const published = npmViewNullable(['@noir-ai/cli', 'versions']);
  if (published && Array.isArray(published) && published.includes(fullVersion)) {
    console.error(`Error: version ${fullVersion} is already published on npm.`);
    console.error('npm versions are immutable — you cannot republish the same version.');
    console.error('Use --force if you are recovering from a partial publish.');
    process.exit(1);
  }

  // Check git tag doesn't already exist
  const existingTag = gitNullable(['tag', '-l', tagName]);
  if (existingTag === tagName) {
    console.error(`Error: git tag ${tagName} already exists.`);
    console.error('Delete the stale tag first, or use a different version.');
    console.error(`  git tag -d ${tagName}`);
    console.error(`  git push --delete origin ${tagName}`);
    process.exit(1);
  }
}

// ── Create tag ─────────────────────────────────────────────────────

console.error('');
console.error(`Branch      : ${branch}`);
console.error(`Base version: ${baseVersion}`);
console.error(`Channel     : ${channel}`);
console.error(`Full version: ${fullVersion}`);
console.error(`Tag         : ${tagName}`);
console.error('');

if (DRY_RUN) {
  console.error('[DRY RUN] No tag created. Remove --dry-run to create the tag.');
  console.log(`Would create tag: ${tagName}`);
  process.exit(0);
}

// Create the annotated tag
try {
  git(['tag', '-a', tagName, '-m', `chore(release): ${tagName}`]);
} catch (err) {
  console.error(`Error: failed to create tag ${tagName}: ${err.message}`);
  process.exit(1);
}

console.error(`✓ Created tag ${tagName}`);
console.error('');
console.error('Next step — push the tag to trigger CI:');
console.error(`  git push origin ${tagName}`);
console.error('');
console.error(
  `CI will publish ${fullVersion} to npm with dist-tag: ${channel === 'stable' ? 'latest' : 'beta'}`,
);
