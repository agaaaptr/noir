# How to manage the host lifecycle hook

When you run `noir init`, Noir writes a small lifecycle hook into your agent
CLI's config so the host can call back into Noir while a session runs. That hook
injects the project brief at session start and enforces the deny-list and Stop
gate you configure under `enforcement` in `.noir/config.yml`. This page is about
where that hook lives, when it stops being there, and how to put it back.

> **`noir hook` (singular) is not a command for you.** It is the hidden, internal
> dispatcher your host invokes with a JSON event on stdin — it is excluded from
> `noir --help` and the command palette. The command you can run is the plural
> one: `noir hooks sync` below. A one-letter mix-up between them is caught with a
> "did you mean" hint rather than silently running the dispatcher.

## Where the hook lives

| Host | File | Managed how |
|---|---|---|
| claude | `.claude/settings.local.json` | Written once, then left to you |
| gemini | `.gemini/settings.json` | Written once, then left to you |
| cursor | `.cursor/hooks.json` | Rewritten on every `noir sync` |

For claude and gemini the file is **user-owned**: it also holds your
`permissions`, `env`, and other host settings, so Noir never rewrites it. It
merges the hook in once at `noir init` / `noir create` and then stays out of the
file for good — `noir init --upgrade` and `noir sync` deliberately do not touch
it, so a hook you removed on purpose is not quietly put back.

## When the hook is missing

The hook is absent when any of these happened:

- You removed it from the host config yourself.
- The project was initialized before the hook shipped, and a later upgrade did
  not recreate it (it will not create a missing claude/gemini hook file on its
  own).

In both cases nothing restores it automatically. Run:

```bash
noir hooks sync
```

That re-adds the hook entry for your project's configured host, leaving every
other setting in the file untouched. If the hook is already present it does
nothing and says so. The command is safe to run repeatedly and never prompts, so
it is fine in CI or a script.

## Refreshing a stale hook

If the hook is present but points at the wrong command — for example you moved
from an npm install to the native installer, which changes the resolved `noir`
path — the default sync leaves the existing entry alone. Force a rewrite of just
Noir's own entries (your other hooks are kept):

```bash
noir hooks sync --force
```

## Scripting

`noir hooks sync --json` prints a `{ok, data}` envelope on stdout describing the
host and each file it touched (`written: true` when the file changed). The
human-readable lines go to stderr, matching every other `noir` command.

A host with no hook surface (the universal `agents-md`, or `opencode`) has
nothing to sync; the command reports that and exits 0.

See [Configuration](../reference/config.md) for the `enforcement` settings the hook
acts on.
