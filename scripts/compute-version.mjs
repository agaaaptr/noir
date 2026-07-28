#!/usr/bin/env node
// Compute the full publish version from a base version and channel.
//
// Noir uses CLEAN SemVer (X.Y.Z) in source code. The prerelease suffix (-beta.N)
// is NEVER stored in package.json — it is computed at release time by this script.
//
// Channel rules (version-string-based):
//   - stable: returns baseVersion unchanged  (e.g. "1.4.0" → "1.4.0")
//   - beta:   queries npm registry, finds max published -beta.N for the same
//             base, returns "1.4.0-beta.{N+1}" (or "1.4.0-beta.1" if none).
//
// Usage:
//   node scripts/compute-version.mjs <baseVersion> <channel>
//   node scripts/compute-version.mjs 1.4.0 beta
//   node scripts/compute-version.mjs 1.4.0 stable
//
// Output: prints the computed full version to stdout and exits 0.
// Exits non-zero with a diagnostics message to stderr on failure.
//
// npm query target: @noir-ai/cli (the canonical marker for the monorepo —
// all 11 packages share unified lockstep versioning, so checking one package
// is sufficient and efficient).

import { execFileSync } from 'node:child_process';

// ── Argument parsing ──────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: node scripts/compute-version.mjs <baseVersion> <channel>');
  console.error('  baseVersion: clean semver (e.g. 1.4.0)');
  console.error('  channel:     "stable" or "beta"');
  process.exit(1);
}

const baseVersion = args[0];
const channel = args[1];

// ── Validation ────────────────────────────────────────────────────

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

if (!SEMVER_RE.test(baseVersion)) {
  console.error(`Error: "${baseVersion}" is not a valid plain semver (X.Y.Z).`);
  console.error('Prerelease suffixes are not allowed in the base version.');
  process.exit(1);
}

if (channel !== 'stable' && channel !== 'beta') {
  console.error(`Error: channel must be "stable" or "beta", got "${channel}".`);
  process.exit(1);
}

// ── Stable: return as-is ──────────────────────────────────────────

if (channel === 'stable') {
  console.log(baseVersion);
  process.exit(0);
}

// ── Beta: query npm registry ──────────────────────────────────────

const NPM_VIEW_ARGS = ['view', '@noir-ai/cli', 'versions', '--json'];
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2000;

/**
 * Synchronous sleep via busy-wait (acceptable for a release script
 * with delays of a few seconds — no event-loop dependency needed).
 */
function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // busy-wait
  }
}

/**
 * Run npm view with retries + backoff. Returns parsed JSON.
 * Exits the process on fatal failure (unreachable registry).
 */
function npmView(retriesLeft = MAX_RETRIES) {
  let lastError;
  for (let attempt = 0; attempt <= retriesLeft; attempt++) {
    try {
      const stdout = execFileSync('npm', NPM_VIEW_ARGS, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15_000,
      }).trim();
      return JSON.parse(stdout);
    } catch (err) {
      lastError = err;
      if (attempt < retriesLeft) {
        const delay = RETRY_DELAY_MS * (attempt + 1);
        console.error(
          `npm view failed (attempt ${attempt + 1}/${retriesLeft + 1}), retrying in ${delay / 1000}s...`,
        );
        sleepSync(delay);
      }
    }
  }
  // All retries exhausted
  console.error(`Error: failed to query npm registry after ${retriesLeft + 1} attempts.`);
  console.error(`Command: npm ${NPM_VIEW_ARGS.join(' ')}`);
  console.error('Reason:', lastError?.message ?? 'unknown');
  console.error('');
  console.error('The npm registry may be down, or the @noir-ai/cli package may not exist yet.');
  console.error('If this is the FIRST release, run a stable release first, then beta will work.');
  process.exit(2);
}

/**
 * Compute the next beta iteration for the given base version.
 *
 * Queries npm for all published versions of @noir-ai/cli, filters to
 * those matching `{baseVersion}-beta.{N}`, and returns N+1 (or 1 if none).
 */
function computeNextBeta(baseVer) {
  const prefix = `${baseVer}-beta.`;

  let allVersions;
  try {
    allVersions = npmView();
  } catch {
    // npmView already exits the process on fatal failure
    process.exit(2);
  }

  if (!Array.isArray(allVersions)) {
    console.error(
      `Error: unexpected npm response format. Expected array, got ${typeof allVersions}.`,
    );
    process.exit(2);
  }

  // Log discovered versions for observability
  const matching = allVersions.filter((v) => v.startsWith(prefix));
  console.error(`Base version: ${baseVer}`);
  console.error(
    `npm published versions matching "${prefix}*": ${matching.length > 0 ? matching.join(', ') : '(none)'}`,
  );

  if (matching.length === 0) {
    return 1;
  }

  // Extract iteration numbers: "1.4.0-beta.3" → 3
  const iterations = matching
    .map((v) => {
      const suffix = v.slice(prefix.length);
      const num = parseInt(suffix, 10);
      // Guard: "1.4.0-beta.0" or "1.4.0-beta.notanumber" → skip
      if (Number.isNaN(num) || suffix !== String(num)) return null;
      return num;
    })
    .filter((n) => n !== null);

  if (iterations.length === 0) {
    return 1;
  }

  const maxIteration = Math.max(...iterations);
  console.error(`Max published iteration: ${maxIteration}`);
  return maxIteration + 1;
}

// ── Compute and output ────────────────────────────────────────────

const nextN = computeNextBeta(baseVersion);
const fullVersion = `${baseVersion}-beta.${nextN}`;

// Validate the computed version is valid semver
const PRERELEASE_SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

if (!PRERELEASE_SEMVER_RE.test(fullVersion)) {
  console.error(`Error: computed version "${fullVersion}" failed semver validation.`);
  console.error('This is an internal bug — please report it.');
  process.exit(3);
}

console.error(`Computed full version: ${fullVersion}`);
// Print ONLY the version to stdout (for CI consumption via $())
console.log(fullVersion);
