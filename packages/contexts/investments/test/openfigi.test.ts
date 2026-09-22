// SPDX-License-Identifier: MIT
/**
 * The `FigiMapper` port's batching contract.
 *
 * The HTTP adapter is WP 3.4's (OpenFIGI is an egress surface and belongs
 * behind WP 2.4's allow-list module, reused rather than reimplemented). What
 * this suite pins is the property that survives whichever adapter lands: the
 * number of *requests* grows with `ceil(n / cap)` and not with `n`.
 */
import { fixedClock } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import {
  OPENFIGI_ANONYMOUS_MAX_JOBS_PER_REQUEST,
  OPENFIGI_MAX_JOBS_PER_MINUTE,
  OPENFIGI_MAX_JOBS_PER_REQUEST,
  createFakeFigiMapper,
  figiBatchesOf,
  figiJobOf,
  figiMappingOf,
  firstUnambiguousFigi,
} from '../src/figi.ts';
import { identifierOf, normaliseIdentifiers } from '../src/identifiers.ts';
import { createSecurityResolver } from '../src/resolver.ts';
import { inMemorySecurityStore } from '../src/store.ts';

const USER = '01920000-0000-7000-8000-000000000001';
const CLOCK = fixedClock('2026-06-15T02:00:00.000Z');

/** 120 distinct MIC-qualified tickers — a mid-sized brokerage's position list. */
function symbols(count: number): readonly string[] {
  return Array.from({ length: count }, (_, index) => `SYM${String(index).padStart(3, '0')}`);
}

describe('OpenFIGI batching', () => {
  it('120 symbols are one batched request, not 120', async () => {
    const mapper = createFakeFigiMapper({
      table: Object.fromEntries(
        symbols(120).map((symbol, index) => [
          `TICKER:${symbol}`,
          [figiMappingOf(`BBG${String(index).padStart(8, '0')}1`, { ticker: symbol })],
        ]),
      ),
    });
    const resolver = createSecurityResolver({
      store: inMemorySecurityStore(),
      clock: CLOCK,
      figi: mapper,
    });

    await resolver.resolveAll(
      symbols(120).map((symbol) => ({
        identifiers: [identifierOf('ticker', symbol, { mic: 'XNAS' })],
      })),
      { userId: USER, provider: 'csv' },
    );

    // The name of this test is the plan's, verbatim, and the number it asserts
    // is *two* rather than one. OpenFIGI's `/v3/mapping` takes at most 100 jobs
    // per POST with an API key (10 without), so 120 symbols cannot be one
    // request and never could have been. What the name is really claiming —
    // that the mapper batches instead of issuing one request per symbol — is
    // what is asserted here, and the discrepancy is recorded in
    // docs/evidence/phase-3/wp3.1-securities.md §4 rather than resolved by
    // quietly raising the cap to make a sentence true.
    expect(mapper.requests).toHaveLength(2);
    expect(mapper.requests.flat()).toHaveLength(120);
    expect(mapper.requests.length).toBeLessThan(120);
    for (const request of mapper.requests) {
      expect(request.length).toBeLessThanOrEqual(OPENFIGI_MAX_JOBS_PER_REQUEST);
    }
  });

  it('resolving one at a time is what the batched call replaces', async () => {
    // The counterfactual, stated as a test so the saving is visible rather than
    // asserted in a comment: `resolve` is `resolveAll` of one, so a caller that
    // loops gets 120 requests and is not wrong, only expensive. `resolveAll` is
    // the method that exists for this reason.
    const mapper = createFakeFigiMapper();
    const resolver = createSecurityResolver({
      store: inMemorySecurityStore(),
      clock: CLOCK,
      figi: mapper,
    });
    for (const symbol of symbols(10)) {
      await resolver.resolve(
        { identifiers: [identifierOf('ticker', symbol, { mic: 'XNAS' })] },
        { userId: USER, provider: 'csv' },
      );
    }
    expect(mapper.requests).toHaveLength(10);
  });

  it('asks once per security, not once per name it was given', async () => {
    // A fact carrying a CUSIP *and* a ticker is one job, not two: the CUSIP
    // already answers the question better, and doubling the job count to ask
    // twice is how a 25,000/minute budget becomes a rate limit.
    const mapper = createFakeFigiMapper();
    const resolver = createSecurityResolver({
      store: inMemorySecurityStore(),
      clock: CLOCK,
      figi: mapper,
    });
    await resolver.resolveAll(
      [
        {
          identifiers: [
            identifierOf('cusip', '922908769'),
            identifierOf('ticker', 'VTI', { mic: 'XNYS' }),
          ],
        },
      ],
      { userId: USER, provider: 'plaid' },
    );
    expect(mapper.requests.flat()).toHaveLength(1);
    expect(mapper.requests.flat()[0]?.idType).toBe('ID_CUSIP');
  });

  it('never asks about a security that already has a FIGI', async () => {
    const mapper = createFakeFigiMapper();
    const resolver = createSecurityResolver({
      store: inMemorySecurityStore(),
      clock: CLOCK,
      figi: mapper,
    });
    await resolver.resolveAll(
      [{ identifiers: [identifierOf('figi', 'BBG000BDTF76'), identifierOf('cusip', '922908769')] }],
      { userId: USER, provider: 'plaid' },
    );
    expect(mapper.requests).toHaveLength(0);
  });

  it('carries the documented limits as numbers in the code', () => {
    // dispatch §4: a rate limit is implemented with its documented number, not
    // described in a comment. 01 §4.1's table is the source for all three.
    expect(OPENFIGI_MAX_JOBS_PER_REQUEST).toBe(100);
    expect(OPENFIGI_ANONYMOUS_MAX_JOBS_PER_REQUEST).toBe(10);
    expect(OPENFIGI_MAX_JOBS_PER_MINUTE).toBe(25_000);
  });
});

describe('figiBatchesOf', () => {
  it('splits at the cap and keeps every job exactly once, in order', () => {
    const jobs = Array.from({ length: 250 }, (_, index) => index);
    const batches = figiBatchesOf(jobs);
    expect(batches).toHaveLength(3);
    expect(batches.map((batch) => batch.length)).toEqual([100, 100, 50]);
    expect(batches.flat()).toEqual(jobs);
  });

  it('is one batch at the cap and two one job past it', () => {
    expect(figiBatchesOf(Array.from({ length: 100 }, (_, i) => i))).toHaveLength(1);
    expect(figiBatchesOf(Array.from({ length: 101 }, (_, i) => i))).toHaveLength(2);
    expect(figiBatchesOf([])).toHaveLength(0);
  });

  it('refuses a batch size of zero rather than looping forever', () => {
    expect(() => figiBatchesOf([1, 2, 3], 0)).toThrow(RangeError);
  });
});

describe('the job and outcome contract', () => {
  it('produces no job for the kinds OpenFIGI cannot answer', () => {
    const { identifiers } = normaliseIdentifiers(
      [
        identifierOf('chain_contract', '0xdac17f958d2ee523a2206206994597c13d831ec7', {
          chain: 'ethereum',
        }),
        identifierOf('proprietary', 'sec-1'),
        identifierOf('figi', 'BBG000BDTF76'),
      ],
      { provider: 'plaid' },
    );
    for (const identifier of identifiers) {
      expect(figiJobOf(identifier), identifier.kind).toBeNull();
    }
  });

  it('refuses an ambiguous answer instead of picking the first mapping', () => {
    expect(firstUnambiguousFigi({ status: 'matched', mappings: [figiMappingOf('BBG1')] })).toBe(
      'BBG1',
    );
    expect(
      firstUnambiguousFigi({
        status: 'matched',
        mappings: [figiMappingOf('BBG1'), figiMappingOf('BBG2')],
      }),
    ).toBeNull();
    expect(firstUnambiguousFigi({ status: 'no_match' })).toBeNull();
    expect(firstUnambiguousFigi({ status: 'error', message: 'timeout' })).toBeNull();
  });

  it('returns one outcome per job, positionally, across batch boundaries', async () => {
    // OpenFIGI's response array is positional. A caller that re-derived the
    // association by matching values back would get it wrong for two jobs with
    // the same idValue and different micCode — which is exactly the dual-listing
    // case the MIC exists for.
    const mapper = createFakeFigiMapper({
      table: { 'TICKER:BHP': [figiMappingOf('BBG000BH0HY2')] },
      jobsPerRequest: 2,
    });
    const jobs = [
      { idType: 'TICKER', idValue: 'BHP', micCode: 'XNYS' },
      { idType: 'TICKER', idValue: 'UNKNOWN', micCode: null },
      { idType: 'TICKER', idValue: 'BHP', micCode: 'XASX' },
    ] as const;
    const outcomes = await mapper.map(jobs);
    expect(outcomes).toHaveLength(3);
    expect(outcomes[0]?.status).toBe('matched');
    expect(outcomes[1]?.status).toBe('no_match');
    expect(outcomes[2]?.status).toBe('matched');
    expect(mapper.requests).toHaveLength(2);
  });

  it('distinguishes a permanent no_match from a transient error', async () => {
    const mapper = createFakeFigiMapper({ errors: { 'ID_CUSIP:922908769': 'HTTP 503' } });
    const [outcome] = await mapper.map([
      { idType: 'ID_CUSIP', idValue: '922908769', micCode: null },
    ]);
    // The difference matters to a caller: `no_match` is a fact about the
    // identifier and can be recorded; `error` is a fact about the call and
    // must not be, or a five-second outage becomes a permanent "unmappable".
    expect(outcome?.status).toBe('error');
  });
});
