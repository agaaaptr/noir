# How to run a spec-driven task end to end

A Noir task moves through a fixed ladder of phases — intake, clarify, spec,
plan, execute, verify, document — and three of those transitions are **gates**
(spec, plan, verify): the engine will not move past them unless the discipline
was followed, or you say so explicitly with a reason.

You normally drive this by talking to the host. This page is for the times you
drive it yourself — scripting it, resuming after a break, or reading exactly
what state a task is in. The *why* behind the ladder is in
[Spec-Driven Development Workflow](../explanation/sdd-workflow.md); this page is
the commands.

## 0. Prerequisite

```bash
noir init
noir daemon start --detach
```

Writes (`task new`, `advance`, `verify`, `block`, `abandon`, `research-record`)
go through the daemon and exit `4` when it cannot be reached. `noir task status`
is the one command with a read fallback: with the daemon confirmed down it
answers from the store directly and marks itself `degraded`. `next` and `resume`
need the daemon.

## 1. Start a task

```bash
noir task new --slug csv-export
noir task new --slug csv-export --mode quick
noir task new --slug csv-export --class feature
```

`--slug` is required and doubles as the task id — it is the handle you use
everywhere else, and it appears in every artifact filename. **Re-running the
same slug overwrites the task**: the store's key-value state is the source of
truth, not a journal, so starting `csv-export` again resets it rather than
forking a second one.

| Flag | Values | What it changes |
|---|---|---|
| `--mode` | `full` (default) \| `quick` | `full` authors spec and plan and makes you review them; `quick` writes a stub spec and records the spec and plan gates as `skipped`, then fast-forwards to execute. **The verify gate still fires either way.** |
| `--class` | `feature` \| `epic` \| `enhancement` \| `bugfix` \| `spike` \| `quick-task` \| `refactor` | Drives the soft **PRD gate**: a `feature` or `epic` that reaches the spec gate without a PRD gets an observable recommendation. |

Both flags are validated on your machine before anything is sent, so a typo is a
clean usage error (exit `2`) listing the values that are accepted — not a
mystery failure from the server.

The command prints the new task's status block (see below).

## 2. See where it is

```bash
noir task status              # the active task
noir task status csv-export   # by id
noir task next                # what to do next, and which skill does it
```

```
task status — csv-export
Task        csv-export
Phase       clarify
State       clarifying
Mode        full
Class       feature
Next gate   spec
Updated     2026-09-15 04:10:02Z
```

| Field | Meaning |
|---|---|
| `Phase` | Where in the ladder you are: `intake` → `clarify` → `spec` → `plan` → `execute` → `verify` → `document`. |
| `State` | The engine's state machine value (`draft`, `clarifying`, `specified`, `planned`, `executing`, `verifying`, `done`, `blocked`, `abandoned`). |
| `Mode` | `full` or `quick`. |
| `Class` | The `--class` you set, when you set one. |
| `Next gate` | The next transition that will require a decision (`spec`, `plan`, `verify`), or `—` past them all. |
| `Block reason` | Present only while the task is blocked. |

An unknown or absent task is exit `3`, not an empty success — so a script can
tell "no such task" from "task exists, nothing to report".

`noir task next` adds the phase's skill and the next gate's skill:

```
task next — csv-export · phase clarify (clarifying, full)
next gate: spec
skill for current phase (clarify): noir-brainstorming
skill for next gate (spec): noir-spec
```

## 3. Move it forward

```bash
noir task advance                  # the next phase
noir task advance --to execute     # jump to a later phase
```

`--to` accepts any phase in the ladder and is validated client-side. A jump
forward **bypasses** the gates it skips — the engine records at most the one gate
guarding the phase you land on (spec → `specified`, plan → `planned`, document →
the verify/`done` gate); a jump landing on execute or verify records nothing at
all. A jumped-over gate only appears in the task's audit trail if you later jump
back through it.

`advance` prints the same status block as `task status`, so one command always
tells you where you landed. Two things it does implicitly when you land at
`done`: it appends a changelog entry and a pending decision-record stub (pass
`--no-artifacts` to skip), and it never clobbers an existing file — the artifact
writes use a preserve-on-conflict policy. When you name `verify` explicitly —
`noir task advance --to verify` — it also prints one hint, ``run `noir handoff`
for a ready-to-paste host prompt``, because that is the moment work leaves
Noir's planning and enters the host's execution.

## 4. Escape a gate on purpose

A gate that will not open is not a wall — it is a decision waiting to be
recorded:

```bash
noir task advance --force "PRD tracked in JIRA-4211"
noir task advance --skip
```

- **`--force <reason>`** proceeds and records the decision as `forced`, with
  your reason attached. Use it for a soft check you have decided against.
- **`--skip`** records the landing gate as `skipped` and continues.

Both are recorded in the audit trail with a timestamp (§9). That is the point:
Noir does not stop you, it makes the shortcut *visible*.

## 5. Prove it — the verify gate

The verify gate is the one that asks for evidence rather than a promise. It runs
the checks you configured and submits their results:

```bash
noir task verify                        # every configured check
noir task verify --check tests --check lint
```

Checks come from `.noir/config.yml`:

```yaml
workflow:
  gate:
    verify:
      checks:
        - name: tests
          command: pnpm test
          tier: hard      # hard (default) | soft
        - name: lint
          command: pnpm lint
          tier: soft
```

Each check is run as a shell command; Noir records its exit code and a SHA-256
digest of its output as the evidence. Passing command:

```
verify — 2 passed, 0 failed → gate approved
```

The gate approves only when the task actually lands at `done`. If it fires but
lands somewhere else, the command says so rather than claiming success, and
tells you to run it again once you are at `verify`.

A failing gate is a **failure** — exit `1`, never a silent success — and it
prints the recovery options it will accept:

```
verify gate: evidence-failed at 1757912402123 (1 passed, 1 failed)
recovery: `noir task verify` | `noir task advance --force <reason>` | `noir task advance --skip` | `noir task block <reason>`
```

The number after `evidence-failed at` is the task's `updatedAt` in epoch
milliseconds, printed raw — the status block's `Updated` field is the one that is
formatted as a readable timestamp.

Under `--json` a pending gate keeps its full context: `{ok:false, error:{…},
data:{pendingGate, recovery, evidence}}`.

With no checks configured the command exits `2` rather than inventing something
to run — the gate wants a real signal, not a rubber stamp.

## 6. Record what you learned

Findings are the raw material the spec gate looks for:

```bash
noir task research                                 # list (shows the active task's status)
noir task research-record --type discovery \
  --text "The CSV writer already streams; no buffering needed." \
  --source src/export/writer.ts
```

| Flag | Notes |
|---|---|
| `--type` | `assumption` \| `discovery` \| `decision` \| `grounding-fact` (required). |
| `--text` | The finding (required, length-capped). |
| `--source` | Where it came from — **required unless the type is `grounding-fact`**. |
| `--task <id>` | Target a task other than the active one. |

The source requirement is the whole point: an entry with no evidence is an
assumption, so it must be typed as one. Recording findings is also what silences
the **research-grounding recommendation** — a `feature` or `epic` reaching the
spec gate with no source-backed findings gets a recommendation to record some
(or `--force <reason>` to proceed without). It is a soft gate, so it never
blocks.

## 7. Pause, resume, stop

```bash
noir task resume                              # briefing for the active task
noir task resume --prompt "start with the writer"
noir task block "waiting on the export schema decision"
noir task abandon
```

**`resume`** is the cross-session entry point: it reads the task back and prints
state, phase, next gate, and the skill for the current phase. `--prompt`
surfaces a continue instruction in this run's briefing (echoed on stderr only —
it is not persisted, so a later `noir task resume` will not show it). A task
with nothing to resume exits `1` — again, honest rather than silently empty.

**`block`** marks the task blocked with a mandatory non-empty reason (an empty
one is exit `2`). A blocked task is resumable, but only by jumping:

```
resume a blocked task with: noir task advance --to <phase>
```

**`abandon`** is terminal. It confirms interactively — *"Abandon this task? This
is terminal and cannot be undone."* — defaulting to **no**; declining or
cancelling exits `5` and leaves the task alone. Under `--no-input`, `--json`,
or CI there is no prompt and it proceeds, so be deliberate there.

## 8. Decompose a capability into slices

```bash
noir task decompose cap-06 --out .noir/plans/cap-06.json
```

This drafts an offline **SlicePlan** — a template skeleton, no provider needed,
so it works with no key configured. `--out <path>` also persists the plan JSON;
either way it prints a line per slice. Each slice is meant to enter the same
ladder you have been using:

```
decompose — cap-06
s1-walking-skeleton: Walking skeleton — thinnest end-to-end (feature) — rationale: The first slice for capability cap-06.
each piece enters the existing clarify→spec→plan→execute→verify→document workflow
```

## 9. Where the decisions are recorded

The **authoritative** record of every gate outcome is the engine's audit KV
(`audit:<taskId>`) in the project store, keyed by the canonical project id. The
engine re-derives each task's history from it on every read, so what you see and
what happened cannot drift.

That record is exported to a file when the task is checkpointed:
**`.noir/audit/<taskId>.json`**. Alongside it, the artifacts of a `done` task
land in `.noir/CHANGELOG.md` and `.noir/decisions/`.

The rest of the artifact set is created as you go — `.noir/intake/`,
`.noir/clarifications/`, `.noir/specs/`, `.noir/plans/`, `.noir/tasks/`
— following the standard naming in
[Generated-artifact format & naming standard](../reference/artifact-format.md).

## Notes & troubleshooting

**"`task advance` exits 4."** The daemon is not running and the command writes.
`noir daemon start --detach`, then retry. `noir task status` is the one read with
a fallback — with the daemon confirmed down it answers from the store directly
and marks the row `degraded`. `noir task next` still needs the daemon.

**"The gate says the PRD is missing."** That is the soft PRD gate on a `feature`
or `epic`. Either write the PRD or record why you are not:
`noir task advance --force "<reason>"`.

**"I forgot my phase — `advance` did something unexpected."** Run
`noir task status` before advancing. A bare `noir task advance` always moves one
step from wherever you are, while a `--to` jump bypasses the gates in between —
only the gate guarding the phase you land on can be recorded.

**"Nothing happened when I re-ran `task new` with the same slug."** It did: the
task was reset to `draft`/intake. Re-starting a slug overwrites it by design.
Use a distinct slug for a distinct piece of work.

## See also

- [Spec-Driven Development Workflow](../explanation/sdd-workflow.md) — the why:
  the full ladder, the state machine, the gate semantics.
- [context-and-handoff.md](context-and-handoff.md) — hand a task over to the
  host, and search the codebase while you work it.
- [memory.md](memory.md) — the cross-session memory that survives a task.
- [config.md](../reference/config.md) — `workflow.gate.verify.checks` and the
  research/PRD settings.
- [artifact-format.md](../reference/artifact-format.md) — how generated
  artifacts are named and structured.
