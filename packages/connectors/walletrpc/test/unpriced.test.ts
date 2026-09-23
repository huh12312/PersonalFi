// SPDX-License-Identifier: MIT
/**
 * Exit test for `docs/plan/03-phase-3-dispatch.md` §3 "WP 3.6", exact name:
 * `'an unpriced non-zero balance fails loudly rather than reporting zero'`.
 *
 * This connector has no price source (`connector.ts`'s header). 08 §2.2: "an
 * honest adapter never reports $0.00 for an unpriced asset." Covers both
 * `syncBalances` and `syncHoldings`, and both chains.
 */
import { describe, expect, it } from 'vitest';
import { isConnectorError, type ConnectorError } from '@connector/port';
import { harness, handleFor } from './harness.ts';

const ZPUB =
  'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
const FIRST_EXTERNAL_ADDRESS = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
const ETH_ADDRESS = '0x00000000219ab540356cbb839cbe05303d7705fa';

describe('an unpriced non-zero balance fails loudly rather than reporting zero', () => {
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

  it('syncHoldings: a funded ethereum wallet raises DATA_UNAVAILABLE, never a zero holding', async () => {
    const { connector, syncOptions } = harness({
      etherscan: { balances: new Map([[ETH_ADDRESS, '42000000000000000']]) }, // 0.042 ETH
    });
    const handle = handleFor(await connector.connect({ chain: 'ethereum', value: ETH_ADDRESS }));

    let thrown: unknown;
    try {
      await connector.syncHoldings(handle, syncOptions);
    } catch (error) {
      thrown = error;
    }
    expect(isConnectorError(thrown)).toBe(true);
    expect((thrown as ConnectorError).condition).toBe('DATA_UNAVAILABLE');
    expect((thrown as Error).message).toContain('0.042 ETH');
  });

  it('a literal zero balance is reported honestly, not refused', async () => {
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
