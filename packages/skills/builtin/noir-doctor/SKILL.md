---
name: noir-doctor
description: Use when diagnosing environment or project health — dependencies, config, runtime, toolchain, and Noir store integrity. Do NOT use for routine status checks — use noir-sync or noir-checkpoint.
metadata:
  category: meta
  version: 1.0.0
license: MIT
compatibility: claude · agents-md · gemini · cursor · opencode
---

# noir-doctor


## When to use
- When the user triggers this skill.

Check what's wrong. Run `noir doctor` and read every row — it prints one row per named check (install, runtime, config, store, daemon, embedder, provider, noir-env, scaffold version, rules budget, host artifacts, nested `.noir`, publish) with a pass/warn/fail status. Advisory, not mandatory — even a red check doesn't block.

## Procedure

1. **Run `noir doctor`.** In-process — no daemon needed. Read the full output on stderr.
2. **Surface actionable issues.** A failed check should tell you what to fix. The install row checks Node version + managed runtime (if installed via native installer).
3. **Fix one at a time.** Don't batch fixes — each fix deserves its own verification that the underlying issue resolved.
4. **Re-run `noir doctor` to confirm green.**

## When done → next skill

→ The relevant skill for whatever was broken. Or continue working with a green doctor.

## Notes
- This skill is a playbook — the host decides which tools to use. On Claude Code, prefer `AskUserQuestion` for choices; on other hosts, ask in text.

### Configuration rows (`.noir/.env`)

`.noir/.env` is the recommended home for project-scoped configuration; these rows report its state and where each value came from (names only — never a value):

| Row | What it means | Remedy |
|---|---|---|
| `noir-env` | The file's permissions — `warn` when it is group/world readable. | `chmod 600 .noir/.env` |
| `noir-env` | The file is **tracked by git** — Noir refuses to load it, so NONE of its keys are in effect. | Add `.noir/.env` to `.gitignore` (the managed block already does) and `git rm --cached .noir/.env` |
| `noir-env:<KEY>` | One row per key the file defines — `from .noir/.env`. | — |
| `provider` | Per configured model provider; `key present (from .noir/.env)` names the winning source for that provider's `apiKeyEnv`. | A `missing <NAME>` row is a placement bug — put that variable (the exact name `apiKeyEnv` refers to) in `.noir/.env`, since the file wins for the keys it defines |

Placement doctrine and the full precedence chain: `docs/how-to/configure-env.md`. `noir env` is the same view per key (`noir env --json` for the structured form).
