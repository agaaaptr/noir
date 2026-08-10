# Root-cause tracing — evidence at every boundary

Deep reference for `noir-systematic-debugging`. Use this when the bug spans multiple layers or the root cause is not obvious from the first stack trace.

## Why boundaries matter

A bug is rarely where it surfaces. "The API returns 500" could mean the route handler, the service, the DB layer, or the config. If you fix at the surface, you patch a symptom; the same root cause fails again through another path. Tracing evidence at each boundary converts a guess into a data-backed narrowing.

## The boundary checklist

For a request that flows CLI → adapter → daemon → store (Noir's own shape), or API → service → DB, instrument each layer BEFORE proposing a fix:

1. **Entry** — what arrived? Log the raw request: method, path, headers, body (sanitized).
2. **Validation** — did the input pass validation? A rejected payload fails here.
3. **Auth/context** — was identity resolved? A missing token fails here.
4. **Service logic** — what did the service compute? Log inputs + outputs at the boundary.
5. **Persistence** — what SQL/query ran? Log the query + params, then the result/error.
6. **Exit** — what returned? Compare the response to the handler's intent.

## Technique: log at the boundary, not inside

Put one log line at each boundary (enter/exit) rather than scattering logs through the middle. The boundary log answers "did X reach layer N correctly?" — the middle log answers "what happened inside layer N?" Start with boundaries; only go inside when a boundary shows the input was wrong.

## Technique: binary search the layers

Instead of instrumenting all 6 boundaries, bisect: check the MIDDLE layer first. If the middle sees the right input and produces the wrong output, the bug is in the middle or below. If the middle sees wrong input, the bug is above. Each check halves the search space.

## Technique: the "did it change?" check

The most common root cause is a recent change. Before tracing:
- `git log --oneline -10` — what changed recently?
- `git diff HEAD~1` — what's different in the code that touches this path?
- Check config/dependency changes: a new package version, a toggled feature flag, an env var change.

## Recording the trace

For a debugging session, keep a compact trace log:

```
REQUEST  GET /api/v2/task/86eyeryfe?include_subtasks=true
VALIDATE ok
AUTH     pk_*** (ok)
SERVICE  fetched task, subtasks=[] (NOT null!)   ← suspicious: empty array
FINDING  subtasks excluded by default; include_subtasks=true missing
```

The trace makes the evidence explicit and reviewable — the same honesty `noir-verifying` demands.

## When the trace points to an architectural issue

If 3+ fixes have failed, each revealing a new problem in a different layer, stop fixing and name the pattern that is not holding (e.g. "the daemon caches process.env at spawn, so any env-var-dependent path is stale"). Surface it as an architectural question with the trace as evidence.
