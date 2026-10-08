# Anti-slop + humanizer + design-taste adoption

Status: proposed · 2026-10-08

## Purpose

Harden Noir's always-on rules and skill pack by natively reimplementing the ideas of
trusted repositories — the ponytail laziness ladder, anti-slop / humanizer prose
standards, and design-taste references — so that a Noir-managed host agent produces
less machine-generated output and carries real design taste. No third-party text is
shipped (Noir adopts ideas, not copies; ADR-0002 forbids a plugin/marketplace surface).

## Locked decisions

- Adopt **natively**: reimplement ideas as original Noir rules and skills; no vendored
  upstream text. Dataviz is proprietary (embedded in the Claude Code binary) and is
  therefore ideas-only; ui-ux-pro-max and refero are MIT and their *structure* (taxonomy,
  schemas, rule ladders) is fair to mirror, their prose is not copied.
- Enforcement channel: **always-on injected rules**, on **all five hosts**.
- Posture: **split** — fail tier for decorative/narration/emoji, warn tier for
  vocabulary and prose.
- Rename: **hard rename** `noir-code-hygiene` to `noir-codebase-audit`; keep the
  `noir-<kebab>` noun canon and the `dir == frontmatter.name` compiler invariant.
- New skills: **consolidated curated**, not 1:1 ponytail parity.
- Vocabulary detection: **per-line regex and per-file frequency/cluster**.
- Humanizer / anti-slop applies to **both** Noir's own repo (hygiene gate) and host
  agent output (injected rules).

## Architecture

Three enforcement tiers, one idea per tier:

1. **Static always-on rules (all five hosts, within the 150-line budget).** A short
   anti-slop + laziness-ladder block appended to the `RULES.md` seed. Every host already
   imports `.noir/rules/RULES.md` (CLAUDE.md `@import`, AGENTS.md `@`, GEMINI.md `@file`),
   so this reaches all five hosts for free and respects `rules.enabled`. Budget is a hard
   constraint: this block must stay small (target well under the 150-line ceiling).

2. **Hook-injected rules (claude; the full ladder and lexical list).** The full anti-slop /
   humanizer / laziness content does not fit the static budget. Claude is the only host
   with a hook bootstrap today, so extend the existing `.noir/hooks/noir-session-start.mjs`
   runner (regenerate mode, re-emitted on sync) to also emit the full ruleset as
   `hookSpecificOutput.additionalContext`, mirroring ponytail's SessionStart + SubagentStart
   pattern. UserPromptSubmit is out of scope — Noir has no per-prompt mode-tracking concept;
   the ruleset injected at SessionStart rides the whole session. Because the runner is
   regenerate-mode, existing installs pick up the runner itself on the next `noir sync`; the
   SubagentStart settings entry is write-once, so an existing install gains it on re-init
   (`init --force`), not on sync.

3. **On-demand skills and references (all hosts).** The large design-taste inventory and the
   playbooks live in skills and their `references/`, loaded when building UI or reviewing
   code, never in every session.

### Per-host injection map

| Host | Static rules | Hook (always-on, full ruleset) | Notes |
|------|--------------|-------------------------------|-------|
| claude | CLAUDE.md RULES block | extend `noir-session-start.mjs` (SessionStart + SubagentStart) | only host with a hook bootstrap |
| agents-md | AGENTS.md `@.noir/rules/RULES.md` | none (no native hook concept) | static only |
| gemini | GEMINI.md RULES block | none today (native `hooks/hooks.json` exists, unused by Noir) | static only |
| cursor | AGENTS.md `@` import | none today (native `hooks.json` sessionStart/beforeSubmitPrompt exists) | static only |
| opencode | AGENTS.md `@` import | none today (native `system.transform` plugin) | static only |

Phase 1 ships tier 1 (all hosts) + tier 2 (claude). Native hook emission for
cursor/opencode/gemini is a follow-up behind the same `rules.enabled` switch; it is
out of scope here because each host's hook mechanism is a separate adapter contract.

## Rule families

New rules are added to `packages/skills/src/hygiene.ts` (or a module it imports) and
flow through the existing consumers: `noir skills lint`, `noir doctor`, and
`pnpm hygiene:gate`. Fail tier blocks CI; warn tier reports.

1. **Lexical anti-slop (warn, markdown).** A curated kill-on-sight list (~20 words:
   delve, utilize, leverage-as-verb, facilitate, elucidate, embark, endeavor, encompass,
   multifaceted, tapestry, testament, paradigm, synergy, holistic, catalyze, juxtapose,
   realm, landscape, myriad, plethora), a suspicious-in-clusters list (~25 words:
   robust, comprehensive, seamless, cutting-edge, innovative, streamline, empower, foster,
   enhance, elevate, optimize, scalable, pivotal, intricate, profound, resonate,
   underscore, harness, navigate, cultivate, bolster, galvanize, cornerstone, game-changer),
   and filler phrases / slop trigrams (it is important to note that, in the realm of,
   a testament to, serves as a, in order to). Small curated lists win over a large scraped
   lexicon (empirical precision ~4% for 77-rule sets vs near-zero noise for ~35 curated
   tokens).

2. **Humanizer tells (warn, markdown).** Em-dash density, hedging openers, and the
   not-X-but-Y contrast construction. Thresholds are per-file frequency, not single-token.

3. **Over-engineering + debt marker (code).** A `noir-debt:` comment marker naming a
   deliberate simplification's ceiling and upgrade path (the Noir-native equivalent of
   ponytail's token; the literal `ponytail:` token is not imported). Warn when a
   `noir-debt:` comment lacks a ceiling or an upgrade path. Existing `bare-todo` and the
   decorative/narration rules remain.

### Frequency engine

`checkHygiene` is per-line and existence-only. Add a per-file pass for the lexical and
humanizer families: strip fenced code before matching prose, count cluster hits per
paragraph, and emit warn findings when a paragraph crosses the threshold (three or more
tier-2 words). A technical-term allowlist (harness, unlock, elevated, journey) prevents
false positives. This is the "both regex and frequency" requirement.

## Skill changes

### Rename

- `noir-code-hygiene` → `noir-codebase-audit`. Body becomes the merged playbook:
  over-engineering audit (ponytail-audit), deliberate-debt harvest (ponytail-debt),
  anti-slop and humanizer de-sloping. Update every reference: `router.md.tmpl`,
  `rules-seed.md.tmpl`, the skills catalog map (`packages/cli/src/commands/skills.ts`),
  the evals dir `packages/skills/evals/noir-code-hygiene/`, the generated
  `docs/reference/skills.md` (regenerated), and the tests that assert the name.

### New skills

- `noir-lazy` — the laziness ladder and YAGNI stance as an on-demand playbook
  (triggers: "be lazy", "simplest solution", "do less", "yagni").
- `noir-debt` — harvest `noir-debt:` markers into a debt ledger (stdout or `.noir/`
  artifact), mirroring ponytail-debt.
- `noir-over-engineering-review` — diff-scoped complexity review (ponytail-review).
- `noir-design` — design direction: commit to one bold aesthetic, anti-template cliché
  list, precedence ladder (adopting the frontend-design and frontend-stack ideas).
- `noir-design-reference` — the style inventory below, as `references/design.md`.
- `noir-dataviz` — chart form/color/marks rules (dataviz ideas re-expressed as original
  rules; no copied text).

`noir-frontend` is folded into `noir-design` (its `references/ui-patterns.md` is the
seed of the design reference). Boundary check: `noir-codebase-audit` and
`noir-over-engineering-review` must stay mutually exclusive with `noir-exploring`,
`noir-doctor`, and `noir-verifying` (writing-skills rule: no near-duplicates).

### Rework

All 27 builtin bodies are re-audited against the new rules and the humanizer standard,
with descriptions tightened to a WHEN cue. This is a content pass, not a rename pass.

## Design reference inventory (`references/design.md`)

Original content mirroring the structure (not the text) of the trusted sources:

- **Style taxonomy** — neobrutalism, glassmorphism, neumorphism, claymorphism,
  skeuomorphism, minimalism, brutalism, bento grid, editorial, luxury, and the
  long-tail from the ui-ux-pro-max styles catalog, each with: era, keywords, cost,
  accessibility floor, and deprecated→replacement redirect.
- **Palette schema** — a 16-token semantic set (primary/on-primary/secondary/on-secondary/
  accent/on-accent/background/foreground/card/card-foreground/muted/muted-foreground/
  border/destructive/on-destructive/ring), shadcn/Tailwind-shaped.
- **UX rule ladder** — the 10-category priority order (accessibility, touch, performance,
  style, layout, typography, animation, forms, navigation, charts) with concrete
  thresholds (4.5:1 contrast, 44×44 touch, 8px spacing, 16px body, reduced-motion).
- **Font pairing and motion** guidance (headings/body pairing, GSAP-free motion tiers).
- **Dataviz** — categorical/ordinal/sequential/diverging color jobs, OKLCH light/dark
  ranges, CVD delta-E floor, mark grammar.

Big binary assets (54 fonts, 1512 icons, Google Fonts table) are **not** vendored: Noir is
local-first with a single-writer SQLite store and a zero-key install. The reference names
them as pointers when needed. The stack-specific CSV rows (version-pinned, with a 90-day
freshness SLA) are adopted as a *pattern*, not imported as rows.

## Constraints respected

- Rules stay within the `RULES.md` 150-line budget and `lengthBudgetKb`.
- `rules.enabled === false` disables the always-on layer everywhere.
- Existing installs heal via the regenerate-mode runner; the write-once settings entry is
  never rewritten.
- Dataviz and the frontend-design mirror carry licensing cautions (proprietary / missing
  top-level LICENSE), so they are ideas-only.
- Skills with concrete assertable behavior (the meta skills) ship an eval; every other
  skill ships a regression test (presence + description, via builtin-hygiene).

## Non-goals

- No vendored binary assets, no paid generation scripts, no new plugin/marketplace surface.
- No native hook emission for cursor/opencode/gemini in this milestone.
- No empirical 1057-word lexicon as an always-on list (kept as an optional reference).

## Decomposition (slices)

1. `rules-engine` — lexical + humanizer + debt-marker rules, frequency pass, allowlist,
   regression tests.
2. `always-on-injection` — RULES.md seed block (all hosts) + claude hook extension
   (SessionStart + SubagentStart), respecting the budget and rules.enabled.
3. `skill-rename-rework` — rename `noir-codebase-audit`, rework all 27 bodies, update
   router/seed/docs/evals/tests.
4. `new-skills` — noir-lazy, noir-debt, noir-over-engineering-review.
5. `design-skills` — noir-design, noir-design-reference (`references/design.md`),
   noir-dataviz; fold noir-frontend.
6. `gate-and-evals` — hygiene:gate wiring, evals for new/renamed skills, docs sync.

## Risks

- Warn-tier vocabulary rules false-positive on legitimate technical prose; the allowlist
  and cluster threshold mitigate this, but the list needs tuning against real output.
- The 150-line static budget constrains how much ships always-on for non-claude hosts.
- Renaming a builtin touches generated docs, the router/seed templates, and three tests;
  a missed reference breaks `noir skills lint` or the docs parity gate.
