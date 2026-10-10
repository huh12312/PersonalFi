// SPDX-License-Identifier: MIT
/**
 * WP 5.13b, carrying Phase 4 gate condition C-6 (G4-7,
 * `docs/evidence/phase-4/gate-security-review.md` §2.5–§2.6, row `EM1`).
 *
 * 07 I5, verbatim: "an employer[-stock tag] is never inferred." G4-7's finding
 * (`EM1`, §2.6): the production composition root's guard —
 * `apps/api/src/domain.ts`, `createInsightsInvestmentsPort`'s
 * `employerStockOf = (securityId) => tagsBySecurity.get(securityId)?.has('employer_stock')
 * ?? false` — was sabotaged to `… || securityId.length > 0` (every holding
 * tagged) and **every suite in the tree stayed green**, for three independent
 * reasons the finding names:
 *
 *   1. the structural test only greps `packages/contexts/investments/src` for
 *      the word "employer" — it cannot see a bug in `apps/api/src/domain.ts`,
 *      a different package;
 *   2. the behavioural twin builds a fresh in-memory tag store `classify()`
 *      never touches — it cannot fail no matter what the composition root
 *      does;
 *   3. every existing fixture that drives the real composition root
 *      (`phase3-advisors.test.ts`'s "I1, I3 and I5 now fire" test) tags the
 *      portfolio's **only** security — with one security, "tagged" and
 *      "everything is tagged" are indistinguishable, so `|| true`-shaped bugs
 *      are invisible.
 *
 * This test closes exactly that gap: it calls the real, unmodified
 * `createInsightsInvestmentsPort(...).holdings(...)` — the same function
 * `phase3-advisors.test.ts` drives, no port double — over a portfolio holding
 * **two** securities, one tagged `employer_stock` and one not, so a guard that
 * has degenerated into "always true" is distinguishable from a guard that
 * reads the tag.
 */
import { DateOnly, newId, systemClock } from '@core/kernel';
import { drizzleSecurityTagsStore } from '@ctx/investments';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInsightsInvestmentsPort } from '../../src/domain.ts';
import {
  NO_DATABASE,
  createApiHarness,
  linkManual,
  type ApiHarness,
} from '../helpers/api-harness.ts';

function isoDay(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

describe.skipIf(NO_DATABASE)(
  "WP 5.13b carry C-6 (G4-7) — an employer-stock tag is never inferred, at the composition root's I5 input",
  () => {
    let h: ApiHarness;
    let brokerageAccountId: string;
    let taggedSecurityId: string;
    let untaggedSecurityId: string;

    async function insertSecurity(input: {
      readonly ticker: string;
      readonly name: string;
    }): Promise<string> {
      const id = newId();
      // fixture: securities row written by SQL because its only writer is the investments sync's SecurityResolver (no route writes it) and this test pins a reader/route over it; the resolver writes this shape (identity_kind 'ticker', identity_key 'ticker:<T>:<user>', classification LOCAL_SEED_TABLE) — the same rows investments-routes.test.ts's header rules on
      await h.database.db.execute(sql`
        INSERT INTO securities (
          id, user_id, identity_kind, identity_key, ticker, name, type, currency,
          is_cash_equivalent, asset_class, region, sector, expense_ratio,
          classification_source, classification_depth, classification_flagged
        ) VALUES (
          ${id}::uuid, ${h.userId}::uuid, 'ticker',
          ${`ticker:${input.ticker}:${h.userId.slice(0, 8)}`},
          ${input.ticker}, ${input.name}, 'equity', 'USD', false,
          'US_EQUITY', 'US', 'BROAD', '0.03',
          'LOCAL_SEED_TABLE', 0, false
        )
      `);
      return id;
    }

    async function insertHolding(input: {
      readonly securityId: string;
      readonly quantity: string;
    }): Promise<void> {
      // fixture: holdings row written by SQL because its only writer is the investments sync (WP 3.7's lot consumer, `upsertHolding`; no route writes it); the sync could write it as a decimal-string quantity on an open account with BROKER/ESTIMATED cost basis, as here
      await h.database.db.execute(sql`
        INSERT INTO holdings (
          id, user_id, account_id, security_id, quantity, institution_value_minor, currency,
          cost_basis_minor, cost_basis_is_user_supplied, cost_basis_source, as_of_date
        ) VALUES (
          ${newId()}::uuid, ${h.userId}::uuid, ${brokerageAccountId}::uuid,
          ${input.securityId}::uuid, ${input.quantity}, 1_000_00, 'USD',
          500_00, false, 'BROKER', ${isoDay(0)}::date
        )
      `);
    }

    async function insertPrice(securityId: string, close: string): Promise<void> {
      // fixture: prices row written by SQL because its only writer is the market-data refresh/price ladder (no route writes it); the ladder writes an observation with source tiingo/coingecko/fred, never last_known (the prices_source_is_an_observation CHECK), as here
      await h.database.db.execute(sql`
        INSERT INTO prices (
          id, user_id, security_id, price_date, source, close, currency, stale, observed_at
        ) VALUES (
          ${newId()}::uuid, ${h.userId}::uuid, ${securityId}::uuid,
          ${isoDay(0)}::date, 'tiingo', ${close}, 'USD', false, now()
        )
      `);
    }

    beforeAll(async () => {
      h = await createApiHarness({ suite: 'wp513b-c6' });

      const linked = await linkManual(h, {
        providerConnectionId: 'wp513b-c6-brokerage',
        displayName: 'C-6 Brokerage',
        accounts: [
          {
            providerAccountId: 'wp513b-c6-taxable',
            name: 'Taxable Brokerage',
            type: 'investment',
            currency: 'USD',
          },
        ],
      });
      brokerageAccountId = linked.accountIds[0] as string;

      // Two securities in the *same* portfolio: the fixture G4-7 says never
      // existed. One is the holder's own employer-stock claim; the other is
      // an ordinary index fund nobody tagged. If the composition root's
      // guard degenerates to "every holding is employer stock" (EM1's exact
      // sabotage), the untagged security's `employerStock` flips to `true`
      // and this test catches it; a single-security fixture could not.
      taggedSecurityId = await insertSecurity({ ticker: 'ACME', name: 'Acme Corp (employer)' });
      untaggedSecurityId = await insertSecurity({
        ticker: 'VTI',
        name: 'Vanguard Total Stock Market ETF',
      });
      await insertHolding({ securityId: taggedSecurityId, quantity: '100.000000000000000000' });
      await insertHolding({ securityId: untaggedSecurityId, quantity: '50.000000000000000000' });
      await insertPrice(taggedSecurityId, '100.00');
      await insertPrice(untaggedSecurityId, '250.00');

      // The holder's own claim, through the real store, the only writer 07
      // I5 permits (`tags.ts`'s own header) — never inferred from the ticker
      // or the name, both of which say nothing about employment here.
      await drizzleSecurityTagsStore(h.database.db, systemClock).set(
        h.userId,
        taggedSecurityId,
        'employer_stock',
      );
    }, 120_000);

    afterAll(async () => {
      await h.close();
    });

    it(
      'the real, unmodified createInsightsInvestmentsPort(...).holdings(...) marks only the tagged security employerStock:true — ' +
        'in both holdings.detail (`positions`) and holdings.aggregate (`aggregate.positions`)',
      async () => {
        const port = createInsightsInvestmentsPort(h.database.db, systemClock);
        const result = await port.holdings({ userId: h.userId, asOf: DateOnly.parse(isoDay(0)) });
        expect(
          result,
          'the portfolio must be valued for this test to mean anything',
        ).not.toBeNull();
        if (result === null) return;

        const tagged = result.positions.find((p) => p.securityId === taggedSecurityId);
        const untagged = result.positions.find((p) => p.securityId === untaggedSecurityId);
        expect(tagged, 'the tagged security must appear in holdings.detail').toBeDefined();
        expect(untagged, 'the untagged security must appear in holdings.detail').toBeDefined();

        expect(tagged?.employerStock, "the holder's own claim is read").toBe(true);
        expect(
          untagged?.employerStock,
          // If `employerStockOf` degenerated to "every holding is employer
          // stock" (EM1's exact sabotage: `… || securityId.length > 0`),
          // this is exactly the field that would flip from `false` to
          // `true` — the untagged security is the one this fixture exists
          // to catch it with.
          'never inferred for a security nobody tagged',
        ).toBe(false);

        // `holdings.aggregate`'s own `positions` (the concentration view) is
        // a second, independent read of the same `employerStockOf` closure —
        // both call sites must agree, and both must answer honestly.
        const aggTagged = result.aggregate.positions.find((p) => p.securityId === taggedSecurityId);
        const aggUntagged = result.aggregate.positions.find(
          (p) => p.securityId === untaggedSecurityId,
        );
        expect(aggTagged?.employerStock).toBe(true);
        expect(aggUntagged?.employerStock).toBe(false);
      },
    );
  },
);
