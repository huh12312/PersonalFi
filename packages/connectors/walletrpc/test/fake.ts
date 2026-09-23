// SPDX-License-Identifier: MIT
/**
 * Hermetic fakes: an in-memory `WalletAddressStore`, a fake Esplora transport,
 * and a fake Etherscan transport. No network, no database — every test in this
 * package runs against these.
 */
import type { WalletAddressRecord, WalletAddressStore, WalletScanState } from '../src/store.ts';
import { EMPTY_SCAN_STATE } from '../src/store.ts';
import {
  ESPLORA_HOST,
  type EsploraHttpResponse,
  type EsploraRequest,
  type EsploraTransport,
} from '../src/btc/esplora.ts';
import {
  ETHERSCAN_HOST,
  type EtherscanHttpResponse,
  type EtherscanRequest,
  type EtherscanTransport,
} from '../src/eth/etherscan.ts';

// ---------------------------------------------------------------------------
// WalletAddressStore
// ---------------------------------------------------------------------------

export class InMemoryWalletAddressStore implements WalletAddressStore {
  readonly #records = new Map<string, WalletAddressRecord>();

  async get(providerConnectionId: string): Promise<WalletAddressRecord | null> {
    return this.#records.get(providerConnectionId) ?? null;
  }

  async put(record: WalletAddressRecord): Promise<void> {
    this.#records.set(record.providerConnectionId, record);
  }

  async updateScanState(providerConnectionId: string, scanState: WalletScanState): Promise<void> {
    const existing = this.#records.get(providerConnectionId);
    if (existing === undefined) return;
    this.#records.set(providerConnectionId, { ...existing, scanState });
  }

  async delete(providerConnectionId: string): Promise<void> {
    this.#records.delete(providerConnectionId);
  }

  size(): number {
    return this.#records.size;
  }
}

// ---------------------------------------------------------------------------
// Fake Esplora
// ---------------------------------------------------------------------------

export interface FakeEsploraOptions {
  /** address -> { fundedSats, spentSats, txCount } */
  readonly addresses?: ReadonlyMap<
    string,
    { fundedSats: bigint; spentSats: bigint; txCount: number }
  >;
  /** Overrides the host every request claims, to simulate a misdirected client. */
  readonly recordedHosts?: string[];
  readonly recordedPaths?: string[];
  readonly forceStatus?: number;
}

export function createFakeEsploraTransport(options: FakeEsploraOptions = {}): EsploraTransport {
  const addresses = options.addresses ?? new Map();
  return async (request: EsploraRequest): Promise<EsploraHttpResponse> => {
    options.recordedHosts?.push(request.host);
    options.recordedPaths?.push(request.path);

    if (request.host !== ESPLORA_HOST) {
      // A real transport would never even be asked to do this — the client
      // hardcodes the host — but a fake that enforced it too is what makes
      // `egress.test.ts` able to prove there is no path around it.
      throw new Error(`fake esplora transport asked for an unexpected host: ${request.host}`);
    }

    if (options.forceStatus !== undefined) {
      return { status: options.forceStatus, body: null };
    }

    const match = /\/address\/([^/]+)$/u.exec(request.path);
    const address = match?.[1] !== undefined ? decodeURIComponent(match[1]) : null;
    const entry = address !== null ? addresses.get(address) : undefined;

    if (entry === undefined) {
      return {
        status: 200,
        body: {
          chain_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 },
          mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 },
        },
      };
    }

    return {
      status: 200,
      body: {
        chain_stats: {
          funded_txo_sum: Number(entry.fundedSats),
          spent_txo_sum: Number(entry.spentSats),
          tx_count: entry.txCount,
        },
        mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 },
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Fake Etherscan
// ---------------------------------------------------------------------------

export interface FakeEtherscanOptions {
  /** address (lowercase) -> balance in wei, decimal string. */
  readonly balances?: ReadonlyMap<string, string>;
  readonly recordedHosts?: string[];
  readonly recordedQueries?: Record<string, string>[];
  readonly recordedApiKeys?: string[];
  readonly forceStatus?: number;
  /** Simulate Etherscan's own error channel (status:"0"). */
  readonly forceProviderError?: string;
}

export function createFakeEtherscanTransport(
  options: FakeEtherscanOptions = {},
): EtherscanTransport {
  const balances = options.balances ?? new Map();
  return async (request: EtherscanRequest): Promise<EtherscanHttpResponse> => {
    options.recordedHosts?.push(request.host);
    options.recordedQueries?.push({ ...request.query });
    if (typeof request.query['apikey'] === 'string') {
      options.recordedApiKeys?.push(request.query['apikey']);
    }

    if (request.host !== ETHERSCAN_HOST) {
      throw new Error(`fake etherscan transport asked for an unexpected host: ${request.host}`);
    }

    if (options.forceStatus !== undefined) {
      return { status: options.forceStatus, body: null };
    }
    if (options.forceProviderError !== undefined) {
      return {
        status: 200,
        body: { status: '0', message: options.forceProviderError, result: null },
      };
    }

    const address = request.query['address']?.toLowerCase();
    const balance = address !== undefined ? (balances.get(address) ?? '0') : '0';
    return { status: 200, body: { status: '1', message: 'OK', result: balance } };
  };
}

export { EMPTY_SCAN_STATE };
