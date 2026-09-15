# How to use cross-session memory

Memory is how one session tells the next one what it learned. Each entry is a
**typed observation** — a decision, a bug, a preference, an architectural fact —
stored locally in the project store and retrieved by meaning, not by file path.
A new session recalls "how do we handle retries here?" and gets the answer you
wrote three weeks ago, without you re-explaining it.

Use this page when you want to write something down deliberately, get it back
later, or prune what is there.

## 0. Prerequisite

An initialized project and a daemon:

```bash
noir init
```

The daemon starts on demand for these commands. A few of them keep working with
it down (see the notes on each), but reading and writing memory wants it up:
`noir daemon start --detach`.

Nothing here needs a model provider. Observations are stored and retrieved
locally — **never sent to an LLM** — unless you explicitly opt into
consolidation (§6).

## 1. Save a decision

```bash
noir memory save --content "Retries use exponential backoff with jitter; the cap is 5 attempts." \
  --type architecture \
  --files src/net/retry.ts,src/net/client.ts
```

| Flag | Meaning |
|---|---|
| `--content <text>` | The observation, in full. Never truncated. |
| `--type <type>` | `pattern` \| `preference` \| `architecture` \| `bug` \| `workflow` \| `fact` \| `decision`. An unknown type is accepted and stored, so a type that fits your project better is not rejected. |
| `--files <a,b,c>` | Comma-separated repo-relative paths the observation is about. |

`--content` is the only one worth thinking about. Omit it in an **interactive**
terminal and Noir prompts for it; omit it anywhere else (a pipe, `--json`,
`--no-input`, CI) and the command exits `2` telling you the flag is required.
Cancelling the prompt exits `5`. Either way a scripted run never hangs on a
question it cannot answer.

The command prints the new id and the stored observation:

```
Saved memory 4f2c1a8e-… .
id           4f2c1a8e-…
type         architecture
importance   0.5
ts           …
source       explicit
project      noir
```

Only the fields the observation actually carries are listed. `source: explicit`
means you asked for it, as opposed to `auto:stop` from a capture (§5);
`importance` is `0.5` unless the caller set it. Everything goes to stderr, and
`--json` puts `{ok:true, data:{id, observation}}` on stdout instead.

## 2. Get it back

```bash
noir memory recall "how do we handle retries"
noir memory recall "how do we handle retries" --limit 3
```

The query is matched by meaning *and* by keyword, so you do not need the words
you originally used. Each hit prints its type, score, importance and id, then
the full content:

```
memory recall — 2 hits for 'how do we handle retries'
[1] architecture · score 0.0312 · importance 0.50 · 4f2c1a8e-…
    files: src/net/retry.ts, src/net/client.ts
    Retries use exponential backoff with jitter; the cap is 5 attempts.
[2] bug · score 0.0164 · importance 0.50 · 9b7e0d41-…
    The retry loop double-counted a 429 as both a retry and a failure.
```

`--limit` caps the number of hits (default 10). When the daemon is unreachable,
recall **still works** — it falls back to an in-process read-only pass over the
store and marks itself: `degraded: BM25-only` on the header line, meaning
keyword matching only, no vectors. `--json` reports the same as
`data.degraded: true`. Nothing is ever written on that path.

## 3. See which sessions wrote what

```bash
noir memory sessions
```

```
memory sessions — 6 sessions
Session       Observations   Last seen
5f2c…         12             2026-09-15 04:10
a91d…         4              2026-09-12 18:44
```

This is the fastest way to find an id to `recall` or `forget` — and, when memory
feels noisy, to see which session did the talking.

## 4. Forget something

```bash
noir memory forget 9b7e0d41-… 4f2c1a8e-…
```

One or more ids, from `recall` or `sessions`. It prints
`Forgot N observation(s).` Ids that do not exist are simply not counted — a
repeat run is harmless. There is no confirmation prompt, so be sure of the id;
`recall` shows the full text before you commit to it.

## 5. Capture a transcript or your own notes

`noir memory capture` records a whole document as one observation, tagged with
its origin:

```bash
noir memory capture note.md                      # from a file
git log -1 | noir memory capture                 # from piped stdin
noir memory capture --content "…"                # inline
noir memory capture note.md --event-type SessionEnd
```

The content is resolved from the first source that is present: `--content`, then
the file argument, then piped stdin, then an interactive prompt. With none of
them the command exits `2`.

**The content is stored as you give it** — Noir does not summarize, rewrite, or
send it anywhere. Whatever you pipe in is what lands in memory, which is why
this is the right tool for a session-end summary you have already written, and
the wrong one for a 4,000-line log you have not read.

`--event-type <label>` records where it came from; the observation's source
becomes `auto:<label>`, lowercased — the default label is `Stop`, so
`source: auto:stop`. Use it to keep capture provenance honest (a `SessionEnd`
summary is not the same evidence as a `Stop` one).

Capture works on a shared workspace too, with a per-repository feed. See
[shared-workspaces.md](shared-workspaces.md).

## 6. Consolidate observations into lessons (opt-in)

Consolidation asks a model to read a set of observations and derive a smaller
set of lessons from them — the "what general rule do these five bugs imply?"

```bash
noir memory consolidate --types bug --limit 50
```

It runs **only when you have explicitly turned it on**. Three things must be
true: `memory.consolidation.enabled: true` in `.noir/config.yml`, a provider
assigned to the `consolidate` tier, and that provider's model resolvable. When
they are, the daemon registers the `memory_consolidate` tool and the command
works:

```
Consolidated 2 lessons from 7 observations.
- 0c1b…: Retry accounting must treat a 429 as exactly one failure.
- 7d4a…: Every backoff path needs a jitter source that is seeded in tests.
```

When they are not, nothing runs and nothing is charged — the command exits `1`
and says which piece is missing:

```
memory consolidate: the daemon does not expose the memory_consolidate tool.
Enable it in .noir/config under memory.consolidation (enabled: true + a
provider + model), then restart the daemon.
```

| Refusal | What it means |
|---|---|
| `no-provider` | No provider is configured for consolidation. |
| `model-unavailable` | A provider is named, but its model could not be resolved. |
| `no-candidates` | Nothing matched `--types` / `--limit` — there is nothing to derive from. |

Consolidation is also **not supported on a shared workspace** — the workspace
memory store has no consolidation model — and the command says so rather than
failing obscurely.

> **This is the one memory command that can cost money**, which is why it is
> off by default and never triggered implicitly. Setting `model:` ids for the
> summarization/`title`/`draft` tiers does **not** enable it.

## 7. When to use memory instead of context search

Both are retrieval over the same store, and they answer different questions.
Reach for the right one and both stay sharp:

| You want… | Use |
|---|---|
| A decision, a rationale, a gotcha, a preference | **memory** (`recall`) |
| Where something lives in the code, how a function works today | **context** (`noir context search`) |
| Something the *host* should know before it starts work | **memory** — the `noir-recall` skill queries it before re-deriving anything |
| The current state of a file you are editing | **context** — memory is a record, not a snapshot |

The rule of thumb: context search is about **the code as it is**; memory is
about **what you concluded about it**. A memory that restates the code goes
stale the moment the code changes; a memory that records the *reason* does not.

For the host side of this, see
[context-and-handoff.md](context-and-handoff.md).

## Notes & troubleshooting

**"My save said `Saved memory …` but recall cannot find it."** Recall ranks by
meaning and keyword. A very short or very generic query can rank a specific
observation below the `--limit`. Raise the limit, use a phrase closer to the
content, or list `noir memory sessions` to confirm it is there at all.

**"Recall shows `degraded: BM25-only`."** The daemon was unreachable and the
command fell back to a read-only keyword search. The results are real, just
narrower. Start the daemon (`noir daemon start --detach`) and re-run for the
full hybrid ranking.

**"The host never mentions what I saved."** The host reads memory when a skill
calls for it — `noir-recall` queries before re-deriving something, and
`noir-wrap` saves at the end of a task. Saving an observation does not push it
into an already running session; it is there for the next one.

**"Is any of this sent anywhere?"** No. Saving, recalling, listing and
forgetting are local. The store is `.noir/store/<projectId>.db`, keyed by the
project id, not a filesystem path. The single exception is consolidation, which
you have to switch on — see [privacy.md](../explanation/privacy.md).

## See also

- [shared-workspaces.md](shared-workspaces.md) — share decision memory across
  two repositories through one workspace daemon.
- [context-and-handoff.md](context-and-handoff.md) — index and search the
  codebase, and hand a session over cleanly.
- [sdd-tasks.md](sdd-tasks.md) — the task lifecycle memory usually feeds.
- [privacy.md](../explanation/privacy.md) — what leaves your machine, and when.
- [mcp-tools.md](../reference/mcp-tools.md) — the `memory_*` tools the host
  calls.
