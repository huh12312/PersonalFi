// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { isConnectorError } from '@connector/port';
import { harness, handleFor } from './harness.ts';

const ZPUB =
  'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
const FIRST_EXTERNAL_ADDRESS = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
const ETH_ADDRESS = '0x00000000219ab540356cbb839cbe05303d7705fa';

describe('WalletRpcConnector.connect', () => {
  it('accepts a zpub and stores nothing secret', async () => {
    const { connector } = harness();
    const result = await connector.connect({ chain: 'bitcoin', value: ZPUB, label: 'Cold wallet' });
    expect(result.credentials).toEqual({});
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]?.type).toBe('crypto');
    expect(result.accounts[0]?.subtype).toBe('bitcoin');
  });

  it('accepts a plain ETH address', async () => {
    const { connector } = harness();
    const result = await connector.connect({ chain: 'ethereum', value: ETH_ADDRESS });
    expect(result.accounts[0]?.subtype).toBe('ethereum');
  });

  it('refuses malformed input as invalid_input', async () => {
    const { connector } = harness();
    let thrown: unknown;
    try {
      await connector.connect({ chain: 'bitcoin' });
    } catch (error) {
      thrown = error;
    }
    expect(isConnectorError(thrown)).toBe(true);
  });
});

describe('WalletRpcConnector balances', () => {
  it('reports zero for an empty bitcoin wallet', async () => {
    const { connector, syncOptions } = harness();
    const connectResult = await connector.connect({ chain: 'bitcoin', value: ZPUB });
    const handle = handleFor(connectResult);

    const balances = await connector.syncBalances(handle, syncOptions);
    expect(balances).toHaveLength(1);
    expect(balances[0]?.current.minor).toBe(0n);
    expect(balances[0]?.current.currency).toBe('USD');
  });

  it('fails loudly rather than reporting zero for a funded bitcoin wallet', async () => {
    const { connector, syncOptions } = harness({
      esplora: {
        addresses: new Map([
          [FIRST_EXTERNAL_ADDRESS, { fundedSats: 5_000_000n, spentSats: 0n, txCount: 1 }],
        ]),
      },
    });
    const connectResult = await connector.connect({ chain: 'bitcoin', value: ZPUB });
    const handle = handleFor(connectResult);

    let thrown: unknown;
    try {
      await connector.syncBalances(handle, syncOptions);
    } catch (error) {
      thrown = error;
    }
    expect(isConnectorError(thrown)).toBe(true);
    expect((thrown as Error).message).toContain('0.05 BTC');
  });

  it('reports zero for an empty ethereum wallet', async () => {
    const { connector, syncOptions } = harness({
      etherscan: { balances: new Map([[ETH_ADDRESS, '0']]) },
    });
    const connectResult = await connector.connect({ chain: 'ethereum', value: ETH_ADDRESS });
    const handle = handleFor(connectResult);

    const balances = await connector.syncBalances(handle, syncOptions);
    expect(balances[0]?.current.minor).toBe(0n);
  });

  it('fails loudly for a funded ethereum wallet', async () => {
    const { connector, syncOptions } = harness({
      etherscan: { balances: new Map([[ETH_ADDRESS, '1000000000000000000']]) }, // 1 ETH
    });
    const connectResult = await connector.connect({ chain: 'ethereum', value: ETH_ADDRESS });
    const handle = handleFor(connectResult);

    let thrown: unknown;
    try {
      await connector.syncBalances(handle, syncOptions);
    } catch (error) {
      thrown = error;
    }
    expect(isConnectorError(thrown)).toBe(true);
    expect((thrown as Error).message).toContain('1 ETH');
  });
});

describe('WalletRpcConnector lifecycle', () => {
  it('refuses to sync a disconnected connection', async () => {
    const { connector, syncOptions } = harness();
    const connectResult = await connector.connect({ chain: 'ethereum', value: ETH_ADDRESS });
    const handle = handleFor(connectResult);

    await connector.disconnect(handle);

    let thrown: unknown;
    try {
      await connector.syncTransactions(handle, null, syncOptions);
    } catch (error) {
      thrown = error;
    }
    expect(isConnectorError(thrown)).toBe(true);
  });
});
