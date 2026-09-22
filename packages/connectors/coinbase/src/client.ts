// SPDX-License-Identifier: MIT
/**
 * The signed request. Five GETs, one allow-list, one fresh token each.
 *
 * ## The three controls that live in this file
 *
 * 1. **`assertReadOnlyPath` runs before the token is minted.** Not after, not in
 *    the transport, not in a comment: a path that is not one of
 *    `COINBASE_READ_ONLY_PATHS` never becomes a signed request, so the failure
 *    mode of a future edit that adds `/orders` is a `ConnectorError` in a test
 *    rather than a live order. The method is typed `'GET'` and has no other
 *    member, so "read-only" is also a type, not only a check.
 * 2. **One JWT per request, minted here, discarded here.** `mintCdpJwt` has no
 *    cache to reuse from (see `jwt.ts`), and the `Authorization` header is built
 *    inside `#call`'s scope and dropped when it returns. The header never
 *    reaches the logger, the error map, or a `cause`.
 * 3. **The private key exists for the length of one signature.** It is parsed
 *    from the sealed material inside `#call`, handed to `mintCdpJwt`, and
 *    garbage on the next tick. There is no field, no module-level cache and no
 *    memoisation keyed on the key name — a cache is a place a credential
 *    survives a request, and this is a package whose entire job is to hold one
 *    for as short a time as possible.
 *
 * ## What is logged
 *
 * `{ provider, endpoint, httpStatus }` on success and
 * `{ provider, endpoint, kind, condition, providerCode }` on failure. Not the
 * query, not the headers, not the body, and — the one that matters — not the
 * token. `log-hygiene.test.ts` asserts the exact key sets, so adding a field is
 * a decision somebody has to make on purpose.
 */
import { ConnectorError } from '@connector/port';
import type { Clock } from '@core/kernel';
import {
  asCoinbaseTransportError,
  coinbaseErrorShapeOf,
  mapCoinbaseError,
  retryAfterMsOf,
} from './errors.ts';
import { mintCdpJwt, parseCdpPrivateKey } from './jwt.ts';
import {
  silentCoinbaseLogger,
  type CoinbaseAccountsPage,
  type CoinbaseApiLike,
  type CoinbaseFillsPage,
  type CoinbaseHttpResponse,
  type CoinbaseKeyPermissions,
  type CoinbaseLogger,
  type CoinbasePortfoliosResponse,
  type CoinbaseRequest,
  type CoinbaseTickerResponse,
  type CoinbaseTransport,
} from './api.ts';
import {
  COINBASE_API_HOST,
  COINBASE_BROKERAGE_PREFIX,
  COINBASE_PROVIDER,
  COINBASE_READ_ONLY_PATHS,
  COINBASE_REQUEST_TIMEOUT_MS,
  coinbaseTickerPath,
} from './provider.ts';

/**
 * The sealed pair, opened for one call.
 *
 * Passed by value rather than read from a store, because the only component that
 * may open `sealed_credentials` is `@ctx/connections` and the only thing this
 * package should be able to do with the result is sign with it.
 */
export interface CoinbaseCredentials {
  /** `organizations/{org}/apiKeys/{key}`. Becomes `kid` and `sub`. */
  readonly keyName: string;
  /** The PEM or the base64 key bytes, exactly as the CDP portal handed them over. */
  readonly privateKeyMaterial: string;
}

export interface CoinbaseClientOptions {
  readonly transport: CoinbaseTransport;
  readonly credentials: CoinbaseCredentials;
  readonly clock: Clock;
  readonly logger?: CoinbaseLogger;
  readonly signal?: AbortSignal | null;
  readonly timeoutMs?: number;
}

/**
 * The complete set of request paths this package may construct, as a predicate.
 *
 * `{product_id}` is matched structurally rather than by prefix. A prefix check
 * would admit `/orders/historical/fills` **and** `/orders`, which is exactly the
 * pair the allow-list exists to separate.
 */
export function isReadOnlyPath(path: string): boolean {
  if (COINBASE_READ_ONLY_PATHS.includes(path as (typeof COINBASE_READ_ONLY_PATHS)[number])) {
    return true;
  }
  const ticker = /^\/api\/v3\/brokerage\/products\/([A-Za-z0-9._-]{1,32})\/ticker$/.exec(path);
  return ticker !== null;
}

/**
 * Refuse a path that is not on the allow-list.
 *
 * `permanent`, not `invalid_input`: reaching here means the *adapter* tried to
 * build a request it is not permitted to build, which is a defect in this
 * package and not something a user can fix by re-entering a key. It must stop
 * the run and be loud.
 */
export function assertReadOnlyPath(path: string): void {
  if (isReadOnlyPath(path)) return;
  throw new ConnectorError(
    `the coinbase adapter tried to build a request to ${path}, which is not one of its ` +
      'read-only paths. This connector is read-only by construction: the allow-list is the ' +
      'control, and a path that is not on it never becomes a signed request.',
    {
      kind: 'permanent',
      condition: 'INTERNAL',
      redactedContext: { path, allowed: COINBASE_READ_ONLY_PATHS.length },
    },
  );
}

export class CoinbaseClient implements CoinbaseApiLike {
  readonly #transport: CoinbaseTransport;
  readonly #credentials: CoinbaseCredentials;
  readonly #clock: Clock;
  readonly #logger: CoinbaseLogger;
  readonly #signal: AbortSignal | null;
  readonly #timeoutMs: number;

  constructor(options: CoinbaseClientOptions) {
    this.#transport = options.transport;
    this.#credentials = options.credentials;
    this.#clock = options.clock;
    this.#logger = options.logger ?? silentCoinbaseLogger;
    this.#signal = options.signal ?? null;
    this.#timeoutMs = options.timeoutMs ?? COINBASE_REQUEST_TIMEOUT_MS;
  }

  async keyPermissions(): Promise<CoinbaseKeyPermissions> {
    return this.#get<CoinbaseKeyPermissions>(`${COINBASE_BROKERAGE_PREFIX}/key_permissions`, {});
  }

  async accounts(options: {
    readonly cursor: string | null;
    readonly limit: number;
  }): Promise<CoinbaseAccountsPage> {
    return this.#get<CoinbaseAccountsPage>(`${COINBASE_BROKERAGE_PREFIX}/accounts`, {
      limit: String(options.limit),
      ...(options.cursor === null ? {} : { cursor: options.cursor }),
    });
  }

  async portfolios(): Promise<CoinbasePortfoliosResponse> {
    return this.#get<CoinbasePortfoliosResponse>(`${COINBASE_BROKERAGE_PREFIX}/portfolios`, {});
  }

  async fills(options: {
    readonly cursor: string | null;
    readonly limit: number;
    readonly startSequenceTimestamp: string | null;
  }): Promise<CoinbaseFillsPage> {
    return this.#get<CoinbaseFillsPage>(`${COINBASE_BROKERAGE_PREFIX}/orders/historical/fills`, {
      limit: String(options.limit),
      ...(options.cursor === null ? {} : { cursor: options.cursor }),
      ...(options.startSequenceTimestamp === null
        ? {}
        : { start_sequence_timestamp: options.startSequenceTimestamp }),
    });
  }

  async ticker(productId: string): Promise<CoinbaseTickerResponse> {
    // `limit=1` is the smallest legal ask: the most recent trade is the
    // exchange's own last price, which is 07 §6.1's "exchange fill" rung.
    return this.#get<CoinbaseTickerResponse>(coinbaseTickerPath(productId), { limit: '1' });
  }

  // -------------------------------------------------------------------------

  /**
   * One request: assert, sign, send, classify.
   *
   * The order is the point. `assertReadOnlyPath` runs first so a forbidden path
   * cannot even be signed; `mintCdpJwt` runs second so the token is bound to
   * this exact method and path; the transport runs third and never sees a key.
   */
  async #get<T>(path: string, query: Readonly<Record<string, string>>): Promise<T> {
    assertReadOnlyPath(path);
    const endpoint = endpointLabelOf(path);

    const request: CoinbaseRequest = {
      method: 'GET',
      host: COINBASE_API_HOST,
      path,
      query,
      headers: {
        // Scoped to this object literal and this call. Nothing retains it: the
        // logger is handed a fixed set of fields below, and `errors.ts` never
        // attaches a cause.
        Authorization: `Bearer ${this.#sign(path)}`,
        Accept: 'application/json',
      },
      signal: this.#signal,
      timeoutMs: this.#timeoutMs,
    };

    let response: CoinbaseHttpResponse;
    try {
      response = await this.#transport(request);
    } catch (cause) {
      throw this.#failed(endpoint, asCoinbaseTransportError(cause, endpoint));
    }

    if (response.status < 200 || response.status >= 300) {
      throw this.#failed(
        endpoint,
        mapCoinbaseError(coinbaseErrorShapeOf(response.body, response.status), {
          endpoint,
          retryAfterMs: retryAfterMsOf(response.headers),
        }),
      );
    }

    if (response.body === null || typeof response.body !== 'object') {
      throw this.#failed(
        endpoint,
        ConnectorError.fromCondition(
          'MALFORMED_RESPONSE',
          `coinbase ${endpoint} answered ${response.status} with a body that is not an object`,
          { redactedContext: { endpoint, httpStatus: response.status } },
        ),
      );
    }

    this.#logger.debug(
      { provider: COINBASE_PROVIDER, endpoint, httpStatus: response.status },
      'coinbase request',
    );
    return response.body as T;
  }

  /**
   * Mint one token for one request.
   *
   * The `KeyObject` is a local. It is created here, used on the next line and
   * unreachable when this method returns — which is the whole of this package's
   * key custody, and it is four lines long on purpose.
   */
  #sign(path: string): string {
    const privateKey = parseCdpPrivateKey(this.#credentials.privateKeyMaterial);
    return mintCdpJwt({
      keyName: this.#credentials.keyName,
      privateKey,
      method: 'GET',
      host: COINBASE_API_HOST,
      path,
      nowMs: this.#clock.nowMs(),
    });
  }

  /** Log the classification — five fields, no payload — and hand the error on. */
  #failed(endpoint: string, error: ConnectorError): ConnectorError {
    this.#logger.warn(
      {
        provider: COINBASE_PROVIDER,
        endpoint,
        kind: error.kind,
        condition: error.condition,
        providerCode: error.providerCode,
      },
      'coinbase request failed',
    );
    return error;
  }
}

/**
 * The endpoint name that appears in logs and in `redactedContext`.
 *
 * A product id is not a secret, but it is user data — which coins somebody
 * holds — so the ticker path is collapsed to `products/{product_id}/ticker`
 * rather than logged verbatim. Everything else is already a constant.
 */
export function endpointLabelOf(path: string): string {
  const relative = path.startsWith(COINBASE_BROKERAGE_PREFIX)
    ? path.slice(COINBASE_BROKERAGE_PREFIX.length + 1)
    : path;
  return relative.replace(/^products\/[^/]+\/ticker$/, 'products/{product_id}/ticker');
}

/**
 * The production transport: `fetch`, pinned, with no room to be redirected.
 *
 * Every option here is a refusal:
 *
 *   * **`redirect: 'error'`** — a 302 is how an SSRF gets out of an allow-list
 *     (WP 3.4's `'a 302 to an internal host is not followed'`, applied to the
 *     one egress this package has). There is no legitimate redirect on a signed
 *     Coinbase API call: the token is bound to `"{METHOD} {host}{path}"` and
 *     would be invalid at the destination anyway, so following one could only
 *     ever leak the `Authorization` header to somewhere it does not belong.
 *   * **`https` and `COINBASE_API_HOST`, from constants** — the URL is built
 *     here from the host in the JWT's own `uri` claim, so the thing we signed
 *     for and the thing we connect to cannot drift apart.
 *   * **a timeout with its own `AbortController`**, merged with the run's signal,
 *     so a hung socket cannot outlive the sync's deadline.
 */
export function fetchTransport(): CoinbaseTransport {
  return async (request: CoinbaseRequest): Promise<CoinbaseHttpResponse> => {
    const url = new URL(`https://${request.host}${request.path}`);
    for (const [key, value] of Object.entries(request.query)) url.searchParams.set(key, value);

    const timer = new AbortController();
    const timeout = setTimeout(() => timer.abort(), request.timeoutMs);
    const signals = request.signal === null ? [timer.signal] : [timer.signal, request.signal];
    try {
      const response = await fetch(url, {
        method: request.method,
        headers: { ...request.headers },
        redirect: 'error',
        signal: AbortSignal.any(signals),
      });
      const text = await response.text();
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      return { status: response.status, headers, body: parseJsonOrNull(text) };
    } finally {
      clearTimeout(timeout);
    }
  };
}

function parseJsonOrNull(text: string): unknown {
  if (text.trim().length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
