# Environment Variables

Every environment variable Noir reads, grouped by function. This is the
single reference — feature pages link here instead of restating defaults.

> **Precedence.** A real environment variable **always wins** over the project
> file: `.noir/.env` (and any config value) only fills keys that are unset. This
> is the 12-factor convention — the environment is the source of truth, the
> project file is a fallback.
>
> **Where env vars come from.** The CLI and daemon inherit the environment of
> the process that launched them. From an interactive terminal, exports in
> `~/.zshrc` / `~/.bashrc` work. From a GUI-launched host (VS Code, a desktop MCP
> client), CI, or launchd, shell rc files are **not** sourced — the most
> reliable placement is the `env` block in `~/.claude/settings.json`, or the
> project-local `.noir/.env` (see [Configuration](config.md)). Restart the daemon
> after changing a token — the daemon's env is a snapshot taken at spawn time.

## Integrations (opt-in)

| Variable | Default | Required | Description |
|---|---|---|---|
| `CLICKUP_API_TOKEN` | — | conditional — required only when the **noir-clickup** integration is enabled (see [ClickUp how-to](../how-to/clickup.md)) | ClickUp personal token (`pk_...`). Resolved by the daemon at call time; set it via `~/.claude/settings.json` `env`, `~/.zshenv` (NOT `.zshrc`), or `.noir/.env`. **Restart the daemon after changing it.** |

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
the **value** is read from the environment at call time — the config stores the
var NAME, never the secret. Example: `apiKeyEnv: ANTHROPIC_API_KEY` reads the
`ANTHROPIC_API_KEY` environment variable. Anonymous local providers (Ollama,
LM Studio) omit `apiKeyEnv`.

Remote embedders read their key by provider name (only when
`context.embedder.kind` is `remote`):

| Variable | Default | Required | Description |
|---|---|---|---|
| `OPENAI_API_KEY` | — | conditional — `context.embedder.kind: remote` + `provider: openai` | OpenAI embedder key. |
| `VOYAGE_API_KEY` | — | conditional — `provider: voyage` | Voyage embedder key. |
| `COHERE_API_KEY` | — | conditional — `provider: cohere` | Cohere embedder key. |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | no | Ollama base URL used as the embedder baseURL fallback. |

## Updates

| Variable | Default | Required | Description |
|---|---|---|---|
| `NOIR_DISABLE_UPDATE_CHECK` | — | no | Non-empty suppresses the **background** startup version check only; `noir update` still works. (`CI` also disables the background check.) |
| `NOIR_DISABLE_UPDATES` | — | no | Non-empty makes `noir update` refuse (exit 2). |

## Terminal / output behavior

| Variable | Default | Required | Description |
|---|---|---|---|
| `NO_COLOR` | — | no | Present **and non-empty** disables color AND interactive prompts (the NO_COLOR spec). |
| `CLICOLOR_FORCE` | `1` | no | Forces color on even under a pipe or `CI` — the escape hatch for CI/log captures. |
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
| `NOIR_NODE_DIST_URL` | — | no | Node dist mirror URL for the native installer's managed-Node provisioning. |
| `NOIR_RUNTIME_DIR` | `~/.noir/runtime` | no | Overrides the managed runtime directory. |
| `NOIR_DAEMON_JSON` | `~/.noir/daemon.json` | no | Overrides the daemon record path. |
| `NOIR_INSTALL_JSON` | `~/.noir/install.json` | no | Overrides the install-record path. |
| `NOIR_UPDATE_CACHE_JSON` | `~/.noir/update-cache.json` | no | Overrides the update-cache path. |
| `NOIR_MCP_COMMAND` | — | no | Overrides the command written into `.mcp.json`. **Test seam** — not a supported user knob. |
| `NOIR_TEMPLATES_DIR` | — | no | Overrides the scaffold template directory (downstream packs). |
| `NOIR_TEST_FORCE_CONFLICT` | — | no | Forces scaffold conflict behavior (test seam). |

## Secrets policy

- **Never commit tokens.** `.noir/.env` is gitignored by the managed
  `.gitignore` block; `.noir/config.yml` is committable project state — use
  `${VAR}` references there, never literal secrets.
- Prefer the `env` block of `~/.claude/settings.json` for host-launched
  daemons, or `.noir/.env` for project-local tokens. `~/.zshenv` works for
  non-interactive shells; `~/.zshrc` is the least reliable (interactive only).
- Keep `.noir/.env` private (`chmod 600`); `noir doctor` warns if it is
  group/world-readable.
- Never pass tokens as CLI arguments (they are visible in process lists).
- Use clearly fake placeholders in docs and examples (`pk_...`, `sk-...`).
