# How to run the host agent headless

`noir run "<prompt>"` drives a host agentic CLI — Claude Code by default —
**headless**: no interactive session, the answer streams back as plain text, and
the whole run is scriptable under `--json`. Use it for a one-off question, a
step in a script or CI job, or any moment you want the host's answer without
opening a session.

This page covers the run itself: the answer, the progress line, the JSON
envelope, profiles, what happens after the answer, how to stop a run, and the
live run screen in the dashboard.

## 0. Prerequisite

A working host binary on `PATH` and, ideally, an initialized project:

```bash
noir init          # recommended — creates .noir/ including .noir/.env
```

`noir run` works **outside** an initialized project too. It is never a failure,
but with no `.noir/.env` there are no project credentials, so it says so once on
stderr before spawning and points at `noir init`. That line is informational and
is silenced by `--json` and `--quiet`.

## 1. Ask a question

The prompt is every positional argument, joined with spaces — quoting is
optional but keeps the shell out of it:

```bash
noir run "summarize the TODOs in src/"
noir run summarize the TODOs in src/          # same prompt
```

The host's answer — and only the answer — is written to **stdout** as it
arrives. Everything else Noir says (usage totals, the transcript path, warnings)
goes to **stderr**, so `noir run "…" > answer.md` captures the answer alone.

Choose which host answers:

```bash
noir run --host gemini "…"           # a different host adapter
noir run --command claude-work "…"   # a specific host binary
```

`--host` takes one of the supported adapter ids; `--command` takes the binary
that host should be driven through. When the name is not on `PATH` — it is an
alias or a function from your shell rc, or a `PATH` entry only your interactive
shell knows — Noir probes your shell for it and either re-spawns the resolved
path or bridges the alias through it, passing the prompt as argv only, never
shell-parsed. That probe needs `$SHELL` to be `zsh`, `bash`, or `fish`, and is
skipped on Windows: without it, `--command` fails with "no executable found".
A launcher script is the most predictable answer, and a run profile (§4) saves
typing either way. Details: [host-profiles.md](host-profiles.md#note-shell-resolution-fallback).

When the host fails, the run exits non-zero with one actionable sentence. On an
**authentication** failure it also names every credential and gateway variable
in effect (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`)
and where each came from — `.noir/.env` or the environment — so "unset it"
points at the file that actually supplies it. **No variable value is ever
printed**, only its name and source. The last 20 lines of the host's own stderr
follow, because that is where a host narrates its progress and its real error.

Every run writes a raw stream-json transcript to
`.noir/transcripts/<host>-<timestamp>.jsonl` (directory `0700`, file `0600`).
The non-JSON summary on stderr ends with the path:

```
usage: 12,480 in / 1,204 out $0.12 · 3 turns (API-equivalent estimate, not billed)
transcript: .noir/transcripts/claude-20260915T041002Z.jsonl
```

The cost figure appears only when the host reported one.

The token figures are an **estimate** of what the same work would cost through
the API. Noir does not bill you: the host runs on your own subscription or key.

## 2. Watch progress while it works

On a terminal, a live status line is drawn in place on stderr, so the wait
before the first token is never silence:

```
▶ claude · waiting for first event…
▶ claude · claude-opus-5 · 8s
● claude-opus-5 · 2m 18s · ↓12,480↑1,204 tokens
```

It names the host, then the model once the host has announced it, then the
elapsed time and running token totals. It redraws only when the host reports
something, and it gets out of the way before the answer is written.

When stderr is **not** a terminal — a pipe, a CI log, a captured file — the
animation would be noise, so it becomes two plain markers instead: one when the
run starts and one when it ends.

`--json` and `--quiet` emit no status line at all.

## 3. Read the answer as data (`--json`)

`--json` turns the run into a single structured envelope on stdout — no
streamed text, no status line, no human diagnostics:

```bash
noir run --json "summarize the TODOs in src/"
```

```json
{
  "ok": true,
  "data": {
    "host": "claude",
    "prompt": "summarize the TODOs in src/",
    "exitCode": 0,
    "usage": { "inputTokens": 12480, "outputTokens": 1204, "totalCostUsd": 0.12, "numTurns": 3 },
    "numTurns": 3,
    "events": 42,
    "transcript": ".noir/transcripts/claude-20260915T041002Z.jsonl",
    "answerText": "The TODOs in src/ are…",
    "sessionId": "5f2c…"
  }
}
```

| Field | What it carries |
|---|---|
| `answerText` | The answer as plain words — reassembled for you, so a consumer never has to parse the stream-json transcript. |
| `sessionId` | The host's session id, present only when the host reported one. Feed it to the host to continue the conversation (see §5). |
| `transcript` | Path to the raw stream-json record of the run. |
| `usage` / `numTurns` / `events` | The token estimate, the number of host turns, and the number of stream events seen. |
| `exitCode` | The **host's** exit status. Noir's own exit code is the one your shell reads. |

A failure under `--json` is one `{ok:false, error:{code,message}}` envelope, and
`error.message` stays a single concise sentence — the stderr tail from §1 is a
human diagnostic and never enters the envelope. The transcript always has the
full output.

## 4. Choose which host setup runs it (`--profile`)

Run **profiles** are named host setups defined in `.noir/config.yml`
(`run.profiles.<name>.binary` plus optional `args` and `env`). They are how you
keep several hosts, several accounts, or several credential sets side by side:

```bash
noir run --profile work "…"
noir run --list-profiles
```

`--list-profiles` prints the configured profiles as `NAME` / `DEFAULT` / `BINARY`
rows and exits without running anything (`--json` gives the same rows as data).
The selection precedence is:

```
--profile <name>  >  NOIR_PROFILE  >  run.defaultProfile  >  built-in default
```

An unknown profile name is a hard error that lists the names that do exist — it
never falls back silently to a different host. See
[host-profiles.md](host-profiles.md) for the config shape and the `${VAR}`
interpolation a profile's `env` supports.

## 5. Decide what to do with the answer

On an **interactive terminal** — both stdin and stdout a TTY, and not `--json`,
`--no-input`, CI, or `NO_COLOR` — a successful run asks what to do next:

| Choice | What it does |
|---|---|
| **Save answer to memory** | Records the answer as a cross-session memory observation. |
| **Add as task research** | Records it as a `discovery` finding on the active task — whitespace collapsed onto one line and cut to 220 characters, source `noir run`. |
| **Write a handoff artifact** | Persists it as a handoff document (`noir handoff --write`). |
| **Continue this session** | Asks for a follow-up prompt and re-invokes the host with `--resume <session-id>` — offered only when the host reported a session id, and only on the first run of a session. |
| **Save answer to a file** | Writes the answer to a path you name, at mode `0600`; the default name is `noir-run-<stamp>.md`. |
| **Dismiss** | Nothing further — the default. |

The rows that need an answer (memory, research, save) are omitted when the run
produced no assistant text, and a menu left with nothing but **Dismiss** is not
shown at all.

Two things to know before you rely on it:

- **Everywhere else it is offered nothing at all** — a pipe, `--json`,
  `--no-input`, CI, or `NO_COLOR`. A scripted run keeps exactly the output it
  has always had.
- **No choice changes the run's exit code.** The menu runs after the run has
  finished; picking "Save answer to memory" on a successful run still exits `0`.

**Continue** is a fresh host invocation, not a `noir run` flag: Noir re-spawns
the same host with `--resume <session-id>` appended to the profile's own
arguments. The memory and research actions go through the daemon; if it is
unreachable they say so and leave everything else alone.

## 6. Stop a run in progress

Press `Ctrl+C` once. Noir forwards `SIGTERM` to the host and leaves with the
conventional `128 + signal` code — the code for the signal **Noir** received:

| You send | Noir forwards | Noir exits |
|---|---|---|
| `Ctrl+C` (`SIGINT`) | `SIGTERM` to the host | `130` |
| `SIGTERM` to `noir` | `SIGTERM` to the host | `143` |

A host that has not exited five seconds later is forced. Press `Ctrl+C` a second
time to leave immediately instead of waiting that grace out; the host is killed
first either way, so nothing is left running behind.

An interrupted run is **not** a failure. There is no `failed` line and no token
summary — the host did as it was told. What the host had already produced is
written to the transcript before Noir leaves, and the message says where:

```
interrupted · transcript: .noir/transcripts/claude-20260915T041002Z.jsonl
```

If the file could not be written, the path reads `(not persisted)`. Under
`--json` an interrupt is one `{ok:false, error:{code,message}}` envelope on
stdout, like any other error.

## 7. Run it live in the dashboard

`noir tui` opens the Ink dashboard. Its `/run <prompt>` opens the **live run
screen** instead of a headless run:

```
/run explain the retry logic in the fetch layer
```

The answer streams into the pane as the host writes it, every tool call the host
starts is listed, and the status bar tracks the model, the elapsed time, and the
running token totals.

The prompt is the one you typed on the dashboard line, so the screen starts
running straight away — there is no second prompt to fill in. The keyboard is
the screen's own while it is open:

| Key | While a host is live | Once it has finished |
|---|---|---|
| `Esc` | Cancel the run; the notice line reads `cancelling…` while the host winds down. | Leave the screen back to the dashboard. |
| `Ctrl+C` | Same as `Esc`. | Same as `Esc`. |
| `Ctrl+C` twice | Force the host now instead of waiting out the grace. | — |
| `Enter` | — | Accept the highlighted row — on the answer prompt this opens the post-run menu (§5) as an overlay. |
| `Up` / `Down` | — | Move between the rows of that menu. |

A cancelled run returns to the dashboard as soon as the host has stopped, with
`interrupted · transcript: <path>` on the notice line. A successful run offers
the same post-run actions as §5, as an overlay; a failed or cancelled one offers
nothing.

Two things to know:

- Only a **bare** `run <prompt>` opens the live screen. A `run` carrying any flag
  (`--json`, `--profile`, `--command`) dispatches as an ordinary captured command
  on the dashboard instead.
- `Ctrl+T` on the **dashboard** (not inside the run screen) opens the transcripts
  picker, where you can reopen a past `.noir/transcripts/` entry read-only.

## Notes & troubleshooting

**"The answer is empty but the run succeeded."** The host may have answered in a
form that carries no assistant text (a tool-only turn, for instance). The
transcript records everything the host sent; read it there.

**"`noir run` says the binary was not found."** The name is not on `PATH` and
the shell probe could not resolve it — usually `$SHELL` is unset (a GUI or
launchd-launched process) or is not `zsh`/`bash`/`fish`, or you are on Windows.
Point `--command` at a real executable or a launcher script, or declare a run
profile and use `--profile`. See
[host-profiles.md](host-profiles.md#note-shell-resolution-fallback).

**"It runs with the wrong credentials."** Run `noir env` to see which source
wins for each key — a value in `.noir/.env` beats the environment. See
[configure-env.md](configure-env.md).

**"I want the run to cost nothing."** It already does, in Noir's books: the
token figures are an API-equivalent estimate, and the host spends your own
subscription or key. Avoiding a *paid* call is a different question — see
[privacy.md](../explanation/privacy.md).

## See also

- [host-profiles.md](host-profiles.md) — defining run profiles and the `${VAR}`
  interpolation their `env` supports.
- [gateways.md](gateways.md) — routing `noir run` (and the host) through a
  gateway or a non-Anthropic endpoint.
- [memory.md](memory.md) — what "Save answer to memory" writes, and how to get
  it back.
- [context-and-handoff.md](context-and-handoff.md) — the handoff artifact the
  post-run menu can write.
- [configure-env.md](configure-env.md) — `.noir/.env`, precedence, and
  `noir env`.
- [getting-started.md](../getting-started.md) — the first-use walkthrough,
  including where `noir run` sits in it.
