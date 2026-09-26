// SPDX-License-Identifier: MIT
/**
 * Phase 3 gate C-2 (G3-14, **HIGH**; `docs/evidence/phase-3/gate-security-review.md`
 * §3.15, §6): a funded watch-only wallet must produce a holding — quantity
 * plus a resolved `security_id` — valued downstream by WP 3.4's price
 * ladder, never `DATA_UNAVAILABLE` on every sync.
 *
 * **Reproduced red first.** Before this condition's fix,
 * `WalletRpcConnector.syncHoldings` threw `DATA_UNAVAILABLE` for any
 * non-zero balance (see `git log -p` on `packages/connectors/walletrpc/src/connector.ts`
 * for the exact diff, and `docs/evidence/phase-4/wp4.12a-gate-conditions.md`
 * C-2 for the reproduction transcript), so step 1 below threw instead of
 * returning a fact and every assertion after it was unreachable. This file
 * is the permanent regression the gate's own temporary
 * `apps/api/test/db/gate3-eth-one-row.test.ts` (deleted, never committed)
 * stood in for.
 *
 * This test does not go through the job queue or an HTTP sync — that would
 * need a live Etherscan key and a live Coinbase key, neither available on
 * this host (the gate's own §3.7/§3.15 walk hit the identical wall). Instead
 * it drives the real `WalletRpcConnector` over its hermetic Etherscan fake
 * (`@connector/walletrpc/test`), builds a Coinbase-shaped
 * `ProviderSecurityFact` for the same asset the way `@connector/coinbase`'s
 * own mapper would (`securityFactOf`, its production export), and resolves
 * both through the real `securityResolverFor` (`apps/api/src/domain.ts`)
 * over a real scratch database — the same three steps
 * `apps/api/src/domain.ts`'s `resolveRunFacts` performs inside a sync,
 * assembled directly so the test needs no job runner. The holding is then
 * written with the real `drizzleLotStore` and valued with the real
 * `valueHoldings`/`priceReaderFor` — the same functions `GET /holdings` and
 * `GET /investments/allocation` call.
 */
import { securityFactOf as coinbaseSecurityFactOf } from '@connector/coinbase';
import { handleFor as walletHandleFor, harness as walletHarness } from '@connector/walletrpc/test';
import { DateOnly, fixedClock, minorUnitScale, newId } from '@core/kernel';
import { createTestDatabase, type TestDatabase } from '@core/testkit';
import { drizzleLotStore, holdingOf, valueHoldings } from '@ctx/investments';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { securityResolverFor } from '../../src/domain.ts';
import {
  BASE_CURRENCY,
  priceHoldings,
  priceReaderFor,
  readHoldings,
} from '../../src/routes/investments.ts';
import { NO_DATABASE } from '../helpers/api-harness.ts';

const ETH_ADDRESS = '0x00000000219ab540356cbb839cbe05303d7705fa';
const OBSERVED_AT = '2026-09-26T12:00:00.000Z';
const AS_OF_DATE = '2026-09-26';
const ETH_PRICE = '2500.0000000000';

describe.skipIf(NO_DATABASE)(
  'a funded watch-only wallet becomes a holding, valued by the price ladder (Phase 3 gate C-2)',
  () => {
    let database: TestDatabase;
    let userId: string;

    beforeAll(async () => {
      database = await createTestDatabase('personalfi_wp412a_wallet_valuation');
      userId = database.userId;
    }, 60_000);

    afterAll(async () => {
      await database.drop();
    });

    it(
      'a Coinbase ETH sighting and a funded wallet ETH sighting resolve to one securities row, ' +
        'and the wallet holding is a non-zero position valued from a seeded price, never DATA_UNAVAILABLE',
      async () => {
        const clock = fixedClock(OBSERVED_AT);

        // 1. The real WalletRpcConnector over its hermetic Etherscan fake — a
        //    non-zero balance, the exact shape G3-14 found unpriceable.
        const { connector, syncOptions } = walletHarness({
          etherscan: { balances: new Map([[ETH_ADDRESS, '2050000000000000000']]) }, // 2.05 ETH
        });
        const handle = walletHandleFor(
          await connector.connect({ chain: 'ethereum', value: ETH_ADDRESS }),
        );
        const walletHoldings = await connector.syncHoldings(handle, syncOptions);
        expect(walletHoldings).toHaveLength(1);
        const walletFact = walletHoldings[0]!;
        // No fiat quote from this connector — see connector.ts's header (C-2).
        expect(walletFact.value).toBeNull();
        // `formatUnits` (units.ts) trims trailing zeros; the `NUMERIC(38,18)`
        // column pads them back on the way out — see the assertion on
        // `holdingRead?.quantity` below, after the round trip.
        expect(walletFact.quantity).toBe('2.05');

        // 2. Coinbase's own ETH sighting — a bare ticker, the shape that only
        //    merges with the wallet's chain_contract via NATIVE_ASSETS.
        const coinbaseFact = coinbaseSecurityFactOf('ETH', '2500.00');

        // 3. Both through the real resolver, over the scratch database — the
        //    same call `resolveRunFacts` (apps/api/src/domain.ts) makes.
        const resolver = securityResolverFor(database.db, clock);
        const context = { userId, provider: 'wp412a-gate-c2-test' };
        const [coinbaseResolution, walletResolution] = await resolver.resolveAll(
          [coinbaseFact, walletFact.security],
          context,
        );
        expect(coinbaseResolution?.outcome).toBe('resolved');
        expect(walletResolution?.outcome).toBe('resolved');
        const coinbaseSecurityId =
          coinbaseResolution?.outcome === 'resolved' ? coinbaseResolution.securityId : null;
        const walletSecurityId =
          walletResolution?.outcome === 'resolved' ? walletResolution.securityId : null;
        expect(walletSecurityId).not.toBeNull();
        expect(walletSecurityId, 'one securities row shared with the Coinbase ETH fact').toBe(
          coinbaseSecurityId,
        );

        const securityRows = await database.db.execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM securities WHERE user_id = ${userId}::uuid
        `);
        expect(securityRows.rows[0]?.n).toBe(1);

        // 4. Write the wallet holding the way the lot consumer would, and
        //    seed a price the way WP 3.4's ladder would.
        const store = drizzleLotStore(database.db, clock);
        await store.upsertHolding(
          userId,
          holdingOf(walletFact, {
            accountId: newId(),
            securityId: walletSecurityId!,
            asOfDate: DateOnly.parse(AS_OF_DATE),
          }),
          { id: newId() },
        );

        await database.db.execute(sql`
          INSERT INTO prices (
            id, user_id, security_id, price_date, source, close, currency, observed_at
          ) VALUES (
            ${newId()}::uuid, ${userId}::uuid, ${walletSecurityId}::uuid, ${AS_OF_DATE}::date,
            'coingecko', ${ETH_PRICE}, 'USD', ${OBSERVED_AT}::timestamptz
          )
        `);

        // 5. Valued downstream by the ladder — never by the fact's own (null)
        //    value, and never DATA_UNAVAILABLE.
        const reads = await readHoldings(database.db, userId, null);
        const holdingRead = reads.find((row) => row.securityId === walletSecurityId);
        expect(holdingRead, 'the wallet position reached readHoldings').toBeDefined();
        expect(holdingRead?.quantity).toBe('2.050000000000000000');

        const kindOf = new Map<string, string>([[walletSecurityId!, 'crypto']]);
        const reader = priceReaderFor(database.db, userId, clock, kindOf);
        const priced = await priceHoldings(reads, reader, AS_OF_DATE);
        const analyticsHolding = priced.holdings.find((row) => row.securityId === walletSecurityId);
        expect(analyticsHolding?.price).not.toBeNull();
        expect(analyticsHolding?.staleness).toBe('FRESH');

        const valuation = valueHoldings(priced.holdings, {
          currency: BASE_CURRENCY,
          scale: minorUnitScale(BASE_CURRENCY),
          basis: 'as_of_now',
        });
        expect(valuation.excluded).toHaveLength(0);
        const valuedWalletHolding = valuation.valued.find(
          (entry) => entry.holding.securityId === walletSecurityId,
        );
        expect(valuedWalletHolding, 'the wallet holding was valued, not excluded').toBeDefined();
        // 2.05 ETH x $2,500.00 = $5,125.00 — a real, non-zero market value,
        // computed by the price ladder and never by the connector's own
        // (null) `institutionValue`.
        expect(valuedWalletHolding?.marketValue.minor).toBe(512_500n);
        expect(valuedWalletHolding?.marketValue.currency).toBe(BASE_CURRENCY);
      },
    );
  },
);
