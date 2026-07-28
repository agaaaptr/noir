# Slice X — Integration skill system (ClickUp first) — design spec

> v1.x capability slice. Companion: `docs/specs/2026-07-25-v1x-capabilities-design.md` §4.4 + §4.4.1 (ClickUp reference, locked). **Predecessor keystone K (committed)** provides the daemon/MCP + managed-block foundations.
> **Status: NOT started.** This spec is the implementation reference; the next session writes the plan + executes.

## Goal
A first-class integration layer: **skill-only default** (read+playbook) + **gated-write-proxy MCP tool** (stateless writes, confirm gate) + **full runtime tier** (stateful, gated on keychain). First integration = **ClickUp** (all 5 flows verified feasible with the `pk_` personal token — no OAuth).

## Locked decisions
- **3-tier model:** skill-only / **gated-write-proxy** (stateless writes via a Noir MCP tool that enforces dry-run→confirm) / full-runtime (stateful OAuth/webhook/polling, gated on keychain).
- **`integration.json` declaration:** `{ name, auth{type,tokenEnv,fallback}, runtime: 'none'|'gated-write-proxy'|'mcp-stdio'|'external-mcp', sdd{intakeFrom,writeBack}, mcp }`.
- ClickUp = first (Q4a); skill-only + gated-write-proxy + 2-way sync (backlog SP-6).
- **OAuth = refuse until keychain** (Q4b); never silently lower the security bar.
- Flow 5 read = **markdown-import now** (Docs-URL defer v1.x) (Q-ClickUp 1).
- Write-gate = **skill + gated-write-proxy MCP tool** (Q-ClickUp 2).
- Template = **MD H2-per-task + CSV** (Q-ClickUp 3).
- PRD from task = **explicit opt-in** (Q-ClickUp 4).
- Same `@noir-ai/skills` pack (import-isolation for runtime deps); separate pkg only for native/heavy deps.

## ClickUp 5 flows (verified API v2; auth `Authorization: pk_<token>`, NO Bearer)
1. `GET /task/{id}` (numeric, or `?custom_task_ids=true&team_id=`) → bounded model drafts PRD (**opt-in**) + emits task-detail md doc.
2. `PUT /task/{id} {status}` — `status` is a system field; valid values from the list's statuses.
3. `POST /list/{list_id}/task {name,parent}` (subtask; parent same list) + `PUT /task/{sub} {status}`.
4. `POST /task/{id}/comment {comment_text, notify_all, assignee?}`.
5. Batch create — **no bulk endpoint** → loop `POST /list/{list_id}/task` (concurrency cap 4-8 + 429 backoff reading `X-RateLimit-Reset`); input = H2-per-task MD template (+ CSV adapter); dry-run preview table → **explicit confirm** → POST.

## Architecture
- `packages/skills/integrations/<name>/{SKILL.md, integration.json, references/, [server/]}`.
- `@noir-ai/skills`: add `discoverIntegrations()` (sibling to `discoverBuiltin`) + `integration.json` Zod schema + validate; widen emit for host MCP config when `runtime∈{mcp-stdio,external-mcp}`. **(This is the deferred K3 — lands here.)**
- `@noir-ai/adapters`: `HostAdapter.emitMcpConfig(integration?, ctx)` overload (S10-aware abstraction).
- `@noir-ai/core`: `integrations: {[name]: {auth, runtime, …}}` config block.
- **daemon:** `integrations_auth` MCP tool (resolve `CLICKUP_API_TOKEN` server-side at call time → kills the non-interactive-shell gotcha; skill never reads shell env) + `noir.clickup_write` gated-write-proxy (dry-run→confirm→POST + audit) + (config-only) emit host MCP for `external-mcp`.
- `noir-prd` skill (built in P) + ClickUp intake bridge (`sdd.intakeFrom: 'task'`); `noir-wrap` write-back (`sdd.writeBack: ['status','subtasks']`).

## Verify-live before lock-in (NOT blockers; runtime checks)
- ClickUp `GET /list/{id}` returns a usable `statuses` array (no dedicated endpoint; community-attested; official schema blank) — fallback: probe tasks / attempt PUT + handle 400.
- Tag auto-create vs 400 (ClickApp-dependent) — runtime check + "create missing tag?" prompt.

## Acceptance
- ClickUp skill (5 flows) works with the `pk_` token; gated-write-proxy enforces confirm before any write; offline cassettes in CI (no real network); `integrations_auth` resolves the token.
- H2-per-task MD + CSV parser → normalized tasks → dry-run confirm → batch POST (rate-limit-aware).
- 746+ tests green; cassette-based tests (mcp-record or MockServer).

## Open questions (next-session clarification)
- **X-OQ1:** gated-write-proxy tool shape — generic `integrations_call(name, op, payload)` or per-integration `noir.clickup_*` tools? [lean: per-integration, clearer]
- **X-OQ2:** audit log location for write-proxy calls (`.noir/audit/` reuse, or a new integrations log)?
- **X-OQ3:** 2-way sync trigger — at `/wrap` only, or also a standalone `noir clickup sync`? (SP-6)
- **X-OQ4:** cassette strategy — `mcp-record` vs MockServer vs both?

## Risks
- Scope creep (default-deny runtime tier; ADR required per escalation).
- Multi-host MCP wiring divergence (abstraction lives in `HostAdapter`, not the integration).
- Prompt-injection in skill-only reads (allowlisted endpoints + host tool-approval gate; document in `SKILL.md`).
- OAuth storage before keychain (refuse; explicit opt-in only if ever allowed — never silent).
