# Releasing Noir

> **Runbook for publishing the `@noir-ai/*` packages to npm.** Noir uses **unified versioning**: all 10 packages share one version and are released together, on a git tag, from CI, using **OIDC Trusted Publishing + SLSA provenance** — with **no long-lived npm token** stored anywhere in the repo.
>
> Audience: a maintainer cutting a release. **Read the [Irreversibility rules](#4-irreversibility-rules--safety) before the first publish.**

---

## 0. Model (read once)

- **Scope:** `@noir-ai/{core, store, workflow, skills, daemon, adapters, cli, context, model, memory}` — 10 packages.
- **Unified versioning:** every release moves all 10 packages to the same version in lockstep. There are no per-package releases.
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

## 2. Cutting a release

> All 10 packages move together. The version you bump is the version that ships.

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
4. Publishes all 10 packages: `pnpm -r publish --access public --provenance --no-git-checks`
   - `--provenance` attaches the SLSA attestation (requires `permissions: id-token: write`).
   - `--no-git-checks` lets pnpm publish despite CI-side git state.
   - `publishConfig.access:"public"` in each `package.json` makes the scoped packages public.
   - `workspace:*` dependency ranges are rewritten to concrete versions automatically by pnpm at publish time.
5. The job runs on the `release` environment (the one you linked on npm).

> If you enabled a required reviewer on the `release` environment, the publish job waits for approval in the GitHub Actions UI before running `npm publish`.

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
