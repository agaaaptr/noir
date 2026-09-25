---
name: noir-code-hygiene
description: Use when writing or reviewing comments, docstrings, summaries, or documents — keep every line carrying something a reader can act on. Use when the user says "clean this up", "this reads like machine output", or asks for a comment sweep. Do NOT use for layout (indentation, quoting, line length); this is about what the text says.
metadata:
  category: meta
  version: 1.0.0
license: MIT
compatibility: claude · agents-md · gemini · cursor · opencode
references:
  - examples.md
---

# noir-code-hygiene

Text that reads as machine-generated fails in a small number of ways, and every
one of them is a sentence a reader cannot act on. The ten defects below are
those ways, each as a Tell (what it looks like), a Why (what it costs a reader)
and a Fix (what to write instead). Four of them — restating, stale text, jargon,
unstated assumptions — are judgements a person makes; the rest are mechanical
enough that the quality gate checks them itself.

## When to use

- Writing or reviewing a comment, docstring, summary, or document that a reader will meet without the context its author had.
- Sweeping a file, a diff, or a report for text that reads as generated.
- The user says "clean this up", "this reads like machine output", or asks for a comment sweep.
- Reviewing your own output before handing it back: comments and summaries are where these defects concentrate.
- **Do NOT use:** for layout (indentation, quoting, line length), or as a substitute for a formatter or a type checker. This is about what the text says, not how it is drawn.

## Procedure

1. **Read the text as somebody who did not write it.** For each sentence, ask what a reader learns that the code, the diff, or the line above does not already say. A sentence that teaches nothing is the one to delete.
2. **Delete before rewriting.** Most defects end at deletion: a divider, a restated line, an empty label, a fact that is no longer true. Rewriting a comment that should not exist only makes the noise longer.
3. **Keep what the code cannot say.** The reason a value is what it is, the invariant a caller depends on, the condition that would break the order, the precondition. When only a restatement would be left, the comment is finished.
4. **Name things in the reader's terms.** Replace a codename, or a shorthand that resolves only against a planning document, with the mechanism it stood for. State the path, the command, or the precondition instead of assuming the reader knows it.
5. **Run the gate.** `noir skills lint` over a skill body, `noir doctor` over a repository. Fix every fail-tier finding; read a warn-tier one as a question about the line rather than a rule to satisfy.

## Tell / Why / Fix

### Decorative separators and banners

**Tell:** a line of punctuation used as a divider — a run of `=`, `-`, `*`, `_`,
or `~` characters, with or without a label inside it — or a heading whose only
job is to sit above another heading.

**Why:** the divider marks a section for whoever wrote the file, not for a reader. It carries nothing, and it is the fastest way to make a file read as machine-written.

**Fix:** delete it. If the label named something a reader needs, make it a heading in a document, or name it in the declaration the divider sat above.

### Restating the obvious

**Tell:** a comment that says what the line below does in the words the code already uses — a getter described as getting, a counter described as counting, a paragraph that repeats the sentence before it.

**Why:** it doubles the reading cost, and it is the first thing to go stale: the code changes and the echo of it does not. A reader who learns the comments are redundant skips the one that matters.

**Fix:** delete it. Keep a comment only when it carries something the code does not — why this value, what the caller relies on, which invariant holds.

### Workflow narration

**Tell:** a comment that walks a reader through the file in the order it runs, with ordinals as markers, or a summary that lists a function's statements in sequence.

**Why:** the code already gives the order, and it gives the true one. The narration goes stale the moment the order changes, and a reader takes it as a promise about behavior.

**Fix:** drop the markers. Keep only what the code cannot show: why this order, which invariant the order holds, or what breaks when it changes.

### Empty labels

**Tell:** a heading, a comment, or a field that names a category and stops — a lone label above nothing, a section with no content under it, a marker recorded with no owner and no reason.

**Why:** a label promises information. A reader pays to open it, finds nothing, and learns to skip the next one.

**Fix:** delete it, or say the thing: what is set up and by whom, what the note adds, what would retire the marker.

### Stale comments

**Tell:** a comment that described the code before an edit — a parameter that no longer exists, a step that no longer happens, a docstring for behavior that has changed, a stated limit the constant beside it contradicts.

**Why:** worse than no comment at all. A wrong comment is trusted, and the reader who acts on it investigates the wrong thing.

**Fix:** when the code changes, read the comment above it in the same edit. Delete what no longer holds, rewrite what changed meaning. A comment is part of the change, not a leftover from it.

### Decorative icons and emoji

**Tell:** an emoji or pictograph used as a bullet, as a heading prefix, as a status flourish in a comment, or as a symbol standing in for a word — a check mark for done, a warning sign for careful.

**Why:** the glyph takes attention and returns none of it, it renders differently or not at all across terminals and fonts, and it announces the text as generated. In output a screen reader reads aloud, it is noise in the middle of a sentence.

**Fix:** remove it and let the words carry the meaning. A glyph that is part of a program's own output — a status badge, a CLI label — belongs inside the string that prints it, not in the text around the code.

### Unexpected characters from another script

**Tell:** a character from a writing system this project does not write in — Han,
Kana, Hangul, Cyrillic, Greek, Arabic, Hebrew, Thai, Devanagari — or a fullwidth
form, a zero-width space, a byte-order mark, a bidirectional override, or the
replacement character a bad decode leaves behind. It turns up inside a word or a
string, where no author would have typed it.

**Why:** a model can leak a token from another script into generated text, and
bytes that were decoded wrongly arrive as an invisible character or a
replacement mark. Either way the reader is shown something nobody meant to
write, and inside a string it can change what the code does.

**Fix:** rewrite the text in the project's language and delete the invisible
character; a deliberate fixture — a test that measures how a wide glyph is laid
out, say — states its own exemption with the marker instead of the text keeping
the character. `noir doctor`'s hygiene check reports these as failures.

### Verbosity

**Tell:** three sentences where one does; a preamble that restates the request; a summary of a summary; a dozen comment lines above a four-line function; a document that explains the same decision twice.

**Why:** every extra sentence is a cost the reader pays before reaching the one that matters. Length also hides the defects above, because prose that repeats itself is prose nobody re-reads closely.

**Fix:** cut to what the reader cannot get elsewhere, and move reference detail into the document that owns it, linked, instead of inlined.

### Internal jargon

**Tell:** a label that resolves only against a planning document — a task code, a milestone codename, a bare section citation, an abbreviation defined once in a note nobody keeps.

**Why:** no reader of this file can resolve it, and it ties the source to a document that will be deleted. The code outlives the plan, so the shorthand ends up naming nothing at all.

**Fix:** name the mechanism, the behavior, or the condition in self-contained words. When a code is the only handle that exists, give the fact it stood for beside it.

### Unstated assumptions

**Tell:** an instruction or a comment that works only if the reader already knows something the text does not say — the path, the file that has to exist first, the command, the environment, or the choice made silently between two options.

**Why:** the reader either guesses, and a wrong guess surfaces as a bug somewhere else, or stops to ask. Both cost more than the sentence that would have prevented it.

**Fix:** state it — the path, the command, the precondition, the reason for the choice. When the answer changes what the text should say, ask rather than pick one silently and leave the reader to find out.

## Worked example

The defects a pattern can catch are the easy half. This pair is the other half:
neither snippet trips a rule, and the first one still wastes a reader's time.

Before:

```ts
/** Fetches the user. */
// NOTE: 30 second timeout because the gateway is slow.
// Added during the checkout rewrite — see the planning note for context.
// Gets the user by id from the client.
export async function fetchUser(id: string): Promise<User> {
  return client.get(`/users/${id}`, { timeoutMs: 5000 });
}
```

After:

```ts
/**
 * Loads a user. A healthy gateway answers in well under a second, so five
 * seconds is the point past which the request is a hang rather than a slow
 * read — the caller hears about it instead of waiting on nothing.
 */
export async function fetchUser(id: string): Promise<User> {
  return client.get(`/users/${id}`, { timeoutMs: 5000 });
}
```

The behavior is identical. What changed: the name restated as a sentence is
gone, the timeout figure that contradicted the constant beside it is gone, and
the two facts a reader cannot get from the expression — why the timeout exists
and why it is this value — are all that is left. The codename went with them.

## Enforcement

Two commands run the same rules, so this guidance and the gate agree:

- `noir skills lint` validates each shipped skill body. A fail-tier pattern is an error and exits non-zero; a warn-tier pattern is a warning and does not.
- `noir doctor` scans the repository's own text — the root documents, `docs/` outside the planning corpus, `.claude/skills`, each package's `src` and `test` trees, and `scripts/` — reporting fail-tier findings in a failing row and warn-tier findings in a warning row. It exits non-zero whenever a fail-tier finding is present, so a repository's continuous integration can call it as its gate.

The rules themselves are one table in the skills package, and each entry carries its tier, the reason the shape is noise, and the fix. Read the table when a line's status is unclear rather than working from memory.

**The exemption marker.** Some files have to name what the rules forbid: the rule table, its fixtures, and the examples file this skill ships. Such a file states its own exemption with the marker the rules honour — the text `noir-hygiene: exempt` alone on a line above its first finding, written as a source comment in code and as an HTML comment in a document. The marker is a statement about the whole file, not a way to silence one line, so it belongs only where the prohibited shape is the subject. A file that carries it to keep a defect is worse off than the defect: the gate stops reporting it, and the reason it was written is now invisible.

## Reference

[examples.md](references/examples.md) carries a worked before/after pair for every defect above, the mechanical shapes the gate catches included — a divider, numbered narration, a decorative emoji, a marker nobody can act on.

## Verification

- [ ] Every sentence kept carries something the code, the diff, or the line above does not.
- [ ] No divider, no restatement, no ordinal marker, no empty label survives the pass.
- [ ] Every fact stated beside the code is true of the code as it stands now.
- [ ] Every codename or shorthand is replaced by the mechanism it stood for.
- [ ] The path, the command, and the precondition are stated rather than assumed.
- [ ] `noir skills lint` (skill body) or `noir doctor` (repository) reports no fail-tier finding.

## Notes

- The tiers differ in what to do with a finding, not in whether the shape is real. A fail-tier pattern is never the right thing to write, so it is removed. A warn-tier one is a mechanical threshold too, but the shape is sometimes the right choice — a marker is sometimes the right note, a block sometimes the right length — so the tier asks a reviewer to look at the line rather than forbidding it.
- Deleting is the most common fix. A file gets clearer by getting shorter, and a shorter file has fewer places to be wrong.
- The standard covers what an agent reports back, not only what it writes into a file: a summary that narrates its own steps, or that repeats the request before answering it, is the same defect in a different medium.

## When done → next skill

→ `noir-verifying` to confirm the sweep left nothing broken. Or `noir-writing-skills` when the text being cleaned is a skill body.
