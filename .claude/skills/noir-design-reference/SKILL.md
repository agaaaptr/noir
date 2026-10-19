---
name: noir-design-reference
description: Use when the user asks "what style should I use", names a style like "neobrutalism" or "glassmorphism", says "pick a style", or needs a design reference — consult references/design.md and return the matching style's tokens, cost, and accessibility floor. Do NOT use for generating assets or for general layout questions.
metadata:
  category: domain
  version: 1.0.0
license: MIT
compatibility: claude · agents-md · gemini · cursor · opencode
references:
  - design.md
---

# noir-design-reference

The style inventory. When a design question needs a named style, its tokens, its build cost, its accessibility floor, a semantic palette, a rule ladder, a font pairing, or a motion budget, this skill reads references/design.md and returns the relevant part. It answers the "which style, and what does it cost" question; noir-design answers the "what should this screen commit to" question.

## When to use

- The user asks "what style should I use", "pick a style", or "design reference".
- The user names a style (neobrutalism, glassmorphism, and the rest) and wants its tokens.
- A screen needs a semantic color palette or a font pairing and none exists yet.
- Do NOT use for generating images, icons, or any binary asset. This skill names large assets as pointers, never as files.
- Do NOT use for general layout questions or for deciding a direction. noir-design owns those.

## Procedure

1. Read the question for what is being asked: a named style, an open choice between styles, a palette, a font pairing, or a motion budget.
2. Open references/design.md and find the section that matches.
3. For a named style, return that style's era, tokens, cost, accessibility floor, and use-and-avoid guidance.
4. For an open choice, shortlist two or three styles by build cost and context, and present each in one line so the user can commit.
5. For tokens, pull the 16-token semantic palette and fill it with the chosen style's colors, light and dark.
6. For the rest, pull the relevant rung from the UX rule ladder, the font-pairing guidance, or the motion tiers. For example, asking for neobrutalism returns its era, tokens, cost, floor, and fit.

## Verification

- [ ] The returned guidance came from references/design.md, not from memory.
- [ ] A named style came back with cost and accessibility floor, not only its look.
- [ ] An open choice names the trade-off (cost, floor, fit), not just a list of names.
- [ ] No asset is generated; anything large is named as a pointer.

## Notes

- This file is a reference: consult it, quote from it, and hand the decision back to noir-design.

## When done → next skill

→ noir-design to apply the chosen direction. → noir-verifying to check the finished screen against the spec.
