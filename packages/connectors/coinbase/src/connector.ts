// SPDX-License-Identifier: MIT
/**
 * `CoinbaseConnector` — the port, over Advanced Trade v3, read-only by construction.
 *
 * ## The scope assertion is the product
 *
 * 01 §3.2: "Verify at runtime via `GET /api/v3/brokerage/key_permissions` and
 * **refuse to start** if the key has `can_trade` or `can_transfer` — cheap,
 * high-value defense for a self-hosted app holding exchange credentials." The
 * dispatch sharpens it to "asserted **at startup and again before every sync**",
 * and this class does exactly that: `#assertViewOnly` is the first line of
 * `connect`, `listAccounts`, all four sync legs and `health`. There is **no
 * cache** of the answer, deliberately. A cache would make the second half of
 * that sentence untrue the moment a key's permissions were widened in the CDP
 * portal between two nightly runs, which is precisely the window a "we checked
 * at boot" control cannot see. The cost is one extra GET per leg; the value is
 * that the control is the one that was specified.
 *
 * ## What this class deliberately does not do
 *
 * - **It does not hold the key.** Not on `this`, not in a module cache. Every
 *   method reads both halves from `handle.secret(...)`, builds a short-lived
 *   `CoinbaseClient`, and drops it when the method returns. `client.ts` parses
 *   the private key once per *request* and drops the `KeyObject` on the next
 *   tick.
 * - **It does not write.** `COINBASE_READ_ONLY_PATHS` is a five-element
 *   allow-list, the request method is the literal type `'GET'`, and
 *   `no-trade-surface.test.ts` drives every public method and asserts the
 *   recorded requests. A trading endpoint does not appear in this package.
 * - **It does not express a trade as spending.** Fills become investment
 *   transactions; the only `ProviderTransactionFact` it emits is the inferred
 *   fiat transfer in `ledger.ts`.
 * - **It does not decide retry policy.** `errors.ts` classifies and stops.
 *
 * ## Revocation, honestly
 *
 * `disconnect` has nothing to call. A CDP key is revoked by its owner in the CDP
 * portal, and there is no v3 endpoint that revokes one — and if there were, it
 * would be a *write*, which this connector refuses by construction. So
 * `disconnect` logs and returns, and the revocation that matters is the caller's:
 * `@ctx/connections` purges `sealed_credentials`, after which every method here
 * fails `invalid_input` because the handle hands back `null`. That is what the
 * conformance suite's `disconnect/revokes` observes, and the evidence doc says
 * so rather than implying a revocation we do not perform.
 */
import {
  ConnectorError,
  assertSupports,
  windowStart,
  type Capability,
  type ConnectResult,
  type ConnectionHandle,
  type Connector,
  type ConnectorCapabilities,
  type ConnectorHealth,
  type Cursor,
  type ProviderAccountFact,
  type ProviderBalanceFact,
  type ProviderHoldingFact,
  type ProviderInvestmentTransactionFact,
  type SyncOptions,
  type TransactionPage,
} from '@connector/port';
import { todayIn, type Clock } from '@core/kernel';
import {
  silentCoinbaseLogger,
  type CoinbaseAccount,
  type CoinbaseFill,
  type CoinbaseLogger,
  type CoinbaseTransport,
} from './api.ts';
import { CoinbaseClient, type CoinbaseCredentials } from './client.ts';
import { decodeWatermark, encodeWatermark } from './cursor.ts';
import { parseCdpPrivateKey } from './jwt.ts';
import { inferOnRampTransfers } from './ledger.ts';
import {
  accountFactOf,
  accountIdByAssetOf,
  assetCodeOf,
  balanceFactOf,
  holdingFactOf,
  investmentTransactionFactOf,
  isFiatAccount,
  totalBalanceOf,
} from './map.ts';
import {
  CDP_KEY_NAME,
  CDP_KEY_NAME_PATTERN,
  CDP_PRIVATE_KEY,
  COINBASE_MANIFEST,
  COINBASE_MAX_ACCOUNTS_PAGE_SIZE,
  COINBASE_MAX_FILLS_PAGE_SIZE,
  COINBASE_MAX_PAGES,
  COINBASE_PROVIDER,
  coinbaseCapabilities,
  coinbaseProductIdOf,
} from './provider.ts';

export interface CoinbaseConnectorOptions {
  readonly transport: CoinbaseTransport;
  /**
   * Needed for `ConnectorHealth.checkedAt` and for the JWT's `nbf`/`exp`, which
   * `SyncOptions` cannot supply because `connect` and `health` do not take one.
   * `Date.now()` is lint-banned outside `@core/kernel` (the same port gap
   * `wp1.3-plaid.md` §8 reported).
   */
  readonly clock: Clock;
  readonly logger?: CoinbaseLogger;
}

/**
 * What `connect` accepts: the two fields of the CDP key form.
 *
 * Validated by hand rather than with zod, because zod is not on this package's
 * boundary allow-list (`scripts/eslint-boundaries.js`, the `connector-coinbase`
 * layer) and two fields do not justify widening it. The failure is
 * `invalid_input`, which the conformance suite asserts, and the error **never
 * echoes the input**: a malformed key form still contains a real private key.
 */
export interface CoinbaseConnectInput {
  readonly keyName: string;
  readonly privateKey: string;
}

export class CoinbaseConnector implements Connector {
  readonly provider = COINBASE_PROVIDER;
  readonly displayName = COINBASE_MANIFEST.displayName;
  readonly #transport: CoinbaseTransport;
  readonly #clock: Clock;
  readonly #logger: CoinbaseLogger;

  constructor(options: CoinbaseConnectorOptions) {
    this.#transport = options.transport;
    this.#clock = options.clock;
    this.#logger = options.logger ?? silentCoinbaseLogger;
  }

  capabilities(): ConnectorCapabilities {
    return coinbaseCapabilities();
  }

  // -------------------------------------------------------------------------
  // Linking
  // -------------------------------------------------------------------------

  /**
   * Validate the key, prove it is read-only, and describe what it can see.
   *
   * The order matters and is the security core of this work package:
   *
   *   1. the key *name* is checked against its documented shape, so a user who
   *      pasted the private key into the name box is rejected before that
   *      material becomes a `kid` header field on the wire;
   *   2. the private key is parsed, which is where an ECDSA key is refused by
   *      name (`jwt.ts`) rather than silently signing ES256;
   *   3. `key_permissions` is asked, and a key that can trade or transfer is
   *      refused **before any data call** — no balance, no fill, nothing;
   *   4. only then do `/portfolios` and `/accounts` run.
   */
  async connect(input: unknown): Promise<ConnectResult> {
    const credentials = parseConnectInput(input);
    const client = this.#clientWith(credentials, null);
    await this.#assertViewOnly(client);

    const portfolios = await client.portfolios();
    const portfolio = portfolios.portfolios.find((candidate) => candidate.deleted !== true);
    if (portfolio === undefined || typeof portfolio.uuid !== 'string') {
      throw ConnectorError.fromCondition(
        'MALFORMED_RESPONSE',
        'coinbase reported no portfolio for this key, so there is nothing to connect',
        { redactedContext: { endpoint: 'portfolios' } },
      );
    }

    const accounts = await this.#allAccounts(client);
    return {
      providerConnectionId: portfolio.uuid,
      displayName: `Coinbase — ${portfolio.name}`,
      // Handed over once. `@ctx/connections` seals both with `SecretBox` and
      // they are never returned to a caller again.
      credentials: {
        [CDP_KEY_NAME]: credentials.keyName,
        [CDP_PRIVATE_KEY]: credentials.privateKeyMaterial,
      },
      accounts: accounts.map(accountFactOf),
      observedCapabilities: this.#observedCapabilitiesOf(accounts),
      // A CDP key does not expire. It is revoked, by its owner, in the portal.
      consentExpiresAt: null,
    };
  }

  // -------------------------------------------------------------------------
  // Sync
  // -------------------------------------------------------------------------

  async listAccounts(handle: ConnectionHandle): Promise<readonly ProviderAccountFact[]> {
    const client = this.#clientFor(handle, null);
    await this.#assertViewOnly(client);
    return (await this.#allAccounts(client)).map(accountFactOf);
  }

  /**
   * One page — and there is only ever one.
   *
   * v3 has no cash-movement stream, so what this returns is the delta between
   * the watermark in the cursor and the balances right now, minus the trades
   * that explain part of it (`ledger.ts`). `hasMore` is therefore always
   * `false` and `nextCursor` is the new watermark, which the orchestrator
   * commits in the same transaction as the page — the cursor contract's rule 2,
   * which matters here exactly as much as it does for a provider stream: a
   * watermark advanced outside the write transaction would silently skip a
   * deposit forever.
   */
  async syncTransactions(
    handle: ConnectionHandle,
    cursor: Cursor | null,
    options: SyncOptions,
  ): Promise<TransactionPage> {
    this.#assertBudget(options, 'transactions');
    const previous = cursor === null ? null : decodeWatermark(cursor);
    const client = this.#clientFor(handle, options);
    await this.#assertViewOnly(client);

    const accounts = await this.#allAccounts(client);
    const fills =
      previous === null ? [] : await this.#allFills(client, options, { since: previous.at });

    const { transfers, watermark } = inferOnRampTransfers({
      previous,
      accounts,
      fills,
      clock: options.clock,
    });

    return {
      added: transfers,
      modified: [],
      // Nothing is ever removed: an inferred observation is not retracted, it is
      // superseded by the next one. Emitting a removal would tell the ledger to
      // delete a transfer the user may have paired with a bank leg by hand.
      removed: [],
      accounts: accounts.map(accountFactOf),
      nextCursor: encodeWatermark(watermark),
      hasMore: false,
    };
  }

  async syncBalances(
    handle: ConnectionHandle,
    options: SyncOptions,
  ): Promise<readonly ProviderBalanceFact[]> {
    assertSupports(this.provider, this.capabilities(), 'balances');
    this.#assertBudget(options, 'balances');
    const client = this.#clientFor(handle, options);
    await this.#assertViewOnly(client);

    const accounts = await this.#allAccounts(client);
    const prices = await this.#pricesFor(client, accounts);
    const asOf = options.clock.now();
    return accounts.map((account) =>
      balanceFactOf(
        account,
        isFiatAccount(account) ? null : (prices.get(assetCodeOf(account)) ?? null),
        asOf,
      ),
    );
  }

  async syncHoldings(
    handle: ConnectionHandle,
    options: SyncOptions,
  ): Promise<readonly ProviderHoldingFact[]> {
    assertSupports(this.provider, this.capabilities(), 'holdings');
    this.#assertBudget(options, 'holdings');
    const client = this.#clientFor(handle, options);
    await this.#assertViewOnly(client);

    const accounts = await this.#allAccounts(client);
    const prices = await this.#pricesFor(client, accounts);
    const asOf = options.clock.now();
    const holdings: ProviderHoldingFact[] = [];
    for (const account of accounts) {
      // A fiat wallet is cash, and its balance is already an account balance.
      // Emitting it as a holding too would count the same dollars twice in the
      // one place — net worth — where double counting is least visible.
      if (isFiatAccount(account)) continue;
      if (String(totalBalanceOf(account)) === '0') continue;
      const price = prices.get(assetCodeOf(account));
      if (price === undefined) continue;
      holdings.push(holdingFactOf(account, price, asOf));
    }
    return holdings;
  }

  /**
   * Fills, by date window. **No cursor**, like every other adapter's.
   *
   * The window is `min(historyDays, historyWindowDays)` back from today, and
   * idempotency is `providerTransactionId` — Coinbase's `entry_id`. The paging
   * cursor inside the loop is Coinbase's own and never escapes this method: the
   * port's cursor is about *committing* a delta, and handing a caller a paging
   * token it must not persist is the mistake rule 2 exists to prevent.
   */
  async syncInvestmentTransactions(
    handle: ConnectionHandle,
    options: SyncOptions,
  ): Promise<readonly ProviderInvestmentTransactionFact[]> {
    assertSupports(this.provider, this.capabilities(), 'investment_txns');
    this.#assertBudget(options, 'investment_txns');
    const client = this.#clientFor(handle, options);
    await this.#assertViewOnly(client);

    const accounts = await this.#allAccounts(client);
    const byAsset = accountIdByAssetOf(accounts);
    // UTC, deliberately: this bounds a provider's window, not a user-facing
    // period boundary. A day of slack on a 730-day window is not a correctness
    // question, and claiming to know the user's zone down here would be.
    const today = todayIn(options.clock, 'UTC');
    const start = windowStart(this.capabilities(), options.historyDays, today) ?? today;
    const fills = await this.#allFills(client, options, { since: `${start}T00:00:00.000Z` });
    return fills.map((fill) => investmentTransactionFactOf(fill, byAsset));
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * There is nothing to revoke here, and saying so is the honest answer.
   *
   * See the class comment. This logs one line naming the connection and returns;
   * it never throws, because a provider that cannot be told must not be able to
   * stop a user from disconnecting.
   */
  async disconnect(handle: ConnectionHandle): Promise<void> {
    this.#logger.warn(
      { provider: COINBASE_PROVIDER, connectionId: handle.connectionId },
      'coinbase has no key-revocation endpoint; the key must be deleted at portal.cdp.coinbase.com, ' +
        'and the sealed credentials are purged locally by the caller',
    );
  }

  /**
   * The cheap probe — and, deliberately, the scope assertion again.
   *
   * `key_permissions` consumes no refresh budget and touches no balance, so it
   * satisfies 08 §2.3's "must not consume refresh budget" while being the one
   * call that can answer both questions the connection-detail screen has: is
   * Coinbase reachable, and is this key still read-only?
   *
   * A **scope** failure throws rather than reporting `reachable: false`. That is
   * a deliberate divergence from `PlaidConnector.health`, which reports every
   * failure: a key that has acquired `can_trade` is not an unhealthy connection,
   * it is a connection we refuse to operate, and returning it as a soft
   * "unreachable" would let a caller retry it forever. Transport and provider
   * failures still report.
   */
  async health(handle: ConnectionHandle): Promise<ConnectorHealth> {
    const checkedAt = this.#clock.now();
    const client = this.#clientFor(handle, null);
    try {
      const permissions = await this.#assertViewOnly(client);
      return {
        reachable: true,
        checkedAt,
        detail: `can_view=${String(permissions.can_view ?? false)}`,
      };
    } catch (cause) {
      if (cause instanceof ConnectorError && cause.condition === 'INSUFFICIENT_SCOPE') throw cause;
      return {
        reachable: false,
        checkedAt,
        detail:
          cause instanceof ConnectorError
            ? (cause.providerCode ?? cause.condition ?? cause.kind)
            : 'unreachable',
      };
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * **The refusal.** `can_trade` or `can_transfer` stops the run, permanently.
   *
   * `INSUFFICIENT_SCOPE` maps to `permanent` (the port's `KIND_OF_CONDITION`),
   * which means `retryable: false, userActionRequired: true`: the orchestrator
   * stops, the connection shows a banner, and no further request is signed with
   * that key. The message names *which* permission, because "create a new
   * view-only key" is only actionable if the user is told what is wrong with
   * this one — and a permission name is not a secret.
   *
   * A key that is not even `can_view` is refused by the same path: it cannot do
   * the job, and letting it through would produce a stream of 403s that look
   * like an outage.
   */
  async #assertViewOnly(client: CoinbaseClient): Promise<{
    readonly can_view?: boolean;
    readonly can_trade?: boolean;
    readonly can_transfer?: boolean;
  }> {
    const permissions = await client.keyPermissions();
    const forbidden: string[] = [];
    if (permissions.can_trade === true) forbidden.push('can_trade');
    if (permissions.can_transfer === true) forbidden.push('can_transfer');

    if (forbidden.length > 0) {
      throw ConnectorError.fromCondition(
        'INSUFFICIENT_SCOPE',
        `this CDP key carries ${forbidden.join(' and ')}. PersonalFi refuses to hold an exchange ` +
          'credential that can move money: create a key with view permission only at ' +
          'portal.cdp.coinbase.com and reconnect. Nothing was read with this key.',
        { providerCode: 'KEY_NOT_READ_ONLY', redactedContext: { forbidden } },
      );
    }
    if (permissions.can_view !== true) {
      throw ConnectorError.fromCondition(
        'INSUFFICIENT_SCOPE',
        'this CDP key does not carry can_view, so it cannot read anything. Create a view-only ' +
          'key at portal.cdp.coinbase.com and reconnect.',
        { providerCode: 'KEY_CANNOT_VIEW', redactedContext: { forbidden: [] } },
      );
    }
    return permissions;
  }

  /** Every account, paged. `/accounts` defaults to 49 per page and caps at 250. */
  async #allAccounts(client: CoinbaseClient): Promise<readonly CoinbaseAccount[]> {
    const accounts: CoinbaseAccount[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < COINBASE_MAX_PAGES; page += 1) {
      const answer = await client.accounts({
        cursor,
        limit: COINBASE_MAX_ACCOUNTS_PAGE_SIZE,
      });
      accounts.push(...answer.accounts);
      cursor =
        answer.has_next === true && answer.cursor !== undefined && answer.cursor !== ''
          ? answer.cursor
          : null;
      if (cursor === null) return accounts;
    }
    throw this.#exhausted('accounts');
  }

  /** Every fill since an instant, paged. */
  async #allFills(
    client: CoinbaseClient,
    options: SyncOptions,
    window: { readonly since: string },
  ): Promise<readonly CoinbaseFill[]> {
    const fills: CoinbaseFill[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < COINBASE_MAX_PAGES; page += 1) {
      this.#assertBudget(options, 'orders/historical/fills');
      const answer = await client.fills({
        cursor,
        limit: COINBASE_MAX_FILLS_PAGE_SIZE,
        startSequenceTimestamp: window.since,
      });
      fills.push(...answer.fills);
      cursor = answer.cursor === undefined || answer.cursor === '' ? null : answer.cursor;
      if (cursor === null || answer.fills.length === 0) return fills;
    }
    throw this.#exhausted('orders/historical/fills');
  }

  /**
   * One ticker call per distinct crypto asset with a non-zero balance.
   *
   * A zero balance is worth zero at any price, so a dust wallet costs no
   * request. An asset with a balance and **no price** is a loud
   * `DATA_UNAVAILABLE` naming the asset rather than a silent zero: 08 §2.2's
   * whole argument is that an empty answer is indistinguishable from "this
   * account holds nothing", and a position valued at $0.00 is that failure with
   * a decimal point on it. WP 3.4's `PriceSource` is what eventually makes this
   * connector's ticker a fallback rather than the only source.
   */
  async #pricesFor(
    client: CoinbaseClient,
    accounts: readonly CoinbaseAccount[],
  ): Promise<ReadonlyMap<string, string>> {
    const assets = new Set<string>();
    for (const account of accounts) {
      if (isFiatAccount(account)) continue;
      if (String(totalBalanceOf(account)) === '0') continue;
      assets.add(assetCodeOf(account));
    }

    const prices = new Map<string, string>();
    for (const asset of [...assets].sort()) {
      const ticker = await client.ticker(coinbaseProductIdOf(asset));
      const price = ticker.trades?.[0]?.price ?? ticker.best_ask ?? ticker.best_bid ?? null;
      if (typeof price !== 'string' || price.trim().length === 0) {
        throw ConnectorError.fromCondition(
          'DATA_UNAVAILABLE',
          `coinbase quotes no USD price for ${asset}, so the position cannot be valued. It is ` +
            'reported as unavailable rather than as zero: a position worth $0.00 disappears from ' +
            'net worth silently, which is the one outcome an honest adapter must not produce.',
          { redactedContext: { asset, productId: coinbaseProductIdOf(asset) } },
        );
      }
      prices.set(asset, price.trim());
    }
    return prices;
  }

  /** Narrow the declared set by what this key can actually see. */
  #observedCapabilitiesOf(accounts: readonly CoinbaseAccount[]): readonly Capability[] {
    const declared = new Set(this.capabilities().supports);
    const observed = new Set<Capability>(['accounts', 'balances']);
    if (accounts.some((account) => isFiatAccount(account))) {
      observed.add('transactions');
      observed.add('incremental_sync');
    }
    if (accounts.some((account) => !isFiatAccount(account))) {
      observed.add('holdings');
      observed.add('investment_txns');
    }
    return [...observed].filter((capability) => declared.has(capability));
  }

  #clientFor(handle: ConnectionHandle, options: SyncOptions | null): CoinbaseClient {
    return this.#clientWith(credentialsFrom(handle), options);
  }

  #clientWith(credentials: CoinbaseCredentials, options: SyncOptions | null): CoinbaseClient {
    return new CoinbaseClient({
      transport: this.#transport,
      credentials,
      clock: options?.clock ?? this.#clock,
      logger: this.#logger,
      signal: options?.signal ?? null,
    });
  }

  #exhausted(endpoint: string): ConnectorError {
    return ConnectorError.fromCondition(
      'MALFORMED_RESPONSE',
      `coinbase ${endpoint} was still paging after ${COINBASE_MAX_PAGES} pages`,
      { redactedContext: { endpoint, pages: COINBASE_MAX_PAGES } },
    );
  }

  /**
   * The port's "hard budget": raise, never truncate silently.
   *
   * A truncated page looks exactly like a provider with no more data, and the
   * orchestrator would commit the watermark and move on — which here would mean
   * a deposit that is never seen again by anything.
   */
  #assertBudget(options: SyncOptions, endpoint: string): void {
    if (options.signal.aborted) {
      throw new ConnectorError(`coinbase ${endpoint} aborted before it was sent`, {
        kind: 'transient',
        redactedContext: { endpoint, reason: 'aborted' },
      });
    }
    if (options.clock.nowMs() > options.deadline.getTime()) {
      throw new ConnectorError(`coinbase ${endpoint} passed the run's deadline`, {
        kind: 'transient',
        redactedContext: { endpoint, reason: 'deadline' },
      });
    }
  }
}

/**
 * Both halves, read fresh from the sealed store on every call.
 *
 * A missing credential is `invalid_input`, not `auth_required`: a connection row
 * whose sealed blob does not hold the names this adapter asks for is a wiring
 * bug or a half-finished purge, and sending the user to re-enter a key would not
 * repair it. The error names the *key*, which is a constant, never the value.
 */
export function credentialsFrom(handle: ConnectionHandle): CoinbaseCredentials {
  const keyName = handle.secret(CDP_KEY_NAME);
  const privateKeyMaterial = handle.secret(CDP_PRIVATE_KEY);
  const missing =
    keyName === null || keyName.length === 0
      ? CDP_KEY_NAME
      : privateKeyMaterial === null || privateKeyMaterial.length === 0
        ? CDP_PRIVATE_KEY
        : null;
  if (missing !== null || keyName === null || privateKeyMaterial === null) {
    throw new ConnectorError('this connection holds no CDP key', {
      kind: 'invalid_input',
      condition: 'CONFIG_ERROR',
      redactedContext: { connectionId: handle.connectionId, credential: missing },
    });
  }
  return { keyName, privateKeyMaterial };
}

/**
 * Validate the key form. The error never echoes the input.
 *
 * `parseCdpPrivateKey` is called here and its result thrown away, purely so that
 * an ECDSA key, an RSA key or a paste of the wrong field fails at `connect`
 * rather than at the first sync — and so that the user sees `jwt.ts`'s message
 * naming Ed25519, which is the one thing they have to change.
 */
export function parseConnectInput(input: unknown): CoinbaseCredentials {
  if (typeof input !== 'object' || input === null) {
    throw invalidConnectInput(['input']);
  }
  const record = input as Record<string, unknown>;
  const keyName = record['keyName'];
  const privateKey = record['privateKey'];
  const problems: string[] = [];
  if (typeof keyName !== 'string' || !CDP_KEY_NAME_PATTERN.test(keyName.trim())) {
    problems.push('keyName');
  }
  if (typeof privateKey !== 'string' || privateKey.trim().length === 0) {
    problems.push('privateKey');
  }
  if (problems.length > 0) throw invalidConnectInput(problems);

  const credentials: CoinbaseCredentials = {
    keyName: (keyName as string).trim(),
    privateKeyMaterial: (privateKey as string).trim(),
  };
  parseCdpPrivateKey(credentials.privateKeyMaterial);
  return credentials;
}

function invalidConnectInput(fields: readonly string[]): ConnectorError {
  return new ConnectorError(
    'a coinbase connection needs a CDP key name of the form ' +
      'organizations/{org_uuid}/apiKeys/{key_uuid} and the matching Ed25519 private key',
    {
      kind: 'invalid_input',
      condition: 'CONFIG_ERROR',
      // The field *names*, never their values: a malformed key form still
      // contains a real private key.
      redactedContext: { fields: [...fields] },
    },
  );
}
