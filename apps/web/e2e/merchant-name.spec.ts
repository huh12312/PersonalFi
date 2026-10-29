// SPDX-License-Identifier: MIT
import { expect, test as base } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

import { expectNoAxeViolations, setTheme } from './support/axe.ts';
import { installFakeWebAuthnAssertion } from './support/fake-webauthn.ts';
import { installAdvisorMocks } from './support/mock-advisors.ts';
import { installApiMocks, type MockApiState } from './support/mock-api.ts';
import {
  CONSENT,
  EBAY_BANK_TEXT,
  EBAY_MERCHANT_ID,
  EBAY_NAME,
  EBAY_SUGGESTION_ID,
  EBAY_TXN_IDS,
  HOSTED_NOTE,
  MERCHANT_NAME_ADVISOR_NAME,
  NOISE_TXN_ID,
  NOT_APPROVED_NOTE,
  PATREON_BANK_TEXT,
  PATREON_NAME,
  PATREON_SUGGESTION_ID,
  PATREON_TXN_ID,
  seedMerchantNames,
  SUGGESTED_BY_LINE,
} from './support/mock-merchant-names.ts';
import { installSweepMocks } from './support/mock-sweep.ts';
import { screenshotDir } from './support/screenshot-dir.ts';
import { hideDevtools, visit } from './support/sweep.ts';

/**
 * WP 11.6 (merchant display-name suggestions, web slice), against the mocked api (`support/mock-merchant-names.ts`,
 * wired into `mock-api.ts` and `mock-advisors.ts`): the local model's name beside the bank's own text on the
 * transaction list and in the detail sheet; Accept renames the merchant's transactions and the chip goes; Dismiss
 * removes it; where nothing can be suggested a one-line note says why and links to Advisors; and Advisor management
 * lists `merchant.name` with its preview (the descriptor, the consent wording) and the approval.
 *
 * The evidence screenshots are one test, run alone with `-g "WP 11.6 evidence"` and `PLAYWRIGHT_EVIDENCE_DIR` set
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

function row(page: Page, transactionId: string): Locator {
  return page
    .getByRole('grid', { name: 'Transactions' })
    .locator(`[data-transaction-id="${transactionId}"]`);
}

/** The general fixture with the noise merchants seeded and the advisor layer over it, signed in, on /transactions. */
async function openTransactions(
  page: Page,
  seed: Parameters<typeof seedMerchantNames>[1] = { mode: 'suggested' },
): Promise<MockApiState> {
  await installFakeWebAuthnAssertion(page);
  const api = await installApiMocks(page);
  await installAdvisorMocks(page, api);
  seedMerchantNames(api, seed);
  await signInByCode(page);
  await page.goto('/transactions');
  await expect(row(page, EBAY_TXN_IDS[0])).toBeVisible();
  return api;
}

test.describe('WP 11.6 merchant name suggestions', () => {
  test('the chip sits under the bank’s own text with who suggested it, and nothing is sent on render', async ({
    page,
  }) => {
    const api = await openTransactions(page);

    for (const id of EBAY_TXN_IDS) {
      const ebay = row(page, id);
      await expect(ebay).toContainText(EBAY_BANK_TEXT);
      const chip = ebay.getByTestId('merchant-name-chip');
      await expect(chip.getByTestId('merchant-name-chip-name')).toHaveText(EBAY_NAME);
      await expect(chip.getByTestId('merchant-name-chip-provenance')).toHaveText(SUGGESTED_BY_LINE);
      await expect(chip.getByRole('button', { name: 'Accept the name Ebay' })).toBeVisible();
      await expect(chip.getByRole('button', { name: 'Dismiss the name Ebay' })).toBeVisible();
    }
    const patreon = row(page, PATREON_TXN_ID);
    await expect(patreon).toContainText(PATREON_BANK_TEXT);
    await expect(patreon.getByTestId('merchant-name-chip-name')).toHaveText(PATREON_NAME);
    // The row of a merchant the pass has not asked about yet draws neither a chip nor (the pass is available) a note.
    await expect(row(page, NOISE_TXN_ID)).toBeVisible();
    await expect(row(page, NOISE_TXN_ID).getByTestId('merchant-name-chip')).toHaveCount(0);
    await expect(page.getByTestId('merchant-name-note')).toHaveCount(0);

    // Rendering applied nothing: no accept, no dismiss, no overlay write; one read of the list for the screen.
    expect(api.merchantNames.accepts).toEqual([]);
    expect(api.merchantNames.dismisses).toEqual([]);
    expect(api.lastPatchBody).toBeNull();
    expect(api.merchantNames.listReads).toBe(1);
    await expectNoAxeViolations(page, 'transactions with merchant name chips');
  });

  test('Accept renames the merchant’s transactions, says how many, and the chip goes', async ({
    page,
  }) => {
    const api = await openTransactions(page);

    await row(page, EBAY_TXN_IDS[0]).getByRole('button', { name: 'Accept the name Ebay' }).click();

    await expect(page.getByTestId('merchant-name-status')).toHaveText(
      'Renamed 2 transactions to Ebay.',
    );
    expect(api.merchantNames.accepts).toEqual([EBAY_SUGGESTION_ID]);
    for (const id of EBAY_TXN_IDS) {
      await expect(row(page, id)).not.toContainText(EBAY_BANK_TEXT);
      await expect(row(page, id).getByTestId('merchant-name-chip')).toHaveCount(0);
      await expect(row(page, id)).toContainText(EBAY_NAME);
    }
    // The other merchant is untouched, and the press opened nothing and did not go through the manual rename.
    await expect(row(page, PATREON_TXN_ID).getByTestId('merchant-name-chip')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(row(page, EBAY_TXN_IDS[0])).toBeFocused();
    expect(api.lastPatchBody).toBeNull();
    expect(api.merchantNames.listReads).toBeGreaterThanOrEqual(2);
  });

  test('Dismiss removes the chip and leaves the bank’s text', async ({ page }) => {
    const api = await openTransactions(page);

    await row(page, PATREON_TXN_ID)
      .getByRole('button', { name: 'Dismiss the name Patreon Membership' })
      .click();

    await expect(page.getByTestId('merchant-name-status')).toHaveText(
      'Dismissed the name Patreon Membership. The bank’s text stays.',
    );
    await expect(row(page, PATREON_TXN_ID).getByTestId('merchant-name-chip')).toHaveCount(0);
    await expect(row(page, PATREON_TXN_ID)).toContainText(PATREON_BANK_TEXT);
    expect(api.merchantNames.dismisses).toEqual([PATREON_SUGGESTION_ID]);
    expect(api.merchantNames.accepts).toEqual([]);
    // The other merchant's chip stays.
    await expect(row(page, EBAY_TXN_IDS[0]).getByTestId('merchant-name-chip')).toBeVisible();
  });

  test('a row that arrives after the accept still reads the bank’s text and carries the chip; Accept applies the name to it', async ({
    page,
  }) => {
    const api = await openTransactions(page);
    await row(page, EBAY_TXN_IDS[0]).getByRole('button', { name: 'Accept the name Ebay' }).click();
    await expect(page.getByTestId('merchant-name-status')).toHaveText(
      'Renamed 2 transactions to Ebay.',
    );

    // A sync brings a third Ebay row, named by the bank.
    api.addTransaction({
      id: 'txn_ebay_3',
      date: new Date().toISOString().slice(0, 10),
      amount: { minor: '-2100', currency: 'USD' },
      name: EBAY_BANK_TEXT,
      merchantId: EBAY_MERCHANT_ID,
      merchantName: null,
    });
    await page.reload();

    const fresh = row(page, 'txn_ebay_3');
    const chip = fresh.getByTestId('merchant-name-chip');
    await expect(chip).toHaveAttribute('data-status', 'accepted');
    await expect(chip.getByTestId('merchant-name-chip-provenance')).toContainText(
      'You accepted it for this merchant before; this row still reads the bank’s text.',
    );
    // The two rows renamed earlier carry nothing (the Patreon chip is the other one on the screen).
    await expect(
      page.locator(`[data-testid="merchant-name-chip"][data-merchant-id="${EBAY_MERCHANT_ID}"]`),
    ).toHaveCount(1);

    await chip.getByRole('button', { name: 'Accept the name Ebay' }).click();
    await expect(page.getByTestId('merchant-name-status')).toHaveText(
      'Renamed 1 transaction to Ebay.',
    );
    await expect(
      page.locator(`[data-testid="merchant-name-chip"][data-merchant-id="${EBAY_MERCHANT_ID}"]`),
    ).toHaveCount(0);
    expect(api.merchantNames.accepts).toEqual([EBAY_SUGGESTION_ID, EBAY_SUGGESTION_ID]);
  });

  test('the detail sheet shows the bank’s text beside the chip, and Accept there moves focus to the confirmation', async ({
    page,
  }) => {
    const api = await openTransactions(page);

    await row(page, EBAY_TXN_IDS[0]).getByText(EBAY_BANK_TEXT).click();
    const section = page.getByTestId('merchant-name-section');
    await expect(section.getByTestId('merchant-name-bank-text')).toHaveText(EBAY_BANK_TEXT);
    await expect(section.getByTestId('merchant-name-chip-provenance')).toHaveText(
      SUGGESTED_BY_LINE,
    );
    await expectNoAxeViolations(page, 'transaction detail with a merchant name chip');

    await section.getByRole('button', { name: 'Accept the name Ebay' }).click();
    const status = section.getByRole('status');
    await expect(status).toHaveText('Renamed 2 transactions to Ebay.');
    await expect(status).toBeFocused();
    await expect(section.getByTestId('merchant-name-chip')).toHaveCount(0);
    await expect(page.getByRole('dialog').getByRole('heading', { name: EBAY_NAME })).toBeVisible();
    expect(api.merchantNames.accepts).toEqual([EBAY_SUGGESTION_ID]);
  });

  test('not approved: a quiet note where the chip would be, with a link to Advisors', async ({
    page,
  }) => {
    await openTransactions(page, { mode: 'unavailable', reason: 'payload_not_approved' });

    // No chips; one note per merchant at most (and at most three on the screen).
    await expect(page.getByTestId('merchant-name-chip')).toHaveCount(0);
    const notes = page.getByTestId('merchant-name-note');
    await expect(notes).toHaveCount(3);
    const note = row(page, EBAY_TXN_IDS[0]).getByTestId('merchant-name-note');
    await expect(note).toHaveText(NOT_APPROVED_NOTE);
    await expect(row(page, EBAY_TXN_IDS[1]).getByTestId('merchant-name-note')).toHaveCount(0);
    await expectNoAxeViolations(page, 'transactions with the not-approved note');

    await note.getByRole('link', { name: 'Advisors' }).click();
    await expect(page).toHaveURL(/\/settings\/advisors$/);
    await expect(
      page
        .getByTestId('advisor-management-screen')
        .getByRole('heading', { name: 'Advisor management' }),
    ).toBeVisible();
    await expect(page.getByText(MERCHANT_NAME_ADVISOR_NAME, { exact: true })).toBeVisible();
  });

  test('a hosted narrator: the note says names stay on this machine', async ({ page }) => {
    await openTransactions(page, { mode: 'unavailable', reason: 'hosted_narrator' });

    await expect(row(page, EBAY_TXN_IDS[0]).getByTestId('merchant-name-note')).toHaveText(
      HOSTED_NOTE,
    );
    await expect(row(page, EBAY_TXN_IDS[0]).getByRole('link')).toHaveCount(0);
  });

  test('Advisor management lists merchant.name; its preview shows the descriptor and the consent wording, and it can be approved', async ({
    page,
  }) => {
    const api = await openTransactions(page, {
      mode: 'unavailable',
      reason: 'payload_not_approved',
    });
    await page.goto('/settings/advisors');
    await expect(
      page
        .getByTestId('advisor-management-screen')
        .getByRole('heading', { name: 'Advisor management' }),
    ).toBeVisible();

    const advisor = page.getByTestId('advisor-row').filter({ hasText: MERCHANT_NAME_ADVISOR_NAME });
    await expect(advisor).toContainText('merchant.name · v1.0.0 · local_model');
    await advisor.getByRole('button', { name: 'Show detail' }).click();
    const detail = page.getByRole('region', { name: `${MERCHANT_NAME_ADVISOR_NAME} detail` });
    await expect(detail.getByTestId('payload-preview-panel')).toBeVisible();

    await expect(detail.getByTestId('payload-consent')).toHaveAccessibleName(
      'What leaves this machine',
    );
    await expect(detail.getByTestId('payload-consent-text')).toHaveText(CONSENT.text);
    await expect(detail.getByTestId('payload-consent-text')).toContainText(
      'Nothing leaves this machine; with a hosted narrator no suggestion is made.',
    );
    await expect(detail.getByTestId('payload-consent')).toContainText(CONSENT.version);
    // The descriptor the model would receive, in the marked untrusted block.
    await expect(detail.getByTestId('untrusted-block')).toContainText('Ebayinc');
    await expect(detail.getByTestId('untrusted-block')).toContainText('PAYPAL *');
    await expectNoAxeViolations(page, 'advisor management with the merchant.name preview');

    await detail.getByRole('button', { name: 'Approve this payload' }).click();
    await expect(detail.getByText('Approved for this exact payload shape')).toBeVisible();
    expect(api.merchantNames.approvals).toHaveLength(1);

    // Approved: the pass can ask now, so the transactions no longer say why not.
    await page.goto('/transactions');
    await expect(row(page, EBAY_TXN_IDS[0])).toBeVisible();
    await expect(page.getByTestId('merchant-name-note')).toHaveCount(0);
  });

  test('WP 11.6 evidence: the transactions screen with a chip, and after Accept, light and dark, 1280 and 390', async ({
    page,
    evidenceDir,
  }) => {
    test.setTimeout(180_000);
    const mocks = await installSweepMocks(page);
    seedMerchantNames(mocks.api, { mode: 'suggested' });
    const dir = screenshotDir(evidenceDir);

    for (const [width, height] of [
      [1280, 900],
      [390, 1400],
    ] as const) {
      await page.setViewportSize({ width, height });
      await visit(page, '/transactions');
      await hideDevtools(page);
      const first = row(page, EBAY_TXN_IDS[0]);
      await expect(first.getByTestId('merchant-name-chip-provenance')).toHaveText(
        SUGGESTED_BY_LINE,
      );
      await expect(row(page, PATREON_TXN_ID).getByTestId('merchant-name-chip')).toBeVisible();
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        await page.screenshot({
          path: `${dir}wp11.6-merchant-name-suggested-${theme}-${String(width)}.png`,
          animations: 'disabled',
        });
      }

      await first.getByRole('button', { name: 'Accept the name Ebay' }).click();
      await expect(page.getByTestId('merchant-name-status')).toHaveText(
        'Renamed 2 transactions to Ebay.',
      );
      await expect(page.getByTestId('merchant-name-chip')).toHaveCount(1);
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        await page.screenshot({
          path: `${dir}wp11.6-merchant-name-accepted-${theme}-${String(width)}.png`,
          animations: 'disabled',
        });
      }

      // Back to the suggested state for the next width (the rows read the bank's text again).
      seedMerchantNames(mocks.api, { mode: 'suggested' });
    }
  });
});
