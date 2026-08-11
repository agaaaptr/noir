# C4 Research Soft-Grounding + Clarify Ambiguity — a grounding sub-step, not a 10th state (spec)

> Capability-04 delta: the roadmap lists "research as a formal FSM stage" as a gap, but the 2026-08-11 audit established the s4 spec **deliberately defines no research state** (research is a grounding step inside PRD drafting, v1x §4.1), and a 7-source web research sweep found **no leading agentic tool models research as a hard, mandatory lifecycle state** — Devin, Codex, MetaGPT, ChatDev, Cursor, Replit, Aider, OpenCode, and Claude Code all treat research as a *soft grounding step* (a read-only permission mode / subagent), and the two hands-on SDD trials (Fowler; Eberhardt) produced strong evidence *against* hard phases (~10× slowdown, markdown bloat, "faux context", waterfall regression).
>
> This spec therefore resolves the roadmap's acceptance criterion ("research as a first-class FSM state") **against** a 10th state and toward a **first-class research sub-step** — read-only, taskClass-gated, evidence-backed, and persisted in the audit KV — per the roadmap's own principle: *"Where research shows a better approach than the roadmap's example, follow the research."* It also closes the clarify gap (the spec-mandated `.noir/clarifications.md` is never produced; ambiguity resolution is fully manual).
>
> Internal docs follow `docs/internal/specs/`. Research basis: Codex's ExecPlan "Surprises & Discoveries" + "Decision Log" (small, evidence-backed, in-plan persistence — the only well-regarded research persistence model); the freeCodeCamp spec-skill's assumption-flagging (faster than Q&A-first); Specline's token-budgeted self-contained packets; OpenCode's read-only "Plan Agent" / Cursor + Claude Code plan modes.

## Goal

1. **A first-class research sub-step** in the clarify→spec span — read-only, host-adapter-aware, taskClass-gated, and producing **small, evidence-backed records** (assumptions, discoveries, decisions) persisted to the audit KV, **not** a markdown research document.
2. **Research output is reusable** — a per-project findings index a resumed task consults instead of re-discovering (closes the "research for cross-session resume" loop).
3. **A dedicated `noir-research` skill** — today research-as-practice is folded into brainstorming/exploring with no dedicated playbook (audit finding).
4. **Clarify produces its artifact** — the spec-mandated `.noir/clarifications/<id>-<slug>.md` writer ships, and clarify→spec gains a deterministic exit criterion (no unanswered open questions).
5. **Grounding checks at the spec gate** — high-uncertainty taskClasses (`feature`/`epic`) get an observable, escapable research-grounding recommendation mirroring the soft PRD gate. **Soft, never blocking.**

## Scope

### S1 — Research findings record in the audit KV

**`packages/workflow/src/types.ts`** — a typed, append-only record (the audit-KV pattern, keyed per task):

```ts
export const RESEARCH_ENTRY_TYPES = ['assumption', 'discovery', 'decision', 'grounding-fact'] as const;
export interface ResearchEntry {
  type: (typeof RESEARCH_ENTRY_TYPES)[number];
  text: string;              // small: capped (default 220 chars) — the ~2.2k-token-packet lesson
  source?: string;           // evidence/citation — file:line, URL, or command. Required for non-grounding-fact.
  taskClass?: TaskClass;     // class context at write time
  at: number;
}
```

- **`packages/workflow/src/engine.ts`** — `recordResearch(store, taskId, entry)` / `readResearch(store, taskId): ResearchEntry[]`, append-only on `research:<taskId>` (mirrors `recordGate` on `audit:<taskId>`). A per-project index `research:index` maps `taskId → { classes, at }` so resume can consult prior tasks' findings (ProjectId-keyed store ⇒ per-project by construction).
- **Entry cap:** a `source` is **required** unless `type === 'grounding-fact'` — defeats the "faux context" failure mode (research claims must be citable). `text` is length-capped at the entry; oversize input is rejected with a clear error (not truncated silently).

### S2 — Read-only research mode + `noir-research` skill

- **`packages/skills/builtin/noir-research/SKILL.md`** (new) — the dedicated playbook: WHAT/WHEN, read-only tool discipline (grep/glob/read/web/search; **no edits**), the three research flavors as sub-modes — **(a) requirements/context grounding** (clarify), **(b) codebase grounding** (`detectStack`-aware re-read before spec — Codex's "read the source code" instruction), **(c) feasibility/spike grounding** (prototype milestones for unknown-heavy work) — and how to record findings via `noir task research record`.
- **`packages/cli/src/commands/task.ts`** — `noir task research` subcommands:
  - `noir task research` → shows the task's current research findings (from `research:<taskId>`) + the suggested flavor (by taskClass) + the read-only-mode reminder.
  - `noir task research record --type <t> --text "<…>" [--source <ref>]` → writes a `ResearchEntry` (validates the source-required rule, entry cap).
- **`packages/daemon/src/server.ts`** — a small `workflow_research_record` MCP tool (write; degraded → read-only envelope) exposing the same record path to host agents, so the host can persist findings without the CLI.
- **Host-adapter awareness (design decision):** the read-only discipline maps onto each host's plan mode where available — `claude` plan mode, `opencode` Plan Agent, `cursor` plan mode — via the adapter seam (`packages/adapters`), and **falls back to Noir's own documented tool policy** (the skill's read-only list) so behavior is uniform across hosts. Host-native fidelity wins per-host; the skill guarantees uniformity.

### S3 — Soft research-grounding check at the spec gate

**`packages/workflow/src/types.ts`** — `WorkflowGateConfig` gains a `research` slice (default = recommend for `feature`/`epic`, mirroring the PRD gate):

```ts
export interface WorkflowGateConfig {
  prd: { mandatoryFor: readonly TaskClass[] };
  research: {
    recommendFor: readonly TaskClass[]; // default ['feature','epic']
    requireSource: boolean;             // default true
  };
}
```

- **`packages/workflow/src/engine.ts`** — at the spec gate, when the task's class is in `research.recommendFor` and `research:<taskId>` has **no entries** (or only `assumption` entries with no `source`), fold an observable recommendation note into the recorded spec gate's `reason` — exactly the `prdRecommendation` pattern (`engine.ts:249-258`): **the advance always proceeds**, `--force <reason>` is the explicit override, quick mode + unlisted classes skip. Never a hard block (research: grounding is a nudge, not a gate).
- This is the **resolution of the roadmap's acceptance criterion** — see "Acceptance-criterion resolution" below.

### S4 — Clarify artifact + exit criterion

- **`packages/workflow/src/artifacts.ts`** — new `writeClarifications(root, taskId, slug, entries)` writing `.noir/clarifications/<id>-<slug>.md` (the s4-mandated file, currently never produced). Content: open questions + resolved assumptions (from the clarify phase), via the conflict seam.
- **`packages/workflow/src/types.ts`** — `TaskState` gains an additive `openQuestions?: string[]` (set during clarify; derived view, not audit-SOT).
- **Deterministic exit criterion:** clarify→spec records a gate-adjacent check (not a new gate): the task may not exit clarify while `openQuestions` is non-empty, **unless** the advance carries `force`/`skip` (the escapable-observable invariant). This replaces the entirely-manual path today — a clarify with unresolved questions is flagged, not silently passed.
- **Model-layer automation (optional, provider-explicit):** when a provider is configured, the clarify step can propose clarifying questions from the intake text (the v1x §4.1 model-layer aspiration). Default **off**; never env-inferred, never silent-paid. `noir task clarify` documents it; the deterministic exit criterion works with or without it.

## Non-goals

- **No 10th FSM state.** No `research` state, no new phase, no new transitions. Research is a mode inside the clarify→spec span, a typed audit record, and a soft gate check. (Justification: s4 intent + the empirical record in the Goal blockquote; the roadmap explicitly permits following research over its own examples.)
- **No markdown research documents** by default. Findings live in the audit KV as citable records; a rendered markdown summary is an explicit, opt-in export (mirrors `writeAuditExport`), not the persistence model.
- **No hard research gate.** Grounding is a recommendation (`--force` escapable), matching the platform's observable+escapable philosophy and the empirical SDD evidence.
- **No network-dependent detection.** Research flavors are local-first (codebase grounding + requirements) by default; feasibility/spikes are host-agent territory, not a Noir-owned run.
- **No re-engineering of PRD drafting** — the existing soft PRD gate and `noir-prd` skill stay as-is; research findings *inform* the PRD, they don't replace it.

## Acceptance-criterion resolution

The roadmap criterion read: *"Research is a first-class FSM state (with its own gate/artifacts) … done when a task's lifecycle can be `intake → research → clarify` and research produces persisted artifacts."*

This spec **reinterprets** it per the research and the roadmap's own "follow the research" principle:

| Criterion element | Resolved by |
|---|---|
| "first-class" | A first-class research **sub-step**: dedicated `noir-research` skill, `research:<taskId>` audit records, `workflow_research_record` MCP tool, `noir task research` CLI, and a typed `ResearchEntry` schema |
| "its own gate" | A **soft** research-grounding check at the spec gate (`research.recommendFor`), observable + `--force` escapable — gated like the PRD gate, not a blocking hard gate |
| "its own artifacts" | Persisted `ResearchEntry` records + opt-in rendered summary; the findings index for cross-session reuse |
| "`intake → research → clarify`" | Satisfied as `intake → clarify (research mode) → spec`, where research is the read-only grounding mode within the clarify→spec span — the exact shape every leading tool uses |
| "produces persisted artifacts" | ✅ `research:<taskId>` KV records + `writeClarifications` artifact + findings index |

The lifecycle change that matters (research output is persisted, discoverable, and reused) is delivered; the *state-machine shape* (which the research shows to be harmful as a hard phase) is not.

## Acceptance criteria

1. `noir task research record --type discovery --text "<…>" --source "packages/foo/src/x.ts:12"` writes a `ResearchEntry` to `research:<taskId>`; `noir task research` lists it; `--type assumption` without `--source` is rejected (exit 2) when `requireSource` is on; an over-cap text is rejected (exit 2).
2. A `feature` task with empty `research:<taskId>` entering the spec gate records an observable research-grounding recommendation note on the spec gate; `--force <reason>` records `forced`; a `quick-task` or an in-`recommendFor`-class task with findings records no note. **(Soft gate, live end-to-end.)**
3. `noir-research` exists in the pack (26→27 builtins), is a full playbook (no stub), passes `validateSkill`/`lintSkill`, and its WHEN describes the read-only mode.
4. A task with `openQuestions` non-empty does not exit clarify via a plain `advance` (flagged); `advance --force <reason>` or resolving the questions (clearing the list) proceeds. `.noir/clarifications/<id>-<slug>.md` is written when clarify completes.
5. A resumed task (`noir task resume`) consults `research:index` for prior findings of the same class and surfaces them in the briefing.
6. Full gate green: lint → build → typecheck → test → docs:validate (engine/daemon/CLI existing tests unchanged; new tests additive).

## Testing strategy

- **Engine unit:** `recordResearch`/`readResearch` append-only + cap + source-rule; spec-gate grounding recommendation fires/doesn't-fire by class, `--force` override, quick-mode skip; clarify exit criterion (open questions block / force escape / resolution clears).
- **CLI integration:** `noir task research` (list/record) paths, rejection cases, and the briefing reuse of `research:index`; **no network** (offline suite).
- **Skills:** pack validation on the new `noir-research` (validateSkill + lintSkill + registry), mirroring the C3 quality gate.
- **Docs:** capability-04 delta #1/#2 status updated; `docs/explanation/sdd-workflow.md` gains a Research & clarify section; skill count updated (26→27) across docs where it appears.

## Rollback

- **Additive throughout.** `research:<taskId>` and `research:index` are new KV keys; `ResearchEntry`/`research` config are new optional shapes; `openQuestions` is a new optional TaskState field; the soft spec-gate note and the clarify exit check engage only for classes in `research.recommendFor` / non-empty `openQuestions` (default behavior for legacy tasks is unchanged).
- **Rollback:** remove the new skill + CLI subcommands + config slice + `writeClarifications`; existing tests pass without modification. The clarify exit check is the only behavioral change — it can be disabled entirely via `research.recommendFor: []` + a config to disable the open-questions check (default legacy tasks have no `openQuestions` set, so they are unaffected).
- **Migration:** none — no store schema change.

## References

- `packages/workflow/src/types.ts` — `WorkflowGateConfig` (gains `research`), `TaskState` (gains `openQuestions`)
- `packages/workflow/src/engine.ts` — `prdRecommendation` (pattern to mirror), `recordGate`
- `packages/workflow/src/gates.ts` — `recordGate`/`readGateHistory` (pattern for `recordResearch`/`readResearch`)
- `packages/workflow/src/artifacts.ts` — new `writeClarifications`; `writeAuditExport` (opt-in render pattern)
- `packages/daemon/src/server.ts` — new `workflow_research_record` tool; degraded envelopes
- `packages/cli/src/commands/task.ts` — new `noir task research` subcommands
- `packages/skills/builtin/noir-research/SKILL.md` — new skill
- `packages/adapters` — plan-mode mapping for the read-only research mode
- Docs to sync: `docs/roadmap/capability-04-ai-development-workflow.md`, `docs/explanation/sdd-workflow.md`, skill count references
