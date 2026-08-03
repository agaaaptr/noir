// Task P4 — offline unit test for scripts/release-registry.mjs.
//
// Two correctness regressions were fixed in P4:
//   1. `channel`/`npmDistTag` were derived from an npm dist-tags POINTER
//      (which advances on every publish) instead of from the immutable version
//      type — so already-shipped stables (1.4.0, 1.5.0) were mislabeled `beta`
//      in the registry even though npm had them at `latest`.
//   2. `changelogRef` was always `null` — the deep link to CHANGELOG.md was
//      never populated.
//
// This test exercises the pure helpers (`anchorFor`, `changelogRefFor`,
// `buildEntry`-equivalent derivation) OFFLINE — no `npm view`, no network
// (global constraint: the unit suite never hits the registry). The CI smoke
// test (P5) and `pnpm release:rebuild` do the real npm round-trip.
//
// It also re-loads the committed `.noir/releases/releases.json` and asserts the
// two historically-mislabeled rows (1.4.0, 1.5.0) are now `channel: stable` and
// every entry has a non-null `changelogRef` — the regression guard the brief
// asks for ("a node assertion script that checks the two fixed rows").
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

// The registry manager is an ESM `.mjs` script. Import its exported pure
// helpers (the `isMainModule()` guard added in P4 keeps the CLI dispatch from
// firing on import, so this is safe + side-effect-free). Resolve from the
// computed repo root (not a relative URL) so the path is unambiguous.
const REGISTRY_PATH = join(repoRoot(), 'scripts', 'release-registry.mjs');
const REGISTRY_URL = pathToFileURL(REGISTRY_PATH).href;
const { anchorFor, changelogRefFor, baseVersion, betaIteration } = (await import(REGISTRY_URL)) as {
  anchorFor: (v: string, d: string | null) => string;
  changelogRefFor: (v: string, d: string | null) => string;
  baseVersion: (v: string) => string;
  betaIteration: (v: string) => number | null;
};

describe('release-registry — anchorFor', () => {
  it('strips dots from a plain SemVer and appends the date', () => {
    // `## 1.6.0 (2026-07-28)` → github anchor `160-2026-07-28`
    expect(anchorFor('1.6.0', '2026-07-28')).toBe('160-2026-07-28');
  });

  it('strips the dot inside a prerelease but keeps the hyphen', () => {
    // `## 1.4.0-beta.1 (2026-07-27)` → github anchor `140-beta1-2026-07-27`
    expect(anchorFor('1.4.0-beta.1', '2026-07-27')).toBe('140-beta1-2026-07-27');
  });

  it('accepts a full ISO timestamp (normalizes to YYYY-MM-DD)', () => {
    expect(anchorFor('1.4.0-beta.1', '2026-07-27T00:30:23.922Z')).toBe('140-beta1-2026-07-27');
  });

  it('falls back to the version-only core when the date is unknown', () => {
    // Still a useful human identifier, even if it won't auto-resolve on github.com.
    expect(anchorFor('1.6.0', null)).toBe('160');
    expect(anchorFor('1.4.0-beta.1', '')).toBe('140-beta1');
  });

  it('matches the anchors GitHub actually generates for the real headings', () => {
    // Verified against https://github.com/agaaaptr/noir/blob/main/CHANGELOG.md
    // — these are the literal <h2 id="…"> values GitHub renders. If the
    // CHANGELOG heading style ever changes, this assertion is the trip-wire.
    expect(anchorFor('1.5.0', '2026-07-28')).toBe('150-2026-07-28');
    expect(anchorFor('1.4.0-beta.1', '2026-07-27')).toBe('140-beta1-2026-07-27');
    expect(anchorFor('1.3.0-beta.6', '2026-07-26')).toBe('130-beta6-2026-07-26');
  });
});

describe('release-registry — changelogRefFor', () => {
  it('produces a deep link to CHANGELOG.md on main', () => {
    expect(changelogRefFor('1.6.0', '2026-07-28')).toBe(
      'https://github.com/agaaaptr/noir/blob/main/CHANGELOG.md#160-2026-07-28',
    );
  });

  it('falls back to the version-only anchor fragment when no date', () => {
    expect(changelogRefFor('1.4.0-beta.1', null)).toBe(
      'https://github.com/agaaaptr/noir/blob/main/CHANGELOG.md#140-beta1',
    );
  });
});

describe('release-registry — version parsing helpers', () => {
  it('baseVersion strips prerelease suffixes', () => {
    expect(baseVersion('1.4.0-beta.3')).toBe('1.4.0');
    expect(baseVersion('1.4.0')).toBe('1.4.0');
  });

  it('betaIteration extracts the prerelease number', () => {
    expect(betaIteration('1.4.0-beta.3')).toBe(3);
    expect(betaIteration('1.4.0')).toBeNull();
  });
});

describe('release-registry — committed registry rows (regression guard)', () => {
  const registryPath = join(repoRoot(), '.noir', 'releases', 'releases.json');
  const data = JSON.parse(readFileSync(registryPath, 'utf8')) as {
    releases: Array<{
      fullVersion: string;
      type: string;
      channel: string;
      npmDistTag: string;
      changelogRef: string | null;
    }>;
  };

  it('1.4.0 and 1.5.0 are channel=stable / npmDistTag=latest (not beta)', () => {
    // These two were the historically-mislabeled rows — shipped as `latest` on
    // npm but recorded as `beta` because the old `distTags.latest === version`
    // check ran at rebuild time when `latest` had already advanced past them.
    for (const ver of ['1.4.0', '1.5.0']) {
      const row = data.releases.find((r) => r.fullVersion === ver);
      expect(row, `row exists for ${ver}`).toBeDefined();
      expect(row?.type, `${ver} type`).toBe('stable');
      expect(row?.channel, `${ver} channel`).toBe('stable');
      expect(row?.npmDistTag, `${ver} npmDistTag`).toBe('latest');
    }
  });

  it('every entry has a non-null changelogRef pointing at CHANGELOG.md', () => {
    expect(data.releases.length, 'registry has releases').toBeGreaterThan(0);
    for (const r of data.releases) {
      expect(r.changelogRef, `${r.fullVersion} has changelogRef`).toMatch(
        /^https:\/\/github\.com\/agaaaptr\/noir\/blob\/main\/CHANGELOG\.md#.+/,
      );
    }
  });

  it('channel/npmDistTag are consistent with type across every row', () => {
    // channel is now derived from type, so this invariant must hold universally.
    for (const r of data.releases) {
      const wantChannel = r.type === 'stable' ? 'stable' : 'beta';
      const wantTag = r.type === 'stable' ? 'latest' : 'beta';
      expect(r.channel, `${r.fullVersion} channel vs type`).toBe(wantChannel);
      expect(r.npmDistTag, `${r.fullVersion} npmDistTag vs type`).toBe(wantTag);
    }
  });
});
