# Environment Variables

Every environment variable Noir reads, grouped by function. This is the
single reference — feature pages link here instead of restating defaults.

> **Precedence.** `.noir/.env` **wins for every key it defines**; the real
> environment is the fallback for the keys the file does not define:
>
> ```
> 1. run profile env   run.profiles.<n>.env          (per-invocation; merges OVER)
> 2. .noir/.env        <- recommended home for project-scoped configuration
> 3. real environment  CI / container / launchd / shell rc
> 4. built-in default
> ```
>
> A machine-global export therefore **cannot shadow** `.noir/.env`. There is no
> `VAR=value noir …` prefix level: a one-shot prefix arrives in `process.env`
> indistinguishably from the inherited environment, so it *is* level 3, not an
> override above the file — use a `run.profiles.<n>.env` entry when you need a
> real per-invocation value. Two further consequences worth knowing: a
> git-*tracked* `.noir/.env` is refused outright (none of its keys are in
> effect), and `noir env` shows which source won for each key. This is a
> deliberate departure from the 12-factor convention — the project file
> describes the project, so it outranks the ambient environment.
>
> **Changed in 1.14.0.** This order is the *inverse* of what 1.12.0/1.13.0
> shipped, where the file filled only unset keys ("real env wins"). If the same
> key is set in both places, you now get the **file's** value — and the loader
> prints one line naming that key the first time it loads the file, so the change
> announces itself rather than being discovered. Run `noir env` to see the winner
> for every key. Nothing is rewritten automatically.
>
> **Where env vars come from.** Level 3 *is* the environment the CLI and daemon
> inherit from the process that launched them. From an interactive terminal,
> exports in `~/.zshrc` / `~/.bashrc` work. From a GUI-launched host (VS Code, a
> desktop MCP client), CI, or launchd, shell rc files are **not** sourced — the
> machine-global fallbacks there are the `env` block in
> `~/.claude/settings.json` and `~/.zshenv`. The project-local `.noir/.env`
> (level 2) is the one placement that works in every launch mode, which is why
> it is the recommended home. Restart the daemon after changing a token — the
> daemon's env is a snapshot taken at spawn time.
>
> **How-to:** [Configuring a project with `.noir/.env`](../how-to/configure-env.md)
> — the full precedence chain, what belongs in the file, and `noir env` for
> seeing which source is winning for each key.

## Integrations (opt-in)

| Variable | Default | Required | Description |
|---|---|---|---|
| `CLICKUP_API_TOKEN` | — | conditional — required only when the **noir-clickup** integration is enabled (see [ClickUp how-to](../how-to/clickup.md)) | ClickUp personal token (`pk_...`). Resolved by the daemon at call time. Put it in `.noir/.env` — the recommended project-scoped home, and the winner for every key it defines. Machine-global fallbacks: the `env` block of `~/.claude/settings.json`, or `~/.zshenv` (NOT `.zshrc` — non-interactive shells skip it). **Restart the daemon after changing it.** |

> **`CLICKUP_TEAM_ID` is NOT an env var** — Noir never reads it. Workspace
> binding (team/list/space ids) is configured as config.yml keys:
> `integrations.clickup.teamId` / `.listId` / `.spaceId` (see
> [Configuration](config.md)).

## Run profile selection

| Variable | Default | Required | Description |
|---|---|---|---|
| `NOIR_PROFILE` | — | no | Selects a `run.profiles` entry for `noir run`. Precedence: `--profile` flag > `NOIR_PROFILE` > `run.defaultProfile` > built-in host default. |

## Model provider + embedder keys

Provider keys are **named** in config (`model.providers.<name>.apiKeyEnv`), and
the **value** is read at call time from the resolved environment — the config
stores the var NAME, never the secret. Example: `apiKeyEnv: ANTHROPIC_API_KEY`
reads the `ANTHROPIC_API_KEY` environment variable. `apiKeyEnv` is a bare name,
never an interpolation: `apiKeyEnv: ${ANTHROPIC_API_KEY}` resolves
`process.env['${ANTHROPIC_API_KEY}']` → `undefined` → a provider with no key,
silently. (Only `run.profiles.<name>.env` interpolates `${VAR}`.) Anonymous
local providers (Ollama, LM Studio) omit `apiKeyEnv`.

Place the **value** in `.noir/.env` — recommended, since it is project-scoped,
`0600`, gitignored and the winner for every key it defines — or in the real
environment for a machine-wide value (see
[Configuring a project with `.noir/.env`](../how-to/configure-env.md)).

Remote embedders read their key by provider name (only when
`context.embedder.kind` is `remote`):

| Variable | Default | Required | Description |
|---|---|---|---|
| `OPENAI_API_KEY` | — | conditional — `context.embedder.kind: remote` + `provider: openai` | OpenAI embedder key. |
| `VOYAGE_API_KEY` | — | conditional — `provider: voyage` | Voyage embedder key. |
| `COHERE_API_KEY` | — | conditional — `provider: cohere` | Cohere embedder key. |

The local Ollama embedder (`context.embedder.kind: ollama`) reads its base URL
from config (`context.embedder.baseURL`), falling back to this variable (empty
unset means "baseURL required"):

| Variable | Default | Required | Description |
|---|---|---|---|
| `OLLAMA_BASE_URL` | — (unset) | conditional — `context.embedder.kind: ollama` | Ollama base URL fallback (e.g. `http://localhost:11434`). |

## Updates

| Variable | Default | Required | Description |
|---|---|---|---|
| `NOIR_DISABLE_UPDATE_CHECK` | — | no | **Present** (even empty) suppresses the **background** startup version check only; `noir update` still works. (`CI` also disables the background check.) |
| `NOIR_DISABLE_UPDATES` | — | no | **Present** (even empty) makes `noir update` refuse (exit 2). |

## Terminal / output behavior

| Variable | Default | Required | Description |
|---|---|---|---|
| `NO_COLOR` | — | no | Present **and non-empty** disables color AND interactive prompts (the NO_COLOR spec). |
| `CLICOLOR_FORCE` | — (unset; auto) | no | Set to `1` to force color on even under a pipe or `CI` — the escape hatch for CI/log captures. |
| `CI` | — | no | Forces color off + non-interactive behavior. Set `CI=0` or `CI=false` to opt out of the detection. |
| `COLUMNS` | 80 (floored at 20) | no | Terminal-width override used by responsive tables and the TUI width budget. |
| `NOIR_NO_BANNER` | — | no | Non-empty suppresses the startup banner even in an interactive terminal. |
| `NOIR_ACCESSIBLE` | — | no | Non-empty swaps the banner gradient for a solid accent (accessibility). |
| `NOIR_NON_INTERACTIVE` | set by `--json` / `--no-input` | no | Propagates the "no prompts" decision into engines that never read `process.env` themselves. Can also be exported directly. |
| `NOIR_DISABLE_TUI_HISTORY` | — | no | Non-empty makes palette recents in-memory only (no `~/.noir/<projectId>/tui-history.json`). |

## Advanced / test-only seams

These are plumbing overrides — documented for completeness; most users never
need them.

| Variable | Default | Required | Description |
|---|---|---|---|
| `NOIR_NODE_DIST_URL` | `https://nodejs.org/dist/` | no | Node dist mirror URL for the native installer's managed-Node provisioning. |
| `NOIR_SYSTEM_NODE_BIN` | — | no | Hard override for the system-Node probe (managed-Node fallback in the native installer / `provisionManagedNode`). |
| `NOIR_SKIP_NODE_PROVISION` | — | no | Set **and non-empty** makes the native installer (`install.sh` / `install.ps1`) skip managed-Node provisioning and use system Node ≥ 22 only. Also the remedy the installer prints when `npm install` fails. |
| `NOIR_CHANNEL` | `latest` | no | npm dist-tag for `install.sh` / `install.ps1` (`beta` selects the beta channel). |
| `NOIR_VERSION` | — | no | Pin an exact version for `install.sh` / `install.ps1` (overrides `NOIR_CHANNEL`). |
| `NOIR_RUNTIME_DIR` | `~/.noir/runtime` | no | Overrides the managed runtime directory. |
| `NOIR_DAEMON_DIR` | `~/.noir/daemons` | no | Overrides the directory holding the per-project daemon records (`<projectId>.json`) and their `0600` bearer tokens (`<projectId>.token`). Primary use is test isolation — a normal run never sets it, and it is **refused from `.noir/.env`** (redirecting it would point Noir at someone else's records). |
| `NOIR_DAEMON_JSON` | `~/.noir/daemon.json` | no | **Legacy only** — the pre-1.14 single global daemon record. Read exactly once by the self-deleting migration (`retireLegacyDaemonRecord`) when it retires a daemon from a previous version, then the file is deleted and no code path reads this path again. It does **not** relocate the current per-project records; that is `NOIR_DAEMON_DIR`. |
| `NOIR_INSTALL_JSON` | `~/.noir/install.json` | no | Overrides the install-record path. |
| `NOIR_WORKSPACES_DIR` | `~/.noir/workspaces` | no | Overrides the user-global workspace root (the shared-workspace registry, store, and daemon record). |
| `NOIR_UPDATE_CACHE_JSON` | `~/.noir/update-cache.json` | no | Overrides the update-cache path. |
| `NOIR_MCP_COMMAND` | — | no | Overrides the command written into `.mcp.json`. **Test seam** — not a supported user knob. |
| `NOIR_DAEMON_MODE` | — | no | Internal — the `--detach` daemon child sets it to `detached` so the daemon record self-reports its mode. Not a user knob. |
| `NOIR_TEMPLATES_DIR` | — | no | Overrides the scaffold template directory (downstream packs). |
| `NOIR_TEST_FORCE_CONFLICT` | — | no | Forces scaffold conflict behavior (test seam). |

### Keys refused from `.noir/.env`

Two classes of name are **never** read from `.noir/.env`, even when the file
defines them:

- **A git-tracked file.** If `.noir/.env` is tracked by git, the whole file is
  refused — none of its keys are in effect. Remedy: add `.noir/.env` to
  `.gitignore` (Noir's managed block already does) and
  `git rm --cached .noir/.env`.
- **The process-injection deny-list.** `NODE_OPTIONS`, `NODE_PATH`,
  `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`, `npm_config_*`, `COREPACK_*`, and
  Noir's own plumbing names (`NOIR_DAEMON_DIR`, `NOIR_RUNTIME_DIR`,
  `NOIR_MCP_COMMAND`, …) are ignored with a one-line warning. Noir spawns Node
  children (the daemon, the host), so a file that arrived inside a cloned
  repository must not be able to inject into them.

`noir doctor`'s `noir-env` check reports the file's permissions and warns when
it is tracked by git; `noir env` lists only the keys that actually won. Full
detail: [Configuring a project with `.noir/.env`](../how-to/configure-env.md).

## Secrets policy

- **Never commit tokens.** `.noir/.env` is gitignored by the managed
  `.gitignore` block; `.noir/config.yml` is committable project state — never
  paste a literal secret into it.
- **`apiKeyEnv` stores a NAME, never an interpolation.** Write
  `apiKeyEnv: ANTHROPIC_API_KEY`; the model layer reads
  `process.env[<that name>]` at call time, so `apiKeyEnv: ${ANTHROPIC_API_KEY}`
  resolves `process.env['${ANTHROPIC_API_KEY}']` → `undefined` → a provider
  with no key, silently. Only `run.profiles.<name>.env` in `config.yml`
  interpolates `${VAR}`.
- **Put the value in `.noir/.env`** — the recommended home: project-scoped,
  `0600`, gitignored, and the winner for every key it defines. The
  machine-global fallbacks are the `env` block of `~/.claude/settings.json`
  (for GUI-launched daemons) and `~/.zshenv` (non-interactive shells);
  `~/.zshrc` is the least reliable (interactive only).
- Keep `.noir/.env` private (`chmod 600`); `noir doctor` warns if it is
  group/world-readable, and warns — naming the remedy — if it is tracked by
  git.
- Never pass tokens as CLI arguments (they are visible in process lists).
- Use clearly fake placeholders in docs and examples (`pk_...`, `sk-...`).
