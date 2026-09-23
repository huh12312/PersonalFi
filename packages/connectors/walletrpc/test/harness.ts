// SPDX-License-Identifier: MIT
/**
 * Wires a `WalletRpcConnector` to the fakes in `fake.ts`, and mints
 * `ConnectionHandle`s the way `@ctx/connections` would: `connect()` first,
 * then a handle keyed by whatever `providerConnectionId` it returned.
 */
import { fixedClock, newId } from '@core/kernel';
import type { ConnectionHandle, ConnectResult, SyncOptions } from '@connector/port';
import { WalletRpcConnector } from '../src/connector.ts';
import { etherscanApiKeyOf, missingEtherscanApiKey } from '../src/eth/api-key.ts';
import {
  InMemoryWalletAddressStore,
  createFakeEsploraTransport,
  createFakeEtherscanTransport,
  type FakeEsploraOptions,
  type FakeEtherscanOptions,
} from './fake.ts';

export const FIXED_NOW = '2026-09-22T12:00:00.000Z';

export interface HarnessOptions {
  readonly esplora?: FakeEsploraOptions;
  readonly etherscan?: FakeEtherscanOptions;
  readonly etherscanKeyPresent?: boolean;
}

export function harness(options: HarnessOptions = {}) {
  const store = new InMemoryWalletAddressStore();
  const clock = fixedClock(FIXED_NOW);
  const esploraTransport = createFakeEsploraTransport(options.esplora);
  const etherscanTransport = createFakeEtherscanTransport(options.etherscan);
  const etherscanApiKey =
    options.etherscanKeyPresent === false
      ? missingEtherscanApiKey()
      : etherscanApiKeyOf('test-etherscan-key');

  const connector = new WalletRpcConnector({
    store,
    esploraTransport,
    etherscanTransport,
    etherscanApiKey,
    clock,
  });

  const syncOptions: SyncOptions = {
    reason: 'manual',
    historyDays: 730,
    pageSize: 500,
    deadline: new Date('2026-09-22T13:00:00.000Z'),
    signal: new AbortController().signal,
    clock,
  };

  return { store, connector, clock, syncOptions };
}

export async function connectWallet(
  connector: WalletRpcConnector,
  input: {
    readonly chain: 'bitcoin' | 'ethereum';
    readonly value: string;
    readonly label?: string;
  },
): Promise<ConnectResult> {
  return connector.connect(input);
}

export function handleFor(connectResult: ConnectResult | null): ConnectionHandle {
  return {
    connectionId: newId(),
    userId: newId(),
    provider: 'wallet_rpc',
    providerConnectionId: connectResult?.providerConnectionId ?? 'disconnected',
    secret: () => null,
  };
}
