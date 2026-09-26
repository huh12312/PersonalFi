// SPDX-License-Identifier: MIT
/**
 * Exit test for `docs/plan/03-phase-3-dispatch.md` §3 "WP 3.6", updated for
 * the Phase 3 gate's C-2 condition (`docs/evidence/phase-3/gate-security-review.md`
 * G3-14, `docs/evidence/phase-4/wp4.12a-gate-conditions.md` C-2).
 *
 * `syncBalances` still refuses a non-zero balance loudly — a ledger balance
 * has no downstream ladder to rescue it (`connector.ts`'s header). Through
 * the gate, `syncHoldings` refused identically, which meant a funded
 * watch-only wallet could never become a holding at all. It now reports the
 * real quantity with `value: null`, never a fabricated `$0.00` and never a
 * refusal that hides the position — 08 §2.2's rule, applied to the shape the
 * port now allows rather than to a thrown error.
 */
import { describe, expect, it } from 'vitest';
import { isConnectorError, type ConnectorError } from '@connector/port';
import { harness, handleFor } from './harness.ts';

const ZPUB =
  'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
const FIRST_EXTERNAL_ADDRESS = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
const ETH_ADDRESS = '0x00000000219ab540356cbb839cbe05303d7705fa';

describe('an unpriced balance never becomes a fabricated zero — and, for holdings, never a refusal either', () => {
  it('syncBalances: a funded bitcoin wallet raises DATA_UNAVAILABLE, never $0.00', async () => {
    const { connector, syncOptions } = harness({
      esplora: {
        addresses: new Map([
          [FIRST_EXTERNAL_ADDRESS, { fundedSats: 1_234n, spentSats: 0n, txCount: 1 }],
        ]),
      },
    });
    const handle = handleFor(await connector.connect({ chain: 'bitcoin', value: ZPUB }));

    let thrown: unknown;
    try {
      await connector.syncBalances(handle, syncOptions);
    } catch (error) {
      thrown = error;
    }
    expect(isConnectorError(thrown)).toBe(true);
    expect((thrown as ConnectorError).condition).toBe('DATA_UNAVAILABLE');
    // Never a Money zero disguised as an answer.
    expect(thrown).not.toEqual(expect.objectContaining({ minor: 0n }));
  });

  it('syncHoldings: a funded ethereum wallet reports its quantity with value: null, never DATA_UNAVAILABLE and never $0.00', async () => {
    const { connector, syncOptions } = harness({
      etherscan: { balances: new Map([[ETH_ADDRESS, '42000000000000000']]) }, // 0.042 ETH
    });
    const handle = handleFor(await connector.connect({ chain: 'ethereum', value: ETH_ADDRESS }));

    const holdings = await connector.syncHoldings(handle, syncOptions);
    expect(holdings).toHaveLength(1);
    const [holding] = holdings;
    expect(holding?.quantity).toBe('0.042');
    expect(holding?.value).toBeNull();
    expect(holding?.costBasis).toBeNull();
    // The security this quantity is *in* still carries the chain's native
    // `chain_contract` identifier, so the resolver still merges it onto the
    // same security a Coinbase ETH sighting would use (`one-security.test.ts`).
    expect(holding?.security.identifiers).toEqual([
      {
        kind: 'chain_contract',
        value: expect.stringMatching(/^0xeeee/iu),
        chain: 'ethereum',
        mic: null,
      },
    ]);
  });

  it('syncHoldings: a funded bitcoin wallet reports its quantity with value: null, never DATA_UNAVAILABLE', async () => {
    const { connector, syncOptions } = harness({
      esplora: {
        addresses: new Map([
          [FIRST_EXTERNAL_ADDRESS, { fundedSats: 1_234n, spentSats: 0n, txCount: 1 }],
        ]),
      },
    });
    const handle = handleFor(await connector.connect({ chain: 'bitcoin', value: ZPUB }));

    const holdings = await connector.syncHoldings(handle, syncOptions);
    expect(holdings).toHaveLength(1);
    expect(holdings[0]?.quantity).toBe('0.00001234');
    expect(holdings[0]?.value).toBeNull();
    expect(holdings[0]?.security.identifiers).toEqual([
      { kind: 'chain_contract', value: 'native', chain: 'bitcoin', mic: null },
    ]);
  });

  it('a literal zero balance is reported honestly, not refused, and not a holding', async () => {
    const { connector, syncOptions } = harness({
      etherscan: { balances: new Map([[ETH_ADDRESS, '0']]) },
    });
    const handle = handleFor(await connector.connect({ chain: 'ethereum', value: ETH_ADDRESS }));

    const holdings = await connector.syncHoldings(handle, syncOptions);
    const balances = await connector.syncBalances(handle, syncOptions);
    expect(holdings).toEqual([]); // nothing to report, not a fabricated zero-value position
    expect(balances[0]?.current.minor).toBe(0n);
  });
});
