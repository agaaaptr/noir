# Releasing Noir

> **Runbook for publishing the `@noir-ai/*` packages to npm.** Noir uses **unified versioning**: all 11 packages share one version and are released together, on a git tag, from CI, authenticated with a **granular npm automation token** (the `NPM_TOKEN` repo secret) and carrying a **SLSA provenance** attestation on every publish.
>
> Audience: a maintainer cutting a release. **Read the [Irreversibility rules](#4-irreversibility-rules--safety) before the first publish.**
>
> **Note:** All version numbers in this runbook (e.g. `1.4.0`, `1.5.0`) are **examples** — substitute your actual version. Current published versions (run `pnpm docs:generate` to refresh):
>
> <!-- noir:doc:status -->
**Latest stable:** `1.9.2` (npm dist-tag `latest` — `npm i @noir-ai/cli` resolves here)
**Current beta:** `1.9.2-beta.1` (npm dist-tag `beta` — `npm i @noir-ai/cli@beta` to opt in)
**Source version:** `1.9.2` (clean SemVer in `packages/*/package.json`)

*Last auto-generated: 2026-08-07T08:28:19.583Z*
<!-- /noir:doc:status -->

---

## 0. Model (read once)

- **Scope:** `@noir-ai/{core, store, workflow, skills, daemon, adapters, cli, context, model, memory, create}` — 11 packages.
- **Unified versioning:** every release moves all 11 published packages to the same version in lockstep. There are no per-package releases; the private workspace-root `package.json` version is outside that release set.
- **Clean source, CI suffix.** Source code (all `packages/*/package.json`) contains ONLY plain SemVer (`X.Y.Z`). The `-beta.N` prerelease suffix is NEVER stored in source — it is computed and injected at publish time by CI. This means the same source version (`1.4.0`) can produce both a beta (`1.4.0-beta.2`) and a stable (`1.4.0`) release depending on which tag is pushed.
- **Two channels (version-string-based).** A tag `vX.Y.Z-beta.N` → npm dist-tag **`beta`** (beta). A tag `vX.Y.Z` (plain, no suffix) → npm dist-tag **`latest`** (stable). The CI detects the channel from the tag name pattern, NOT from which branch the tag is on. This means you create the tag that matches what you want to publish — no need to change `package.json` between beta and stable.
- **Trigger:** pushing a `vX.Y.Z` or `vX.Y.Z-beta.N` git tag runs `.github/workflows/release.yml`, which injects the full version, builds, and publishes all 11 packages to the npm registry.
- **Auth = npm automation token (Path A).** A granular npm access token scoped to `@noir-ai/*` (read + write) is stored as the `NPM_TOKEN` GitHub repo secret. **OIDC Trusted Publishing is the target alternative** — see [§1e](#1e-alternative-path--oidc-trusted-publishing-later).
- **Provenance:** every publish runs `npm publish --provenance`, which attaches a signed SLSA build-time attestation. Provenance uses the GitHub OIDC token from `permissions: id-token: write` — **independent of the npm token**.
- **Release Registry:** every successful publish generates/updates `.noir/releases/releases.json` + `releases.md` automatically. Run `pnpm release:history` to view, `pnpm release:rebuild` to recover from npm + git tags.
- **Access:** scoped packages (`@noir-ai/*`) are **private by default**. `publishConfig: { access: "public" }` in every `package.json` overrides that.

---

## 1. Prerequisites (one-time setup)

These are done once, by the npm org owner, before the first release. v1 uses **Path A** — a granular npm automation token stored as a GitHub secret — because it works for the *very first* publish of brand-new packages. The tokenless OIDC alternative is described in [§1e](#1e-alternative-path--oidc-trusted-publishing-later).

### 1a. On npmjs.com

1. **Create an npm account** (if you don't have one), then **create the `@noir-ai` organization** on https://www.npmjs.com/org/create.
2. **Enable 2FA on your account (mandatory)** and **enforce 2FA at the org level** (Org settings → Require two-factor authentication for all members). Publishing and provenance both work under 2FA.
3. **Create a granular automation token** (profile → **Access Tokens** → **Granular Access Token**):
   - **Name:** e.g. `noir-release`
   - **Expiration:** your policy (e.g. 90 days / 1 year).
   - **Packages:** select **"All packages in the `@noir-ai` scope"** (or enumerate the packages once they exist).
   - **Permissions:** **Read and write** (write is required to publish).
   - **2FA:** allow this token to **bypass 2FA**, so unattended CI can publish (the token itself is the credential).
   - **Copy it once.** npm does not show the value again.

### 1b. On GitHub

1. **Make the repo public** (`agaaaptr/noir`) — provenance requires a public source repo. If you keep it private, drop `--provenance` and accept weaker attestations.
2. **Add the `NPM_TOKEN` secret** (Repo settings → **Secrets and variables** → **Actions** → **New repository secret**): name `NPM_TOKEN`, value = the token from §1a step 3. The publish job reads it via `${{ secrets.NPM_TOKEN }}`.
3. **Create the `release` environment** (Repo settings → **Environments** → **New environment** → `release`). Optionally add a **Required reviewer** so a tag push waits for human approval in the GitHub Actions UI before `npm publish` runs. For tighter blast-radius control, put the `NPM_TOKEN` secret on the `release` **environment** (instead of the repo) so it is only available after that approval — recommended.

### 1c. Local machine

- Node ≥ 22, pnpm (the version pinned in the root `package.json` `packageManager` field).
- `npm` CLI ≥ 9.5 (for provenance support) — comes with Node 22+.
- You must have push + tag-push rights on `agaaaptr/noir`.

### What CI does at publish time (`.github/workflows/release.yml`)

The publish job uses **two independent credentials for two independent things**:

1. **The npm token → publish auth.** `actions/setup-node` is configured with `registry-url: 'https://registry.npmjs.org'`, which writes an `.npmrc` that publishes to the registry using `NODE_AUTH_TOKEN`. The publish step sets `env: NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` and runs `npm publish "$tgz" --provenance --access public --tag "$DIST_TAG"`. The token is the granular one from §1a.
2. **The GitHub OIDC token → provenance.** `permissions: id-token: write` lets the job mint a short-lived GitHub OIDC token, and `npm publish --provenance` uses it to attach a signed SLSA attestation to each package. This does **not** depend on the npm token — provenance works the same under Path A as under Trusted Publishing.

The publish is a deliberate **two-step** flow — **pack** with `pnpm` (which rewrites `workspace:*` ranges to concrete versions), then **publish** each packed `.tgz` with `npm` (which supports `--provenance`; `pnpm publish` does not). Full pipeline (lint → build → derive channel → pack → publish) in [§2](#2-cutting-a-release-stable-from-main).

> **Provenance note:** `--provenance` requires a public repo + a GitHub-hosted runner, both of which `release.yml` uses. Consumers can verify each published tarball was built from this repo's tagged commit (the npm UI shows the attestation; `npm view <pkg> dist.attestation` exposes it).

### 1e. Alternative path — OIDC Trusted Publishing (later)

OIDC Trusted Publishing (npm "Linked publishers" / "Trusted Publishers") is the **tokenless** alternative: npm is configured to trust `agaaaptr/noir` + the `release.yml` workflow + the `release` environment, and the job mints a short-lived OIDC token at publish time instead of reading a stored secret. Removing the token from the blast radius is the appeal.

v1 does **not** use it for one reason: a Trusted Publisher can only be linked to a package that **already exists** on npm, so it cannot authorize the *first* publish of a brand-new package. Path A (the granular token) works for the first publish and every one after. Once all `@noir-ai/*` packages exist, you can migrate to OIDC by linking each package on npm and dropping the `NPM_TOKEN` secret — provenance is unchanged (still `--provenance` + `id-token: write`). Under OIDC, the [new-package flow](packaging.md) gains one extra manual step: the new package's Trusted Publisher must be registered on npm before its first tag push.

---

## 2. Cutting a release (stable, from `main`)

> All 11 packages move together. You only need to bump the base version when changing it (major/minor/patch). The CI handles the rest.

```bash
# 0. Start from an up-to-date main, clean tree.
git checkout main
git pull --ff-only

# 1. (Optional) Bump the base version if this is a version change.
#    Skip this step if you're just promoting an existing develop beta.
node scripts/bump-version.mjs 1.4.0
#    equivalent: pnpm release:bump 1.4.0

# 2. (Recommended) update CHANGELOG.md (root) for the release.

# 3. Review the diff — all 11 packages should show the new version.
git diff

# 4. Commit (no tag yet).
git add -A
git commit -m "chore(release): v1.4.0"

# 5. Push the commit to main.
git push origin main

# 6. Create the release tag. This script auto-creates the correct tag:
#    On main → plain vX.Y.Z (stable channel in CI).
pnpm release:tag

# 7. Push the tag to trigger CI.
git push origin v1.4.0
```

> **The `pnpm release:tag` script does NOT modify package.json.** It reads the base version from source, verifies clean tree + upstream sync, checks the version isn't already on npm, and creates the annotated tag. For stable releases on main, the tag is `vX.Y.Z` (matching the source).

### What CI does next (`.github/workflows/release.yml`)

1. Detects **plain SemVer tag** → `channel=stable`, `dist-tag=latest`.
2. Checks if version is already on npm (idempotency — skips if already published).
3. **Injects the full version** into all `packages/*/package.json` files in the CI workspace.
4. `pnpm lint` → `pnpm build` → `pnpm typecheck` → `pnpm test`.
5. `pnpm pack` (captures the injected version in tarballs).
6. `npm publish --provenance --access public --tag latest` for each tarball.
7. Updates `.noir/releases/` registry and pushes back to the repo.
8. **Generates installer artifacts + `SHA256SUMS` + Sigstore attestation** for `install.sh` and `install.ps1` (see [§2c](#2c-installer-artifacts-checksums--attestation)).
9. Creates a GitHub Release with auto-generated release notes, attaching the installers + `SHA256SUMS` and pasting the `gh attestation verify` instructions into the body.

### 2c. Installer artifacts, checksums & attestation

Every stable release publishes the **native installers** as GitHub Release artifacts and binds them to the CI run that produced them via a Sigstore build-time attestation (the same SLSA predicate npm uses). The `release.yml` job:

1. Copies `scripts/install.sh` + `scripts/install.ps1` into a `dist-installers/` tree.
2. Generates `SHA256SUMS` (`shasum -a 256 install.sh install.ps1 > SHA256SUMS`) — pinned checksums users can verify offline.
3. Runs [`actions/attest-build-provenance@v3`](https://github.com/actions/attest-build-provenance) over `install.sh`, `install.ps1`, and `SHA256SUMS`, persisting a Sigstore attestation to GitHub's attestations API (`attestations: write` permission).
4. Uploads all three as Release assets and pastes the verification commands into the Release body.

Consumer verification (also documented in [installation.md](installation.md#trust-verification-pinned-installers-checksums-attestation)):

```bash
# 1. Verify the checksum against SHA256SUMS
shasum -a 256 install.sh            # compare to the install.sh line in SHA256SUMS

# 2. Verify the build-time attestation (binds the file to this repo's CI run)
gh attestation verify install.sh --repo agaaaptr/noir
```

`gh attestation verify` checks the cryptographic attestation minted for the file at publish time, so a tampered installer (even one with a matching checksum, if the checksum file itself were swapped) is caught. The attestation uses the GitHub OIDC token from `permissions: id-token: write` — independent of the npm token.

---

## 2b. Beta vs stable channels

Noir ships **two release channels in parallel**, both cut as git tags and both published by the same `release.yml`. They differ in (a) the tag name pattern, (b) the npm dist-tag, (c) the version string, and (d) what consumers type to opt in.

### The model

| | Stable | Beta |
|---|---|---|
| **Tag pattern** | `vX.Y.Z` (plain) | `vX.Y.Z-beta.N` (prerelease suffix) |
| **Created by** | `pnpm release:tag` on `main` | `pnpm release:tag` on `develop` |
| **npm dist-tag** | `latest` (the default) | `beta` (opt-in) |
| **Published version** | `X.Y.Z` | `X.Y.Z-beta.N` |
| **Source version** | `X.Y.Z` (unchanged) | `X.Y.Z` (suffix added by CI) |
| **Consumer install** | `npm i @noir-ai/cli` | `npm i @noir-ai/cli@beta` |
| **Audience** | Everyone | Early testers |
| **Promotion path** | — | Merge `develop` → `main`, then `pnpm release:tag` on `main` |

### How CI detects the channel

The CI uses **version-string-based detection** (NOT branch-based):

```yaml
# tag v1.4.0        → no prerelease suffix  → channel=stable, dist-tag=latest
# tag v1.4.0-beta.2 → has -beta.N suffix     → channel=beta, dist-tag=beta
```

This means:
- **The tag name determines the channel.** No need to worry about which branch the tag is on.
- **Source package.json stays clean.** You don't change it between beta and stable releases.
- **Cross-validation (warning only):** CI warns if a beta tag isn't on develop or a stable tag isn't on main, but does NOT block the publish.

### Cutting a beta release (from `develop`)

```bash
# 0. Start from an up-to-date develop, clean tree.
git checkout develop
git pull --ff-only

# 1. (Optional) Bump base version if this release warrants it.
#    If just adding another beta to the same base, skip this.
node scripts/bump-version.mjs 1.5.0   # only if bumping base
git add -A && git commit -m "chore(release): bump to 1.5.0"
git push origin develop

# 2. Create the release tag. The script queries npm, finds the
#    highest published beta for the current base, and creates the
#    next one (e.g., 1.5.0-beta.1 if no betas for 1.5.0 exist).
pnpm release:tag

# 3. Push the tag. CI detects the -beta.N suffix → publishes to
#    the beta dist-tag.
git push origin v1.5.0-beta.1
```

> **`pnpm release:tag` on develop** automatically queries npm for the next beta number. You never type the beta number manually.

After the `release.yml` job goes green:

```bash
npm view @noir-ai/cli dist-tags.beta   # → 1.5.0-beta.1 (current beta pointer)
npx @noir-ai/cli@beta init             # smoke test the published beta
pnpm release:history                   # view the updated release registry
```

### Promoting beta → stable

When the beta line is ready:

1. Merge `develop` into `main`:
   ```bash
   git checkout main && git merge --ff-only develop && git push origin main
   ```

2. Ensure source `package.json` version is the desired stable version:
   ```bash
   node scripts/bump-version.mjs 1.5.0
   git add -A && git commit -m "chore(release): v1.5.0"
   git push origin main
   ```

3. Create and push the stable tag:
   ```bash
   pnpm release:tag       # creates v1.5.0 (plain, no suffix)
   git push origin v1.5.0
   ```

4. CI detects plain SemVer → publishes under `latest`. Now `npm i @noir-ai/cli` resolves to `1.9.0`; `npm i @noir-ai/cli@beta` still resolves to the last beta.

### Additional beta for the same base version

If you need another beta iteration without changing the base version:

```bash
git checkout develop && git pull --ff-only
pnpm release:tag       # auto-computes next beta (e.g., 1.5.0-beta.2)
git push origin v1.5.0-beta.2
```

No source changes needed — the CI handles the suffix.

### 2d. Homebrew & Scoop (stable-only, manual bump on each stable)

The Homebrew formula ([`packaging/homebrew/noir.rb`](../../packaging/homebrew/noir.rb)) and Scoop manifest ([`packaging/scoop/noir.json`](../../packaging/scoop/noir.json)) are **stable-only** — there is no beta channel on a tap/bucket. After each stable publish, refresh the `url`/`sha256`/`version` from the now-published npm tarball:

```bash
# Get the three values from npm (immutable once published)
curl -sL https://registry.npmjs.org/@noir-ai/cli/latest | \
  jq -r '.version, .dist.tarball, .dist.integrity'

# sha256 of the tarball (Homebrew wants sha256; npm reports sha512-integrity)
shasum -a 256 <(curl -sL "<tarball>")

# Homebrew: update url/sha256/version in packaging/homebrew/noir.rb
# Scoop:   update version/url/hash in packaging/scoop/noir.json
```

Then commit + push the bump on `main`. The tap repo (`brew tap agaaaptr/noir`) and the Scoop bucket both point at this repo, so a single commit updates both. The Homebrew README ([`packaging/homebrew/README.md`](../../packaging/homebrew/README.md)) documents the Node-for-Formula-Authors tradeoff (heavier than npm — the formula builds native modules against Homebrew's `node@22`).

---

## 3. Semver policy (unified)

Noir ships a **single** version across all 11 packages. The bump level reflects the **most significant** change anywhere in the toolkit this release:

| Change | Bump | Examples |
|---|---|---|
| **Breaking** public API, CLI flag, config schema, `.noir/` layout, or MCP tool shape | **major** | Renaming a CLI command; a required `config.yml` field; removing/renaming an exported symbol; an MCP tool's input schema change. |
| **New** capability, tool, or exported surface (backward-compatible) | **minor** | A new MCP tool; a new `noir <subcommand>`; a new optional config block; a new package. |
| **Fix / perf / docs** (no behavior contract change) | **patch** | Bug fixes, dependency bumps within range, test/doc changes. |

Rules:

- **All 11 move together.** Even a change that only touches one package bumps the unified version for every package.
- **Pre-1.0 caveat:** while the version is `0.x`, minors may include breaking changes. From `1.0.0` the table above is binding.
- **When in doubt, bump higher** and document it.

---

## 3a. Release Registry & Developer CLI

Every successful publish automatically updates `.noir/releases/` (committed back to the repo by CI). Use these commands to interact with it:

| Command | Purpose |
|---|---|
| `pnpm release:history` | Print formatted release history (stable + beta + current state) |
| `pnpm release:validate` | Check registry integrity against npm + git tags |
| `pnpm release:rebuild` | Full rebuild from npm + git tags (recovery) |
| `pnpm release:compute <ver> <channel>` | Preview the next beta or stable version |
| `pnpm release:tag` | Create the correct release tag (auto-computes beta number) |
| `pnpm release:bump <ver>` | Bump all 11 packages to a new version |

Example output:

```
$ pnpm release:history

Stable Releases
  1.4.0  2026-07-27

Beta Releases
  1.4.0-beta.1  2026-07-27
  1.3.0-beta.6  2026-07-26
  ...

Current
  Base Version : 1.4.0
  Latest Stable: 1.4.0
  Latest Beta  : 1.4.0-beta.1
  Next Beta    : 1.4.0-beta.2
```

**Recovery:** If `.noir/releases/releases.json` is ever lost or corrupted, run `pnpm release:rebuild` to regenerate it from the npm registry (authoritative source) cross-referenced with git tags.

---

## 4. Irreversibility rules & safety

npm publishing is **irreversible**. Internalize these before the first release:

1. **Versions are immutable.** Once `@noir-ai/cli@1.0.0` is published, that exact `name@version` can **never** be published again, even if you delete the tarball. npm keeps the version slot occupied forever.
2. **You cannot republish the same version.** A typo in a published `1.0.0` means the fix ships as `1.0.1`. There is no "overwrite."
3. **Deprecate, never delete.** You can `npm deprecate @noir-ai/<pkg>@<version> "reason"` (and unpublish is only possible within 72h of first publish, only for packages with no dependents, and only for the first 72 hours of the package's life — assume it is unavailable as a tool). Deprecation is the safe, durable tool.
4. **Always dry-run first.** Before tagging, confirm the tarball is sane:
   ```bash
   cd packages/cli && npm publish --dry-run && cd -
   ```
   Check: only `dist/` (+ `builtin/` for skills) + `README.md` are in the tarball; **no `src/`, no `tests/`, no `.env`/secrets, no `.noir/` store, no lockfiles leaking.**
5. **No secrets in the tree.** Provenance binds the tarball to the commit; anything in the committed tree can end up attested. Keep secrets in the environment, never in files.
6. **One tag, one release.** Never reuse or move a tag. If a release is bad after tagging, ship a patch release (`1.0.1`) and deprecate-on-document the bad one; do **not** `git tag -f`.
7. **`publishConfig.provenance: true` + `access: "public"` must stay in every package.json.** Removing `access:"public"` silently makes scoped publishes fail (or publish private, which is worse). CI gates on `--provenance` too.

---

## 5. Verification after publish

Once the `release.yml` job is green, confirm the packages actually landed and work:

```bash
# 5a. Registry metadata for the CLI (spot the unified version + provenance).
npm view @noir-ai/cli
npm view @noir-ai/cli version           # should print 1.0.0
npm view @noir-ai/cli dist.attestation  # provenance present (or check the npm UI badge)

# 5b. All 11 are at the same version.
for p in core store workflow skills daemon adapters cli context model memory create; do
  printf "@noir-ai/%s\t%s\n" "$p" "$(npm view @noir-ai/$p version)"
done

# 5c. Smoke install + run (the end-user path).
npx @noir-ai/cli@1.0.0 --version
npx @noir-ai/cli@1.0.0 init --help
```

Optionally, in a throwaway project:

```bash
mkdir /tmp/noir-smoke && cd /tmp/noir-smoke
npx @noir-ai/cli@1.0.0 init     # scaffolds .noir/ + emits the skill pack + host wiring
ls -la .noir .claude/skills      # confirm artifacts
```

If any package is missing or at the wrong version, **do not republish** — cut a patch release that corrects the drift (§3/§4).

---

## 6. First-release checklist

The very first release (`1.0.0`) has extra gating. Do not cut it until every box is checked.

**Setup (§1)**
- [ ] npm account exists; `@noir-ai` org created on npmjs.com.
- [ ] 2FA enabled on the owner account + required at the org level.
- [ ] Granular automation token `noir-release` created on npm: scoped to `@noir-ai/*`, Read + Write, 2FA bypass.
- [ ] `NPM_TOKEN` GitHub secret = the token (repo-level, or on the `release` environment for tighter gating).
- [ ] Repo `agaaaptr/noir` is **public** (provenance requires it).
- [ ] `release` environment created on GitHub (optional required-reviewer added).

**Readiness (§2 / §4)**
- [ ] `pnpm lint && pnpm build && pnpm typecheck && pnpm test` all green on `main` (target the same Node 22 the CI uses).
- [ ] Every `packages/*/package.json` has `publishConfig: { access:"public", provenance:true }`, `engines.node >=22`, a one-line `description`, valid `repository`/`bugs`/`homepage`, and `files` including `dist` (+ `README.md`, and `builtin/` for skills).
- [ ] `npm publish --dry-run` in `packages/cli` and at least one library package is sane (correct files, **no `src/`/tests/secrets**).
- [ ] `CHANGELOG.md` (root) has a `1.0.0` entry.

**Cut (§2)**
- [ ] `node scripts/bump-version.mjs 1.0.0`; verify all 11 are `1.0.0` and identical.
- [ ] Commit + tag `v1.0.0`; push commit and tag.
- [ ] `release.yml` run on the `release` environment goes green; all 11 publishes succeed.

**Verify (§5)**
- [ ] `npm view @noir-ai/cli version` → `1.0.0`.
- [ ] All 11 packages resolve at `1.0.0`.
- [ ] `npx @noir-ai/cli@1.0.0 --version` runs; `npm view … dist.attestation` (or the npm UI) shows provenance.
- [ ] GitHub **Release** notes published from the tag, summarizing the 11 packages + changelog.

---

## 7. Reference: the release one-liner

```bash
# The full workflow (develop beta):
git checkout develop && git pull --ff-only
pnpm release:tag                       # auto-computes next beta number
git push origin vX.Y.Z-beta.N          # triggers CI → publishes to beta dist-tag

# Promote to stable:
git checkout main && git merge --ff-only develop && git push origin main
pnpm release:tag                       # creates vX.Y.Z (plain)
git push origin vX.Y.Z                 # triggers CI → publishes to latest dist-tag

# Preview what would happen (dry-run):
pnpm release:tag --dry-run
```

The tag push hands off to `.github/workflows/release.yml`. You're done.

---

## 8. Troubleshooting

Gotchas encountered during releases. Each is one line: symptom → fix.

### Common issues

1. **`pnpm release:tag` fails with "not clean"** — you have uncommitted changes. Commit or stash first. Use `--force` to skip.
2. **`pnpm release:tag` fails with "unpushed commits"** — your local branch is ahead of origin. Push first.
3. **"Version already published on npm"** — the version already exists. Wait for the next beta number if this is a re-run, or bump the base version. For partial-publish recovery, bump the iteration and republish all 11.
4. **npm view timeout** — the npm registry may be down. Retry; the `compute-version.mjs` script retries with backoff.
5. **CI fails on "version already published"** — expected on workflow re-runs. The idempotency check skips re-publishing safely.
6. **Registry out of sync** — run `pnpm release:validate` to detect issues, then `pnpm release:rebuild` to fix.

### Partial publish recovery

If `npm publish` fails after publishing some of the 11 packages (e.g., network error on the 6th package):
1. Don't try to re-publish the same version — npm rejects it.
2. Bump to the next beta: `pnpm release:tag` (auto-computes next iteration).
3. Push the new tag. All 11 packages publish under the new version.
4. Optionally deprecate the partially-published version: `npm deprecate @noir-ai/<pkg>@<bad-version> "partial publish"`.
