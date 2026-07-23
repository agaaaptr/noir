# Commit / Push Discipline + CI-aware Post-push

Every push-capable skill (`/flow`, `/wrap`) follows this.

## Commit
- **Per scope** (conventional commits: `feat` / `fix` / `docs` / `chore` / `refactor`). Never bundle unrelated changes into one commit.
- Scope plugin changes: `feat(noir-workflow): …`.

## Push
- Push **requires explicit user confirmation** — never auto-push.
- Confirm the branch + the commits about to be pushed before each push.

## Post-push action (CI-aware, no assumption)
After a confirmed push, read the project's CI config to decide the relevant next action:
1. **Detect CI:** `.gitlab-ci.yml`, `.github/workflows/*.yml`, `.circleci/config.yml`, `Jenkinsfile`, …
2. **Determine the release mechanism** from the config:
   - **Tag-publish** (publish/deploy triggered by a version tag): GitLab `rules: $CI_COMMIT_TAG` / `only: tags`; GitHub `on: push: tags:`. → ask "tag a version?" (run the version-bump + tag flow).
   - **Auto-deploy** (deploy triggered by branch push): deploy job on `develop` / `staging` / `master`. → do **not** ask about a tag; note "CI will auto-deploy".
   - **Both / neither / unknown** → ASK the user what the release flow is.
3. **Corroborate with project type:**
   - FE Angular `@uiigateway/*` library → tag-publish → offer version-bump + tag.
   - BE service (`go.mod` → Go; `composer.json` → PHP / Lumen / Laravel) → auto-deploy → no tag.
4. **Never assume** — if the CI config is unclear, ask.

## Version-bump + tag flow
For tag-publish projects → the `/flow` Phase 7 procedure (tag-first; plain `package.json` version; counter `N = max+1`/`0`, numeric; env suffix `-bN`/`-rcN`/plain per branch). See `/flow` `references/release.md`.
