// SPDX-License-Identifier: MIT
/**
 * D29 — the USD bare-ticker OpenFIGI tier (WP 10.5, defect (g) of WP 10.4).
 *
 * WP 3.1's rule is that a bare ticker never establishes a security, and it
 * still does not: what establishes one here is the composite FIGI OpenFIGI
 * answered for `TICKER <symbol>` with `exchCode: US`, accepted only when every
 * mapping in the answer names the same composite. Only a fact with no stronger
 * identity, a bare ticker, currency USD and an equity / ETF / mutual-fund type
 * is ever asked; anything else is never sent and abstains as before.
 *
 * In-memory store and the hermetic fake mapper; no network.
 */
import { fixedClock } from '@core/kernel';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  US_COMPOSITE_FIGI_CONFIDENCE,
  US_COMPOSITE_FIGI_PROVIDER,
  createFakeFigiMapper,
  figiMappingOf,
  figiTableKeyOf,
  usCompositeJobOf,
  usCompositeVerdictOf,
  type FakeFigiMapper,
  type FigiMapping,
} from '../src/figi.ts';
import { identifierOf } from '../src/identifiers.ts';
import {
  collectingEventSink,
  createSecurityResolver,
  type ResolvableSecurity,
  type Resolution,
  type ResolveContext,
} from '../src/resolver.ts';
import { inMemorySecurityStore, type InMemorySecurityStore } from '../src/store.ts';

const USER = '01920000-0000-7000-8000-000000000001';
const CLOCK = fixedClock('2026-06-15T02:00:00.000Z');
const CONTEXT: ResolveContext = {
  userId: USER,
  provider: 'plaid',
  correlationId: '01920000-0000-7000-8000-0000000000c3',
};

/** VTI's US composite FIGI, and two of its venue-level lines. */
const VTI_COMPOSITE = 'BBG000BDTF76';
const VTI_LINES: readonly FigiMapping[] = [
  figiMappingOf('BBG000BDTF76', { ticker: 'VTI', exchCode: 'US', compositeFigi: VTI_COMPOSITE }),
  figiMappingOf('BBG000BDTG11', { ticker: 'VTI', exchCode: 'UP', compositeFigi: VTI_COMPOSITE }),
];

/** A Plaid-shaped VTI: bare ticker, no FIGI/ISIN/CUSIP/MIC, Plaid's own id beside it. */
function bareVti(overrides: Partial<ResolvableSecurity> = {}): ResolvableSecurity {
  return {
    identifiers: [identifierOf('ticker', 'VTI')],
    providerSecurityId: 'sec-vti-0001',
    name: 'Vanguard Total Stock Market ETF',
    type: 'etf',
    currency: 'USD',
    isCashEquivalent: false,
    ...overrides,
  };
}

let store: InMemorySecurityStore;
let events: ReturnType<typeof collectingEventSink>;
let mapper: FakeFigiMapper;

function resolverWith(table: Readonly<Record<string, readonly FigiMapping[]>> = {}, errors = {}) {
  mapper = createFakeFigiMapper({ table, errors });
  return createSecurityResolver({ store, clock: CLOCK, events, figi: mapper });
}

function tickerReasonOf(resolution: Resolution): string | undefined {
  return resolution.abstentions.find((entry) => entry.tier === 'ticker')?.reason;
}

beforeEach(() => {
  store = inMemorySecurityStore();
  events = collectingEventSink();
});

describe('D29 — a bare USD ticker is asked about under exchCode US', () => {
  it('a USD ETF bare ticker with one composite FIGI resolves on tier figi, with OpenFIGI’s provenance', async () => {
    const resolver = resolverWith({ 'TICKER:VTI/US': VTI_LINES });
    const resolution = await resolver.resolve(bareVti(), CONTEXT);

    expect(resolution.outcome).toBe('resolved');
    if (resolution.outcome !== 'resolved') return;
    expect(resolution.created).toBe(true);
    expect(resolution.identity.kind).toBe('figi');
    expect(resolution.identity.value).toBe(VTI_COMPOSITE);
    expect(resolution.identity.provider).toBe(US_COMPOSITE_FIGI_PROVIDER);

    const security = await store.getSecurity(USER, resolution.securityId);
    expect(security?.identityKind).toBe('figi');
    expect(security?.figi).toBe(VTI_COMPOSITE);
    expect(security?.ticker).toBe('VTI');
    expect(security?.mic).toBeNull();
    expect(security?.type).toBe('etf');

    // Provenance: the derived FIGI says who answered and how sure we are; the
    // bare ticker stays on as the evidence it was asked from, at its own
    // unqualified confidence, attributed to the connector that said it.
    const rows = store.identifiers.filter((row) => row.securityId === resolution.securityId);
    const figiRow = rows.find((row) => row.kind === 'figi');
    expect(figiRow).toMatchObject({
      value: VTI_COMPOSITE,
      provider: US_COMPOSITE_FIGI_PROVIDER,
      confidence: US_COMPOSITE_FIGI_CONFIDENCE,
    });
    expect(Number(US_COMPOSITE_FIGI_CONFIDENCE)).toBeLessThan(1);
    expect(rows.find((row) => row.kind === 'ticker')).toMatchObject({
      value: 'VTI',
      mic: null,
      provider: 'plaid',
      confidence: '0.3000',
    });
    expect(rows.find((row) => row.kind === 'proprietary')?.value).toBe('sec-vti-0001');
    expect(events.events).toHaveLength(0);
  });

  it('the job is TICKER with exchCode US and no micCode, in the one batched pass', async () => {
    const resolver = resolverWith({ 'TICKER:VTI/US': VTI_LINES });
    await resolver.resolveAll(
      [
        bareVti(),
        bareVti({
          identifiers: [identifierOf('ticker', 'AAPL')],
          providerSecurityId: 'sec-aapl',
          type: 'equity',
        }),
        { identifiers: [identifierOf('isin', 'US0378331005')], currency: 'USD', type: 'equity' },
      ],
      CONTEXT,
    );
    expect(mapper.requests).toHaveLength(1);
    const jobs = mapper.requests.flat();
    expect(jobs).toEqual([
      { idType: 'TICKER', idValue: 'VTI', micCode: null, exchCode: 'US' },
      { idType: 'TICKER', idValue: 'AAPL', micCode: null, exchCode: 'US' },
      { idType: 'ID_ISIN', idValue: 'US0378331005', micCode: null },
    ]);
    expect(figiTableKeyOf(usCompositeJobOf('vti'))).toBe('TICKER:VTI/US');
  });

  it('two composites abstain ambiguous_us_ticker and mint nothing', async () => {
    const resolver = resolverWith({
      'TICKER:VTI/US': [
        figiMappingOf('BBG000BDTF76', { compositeFigi: 'BBG000BDTF76' }),
        figiMappingOf('BBG000BHTMY2', { compositeFigi: 'BBG000BHTMY2' }),
      ],
    });
    const resolution = await resolver.resolve(bareVti(), CONTEXT);
    expect(resolution.outcome).toBe('unresolved');
    expect(tickerReasonOf(resolution)).toBe('ambiguous_us_ticker');
    expect(resolution.abstentions.find((entry) => entry.tier === 'ticker')?.detail).toBe('VTI');
    expect(store.rows.length).toBe(0);
    expect(events.events).toHaveLength(1);
  });

  it('a mapping without a composite FIGI counts as ambiguous, not as agreement', async () => {
    const resolver = resolverWith({
      'TICKER:VTI/US': [
        figiMappingOf('BBG000BDTF76', { compositeFigi: VTI_COMPOSITE }),
        figiMappingOf('BBG000BDTG11'),
      ],
    });
    const resolution = await resolver.resolve(bareVti(), CONTEXT);
    expect(resolution.outcome).toBe('unresolved');
    expect(tickerReasonOf(resolution)).toBe('ambiguous_us_ticker');
    expect(store.rows.length).toBe(0);
  });

  it('no_match abstains no_us_match', async () => {
    const resolver = resolverWith({});
    const resolution = await resolver.resolve(bareVti(), CONTEXT);
    expect(resolution.outcome).toBe('unresolved');
    expect(tickerReasonOf(resolution)).toBe('no_us_match');
    expect(store.rows.length).toBe(0);
    expect(mapper.requests.flat()).toHaveLength(1);
  });

  it('a transient error abstains us_ticker_not_checked — a fact about the call, never about the ticker', async () => {
    const resolver = resolverWith({ 'TICKER:VTI/US': VTI_LINES }, { 'TICKER:VTI/US': 'HTTP 503' });
    const resolution = await resolver.resolve(bareVti(), CONTEXT);
    expect(resolution.outcome).toBe('unresolved');
    expect(tickerReasonOf(resolution)).toBe('us_ticker_not_checked');
    expect(resolution.abstentions.map((entry) => entry.reason)).not.toContain('no_us_match');
    expect(store.rows.length).toBe(0);
    expect(store.identifiers).toHaveLength(0);
  });

  it('a non-USD bare ticker is never sent, and stays unqualified_ticker', async () => {
    const resolver = resolverWith({ 'TICKER:VTI/US': VTI_LINES });
    const outcomes = await resolver.resolveAll(
      [
        bareVti({ currency: 'CAD' }),
        bareVti({ currency: null, providerSecurityId: 'sec-vti-null' }),
        bareVti({ currency: '', providerSecurityId: 'sec-vti-blank' }),
      ],
      CONTEXT,
    );
    expect(mapper.requests).toHaveLength(0);
    for (const outcome of outcomes) {
      expect(outcome.outcome).toBe('unresolved');
      expect(tickerReasonOf(outcome)).toBe('unqualified_ticker');
    }
    expect(store.rows.length).toBe(0);
  });

  it('a bare ticker whose type is not equity, ETF or mutual fund is never sent', async () => {
    const resolver = resolverWith({ 'TICKER:VTI/US': VTI_LINES });
    const outcomes = await resolver.resolveAll(
      [
        bareVti({ type: 'other' }),
        bareVti({ type: null, providerSecurityId: 'sec-vti-untyped' }),
        bareVti({ type: 'cash', providerSecurityId: 'sec-vti-cash' }),
        bareVti({ type: 'fixed income', providerSecurityId: 'sec-vti-bond' }),
        bareVti({ type: 'derivative', providerSecurityId: 'sec-vti-option' }),
      ],
      CONTEXT,
    );
    expect(mapper.requests).toHaveLength(0);
    for (const outcome of outcomes) {
      expect(outcome.outcome).toBe('unresolved');
      expect(tickerReasonOf(outcome)).toBe('unqualified_ticker');
    }
  });

  it('equity and mutual-fund types are sent like an ETF', async () => {
    const resolver = resolverWith({
      'TICKER:AAPL/US': [figiMappingOf('BBG000B9Y5X2', { compositeFigi: 'BBG000B9XRY4' })],
      'TICKER:VFIFX/US': [figiMappingOf('BBG000BGVQ34', { compositeFigi: 'BBG000BGVQ34' })],
    });
    const [aapl, vfifx] = await resolver.resolveAll(
      [
        bareVti({
          identifiers: [identifierOf('ticker', 'AAPL')],
          providerSecurityId: 'sec-aapl',
          type: 'equity',
        }),
        bareVti({
          identifiers: [identifierOf('ticker', 'VFIFX')],
          providerSecurityId: 'sec-vfifx',
          type: 'mutual fund',
        }),
      ],
      CONTEXT,
    );
    expect(aapl?.outcome === 'resolved' ? aapl.identity.value : null).toBe('BBG000B9XRY4');
    expect(vfifx?.outcome === 'resolved' ? vfifx.identity.value : null).toBe('BBG000BGVQ34');
  });

  it('a fact with an ISIN goes through the ISIN job, never the US-ticker job', async () => {
    const resolver = resolverWith({
      'TICKER:VTI/US': [figiMappingOf('BBG000BHTMY2', { compositeFigi: 'BBG000BHTMY2' })],
    });
    const resolution = await resolver.resolve(
      bareVti({
        identifiers: [identifierOf('isin', 'US9229087690'), identifierOf('ticker', 'VTI')],
      }),
      CONTEXT,
    );
    expect(mapper.requests.flat()).toEqual([
      { idType: 'ID_ISIN', idValue: 'US9229087690', micCode: null },
    ]);
    // ISIN no_match: the ISIN still establishes the row, as before D29.
    expect(resolution.outcome === 'resolved' ? resolution.identity.kind : null).toBe('isin');
  });

  it('a MIC-qualified ticker keeps its own job and is never asked under exchCode US', async () => {
    const resolver = resolverWith({});
    await resolver.resolve(
      bareVti({ identifiers: [identifierOf('ticker', 'VTI', { mic: 'XNYS' })] }),
      CONTEXT,
    );
    expect(mapper.requests.flat()).toEqual([{ idType: 'TICKER', idValue: 'VTI', micCode: 'XNYS' }]);
  });

  it('with no mapper configured, a bare ticker is not claimed as checked: it stays unqualified_ticker', async () => {
    const resolver = createSecurityResolver({ store, clock: CLOCK, events });
    const resolution = await resolver.resolve(bareVti(), CONTEXT);
    expect(resolution.outcome).toBe('unresolved');
    expect(tickerReasonOf(resolution)).toBe('unqualified_ticker');
  });

  it('a re-sync of the same bare ticker finds the row it established, and mints nothing', async () => {
    const resolver = resolverWith({ 'TICKER:VTI/US': VTI_LINES });
    const first = await resolver.resolve(bareVti(), CONTEXT);
    const second = await resolver.resolve(bareVti(), CONTEXT);
    expect(first.outcome === 'resolved' && second.outcome === 'resolved').toBe(true);
    if (first.outcome !== 'resolved' || second.outcome !== 'resolved') return;
    expect(second.securityId).toBe(first.securityId);
    expect(second.created).toBe(false);
    expect(store.rows.length).toBe(1);
  });

  it('a non-USD bare ticker from another provider does not land on the row a USD one established', async () => {
    // D29 attaches the bare ticker `VTI` to the row it establishes, as
    // evidence. Evidence must not become identity by the back door: a CSV's
    // CAD `VTI`, never sent to OpenFIGI, may not find that row through the
    // bare ticker's key. Only a provider's own id (proprietary) may find a row
    // when nothing identity-bearing was given — 3.1's "a lookup mints nothing".
    const resolver = resolverWith({ 'TICKER:VTI/US': VTI_LINES });
    const usd = await resolver.resolve(bareVti(), CONTEXT);
    const cad = await resolver.resolve(
      { identifiers: [identifierOf('ticker', 'VTI')], currency: 'CAD', type: 'etf' },
      { ...CONTEXT, provider: 'csv' },
    );
    expect(usd.outcome).toBe('resolved');
    expect(cad.outcome).toBe('unresolved');
    expect(tickerReasonOf(cad)).toBe('unqualified_ticker');
    expect(store.rows).toHaveLength(1);
  });

  it('a bare ticker never inherits the FIGI another fact’s MIC-qualified ticker was mapped to', async () => {
    // Before WP 10.5 the batch's upgrade map was keyed `TICKER:VTI` alone, so a
    // bare CAD `VTI` in the same batch as `VTI@XNYS` picked up XNYS's FIGI and
    // resolved onto it: an identity from a bare ticker, through the back door.
    const resolver = resolverWith({ 'TICKER:VTI': [figiMappingOf('BBG000BDTF76')] });
    const [qualified, bare] = await resolver.resolveAll(
      [
        bareVti({
          identifiers: [identifierOf('ticker', 'VTI', { mic: 'XNYS' })],
          providerSecurityId: null,
        }),
        bareVti({ currency: 'CAD', providerSecurityId: null }),
      ],
      CONTEXT,
    );
    expect(qualified?.outcome).toBe('resolved');
    expect(bare?.outcome).toBe('unresolved');
  });
});

describe('usCompositeVerdictOf', () => {
  it('is unique only when every mapping names the same well-formed composite', () => {
    expect(usCompositeVerdictOf({ status: 'matched', mappings: VTI_LINES })).toEqual({
      status: 'unique',
      compositeFigi: VTI_COMPOSITE,
    });
    expect(
      usCompositeVerdictOf({
        status: 'matched',
        mappings: [figiMappingOf('BBG000BDTF76', { compositeFigi: 'not-a-figi' })],
      }),
    ).toEqual({ status: 'ambiguous' });
    expect(usCompositeVerdictOf({ status: 'matched', mappings: [] })).toEqual({
      status: 'no_match',
    });
    expect(usCompositeVerdictOf({ status: 'no_match' })).toEqual({ status: 'no_match' });
    expect(usCompositeVerdictOf({ status: 'error', message: 'HTTP 503' })).toEqual({
      status: 'error',
    });
  });
});
