# How to search your codebase and hand off a session

This page covers the two ends of a working session. At the start you need the
right code in front of you without reading whole files; at the end you need the
state of the work to survive into the next session. The first half is
**context** — index, search, status. The second half is **handoff** — `noir
handoff` and its session-end alias `noir wrap`.

They live on one page because they are the same move in opposite directions: one
pulls the repository into a session, the other pushes a session out to a file
you can paste into the next one.

## 0. Prerequisite

```bash
noir init
noir daemon start --detach
```

Context search reads a **read-only fallback** when the daemon is down, so it
keeps working. Indexing and status do not: they need the daemon and exit `4`
without it. Handoff never fails on a missing daemon — it degrades (§4).

## 1. Index the project

```bash
noir context index
noir context index --path src --path packages/cli
noir context index --force
```

The indexer walks the configured roots (`context.roots` in `.noir/config.yml`,
the project root by default), splits each file into chunks, and stores those
chunks plus a vector for each.

| Flag | What it does |
|---|---|
| `--path <p>` | Index only this path. **Repeatable** — `--path a --path b` indexes both, not just the last one. |
| `--force` | Drop every indexed chunk and vector, then re-index from scratch. |

Without `--force` the walk is **incremental**: a file whose content hash has not
changed is skipped, and a file that vanished is deleted from the index. Reach
for `--force` when the index looks wrong rather than merely stale (an embedder
change, a corrupted store, a `.noir/config.yml` roots edit).

```
context index — .
Indexed (new)          128
Skipped (unchanged)    940
Deleted (removed)      3
Failed                 0
Total chunks           4211
```

`Failed` counts files that could not be read (binary, encoding, IO). They are
reported, not fatal. If the embedder is unavailable, the header carries
`degraded: vectors skipped` — the chunks are indexed and searchable by keyword,
but not by meaning.

## 2. Search it

```bash
noir context search "where do we validate the retry budget"
noir context search "retry budget" --limit 5
```

Search is **hybrid**: a keyword pass (BM25 over the chunks) and a meaning pass
(nearest vectors) each produce a ranking, the two are merged by reciprocal rank
fusion, and the result is trimmed to a token budget so a search cannot flood
your context window. A hit therefore surfaces both when it shares your words and
when it merely *means* the same thing.

```
context search — 4 hits · hybrid · 1832 tokens
#   Path                        Score    Snippet
1   src/net/retry.ts            0.0321   const budget = Math.min(attempts * base, maxDelay)…
2   src/net/client.ts           0.0164   if (attempt >= MAX_ATTEMPTS) throw new RetryExhausted…
```

| Column | Meaning |
|---|---|
| `Path` | Repo-relative path of the file the chunk came from. |
| `Score` | The fused rank score. Compare hits to each other; the absolute number is not meaningful on its own. |
| `Snippet` | The matching region of the chunk. |

The header names the **mode** the search actually ran in — `hybrid` when both
passes contributed, `bm25-only` when the vectors were unavailable. Two suffixes
can follow:

- `degraded: BM25-only` — the daemon was unreachable, so Noir fell back to a
  **read-only** in-process search over the same store. Keyword matching only;
  nothing was written. Start the daemon and re-run for the full ranking.
- `(budget hit — results truncated)` — there were more hits than the token
  budget allowed. Narrow the query or raise `context.budgetTokens`.

`--limit` caps the number of hits (default 10); an invalid value is a usage
error (exit `2`) before anything touches the daemon.

## 3. Check the index

```bash
noir context status
```

```
context status — 8f3c…
Project         8f3c…
Docs            1348
Vectors         4211
Indexed files   1348
Embedder        local · Xenova/all-MiniLM-L6-v2 (384-dim)
Degraded        no
```

`Docs` is the number of indexed documents, `Vectors` the number of vector rows.
The **embedder** line is the one to read when search behaves oddly: it names the
kind and the model that is actually in use, and `none (BM25-only)` means no
embedder is configured at all — keyword search only. `Degraded` reports whether
the engine is running in a reduced mode.

The default embedder is `local` — a small model that ships with Noir, needs no
API key, and runs on your machine. Remote embedders are opt-in; see
[configure-env.md](configure-env.md).

## 4. Emit a handoff

When it is time to move the work into a host session, `noir handoff` renders a
ready-to-paste prompt:

```bash
noir handoff
```

The markdown goes to **stdout** (nothing else does), so it pipes where you want
it:

```bash
noir handoff > next-session.md
noir handoff --json | jq -r '.data.directive'
```

The artifact carries the project identity, the active task and its phase, an
**`## Open host` directive** — the exact line to paste into your host — the next
step and the skill that performs it, and two bounded seeds:

- **Extracted context** — up to 5 `context_search` hits for the task's domain.
- **Extracted memory** — up to 5 `memory_recall` observations for the same.

The extraction query is the **active task id**, or the project name when no task
is active, so the seed is about the work in hand rather than the repository at
large. Five is a deliberate cap: this is a seed to start a conversation, not a
dump.

Two things `noir handoff` deliberately does **not** do. It never spawns the
host — the directive is text, and you decide what to paste and where. And it
never hard-fails on a degraded environment: a down daemon or a missing embedder
leaves a note in the artifact (`_No context hits (or daemon down)…_`) and the
command still exits `0` with the rest of the handoff intact.

## 5. Persist it

```bash
noir handoff --write
noir wrap --write
```

`--write` persists the artifact to **`.noir/handoff/HO-<NNNN>-<id>.md`** —
numbered, so a project accumulates an ordered series. The path is reported on
stderr, and the artifact is **not** also printed to stdout: with `--write` you
asked for a file, so that is what you get. The directory is gitignored by Noir's
managed block (`.noir/handoff/`), because these prompts are session-specific and
machine-local — paste-and-go, not reviewed source.

`--write --json` writes the file *and* emits the structured envelope, so a
script can have both the artifact and its metadata.

## 6. `noir wrap` — the session-end name

```bash
noir wrap
```

`noir wrap` is `noir handoff` under the name you reach for at the end of a
session. It is the **same handler** with the same flags — there is no second
code path and no different output. The `noir-wrap` skill uses it to close out a
task, which is why you will see it named in the phase ladder
([sdd-tasks.md](sdd-tasks.md)).

## Notes & troubleshooting

**"Search returns nothing for a term I know is in the file."** Run
`noir context status` and check the covered roots and the embedder line. If the
file is outside `context.roots`, or was added after the last index, run
`noir context index`. If `Degraded` is `yes`, or the header said `degraded:
BM25-only`, start the daemon.

**"The index is huge and slow."** Narrow `context.roots` in `.noir/config.yml`
to the directories that matter, then `noir context index --force` to rebuild.

**"`context index` exits 4 but search works."** Correct — they differ on
purpose. Search can still read on its own; indexing writes to the project
database, and only the daemon may do that. `noir daemon start --detach`.

**"The handoff has no context or memory seed."** The daemon was down, or no
embedder is available; the artifact says which. Start the daemon and re-run.

**"I edited the handoff file and it was overwritten."** `--write` reuses the
numbered path for the same task, so a re-run regenerates it. Copy anything you
edited out of `.noir/handoff/` — it is a generated artifact, not a source file.

## See also

- [memory.md](memory.md) — the cross-session memory the handoff seeds from.
- [sdd-tasks.md](sdd-tasks.md) — the task whose phase and next skill the
  handoff reports.
- [config.md](../reference/config.md) — `context.roots`,
  `context.embedder`, `context.budgetTokens`.
- [configure-env.md](configure-env.md) — remote embedder keys and the local
  default.
- [architecture.md](../explanation/architecture.md) — how the context and
  memory engines sit on the store.
