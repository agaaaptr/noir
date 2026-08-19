# Running with multiple host profiles

`noir run <prompt>` drives a host agentic CLI headless (Claude Code by default).
If you have more than one host setup — two Claude Code installs, a work profile
and a personal one, a different binary per project — define them as **run
profiles** instead of typing `--command` every time.

> **Aliases don't work.** `noir run --command my-alias` fails with ENOENT when
> `my-alias` is a shell alias or function: `spawn()` does not go through the
> shell, so aliases/functions from `.zshrc` are invisible. Use an executable on
> `PATH`, an absolute path, a launcher script in `~/.local/bin/`, or a profile
> below. (Noir can resolve PATH entries and aliases through your interactive
> shell automatically when they only exist there — see the note at the end.)

## 1. Define profiles

```yaml
# .noir/config.yml
run:
  defaultProfile: work            # optional fallback
  profiles:
    work:
      binary: /Users/me/bin/claude-work
      env:
        CLAUDE_CONFIG_DIR: /Users/me/.claude-work   # profile-scoped config dir
    lab:
      binary: claude
      args: ['--strict-output-mode']
```

| Field | Type | Default | Description |
|---|---|---|---|
| `binary` | string | required | The executable to spawn. An absolute path or a name on `PATH`. |
| `env` | map<string,string\|null> | `{}` | Merged over the inherited environment before spawn. `null` **deletes** a variable; `KEY: ${KEY}` references your own env value — never store literal secrets here. |
| `args` | string[] | `[]` | Extra args appended after the host's headless flags. |

Profile names allow `[A-Za-z0-9_-]` only.

## 2. Select

Precedence: **`--profile <name>` flag > `NOIR_PROFILE` env var > `run.defaultProfile` > built-in host default.**

```bash
noir run --profile work "explain this repo"   # explicit
NOIR_PROFILE=lab noir run "…"                 # env var
noir run "…"                                  # falls back to defaultProfile
```

An explicitly named profile that does not exist is an **error** that lists the
available names — it never silently falls back.

## 3. List

```bash
noir run --list-profiles
#   NAME   DEFAULT   BINARY
#   work   *         /Users/me/bin/claude-work
#   lab               claude
```

## 4. Remove / edit

Edit `run.profiles` in `.noir/config.yml` (remove the block or the key).
There is no stored state — the config is the single source of truth.

## Security

`.noir/config.yml` is **committable project state**. Never paste a token into
`env`; write `ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}` and export the real value
in your shell / `.noir/.env` instead (see
[Environment Variables](../reference/environment.md)).

## Note: shell resolution fallback

If a `--command` / profile binary is genuinely missing, Noir probes your
interactive shell (`$SHELL`) to see whether the name is a PATH entry exported in
an rc file or an alias/function. PATH entries are re-spawned directly; aliases
and functions are bridged through the shell with the prompt passed **only as
argv** (never shell-parsed). This covers the "everything lives in `.zshrc`"
setup — but a launcher script remains the most predictable option.

Requirements + limits of the fallback: `$SHELL` must be set and be `zsh`,
`bash`, or `fish` (GUI/launchd-launched processes often lack `$SHELL` — a
launcher script or profile `binary` path is the reliable answer there); the
probe is skipped entirely on Windows and for names containing `/`; a hanging rc
file aborts the probe after ~3 s and surfaces the plain ENOENT error.
