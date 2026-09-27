// SPDX-License-Identifier: MIT
/**
 * Phase 3 gate C-3 (G3-3, MEDIUM; `docs/evidence/phase-3/gate-security-review.md`
 * §6; v0.5 rung, `03-phase-3-dispatch.md` §1): "a USD deposit into Coinbase
 * followed by a BTC buy is one transfer plus one trade, never $5,000 of
 * spending in a 'Crypto' category." `packages/connectors/coinbase/test/onramp.test.ts`
 * proves the *connector* half — the deposit leaves `syncTransactions()` with
 * `providerCategory: COINBASE_TRANSFER_IN_PFC` (`TRANSFER_IN_ACCOUNT_TRANSFER`)
 * and the BTC buy never becomes a ledger transaction at all. This file drives
 * that same PFC object through the real orchestrator, the real categorization
 * consumer and `apps/api/src/reports/spending-income.ts`'s real aggregation —
 * the "through the orchestrator, categorisation and reports' spending
 * aggregation" half the condition names — and records what was actually
 * found, which is **not** what the condition's own text predicted.
 *
 * ## What running it found (this WP's ownership is `pfc-map.ts` alone; read
 * first, per the brief — everything below that is not `pfc-map.ts` is a
 * finding for the orchestrator, not a fix made here)
 *
 * `packages/contexts/categorization/src/pfc-map.ts` maps
 * `TRANSFER_IN_ACCOUNT_TRANSFER` (and `TRANSFER_OUT_ACCOUNT_TRANSFER`) to
 * `transfers.between_accounts`, a `kind: 'transfer'` leaf — **already
 * correct**, both directions, no change needed here.
 *
 * But that mapping turns out not to be what protects the deposit from
 * spending. `packages/contexts/categorization/src/service.ts`'s
 * `categorizeTransactions` (the consumer `worker.ts` actually runs) persists
 * only a **tier-2 (rule)** decision into `@ctx/ledger`'s effective category —
 * its own comment: "every other source (merchant_default, provider,
 * classifier, none) is a tier ledger has no column for — it stays entirely in
 * this context's own `category_assignments`". A provider-category (tier 4)
 * match, which is what an on-ramp deposit with no rule gets, is **never
 * auto-applied**: it sits in `category_assignments` for `pending_review`, and
 * the transaction's effective `categoryId` stays `null`.
 *
 * `apps/api/src/reports/spending-income.ts`'s `spendingRowsOf` treats a
 * `categoryId: null` cell as spending only when its amount is **not**
 * positive (`!Money.isPositive(amount)`). An inflow with no category —
 * exactly what an unpaired on-ramp deposit is, today — is therefore excluded
 * from spending **by that rule**, not by `pfc-map.ts`'s mapping ever reaching
 * the ledger. Sabotaging `pfc-map.ts` directly (`TRANSFER_IN_ACCOUNT_TRANSFER`
 * → `dining.restaurants`, reproducing S-CB5b against the real, unmodified
 * pipeline below) left the deposit's spending contribution **unchanged**: the
 * mapping the gate's own sabotage targets is not, in the current
 * architecture, load-bearing for this claim. This is `personalfi-gate-lessons`'s
 * own pattern once more — a control believed to gate an outcome, that a real
 * run shows does not.
 *
 * The `null`-and-positive exclusion is a coincidence of sign, not a transfer
 * rule, and the companion test below (`characterises the matching outflow
 * leg`) shows the coincidence does not hold in the other direction: an
 * unpaired, uncategorised **outflow** (the bank-side leg funding the on-ramp,
 * before `POST /transfers/pair` ever runs) is counted as spending today. This
 * is the real residual risk C-3 leaves open — recorded precisely in this WP's
 * evidence for 4.12c, not fixed here: the fix belongs in `@ctx/budgeting`'s
 * `computeActuals` or `apps/api/src/reports/spending-income.ts`
 * (`kind: 'transfer'` categories excluded structurally, the way `kind:
 * 'income'` already is), neither of which this WP's brief grants — its one
 * categorization/recurring file is `pfc-map.ts`, already correct.
 */
import { DateOnly, DateOnly as DateOnlyType, money, systemClock } from '@core/kernel';
import { createConsumerPump, platformExecutor } from '@core/platform';
import { COINBASE_TRANSFER_IN_PFC } from '@connector/coinbase';
import { manualTransaction, type ManualTransactionInput } from '@connector/manual';
import { listCategories, matchProviderCategory } from '@ctx/categorization';
import { createEgressPolicy, createNtfyChannel, createSmtpChannel } from '@ctx/notifications';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeCategoryMonthActivity, spendingRowsOf } from '../../src/reports/spending-income.ts';
import {
  createConnectorRegistry,
  createDomainRuntime,
  createInvestmentSyncPort,
} from '../../src/domain.ts';
import { appModules } from '../../src/modules.ts';
import {
  createApiHarness,
  linkManual,
  NO_DATABASE,
  type ApiHarness,
} from '../helpers/api-harness.ts';

const DEPOSIT_DATE = '2026-09-10';
const OUTFLOW_DATE = '2026-08-10'; // a different month from DEPOSIT_DATE — see categorizeAndAggregate's header
const LEG_MINOR = 500_000n; // $5,000.00, this gate's own live-walk figure (§3.12)

/**
 * A `ProviderTransactionFact` carrying the connector's real, un-retyped PFC
 * object. `manualTransaction` always writes `providerCategory: null` — the
 * Manual connector has no PFC source of its own — so the override is what
 * stands in for "the Coinbase connector's fixture" (or, for the outflow
 * test, a bank connector's) without instantiating either connector class:
 * `onramp.test.ts` already proves the Coinbase connector produces this exact
 * object; this file's claim is what happens to it downstream.
 */
function factWithProviderCategory(
  input: ManualTransactionInput,
  providerCategory: { primary: string; detailed: string; confidence_level: string },
) {
  return { ...manualTransaction(input), providerCategory };
}

/**
 * Real orchestrator, real categorization consumer, real reports aggregation —
 * every call this file drives a transaction through, scoped to one calendar
 * month at a time. Each `it` below uses its own month: `computeCategoryMonthActivity`
 * nets every row sharing `(month, categoryId, currency)` into one cell, and
 * this suite's `h` is shared (`beforeAll`, not `beforeEach`) across the whole
 * describe block on purpose — matching a real account's history, where every
 * transaction lives in the same ledger — so a same-month, same-null-category
 * deposit and outflow from two different `it`s would net against each other
 * and hide the very leak the second test exists to characterise.
 */
async function categorizeAndAggregate(
  h: ApiHarness,
  month: { readonly from: string; readonly to: string },
): Promise<{
  spending: Awaited<ReturnType<typeof computeCategoryMonthActivity>>;
}> {
  const logger = pino({ level: 'silent' });
  const runtime = createDomainRuntime({
    database: h.database.db,
    clock: systemClock,
    logger,
    registry: createConnectorRegistry(),
    secretBox: h.security.requireSecretBox(),
  });
  const egressPolicy = createEgressPolicy({ allowedHosts: [] });
  const modules = appModules({
    database: h.database.db,
    userId: h.userId,
    orchestrator: runtime.orchestrator,
    timezone: 'UTC',
    clock: systemClock,
    notificationChannels: {
      ntfy: createNtfyChannel({ policy: egressPolicy }),
      smtp: createSmtpChannel({ policy: egressPolicy }),
    },
    secretBox: h.security.requireSecretBox(),
    investmentSyncPort: createInvestmentSyncPort(h.database.db),
  });
  const categorization = modules.find((module) => module.flagKey === 'module.categorization');
  const pump = createConsumerPump({
    pool: h.database.pool,
    db: platformExecutor(h.database.db),
    clock: systemClock,
    logger,
    consumers: categorization?.consumers ?? [],
  });
  await pump.drain();

  const categories = await listCategories(h.database.db, h.userId, {});
  const incomeIds = new Set(
    categories.filter((category) => category.kind === 'income').map((category) => category.id),
  );
  const cells = await computeCategoryMonthActivity(h.database.db, {
    userId: h.userId,
    dateFrom: DateOnlyType.parse(month.from),
    dateTo: DateOnlyType.parse(month.to),
  });
  return { spending: spendingRowsOf(cells, incomeIds) };
}

describe.skipIf(NO_DATABASE)(
  'the fiat on-ramp, through the real orchestrator, categorisation and reports aggregation ' +
    '(Phase 3 gate C-3)',
  () => {
    let h: ApiHarness;

    beforeAll(async () => {
      h = await createApiHarness({ suite: 'wp412bc3onramp' });
    });

    afterAll(async () => {
      await h.close();
    }, 60_000);

    it(
      "a $5,000 USD on-ramp deposit — the connector's real PFC object, no rule written for it — " +
        'contributes zero to the spending report for its month',
      async () => {
        await linkManual(h, {
          providerConnectionId: 'onramp-conn',
          displayName: 'Coinbase',
          accounts: [
            {
              providerAccountId: 'usd-wallet',
              name: 'USD Wallet',
              type: 'depository',
              currency: 'USD',
            },
          ],
          batch: {
            added: [
              factWithProviderCategory(
                {
                  providerAccountId: 'usd-wallet',
                  providerTransactionId: 'onramp-deposit-1',
                  amount: money(LEG_MINOR, 'USD'),
                  postedDate: DateOnly.parse(DEPOSIT_DATE),
                  name: 'Coinbase on-ramp deposit',
                },
                COINBASE_TRANSFER_IN_PFC,
              ),
            ],
          },
        });

        const { spending } = await categorizeAndAggregate(h, {
          from: '2026-09-01',
          to: '2026-09-30',
        });
        const total = spending.reduce((sum, cell) => sum + cell.amount.minor, 0n);
        expect(total, 'the on-ramp deposit must contribute zero to spending').toBe(0n);
      },
      60_000,
    );

    it(
      'characterises the matching outflow leg: an unpaired bank-side TRANSFER_OUT with the same ' +
        'PFC shape is NOT excluded today (the residual risk this WP records for 4.12c, not fixed ' +
        'here — see the file header)',
      async () => {
        await linkManual(h, {
          providerConnectionId: 'onramp-outflow-conn',
          displayName: 'Bank',
          accounts: [
            {
              providerAccountId: 'bank-checking',
              name: 'Checking',
              type: 'depository',
              currency: 'USD',
            },
          ],
          batch: {
            added: [
              factWithProviderCategory(
                {
                  providerAccountId: 'bank-checking',
                  providerTransactionId: 'onramp-outflow-1',
                  amount: money(-LEG_MINOR, 'USD'),
                  postedDate: DateOnly.parse(OUTFLOW_DATE),
                  name: 'Transfer to Coinbase',
                },
                {
                  primary: 'TRANSFER_OUT',
                  detailed: 'TRANSFER_OUT_ACCOUNT_TRANSFER',
                  confidence_level: 'LOW',
                },
              ),
            ],
          },
        });

        const { spending } = await categorizeAndAggregate(h, {
          from: '2026-08-01',
          to: '2026-08-31',
        });
        const total = spending.reduce((sum, cell) => sum + cell.amount.minor, 0n);
        // This is the CURRENT, verified behaviour, not the desired one — see
        // the file header's "residual risk" paragraph. If `@ctx/budgeting` or
        // `apps/api/src/reports/spending-income.ts` is later changed to
        // exclude `kind: 'transfer'` categories structurally (the fix this WP
        // names but does not make), this assertion becomes `toBe(0n)` and its
        // own comment is the signal that the gap closed.
        expect(
          total,
          'CURRENTLY (not desired): an unpaired, uncategorised transfer-shaped outflow is counted ' +
            'as spending. If this now reads 0n, the gap this test documents has closed — update the ' +
            'comment and evidence, do not just delete the assertion.',
        ).toBe(-LEG_MINOR);
      },
      60_000,
    );

    it('pfc-map.ts maps both on-ramp PFC codes to a transfer-kind leaf, sabotage-tested against the real map', async () => {
      const inMatch = matchProviderCategory({
        primary: COINBASE_TRANSFER_IN_PFC.primary,
        detailed: COINBASE_TRANSFER_IN_PFC.detailed,
        confidenceLevel: COINBASE_TRANSFER_IN_PFC.confidence_level,
      });
      expect(inMatch?.categoryKey).toBe('transfers.between_accounts');

      const outMatch = matchProviderCategory({
        primary: 'TRANSFER_OUT',
        detailed: 'TRANSFER_OUT_ACCOUNT_TRANSFER',
        confidenceLevel: 'LOW',
      });
      expect(outMatch?.categoryKey).toBe('transfers.between_accounts');

      const categories = await listCategories(h.database.db, h.userId, {});
      const transferCategory = categories.find(
        (category) => category.key === 'transfers.between_accounts',
      );
      expect(transferCategory?.kind).toBe('transfer');
    });
  },
);
