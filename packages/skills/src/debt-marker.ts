import type { HygieneRule } from './hygiene.js';

// A `noir-debt:` comment must name a known ceiling or an upgrade trigger
// (when/if/ceiling/once), otherwise the deliberate shortcut is untrackable.
export const DEBT_MARKER_RULE: HygieneRule = {
  id: 'noir-debt',
  tier: 'warn',
  appliesTo: 'code',
  pattern: /(?:^[ \t]*|[ \t])(?:\/\/|#|\/\*|\*)[ \t]*noir-debt:(?!.*\b(?:when|if|ceiling|once)\b)/m,
  rationale: 'a debt marker without a ceiling or upgrade trigger is an un-trackable shortcut',
  fix: 'name the ceiling and the condition that justifies the upgrade',
};
