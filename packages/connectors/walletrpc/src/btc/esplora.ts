// SPDX-License-Identifier: MIT
/**
 * Blockstream Esplora — the BTC balance and activity source (01 §3.5:
 * "mempool.space and Blockstream Esplora have no xpub endpoint in their public
 * REST APIs. You must derive addresses client-side… and query
 * `GET /api/address/:address[/txs|/utxo]` per address.").
 *
 * ## The transport seam, and why the host is a source-code constant
 *
 * `EsploraTransport` is a function, exactly like Coinbase's `CoinbaseTransport`
 * (`packages/connectors/coinbase/src/api.ts`) and for the identical reason:
 * this package's boundary layer does not (and, per its `why`, must not) allow
 * `@core/platform`, so the SSRF-grade guard — DNS-rebinding-safe resolution,
 * private/link-local refusal, no redirect following, a bounded body — is built
 * once at the composition root (`apps/api`) and injected here, exactly as it
 * is for every other adapter. What *this* file owns is narrower and just as
 * load-bearing: **`ESPLORA_HOST` is a constant, never a parameter**, so no
 * value this connector reads from a user — an xpub, a derived address, a
 * label — can ever become the destination host. `egress.test.ts` proves this
 * by grepping for it and by driving the client with adversarial addresses and
 * asserting every recorded request's `host` is still this one string.
 */
import { ConnectorError } from '@connector/port';

/** The only host this client ever asks for. Not configurable, not derived. */
export const ESPLORA_HOST = 'blockstream.info';
export const ESPLORA_BASE_PATH = '/api';
export const ESPLORA_REQUEST_TIMEOUT_MS = 15_000;

export interface EsploraRequest {
  readonly host: typeof ESPLORA_HOST;
  readonly path: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal | null;
}

export interface EsploraHttpResponse {
  readonly status: number;
  readonly body: unknown;
}

export type EsploraTransport = (request: EsploraRequest) => Promise<EsploraHttpResponse>;

export interface EsploraChainStats {
  readonly funded_txo_sum?: unknown;
  readonly spent_txo_sum?: unknown;
  readonly tx_count?: unknown;
}

export interface EsploraAddressStats {
  readonly chain_stats?: EsploraChainStats;
  readonly mempool_stats?: EsploraChainStats;
}

export interface AddressActivity {
  /** Confirmed + mempool balance, in satoshis. */
  readonly balanceSats: bigint;
  readonly hasActivity: boolean;
}

export interface EsploraClientOptions {
  readonly transport: EsploraTransport;
  readonly signal?: AbortSignal | null;
}

function pathFor(address: string): string {
  // Bitcoin addresses are base58/bech32: no `/`, `?`, or other path-breaking
  // character can occur in one, and `encodeURIComponent` is applied anyway so
  // that an address this connector's own derivation never produces still could
  // not smuggle a path segment.
  return `${ESPLORA_BASE_PATH}/address/${encodeURIComponent(address)}`;
}

function toBigInt(value: unknown, field: string): bigint {
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  throw new ConnectorError(`esplora returned a non-integer ${field}`, {
    kind: 'permanent',
    condition: 'MALFORMED_RESPONSE',
    redactedContext: { field },
  });
}

export function createEsploraClient(options: EsploraClientOptions) {
  async function addressActivity(address: string): Promise<AddressActivity> {
    const response = await options.transport({
      host: ESPLORA_HOST,
      path: pathFor(address),
      timeoutMs: ESPLORA_REQUEST_TIMEOUT_MS,
      signal: options.signal ?? null,
    });

    if (response.status === 429) {
      throw ConnectorError.fromCondition('RATE_LIMITED', 'esplora rate-limited this request', {
        redactedContext: { host: ESPLORA_HOST },
      });
    }
    if (response.status >= 500) {
      throw ConnectorError.fromCondition(
        'PROVIDER_DOWN',
        `esplora returned ${String(response.status)}`,
        {
          redactedContext: { host: ESPLORA_HOST, status: response.status },
        },
      );
    }
    if (response.status !== 200) {
      throw ConnectorError.fromCondition(
        'MALFORMED_RESPONSE',
        `esplora returned an unexpected status ${String(response.status)}`,
        { redactedContext: { host: ESPLORA_HOST, status: response.status } },
      );
    }

    const body = response.body as EsploraAddressStats | null;
    if (body === null || typeof body !== 'object') {
      throw ConnectorError.fromCondition('MALFORMED_RESPONSE', 'esplora returned no address stats');
    }

    const chain = body.chain_stats ?? {};
    const mempool = body.mempool_stats ?? {};
    const funded = toBigInt(chain.funded_txo_sum ?? 0, 'chain_stats.funded_txo_sum');
    const spent = toBigInt(chain.spent_txo_sum ?? 0, 'chain_stats.spent_txo_sum');
    const mempoolFunded = toBigInt(mempool.funded_txo_sum ?? 0, 'mempool_stats.funded_txo_sum');
    const mempoolSpent = toBigInt(mempool.spent_txo_sum ?? 0, 'mempool_stats.spent_txo_sum');
    const chainTxCount = toBigInt(chain.tx_count ?? 0, 'chain_stats.tx_count');
    const mempoolTxCount = toBigInt(mempool.tx_count ?? 0, 'mempool_stats.tx_count');

    return {
      balanceSats: funded - spent + (mempoolFunded - mempoolSpent),
      hasActivity: chainTxCount > 0n || mempoolTxCount > 0n,
    };
  }

  return {
    addressActivity,
    /** For gap-limit scanning: activity only, no balance arithmetic. */
    hasActivity: async (address: string): Promise<boolean> =>
      (await addressActivity(address)).hasActivity,
  };
}

export type EsploraClient = ReturnType<typeof createEsploraClient>;
