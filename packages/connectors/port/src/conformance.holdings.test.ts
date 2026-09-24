// SPDX-License-Identifier: MIT
/**
 * The `holdings/` conformance check, sabotaged — WP 3.7a.
 *
 * `packages/contexts/connections/test/conformance.test.ts` already holds the
 * suite's own "a gate that has never been observed failing something is not
 * evidence" tests, and it drives them through a real `ManualConnector`. It
 * cannot drive these: `manual` does not declare `holdings`, so the check it
 * would exercise returns early, and the adapters that *do* declare it live in
 * packages `@ctx/connections` may not import. So the holdings check's own
 * sabotages live here, beside the check.
 *
 * Each case is the shape of a real adapter mistake, and the first of them is
 * the WP 3.7 defect itself: an adapter that had four names for a security and
 * handed the port the strongest one. That passed the pre-3.7a check — it was a
 * valid kind with a non-empty value — and split the security in two downstream.
 * The check now asserts the *set*, and this is where it is watched doing it.
 */
import { money, systemClock } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import { connectorConformanceChecks, type ConformanceSubject } from './conformance.ts';
import {
  securityIdentifierOf,
  type ProviderHoldingFact,
  type ProviderSecurityFact,
} from './facts.ts';
import { securityFingerprintOf } from './fingerprint.ts';
import type { Connector } from './connector.ts';

const VTI_IDENTIFIERS = [
  securityIdentifierOf('figi', 'BBG000BDTF76'),
  securityIdentifierOf('isin', 'US9229087690'),
  securityIdentifierOf('cusip', '922908769'),
  securityIdentifierOf('ticker', 'VTI', { mic: 'XNYS' }),
];

function securityFactOf(overrides: Partial<ProviderSecurityFact> = {}): ProviderSecurityFact {
  const identifiers = overrides.identifiers ?? VTI_IDENTIFIERS;
  return {
    providerSecurityId: 'sec-vti-0001',
    identifiers,
    name: 'Vanguard Total Stock Market ETF',
    type: 'etf',
    subtype: null,
    currency: 'USD',
    isCashEquivalent: false,
    closePrice: '268.40',
    closePriceAsOf: null,
    raw: null,
    fingerprint: securityFingerprintOf(identifiers),
    ...overrides,
  };
}

function holdingOf(security: ProviderSecurityFact): ProviderHoldingFact {
  return {
    providerAccountId: 'acct-brokerage-003',
    security,
    quantity: '62.5',
    costBasis: null,
    value: money(1_677_500n, 'USD'),
    asOf: new Date('2026-06-01T20:00:00.000Z'),
    raw: null,
  };
}

/**
 * The smallest subject the `holdings/` check can run against.
 *
 * Only `capabilities()` and `syncHoldings` are reachable from it — the check
 * calls nothing else — so a stub is honest here in a way it would not be for
 * `sync/resumable`. Everything else is left unimplemented on purpose: if the
 * check ever grows a call into another method, this stub throws rather than
 * quietly passing on a `undefined`.
 */
function subjectWith(holdings: readonly ProviderHoldingFact[]): ConformanceSubject {
  const connector = {
    provider: 'stub',
    capabilities: () => ({ supports: ['holdings'] as const, reconnect: 'none' as const }),
    syncHoldings: () => Promise.resolve(holdings),
  } as unknown as Connector;

  return {
    connector,
    handle: {
      connectionId: 'conn-1',
      userId: 'user-1',
      provider: 'stub',
      providerConnectionId: 'pc-1',
      secret: () => null,
    },
    options: {
      reason: 'manual',
      historyDays: 730,
      pageSize: 500,
      deadline: new Date('2026-06-01T21:00:00.000Z'),
      signal: new AbortController().signal,
      clock: systemClock,
    },
  };
}

async function runHoldingsCheck(subject: ConformanceSubject): Promise<void> {
  const check = connectorConformanceChecks(subject).find((candidate) =>
    candidate.name.startsWith('holdings/'),
  );
  if (check === undefined) throw new Error('no conformance check starting with holdings/');
  await check.run();
}

describe('the holdings conformance check, sabotaged', () => {
  it('passes an adapter that hands over every name the provider gave', async () => {
    await expect(
      runHoldingsCheck(subjectWith([holdingOf(securityFactOf())])),
    ).resolves.toBeUndefined();
  });

  /**
   * The WP 3.7 defect, and the honest limit of what a conformance check can do
   * about it.
   *
   * `holdingSecurityOf` took `strongestIdentifier(securityIdentifiersOf(...))`
   * and threw the other three away. A check cannot catch that, and this test
   * exists to say so out loud rather than to leave a reader assuming the suite
   * has it covered:
   *
   *   * the truncated fact is **well-formed**. One FIGI is a perfectly legal
   *     identifier set, and a brokerage that knows only a FIGI is a real
   *     brokerage;
   *   * the fingerprint does not give it away either, and that is deliberate
   *     rather than an oversight. `securityFingerprintOf` hashes the *strongest*
   *     identifier alone, precisely so two providers who agree on an ISIN
   *     fingerprint alike even when one of them is chattier. That property is
   *     what makes it a cross-provider dedupe key, and it is exactly what makes
   *     it blind to a dropped name.
   *
   * So the defence is not this suite. It is the **shape**: `security` is a
   * `ProviderSecurityFact`, so there is no longer a field an adapter can satisfy
   * by choosing, and `securityIdentifiersOf`'s whole output is what
   * `holdingFactOf` has in hand. The per-adapter tests are what pin the set
   * itself — `@connector/plaid`'s `map.test.ts` asserts all four VTI names.
   */
  it('cannot tell a truncated identifier set from a genuinely quiet provider', async () => {
    const strongestOnly = [VTI_IDENTIFIERS[0]!];
    const truncated = securityFactOf({
      identifiers: strongestOnly,
      fingerprint: securityFingerprintOf(strongestOnly),
      type: null,
      name: null,
    });
    // Same fingerprint as the full set: over the strongest name only, by design.
    expect(securityFingerprintOf(strongestOnly)).toBe(securityFingerprintOf(VTI_IDENTIFIERS));
    await expect(runHoldingsCheck(subjectWith([holdingOf(truncated)]))).resolves.toBeUndefined();
  });

  it('fails an adapter that names a security with nothing at all', async () => {
    const nameless = { ...securityFactOf(), identifiers: [], fingerprint: 'x'.repeat(64) };
    await expect(runHoldingsCheck(subjectWith([holdingOf(nameless)]))).rejects.toThrow(
      /empty identifier set/u,
    );
  });

  it('fails an adapter that omits the providerSecurityId', async () => {
    await expect(
      runHoldingsCheck(subjectWith([holdingOf(securityFactOf({ providerSecurityId: '  ' }))])),
    ).rejects.toThrow(/providerSecurityId/u);
  });

  it('fails an adapter that names a contract address without its chain', async () => {
    const identifiers = [
      { kind: 'chain_contract' as const, value: 'native', chain: null, mic: null },
    ];
    await expect(
      runHoldingsCheck(
        subjectWith([
          holdingOf(
            securityFactOf({ identifiers, fingerprint: securityFingerprintOf(identifiers) }),
          ),
        ]),
      ),
    ).rejects.toThrow(/chain_contract with no chain/u);
  });

  it('fails an adapter that floats a quantity', async () => {
    const floated = { ...holdingOf(securityFactOf()), quantity: 1e-7 as unknown as string };
    await expect(runHoldingsCheck(subjectWith([floated]))).rejects.toThrow(/decimal string/u);
  });
});
