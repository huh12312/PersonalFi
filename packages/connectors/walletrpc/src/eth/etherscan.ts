// SPDX-License-Identifier: MIT
/**
 * Etherscan v2 — the ETH balance source. 01 §3.5: "one key across 60+ EVM
 * chains via a `chainid` param. Free tier 5 calls/sec, 100,000 calls/day."
 * This connector uses `chainid=1` (Ethereum mainnet) only.
 *
 * `GET /v2/api?chainid=1&module=account&action=balance&address=…&tag=latest&apikey=…`
 * answers `{ status: "1"|"0", message, result: "<wei as a decimal string>" }`.
 *
 * ## No "enumerate all token balances" primitive (01 §3.5)
 *
 * Etherscan gives per-contract `tokenbalance` only — there is no endpoint that
 * lists every ERC-20 a wallet holds, so it cannot be discovered without first
 * finding the token set from transfer-event logs. That is out of scope for
 * this work package and is the documented upgrade path: **Alchemy's
 * `alchemy_getTokenBalances`** is materially better at this and would be a new
 * host, a new adapter and a new allow-list entry, not a change to this file.
 * This connector's ETH leg is native-ETH-only.
 *
 * ## The host, and the key, are both fixed — never derived from user input
 *
 * Same shape as `esplora.ts`: `ETHERSCAN_HOST` is a constant, the transport is
 * injected (the real one, egress-guarded, is built at the composition root),
 * and the address goes in a query parameter that is built from a value already
 * validated by `eth/address.ts` to be exactly `0x` + 40 hex characters — so
 * there is no way an address contributes anything but itself to the request.
 *
 * The API key is read once per call via `EtherscanApiKey.reveal()` and placed
 * directly in the query string map this file returns to the transport; it is
 * never concatenated into a URL string this package builds itself, and
 * `log-hygiene.test.ts` asserts the key never appears in any thrown error's
 * message (Etherscan does not echo request parameters in its error bodies,
 * unlike FRED — see `@ctx/integrations`'s `secrets.ts` for why that provider
 * needed `redactSecrets` and this one does not).
 */
import { ConnectorError } from '@connector/port';
import type { EtherscanApiKey } from './api-key.ts';

export const ETHERSCAN_HOST = 'api.etherscan.io';
export const ETHERSCAN_BASE_PATH = '/v2/api';
export const ETHERSCAN_REQUEST_TIMEOUT_MS = 15_000;
export const ETHEREUM_MAINNET_CHAIN_ID = 1;

export interface EtherscanRequest {
  readonly host: typeof ETHERSCAN_HOST;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly signal: AbortSignal | null;
}

export interface EtherscanHttpResponse {
  readonly status: number;
  readonly body: unknown;
}

export type EtherscanTransport = (request: EtherscanRequest) => Promise<EtherscanHttpResponse>;

export interface EtherscanClientOptions {
  readonly transport: EtherscanTransport;
  readonly apiKey: EtherscanApiKey;
  readonly signal?: AbortSignal | null;
}

interface EtherscanBalanceBody {
  readonly status?: unknown;
  readonly message?: unknown;
  readonly result?: unknown;
}

export function createEtherscanClient(options: EtherscanClientOptions) {
  async function nativeBalanceWei(address: string): Promise<bigint> {
    if (!options.apiKey.present) {
      throw new ConnectorError(
        'no etherscan_api_key is configured. Etherscan v2 requires a key even at the free tier; ' +
          'set etherscan_api_key and reconnect this wallet.',
        { kind: 'invalid_input', condition: 'CONFIG_ERROR' },
      );
    }

    const response = await options.transport({
      host: ETHERSCAN_HOST,
      path: ETHERSCAN_BASE_PATH,
      query: {
        chainid: String(ETHEREUM_MAINNET_CHAIN_ID),
        module: 'account',
        action: 'balance',
        address,
        tag: 'latest',
        apikey: options.apiKey.reveal(),
      },
      timeoutMs: ETHERSCAN_REQUEST_TIMEOUT_MS,
      signal: options.signal ?? null,
    });

    if (response.status === 429) {
      throw ConnectorError.fromCondition('RATE_LIMITED', 'etherscan rate-limited this request', {
        redactedContext: { host: ETHERSCAN_HOST },
      });
    }
    if (response.status >= 500) {
      throw ConnectorError.fromCondition(
        'PROVIDER_DOWN',
        `etherscan returned ${String(response.status)}`,
        { redactedContext: { host: ETHERSCAN_HOST, status: response.status } },
      );
    }
    if (response.status !== 200) {
      throw ConnectorError.fromCondition(
        'MALFORMED_RESPONSE',
        `etherscan returned an unexpected status ${String(response.status)}`,
        { redactedContext: { host: ETHERSCAN_HOST, status: response.status } },
      );
    }

    const body = response.body as EtherscanBalanceBody | null;
    if (body === null || typeof body !== 'object') {
      throw ConnectorError.fromCondition('MALFORMED_RESPONSE', 'etherscan returned no body');
    }
    if (body.status !== '1') {
      // Etherscan's own error channel: an invalid key, an unrecognised
      // address, a chain not on the free tier (R11). The message is Etherscan's
      // own text, which never contains the key (it is a query param the
      // provider does not echo back).
      throw ConnectorError.fromCondition(
        'INSUFFICIENT_SCOPE',
        `etherscan refused this request: ${String(body.message ?? 'unknown error')}`,
        { redactedContext: { host: ETHERSCAN_HOST } },
      );
    }
    if (typeof body.result !== 'string' || !/^\d+$/.test(body.result)) {
      throw ConnectorError.fromCondition(
        'MALFORMED_RESPONSE',
        'etherscan answered a balance that is not a decimal integer string',
      );
    }
    return BigInt(body.result);
  }

  return { nativeBalanceWei };
}

export type EtherscanClient = ReturnType<typeof createEtherscanClient>;
