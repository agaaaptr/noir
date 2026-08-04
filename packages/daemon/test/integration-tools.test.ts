// MCP round-trip + cassette tests for the integration tools:
// `integrations_auth` + `noir_clickup_write`. Mirrors packages/daemon/test/memory-
// tools.test.ts (InMemoryTransport + @modelcontextprotocol/client Client).
//
// OFFLINE / CASSETTE (NFR-2, X-OQ4): global `fetch` is replaced with a spy whose
// only fixtures are ClickUp API v2 URLs. The CI INVARIANT below FAILS the suite
// if any real `fetch` to a non-allowlisted host is attempted — the proxy can
// NEVER reach an endpoint outside its allowlist (prompt-injection defense).
//
// Security assertions (the load-bearing ones):
//   1. DRY-RUN (confirm absent/false) makes ZERO fetch calls — the confirm gate
//      is HARD; nothing in code or task content can bypass it.
//   2. CONFIRM=true executes via the cassette, writes the audit, and sends the
//      auth header as `pk_<token>` (NO Bearer).
//   3. No-token ⇒ refuse with NO fetch call (graceful; manual-paste fallback).
//   4. The token value NEVER appears in stderr / the dry-run preview / the audit
//      file — it travels only in the tool RESULT + the outbound auth header.
//   5. A caller-supplied `url` in the payload is IGNORED — URLs come ONLY from
//      the op + binding (prompt-injection defense).
//   6. Batch 429 backoff reads X-RateLimit-Reset then retries once.
//   7. Batch H2-markdown parses into normalized tasks.
//
// These do NOT open a store (the integration service is store-independent), so
// they run on every platform without the sqlite-vec probe.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { ProjectInfo } from '@noir-ai/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildRequests, InvalidOp, parseH2Tasks } from '../src/clickup-write.js';
import { buildIntegrationService } from '../src/integration-seam.js';
import { createNoirServer } from '../src/server.js';

// --- fetch cassette (offline; X-OQ4) --------------------------------------
// The spy holds fixture responses keyed by `<METHOD> <URL>`; an unexpected call
// throws so the CI invariant (no real network / no off-allowlist host) fails the
// test loudly. A `history` array records every call for assertions.
type FetchInit = { method?: string; headers?: Record<string, string>; body?: string };
type Fixture = { status: number; body: unknown; headers?: Record<string, string> };

function makeCassette(table: Record<string, Fixture | ((init: FetchInit) => Fixture)>) {
  const history: { url: string; init: FetchInit }[] = [];
  const fetchMock = vi.fn(async (url: string, init: FetchInit) => {
    history.push({ url, init });
    const key = `${(init.method ?? 'GET').toUpperCase()} ${url}`;
    const entry = table[key];
    if (!entry) {
      throw new Error(
        `CASSETTE MISS + NETWORK GUARD: unexpected real fetch to ${key}. The proxy must only hit allowlisted fixture URLs (prompt-injection defense).`,
      );
    }
    const fx = typeof entry === 'function' ? entry(init) : entry;
    return {
      ok: fx.status >= 200 && fx.status < 300,
      status: fx.status,
      headers: {
        get: (h: string) => fx.headers?.[h.toLowerCase()] ?? null,
      },
      json: async () => fx.body,
      text: async () => JSON.stringify(fx.body),
    } as unknown as Response;
  });
  return { fetchMock, history };
}

const realFetch = globalThis.fetch;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-int-tools-'));
});
afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(root, { recursive: true, force: true });
});

const project: ProjectInfo = {
  id: 'deadbeef',
  name: 'int-demo',
  root,
  config: {
    host: 'claude',
    mode: 'full',
    daemon: { idleTimeoutSec: 900 },
    // Bind noir-clickup to a workspace list so the gated proxy can build URLs
    // from the config when the payload omits listId. (`auth: {}` mirrors the
    // parsed NoirConfig shape — the schema defaults it to `{}`.)
    integrations: {
      clickup: {
        auth: {},
        runtime: 'gated-write-proxy',
        teamId: '90125',
        listId: 'list42',
      },
    },
  },
};

async function callTool(
  server: ReturnType<typeof createNoirServer>,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: 'noir-test', version: '0.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name, arguments: args });
    const block = result.content?.[0];
    return JSON.parse((block as { text: string }).text) as Record<string, unknown>;
  } finally {
    await client.close();
  }
}

async function listToolNames(server: ReturnType<typeof createNoirServer>): Promise<string[]> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: 'noir-test', version: '0.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    return listed.tools.map((t) => t.name);
  } finally {
    await client.close();
  }
}

/**
 * MCP protocol guard — every registered tool name MUST match the spec charset
 * /^[a-zA-Z0-9_-]{1,64}$/. A dotted name (`noir.clickup_write`) is INVALID at
 * the protocol layer: the host rejects the tools/list, and the whole MCP session
 * fails to connect (the `-32000` the user hit). This is the regression guard that
 * would have caught it — register a dotted tool and this suite fails.
 */
const MCP_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

function newServer() {
  const integrations = buildIntegrationService(root, project.config.integrations ?? {});
  return createNoirServer({ project, transport: 'stdio', daemon: false, integrations });
}

describe('integration MCP tools — registration', () => {
  it('registers ONLY protocol-valid tool names ([a-z0-9_-])', async () => {
    // MCP spec: tool names are restricted to [a-zA-Z0-9_-]. A dotted name
    // (noir.clickup_write) makes the host reject tools/list and kills the whole
    // session — the failure mode this suite guards against.
    const server = newServer();
    const names = await listToolNames(server);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(name, `tool name "${name}" must match MCP charset`).toMatch(MCP_TOOL_NAME);
    }
  });

  it('registers integrations_auth always; noir_clickup_write when a gated-write-proxy declaration ships', async () => {
    const server = newServer();
    const names = await listToolNames(server);
    expect(names).toContain('integrations_auth');
    expect(names).toContain('noir_clickup_write');
  });

  it('honors integrations.clickup.runtime "none" — noir_clickup_write is NOT registered but integrations_auth still is', async () => {
    // A user opts out of writes for a read-only run by downgrading the runtime
    // to `none` locally. The declaration still ships `gated-write-proxy`, so the
    // gate must read the EFFECTIVE runtime (config overlay wins), not the
    // declaration. integrations_auth stays registered (the tier model: `none` =
    // skill-side reads still need the token).
    const intProject: ProjectInfo = {
      ...project,
      config: {
        ...project.config,
        integrations: {
          clickup: {
            ...(project.config.integrations?.clickup ?? {}),
            runtime: 'none',
          },
        },
      },
    };
    const integrations = buildIntegrationService(root, intProject.config.integrations ?? {});
    const server = createNoirServer({
      project: intProject,
      transport: 'stdio',
      daemon: false,
      integrations,
    });
    const names = await listToolNames(server);
    expect(names).toContain('integrations_auth');
    expect(names).not.toContain('noir_clickup_write');
  });

  it('explicit runtime "gated-write-proxy" registers both tools (parity with the unset/declaration default)', async () => {
    // The positive case: an explicit `gated-write-proxy` overlay behaves the
    // same as the declaration default (both tools register). Locks the
    // effectiveRuntime === declaration.runtime path.
    const intProject: ProjectInfo = {
      ...project,
      config: {
        ...project.config,
        integrations: {
          clickup: {
            ...(project.config.integrations?.clickup ?? {}),
            runtime: 'gated-write-proxy',
          },
        },
      },
    };
    const integrations = buildIntegrationService(root, intProject.config.integrations ?? {});
    const server = createNoirServer({
      project: intProject,
      transport: 'stdio',
      daemon: false,
      integrations,
    });
    const names = await listToolNames(server);
    expect(names).toContain('integrations_auth');
    expect(names).toContain('noir_clickup_write');
  });
});

describe('integrations_auth — token resolution', () => {
  it('resolves by integration name (declaration tokenEnv) when the env var is set', async () => {
    process.env.CLICKUP_API_TOKEN = 'tk_secret123';
    const server = newServer();
    const res = await callTool(server, 'integrations_auth', { integration: 'noir-clickup' });
    expect(res.ok).toBe(true);
    expect(res.token).toBe('tk_secret123');
    expect(res.envVar).toBe('CLICKUP_API_TOKEN');
    delete process.env.CLICKUP_API_TOKEN;
  });

  it('reports no-token when the env var is absent (manual-paste fallback path)', async () => {
    delete process.env.CLICKUP_API_TOKEN;
    const server = newServer();
    const res = await callTool(server, 'integrations_auth', { integration: 'noir-clickup' });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('no-token');
    expect(res.envVar).toBe('CLICKUP_API_TOKEN');
  });

  it('resolves by explicit envVar (no declaration needed)', async () => {
    process.env.MY_CUSTOM_TOKEN = 'tk_xyz';
    const server = newServer();
    const res = await callTool(server, 'integrations_auth', { envVar: 'MY_CUSTOM_TOKEN' });
    expect(res.ok).toBe(true);
    expect(res.token).toBe('tk_xyz');
    delete process.env.MY_CUSTOM_TOKEN;
  });

  it('honors a config auth.tokenEnv override over the declaration default', async () => {
    const intProject: ProjectInfo = {
      ...project,
      config: {
        ...project.config,
        integrations: {
          clickup: {
            runtime: 'gated-write-proxy',
            listId: 'list42',
            auth: { tokenEnv: 'CLICKUP_TOKEN_OVERRIDE' },
          },
        },
      },
    };
    process.env.CLICKUP_TOKEN_OVERRIDE = 'tk_overridden';
    const integrations = buildIntegrationService(root, intProject.config.integrations ?? {});
    const server = createNoirServer({
      project: intProject,
      transport: 'stdio',
      daemon: false,
      integrations,
    });
    const res = await callTool(server, 'integrations_auth', { integration: 'noir-clickup' });
    expect(res.ok).toBe(true);
    expect(res.token).toBe('tk_overridden');
    expect(res.envVar).toBe('CLICKUP_TOKEN_OVERRIDE');
    delete process.env.CLICKUP_TOKEN_OVERRIDE;
  });

  it('refuses unknown-integration without crashing', async () => {
    const server = newServer();
    const res = await callTool(server, 'integrations_auth', { integration: 'noir-bogus' });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('unknown-integration');
  });
});

describe('noir_clickup_write — HARD confirm gate (dry-run)', () => {
  it('dry-run returns a preview and makes ZERO fetch calls (confirm gate is HARD)', async () => {
    const { fetchMock, history } = makeCassette({
      'PUT https://api.clickup.com/api/v2/task/abc': { status: 200, body: { id: 'abc' } },
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const server = newServer();
    const res = await callTool(server, 'noir_clickup_write', {
      op: 'status',
      taskId: 'abc',
      status: 'in progress',
    });
    expect(res.ok).toBe(true);
    expect(res.mode).toBe('dry-run');
    expect(Array.isArray(res.preview)).toBe(true);
    const preview = (res.preview as Array<Record<string, unknown>>)[0];
    expect(preview.method).toBe('PUT');
    expect(preview.url).toBe('https://api.clickup.com/api/v2/task/abc');
    // SECURITY: the preview shows a REDACTED auth header (never the token).
    expect(preview.auth).toBe('pk_***');
    // HARD gate: NO fetch call happened.
    expect(history.length).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('confirm:false is also a dry-run; only confirm:true reaches the network', async () => {
    const { fetchMock, history } = makeCassette({
      'PUT https://api.clickup.com/api/v2/task/abc': { status: 200, body: { id: 'abc' } },
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const server = newServer();
    const dry = await callTool(server, 'noir_clickup_write', {
      op: 'status',
      taskId: 'abc',
      status: 'done',
      confirm: false,
    });
    expect(dry.mode).toBe('dry-run');
    expect(history.length).toBe(0);
  });

  it('dryRun:true forces a preview even when confirm:true (safe default wins)', async () => {
    const { fetchMock, history } = makeCassette({});
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const server = newServer();
    const res = await callTool(server, 'noir_clickup_write', {
      op: 'status',
      taskId: 'abc',
      status: 'done',
      confirm: true,
      dryRun: true,
    });
    expect(res.mode).toBe('dry-run');
    expect(history.length).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('noir_clickup_write — confirm=true executes', () => {
  it('status op: PUTs with pk_ auth (NO Bearer), audits, returns executed', async () => {
    process.env.CLICKUP_API_TOKEN = 'tk_real';
    const { fetchMock, history } = makeCassette({
      'PUT https://api.clickup.com/api/v2/task/abc': {
        status: 200,
        body: { id: 'abc', status: { status: 'in progress' } },
      },
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const server = newServer();
    const res = await callTool(server, 'noir_clickup_write', {
      op: 'status',
      taskId: 'abc',
      status: 'in progress',
      confirm: true,
    });
    expect(res.ok).toBe(true);
    expect(res.mode).toBe('executed');
    expect(res.audited).toBe(true);
    expect(history.length).toBe(1);
    const call = history[0];
    expect(call.init.method).toBe('PUT');
    // SECURITY: pk_ prefix, NO Bearer.
    expect(call.init.headers?.authorization).toBe('pk_tk_real');
    expect(call.init.headers?.authorization).not.toMatch(/^Bearer /);
    expect(call.init.headers?.['content-type']).toBe('application/json');
    const body = JSON.parse(call.init.body ?? '{}') as Record<string, unknown>;
    expect(body.status).toBe('in progress');
    delete process.env.CLICKUP_API_TOKEN;
  });

  it('writes an integration audit record to .noir/audit/integration-clickup.jsonl', async () => {
    process.env.CLICKUP_API_TOKEN = 'tk_real';
    const { fetchMock } = makeCassette({
      'PUT https://api.clickup.com/api/v2/task/abc': { status: 200, body: { id: 'abc' } },
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const server = newServer();
    await callTool(server, 'noir_clickup_write', {
      op: 'status',
      taskId: 'abc',
      status: 'done',
      confirm: true,
    });
    const auditFile = join(root, '.noir', 'audit', 'integration-clickup.jsonl');
    expect(existsSync(auditFile)).toBe(true);
    const lines = readFileSync(auditFile, 'utf8').trim().split('\n');
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(entry.kind).toBe('integration');
    expect(entry.integration).toBe('noir-clickup');
    expect(entry.op).toBe('status');
    expect(entry.method).toBe('PUT');
    expect(entry.httpStatus).toBe(200);
    expect(entry.success).toBe(true);
    expect(entry.target).toBe('task/abc');
    expect(typeof entry.timestamp).toBe('number');
    // SECURITY: the token NEVER appears in the audit body.
    expect(lines[0]).not.toContain('tk_real');
    delete process.env.CLICKUP_API_TOKEN;
  });

  it('subtask op: POSTs create then PUTs the status follow-up with the returned id', async () => {
    process.env.CLICKUP_API_TOKEN = 'tk_real';
    const cassette = makeCassette({
      'POST https://api.clickup.com/api/v2/list/list42/task': {
        status: 200,
        body: { id: 'sub9', name: 'wire proxy' },
      },
      'PUT https://api.clickup.com/api/v2/task/sub9': { status: 200, body: { id: 'sub9' } },
    });
    globalThis.fetch = cassette.fetchMock as unknown as typeof fetch;
    const server = newServer();
    const res = await callTool(server, 'noir_clickup_write', {
      op: 'subtask',
      parentTaskId: 'abc',
      name: 'wire proxy',
      status: 'open',
      confirm: true,
    });
    expect(res.ok).toBe(true);
    expect(cassette.history.length).toBe(2);
    const [create, status] = cassette.history;
    expect(create.url).toBe('https://api.clickup.com/api/v2/list/list42/task');
    const createBody = JSON.parse(create.init.body ?? '{}') as Record<string, unknown>;
    expect(createBody.parent).toBe('abc');
    expect(createBody.name).toBe('wire proxy');
    expect(status.url).toBe('https://api.clickup.com/api/v2/task/sub9');
    const statusBody = JSON.parse(status.init.body ?? '{}') as Record<string, unknown>;
    expect(statusBody.status).toBe('open');
    delete process.env.CLICKUP_API_TOKEN;
  });

  it('comment op: POSTs the comment with notify_all + optional assignee', async () => {
    process.env.CLICKUP_API_TOKEN = 'tk_real';
    const cassette = makeCassette({
      'POST https://api.clickup.com/api/v2/task/abc/comment': { status: 200, body: { id: 'cm1' } },
    });
    globalThis.fetch = cassette.fetchMock as unknown as typeof fetch;
    const server = newServer();
    const res = await callTool(server, 'noir_clickup_write', {
      op: 'comment',
      taskId: 'abc',
      commentText: 'ship it',
      notifyAll: true,
      assigneeId: 1337,
      confirm: true,
    });
    expect(res.ok).toBe(true);
    const body = JSON.parse(cassette.history[0].init.body ?? '{}') as Record<string, unknown>;
    expect(body.comment_text).toBe('ship it');
    expect(body.notify_all).toBe(true);
    expect(body.assignee).toBe(1337);
    delete process.env.CLICKUP_API_TOKEN;
  });
});

describe('noir_clickup_write — no-token refuse + batch 429 backoff', () => {
  it('refuses with no-token and makes NO fetch when the env var is absent (even on confirm=true)', async () => {
    delete process.env.CLICKUP_API_TOKEN;
    const { fetchMock, history } = makeCassette({});
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const server = newServer();
    const res = await callTool(server, 'noir_clickup_write', {
      op: 'status',
      taskId: 'abc',
      status: 'done',
      confirm: true,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('no-token');
    expect(history.length).toBe(0);
  });

  it('batch 429: backs off on X-RateLimit-Reset then retries once (success)', async () => {
    process.env.CLICKUP_API_TOKEN = 'tk_real';
    // A reset ~50ms in the future so the test is fast but the wait is real.
    const resetEpoch = Math.floor((Date.now() + 50) / 1000);
    let calls = 0;
    const cassette = makeCassette({
      'POST https://api.clickup.com/api/v2/list/list42/task': (init) => {
        calls++;
        // First call → 429 with the reset header; retry → 200.
        if (calls === 1) {
          return {
            status: 429,
            body: { err: 'Rate limited' },
            headers: { 'x-ratelimit-reset': String(resetEpoch) },
          };
        }
        const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
        return { status: 200, body: { id: 't1', name: body.name } };
      },
    });
    globalThis.fetch = cassette.fetchMock as unknown as typeof fetch;
    const server = newServer();
    // Single-task batch so the 429+retry is deterministic (no concurrency race
    // on the shared `calls` counter). The retry logic is per-request regardless.
    const res = await callTool(server, 'noir_clickup_write', {
      op: 'batch',
      tasks: [{ name: 'A' }],
      confirm: true,
    });
    expect(res.ok).toBe(true);
    expect(cassette.history.length).toBe(2); // 1 initial (429) + 1 retry (200)
    // The audit recorded the 429 wait on the one executed row.
    const auditFile = join(root, '.noir', 'audit', 'integration-clickup.jsonl');
    const lines = readFileSync(auditFile, 'utf8').trim().split('\n');
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(entry.success).toBe(true);
    expect(entry.httpStatus).toBe(200);
    expect(entry.rateLimitedWaitMs).not.toBeUndefined();
    delete process.env.CLICKUP_API_TOKEN;
  }, 15_000);
});

describe('noir_clickup_write — prompt-injection defense (allowlist only)', () => {
  it('ignores a caller-supplied url in the payload; URLs come ONLY from the op + binding', async () => {
    const { fetchMock, history } = makeCassette({
      'PUT https://api.clickup.com/api/v2/task/abc': { status: 200, body: { id: 'abc' } },
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const server = newServer();
    // Adversary tries to redirect the proxy to an evil endpoint via a `url` field
    // (both top-level and nested under payload). The builders never read `url`.
    const res = await callTool(server, 'noir_clickup_write', {
      op: 'status',
      taskId: 'abc',
      status: 'done',
      url: 'https://evil.example.com/api/v2/task/abc',
      payload: { url: 'https://evil.example.com' },
    });
    expect(res.ok).toBe(true);
    expect(res.mode).toBe('dry-run');
    expect((res.preview as Array<Record<string, unknown>>)[0].url).toBe(
      'https://api.clickup.com/api/v2/task/abc',
    );
    expect(history.length).toBe(0);
  });

  it('rejects a taskId with path characters (id charset guard)', () => {
    // Direct builder test: an id smuggling a path segment is rejected.
    expect(() =>
      buildRequests('status', { taskId: 'abc/../../admin', status: 'x' }, { listId: 'l1' }),
    ).toThrow(InvalidOp);
  });

  it('rejects an unknown op', () => {
    expect(() => buildRequests('task:delete', {}, { listId: 'l1' })).toThrow(InvalidOp);
  });
});

describe('noir_clickup_write — H2-markdown batch parsing', () => {
  it('parses H2-per-task markdown into normalized tasks', () => {
    const md = `## Wire proxy
body line one
- tag: backend
- tag: security
- assignee: 1337

## Ship it
- status: open
`;
    const tasks = parseH2Tasks(md);
    expect(tasks.length).toBe(2);
    expect(tasks[0]?.name).toBe('Wire proxy');
    expect(tasks[0]?.description).toBe('body line one');
    expect(tasks[0]?.tags).toEqual(['backend', 'security']);
    expect(tasks[0]?.assignees).toEqual([1337]);
    expect(tasks[1]?.name).toBe('Ship it');
    expect(tasks[1]?.status).toBe('open');
  });

  it('batch op renders one POST per parsed task (dry-run preview)', async () => {
    const { fetchMock, history } = makeCassette({});
    globalThis.fetch = fetchMock as unknown as typeof fetch; // never called
    const server = newServer();
    const res = await callTool(server, 'noir_clickup_write', {
      op: 'batch',
      markdown: '## A\n## B\n## C\n',
    });
    expect(res.mode).toBe('dry-run');
    expect((res.preview as unknown[]).length).toBe(3);
    expect(history.length).toBe(0);
    // All three target the SAME allowlisted URL (no per-task URL injection).
    const urls = (res.preview as Array<Record<string, unknown>>).map((p) => p.url);
    for (const u of urls) expect(u).toBe('https://api.clickup.com/api/v2/list/list42/task');
  });
});

describe('noir_clickup_write — security: token never leaks', () => {
  it('the token does not appear in any stderr output or the audit file after an executed write', async () => {
    // Capture stderr to assert the token never leaks there.
    const seized: string[] = [];
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: unknown) => {
      seized.push(typeof c === 'string' ? c : String(c));
      return true;
    }) as typeof process.stderr.write;
    try {
      process.env.CLICKUP_API_TOKEN = 'TK_LEAK_CANARY';
      const cassette = makeCassette({
        'PUT https://api.clickup.com/api/v2/task/abc': { status: 200, body: { id: 'abc' } },
      });
      globalThis.fetch = cassette.fetchMock as unknown as typeof fetch;
      const server = newServer();
      const res = await callTool(server, 'noir_clickup_write', {
        op: 'status',
        taskId: 'abc',
        status: 'done',
        confirm: true,
      });
      expect(res.ok).toBe(true);
      // The tool RESULT may carry it (trusted host) — but stderr + audit must NOT.
      const stderrBlob = seized.join('');
      expect(stderrBlob).not.toContain('TK_LEAK_CANARY');
      const auditFile = join(root, '.noir', 'audit', 'integration-clickup.jsonl');
      const auditBlob = existsSync(auditFile) ? readFileSync(auditFile, 'utf8') : '';
      expect(auditBlob).not.toContain('TK_LEAK_CANARY');
      // The executed-result envelope also must not echo the token (only the
      // outbound header carries it; the result carries status/httpStatus/etc).
      expect(JSON.stringify(res)).not.toContain('TK_LEAK_CANARY');
      delete process.env.CLICKUP_API_TOKEN;
    } finally {
      process.stderr.write = origErr;
    }
  });

  it('NIT(c): a 4xx/5xx ClickUp error body does NOT echo the token into the result envelope / stderr / audit', async () => {
    // Extend the token-canary to the ERROR path: ClickUp returns a 500 with a
    // body that (hypothetically) echoes request metadata. The token must still
    // never appear in stderr, the audit, or the result envelope (only the
    // outbound header carries it; the error body is reflected as JSON DATA but
    // the token was never IN the body — it was in the header).
    const seized: string[] = [];
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: unknown) => {
      seized.push(typeof c === 'string' ? c : String(c));
      return true;
    }) as typeof process.stderr.write;
    try {
      process.env.CLICKUP_API_TOKEN = 'TK_ERR_CANARY';
      const cassette = makeCassette({
        'PUT https://api.clickup.com/api/v2/task/abc': {
          status: 500,
          body: { err: 'internal_server_error', request_id: 'req-xyz' },
        },
      });
      globalThis.fetch = cassette.fetchMock as unknown as typeof fetch;
      const server = newServer();
      const res = await callTool(server, 'noir_clickup_write', {
        op: 'status',
        taskId: 'abc',
        status: 'done',
        confirm: true,
      });
      // The request failed → ok is false, error message present.
      expect(res.ok).toBe(false);
      expect(res.mode).toBe('executed');
      // SECURITY: token does not leak to stderr, audit, or result envelope even
      // on the error path. The error body IS reflected (it's data, not the token)
      // but the token itself only ever traveled in the outbound header.
      expect(seized.join('')).not.toContain('TK_ERR_CANARY');
      expect(JSON.stringify(res)).not.toContain('TK_ERR_CANARY');
      const auditFile = join(root, '.noir', 'audit', 'integration-clickup.jsonl');
      const auditBlob = existsSync(auditFile) ? readFileSync(auditFile, 'utf8') : '';
      expect(auditBlob).not.toContain('TK_ERR_CANARY');
      // The audit row for the failed request records success:false + the httpStatus.
      if (auditBlob.length > 0) {
        const entry = JSON.parse(auditBlob.trim()) as Record<string, unknown>;
        expect(entry.success).toBe(false);
        expect(entry.httpStatus).toBe(500);
      }
      delete process.env.CLICKUP_API_TOKEN;
    } finally {
      process.stderr.write = origErr;
    }
  });
});

describe('noir_clickup_write — I1: batch create-task uses plural `assignees`', () => {
  it('POSTs the body with `assignees` (plural array), NOT `assignee` (silent data loss otherwise)', async () => {
    process.env.CLICKUP_API_TOKEN = 'tk_real';
    const cassette = makeCassette({
      'POST https://api.clickup.com/api/v2/list/list42/task': (init) => {
        const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
        return { status: 200, body: { id: 't1', name: body.name } };
      },
    });
    globalThis.fetch = cassette.fetchMock as unknown as typeof fetch;
    const server = newServer();
    const res = await callTool(server, 'noir_clickup_write', {
      op: 'batch',
      tasks: [{ name: 'With assignees', assignees: [1337, 4242] }],
      confirm: true,
    });
    expect(res.ok).toBe(true);
    expect(cassette.history.length).toBe(1);
    const body = JSON.parse(cassette.history[0].init.body ?? '{}') as Record<string, unknown>;
    // ClickUp `POST /list/{list_id}/task` takes the PLURAL `assignees: number[]`.
    // The singular `assignee` key would be silently ignored → tasks created with
    // NO assignees while audit reports success (I1 silent data loss).
    expect(Array.isArray(body.assignees)).toBe(true);
    expect(body.assignees).toEqual([1337, 4242]);
    expect(body.assignee).toBeUndefined();
    delete process.env.CLICKUP_API_TOKEN;
  });
});

describe('noir_clickup_write — NIT coverage gaps (partial failure / 429 no-reset)', () => {
  it('NIT(a): partial batch failure — per-request results[] reflect mixed success, ok is false, audit appends one line per executed request', async () => {
    process.env.CLICKUP_API_TOKEN = 'tk_real';
    // A 2-task batch where the FIRST POSTs 200 and the SECOND POSTs 400. The
    // handler key is the same URL, so the cassette branches on the request body
    // to deterministically assign success/failure per task (no concurrency race).
    const cassette = makeCassette({
      'POST https://api.clickup.com/api/v2/list/list42/task': (init) => {
        const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
        if (body.name === 'B') {
          return { status: 400, body: { err: 'validation_failed' } };
        }
        return { status: 200, body: { id: 'ok1', name: body.name } };
      },
    });
    globalThis.fetch = cassette.fetchMock as unknown as typeof fetch;
    const server = newServer();
    const res = await callTool(server, 'noir_clickup_write', {
      op: 'batch',
      tasks: [{ name: 'A' }, { name: 'B' }],
      confirm: true,
    });
    // ok is false because at least one request failed.
    expect(res.ok).toBe(false);
    expect(res.mode).toBe('executed');
    const results = res.results as Array<Record<string, unknown>>;
    expect(results.length).toBe(2);
    // Per-request success/failure is reflected (one true, one false).
    const successes = results.map((r) => r.success).sort();
    expect(successes).toEqual([false, true]);
    // The audit appended ONE line per executed request (2 total), with MIXED
    // success values mirroring results[].
    const auditFile = join(root, '.noir', 'audit', 'integration-clickup.jsonl');
    const lines = readFileSync(auditFile, 'utf8').trim().split('\n');
    expect(lines.length).toBe(2);
    const auditSuccesses = lines
      .map((l) => (JSON.parse(l) as Record<string, unknown>).success)
      .sort();
    expect(auditSuccesses).toEqual([false, true]);
    delete process.env.CLICKUP_API_TOKEN;
  });

  it('NIT(b): 429 with NO X-RateLimit-Reset header falls back to the default wait, retries once, succeeds', async () => {
    process.env.CLICKUP_API_TOKEN = 'tk_real';
    let calls = 0;
    const cassette = makeCassette({
      'POST https://api.clickup.com/api/v2/list/list42/task': (init) => {
        calls++;
        // First call → 429 with NO reset header (a misbehaving gateway); the
        // proxy falls back to the default wait. Retry → 200.
        if (calls === 1) {
          return { status: 429, body: { err: 'Rate limited' } };
        }
        const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
        return { status: 200, body: { id: 't1', name: body.name } };
      },
    });
    globalThis.fetch = cassette.fetchMock as unknown as typeof fetch;
    const server = newServer();
    // Single-task batch so the retry count is deterministic.
    const res = await callTool(server, 'noir_clickup_write', {
      op: 'batch',
      tasks: [{ name: 'A' }],
      confirm: true,
    });
    expect(res.ok).toBe(true);
    expect(cassette.history.length).toBe(2); // 1 initial (429) + 1 retry (200)
    // The audit recorded the 429 wait on the one executed row even though the
    // reset header was absent (the default wait fired).
    const auditFile = join(root, '.noir', 'audit', 'integration-clickup.jsonl');
    const lines = readFileSync(auditFile, 'utf8').trim().split('\n');
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(entry.success).toBe(true);
    expect(entry.httpStatus).toBe(200);
    expect(entry.rateLimitedWaitMs).not.toBeUndefined();
    delete process.env.CLICKUP_API_TOKEN;
  }, 15_000);
});
