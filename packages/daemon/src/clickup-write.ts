// `noir.clickup_write` gated-write-proxy. The daemon-side
// companion to the `noir-clickup` skill's write flows (2/3/4/5). SECURITY-CRITICAL.
//
// The proxy owns EXACTLY four responsibilities, and ONLY these:
//   1. ALLOWLISTED URL construction — URLs are built from `op` + `payload` + the
//      workspace binding (`teamId`/`listId`). A caller-supplied `url` is NEVER
//      honored; ClickUp ids are validated against a strict charset so a task id
//      can't smuggle a path segment. This is the prompt-injection defense: a
//      malicious task field can become JSON DATA in a POST body, but it can NEVER
//      redirect the proxy to a different endpoint.
//   2. DRY-RUN → CONFIRM gate — unless `confirm === true`, the proxy computes the
//      exact would-be request(s) and returns a PREVIEW without any network call.
//      `fetch` is not even touched. Only an explicit `confirm:true` (surfaced to
//      the host's tool-approval gate) reaches the network.
//   3. EXECUTE — on confirm, POST/PUT to ClickUp API v2 with the `pk_<token>`
//      auth header (NO Bearer), concurrency cap 4 on batch, 429 backoff keyed on
//      `X-RateLimit-Reset` (await until reset, retry once — never blind-retry).
//   4. AUDIT — every EXECUTED write appends a record to `.noir/audit/` via the
//      seam's `writeIntegrationAudit`. Dry-runs are NOT audited.
//
// The token is resolved by the caller (the tool handler, via `resolveToken`) and
// passed in ONLY for the execute path; the dry-run path never sees it. The token
// NEVER appears in previews (redacted `pk_***`), results, or audit entries.
//
// Doctrine: graceful degradation (no-token ⇒ refuse, no fetch; no-config ⇒
// refuse; never a crash); NO silent writes (confirm gate is HARD); allowlist is
// the only source of URLs.

// ClickUp API v2 base. Constant — the proxy never accepts a base URL from input.
const CLICKUP_BASE = 'https://api.clickup.com/api/v2';

/** Strict charset for ClickUp ids (task/list/space/team). ClickUp task ids are
 *  alphanumeric (`abc123`) or numeric; custom ids look like `CU-42`. Allow
 *  letters, digits, underscore, hyphen only — rejects `/`, `?`, `#`, spaces, and
 *  anything else that could mutate the path/query. */
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function assertId(value: string, field: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new InvalidOp(`invalid ${field}: ${JSON.stringify(value)} (must match ${ID_PATTERN})`);
  }
  return value;
}

/** Op-shaped error thrown when input violates the contract (bad id, missing
 *  required field, unknown op). The handler maps it to `{ok:false, reason:'invalid-op'}`. */
export class InvalidOp extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOp';
  }
}

// ---------------------------------------------------------------------------
// Op vocabulary (spec resolution). The proxy accepts BOTH the short verbs
// (`status` | `subtask` | `comment` | `batch`) from the spec AND the
// `task:`-prefixed verbs (`task:set-status` | `task:create-subtask` |
// `task:comment` | `task:batch-create`) that the LOCKED `noir-clickup` SKILL.md
// documents. The skill is locked (cannot be edited), so the tool MUST
// honor the verbs the skill emits; the short forms are accepted as aliases for
// ergonomics + spec alignment. Normalized to the short form internally.
// ---------------------------------------------------------------------------
const OP_ALIASES: Record<string, string> = {
  'task:set-status': 'status',
  'task:create-subtask': 'subtask',
  'task:comment': 'comment',
  'task:batch-create': 'batch',
};
export type ClickUpOp = 'status' | 'subtask' | 'comment' | 'batch';
export function normalizeOp(op: string): ClickUpOp {
  const resolved = OP_ALIASES[op] ?? op;
  if (
    resolved !== 'status' &&
    resolved !== 'subtask' &&
    resolved !== 'comment' &&
    resolved !== 'batch'
  ) {
    throw new InvalidOp(`unknown op: ${JSON.stringify(op)}`);
  }
  return resolved;
}

/** Workspace binding the proxy resolves listId/teamId from (config > payload). */
export interface ClickUpBinding {
  teamId?: string;
  listId?: string;
}

/** A constructed HTTP request against an allowlisted endpoint. The auth header
 *  is ABSENT here — it is added at execute time only; the dry-run preview shows
 *  a redacted placeholder so the token never leaves the execute path. */
export interface BuiltRequest {
  method: 'GET' | 'POST' | 'PUT';
  /** Full allowlisted URL (constructed from op + payload + binding). */
  url: string;
  /** JSON body (already stringified-safe as an object). */
  body?: Record<string, unknown>;
  /** Stable descriptor for the audit `target` field (e.g. `task/abc123`). */
  target: string;
}

/** A single preview/result row. */
export interface RequestRow {
  method: string;
  url: string;
  body?: Record<string, unknown>;
  /** Redacted auth header for the preview (always `pk_***`). */
  auth: 'pk_***';
  target: string;
}

/** Resolved ClickUp workspace binding (config > payload). */
function resolveBinding(payload: Record<string, unknown>, binding: ClickUpBinding): ClickUpBinding {
  const listId =
    (typeof payload.listId === 'string' ? payload.listId : undefined) ?? binding.listId;
  const teamId =
    (typeof payload.teamId === 'string' ? payload.teamId : undefined) ?? binding.teamId;
  const resolved: ClickUpBinding = {};
  if (listId !== undefined) resolved.listId = assertId(listId, 'listId');
  if (teamId !== undefined) resolved.teamId = assertId(teamId, 'teamId');
  return resolved;
}

// ---------------------------------------------------------------------------
// Request builders — one per op. Each returns the request(s) the op renders.
// URLs come ONLY from these templates; a caller-supplied `url` is ignored.
// ---------------------------------------------------------------------------
function buildStatus(payload: Record<string, unknown>): BuiltRequest {
  const taskId = assertId(String(payload.taskId ?? ''), 'taskId');
  const status = payload.status;
  if (typeof status !== 'string' || status.length === 0) {
    throw new InvalidOp('status op requires payload.status (non-empty string)');
  }
  return {
    method: 'PUT',
    url: `${CLICKUP_BASE}/task/${taskId}`,
    body: { status },
    target: `task/${taskId}`,
  };
}

function buildSubtask(payload: Record<string, unknown>, binding: ClickUpBinding): BuiltRequest[] {
  const resolved = resolveBinding(payload, binding);
  if (!resolved.listId)
    throw new InvalidOp(
      'subtask op requires a listId (payload.listId or integrations.clickup.listId)',
    );
  const parentTaskId = assertId(String(payload.parentTaskId ?? ''), 'parentTaskId');
  const name = payload.name;
  if (typeof name !== 'string' || name.length === 0) {
    throw new InvalidOp('subtask op requires payload.name (non-empty string)');
  }
  const create: BuiltRequest = {
    method: 'POST',
    url: `${CLICKUP_BASE}/list/${resolved.listId}/task`,
    body: { name, parent: parentTaskId },
    target: `list/${resolved.listId}/task (parent ${parentTaskId})`,
  };
  const reqs = [create];
  // Optional follow-up: set the new subtask's status once it exists. The taskId
  // is the ClickUp-returned id; the proxy fills it from the create response at
  // execute time. At dry-run time, the preview shows the would-be request with
  // a placeholder id + a `__dependsOn` marker so the host sees the dependency.
  const status =
    typeof payload.status === 'string' && payload.status.length > 0 ? payload.status : undefined;
  if (status !== undefined) {
    reqs.push({
      method: 'PUT',
      url: `${CLICKUP_BASE}/task/__sub_id__`,
      body: { status },
      target: `task/<new subtask> (status)`,
    });
  }
  return reqs;
}

function buildComment(payload: Record<string, unknown>): BuiltRequest {
  const taskId = assertId(String(payload.taskId ?? ''), 'taskId');
  const commentText = payload.commentText;
  if (typeof commentText !== 'string' || commentText.length === 0) {
    throw new InvalidOp('comment op requires payload.commentText (non-empty string)');
  }
  const notifyAll = typeof payload.notifyAll === 'boolean' ? payload.notifyAll : false;
  const body: Record<string, unknown> = { comment_text: commentText, notify_all: notifyAll };
  // assignee is the ClickUp user id (integer) and OPTIONAL.
  if (payload.assigneeId !== undefined && payload.assigneeId !== null) {
    const assignee =
      typeof payload.assigneeId === 'number' ? payload.assigneeId : Number(payload.assigneeId);
    if (!Number.isFinite(assignee))
      throw new InvalidOp('comment op payload.assigneeId must be a number');
    body.assignee = assignee;
  }
  return {
    method: 'POST',
    url: `${CLICKUP_BASE}/task/${taskId}/comment`,
    body,
    target: `task/${taskId}/comment`,
  };
}

/** A normalized task for the batch op (H2 markdown + the `tasks[]` array both
 *  reduce to this). All fields are JSON DATA in the POST body — adversary text
 *  in a task title becomes the `name` string, never an executable instruction. */
export interface NormalizedTask {
  name: string;
  description?: string;
  tags?: string[];
  assignees?: number[];
  status?: string;
}

/** Parse H2-per-task markdown into normalized tasks. Each `## <title>` opens a
 *  task; body lines until the next `## ` are the description, EXCEPT lines that
 *  match `- key: value` which are folded into structured fields (assignees/tags).
 *  Tolerant: a missing leading H2 still yields the body as one task (named from
 *  the first non-empty line) so a slightly-malformed template still previews. */
export function parseH2Tasks(markdown: string): NormalizedTask[] {
  const lines = markdown.split(/\r?\n/);
  const tasks: NormalizedTask[] = [];
  let cur: NormalizedTask | null = null;
  const desc: string[] = [];
  for (const raw of lines) {
    const line = raw;
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2) {
      const title = h2[1];
      if (title !== undefined) {
        if (cur) cur.description = desc.join('\n').trim() || undefined;
        cur = { name: title.trim() };
        desc.length = 0;
        tasks.push(cur);
        continue;
      }
    }
    if (!cur) {
      // Pre-H2 content: skip bare blank lines; a stray line becomes a task so
      // the template still previews (graceful, not a crash).
      if (line.trim().length === 0) continue;
      cur = { name: line.trim() };
      desc.length = 0;
      tasks.push(cur);
      continue;
    }
    const meta = /^-\s+([A-Za-z_]+)\s*:\s*(.+?)\s*$/.exec(line);
    if (meta) {
      const keyRaw = meta[1];
      const valRaw = meta[2];
      if (keyRaw !== undefined && valRaw !== undefined) {
        const key = keyRaw.toLowerCase();
        const val = valRaw;
        if (key === 'tag' || key === 'tags') {
          cur.tags = [
            ...(cur.tags ?? []),
            ...val
              .split(',')
              .map((t) => t.trim())
              .filter((t) => t.length > 0),
          ];
        } else if (key === 'assignee' || key === 'assignees') {
          const ids = val
            .split(',')
            .map((t) => t.trim())
            .map((t) => Number(t))
            .filter((n) => Number.isFinite(n));
          cur.assignees = [...(cur.assignees ?? []), ...ids];
        } else if (key === 'status') {
          cur.status = val;
        } else {
          // Unknown meta key: keep as a description line (don't lose information).
          desc.push(line);
        }
      } else {
        desc.push(line);
      }
    } else {
      desc.push(line);
    }
  }
  if (cur) cur.description = desc.join('\n').trim() || undefined;
  // Drop tasks that ended up with an empty name (e.g. a trailing `## ` with no title).
  return tasks.filter((t) => t.name.length > 0);
}

function normalizeBatchInput(payload: Record<string, unknown>): NormalizedTask[] {
  if (Array.isArray(payload.tasks)) {
    return payload.tasks.map((t, i) => {
      if (typeof t !== 'object' || t === null)
        throw new InvalidOp(`batch payload.tasks[${i}] must be an object`);
      const obj = t as Record<string, unknown>;
      const name = obj.name;
      if (typeof name !== 'string' || name.length === 0)
        throw new InvalidOp(`batch payload.tasks[${i}].name required`);
      const out: NormalizedTask = { name };
      if (typeof obj.description === 'string') out.description = obj.description;
      if (Array.isArray(obj.tags)) out.tags = obj.tags.map((s) => String(s));
      if (Array.isArray(obj.assignees))
        out.assignees = obj.assignees.map((n) => Number(n)).filter((n) => Number.isFinite(n));
      if (typeof obj.status === 'string') out.status = obj.status;
      return out;
    });
  }
  if (typeof payload.markdown === 'string') {
    return parseH2Tasks(payload.markdown);
  }
  throw new InvalidOp('batch op requires payload.tasks[] OR payload.markdown (H2-per-task)');
}

function buildBatch(payload: Record<string, unknown>, binding: ClickUpBinding): BuiltRequest[] {
  const resolved = resolveBinding(payload, binding);
  if (!resolved.listId)
    throw new InvalidOp(
      'batch op requires a listId (payload.listId or integrations.clickup.listId)',
    );
  const tasks = normalizeBatchInput(payload);
  if (tasks.length === 0)
    throw new InvalidOp('batch op yielded no tasks (empty markdown / tasks[])');
  return tasks.map((t, i) => {
    const body: Record<string, unknown> = { name: t.name };
    if (t.description !== undefined) body.description = t.description;
    if (t.tags !== undefined && t.tags.length > 0) body.tags = t.tags;
    // ClickUp `POST /list/{list_id}/task` takes the PLURAL `assignees: number[]`
    // (see references/clickup-api.md). The singular `assignee` key is silently
    // ignored → tasks created with NO assignees while audit reports success
    // (silent data loss). Only the comment endpoint uses singular `assignee`.
    if (t.assignees !== undefined && t.assignees.length > 0) body.assignees = t.assignees;
    return {
      method: 'POST' as const,
      url: `${CLICKUP_BASE}/list/${resolved.listId}/task`,
      body,
      target: `list/${resolved.listId}/task (#${i + 1} ${t.name.slice(0, 40)})`,
    };
  });
}

/** Build ALL requests an op renders, WITHOUT touching the network. Used by both
 *  the dry-run preview (no auth) and the execute path (auth added). Throws
 *  `InvalidOp` on a contract violation (bad id, missing field, unknown op). */
export function buildRequests(
  opRaw: string,
  payload: Record<string, unknown>,
  binding: ClickUpBinding,
): { op: ClickUpOp; requests: BuiltRequest[] } {
  const op = normalizeOp(opRaw);
  switch (op) {
    case 'status':
      return { op, requests: [buildStatus(payload)] };
    case 'subtask':
      return { op, requests: buildSubtask(payload, binding) };
    case 'comment':
      return { op, requests: [buildComment(payload)] };
    case 'batch':
      return { op, requests: buildBatch(payload, binding) };
  }
}

/** Render a dry-run preview row set. NO auth header, NO network — the token
 *  never enters this path. */
export function previewRows(requests: BuiltRequest[]): RequestRow[] {
  return requests.map((r) => ({
    method: r.method,
    url: r.url,
    ...(r.body !== undefined ? { body: r.body } : {}),
    auth: 'pk_***',
    target: r.target,
  }));
}

// ---------------------------------------------------------------------------
// Execute path. Reached ONLY when `confirm === true`. The token is added here
// (and ONLY here) as `Authorization: pk_<token>` (NO Bearer — ClickUp v2 rejects
// Bearer). 429 backoff reads `X-RateLimit-Reset` and awaits until reset, then
// retries ONCE per request.
// ---------------------------------------------------------------------------

/** Minimal fetch shape the proxy needs. Bound to global `fetch` in production;
 *  a spy in tests (cassette). */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ExecResult {
  target: string;
  method: string;
  url: string;
  httpStatus: number;
  success: boolean;
  /** ClickUp's parsed JSON body (or `{}` when absent). NEVER contains the token
   *  (ClickUp never echoes it). */
  response: Record<string, unknown>;
  /** Present when a 429 backoff fired on this request. */
  rateLimitedWaitMs?: number;
  /** For `subtask` with a status follow-up: the new subtask id resolved from the
   *  create response so the host can reference it. */
  newTaskId?: string;
  /** Error message on a non-2xx / network failure (NEVER includes the token). */
  error?: string;
}

/** Build the outbound auth+content-type headers. The token is added here and
 *  ONLY here (as `Authorization: pk_<token>`, NO Bearer — ClickUp v2 rejects
 *  Bearer). Despite the historical name, this function does NOT redact — it
 *  attaches the RAW token; the dry-run preview never calls it (previews show
 *  the redacted `pk_***` placeholder instead), so the live token only travels
 *  on the execute path's outbound request. */
function authHeaders(token: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `pk_${token}`,
  };
}

/** Read `X-RateLimit-Reset` (epoch seconds) and compute the wait until reset.
 *  Caps at a sane maximum so a malformed far-future header can't pin the daemon. */
function rateLimitWaitMs(res: Response): number | undefined {
  const reset = res.headers.get('X-RateLimit-Reset');
  if (reset === null) return undefined;
  const epochSec = Number(reset);
  if (!Number.isFinite(epochSec)) return undefined;
  const waitMs = epochSec * 1000 - Date.now();
  // Clamp to [0, 60s]. A negative (past reset) → 0 (retry now). A huge value
  // (malformed) → 60s (don't pin the daemon on a bad header).
  if (waitMs <= 0) return 0;
  if (waitMs > 60_000) return 60_000;
  return waitMs;
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((r) => setTimeout(r, ms));
}

/** Execute a single request with one 429-bounded retry. */
async function executeOne(
  req: BuiltRequest,
  token: string,
  fetchImpl: FetchLike,
): Promise<ExecResult> {
  const init: RequestInit = {
    method: req.method,
    headers: authHeaders(token),
    ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
  };
  let res: Response;
  try {
    res = await fetchImpl(req.url, init);
  } catch (err) {
    return {
      target: req.target,
      method: req.method,
      url: req.url,
      httpStatus: 0,
      success: false,
      response: {},
      error: err instanceof Error ? err.message : String(err),
    };
  }
  // 429: honor the header literally, await until reset, retry ONCE.
  if (res.status === 429) {
    const waitMs = rateLimitWaitMs(res) ?? 1000;
    await sleep(waitMs);
    try {
      res = await fetchImpl(req.url, init);
    } catch (err) {
      return {
        target: req.target,
        method: req.method,
        url: req.url,
        httpStatus: 429,
        success: false,
        response: {},
        rateLimitedWaitMs: waitMs,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    const final = await toExecResult(req, res);
    return { ...final, rateLimitedWaitMs: waitMs };
  }
  return toExecResult(req, res);
}

async function toExecResult(req: BuiltRequest, res: Response): Promise<ExecResult> {
  const success = res.status >= 200 && res.status < 300;
  let parsed: Record<string, unknown> = {};
  try {
    parsed = (await res.json()) as Record<string, unknown>;
  } catch {
    try {
      const text = await res.text();
      parsed = text.length > 0 ? { _raw: text } : {};
    } catch {
      parsed = {};
    }
  }
  const result: ExecResult = {
    target: req.target,
    method: req.method,
    url: req.url,
    httpStatus: res.status,
    success,
    response: parsed,
  };
  if (!success) {
    const errVal = parsed.err;
    result.error = typeof errVal === 'string' ? errVal : `HTTP ${res.status}`;
  }
  return result;
}

/** Concurrency-limited map (cap 4 per spec: 4-8, conservative). Each item gets
 *  at most one in-flight request; the 429 retry is awaited within its slot. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) break;
      const item = items[i];
      // `i` is bounded by items.length above; the indexed access is safe.
      if (item !== undefined) results[i] = await fn(item, i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Execute an op's requests against ClickUp. The `subtask` op is special: its
 *  optional status follow-up needs the create response's `id`, so the two
 *  requests run sequentially with the id threaded through. `batch` runs with a
 *  concurrency cap of 4 + per-request 429 backoff. */
export async function executeOp(
  op: ClickUpOp,
  requests: BuiltRequest[],
  token: string,
  fetchImpl: FetchLike,
): Promise<ExecResult[]> {
  if (op === 'subtask' && requests.length === 2) {
    const create = requests[0];
    const statusReq = requests[1];
    if (!create || !statusReq) {
      // Defensive: length === 2 guard above makes this unreachable, but
      // noUncheckedIndexedAccess forces the check.
      throw new InvalidOp('subtask op expects exactly two rendered requests');
    }
    const createRes = await executeOne(create, token, fetchImpl);
    if (!createRes.success) return [createRes];
    const newId = typeof createRes.response.id === 'string' ? createRes.response.id : undefined;
    if (!newId) {
      // Create succeeded but no id came back — can't set status. Surface the
      // partial success; the host sees the create worked, the status didn't.
      return [
        createRes,
        {
          target: statusReq.target,
          method: statusReq.method,
          url: statusReq.url,
          httpStatus: 0,
          success: false,
          response: {},
          error: 'subtask created but no id returned; status follow-up skipped',
        },
      ];
    }
    createRes.newTaskId = newId;
    // The response-derived id is substituted into the allowlisted URL template
    // — validate it against the SAME charset as every caller-supplied id so a
    // compromised/buggy ClickUp response can't smuggle a path segment (the
    // module's stated invariant: every id is charset-validated before use in a URL).
    assertId(newId, 'subtask-create-response.id');
    // Rewrite the placeholder URL with the real id and execute.
    const realStatusReq: BuiltRequest = {
      method: statusReq.method,
      url: statusReq.url.replace('__sub_id__', newId),
      target: `task/${newId} (status)`,
      ...(statusReq.body !== undefined ? { body: statusReq.body } : {}),
    };
    const statusRes = await executeOne(realStatusReq, token, fetchImpl);
    return [createRes, statusRes];
  }
  if (op === 'batch') {
    return mapWithConcurrency(requests, 4, (req) => executeOne(req, token, fetchImpl));
  }
  // status / comment / (subtask without status): single request, executed in order.
  const out: ExecResult[] = [];
  for (const req of requests) {
    out.push(await executeOne(req, token, fetchImpl));
  }
  return out;
}
