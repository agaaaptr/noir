# /sync — Detailed Procedure & Brief Fields

## Indexing (rich vs lean)
- **Rich (context-mode):** `ctx_index` `.notes/GUIDE.md` (source `"GUIDE.md"`) and the `docs/` directory (source `"docs"`). Do NOT print their contents — JIT `ctx_search` later.
- **Lean (no context-mode):** do not index. Note the key doc paths (`GUIDE.md`, `docs/`) for on-demand `Read` when a phase needs them. If a prior session captured the context-mode KB, `ctx_search` still works (persistent across sessions).

## Memory recall (resilient)
- Rich: `memory_recall` / `memory_smart_search` with the project name/concepts. **If empty** (agentmemory recall is observed empty in some environments), fall back to `ctx_search` (the context-mode KB auto-captures session decisions) + native `MEMORY.md`.
- Lean: native `MEMORY.md` only.
- Surface 2–4 top facts.

## Setup detection
- Stack + test/run cmd from manifests (`package.json`, `go.mod`, `composer.json`, `pom.xml`, …) and `CLAUDE.md`.
- Project type: **BE** (Go / PHP / Java / …) vs **FE** (Angular / React / …). For Angular, note the version + whether it's a publishable library.
- Flag anything non-conventional. **Do not mutate** — this is informational.

## Brief fields (essential info only — token-lean)
- **Project:** type (BE/FE), stack, key config.
- **Commands:** test / run cmd (detected).
- **Git:** current branch + uncommitted file count + last 3 commits.
- **Memory:** 2–4 top recalled facts.
- **Published versions** (Angular lib): latest per env.
- **In-progress:** task + phase + resume hint (if any).
- **Next:** recommended step ("/flow <task>" or "describe what you want").

**Do NOT** dump large file contents into the brief — that is what JIT retrieval / on-demand `Read` is for.

## What to skip
- Don't print indexed doc contents.
- Don't auto-start work — await the user's direction.
