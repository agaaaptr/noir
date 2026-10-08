import type { HygieneRule } from './hygiene.js';

// A `noir-debt:` comment must name a known ceiling AND an upgrade trigger
// (when/if/once), otherwise the deliberate shortcut is untrackable. The word
// "ceiling" alone is not a trigger: it names the limit, not the condition that
// justifies paying for the upgrade.
export const DEBT_MARKER_RULE: HygieneRule = {
  id: 'noir-debt',
  tier: 'warn',
  appliesTo: 'code',
  pattern: /(?:^[ \t]*|[ \t])(?:\/\/|#|\/\*|\*)[ \t]*noir-debt:(?!.*\b(?:when|if|once)\b)/m,
  rationale: 'a debt marker without a ceiling or upgrade trigger is an un-trackable shortcut',
  fix: 'name the ceiling and the condition that justifies the upgrade',
};
