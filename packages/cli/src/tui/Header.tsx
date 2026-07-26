// Branded header. The diamond mark uses the Midnight Cobalt brand role
// (`c.accent`, solid blue), which is the single-line form of the banner's
// gradient — it strips under NO_COLOR and stays solid under NOIR_ACCESSIBLE.
// The full block wordmark lives in the banner module; a dashboard header is a
// one-line surface, so the compact mark is the right altitude.

import { Text } from 'ink';
import type { ReactElement } from 'react';
import { c } from '../theme.js';

export function Header({ tagline }: { tagline?: string }): ReactElement {
  return (
    <Text>
      {c.accent('◆')} {c.bold('noir')} <Text>{c.dim(tagline ?? 'dashboard')}</Text>
    </Text>
  );
}
