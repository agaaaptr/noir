# Using the ClickUp integration (noir-clickup)

Noir ships one opt-in integration: **noir-clickup** — a gated write proxy for
ClickUp that reads task state and writes status/subtask/comments back. It is
shipped as a skill (agent-visible) plus daemon MCP tools
(`integrations_auth`, `noir_clickup_write`).

This guide covers the one thing users get wrong most often: **token
placement** (and the daemon-restart rule that follows).

## 1. Get a token

1. ClickUp → **Settings → Apps → "Generate API Token"**.
2. Copy the `pk_...` value. Tokens never expire and grant full account access —
   treat them like passwords. Never commit them.

## 2. Place the token (pick one, in order)

The token is read by the **daemon at call time**. The daemon's env is a
**snapshot taken when it spawned** — so wherever you put it, **restart the
daemon afterward**: `noir daemon restart`.

1. **Recommended — `.noir/.env`.** Project-scoped, gitignored, created at
   `0600` by `noir init`, and it works no matter how the process was launched
   (terminal, GUI MCP client, launchd, CI). Under Noir's precedence this file
   **wins for every key it defines** — a machine-global export cannot shadow
   it:
   ```bash
   # .noir/.env  (gitignored — never commit)
   CLICKUP_API_TOKEN=pk_your_token_here
   ```
2. **Real environment — a CI secret store, or an export in `~/.zshenv`.** This
   is the fallback level: it applies only to keys `.noir/.env` leaves unset, so
   any key the file defines wins over the ambient value. `~/.zshenv` works for
   non-interactive shells; a CI job exports the token from its secret store.
   There is no `VAR=value noir …` per-command prefix override — a prefix arrives
   in `process.env` exactly like the inherited environment, so it is this same
   level. For a real per-invocation value, use a `run.profiles.<n>.env` entry
   (see [host-profiles.md](host-profiles.md)).
3. **Machine-global host file — `~/.claude/settings.json` `env` block.** A
   fallback for a host-launched daemon when you would rather not keep the token
   in the repository; it cannot shadow `.noir/.env`:
   ```json
   { "env": { "CLICKUP_API_TOKEN": "pk_your_token_here" } }
   ```
   (Note: `~/.zshrc` is the least reliable of all — interactive shells only, so
   `.zshrc` exports are invisible to detached daemons.)

`noir env` shows which source actually won for `CLICKUP_API_TOKEN`.

If the token is missing, `integrations_auth` returns `no-token` and the skill
stops with this setup guidance — it never guesses or invents a token.

Placement doctrine — what belongs in `.noir/.env`, the exact precedence chain,
and how to confirm which value is in effect (`noir env`):
[configure-env.md](configure-env.md).

## 3. Workspace binding (optional)

Team/list/space ids are **config.yml keys, not env vars**:

```yaml
# .noir/config.yml
integrations:
  clickup:
    teamId: "ABC123"     # optional — only for custom task IDs (#ABC-123)
    listId: "..."        # needed for create/batch flows
    spaceId: "..."       # optional
```

You can also rename the token env var (`auth.tokenEnv`) or downgrade the
integration to read-only (`runtime: none`) for a restricted workspace:

```yaml
integrations:
  clickup:
    runtime: none        # unregisters the write tool — read-only runs only
    auth:
      tokenEnv: MY_CUSTOM_TOKEN_VAR
```

## 4. Verify + audit

- Restart the daemon, then call `integrations_auth({ envVar: 'CLICKUP_API_TOKEN' })`
  (or run any ClickUp skill flow) — `{ok:true}` means the token resolved.
  `envVar` must be one of the **declared** `tokenEnv` names (allowlisted by the
  daemon to prevent secret exfiltration) — passing an undeclared name returns
  `{ok:false, reason:'no-token'}`.
- Every gated write is logged to `.noir/audit/integration-clickup.jsonl`.

## Reference

- Env vars: [Environment Variables](../reference/environment.md)
- Config keys: [Configuration Reference](../reference/config.md)
- The full skill playbook ships to the host as `noir-clickup/SKILL.md`.
