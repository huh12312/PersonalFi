// SPDX-License-Identifier: MIT
import { expect, test as base } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoAxeViolations, setTheme } from './support/axe.ts';
import { installFakeWebAuthnAssertion } from './support/fake-webauthn.ts';
import { installApiMocks } from './support/mock-api.ts';
import {
  ABSTAINED_LINE,
  CITED_MERCHANT,
  CITED_TRANSACTION_ID,
  installRuleSuggestionMocks,
  NOT_RECORDED_LINE,
  RULE_SUGGESTION_INSIGHT_ID,
  SUGGESTED_CATEGORY_KEY,
} from './support/mock-rule-suggestions.ts';
import { installSweepMocks } from './support/mock-sweep.ts';
import { screenshotDir } from './support/screenshot-dir.ts';
import { hideDevtools, visit } from './support/sweep.ts';

/**
 * WP 11.1 (deterministic categorisation groundwork, web slice): the Inbox's one-line "why" under an uncategorised
 * row, read verbatim from `GET /transactions/explanations`; and a `spending.rule_suggestion` accepted from the Inbox
 * and from `/insights` — the rule created through the dialog's own `POST /transactions/{id}/rule` with the suggested
 * category, then `POST /insights/{id}/review {action:'accept'}`, then the suggestion gone.
 *
 * The evidence screenshots are one test, run alone with `-g "WP 11.1 evidence"` and `PLAYWRIGHT_EVIDENCE_DIR` set
 * to `docs/evidence/phase-11` (unset, they go to the gitignored output directory).
 */
const test = base.extend<{ evidenceDir: string | undefined }>({
  evidenceDir: [undefined, { option: true }],
});

async function signInByCode(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Use an authenticator code instead' }).click();
  await page.getByLabel('6-digit authenticator code').fill('123456');
  await page.getByRole('button', { name: 'Verify code' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

test.describe('WP 11.1 rule suggestions', () => {
  test('the Inbox shows the server’s explanation line under an uncategorised row', async ({
    page,
  }) => {
    await installFakeWebAuthnAssertion(page);
    await installApiMocks(page);
    const mocks = await installRuleSuggestionMocks(page);
    await signInByCode(page);
    await page.goto('/inbox');

    const row = page
      .getByRole('list', { name: 'Review inbox' })
      .locator('> li')
      .filter({ hasText: 'Blue Bottle Coffee' });
    await expect(row.getByTestId('inbox-why')).toHaveText(`Why: ${ABSTAINED_LINE}`);
    const other = page
      .getByRole('list', { name: 'Review inbox' })
      .locator('> li')
      .filter({ hasText: 'Farmers Market' });
    await expect(other.getByTestId('inbox-why')).toHaveText(`Why: ${NOT_RECORDED_LINE}`);
    // One batch for the rows on screen.
    expect([...new Set(mocks.explanationBatches)]).toEqual(['txn_1,txn_2']);
    await expectNoAxeViolations(page, 'inbox with explanation lines');
  });

  test('accepting a rule suggestion from the Inbox creates the rule with its category, accepts it, and it is gone', async ({
    page,
  }) => {
    await installFakeWebAuthnAssertion(page);
    const api = await installApiMocks(page);
    const mocks = await installRuleSuggestionMocks(page);
    await signInByCode(page);
    await page.goto('/inbox');

    const suggestion = page.getByTestId('rule-suggestion');
    await expect(suggestion).toHaveCount(1);
    await expect(suggestion.getByTestId('rule-suggestion-merchant')).toHaveText(CITED_MERCHANT);
    await expect(suggestion).toContainText('Groceries');
    await expect(suggestion.getByTestId('rule-suggestion-count')).toHaveText('4');

    await suggestion.getByRole('button', { name: 'Create rule' }).click();
    const dialog = page.getByRole('dialog', { name: 'Always categorize like this' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('combobox', { name: 'Category' })).toHaveValue('Groceries');
    // Nothing is created before the dialog's own button.
    expect(mocks.ruleCreates).toEqual([]);
    expect(mocks.reviews).toEqual([]);

    await dialog.getByRole('button', { name: 'Preview' }).click();
    await expect
      .poll(() => mocks.ruleCreates, { message: 'POST /transactions/{id}/rule was never sent' })
      .toEqual([
        {
          transactionId: CITED_TRANSACTION_ID,
          body: { categoryKey: SUGGESTED_CATEGORY_KEY, name: expect.any(String) },
        },
      ]);
    expect(api.lastRuleCreateBody).toMatchObject({ categoryKey: SUGGESTED_CATEGORY_KEY });
    await expect
      .poll(() => mocks.reviews, { message: 'POST /insights/{id}/review was never sent' })
      .toEqual([{ insightId: RULE_SUGGESTION_INSIGHT_ID, body: { action: 'accept' } }]);

    await dialog.getByRole('button', { name: 'Just save the rule' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('rule-suggestion')).toHaveCount(0);
    // Nothing was applied to existing transactions: only Apply does that, and it was not pressed.
    expect(api.lastRuleApplyBody).toBeNull();
  });

  test('accepting a rule suggestion from /insights does the same; the S3 draft stays inert', async ({
    page,
  }) => {
    await installFakeWebAuthnAssertion(page);
    const api = await installApiMocks(page);
    const mocks = await installRuleSuggestionMocks(page);
    await signInByCode(page);
    await page.goto('/insights');

    const cards = page.getByRole('list', { name: 'Insights' }).locator('> li');
    const suggestion = cards.filter({ hasText: 'A merchant you always file the same way' });
    const s3 = cards.filter({ hasText: 'Some spending has no category' });
    await expect(suggestion).toHaveCount(1);
    await expect(s3).toHaveCount(1);
    await expect(s3.getByRole('button', { name: 'Create rule' })).toHaveCount(0);
    await expectNoAxeViolations(page, 'insights with a rule suggestion');

    await suggestion.getByRole('button', { name: 'Create rule' }).click();
    const dialog = page.getByRole('dialog', { name: 'Always categorize like this' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('combobox', { name: 'Category' })).toHaveValue('Groceries');
    expect(mocks.ruleCreates).toEqual([]);

    await dialog.getByRole('button', { name: 'Preview' }).click();
    await expect
      .poll(() => mocks.ruleCreates)
      .toEqual([
        {
          transactionId: CITED_TRANSACTION_ID,
          body: { categoryKey: SUGGESTED_CATEGORY_KEY, name: expect.any(String) },
        },
      ]);
    await expect
      .poll(() => mocks.reviews)
      .toEqual([{ insightId: RULE_SUGGESTION_INSIGHT_ID, body: { action: 'accept' } }]);

    // This time the holder applies it: the preview's count, then the dialog closes and the card is gone.
    await dialog.getByRole('button', { name: /apply to \d+ transactions?/i }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => api.lastRuleApplyBody).toEqual({ retroactive: true });
    await expect(suggestion).toHaveCount(0);
    await expect(s3).toHaveCount(1);
  });

  test('WP 11.1 evidence: the explanation line and a rule suggestion, light and dark, 1280 and 390', async ({
    page,
    evidenceDir,
  }) => {
    test.setTimeout(180_000);
    await installSweepMocks(page);
    await installRuleSuggestionMocks(page);
    const dir = screenshotDir(evidenceDir);
    for (const [width, height] of [
      [1280, 900],
      [390, 1400],
    ] as const) {
      await page.setViewportSize({ width, height });

      await visit(page, '/inbox');
      await hideDevtools(page);
      const row = page
        .getByRole('list', { name: 'Review inbox' })
        .locator('> li')
        .filter({ hasText: 'Blue Bottle Coffee' });
      await expect(row.getByTestId('inbox-why')).toHaveText(`Why: ${ABSTAINED_LINE}`);
      const suggestion = page.getByTestId('rule-suggestion');
      await expect(suggestion.getByTestId('rule-suggestion-merchant')).toHaveText(CITED_MERCHANT);
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        await row.screenshot({
          path: `${dir}wp11.1-inbox-explanation-${theme}-${String(width)}.png`,
          animations: 'disabled',
        });
        await page.locator('[data-inbox-section="rule-suggestions"]').screenshot({
          path: `${dir}wp11.1-inbox-rule-suggestion-${theme}-${String(width)}.png`,
          animations: 'disabled',
        });
      }

      await visit(page, '/insights');
      await hideDevtools(page);
      const card = page
        .getByRole('list', { name: 'Insights' })
        .locator('> li')
        .filter({ hasText: 'A merchant you always file the same way' });
      await expect(card.getByRole('button', { name: 'Create rule' })).toBeVisible();
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        await card.screenshot({
          path: `${dir}wp11.1-insight-rule-suggestion-${theme}-${String(width)}.png`,
          animations: 'disabled',
        });
      }
    }
  });
});
