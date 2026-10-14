# Authoring e2e tests

The hybrid shape: a natural-language goal the host agent drives, pinned by an
exact assertion. The runner is whatever the project already uses (Playwright,
Cypress, vitest browser mode). Never add a dependency when one is present.

## Fixture shape

Import `test` and `expect` from the runner. A test receives the app/browser
driver and the locator surface.

```ts
import { test, expect } from '@playwright/test';

test('a member upgrades to Pro', async ({ page }) => {
  await page.goto('/settings/billing');
  // natural-language goal, one step at a time:
  await page.getByRole('button', { name: 'Upgrade' }).click();
  await page.getByRole('radio', { name: 'Pro' }).check();
  await page.getByRole('button', { name: 'Confirm' }).click();
  // deterministic pin right after the step:
  await expect(page.getByRole('status')).toContainText('Pro');
});
```

## Locators are semantic

Prefer `getByRole` with an accessible name, then `getByText`, `getByLabel`.
Never bind to a CSS class, a `data-testid`, or a DOM index. A semantic locator
survives restructure and proves what the user sees.

## One goal per step

A step is one user goal, pinned immediately after. If a step cannot be stated
in one sentence, it is several steps.

## Exact vs semantic

- Exact values (a count, a required string, a URL) go through a locator
  assertion.
- Semantic judgments ("the preview looks right") are checked by hand while
  authoring, then reduced to an exact assertion before committing.

## Secrets

A credential or token never appears in test code. Resolve it from the
project's own secret source (env, a vault, a fixture loaded at runtime) and
hand only an opaque handle to the action.
