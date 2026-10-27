// SPDX-License-Identifier: MIT
import { expect, test as base } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

import { expectNoAxeViolations, setTheme } from './support/axe.ts';
import { installFakeWebAuthnAssertion } from './support/fake-webauthn.ts';
import { installApiMocks } from './support/mock-api.ts';
import {
  ABOVE_GATE_RESULT,
  ABSTAINED_LINE,
  BELOW_GATE_RESULT,
  installCategorySuggestionMocks,
  seedSuggestionResult,
  SUGGESTED_CATEGORY_ID,
  SUGGESTED_CATEGORY_LABEL,
  SUGGESTED_MERCHANT,
  SUGGESTED_TRANSACTION_ID,
  SUGGESTION_CHIP,
} from './support/mock-category-suggestions.ts';
import { installSweepMocks } from './support/mock-sweep.ts';
import { screenshotDir } from './support/screenshot-dir.ts';
import { hideDevtools, visit } from './support/sweep.ts';

/**
 * WP 11.2 (category suggestions for the abstained residue, web slice), against the mocked api
 * (`support/mock-category-suggestions.ts`, over `mock-api.ts`): the model's suggestion as a chip in the Inbox and the
 * transaction list — Confirm is the normal pick (`PATCH /transactions/{id}` with the suggested category, the row
 * leaves the queue), Not this posts the rejection and the chip goes with the row still uncategorised — and
 * Settings › Language model › Category suggestions: Measure → a result below the gate → Enable held with its reason;
 * a second measurement past the gate → Enable turns suggestions on.
 *
 * The evidence screenshots are one test, run alone with `-g "WP 11.2 evidence"` and `PLAYWRIGHT_EVIDENCE_DIR` set
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

function inboxRow(page: Page, text: string): Locator {
  return page.getByRole('list', { name: 'Review inbox' }).locator('> li').filter({ hasText: text });
}

async function openLanguageModel(page: Page): Promise<Locator> {
  await visit(page, '/settings');
  await page.getByRole('tab', { name: 'Language model' }).click();
  const card = page.getByTestId('category-suggestions');
  await expect(card.getByTestId('suggestions-status')).toBeVisible();
  return card;
}

test.describe('WP 11.2 category suggestions', () => {
  test('the Inbox: the chip says the source and the reason, and Confirm files the row through the normal pick', async ({
    page,
  }) => {
    await installFakeWebAuthnAssertion(page);
    const api = await installApiMocks(page);
    const mocks = await installCategorySuggestionMocks(page);
    await signInByCode(page);
    await page.goto('/inbox');

    const row = inboxRow(page, SUGGESTED_MERCHANT);
    const chip = row.getByTestId('suggestion-chip');
    await expect(chip.getByTestId('suggestion-chip-text')).toHaveText(SUGGESTION_CHIP);
    // A suggestion, not an assignment: the row still reads uncategorised, its "why" kept; nothing was applied.
    await expect(row).toContainText('· Uncategorized');
    await expect(row.getByTestId('inbox-why')).toHaveText(`Why: ${ABSTAINED_LINE}`);
    expect(mocks.patches).toEqual([]);
    await expect(inboxRow(page, 'Farmers Market').getByTestId('suggestion-chip')).toHaveCount(0);
    await expectNoAxeViolations(page, 'inbox with a model suggestion');

    await chip.getByRole('button', { name: `Confirm ${SUGGESTED_CATEGORY_LABEL}` }).click();
    await expect
      .poll(() => mocks.patches, { message: 'PATCH /transactions/{id} was never sent' })
      .toEqual([
        { transactionId: SUGGESTED_TRANSACTION_ID, body: { categoryId: SUGGESTED_CATEGORY_ID } },
      ]);
    expect(api.lastPatchBody).toEqual({ categoryId: SUGGESTED_CATEGORY_ID });
    await expect(inboxRow(page, SUGGESTED_MERCHANT)).toHaveCount(0);
    await expect(inboxRow(page, 'Farmers Market')).toHaveCount(1);
    expect(mocks.rejects).toEqual([]);
  });

  test('the Inbox: Not this posts the rejection; the chip is gone and the row stays uncategorised', async ({
    page,
  }) => {
    await installFakeWebAuthnAssertion(page);
    await installApiMocks(page);
    const mocks = await installCategorySuggestionMocks(page);
    await signInByCode(page);
    await page.goto('/inbox');

    const row = inboxRow(page, SUGGESTED_MERCHANT);
    await expect(row.getByTestId('suggestion-chip')).toBeVisible();
    await row.getByRole('button', { name: 'Not this' }).click();

    await expect.poll(() => mocks.rejects).toEqual([SUGGESTED_TRANSACTION_ID]);
    await expect(row.getByTestId('suggestion-chip')).toHaveCount(0);
    await expect(row).toContainText('· Uncategorized');
    await expect(row).toBeFocused();
    expect(mocks.patches).toEqual([]);
    expect(mocks.explanationBatches.length).toBeGreaterThanOrEqual(2);
  });

  test('the transaction list: the compact chip; Not this, then Confirm on a fresh visit', async ({
    page,
  }) => {
    await installFakeWebAuthnAssertion(page);
    await installApiMocks(page);
    const mocks = await installCategorySuggestionMocks(page);
    await signInByCode(page);
    await page.goto('/transactions');

    const grid = page.getByRole('grid', { name: 'Transactions' });
    const row = grid.locator(`[data-transaction-id="${SUGGESTED_TRANSACTION_ID}"]`);
    const chip = row.getByTestId('suggestion-chip');
    await expect(chip.getByTestId('suggestion-chip-text')).toHaveText(SUGGESTION_CHIP);
    await expect(row).toContainText('Uncategorized ·');
    // One batch, for the uncategorised rows only.
    expect(mocks.explanationBatches.length).toBeGreaterThan(0);
    expect(mocks.explanationBatches[0]?.split(',')).toContain(SUGGESTED_TRANSACTION_ID);
    await expect(grid.getByTestId('suggestion-chip')).toHaveCount(1);
    await expectNoAxeViolations(page, 'transactions with a model suggestion');

    await chip.getByRole('button', { name: `Confirm ${SUGGESTED_CATEGORY_LABEL}` }).click();
    await expect
      .poll(() => mocks.patches)
      .toEqual([
        { transactionId: SUGGESTED_TRANSACTION_ID, body: { categoryId: SUGGESTED_CATEGORY_ID } },
      ]);
    await expect(row.getByTestId('suggestion-chip')).toHaveCount(0);
    await expect(row).toContainText(`${SUGGESTED_CATEGORY_LABEL} ·`);
    // The chip's buttons are its own: the row's detail did not open.
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('the transaction list: Not this, and the chip is gone', async ({ page }) => {
    await installFakeWebAuthnAssertion(page);
    await installApiMocks(page);
    const mocks = await installCategorySuggestionMocks(page);
    await signInByCode(page);
    await page.goto('/transactions');

    const row = page.locator(`[data-transaction-id="${SUGGESTED_TRANSACTION_ID}"]`);
    await row.getByRole('button', { name: 'Not this' }).click();
    await expect.poll(() => mocks.rejects).toEqual([SUGGESTED_TRANSACTION_ID]);
    await expect(row.getByTestId('suggestion-chip')).toHaveCount(0);
    await expect(row).toContainText('Uncategorized ·');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(mocks.patches).toEqual([]);
  });

  test('Settings: Measure → below the gate → Enable held with the reason; measured again past it → Enable turns it on', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await installFakeWebAuthnAssertion(page);
    const api = await installApiMocks(page);
    const card = await openLanguageModel(page);
    const status = card.getByTestId('suggestions-status');
    const toggle = card.getByRole('switch', { name: 'Show category suggestions' });
    const why = card.getByTestId('suggestions-enable-why');
    const live = card.getByTestId('suggestions-measure-live');

    await expect(status).toHaveText('Off: not measured yet');
    await expect(card.getByTestId('suggestions-what-leaves')).toHaveText(
      /^What leaves this machine: nothing\./,
    );
    await expect(card.getByTestId('suggestions-consent')).toHaveCount(0);
    await expect(toggle).toHaveAttribute('aria-disabled', 'true');

    // 1. Measure (the passkey step-up first), "Measuring…" while the settings are read every 2 s, then the result.
    await card.getByRole('button', { name: 'Measure' }).click();
    await expect(live).toHaveAttribute('aria-live', 'polite');
    await expect(live).toContainText('Measuring…');
    await expect(live).toHaveText('Measured: 72 % precision, 63 % coverage, 25 rows scored.', {
      timeout: 20_000,
    });
    expect(api.categorySuggestions.writes[0]).toEqual({
      call: 'POST /api/categories/suggestions/measure',
      body: { modelChoice: 'narrator' },
    });
    expect(api.categorySuggestions.stepUpsAsked).toBeGreaterThan(0);
    await expect(status).toHaveText(
      'Off: below the 85 % gate — 72 % on your history, 25 rows scored',
    );
    await expect(card.getByTestId('suggestions-precision')).toContainText('72 %');
    await expect(card.getByTestId('suggestions-confusions').locator('li').first()).toHaveText(
      'Restaurants → Coffee Shops: 4 times',
    );
    // Enable is held, and says why in words.
    await expect(toggle).toHaveAttribute('aria-disabled', 'true');
    await expect(why).toContainText(
      'Turns on at 85 % precision over at least 20 of your own transactions; last measured 72 % on 25.',
    );
    await toggle.click({ force: true });
    expect(api.categorySuggestions.writes.map((w) => w.call)).not.toContain(
      'POST /api/categories/suggestions/enabled',
    );
    await expectNoAxeViolations(page, 'settings › category suggestions below the gate');

    // 2. Measured again: past the gate, the switch is offered, and turns suggestions on.
    await card.getByRole('button', { name: 'Measure' }).click();
    await expect(live).toHaveText('Measured: 91 % precision, 85 % coverage, 34 rows scored.', {
      timeout: 20_000,
    });
    await expect(status).toHaveText('Ready to turn on');
    await expect(toggle).not.toHaveAttribute('aria-disabled', 'true');
    await toggle.click();
    await expect(status).toHaveText('On');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(api.categorySuggestions.writes.at(-1)).toEqual({
      call: 'POST /api/categories/suggestions/enabled',
      body: { enabled: true },
    });
    await expectNoAxeViolations(page, 'settings › category suggestions on');
  });

  test('Settings: the payload is shown on demand and approved with its shape; the hosted consent only when it applies', async ({
    page,
  }) => {
    await installFakeWebAuthnAssertion(page);
    const api = await installApiMocks(page);
    api.categorySuggestions.settings.hosted.applies = true;
    const card = await openLanguageModel(page);

    const consent = card.getByRole('checkbox', {
      name: api.categorySuggestions.settings.hosted.consentText,
    });
    await expect(consent).not.toBeChecked();
    await expect(card.getByTestId('suggestions-what-leaves')).not.toContainText('nothing');

    await card.getByRole('button', { name: 'Show exactly what a run would send' }).click();
    await expect(card.getByTestId('suggestions-prompt')).toContainText('untrusted_data');
    await card.getByRole('button', { name: 'Approve this payload' }).click();
    await expect(card.getByText('Approved for this payload shape')).toBeVisible();
    expect(api.categorySuggestions.writes).toContainEqual({
      call: 'POST /api/categories/suggestions/approve',
      body: { queryShape: 'categorization.suggest:v1' },
    });

    // The box shows the api's state, not the click: it is ticked once the write (after the step-up) answers.
    await consent.click();
    await expect(consent).toBeChecked();
    expect(api.categorySuggestions.writes).toContainEqual({
      call: 'PUT /api/categories/suggestions/hosted-consent',
      body: {
        consent: true,
        consentTextSha256: api.categorySuggestions.settings.hosted.consentTextSha256,
      },
    });
  });

  test('WP 11.2 evidence: the Inbox chip, and the settings below and above the gate, light and dark, 1280 and 390', async ({
    page,
    evidenceDir,
  }) => {
    test.setTimeout(180_000);
    const mocks = await installSweepMocks(page);
    await installCategorySuggestionMocks(page);
    const dir = screenshotDir(evidenceDir);
    for (const [width, height] of [
      [1280, 900],
      [390, 1400],
    ] as const) {
      await page.setViewportSize({ width, height });

      await visit(page, '/inbox');
      await hideDevtools(page);
      const row = inboxRow(page, SUGGESTED_MERCHANT);
      await expect(row.getByTestId('suggestion-chip-text')).toHaveText(SUGGESTION_CHIP);
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        await row.screenshot({
          path: `${dir}wp11.2-inbox-suggestion-${theme}-${String(width)}.png`,
          animations: 'disabled',
        });
      }

      for (const [name, result] of [
        ['below-gate', BELOW_GATE_RESULT],
        ['above-gate', ABOVE_GATE_RESULT],
      ] as const) {
        seedSuggestionResult(mocks.categorySuggestions, result);
        await visit(page, '/settings');
        await hideDevtools(page);
        await page.getByRole('tab', { name: 'Language model' }).click();
        const card = page.getByTestId('category-suggestions');
        await expect(card.getByTestId('suggestions-status')).toHaveText(
          name === 'below-gate'
            ? 'Off: below the 85 % gate — 72 % on your history, 25 rows scored'
            : 'Ready to turn on',
        );
        await expect(card.getByTestId('suggestions-confusions')).toBeVisible();
        for (const theme of ['light', 'dark'] as const) {
          await setTheme(page, theme);
          await card.screenshot({
            path: `${dir}wp11.2-settings-${name}-${theme}-${String(width)}.png`,
            animations: 'disabled',
          });
        }
      }
    }
  });
});
