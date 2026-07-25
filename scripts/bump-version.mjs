#!/usr/bin/env node
// Unified version bumper for the @noir-ai/* monorepo.
//
// Noir uses UNIFIED versioning: all 10 packages share one version and release
// together. This script writes a single version into every package.json under
// packages/* (and is the source of truth the release CI relies on).
//
// Usage:
//   node scripts/bump-version.mjs <version>   # e.g. 1.0.0
//   node scripts/bump-version.mjs 1.0.0 --no-git-tag-version
//
// The `--no-git-tag-version` flag is accepted (for npm-version-parity muscle
// memory) and is a no-op — this script NEVER creates a git tag or commit by
// itself. Tagging is a separate, deliberate release step (see docs/releasing.md).
//
// Exits non-zero if no/invalid version is given or no package.json is found.

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PACKAGES_DIR = join(ROOT, 'packages');

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

function usage() {
  console.error('Usage: node scripts/bump-version.mjs <semver> [--no-git-tag-version]');
  console.error('Example: node scripts/bump-version.mjs 1.0.0');
}

const args = process.argv.slice(2).filter((a) => a !== '--no-git-tag-version');
const version = args[0];

if (!version) {
  console.error('Error: missing version argument.\n');
  usage();
  process.exit(1);
}
if (!SEMVER_RE.test(version)) {
  console.error(`Error: "${version}" is not a valid semantic version.\n`);
  usage();
  process.exit(1);
}

const entries = await readdir(PACKAGES_DIR, { withFileTypes: true });
const pkgDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

if (pkgDirs.length === 0) {
  console.error(`Error: no package directories found under ${PACKAGES_DIR}`);
  process.exit(1);
}

let changed = 0;
const seen = new Set();

for (const dir of pkgDirs) {
  const file = join(PACKAGES_DIR, dir, 'package.json');
  let json;
  try {
    json = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    console.error(`skip  ${dir} (no package.json)`);
    continue;
  }
  if (!json.name || !json.name.startsWith('@noir-ai/')) {
    console.error(`skip  ${dir} (name ${json.name ?? '<none>'} is not @noir-ai/*)`);
    continue;
  }
  const previous = json.version;
  json.version = version;
  // Preserve 2-space indentation + trailing newline (matches the rest of the repo).
  await writeFile(file, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
  seen.add(json.name);
  changed += 1;
  console.log(`bump  ${json.name.padEnd(20)} ${previous} -> ${version}`);
}

console.log(`---\nWrote version ${version} to ${changed} package.json file(s).`);
if (changed > 0) {
  console.log('Next (manual): review the diff, commit, then tag — see docs/releasing.md.');
}
