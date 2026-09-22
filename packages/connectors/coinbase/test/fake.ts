// SPDX-License-Identifier: MIT
/**
 * `FakeCoinbaseApi` — a transport that **checks the token before it answers**.
 *
 * ## Why the fake sits below the JWT rather than above it
 *
 * The obvious shape for a test double here is an object implementing
 * `CoinbaseApiLike` with five canned answers. That double would be useless for
 * this work package: every security property WP 3.5 is asked to deliver lives in
 * the signing path, and a fake that replaced `CoinbaseClient` would replace the
 * signing path too. A broken `alg`, a reused nonce, a token minted for the wrong
 * `uri` and a signature that does not verify would all ship green.
 *
 * So the seam is `CoinbaseTransport` — the layer *below* the signature — and
 * this object is a small, hostile server:
 *
 *   * it decodes the `Authorization` header and asserts **EdDSA**, `kid`,
 *     `sub`, `iss`, `aud`, a 120-second window, a per-request `nonce`, and the
 *     `uri` claim against the method and path it actually received;
 *   * it **verifies the Ed25519 signature** with `node:crypto` against the
 *     public half of the test key, so a signature over the wrong bytes is a 401
 *     rather than a pass;
 *   * it answers `401 UNAUTHENTICATED` when any of that fails, exactly as the
 *     real service does, which means the adapter's own error map is exercised by
 *     its own bugs.
 *
 * `rejections` records *why* each 401 happened so a test can assert the reason
 * rather than the status, and `tokens` / `nonces` are kept so `jwt.test.ts` can
 * prove freshness across two endpoints and `log-hygiene.test.ts` can grep every
 * artefact for a token that really was minted.
 *
 * ## The fixtures are recorded *shapes*, and the arithmetic in them is the point
 *
 * There is no Coinbase account on this machine. Every field name, nesting and
 * type below comes from 01 §3.3 and the Advanced Trade reference; the *values*
 * are chosen so that the ledger gap is visible and hand-checkable:
 *
 * ```
 *   USD   980.00     − (−9,032.50 traded)  = +10,012.50 unexplained  → deposits
 *   BTC   0.35       − (+0.10 traded)      =      +0.25 unexplained  → a transfer in
 *   ETH   2.05       − (+2.00 traded)      =      +0.05 unexplained  → staking rewards
 * ```
 *
 * Those three residuals are the R6 finding as a number rather than as a
 * paragraph, and `ledger-gap.test.ts` asserts them.
 */
// The test double is the *verifier*. It has to check an Ed25519 signature with
// the same primitive the real service would, or the whole signing path ships
// untested — which is the failure this file's opening comment is about. Same
// carve-out reasoning as `src/jwt.ts`: a signature, not a cipher; no AAD, no
// nonce reuse, no tag comparison.
import { createPrivateKey, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CoinbaseAccountsPage,
  CoinbaseFillsPage,
  CoinbaseHttpResponse,
  CoinbaseKeyPermissions,
  CoinbasePortfoliosResponse,
  CoinbaseRequest,
  CoinbaseTickerResponse,
} from '../src/api.ts';
import {
  CDP_JWT_ALGORITHM,
  CDP_JWT_AUDIENCE,
  CDP_JWT_ISSUER,
  CDP_JWT_LIFETIME_SECONDS,
  COINBASE_API_HOST,
} from '../src/provider.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as T;
}

export const ACCOUNTS_FIXTURE: CoinbaseAccountsPage = fixture('accounts');
export const FILLS_FIXTURE: CoinbaseFillsPage = fixture('fills');
export const PORTFOLIOS_FIXTURE: CoinbasePortfoliosResponse = fixture('portfolios');
export const KEY_PERMISSIONS_FIXTURE: CoinbaseKeyPermissions = fixture('key-permissions');
export const TICKERS_FIXTURE: Readonly<Record<string, CoinbaseTickerResponse>> = fixture('tickers');

// ---------------------------------------------------------------------------
// A key that is not a key
// ---------------------------------------------------------------------------

/**
 * A fixed Ed25519 seed, so a failing run is reproducible and the evidence doc's
 * decoded example is stable. It is thirty-two bytes of nothing; the *public*
 * half is all the fake needs, and the private half exists only inside this
 * process.
 */
const TEST_SEED = Buffer.from(
  '0e1d2c3b4a59687706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a090',
  'hex',
);

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

const testPrivateKey = createPrivateKey({
  key: Buffer.concat([ED25519_PKCS8_PREFIX, TEST_SEED]),
  format: 'der',
  type: 'pkcs8',
});

const testPublicKey = createPublicKey(testPrivateKey);

/** The PEM form, which is one of the three shapes `parseCdpPrivateKey` accepts. */
export const TEST_PRIVATE_KEY_PEM = testPrivateKey
  .export({ type: 'pkcs8', format: 'pem' })
  .toString();

/**
 * The `base64(seed ‖ publicKey)` form the CDP portal actually downloads.
 *
 * Unmistakable on purpose: `log-hygiene.test.ts` greps every artefact for this
 * exact string, and a short or ordinary-looking value would turn a real leak
 * into a test that passes by luck.
 */
export const TEST_PRIVATE_KEY_BASE64 = Buffer.concat([
  TEST_SEED,
  testPublicKey.export({ type: 'spki', format: 'der' }).subarray(-32),
]).toString('base64');

/** A well-formed CDP key name. The uuids are not real and never will be. */
export const TEST_KEY_NAME =
  'organizations/11111111-2222-4333-8444-555555555555/apiKeys/66666666-7777-4888-8999-aaaaaaaaaaaa';

/**
 * An ECDSA key, for the one refusal that is easiest to get wrong.
 *
 * 01 §3.2: "ECDSA is a legacy key algorithm. You should use Ed25519 instead",
 * and Plaid's *webhook* verification is ES256, so the two are adjacent in this
 * codebase. `jwt.test.ts` hands this to `parseCdpPrivateKey` and asserts it is
 * refused rather than signed with.
 */
export const TEST_ECDSA_PRIVATE_KEY_PEM = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly authorization: string | undefined;
  readonly endpoint: string;
}

export interface ScriptedFailure {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface FakeCoinbaseOptions {
  /** Overrides the recorded `key_permissions` answer. The trade/transfer sabotage. */
  readonly permissions?: CoinbaseKeyPermissions;
  /** Endpoint label → the failure it answers with, every time. */
  readonly failures?: Readonly<Record<string, ScriptedFailure>>;
  /** The key name the token's `kid` and `sub` must equal. */
  readonly keyName?: string;
  /** Wall clock, so the 120-second window can be asserted against a fixed now. */
  readonly nowMs?: () => number;
  /** Accounts to answer with, when a test needs a different shape. */
  readonly accounts?: CoinbaseAccountsPage;
  readonly fills?: CoinbaseFillsPage;
  readonly tickers?: Readonly<Record<string, CoinbaseTickerResponse>>;
}

export class FakeCoinbaseApi {
  readonly requests: RecordedRequest[] = [];
  readonly tokens: string[] = [];
  readonly nonces: string[] = [];
  readonly rejections: string[] = [];
  readonly #options: FakeCoinbaseOptions;
  readonly #seenNonces = new Set<string>();

  constructor(options: FakeCoinbaseOptions = {}) {
    this.#options = options;
  }

  /** The `CoinbaseTransport` the client is constructed with. */
  transport = async (request: CoinbaseRequest): Promise<CoinbaseHttpResponse> => {
    const authorization = request.headers['Authorization'];
    const endpoint = endpointOf(request.path);
    this.requests.push({
      method: request.method,
      path: request.path,
      query: request.query,
      authorization,
      endpoint,
    });

    const rejection = this.#verify(request, authorization);
    if (rejection !== null) {
      this.rejections.push(rejection);
      return json(401, {
        error: 'UNAUTHENTICATED',
        message: `the request JWT was rejected: ${rejection}`,
      });
    }

    const scripted = this.#options.failures?.[endpoint];
    if (scripted !== undefined) {
      return {
        status: scripted.status,
        headers: scripted.headers ?? {},
        body: scripted.body,
      };
    }

    return this.#answer(endpoint, request);
  };

  // -------------------------------------------------------------------------

  /** `null` when the token is good; otherwise the reason it is not. */
  #verify(request: CoinbaseRequest, authorization: string | undefined): string | null {
    if (authorization === undefined) return 'no Authorization header';
    if (!authorization.startsWith('Bearer ')) return 'the Authorization header is not a Bearer';
    const token = authorization.slice('Bearer '.length);
    this.tokens.push(token);

    const parts = token.split('.');
    if (parts.length !== 3) return 'not a compact JWS';
    const [rawHeader, rawPayload, signature] = parts as [string, string, string];

    let header: Record<string, unknown>;
    let payload: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(rawHeader, 'base64url').toString('utf8'));
      payload = JSON.parse(Buffer.from(rawPayload, 'base64url').toString('utf8'));
    } catch {
      return 'the header or payload is not JSON';
    }

    const keyName = this.#options.keyName ?? TEST_KEY_NAME;
    const nowSeconds = Math.floor((this.#options.nowMs?.() ?? Date.now()) / 1000);

    if (header['alg'] !== CDP_JWT_ALGORITHM) return `alg is ${String(header['alg'])}, not EdDSA`;
    if (header['typ'] !== 'JWT') return 'typ is not JWT';
    if (header['kid'] !== keyName) return 'kid is not the key name';

    const nonce = header['nonce'];
    if (typeof nonce !== 'string' || nonce.length === 0) return 'no nonce';
    this.nonces.push(nonce);
    if (this.#seenNonces.has(nonce)) return 'the nonce was reused';
    this.#seenNonces.add(nonce);

    if (payload['sub'] !== keyName) return 'sub is not the key name';
    if (payload['iss'] !== CDP_JWT_ISSUER) return 'iss is not cdp';
    const aud = payload['aud'];
    if (!Array.isArray(aud) || aud.length !== 1 || aud[0] !== CDP_JWT_AUDIENCE[0]) {
      return 'aud is not ["cdp_service"]';
    }

    const nbf = payload['nbf'];
    const exp = payload['exp'];
    if (typeof nbf !== 'number' || typeof exp !== 'number') return 'nbf or exp is missing';
    if (exp - nbf !== CDP_JWT_LIFETIME_SECONDS) return `the lifetime is ${exp - nbf}s, not 120s`;
    // One second of slack each way: the clock that minted the token and the
    // clock checking it are the same in tests, but rounding to whole seconds can
    // still straddle a boundary.
    if (nowSeconds + 1 < nbf) return 'the token is not yet valid';
    if (nowSeconds - 1 > exp) return 'the token has expired';

    const expectedUri = `${request.method} ${request.host}${request.path}`;
    if (payload['uri'] !== expectedUri) {
      return `uri is ${JSON.stringify(payload['uri'])}, not ${JSON.stringify(expectedUri)}`;
    }
    if (request.host !== COINBASE_API_HOST) return 'the host is not api.coinbase.com';

    const verified = verify(
      null,
      Buffer.from(`${rawHeader}.${rawPayload}`, 'utf8'),
      testPublicKey,
      Buffer.from(signature, 'base64url'),
    );
    return verified ? null : 'the Ed25519 signature does not verify';
  }

  #answer(endpoint: string, request: CoinbaseRequest): CoinbaseHttpResponse {
    switch (endpoint) {
      case 'key_permissions':
        return json(200, this.#options.permissions ?? KEY_PERMISSIONS_FIXTURE);
      case 'accounts':
        return json(200, this.#options.accounts ?? ACCOUNTS_FIXTURE);
      case 'portfolios':
        return json(200, PORTFOLIOS_FIXTURE);
      case 'orders/historical/fills':
        return json(200, this.#fillsSince(request.query['start_sequence_timestamp']));
      case 'products/{product_id}/ticker': {
        const productId = request.path.split('/').at(-2) ?? '';
        const tickers = this.#options.tickers ?? TICKERS_FIXTURE;
        const ticker = tickers[productId];
        if (ticker === undefined) {
          return json(404, { error: 'NOT_FOUND', message: 'no such product' });
        }
        return json(200, ticker);
      }
      default:
        return json(404, { error: 'NOT_FOUND', message: 'no such endpoint' });
    }
  }

  /**
   * Real `start_sequence_timestamp` filtering.
   *
   * Not decoration: the on-ramp inference subtracts only the trades *inside* the
   * window, and a fake that ignored the parameter would return the ETH buy from
   * June as well, which would make the residual arithmetic pass for the wrong
   * reason.
   */
  #fillsSince(since: string | undefined): CoinbaseFillsPage {
    const all = this.#options.fills ?? FILLS_FIXTURE;
    if (since === undefined) return all;
    const from = new Date(since).getTime();
    return {
      ...all,
      fills: all.fills.filter((fill) => new Date(fill.trade_time).getTime() >= from),
    };
  }
}

function json(status: number, body: unknown): CoinbaseHttpResponse {
  return { status, headers: { 'content-type': 'application/json' }, body };
}

/** The same collapse `client.ts` does, so `failures` is keyed on one vocabulary. */
export function endpointOf(path: string): string {
  const relative = path.replace('/api/v3/brokerage/', '');
  return relative.replace(/^products\/[^/]+\/ticker$/, 'products/{product_id}/ticker');
}
