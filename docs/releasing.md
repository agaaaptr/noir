# Releasing Noir

> **Runbook for publishing the `@noir-ai/*` packages to npm.** Noir uses **unified versioning**: all 10 packages share one version and are released together, on a git tag, from CI, using **OIDC Trusted Publishing + SLSA provenance** — with **no long-lived npm token** stored anywhere in the repo.
>
> Audience: a maintainer cutting a release. **Read the [Irreversibility rules](#4-irreversibility-rules--safety) before the first publish.**

---

## 0. Model (read once)

- **Scope:** `@noir-ai/{core, store, workflow, skills, daemon, adapters, cli, context, model, memory}` — 10 packages.
- **Unified versioning:** every release moves all 10 packages to the same version in lockstep. There are no per-package releases.
- **Two channels (branch-based).** A tag push on **`main`** → npm dist-tag **`latest`** (stable; `npm i @noir-ai/cli` resolves here). A tag push on **`develop`** → npm dist-tag **`beta`** (opt-in; `npm i @noir-ai/cli@beta`). The publish job derives the channel from which branch holds the tagged commit. Versions: stable is `X.Y.Z`; beta is `X.Y.Z-beta.N`. Full mechanics in [§2b](#2b-beta-vs-stable-channels); consumer side in [installation.md](installation.md#what-youre-installing).
- **Trigger:** pushing a `vX.Y.Z` git tag runs `.github/workflows/release.yml`, which builds all 10 packages and publishes them to the npm registry.
- **Auth = OIDC Trusted Publishing.** npm is configured to trust the `agaaaptr/noir` GitHub repo + the `release.yml` workflow. At publish time the GitHub Actions job mints a short-lived OIDC token that npm accepts — **no `NPM_TOKEN` secret is stored** on GitHub, and **no automation token** sits on an npm account. Removing the token from the blast radius is the whole point.
- **Provenance:** every publish runs `npm publish --provenance`, which attaches a signed SLSA build-time attestation to each package. Consumers can verify the published tarball was built from this repo's tagged commit. This requires the repo to be **public** and the build to run on a **GitHub-hosted runner**.
- **Access:** scoped packages (`@noir-ai/*`) are **private by default**. `publishConfig: { access: "public" }` in every `package.json` overrides that so the packages publish publicly.

---

## 1. Prerequisites (one-time setup)

These are done once, by the npm org owner, before the first release.

### 1a. On npmjs.com

1. **Create the `@noir-ai` organization** on https://www.npmjs.com/org/create.
2. **Enable 2FA** on the owner account and **enforce 2FA at the org level** (Org settings → Require two-factor authentication for all members). Publishing and provenance both work under 2FA; the OIDC path is not weakened by it because the publish itself is tokenless.
3. **Do NOT create a long-lived automation/publish token.** That is the legacy path; Noir does not use it.

### 1b. Link GitHub ↔ npm (Trusted Publishing, OIDC)

For the unified set, configure Trusted Publishing so `release.yml` can publish **without a token**. On npm, for each package `@noir-ai/<pkg>` (or at the org level if npm exposes org-wide linked publishing at the time you read this):

- **Settings → Linked publishers / Trusted Publishers → Add GitHub Action.**
- **Repository owner:** `agaaaptr`
- **Repository name:** `noir`
- **Workflow filename:** `release.yml` (the file in `.github/workflows/`)
- **Environment:** `release` (must match the `environment:` on the publish job in `release.yml`)
- Leave the custom claims empty unless you know you need them.

> Repeat for all 10 packages. This mapping is the only thing that authorizes CI to publish — keep it pointed at exactly `agaaaptr/noir` + `release.yml` + `release`.

### 1c. On GitHub

1. **Make the repo public** (`agaaaptr/noir`) — provenance requires a public source repo. If you keep it private, drop `--provenance` and accept weaker attestations.
2. **Create the `release` environment** (Repo settings → Environments → New environment → `release`). You may add required reviewers here so a human approves each publish job before it runs. This is optional but recommended.
3. **No secrets to add.** Specifically, do **not** add `NPM_TOKEN`. The job uses `permissions: id-token: write` and the npm CLI obtains auth via OIDC.

### 1d. Local machine

- Node ≥ 20, pnpm (the version pinned in the root `package.json` `packageManager` field).
- `npm` CLI ≥ 9.5 (for provenance support) — comes with Node 20+.
- You must have push + tag-push rights on `agaaaptr/noir`.

---

## 2. Cutting a release (stable, from `main`)

> All 10 packages move together. The version you bump is the version that ships. This is the **stable** flow; the beta flow is in [§2b](#2b-beta-vs-stable-channels).

```bash
# 0. Start from an up-to-date main, clean tree.
git checkout main
git pull --ff-only

# 1. Bump the unified version in all 10 package.json files.
#    (Choose the bump per §3 semver policy. Example: first public release → 1.0.0.)
node scripts/bump-version.mjs 1.0.0
#    equivalent: pnpm release:bump 1.0.0

# 2. (Recommended) update docs/CHANGELOG.md for the release.

# 3. Review the diff — it should be 10× one-line "version" bumps (+ changelog).
git diff

# 4. Commit + tag. The tag name is the signal CI listens for.
git add -A
git commit -m "chore(release): v1.0.0"
git tag v1.0.0

# 5. Push the commit AND the tag. The tag push is what triggers release.yml.
git push origin main
git push origin v1.0.0
```

### What CI does next (`.github/workflows/release.yml`)

1. Checks out the tagged commit.
2. Sets up Node 22 + pnpm; `pnpm install --frozen-lockfile`.
3. `pnpm lint` → `pnpm typecheck` → `pnpm build` (all 10 packages → `dist/`).
4. **Derives the channel** from the branch (see [§2b](#2b-beta-vs-stable-channels)): if the tagged commit is reachable from `origin/main`, dist-tag = `latest` (stable); otherwise `beta`. For the §2 flow that is always `latest`.
5. Packs, then publishes, all 10 packages. This is a deliberate **two-step** flow (see `.github/workflows/release.yml`):
   1. **Pack** — `pnpm -r --filter './packages/*' pack`
      - `pnpm pack` (NOT `npm pack`) **rewrites `workspace:*` dependency ranges to concrete versions** inside the tarballs, so the published packages resolve on install. `npm publish` does **not** rewrite workspace ranges on its own.
   2. **Publish** — for each packed `*.tgz`: `npm publish "$tgz" --provenance --access public --tag "$DIST_TAG"`
      - `npm publish` (NOT `pnpm publish`) is used because **`pnpm publish` does not support `--provenance`**. `npm publish` is the step that attaches the SLSA attestation via the GitHub OIDC ↔ npm Trusted Publishing link (§1).
      - `--provenance` attaches the SLSA attestation (requires `permissions: id-token: write`).
      - `--access public` overrides the scoped-package default of private (also enforced via `publishConfig.access:"public"` in each `package.json`).
      - `--tag "$DIST_TAG"` sets the npm dist-tag — `latest` for stable, `beta` for beta. This is how `npm i @noir-ai/cli` (stable) vs `npm i @noir-ai/cli@beta` (beta) resolve to different versions.
6. The job runs on the `release` environment (the one you linked on npm).

> If you enabled a required reviewer on the `release` environment, the publish job waits for approval in the GitHub Actions UI before running `npm publish`.

---

## 2b. Beta vs stable channels

Noir ships **two release channels in parallel**, both cut as git tags and both published by the same `release.yml`. They differ in (a) which branch the tag lives on, (b) the npm dist-tag applied at publish time, (c) the version string, and (d) what consumers type to opt in.

### The model

| | Stable | Beta |
|---|---|---|
| **Tag lives on** | `main` | `develop` |
| **npm dist-tag** | `latest` (the default) | `beta` (opt-in) |
| **Version scheme** | `X.Y.Z` | `X.Y.Z-beta.N` (prerelease, `-beta.N` suffix) |
| **Consumer install** | `npm i @noir-ai/cli` | `npm i @noir-ai/cli@beta` |
| **Audience** | Everyone | Early testers willing to hit rough edges |
| **Promotion path** | — | Merge `develop` → `main`, then cut a stable tag with the same `X.Y.Z` (no `-beta.N`) |

A dist-tag is **just a movable label** npm keeps alongside the immutable versions. `latest` and `beta` are independent pointers: each can be moved forward by publishing a new tag without affecting the other. Consumers who type `@noir-ai/cli` get whatever `latest` points at; consumers who type `@noir-ai/cli@beta` get whatever `beta` points at; either can also pin an exact version (`@noir-ai/cli@1.2.3`).

### How CI derives the channel from the branch

The publish job in `.github/workflows/release.yml` decides the dist-tag from **which branch holds the tagged commit**, not from anything in the version string or tag name:

```yaml
- name: Determine release channel (tag on main → latest/stable; else → beta)
  id: channel
  run: |
    SHA="${{ github.sha }}"
    # `git branch -r --contains` lists remote branches holding the tagged commit.
    if git branch -r --contains "$SHA" 2>/dev/null | grep -q 'origin/main'; then
      echo "tag=latest"     >> "$GITHUB_OUTPUT"
      echo "channel=stable" >> "$GITHUB_OUTPUT"
    else
      echo "tag=beta"   >> "$GITHUB_OUTPUT"
      echo "channel=beta" >> "$GITHUB_OUTPUT"
    fi
```

That single `if` is the whole channel switch. Consequences:

- **The branch IS the channel.** A tag reachable from `origin/main` → `latest`. Anything else (typically `develop`) → `beta`. There is no `--channel` flag and no per-package config.
- **Beta tags never leave `develop`** until you merge to `main`. Cutting `v1.3.0-beta.4` on `develop` publishes under `beta`; when `develop` merges to `main` and you cut `v1.3.0` there, the same content ships under `latest`.
- **Semver-style tag names are not parsed** for the channel — only the branch matters. A `v1.3.0-beta.4` tag pushed on `main` by mistake would publish as `latest`. Keep beta tags on `develop`.

### Cutting a beta release (from `develop`)

The mechanical mirror of the §2 stable flow, on `develop` and with the prerelease version:

```bash
# 0. Start from an up-to-date develop, clean tree.
git checkout develop
git pull --ff-only

# 1. Bump to the prerelease version. The -beta.N suffix is what marks it prerelease.
node scripts/bump-version.mjs 1.3.0-beta.4
#    equivalent: pnpm release:bump 1.3.0-beta.4

# 2. (Recommended) add a CHANGELOG entry under an "Unreleased / beta" heading.

# 3. Review the diff — 10× one-line version bumps (+ changelog).
git diff

# 4. Commit + tag. The tag name still starts with v, but carries the prerelease suffix.
git add -A
git commit -m "chore(release): v1.3.0-beta.4"
git tag v1.3.0-beta.4

# 5. Push commit + tag. CI derives channel=beta (the commit is on develop, not main).
git push origin develop
git push origin v1.3.0-beta.4
```

After the `release.yml` job goes green:

```bash
npm view @noir-ai/cli dist-tags.beta   # → 1.3.0-beta.4
npm i -g @noir-ai/cli@beta             # opt in
```

### Promoting beta → stable

When the beta line is ready to ship to everyone:

1. Merge `develop` into `main` (`git checkout main && git merge --ff-only develop && git push origin main`).
2. Bump to the stable version (drop the `-beta.N` suffix):

   ```bash
   git checkout main
   node scripts/bump-version.mjs 1.3.0      # same X.Y.Z, no prerelease suffix
   git add -A && git commit -m "chore(release): v1.3.0"
   git tag v1.3.0
   git push origin main && git push origin v1.3.0
   ```

3. CI derives `channel=stable` (commit is on `main`), publishes under `latest`. Now `npm i @noir-ai/cli` resolves to `1.3.0`; `npm i @noir-ai/cli@beta` keeps resolving to whatever the `beta` tag last pointed at (typically the last beta — move it forward with the next beta tag, or leave it).

### Irreversibility reminder for pre-releases

Everything in [§4 Irreversibility rules](#4-irreversibility-rules--safety) applies to prereleases identically — with three sharpenings:

1. **`X.Y.Z-beta.N` versions are immutable too.** Once `@noir-ai/cli@1.3.0-beta.4` is published, that exact `name@version` is occupied forever, even after the stable `1.3.0` ships. A broken beta means **bump to `-beta.5`** — never republish `-beta.4`.
2. **Dist-tag moves are reversible; version publishes aren't.** You can `npm dist-tag rm @noir-ai/cli beta && npm dist-tag add @noir-ai/cli@1.3.0-beta.3 beta` to roll the `beta` pointer back if `-beta.4` was bad. The published `-beta.4` tarball stays on the registry (deprecate it with `npm deprecate`); only the label moves.
3. **Never republish the same version as a "fix".** A typo in `-beta.4` ships as `-beta.5`, full stop. There is no overwrite path, on stable or beta.

See [installation.md](installation.md) for the consumer-side view of these two channels.

---

## 3. Semver policy (unified)

Noir ships a **single** version across all 10 packages. The bump level reflects the **most significant** change anywhere in the toolkit this release:

| Change | Bump | Examples |
|---|---|---|
| **Breaking** public API, CLI flag, config schema, `.noir/` layout, or MCP tool shape | **major** | Renaming a CLI command; a required `config.yml` field; removing/renaming an exported symbol; an MCP tool's input schema change. |
| **New** capability, tool, or exported surface (backward-compatible) | **minor** | A new MCP tool; a new `noir <subcommand>`; a new optional config block; a new package. |
| **Fix / perf / docs** (no behavior contract change) | **patch** | Bug fixes, dependency bumps within range, test/doc changes. |

Rules:

- **All 10 move together.** Even a change that only touches one package bumps the unified version for every package. This is deliberate: consumers install the toolkit, not loose fragments, and a single shared version removes the "is `@noir-ai/store@1.2.0` compatible with `@noir-ai/context@1.1.0`?" question.
- **Pre-1.0 caveat:** while the version is `0.x`, minors may include breaking changes (per the loose pre-1.0 convention). Call them out in the changelog regardless. The **first public release is `1.0.0`**; from there the table above is binding.
- **When in doubt, bump higher** and document it.

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

# 5b. All 10 are at the same version.
for p in core store workflow skills daemon adapters cli context model memory; do
  printf "@noir-ai/%s\t%s\n" "$p" "$(npm view @noir-ai/$p version)"
done

# 5c. Smoke install + run (the end-user path).
npx @noir-ai/cli@1.0.0 --version
npx @noir-ai/cli@1.0.0 init --help
```

Optionally, in a throwaway project:

```bash
mkdir /tmp/noir-smoke && cd /tmp/noir-smoke
npx @noir-ai/cli@1.0.0 init     # scaffolds .noir/ + emits the 31 builtin skills + host wiring
ls -la .noir .claude/skills      # confirm artifacts
```

If any package is missing or at the wrong version, **do not republish** — cut a patch release that corrects the drift (§3/§4).

---

## 6. First-release checklist

The very first release (`1.0.0`) has extra gating. Do not cut it until every box is checked.

**Setup (§1)**
- [ ] `@noir-ai` org created on npmjs.com.
- [ ] 2FA required at the org level.
- [ ] **No** long-lived publish token created (deliberate).
- [ ] Trusted Publisher linked for **all 10** packages: repo `agaaaptr/noir`, workflow `release.yml`, environment `release`.
- [ ] Repo `agaaaptr/noir` is **public**.
- [ ] `release` environment created on GitHub (optional required-reviewer added).
- [ ] **No `NPM_TOKEN` secret** in the repo or env.

**Readiness (§2 / §4)**
- [ ] `pnpm lint && pnpm typecheck && pnpm build && pnpm test` all green on `main` (target the same Node 22 the CI uses).
- [ ] Every `packages/*/package.json` has `publishConfig: { access:"public", provenance:true }`, `engines.node >=20`, a one-line `description`, valid `repository`/`bugs`/`homepage`, and `files` including `dist` (+ `README.md`, and `builtin/` for skills).
- [ ] `npm publish --dry-run` in `packages/cli` and at least one library package is sane (correct files, **no `src/`/tests/secrets**).
- [ ] `docs/CHANGELOG.md` has a `1.0.0` entry.

**Cut (§2)**
- [ ] `node scripts/bump-version.mjs 1.0.0`; verify all 10 are `1.0.0` and identical.
- [ ] Commit + tag `v1.0.0`; push commit and tag.
- [ ] `release.yml` run on the `release` environment goes green; all 10 publishes succeed.

**Verify (§5)**
- [ ] `npm view @noir-ai/cli version` → `1.0.0`.
- [ ] All 10 packages resolve at `1.0.0`.
- [ ] `npx @noir-ai/cli@1.0.0 --version` runs; `npm view … dist.attestation` (or the npm UI) shows provenance.
- [ ] GitHub **Release** notes published from the tag, summarizing the 10 packages + changelog.

---

## 7. Reference: the release bump one-liner

```bash
# Bump, commit, tag, push (the whole human side of a release):
node scripts/bump-version.mjs <X.Y.Z>   # or: pnpm release:bump <X.Y.Z>
git add -A && git commit -m "chore(release): v<X.Y.Z>"
git tag v<X.Y.Z>
git push origin main && git push origin v<X.Y.Z>
```

The tag push hands off to `.github/workflows/release.yml`. You're done.
