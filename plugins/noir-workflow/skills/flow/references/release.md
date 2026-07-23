# /flow Phase 7 — Angular v13 `@uiigateway/*` release

**Detect:** root `package.json` has `@angular/core` `~13.x`/`^13.x`, AND a `projects/<scope>/<lib>/package.json` with a `version` field, AND its `name` matches `@uiigateway/*`. If not → skip (not a release target).

If yes → `AskUserQuestion`: version action `patch` / `minor` / `major` / `next-pre-release` / `skip` (show the current plain version).
- `patch`/`minor`/`major` → new plain version (suffix resets to 0).
- `next-pre-release` → same plain version, suffix +1 (`b0→b1`, `rc0→rc1`).
- `skip` → do nothing.

## Steps (once an action is chosen)
1. **Determine the tag first** (needed for the CHANGELOG note). Branch: `git rev-parse --abbrev-ref HEAD`. Suffix kind: `develop`→`b`, `staging`→`rc`, `master`→none (plain), other→`AskUserQuestion`. **Counter N:** `git tag -l "<target>-<kind>*"`; parse the integer after `<kind>` from each match; `N = max + 1`, or `0` if none — compare **numerically** (`b10` > `b9`; a new plain version has no matching tags → resets to `0`). Tag = `<target>-<kind><N>` (develop/staging) or `<target>` (master).
2. **(patch/minor/major)** Edit the lib `package.json` to the new **plain** version; prepend a **Keep a Changelog** entry to `CHANGELOG.md` — `## [<new plain version>] - <YYYY-MM-DD>`, a `> Published as: \`<tag>\` (<branch>) — see VERSIONS.md for per-env status.` line, then changes under `### Added` / `### Changed` / `### Fixed` / `### Removed` (omit empty). Commit both: `chore: bump version to <new version>`. **(next-pre-release)** leave `package.json` unchanged; optionally append a `Published as: <tag>` line to the existing version's entry (confirm with user).
3. **Confirm push** (plugin `references/commit-push.md`). On confirm: `git push origin <branch>`; then `git tag -a "<tag>" -m "release: <target>"`; `git push origin "<tag>"`.

CI derives the published version from the tag (`npm version --no-git-tag-version --allow-same-version "$CI_COMMIT_TAG"`) — the committed `package.json` stays plain. See the project's `GITLAB-CI-VERSIONING-GUIDE.md` (if present) for the full model.
