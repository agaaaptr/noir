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

1. **Most reliable — `~/.claude/settings.json` `env` block.** Inherited by the
   daemon no matter how Claude Code was launched (terminal, desktop, CI):
   ```json
   { "env": { "CLICKUP_API_TOKEN": "pk_your_token_here" } }
   ```
2. **Project-local — `.noir/.env`.** Works even when the process was not
   launched from a shell that exported the token (GUI MCP clients, launchd).
   `.noir/.env` is gitignored; real env vars always win over it:
   ```bash
   # .noir/.env  (gitignored — never commit)
   CLICKUP_API_TOKEN=pk_your_token_here
   ```
3. **Shell export — `~/.zshenv` (NOT `.zshrc`).** Non-interactive shells source
   `.zshenv` but skip `.zshrc`, so `.zshrc` exports are invisible to the Bash
   tool and detached daemons.

If the token is missing, `integrations_auth` returns `no-token` and the skill
stops with this setup guidance — it never guesses or invents a token.

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
- Every gated write is logged to `.noir/audit/integration-clickup.jsonl`.

## Reference

- Env vars: [Environment Variables](../reference/environment.md)
- Config keys: [Configuration Reference](../reference/config.md)
- The full skill playbook ships to the host as `noir-clickup/SKILL.md`.
