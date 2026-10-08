---
name: noir-debt
description: Use when the user asks "what did we defer", "list the shortcuts", "debt ledger", or mentions noir-debt. Grep the repo for the noir-debt markers, then group them by file into a ledger that names each marker's ceiling and upgrade trigger. Do NOT use to fix the debt (the owning task does that), or as a whole-repo audit (noir-codebase-audit owns that pass).
metadata:
  category: meta
  version: 1.0.0
license: MIT
compatibility: claude · agents-md · gemini · cursor · opencode
---

# noir-debt

Harvest every `noir-debt:` marker in the repository into a ledger grouped by file. Each entry names the marker's ceiling and the trigger that retires it, so a later change can pay the debt back instead of rediscovering it.

## When to use

- The user asks "what did we defer", "list the shortcuts", "debt ledger", or mentions noir-debt.
- Before changing a file, to see which markers inside it have a trigger that has already arrived.
- **Do NOT use** to fix the debt itself; the owning task pays it. For the whole-repo over-engineering and prose pass, use `noir-codebase-audit`.

## Procedure

1. **Find the markers.** Grep the repo for `noir-debt:` in source comments, for example: `grep -rn "noir-debt:" .`. Narrow the include patterns to the languages present.
2. **Read each marker's two halves.** A marker names a ceiling and the condition that justifies the upgrade, for example: `// noir-debt: global lock, per-account locks when throughput matters`. A marker with only a ceiling is incomplete; list it as such rather than inventing a trigger.
3. **Group by file.** Order entries by path, then line. One line per marker: file, line, ceiling, trigger.
4. **Print the ledger to stdout.** Keep it copyable: one line per marker, no summary paragraphs. A marker whose trigger has already arrived is flagged in its group as due now.

## Verification

- [ ] Every `noir-debt:` marker in the repo appears in the ledger, grouped by file.
- [ ] Each entry carries the ceiling and the trigger, or is flagged when the trigger half is missing.
- [ ] Entries are one line each, ordered by file then line.
- [ ] Markers whose trigger has arrived are called out as due.

## Notes

- The ledger is read-only output; writing it to a file or paying the markers belongs to the owning task.
- A marker without a trigger cannot be paid back on time; report it as incomplete rather than completing it silently.
- Read the ledger before the next change in a file, so a due marker becomes the work of that change.

## When done → next skill

→ `noir-executing-plans`, or the owning task, to pay a marker whose trigger has arrived. Or `noir-codebase-audit` for the full audit pass.
