// SPDX-License-Identifier: MIT
/**
 * The merge rule, proved against the in-memory store — which enforces the same
 * two invariants `0013_securities.sql` does, and is in `src/` so a reviewer
 * cannot substitute a friendlier one. `test/db/` re-runs the load-bearing half
 * against Postgres.
 */
import { fixedClock } from '@core/kernel';
import fc from 'fast-check';
import { beforeEach, describe, expect, it } from 'vitest';
import { createFakeFigiMapper, figiMappingOf, type FigiMapping } from './figi.ts';
import { identifierOf } from './identifiers.ts';
import {
  collectingEventSink,
  createSecurityResolver,
  type ResolveContext,
  type Resolution,
  type ResolvedSecurity,
} from './resolver.ts';
import { inMemorySecurityStore, type InMemorySecurityStore } from './store.ts';

const USER = '01920000-0000-7000-8000-000000000001';
const CLOCK = fixedClock('2026-06-15T02:00:00.000Z');

/** The addresses a wallet or an aggregator uses to mean "the chain's own coin". */
const ETH_NATIVE_SENTINEL = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

function contextFor(provider: string): ResolveContext {
  return { userId: USER, provider, correlationId: '01920000-0000-7000-8000-0000000000c3' };
}

function resolved(resolution: Resolution): ResolvedSecurity {
  if (resolution.outcome !== 'resolved') {
    throw new Error(
      `expected a resolution, got an abstain: ${resolution.abstentions
        .map((entry) => `${entry.tier}=${entry.reason}`)
        .join(', ')}`,
    );
  }
  return resolution;
}

let store: InMemorySecurityStore;
let events: ReturnType<typeof collectingEventSink>;

function resolverWith(figiTable?: Readonly<Record<string, readonly FigiMapping[]>>) {
  return createSecurityResolver({
    store,
    clock: CLOCK,
    events,
    // Spread rather than `figi: undefined`: `exactOptionalPropertyTypes` makes
    // "absent" and "present and undefined" two different things, and the
    // resolver's own default (a mapper that matches nothing) is what the
    // absent case is supposed to exercise.
    ...(figiTable === undefined ? {} : { figi: createFakeFigiMapper({ table: figiTable }) }),
  });
}

beforeEach(() => {
  store = inMemorySecurityStore();
  events = collectingEventSink();
});

describe('SecurityResolver', () => {
  it('ETH as a Coinbase ticker, a chain+contract and a brokerage CUSIP resolve to one securityId', async () => {
    const resolver = resolverWith();

    // 1. Coinbase. A bare ticker with no MIC — and that is not sloppiness:
    //    ISO-10383 registers venues and a chain is not one, so a crypto ticker
    //    can never be qualified the way BHP.XASX can. `NATIVE_ASSETS`
    //    canonicalises it onto ethereum's native sentinel.
    const coinbase = resolved(
      await resolver.resolve(
        {
          identifiers: [identifierOf('ticker', 'ETH')],
          providerSecurityId: 'ETH-USD',
          name: 'Ether',
          type: 'cryptocurrency',
          currency: 'USD',
        },
        contextFor('coinbase'),
      ),
    );
    expect(coinbase.created).toBe(true);

    // 2. A watch-only wallet. The same coin, named as an address on a chain.
    const wallet = resolved(
      await resolver.resolve(
        {
          identifiers: [identifierOf('chain_contract', ETH_NATIVE_SENTINEL, { chain: 'ETH' })],
          providerSecurityId: null,
          name: 'Ether',
          type: 'cryptocurrency',
        },
        contextFor('walletrpc'),
      ),
    );

    // 3. A brokerage that custodies the coin and files the *line* under a
    //    CUSIP, while still telling us what it is. The CUSIP is a stronger
    //    identity than a contract address, so it upgrades the row's
    //    `identity_kind` — and does not change its id, which is the only thing
    //    a holding, a lot or an allocation weight ever points at.
    const brokerage = resolved(
      await resolver.resolve(
        {
          identifiers: [
            identifierOf('cusip', '922908769'),
            identifierOf('ticker', 'ETHEREUM'),
            identifierOf('proprietary', 'sec-eth-0007'),
          ],
          providerSecurityId: 'sec-eth-0007',
          name: 'Ether',
          type: 'cryptocurrency',
        },
        contextFor('plaid'),
      ),
    );

    expect(wallet.securityId).toBe(coinbase.securityId);
    expect(brokerage.securityId).toBe(coinbase.securityId);
    expect(store.rows).toHaveLength(1);

    // The row ends up knowing all of it: the chain it lives on, the CUSIP the
    // brokerage files it under, and the ticker each provider spells its own way.
    const row = store.rows[0];
    expect(row?.chain).toBe('ethereum');
    expect(row?.contract).toBe('native');
    expect(row?.cusip).toBe('922908769');
    expect(row?.identityKind).toBe('cusip');
    expect(row?.assetClass).toBe('CRYPTO');

    // And the provider ids are recorded as evidence, attributed, never as identity.
    const proprietary = store.identifiers.filter((identifier) => identifier.kind === 'proprietary');
    expect(proprietary.map((identifier) => identifier.provider).sort()).toEqual([
      'coinbase',
      'plaid',
    ]);
    expect(events.events).toHaveLength(0);
  });

  it('an unresolvable identifier fails loudly and emits SecurityResolutionFailed rather than minting a row', async () => {
    const resolver = resolverWith();

    const outcome = await resolver.resolve(
      {
        identifiers: [
          identifierOf('proprietary', 'NWSWEEP'),
          // An unqualified ticker and a mistyped CUSIP: two names, neither of
          // which can say which security this is.
          identifierOf('ticker', 'SWEEP'),
          identifierOf('cusip', '922908768'),
        ],
        providerSecurityId: 'sec-cash-0002',
        name: 'Northwind Cash Sweep',
        type: 'cash',
      },
      contextFor('plaid'),
    );

    expect(outcome.outcome).toBe('unresolved');
    expect(store.rows).toHaveLength(0);
    expect(store.identifiers).toHaveLength(0);

    expect(events.events).toHaveLength(1);
    const event = events.events[0];
    expect(event?.eventType).toBe('investments.SecurityResolutionFailed');
    const payload = event?.payload as {
      readonly provider: string;
      readonly providerSecurityId: string | null;
      readonly abstentions: readonly { readonly tier: string; readonly reason: string }[];
    };
    expect(payload.provider).toBe('plaid');
    expect(payload.providerSecurityId).toBe('sec-cash-0002');
    // Every abstain is named, which is what makes this event actionable: the
    // user can be told *why* the position could not be identified.
    const reasons = Object.fromEntries(
      payload.abstentions.map((entry) => [entry.tier, entry.reason]),
    );
    expect(reasons['cusip']).toBe('malformed');
    expect(reasons['ticker']).toBe('unqualified_ticker');
    expect(reasons['proprietary']).toBe('proprietary_is_not_an_identity');
    expect(reasons['figi']).toBe('absent');
  });

  it('two identifiers for one security never create two rows', async () => {
    // A property rather than an example: whatever subset of one security's
    // names each provider happens to volunteer, and in whatever order they
    // sync, the answer is one live row.
    //
    // The generator's one constraint is not a weakening, it is the precondition
    // the claim actually has: **something has to link the names.** A provider
    // that reports only a CUSIP and a second that reports only an ISIN have
    // said nothing that makes those the same security, and inventing the link
    // would be exactly the guess this resolver refuses to make everywhere else.
    // So one sighting — at a position the property chooses, including last,
    // after two disjoint rows already exist — names the security fully, and
    // that is the sighting the merge has to act on.
    const names = [
      identifierOf('figi', 'BBG000BDTF76'),
      identifierOf('isin', 'US9229087690'),
      identifierOf('cusip', '922908769'),
      identifierOf('ticker', 'VTI', { mic: 'XNYS' }),
    ];
    const partial = fc.shuffledSubarray(names, { minLength: 1 });

    await fc.assert(
      fc.asyncProperty(
        fc.array(partial, { minLength: 1, maxLength: 5 }),
        fc.nat(),
        async (subsets, position) => {
          store = inMemorySecurityStore();
          events = collectingEventSink();
          const resolver = resolverWith();
          const sightings = [...subsets];
          sightings.splice(position % (sightings.length + 1), 0, names);

          const ids: string[] = [];
          for (const [index, identifiers] of sightings.entries()) {
            const outcome = await resolver.resolve(
              { identifiers, providerSecurityId: `sec-${String(index)}` },
              contextFor(`provider-${String(index)}`),
            );
            ids.push(resolved(outcome).securityId);
          }

          // Exactly one live row...
          const live = store.rows.filter((row) => row.mergedIntoId === null);
          expect(live).toHaveLength(1);
          // ...and every id ever handed out leads to it. A merge may have
          // happened on the way, which is why the ids are followed through
          // `merged_into_id` rather than compared raw: a caller holding an
          // id from before the merge is never left pointing at nothing.
          const survivorOf = (id: string): string => {
            let current = store.rows.find((row) => row.id === id);
            for (let hops = 0; hops < 8 && current?.mergedIntoId != null; hops += 1) {
              const next: string = current.mergedIntoId;
              current = store.rows.find((row) => row.id === next);
            }
            return current?.id ?? id;
          };
          for (const id of ids) expect(survivorOf(id)).toBe(live[0]?.id);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('WETH and ETH are two securities, because a user can hold both at once', async () => {
    const resolver = resolverWith();
    const eth = resolved(
      await resolver.resolve(identifierOf('ticker', 'ETH'), contextFor('coinbase')),
    );
    const weth = resolved(
      await resolver.resolve(
        identifierOf('chain_contract', WETH, { chain: 'ethereum' }),
        contextFor('walletrpc'),
      ),
    );
    expect(weth.securityId).not.toBe(eth.securityId);
    expect(store.rows).toHaveLength(2);
  });

  it('merges two rows deterministically when a later name proves they are one asset', async () => {
    const resolver = resolverWith();

    // Two providers, two rows: nothing yet says they are the same security.
    const byCusip = resolved(
      await resolver.resolve(identifierOf('cusip', '922908769'), contextFor('brokerage-a')),
    );
    const byFigi = resolved(
      await resolver.resolve(identifierOf('figi', 'BBG000BDTF76'), contextFor('brokerage-b')),
    );
    expect(byFigi.securityId).not.toBe(byCusip.securityId);
    expect(store.rows).toHaveLength(2);

    // A third sighting names both. The FIGI-identified row wins — strongest
    // identity tier — and the CUSIP row is marked merged rather than deleted,
    // so anything already pointing at it can be followed forward.
    const together = resolved(
      await resolver.resolve(
        { identifiers: [identifierOf('figi', 'BBG000BDTF76'), identifierOf('cusip', '922908769')] },
        contextFor('brokerage-a'),
      ),
    );
    expect(together.securityId).toBe(byFigi.securityId);
    expect(together.merged).toEqual([byCusip.securityId]);
    expect(store.rows.find((row) => row.id === byCusip.securityId)?.mergedIntoId).toBe(
      byFigi.securityId,
    );
    // Every name now points at the survivor.
    expect(new Set(store.identifiers.map((identifier) => identifier.securityId))).toEqual(
      new Set([byFigi.securityId]),
    );

    // And a later sighting of the *loser's* name follows the merge forward.
    const afterwards = resolved(
      await resolver.resolve(identifierOf('cusip', '922908769'), contextFor('brokerage-a')),
    );
    expect(afterwards.securityId).toBe(byFigi.securityId);
  });

  it('picks the same winner whichever provider synced first', async () => {
    const outcomes: string[] = [];
    for (const order of [
      ['cusip', 'figi'],
      ['figi', 'cusip'],
    ] as const) {
      store = inMemorySecurityStore();
      events = collectingEventSink();
      const resolver = resolverWith();
      for (const kind of order) {
        await resolver.resolve(
          kind === 'figi'
            ? identifierOf('figi', 'BBG000BDTF76')
            : identifierOf('cusip', '922908769'),
          contextFor(`by-${kind}`),
        );
      }
      const merged = resolved(
        await resolver.resolve(
          {
            identifiers: [identifierOf('figi', 'BBG000BDTF76'), identifierOf('cusip', '922908769')],
          },
          contextFor('both'),
        ),
      );
      const survivor = store.rows.find((row) => row.id === merged.securityId);
      outcomes.push(survivor?.identityKind ?? 'none');
    }
    // The surviving row is identified by its FIGI in both orders. A resolver
    // whose answer depended on sync order would produce a different history on
    // a replay, which is the failure this rule exists to prevent.
    expect(outcomes).toEqual(['figi', 'figi']);
  });

  it('a proprietary id finds a row it corroborated before, and still mints none', async () => {
    const resolver = resolverWith();
    const first = resolved(
      await resolver.resolve(
        {
          identifiers: [identifierOf('cusip', '922908769'), identifierOf('proprietary', 'sec-1')],
          providerSecurityId: 'sec-1',
        },
        contextFor('plaid'),
      ),
    );

    // The next sync of the same position tells us only Plaid's own id — which
    // happens, for a security whose metadata the institution stops filling.
    const again = resolved(
      await resolver.resolve(
        { identifiers: [identifierOf('proprietary', 'sec-1')], providerSecurityId: 'sec-1' },
        contextFor('plaid'),
      ),
    );
    expect(again.securityId).toBe(first.securityId);
    expect(again.created).toBe(false);
    expect(store.rows).toHaveLength(1);

    // A *different* provider's identically-spelled id is not the same name and
    // resolves to nothing, because a proprietary id is scoped to its issuer.
    const elsewhere = await resolver.resolve(
      { identifiers: [identifierOf('proprietary', 'sec-1')], providerSecurityId: 'sec-1' },
      contextFor('coinbase'),
    );
    expect(elsewhere.outcome).toBe('unresolved');
    expect(store.rows).toHaveLength(1);
  });

  it('upgrades a row’s identity when a stronger name arrives, keeping its id', async () => {
    const resolver = resolverWith();
    const first = resolved(
      await resolver.resolve(identifierOf('ticker', 'VTI', { mic: 'XNYS' }), contextFor('csv')),
    );
    expect(store.rows[0]?.identityKind).toBe('ticker');

    const second = resolved(
      await resolver.resolve(
        {
          identifiers: [
            identifierOf('figi', 'BBG000BDTF76'),
            identifierOf('ticker', 'VTI', { mic: 'XNYS' }),
          ],
        },
        contextFor('plaid'),
      ),
    );
    expect(second.securityId).toBe(first.securityId);
    expect(store.rows[0]?.identityKind).toBe('figi');
    expect(store.rows[0]?.figi).toBe('BBG000BDTF76');
  });

  it('never erases a name a weaker provider did not know', async () => {
    const resolver = resolverWith();
    await resolver.resolve(
      {
        identifiers: [
          identifierOf('figi', 'BBG000BDTF76'),
          identifierOf('ticker', 'VTI', { mic: 'XNYS' }),
        ],
      },
      contextFor('plaid'),
    );
    // A CSV import of the same position knows only the ticker. Blanking the
    // FIGI column would undo the upgrade every later sighting depends on.
    await resolver.resolve(identifierOf('ticker', 'VTI', { mic: 'XNYS' }), contextFor('csv'));
    expect(store.rows[0]?.figi).toBe('BBG000BDTF76');
  });

  it('uses a FIGI the mapper supplied to join a CUSIP-only row to a FIGI-named one', async () => {
    const resolver = resolverWith({
      'ID_CUSIP:922908769': [figiMappingOf('BBG000BDTF76', { ticker: 'VTI' })],
    });
    const byFigi = resolved(
      await resolver.resolve(identifierOf('figi', 'BBG000BDTF76'), contextFor('plaid')),
    );
    // 07 §4.3: "Brokerage CSVs frequently give only a CUSIP; without this
    // mapping the whole portfolio module stalls."
    const byCusip = resolved(
      await resolver.resolve(identifierOf('cusip', '922908769'), contextFor('csv')),
    );
    expect(byCusip.securityId).toBe(byFigi.securityId);
    expect(store.rows).toHaveLength(1);
  });

  it('refuses an ambiguous OpenFIGI answer rather than picking one', async () => {
    const resolver = resolverWith({
      // A dual listing: OpenFIGI knows two securities by this ticker, and
      // there is no rule by which one of them is "the" answer.
      'TICKER:BHP': [figiMappingOf('BBG000BH0HY2'), figiMappingOf('BBG000BHW6T1')],
    });
    const outcome = await resolver.resolve(identifierOf('ticker', 'BHP'), contextFor('csv'));
    expect(outcome.outcome).toBe('unresolved');
    expect(store.rows).toHaveLength(0);
  });
});
