# Configuring a project with `.noir/.env`

`.noir/.env` is the **recommended home for project-scoped configuration and
secrets** — the integration tokens, provider keys, and selection variables this
repository needs. Noir reads it in-process and applies it to its own
environment, so a value placed here is in effect for every Noir command and
every host/daemon Noir spawns, no matter how the process was launched
(terminal, GUI MCP client, launchd, CI).

`noir init` already created the file for you (mode `0600`, every line commented
out). This page covers what belongs in it, the precedence chain, how to see
what is actually in effect, recipes, and how it is kept safe.

## 1. What the file is for

**Belongs here — anything project-scoped:**

| Kind | Example key |
|---|---|
| Integration token (opt-in integrations) | `CLICKUP_API_TOKEN` |
| Model provider key — the variable your `apiKeyEnv` **names** | `ANTHROPIC_API_KEY` |
| Remote embedder key (`context.embedder.kind: remote`) | `OPENAI_API_KEY` |
| Run-profile host selection | `NOIR_PROFILE` |
| Update kill-switches | `NOIR_DISABLE_UPDATE_CHECK`, `NOIR_DISABLE_UPDATES` |

**Does not belong here:**

- **Machine-wide values.** The file is per-checkout and gitignored — each
  developer has their own. A value that must be identical on every machine
  belongs in the real environment (`~/.zshenv`, CI, a container env, launchd).
- **Per-user UI preferences.** `NO_COLOR`, `COLUMNS`, `NOIR_ACCESSIBLE`,
  `NOIR_NO_BANNER` describe *your session*, not the project — put them in your
  shell rc or your host's settings.
- **Structural project configuration.** Hosts, tiers, embedder kind, workspace
  ids, and run-profile binaries live in `.noir/config.yml`, which is
  committable project state. `.noir/.env` carries *values*, `config.yml`
  carries *shape*.

**The committable counterpart** is `.noir/.env.example`: the same variable set
with commented-out fake placeholders. It is documentation for the team and is
never loaded — keep it in git, keep the real file out.

## 2. Creating it

`noir init` writes both files:

| File | Mode | Purpose |
|---|---|---|
| `.noir/.env` | `0600` | the real, working file — created empty of values (every line commented) |
| `.noir/.env.example` | default | committable documentation of the format |

Because the seed has no active value, creating it changes no behaviour. Both
entries are `skipIfExists`, so re-running `noir init` (or `noir init --upgrade`)
never overwrites a file you have edited.

Creating it by hand — from an older project, or after deleting it:

```bash
touch .noir/.env && chmod 600 .noir/.env
```

It is already ignored: Noir's managed `.gitignore` block carries `/.noir/.env`
and `/.noir/.env.*`, with `!/.noir/.env.example` keeping the example visible.

## 3. Precedence

The rule: **`.noir/.env` wins for every key it defines; the real environment is
the fallback for the keys the file does not define.**

```
1. run profile env   run.profiles.<n>.env          (per-invocation; merges OVER)
2. .noir/.env        <- recommended home for project-scoped configuration
3. real environment  CI / container / launchd / shell rc
4. built-in default
```

A machine-global export therefore **cannot shadow** a value in this file. This
is a deliberate departure from the Node `--env-file` / dotenv convention
(fill-only-unset): for project configuration the project file must be able to
describe the project, otherwise a token exported from `~/.zshrc` silently
overrides the one you just put in the repository.

There is deliberately **no `VAR=value noir …` prefix level**. Such a prefix
lands in `process.env` indistinguishably from the inherited environment, so it
is level 3 — it cannot override this file. The genuine per-invocation override
is a `run.profiles.<n>.env` entry (level 1).

Shadows are not silent — when the file defines a key the environment *also*
defines with a **different** value, Noir emits one stderr line naming the key
and which source won. It never prints either value:

```
.noir/.env: 'CLICKUP_API_TOKEN' overrides the environment value for this run (run `noir env` to see every resolved key)
```

Scope: applying the file mutates **only Noir's own `process.env`** (and the
children it spawns). It never writes to a shell profile, never exports to the
parent, and never persists anything — so a manual `claude` invocation in your
terminal still sees your shell environment exactly as before. That is what
makes the "several Claude profiles with different API keys" setup keep working.

Two behaviours worth knowing before you write entries:

- **No interpolation in the file.** `.noir/.env` is data, not a script: `${VAR}`
  is a literal, and command substitution is not performed. (Only
  `run.profiles.<name>.env` in `config.yml` interpolates `${VAR}`.)
- **The parser is the documented Node `--env-file` dialect.** `KEY=VALUE` per
  line, `#` comments, an optional `export ` prefix, single/double quotes, blank
  `KEY=` for an empty value, last definition wins. A malformed line is skipped
  with a `file:line: reason` warning, never a crash.

## 4. Seeing what is in effect

`noir env` answers "which value is winning, and who supplied it?" — read-only,
and it prints **names and redacted shapes only, never a value**:

```
KEY                                       SOURCE                             VALUE
CLICKUP_API_TOKEN                         .noir/.env                         pk_…(24)
ANTHROPIC_API_KEY                         .noir/.env (shadows environment)   sk-…(20)
NOIR_PROFILE                              environment                        …(4)
OLLAMA_BASE_URL                           environment                        htt…(22)
```

| Column | Meaning |
|---|---|
| `KEY` | The variable name — safe to print; this is what you type. |
| `SOURCE` | The side that won. `.noir/.env` = the file defined it; `environment` = the file does not define it, so the ambient value (or the built-in default) applies; `.noir/.env (shadows environment)` = the file defined it **and** your environment had a different value, so the file is overriding something you may have forgotten about. |
| `VALUE` | The first three characters plus the length (`pk_…(42)`), so two tokens can be told apart without either being printed. A value of eight characters or fewer is shown as a length only — a short prefix would be the whole value. |

The report is curated, not a dump: it lists every key the file defines, plus
the Noir-relevant ambient names (`CLICKUP_API_TOKEN`, the `*_API_KEY` provider /
embedder keys, `OLLAMA_BASE_URL`, `NOIR_PROFILE`), plus any name the project's
own `model.providers.<name>.apiKeyEnv` asks for. Your whole shell environment
is neither listed nor an answer to the question.

`--json` emits the structured form — `{ok:true, data:{vars, warnings}}` with
`{key, source, shadowed?, valueLength}` rows — carrying even less than the
table (a length, never a shape). The command always exits 0: "your file is not
being loaded" is information, not a failure.

`noir doctor` reports the same provenance in its check list:

- `noir-env:<KEY>` — `from .noir/.env` for every key the file defines.
- `noir-env` — the file's permissions; a **warn** when it is group/world
  readable, and a **warn** naming the remedy when the file is tracked by git.
- `provider` — per configured provider, `key present (from .noir/.env)` when the
  winning source for that provider's `apiKeyEnv` is the file.

## 5. Common recipes

### Integration token — ClickUp

```bash
# .noir/.env                                  (gitignored — never commit)
CLICKUP_API_TOKEN=pk_your_token_here
```

Then restart the daemon: `noir daemon restart`. The daemon's environment is a
**spawn-time snapshot** — a token added after it started is invisible to it
until it restarts. Workspace binding is config, not env: `CLICKUP_TEAM_ID` is
never read; set `integrations.clickup.teamId` / `.listId` / `.spaceId` in
`.noir/config.yml` instead. Full guide: [clickup.md](clickup.md).

### Model provider key — `apiKeyEnv` is a NAME, never `${VAR}`

This is the trap that silently disables a provider. `apiKeyEnv` stores the
variable **name**; Noir reads `process.env[<that name>]` at call time. So:

```yaml
# .noir/config.yml
model:
  providers:
    anthropic:
      apiKeyEnv: ANTHROPIC_API_KEY   # -> reads $ANTHROPIC_API_KEY
  tiers:
    default:
      provider: anthropic
```

```bash
# .noir/.env
ANTHROPIC_API_KEY=sk-ant-your_key_here
```

Writing `apiKeyEnv: ${ANTHROPIC_API_KEY}` resolves
`process.env['${ANTHROPIC_API_KEY}']` → `undefined` → a provider with no key,
silently. Only `run.profiles.<name>.env` interpolates `${VAR}`; `apiKeyEnv`
does not. With no provider configured (or no key resolvable) the model layer
degrades to templates — Noir never makes a silent paid call.

### Remote embedder

Only when you opt out of the default local embedder:

```bash
# .noir/.env
OPENAI_API_KEY=sk-your_key_here      # context.embedder.kind: remote + provider: openai
```

`context.embedder.kind: local` (the default) needs no key. The other remote
providers use `VOYAGE_API_KEY` / `COHERE_API_KEY`. For `kind: ollama` the base
URL comes from `context.embedder.baseURL`; `OLLAMA_BASE_URL` is its fallback:

```bash
OLLAMA_BASE_URL=http://localhost:11434
```

### Run-profile host selection

```bash
# .noir/.env
NOIR_PROFILE=work
```

Precedence for the selection itself: `--profile <name>` flag > `NOIR_PROFILE` >
`run.defaultProfile` > built-in host default. Define the profiles in
`.noir/config.yml` — see [host-profiles.md](host-profiles.md).

### A per-invocation override — a run profile

```yaml
# .noir/config.yml
run:
  profiles:
    ci:
      binary: claude
      env:
        CLICKUP_API_TOKEN: ${CLICKUP_API_TOKEN}   # values come from your CI secret store
```

```bash
noir run --profile ci "…"
```

Level 1 of the chain, and the only per-invocation override Noir has: a
`run.profiles.<n>.env` entry is merged **over** the inherited environment for
that spawn, so it also outranks this file. It is the right escape hatch for a CI
job (export the value in the job environment, reference it here rather than
writing it into the file) and for testing a rotated token without editing
anything. A `VAR=value noir …` prefix is **not** an override — it arrives in
`process.env` exactly like the inherited environment (level 3), so this file
still wins.

## 6. Safety

- **Gitignored by the managed block.** `/.noir/.env` and `/.noir/.env.*` are
  ignored; `!/.noir/.env.example` keeps the example committable.
- **`0600`.** `noir init` creates the file unreadable by others; `noir doctor`
  warns (via the `noir-env` row) if it is group/world readable. Remedy:
  `chmod 600 .noir/.env`.
- **A git-*tracked* `.noir/.env` is refused outright.** Noir never interprets
  it, so none of its keys are in effect, and the refusal names the remedy:

  ```
  .noir/.env: refusing to load — it is tracked by git. A cloned repository could redirect credentials through it. Fix: add `.noir/.env` to .gitignore (Noir's managed block already does) and run `git rm --cached .noir/.env`.
  ```

  The reason is that a tracked file arrives with the clone. Under this
  precedence it could set `ANTHROPIC_BASE_URL` to an attacker's endpoint while
  the *token* still arrives through the environment fallback — the file needs
  no secret of its own to exfiltrate yours. Untracked (the normal case, since
  init creates it gitignored) is trusted; outside a git repository the file is
  trusted too, and any git failure degrades to trust rather than disabling the
  file for everyone.
- **A deny-list of process-injection names applies.** Even present in the file,
  `NODE_OPTIONS`, `NODE_PATH`, `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`,
  `npm_config_*`, `COREPACK_*`, and Noir's own plumbing names
  (`NOIR_DAEMON_DIR`, `NOIR_RUNTIME_DIR`, `NOIR_MCP_COMMAND`, …) are ignored
  with a one-line warning. Noir spawns Node children (the daemon, the host), so
  a file that arrived inside a cloned repository must not be able to inject
  into them.
- **Never commit it, and never pass a token as a CLI argument** — arguments are
  visible in process lists.
- **Noir never prints a value.** `noir env` prints the name, the winning
  source, and a redacted shape; `--json` prints a length. The loader's warnings
  name keys, never values.

## 7. Troubleshooting

**"I edited `.noir/.env` and nothing changed."**

Run `noir env` and read the `SOURCE` column. `environment` means the file is not
defining that key — usually a typo, a line still commented out, or a malformed
line (the loader writes `.noir/.env:<line>: <reason> — skipped` to stderr). If
the key *is* in the file and your shell also had it, the row reads
`.noir/.env (shadows environment)` — the file is winning, and the stderr
shadow line named the key when the command started.

**"Still `no-token` after I added it."**

The daemon's environment is a snapshot taken when it spawned. Restart it —
`noir daemon restart` — then retry. This is the most common cause of "the token
works in my shell but the integration says it is missing".

**"My repository's `.noir/.env` was ignored."**

It is tracked by git, so it is refused. Add `.noir/.env` to `.gitignore` (the
managed block already does) and untrack it: `git rm --cached .noir/.env`. The
`noir-env` row in `noir doctor` reports this, and `noir env` shows no keys from
the file.

**"I set a key and it has no effect at all."**

Check the command's stderr for `refusing process-injection key '<NAME>'` — that
name is on the deny-list above and is never read from a project file. For a
provider key, confirm `apiKeyEnv` in `config.yml` names the variable you set
(a bare name, never `${...}`), and that `noir doctor`'s `provider` row reports
`key present`.

## See also

- [environment.md](../reference/environment.md) — every environment variable
  Noir reads, and the secrets policy.
- [config.md](../reference/config.md) — the `.noir/config.yml` schema.
- [clickup.md](clickup.md) — the ClickUp integration end to end.
- [host-profiles.md](host-profiles.md) — run profiles and the `${VAR}`
  interpolation they support.
- [privacy.md](../explanation/privacy.md) — what leaves your machine, and when.
