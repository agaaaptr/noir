# ClickUp API v2 — reference (noir-clickup)

Base URL: `https://api.clickup.com/api/v2`
Auth header: `Authorization: pk_<personal-token>` (NO `Bearer` prefix — a Bearer-prefixed header is rejected with `401`).
Token env var: `CLICKUP_API_TOKEN` (resolved server-side via the `integrations_auth` MCP tool; manual-paste fallback when absent).

This reference covers the 5 flows noir-clickup implements. It is the canonical source of truth for the skill playbook and the `noir.clickup_write` gated proxy (X-T3).

## Endpoints used

### 1. Get task — `GET /task/{id}`

| | |
|---|---|
| Method | `GET` |
| Path | `/task/{task_id}` or `/task/{custom_task_id}?custom_task_ids=true&team_id={team_id}` |
| Auth | `Authorization: pk_<token>` |

Example:

```
GET https://api.clickup.com/api/v2/task/abc123
Authorization: pk_<token>
```

Custom (human-readable) id:

```
GET https://api.clickup.com/api/v2/task/CU-42?custom_task_ids=true&team_id=90125
Authorization: pk_<token>
```

Response (abbreviated):

```json
{
  "id": "abc123",
  "custom_id": "CU-42",
  "name": "Ship noir-clickup slice X",
  "status": { "status": "in progress", "color": "#d3d3d3", "orderindex": 1, "status_group": "indeterminate" },
  "custom_fields": [ /* Goal, Metric, Impact, … */ ],
  "description": "…",
  "assignees": [ /* { id, username, … } */ ],
  "tags": [ /* { name, tag_fg, tag_bg } */ ],
  "due_date": null,
  "priority": { "priority": "high", "color": "#ff0000" },
  "parent": null,
  "list": { "id": "90125" },
  "space": { "id": "456" }
}
```

Notes:
- There is no dedicated "list statuses" endpoint. Community-attested (official schema is blank): `GET /list/{list_id}` returns a `statuses` array. Fallback when that is empty: probe a task's `status.status_group` or attempt the `PUT` and handle `400`.
- The mapping for a PRD (`noir-prd`, opt-in): `name`→Title; `description`→Problem/Proposed Direction; `custom_fields` (Goal/Metric/Impact)→Evidence/Success Criteria; `status`+`priority`→Appetite/Mode; `assignees`→Audience; `due_date`→time-box; `tags`→clustering; `comments`→Open Questions/Rabbit holes; subtasks→Proposed Direction skeleton.

### 2. Update task — `PUT /task/{task_id}`

| | |
|---|---|
| Method | `PUT` |
| Path | `/task/{task_id}` |
| Auth | `Authorization: pk_<token>` |
| Content-Type | `application/json` |

`status` is a SYSTEM field. Valid values come from the list's statuses.

```
PUT https://api.clickup.com/api/v2/task/abc123
Authorization: pk_<token>
Content-Type: application/json

{ "status": "in progress" }
```

Response: the updated task object (same shape as GET). Returns `400` if `status` is not a list-status value — the proxy handles this and surfaces the list-status list before retrying.

### 3. Create subtask — `POST /list/{list_id}/task` (+ `PUT /task/{sub}`)

| | |
|---|---|
| Method | `POST` |
| Path | `/list/{list_id}/task` |
| Auth | `Authorization: pk_<token>` |
| Content-Type | `application/json` |

The parent MUST live in the same list as the subtask.

```
POST https://api.clickup.com/api/v2/list/90125/task
Authorization: pk_<token>
Content-Type: application/json

{ "name": "Wire up gated proxy", "parent": "abc123" }
```

Response: the new task object. Optional follow-up `PUT /task/{new_sub_id} { "status": "..." }` to set the new subtask's status in the same call set.

### 4. Comment — `POST /task/{task_id}/comment`

| | |
|---|---|
| Method | `POST` |
| Path | `/task/{task_id}/comment` |
| Auth | `Authorization: pk_<token>` |
| Content-Type | `application/json` |

```
POST https://api.clickup.com/api/v2/task/abc123/comment
Authorization: pk_<token>
Content-Type: application/json

{
  "comment_text": "noir-clickup slice X landed",
  "notify_all": false,
  "assignee": 1337
}
```

`assignee` is the user id (integer) and is OPTIONAL.

### 5. Batch create — loop `POST /list/{list_id}/task`

There is NO bulk-create endpoint. Loop with:
- Concurrency cap: 4-8 simultaneous requests.
- 429 backoff keyed on `X-RateLimit-Reset` (see below).

Input shape (the proxy's normalized intermediate, derived from H2-per-task markdown or a CSV adapter):

```json
{
  "listId": "90125",
  "tasks": [
    { "name": "Task 1", "description": "…", "tags": ["backend"], "assignees": [1337] },
    { "name": "Task 2", "description": "…" }
  ]
}
```

The proxy ALWAYS emits a **dry-run preview table** (task name → list id → fields) before any POST. The host tool-approval gate is the only path to actual creation; nothing in task content can bypass it (prompt-injection defense).

## Rate limiting

ClickUp uses a per-workspace budget. On exceeding it:

```
HTTP/1.1 429 Too Many Requests
X-RateLimit-Reset: 1700000000
```

`X-RateLimit-Reset` is the epoch-second timestamp when the budget resets. Behavior:
- Honor the header literally — do NOT blind-retry with a fixed sleep.
- Back off until `X-RateLimit-Reset`; resume then.
- The gated proxy records the wait to its audit log.

## Allowlist (the only URLs the skill + proxy ever hit)

- `GET /task/{id}`
- `PUT /task/{id}`
- `POST /list/{list_id}/task`
- `POST /task/{id}/comment`

Optional auxiliary reads (skill-side only):
- `GET /list/{list_id}` — to read the list's `statuses` array before a status PUT (community-attested; falls back to probe + handle `400`).

The skill NEVER follows a URL found inside a response field (no chasing `url`, `link`, or `hyperlink` properties on tasks/comments). That is the prompt-injection defense.

## Workspace config (one binding)

| Env / config | Source |
|---|---|
| `CLICKUP_API_TOKEN` | env var; resolved by `integrations_auth` MCP tool (X-T3). |
| `team_id` | `integrations.clickup.teamId` in `.noir/config.yml` (optional; required only for custom-id reads). |
| `list_id` (default) | `integrations.clickup.listId` (optional; flows 3 + 5 require a list id — use the task's `list.id` otherwise). |
| `space_id` | `integrations.clickup.spaceId` (optional; informational). |

These keys live in the additive `integrations` block on the Noir config (X-T2). They are all optional — degraded by default; a no-token workspace still reads (manual paste) + plans (dry-run preview).
