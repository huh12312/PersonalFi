// SPDX-License-Identifier: MIT
/**
 * WP 4.3's two revealed-behaviour ports (`planningCashflowReaderFor`,
 * `planningSpendingReaderFor`, composed by `planningRevealedPortsFor`), run
 * through the real ledger and a real budget — the runtime twin of
 * `packages/contexts/planning/test/ports.test.ts`'s type-level check, and the
 * test `docs/evidence/phase-4/wp4.3-revealed.md` §8.4 asks the orchestrator to
 * commit.
 *
 * `packages/contexts/planning/test/revealed-seed.test.ts` already proves the
 * *derivation* against a hand-built fake port over `generateDemoData(1)`'s raw
 * rows. This file proves the *binding*: the same seed, loaded through
 * `@ctx/ledger`'s own `loadSeedDataset` (the real write path, the real
 * `pairTransfers` heuristic, the real refund detector), read back through
 * `planningRevealedPortsFor` exactly as `apps/api/src/domain.ts` composes it —
 * not a second implementation of the arithmetic, a proof that the wiring
 * reaches the real thing. §7.2 of the evidence above ran this by hand against
 * a throwaway script and got the numbers asserted below; this file is that
 * script, committed.
 *
 * ## Why a budget is built here rather than reused from another suite
 *
 * `generateDemoData(1)` predates `@ctx/budgeting` (WP 2.1 postdates WP 0/1's
 * seed), so the dataset carries no budget at all. `SpendingReader.listBudgets`
 * therefore returns `[]` until one exists, and `result.spending.essential` is
 * `not_derivable` — asserted below, once, as the "no budget" half of the
 * binding, before the second half builds one. The classified budget itself is
 * deliberately the simplest fixture that can prove the composition: one
 * `Rent` line (`NEED`, $2,000.00/mo), one `Dining` line (`WANT`, $300.00/mo),
 * one `Miscellaneous` line (`class: null`, $150.00/mo, "unclassified" in
 * `RevealedBehavior.spending` — nobody set its class, and the derivation must
 * not guess one), for the 13 calendar months 2025-08 through 2026-08. The
 * **2025-08 period is planted at 100×** ($200,000.00 / $30,000.00 /
 * $15,000.00): it is one calendar month *before* the derivation's trailing
 * 12-month window (2025-09-01…2026-08-31, `asOf = 2026-08-31`, per the evidence
 * §4), so if the window ever grew by one month at either edge this fixture
 * would make that visible by two orders of magnitude rather than by a rounding
 * difference nobody would notice.
 *
 * ## Why the budget line is created over HTTP and not by calling `upsertLine`
 *
 * `apps/api/src/routes/budgets.ts`'s own module comment says it directly:
 * `POST /budgets/lines`'s upsert is "not on the context's public surface,
 * re-implemented here against its published `./schema`" — `@ctx/budgeting`
 * deliberately does not export `upsertLine` (`packages/contexts/budgeting/src/index.ts`
 * has no line for it). The composition root's *route* is the only real thing
 * that creates a classified line, so this file calls it exactly the way
 * `apps/api/test/db/budgets-dirty-on-create.test.ts` does. Every other write
 * below — `loadSeedDataset`, `applyProviderTransactions`, `setTransactionOverlay`,
 * `createBudget`, `openPeriod`, `recomputePeriod` — is a function `@ctx/ledger`
 * or `@ctx/budgeting` does export, called directly against the harness's own
 * database exactly as `apps/api/src/domain.ts` and its routes call them.
 */
import { DateOnly, Money, money, newId, systemClock, type Money as MoneyType } from '@core/kernel';
import { generateDemoData } from '@core/seed';
import {
  applyProviderTransactions,
  listAccounts,
  loadSeedDataset,
  setTransactionOverlay,
  type ProviderTransactionInput,
} from '@ctx/ledger';
import { createBudget, openPeriod, recomputePeriod, type BudgetingContext } from '@ctx/budgeting';
import { deriveRevealedBehavior, type DerivedAmount } from '@ctx/planning';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBudgetingLedgerPort, planningRevealedPortsFor } from '../../src/domain.ts';
import {
  createApiHarness,
  expectStatus,
  NO_DATABASE,
  type ApiHarness,
} from '../helpers/api-harness.ts';

/** `@ctx/budgeting`'s D8: opaque, no foreign key — any string identifies a category. */
const RENT_CATEGORY_ID = newId();
const DINING_CATEGORY_ID = newId();
const MISC_CATEGORY_ID = newId();

const WINDOW_ASOF = DateOnly.parse('2026-08-31');
const FIXTURE_FIRST_MONTH = DateOnly.of(2025, 8, 1);
const FIXTURE_MONTH_COUNT = 13; // 2025-08 (planted, out of window) … 2026-08

function fact(
  name: string,
  id: string,
  amountMinor: bigint,
  date: DateOnly,
): ProviderTransactionInput {
  return {
    providerTransactionId: id,
    pendingTransactionId: null,
    amount: money(amountMinor, 'USD'),
    isoCurrency: 'USD',
    postedDate: date,
    authorizedDate: null,
    postedAt: null,
    authorizedAt: null,
    name,
    merchantName: null,
    originalDescription: null,
    paymentChannel: null,
    providerCategory: null,
    pending: false,
    location: null,
    counterparties: null,
    raw: {},
  };
}

describe.skipIf(NO_DATABASE)(
  "WP 4.3's revealed-behaviour ports, over the real ledger and a real budget",
  () => {
    let h: ApiHarness;
    let checkingAccountId: string;
    /**
     * Excluded from the fixture budget below (`createBudget`'s
     * `offBudgetAccountIds`). The seed's credit card has real historic activity
     * and no card-payment envelope of its own; leaving it on-budget makes
     * `POST /budgets/lines`' recompute fail `identityHolds`
     * (`budgeting.card_identity_violation`) on every line write, for a reason
     * that has nothing to do with the three lines this fixture is actually
     * about. Off-budget is also the honest modelling choice: nothing below
     * builds this fixture's own card-payment tracking, so identity II should
     * never be asked about this card at all.
     */
    let creditAccountId: string;

    beforeAll(async () => {
      h = await createApiHarness({ suite: 'wp4wrevealed' });

      const dataset = generateDemoData(1);
      const seeded = await loadSeedDataset(h.database.db, h.userId, dataset, {
        clock: systemClock,
      });
      expect(seeded.accountCount, 'the demo seed always creates 6 accounts').toBe(6);

      const accounts = await listAccounts(h.database.db, {
        userId: h.userId,
        includeClosed: true,
      });
      const checking = accounts.find((a) => a.subtype === 'checking');
      if (checking === undefined) throw new Error('no checking account in the seeded dataset');
      checkingAccountId = checking.id;
      const credit = accounts.find((a) => a.type === 'credit');
      if (credit === undefined) throw new Error('no credit card account in the seeded dataset');
      creditAccountId = credit.id;
    }, 120_000);

    afterAll(async () => {
      await h.close();
    }, 60_000);

    it(
      "planningRevealedPortsFor derives the seed's take-home, taxable contributions and " +
        'savings rate exactly as the evidence walk states, names 14 exclusions, and only ' +
        'derives spending once a real classified budget exists',
      async () => {
        const ports = planningRevealedPortsFor(h.database.db, {
          userId: h.userId,
          timeZone: 'America/New_York',
        });

        // --- 1. Before any budget exists: income/contributions derive, spending does not ---
        const before = await deriveRevealedBehavior(ports, {
          userId: h.userId,
          asOf: WINDOW_ASOF,
          baseCurrency: 'USD',
        });

        expect(before.income.takeHome.status, 'takeHome').toBe('derived');
        if (before.income.takeHome.status !== 'derived') throw new Error('unreachable');
        expect(Money.formatAmount(before.income.takeHome.total)).toBe('80600.00');
        expect(before.income.takeHome.observationCount).toBe(26);

        expect(before.contributions.byBucket.TAXABLE.status, 'TAXABLE contributions').toBe(
          'derived',
        );
        if (before.contributions.byBucket.TAXABLE.status !== 'derived') {
          throw new Error('unreachable');
        }
        expect(Money.formatAmount(before.contributions.byBucket.TAXABLE.total)).toBe('4000.00');
        for (const bucket of ['TAX_DEFERRED', 'ROTH', 'HSA'] as const) {
          expect(before.contributions.byBucket[bucket].status, bucket).toBe('not_derivable');
        }

        expect(before.savingsRate).toMatchObject({ status: 'derived', rate: '0.0496' });

        const incomeExclusionsBefore = before.exclusions.filter((e) => e.derivation === 'income');
        expect(incomeExclusionsBefore.filter((e) => e.reason === 'internal_transfer')).toHaveLength(
          12,
        );
        expect(incomeExclusionsBefore.filter((e) => e.reason === 'refund')).toHaveLength(2);
        expect(incomeExclusionsBefore).toHaveLength(14);
        expect(before.exclusions.filter((e) => e.derivation === 'contributions')).toHaveLength(0);
        expect(before.exclusions.filter((e) => e.derivation === 'spending')).toHaveLength(0);
        expect(before.exclusions).toHaveLength(14);

        // No budget yet: `SpendingReader.listBudgets` is real and returns nothing real.
        expect(before.spending.essential.status, 'no budget yet').toBe('not_derivable');
        expect(before.spending.budgetId).toBeNull();

        // --- 2. Build a real, minimal classified budget over the real ledger -------------
        const context: BudgetingContext = {
          userId: h.userId,
          clock: systemClock,
          correlationId: newId(),
        };
        const budget = await createBudget(h.database.db, context, {
          name: "WP 4.3's revealed-ports fixture",
          currency: 'USD',
          timezone: 'America/New_York',
          offBudgetAccountIds: [creditAccountId],
        });

        const months = Array.from({ length: FIXTURE_MONTH_COUNT }, (_, i) =>
          DateOnly.addMonths(FIXTURE_FIRST_MONTH, i),
        );

        for (const [i, monthStart] of months.entries()) {
          const planted = i === 0; // 2025-08: one month before the window, at 100×.
          const scale = planted ? 100n : 1n;

          const rentId = `wp4w-rent-${monthStart}`;
          const diningId = `wp4w-dining-${monthStart}`;
          const miscId = `wp4w-misc-${monthStart}`;

          const rentResult = await applyProviderTransactions(h.database.db, {
            userId: h.userId,
            accountId: checkingAccountId,
            provider: 'wp4w-revealed-ports-fixture',
            added: [fact('Rent', rentId, -200_000n * scale, DateOnly.addDays(monthStart, 4))],
            clock: systemClock,
            correlationId: context.correlationId,
          });
          const diningResult = await applyProviderTransactions(h.database.db, {
            userId: h.userId,
            accountId: checkingAccountId,
            provider: 'wp4w-revealed-ports-fixture',
            added: [fact('Dining', diningId, -30_000n * scale, DateOnly.addDays(monthStart, 9))],
            clock: systemClock,
            correlationId: context.correlationId,
          });
          const miscResult = await applyProviderTransactions(h.database.db, {
            userId: h.userId,
            accountId: checkingAccountId,
            provider: 'wp4w-revealed-ports-fixture',
            added: [
              fact('Miscellaneous', miscId, -15_000n * scale, DateOnly.addDays(monthStart, 14)),
            ],
            clock: systemClock,
            correlationId: context.correlationId,
          });

          expect(rentResult.addedTransactionIds).toHaveLength(1);
          expect(diningResult.addedTransactionIds).toHaveLength(1);
          expect(miscResult.addedTransactionIds).toHaveLength(1);

          await setTransactionOverlay(
            h.database.db,
            {
              userId: h.userId,
              transactionId: rentResult.addedTransactionIds[0] ?? '',
              patch: { userCategoryId: RENT_CATEGORY_ID },
            },
            context,
          );
          await setTransactionOverlay(
            h.database.db,
            {
              userId: h.userId,
              transactionId: diningResult.addedTransactionIds[0] ?? '',
              patch: { userCategoryId: DINING_CATEGORY_ID },
            },
            context,
          );
          await setTransactionOverlay(
            h.database.db,
            {
              userId: h.userId,
              transactionId: miscResult.addedTransactionIds[0] ?? '',
              patch: { userCategoryId: MISC_CATEGORY_ID },
            },
            context,
          );

          const period = await openPeriod(h.database.db, context, {
            budgetId: budget.id,
            on: monthStart,
          });

          // `upsertLine` is not on `@ctx/budgeting`'s public surface (see the file
          // header) — created here the same way every other line in this app is
          // created, through the real route.
          for (const [categoryId, lineClass] of [
            [RENT_CATEGORY_ID, 'NEED'],
            [DINING_CATEGORY_ID, 'WANT'],
            [MISC_CATEGORY_ID, null],
          ] as const) {
            const created = await h.request({
              method: 'POST',
              url: '/budgets/lines',
              session: h.stale,
              body: { periodId: period.id, categoryId, class: lineClass },
            });
            expectStatus(created, 201);
          }

          await recomputePeriod(
            h.database.db,
            context,
            { port: createBudgetingLedgerPort(h.database.db) },
            period.id,
          );
        }

        // --- 3. Derive again: the identical port composition now reads a real budget -----
        const after = await deriveRevealedBehavior(ports, {
          userId: h.userId,
          asOf: WINDOW_ASOF,
          baseCurrency: 'USD',
        });

        // Take-home, contributions and the savings rate are untouched by the budget.
        expect(after.income.takeHome.status).toBe('derived');
        if (after.income.takeHome.status === 'derived') {
          expect(Money.formatAmount(after.income.takeHome.total)).toBe('80600.00');
        }
        expect(after.savingsRate).toMatchObject({ status: 'derived', rate: '0.0496' });

        expect(after.spending.budgetId).toBe(budget.id);

        const derived = (amount: DerivedAmount): MoneyType => {
          if (amount.status !== 'derived') {
            throw new Error(`expected derived, got ${amount.status}`);
          }
          return amount.total;
        };

        // The 2025-08 period is one month before the window and planted at 100×: reading
        // it would show as roughly $2,024,000.00 rather than $24,000.00, so this
        // assertion is also the proof that the window's edge is exactly where the
        // evidence says it is.
        expect(Money.formatAmount(derived(after.spending.essential))).toBe('24000.00');
        expect(Money.formatAmount(derived(after.spending.discretionary))).toBe('3600.00');
        expect(Money.formatAmount(derived(after.spending.unclassified))).toBe('1800.00');
        expect(Money.formatAmount(derived(after.spending.nonSavings))).toBe('29400.00');

        // Twelve equal months per line: nothing crosses the one-off threshold.
        expect(after.exclusions.filter((e) => e.derivation === 'spending')).toHaveLength(0);
        // Income/contributions are unaffected by the budget existing.
        expect(after.exclusions.filter((e) => e.derivation === 'income')).toHaveLength(14);
        expect(after.exclusions).toHaveLength(14);
      },
      120_000,
    );
  },
);
