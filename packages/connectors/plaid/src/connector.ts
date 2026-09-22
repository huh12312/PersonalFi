// SPDX-License-Identifier: MIT
/**
 * `PlaidConnector` — the port, over `/transactions/sync`.
 *
 * ## What this class deliberately does not do
 *
 * - **It does not hold the access token.** Not on `this`, not in a module-level
 *   cache, not in a closure that outlives one call. Every method reads it from
 *   `handle.secret(PLAID_ACCESS_TOKEN)` and drops it when the method returns.
 *   `connect` hands it back once so `@ctx/connections` can seal it, and that is
 *   the only time it exists outside a `SecretBox` (08 §2.3).
 * - **It does not accumulate pages.** `syncTransactions` returns one page per
 *   call. The orchestrator accumulates, and it accumulates *because* this
 *   adapter declares `incremental_sync`: 01 §5.1's "retrieve all available
 *   updates before persisting" is a rule about the commit boundary, which is the
 *   caller's, not about who calls the API.
 * - **It does not decide retry policy.** It classifies (`errors.ts`) and stops.
 * - **It does not log a token.** See `#call`.
 *
 * ## The cursor is Plaid's, verbatim
 *
 * `nextCursor` is `next_cursor` and nothing else: no wrapping, no encoding, no
 * composite of "cursor plus the account we were on". The port's rule 1 says the
 * cursor is opaque, and the fastest way to break a resumable sync is to invent a
 * cursor format that a later version of the adapter cannot parse.
 */
import {
  ConnectorError,
  cursorOf,
  assertSupports,
  windowStart,
  type ConnectResult,
  type ConnectionHandle,
  type Connector,
  type ConnectorCapabilities,
  type ConnectorHealth,
  type Capability,
  type Cursor,
  type ProviderAccountFact,
  type ProviderBalanceFact,
  type ProviderHoldingFact,
  type ProviderInvestmentTransactionFact,
  type ProviderLiabilityFact,
  type ProviderTransactionFact,
  type SyncOptions,
  type TransactionPage,
} from '@connector/port';
import { todayIn, type Clock } from '@core/kernel';
import type {
  LinkTokenCreateRequest,
  PersonalFinanceCategoryVersion,
  Products,
  Transaction,
  TransactionsSyncRequest,
  TransactionsUpdateStatus,
} from 'plaid';
import { z } from 'zod';
import {
  silentPlaidLogger,
  type PlaidApiLike,
  type PlaidLinkSettings,
  type PlaidLogger,
} from './api.ts';
import { asPlaidConnectorError, mapPlaidError, plaidErrorShapeOf } from './errors.ts';
import {
  accountFactOf,
  balanceFactOf,
  currencyByAccountOf,
  holdingFactOf,
  investmentTransactionFactOf,
  liabilityFactsOf,
  securitiesByIdOf,
  transactionFactOf,
} from './map.ts';
import {
  PLAID_ACCESS_TOKEN,
  PLAID_HISTORICAL_UPDATE_COMPLETE,
  PLAID_MANIFEST,
  PLAID_MAX_HISTORY_DAYS,
  PLAID_MAX_PAGE_SIZE,
  PLAID_PFC_VERSION,
  PLAID_PRODUCTS,
  PLAID_PROVIDER,
  plaidCapabilities,
} from './provider.ts';

export interface PlaidConnectorOptions {
  readonly api: PlaidApiLike;
  readonly settings: PlaidLinkSettings;
  /**
   * Needed because `Connector.health` takes no `SyncOptions`, and therefore no
   * clock, while `ConnectorHealth.checkedAt` is a timestamp — and
   * `docs/CONVENTIONS.md` bans `new Date()` outside a `Clock` everywhere. Held
   * on the connector rather than threaded through the one method that needs it;
   * reported as a port gap in the evidence doc.
   */
  readonly clock: Clock;
  readonly logger?: PlaidLogger;
}

/**
 * What `connect` accepts: the artifact Plaid Link's `onSuccess` produced.
 *
 * `institutionName` comes from Link's own metadata and is optional because
 * `/item/get` also reports it; whichever we have becomes the connection's
 * display name. Nothing else from the Link callback is trusted.
 */
const connectSchema = z.object({
  publicToken: z.string().min(1),
  institutionName: z.string().min(1).nullish(),
});

export type PlaidConnectInput = z.infer<typeof connectSchema>;

export interface PlaidLinkTokenInput {
  /** `user.client_user_id`. The app's own user id, never an email. */
  readonly clientUserId: string;
}

export interface PlaidLinkToken {
  readonly linkToken: string;
  readonly expiresAt: Date;
  readonly requestId: string;
}

export interface PlaidUpdateLinkTokenInput {
  /**
   * 01 §1.7: set for `NEW_ACCOUNTS_AVAILABLE`, and note the warning — "any
   * de-selected accounts will no longer be shared with you". Off by default, so
   * a routine reauth cannot silently drop an account the user forgot to tick.
   */
  readonly accountSelectionEnabled?: boolean;
}

/**
 * The capability each Plaid product implies, for `observedCapabilities`.
 *
 * `ConnectResult.observedCapabilities` "narrows, never widens, the declared
 * set", so this is intersected with `capabilities().supports` before it is
 * returned — a Plaid product we have not built support for cannot appear.
 */
const CAPABILITIES_OF_PRODUCT: Readonly<Record<string, readonly Capability[]>> = Object.freeze({
  transactions: ['transactions', 'incremental_sync', 'historical_backfill'],
  investments: ['holdings', 'investment_txns'],
  liabilities: ['liabilities'],
});

export class PlaidConnector implements Connector {
  readonly provider = PLAID_PROVIDER;
  readonly displayName = PLAID_MANIFEST.displayName;
  readonly #api: PlaidApiLike;
  readonly #settings: PlaidLinkSettings;
  readonly #clock: Clock;
  readonly #logger: PlaidLogger;

  constructor(options: PlaidConnectorOptions) {
    this.#api = options.api;
    this.#settings = options.settings;
    this.#clock = options.clock;
    this.#logger = options.logger ?? silentPlaidLogger;
  }

  capabilities(): ConnectorCapabilities {
    return plaidCapabilities({ webhooksConfigured: this.#settings.webhookUrl !== null });
  }

  // -------------------------------------------------------------------------
  // Linking
  // -------------------------------------------------------------------------

  /**
   * Step one of linking: a `link_token` for the browser to open Plaid Link with.
   *
   * Not on the `Connector` port, because the port's `connect` takes the
   * *completion* artifact and a provider-hosted flow needs a step before that.
   * `apps/api` calls this from the "add a connection" route.
   *
   * The pins, all asserted by `pins.test.ts`:
   *
   *   * `products: [transactions, investments, liabilities]` — D16 exactly. Not
   *     `auth`, not `identity`.
   *   * `transactions.days_requested: 730` — D16/01 §5.1. Plaid's default is 90,
   *     and because `transactions` is in `products` this is the field that
   *     decides the Item's history window **for the life of the Item**: 01 §5.1
   *     and the SDK's own doc say the window "cannot be updated if Transactions
   *     has already been added", so getting it wrong here costs a `/item/remove`
   *     and a re-link — and on Trial, a slot (D16).
   *   * `redirect_uri` — from `PUBLIC_HOST` (D12), omitted when unset rather than
   *     sent empty, which is an `INVALID_FIELD`.
   *   * **no `webhook`** unless one is configured. D12: polling by default.
   */
  async createLinkToken(input: PlaidLinkTokenInput): Promise<PlaidLinkToken> {
    const request: LinkTokenCreateRequest = {
      ...this.#linkTokenBase(input.clientUserId),
      products: [...PLAID_PRODUCTS] as Products[],
      transactions: { days_requested: PLAID_MAX_HISTORY_DAYS },
    };
    const { data } = await this.#call('link/token/create', () =>
      this.#api.linkTokenCreate(request),
    );
    return {
      linkToken: data.link_token,
      expiresAt: new Date(data.expiration),
      requestId: data.request_id,
    };
  }

  /**
   * A `link_token` for Link in **update mode** — the reconnect flow.
   *
   * 01 §1.7 is emphatic on both halves of this:
   *
   * > "the `access_token` does not change when using Link in update mode, so
   * > there is no need to repeat the exchange token process."
   *
   * — which is why this returns only a token and nothing to re-seal — and:
   *
   * > "Do **not** populate `products` during standard update mode."
   *
   * — which is why `products` is absent here and asserted absent by a test. A
   * `products` array in update mode re-initialises the Item's product set and
   * can re-bill it.
   */
  async createUpdateLinkToken(
    handle: ConnectionHandle,
    input: PlaidUpdateLinkTokenInput = {},
  ): Promise<PlaidLinkToken> {
    const request: LinkTokenCreateRequest = {
      ...this.#linkTokenBase(handle.userId),
      access_token: this.#accessToken(handle),
      ...(input.accountSelectionEnabled === true
        ? { update: { account_selection_enabled: true } }
        : {}),
    };
    const { data } = await this.#call('link/token/create (update)', () =>
      this.#api.linkTokenCreate(request),
    );
    return {
      linkToken: data.link_token,
      expiresAt: new Date(data.expiration),
      requestId: data.request_id,
    };
  }

  /**
   * Step two: exchange the public token, and describe what we just linked.
   *
   * The `access_token` is returned in `credentials` and **not kept**. The public
   * token is single-use and expires in 30 minutes (01 §1.5); if the exchange
   * fails the user re-runs Link, which is why an exchange failure classifies as
   * `CONFIG_ERROR`/`invalid_input` rather than as something to retry.
   */
  async connect(input: unknown): Promise<ConnectResult> {
    const parsed = connectSchema.safeParse(input);
    if (!parsed.success) {
      // The message deliberately does not echo the input: a malformed link
      // payload can still contain a real public token.
      throw new ConnectorError('a plaid link result needs a publicToken', {
        kind: 'invalid_input',
        condition: 'CONFIG_ERROR',
        redactedContext: { issues: parsed.error.issues.map((issue) => issue.path.join('.')) },
      });
    }

    const exchanged = await this.#call('item/public_token/exchange', () =>
      this.#api.itemPublicTokenExchange({ public_token: parsed.data.publicToken }),
    );
    const accessToken = exchanged.data.access_token;

    const item = await this.#call('item/get', () =>
      this.#api.itemGet({ access_token: accessToken }),
    );
    const accounts = await this.#call('accounts/get', () =>
      this.#api.accountsGet({ access_token: accessToken }),
    );

    const consentExpiration = item.data.item.consent_expiration_time;
    return {
      providerConnectionId: exchanged.data.item_id,
      displayName:
        parsed.data.institutionName ??
        item.data.item.institution_name ??
        item.data.item.institution_id ??
        PLAID_MANIFEST.displayName,
      // Handed over once, sealed by @ctx/connections, never returned again.
      credentials: { [PLAID_ACCESS_TOKEN]: accessToken },
      accounts: accounts.data.accounts.map(accountFactOf),
      observedCapabilities: this.#observedCapabilitiesOf(item.data.item),
      consentExpiresAt: consentExpiration === null ? null : new Date(consentExpiration),
    };
  }

  // -------------------------------------------------------------------------
  // Sync
  // -------------------------------------------------------------------------

  async listAccounts(handle: ConnectionHandle): Promise<readonly ProviderAccountFact[]> {
    const { data } = await this.#call('accounts/get', () =>
      this.#api.accountsGet({ access_token: this.#accessToken(handle) }),
    );
    return data.accounts.map(accountFactOf);
  }

  /**
   * One page of `/transactions/sync`.
   *
   * Request pins, asserted by `pins.test.ts`:
   *
   *   * `count: min(pageSize, 500)` — 500 is Plaid's ceiling (01 §5.1).
   *   * `options.personal_finance_category_version: 'v2'` — pinned in code even
   *     though a post-2025 account gets v2 by default (01 §5.4), so the taxonomy
   *     the classifier was trained against cannot change under us silently.
   *   * `options.include_original_description: true` — the raw institution
   *     descriptor. It is what a CSV export of the same account contains, and
   *     therefore what the cross-provider fingerprint keys on (`map.ts`).
   *   * `options.days_requested` — belt and braces. It has no effect on an Item
   *     that was linked with `transactions` in `products` (that Item's window
   *     was fixed by `transactions.days_requested` at link time), but an Item
   *     linked any other way would otherwise silently get 90 days.
   *   * `cursor` **omitted**, not `null`, on the first call. Plaid's contract is
   *     "if omitted, the entire history of updates will be returned".
   */
  async syncTransactions(
    handle: ConnectionHandle,
    cursor: Cursor | null,
    options: SyncOptions,
  ): Promise<TransactionPage> {
    this.#assertBudget(options, 'transactions/sync');
    const request: TransactionsSyncRequest = {
      access_token: this.#accessToken(handle),
      ...(cursor === null ? {} : { cursor }),
      count: Math.max(1, Math.min(options.pageSize, PLAID_MAX_PAGE_SIZE)),
      options: {
        include_original_description: true,
        // `'v2'` is the wire value of `PersonalFinanceCategoryVersion.V2`. Cast
        // rather than imported so this module stays type-only against the SDK
        // and a test never loads axios.
        personal_finance_category_version: PLAID_PFC_VERSION as PersonalFinanceCategoryVersion,
        days_requested: this.#historyDays(options),
      },
    };

    const { data } = await this.#call('transactions/sync', () =>
      this.#api.transactionsSync(request),
    );

    // 01 §5.1's PRODUCT_NOT_READY row assumed the not-ready case *throws*. Real
    // Sandbox (found by the live smoke, WP 1.3 §7) instead answers 200 with an
    // empty, non-`has_more` page and `transactions_update_status: 'NOT_READY'`
    // or `'INITIAL_UPDATE_COMPLETE'` while the extract is still running. Folding
    // that into the same `PRODUCT_NOT_READY`/`transient` classification the error
    // map already carries means every existing caller's retry loop — including
    // this file's own callers and the orchestrator — needs no new code path.
    // `HISTORICAL_UPDATE_COMPLETE` is excluded so a genuinely empty, finished
    // account (the steady state after backfill) returns normally instead of
    // retrying forever.
    if (
      data.added.length === 0 &&
      data.modified.length === 0 &&
      data.removed.length === 0 &&
      !data.has_more &&
      data.transactions_update_status !==
        (PLAID_HISTORICAL_UPDATE_COMPLETE as TransactionsUpdateStatus)
    ) {
      throw mapPlaidError(
        { error_type: 'ITEM_ERROR', error_code: 'PRODUCT_NOT_READY' },
        { endpoint: 'transactions/sync', retryAfterMs: null },
      );
    }

    const currencyByAccount = currencyByAccountOf(data.accounts);
    const factOf = (transaction: Transaction): ProviderTransactionFact =>
      transactionFactOf(transaction, currencyByAccount.get(transaction.account_id) ?? 'USD');

    return {
      added: data.added.map(factOf),
      modified: data.modified.map(factOf),
      // 01 §5.1: "`removed[]` contains **IDs only**, not objects" — and the
      // account id, which is what the orchestrator needs to route the removal.
      removed: data.removed.map((removed) => ({
        providerAccountId: removed.account_id,
        providerTransactionId: removed.transaction_id,
      })),
      // Plaid volunteers the full account list on every page. Passed through on
      // every page rather than only the first: an institution can add an account
      // mid-backfill, and a page naming an account the connection has never
      // mapped is a hard `MALFORMED_RESPONSE` in the orchestrator. `linkAccounts`
      // is an upsert, so the repetition costs a few statements per page and buys
      // the guarantee.
      accounts: data.accounts.map(accountFactOf),
      nextCursor: cursorOf(data.next_cursor),
      hasMore: data.has_more,
    };
  }

  /**
   * `/accounts/balance/get`. **Sparingly** (01 §1.5).
   *
   * This forces a real-time extraction at the institution — p50 ~3 s, p95 ~11 s
   * — is billed per request, and is rate limited at 5/min and 30/hr per Item
   * (01 §1.8), by far the tightest limit we touch. The cached balances on a
   * Transactions Item refresh about daily and are good enough for a PFM, so the
   * orchestrator should call this on demand and on the daily snapshot seal, not
   * on every transaction sync.
   */
  async syncBalances(
    handle: ConnectionHandle,
    options: SyncOptions,
  ): Promise<readonly ProviderBalanceFact[]> {
    assertSupports(this.provider, this.capabilities(), 'balances');
    this.#assertBudget(options, 'accounts/balance/get');
    const { data } = await this.#call('accounts/balance/get', () =>
      this.#api.accountsBalanceGet({ access_token: this.#accessToken(handle) }),
    );
    const asOf = options.clock.now();
    return data.accounts.map((account) => balanceFactOf(account, asOf));
  }

  async syncHoldings(
    handle: ConnectionHandle,
    options: SyncOptions,
  ): Promise<readonly ProviderHoldingFact[]> {
    assertSupports(this.provider, this.capabilities(), 'holdings');
    this.#assertBudget(options, 'investments/holdings/get');
    const { data } = await this.#call('investments/holdings/get', () =>
      this.#api.investmentsHoldingsGet({ access_token: this.#accessToken(handle) }),
    );
    const securities = securitiesByIdOf(data.securities);
    const asOf = options.clock.now();
    return data.holdings.map((holding) => holdingFactOf(holding, securities, asOf));
  }

  /**
   * Investment transactions, by date window.
   *
   * Now an optional port method (WP 3.1), but deliberately **not** shaped like
   * `syncTransactions`: 01 §5.5 — "There is no `/investments/transactions/sync`"
   * — so there is no cursor and no `TransactionPage`, because a paging shape with
   * nothing behind it hands the caller a `nextCursor` it must never persist. The
   * window is `min(historyDays, 730)` back from today, and idempotency is the
   * caller's `investment_transaction_id` upsert, exactly as 01 §5.5 prescribes.
   *
   * Paginates on `total_investment_transactions` with `options.offset`, because
   * the endpoint caps a response at 500 and silently truncating a brokerage's
   * history is the failure this whole package exists to avoid.
   */
  async syncInvestmentTransactions(
    handle: ConnectionHandle,
    options: SyncOptions,
  ): Promise<readonly ProviderInvestmentTransactionFact[]> {
    assertSupports(this.provider, this.capabilities(), 'investment_txns');
    const accessToken = this.#accessToken(handle);
    // UTC, deliberately: this is a request parameter bounding a provider's
    // window, not a user-facing period boundary. `todayIn(clock, userZone)` is
    // for budget months and the daily seal; a day of slack on a 730-day backfill
    // window is not a correctness question, and pretending to know the user's
    // zone down here would be.
    const today = todayIn(options.clock, 'UTC');
    const start = windowStart(this.capabilities(), options.historyDays, today) ?? today;
    const facts: ProviderInvestmentTransactionFact[] = [];

    for (let offset = 0; ;) {
      this.#assertBudget(options, 'investments/transactions/get');
      const { data } = await this.#call('investments/transactions/get', () =>
        this.#api.investmentsTransactionsGet({
          access_token: accessToken,
          start_date: start,
          end_date: today,
          options: { count: PLAID_MAX_PAGE_SIZE, offset },
        }),
      );
      const securities = securitiesByIdOf(data.securities);
      for (const transaction of data.investment_transactions) {
        facts.push(investmentTransactionFactOf(transaction, securities));
      }
      offset += data.investment_transactions.length;
      if (
        data.investment_transactions.length === 0 ||
        offset >= data.total_investment_transactions
      ) {
        return facts;
      }
    }
  }

  async syncLiabilities(
    handle: ConnectionHandle,
    options: SyncOptions,
  ): Promise<readonly ProviderLiabilityFact[]> {
    assertSupports(this.provider, this.capabilities(), 'liabilities');
    this.#assertBudget(options, 'liabilities/get');
    const { data } = await this.#call('liabilities/get', () =>
      this.#api.liabilitiesGet({ access_token: this.#accessToken(handle) }),
    );
    return liabilityFactsOf(data.liabilities, currencyByAccountOf(data.accounts));
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * `/item/remove`. **This does not free a Trial Item slot.**
   *
   * D16: "The 10-Item cap is a ratchet (`/item/remove` does not free slots), so
   * the institution list is decided before the first Production link." Removing
   * an Item revokes the token and stops the billing, and the slot stays spent
   * for the life of the Trial. On Sandbox it costs nothing; on Production every
   * call to this method is one of ten, permanently.
   *
   * Idempotent for an Item that is already gone — Plaid answers `ITEM_NOT_FOUND`
   * or `INVALID_ACCESS_TOKEN`, and "already revoked" is the outcome the caller
   * asked for. Anything else raises, so `disconnectConnection` in
   * `@ctx/connections` can record `revokedAtProvider: false` honestly instead of
   * telling the user we revoked something we did not.
   */
  async disconnect(handle: ConnectionHandle): Promise<void> {
    try {
      await this.#call('item/remove', () =>
        this.#api.itemRemove({ access_token: this.#accessToken(handle) }),
      );
    } catch (cause) {
      const code = cause instanceof ConnectorError ? cause.providerCode : null;
      if (code === 'ITEM_NOT_FOUND' || code === 'INVALID_ACCESS_TOKEN') {
        this.#logger.warn(
          { connectionId: handle.connectionId, providerCode: code },
          'plaid item was already removed',
        );
        return;
      }
      throw cause;
    }
  }

  /**
   * `/item/get` — the cheap probe (08 §2.3: "must not consume refresh budget").
   *
   * It does not touch the institution, so it costs nothing at the bank and
   * nothing in extraction latency. `reachable` is false when the Item carries an
   * error, because an Item in `ITEM_LOGIN_REQUIRED` is reachable in the network
   * sense and useless in every other sense; `detail` carries Plaid's own code so
   * the connection detail screen can say which.
   */
  async health(handle: ConnectionHandle): Promise<ConnectorHealth> {
    const checkedAt = this.#clock.now();
    try {
      const { data } = await this.#call('item/get', () =>
        this.#api.itemGet({ access_token: this.#accessToken(handle) }),
      );
      const error = data.item.error;
      return {
        reachable: error === null,
        checkedAt,
        detail: error === null ? null : `${error.error_type}/${error.error_code}`,
      };
    } catch (cause) {
      // `health` reports rather than throws: it is the probe the connection
      // detail screen calls, and a provider that is down is an answer, not an
      // exception. `#call` has already classified and logged.
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

  /**
   * Classify an `item.error` that arrived out of band — a webhook, or the
   * `error` field on an otherwise successful `/item/get`.
   *
   * Exposed because the Item's error is the *authoritative* statement of a
   * connection's health and it does not always arrive as a thrown API failure.
   */
  static classifyItemError(error: unknown): ConnectorError | null {
    const shape = plaidErrorShapeOf(error);
    return shape === null ? null : mapPlaidError(shape, { endpoint: 'item.error' });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * One request, one log line, one error funnel.
   *
   * The log line names the endpoint and Plaid's `request_id` and nothing else.
   * Not the request body (it contains `access_token` on every call after
   * linking), not the response object (axios hangs the whole request config off
   * it), not the error (same, plus `PLAID-SECRET` in `config.headers`). See the
   * head of `errors.ts`.
   */
  async #call<T extends { readonly data: { readonly request_id?: string } }>(
    endpoint: string,
    send: () => Promise<T>,
  ): Promise<T> {
    try {
      const response = await send();
      this.#logger.debug(
        { provider: PLAID_PROVIDER, endpoint, requestId: response.data.request_id ?? null },
        'plaid request',
      );
      return response;
    } catch (cause) {
      const error = asPlaidConnectorError(cause, endpoint);
      this.#logger.warn(
        {
          provider: PLAID_PROVIDER,
          endpoint,
          kind: error.kind,
          condition: error.condition,
          providerCode: error.providerCode,
        },
        'plaid request failed',
      );
      throw error;
    }
  }

  /**
   * The token, read fresh from the sealed store on every call.
   *
   * A missing credential is `invalid_input`, not `auth_required`: the user
   * cannot fix a connection row whose sealed blob does not contain the key this
   * adapter asks for. That is a wiring bug or a half-finished migration, and
   * sending the user through Link would not repair it.
   */
  #accessToken(handle: ConnectionHandle): string {
    const token = handle.secret(PLAID_ACCESS_TOKEN);
    if (token === null || token.length === 0) {
      throw new ConnectorError('this connection holds no plaid access token', {
        kind: 'invalid_input',
        condition: 'CONFIG_ERROR',
        redactedContext: { connectionId: handle.connectionId, credential: PLAID_ACCESS_TOKEN },
      });
    }
    return token;
  }

  #linkTokenBase(clientUserId: string): LinkTokenCreateRequest {
    return {
      client_name: this.#settings.clientName,
      language: this.#settings.language,
      country_codes: [...this.#settings.countryCodes] as LinkTokenCreateRequest['country_codes'],
      user: { client_user_id: clientUserId },
      // Omitted rather than sent as null: Plaid rejects an empty `redirect_uri`
      // with INVALID_FIELD, and D12 says a LAN-only deployment has none.
      ...(this.#settings.redirectUri === null ? {} : { redirect_uri: this.#settings.redirectUri }),
      // D12: no webhook by default. Polling is the ingestion path; a webhook URL
      // is an optional compose profile, and registering one we do not serve
      // would make Plaid retry deliveries into a black hole.
      ...(this.#settings.webhookUrl === null ? {} : { webhook: this.#settings.webhookUrl }),
    };
  }

  /** Narrows the declared set by what Plaid says this Item actually has. */
  #observedCapabilitiesOf(item: {
    products?: readonly Products[];
    billed_products: readonly Products[];
    available_products: readonly Products[];
  }): readonly Capability[] {
    const declared = new Set(this.capabilities().supports);
    const observed = new Set<Capability>(['accounts', 'balances']);
    for (const product of [
      ...(item.products ?? []),
      ...item.billed_products,
      ...item.available_products,
    ]) {
      for (const capability of CAPABILITIES_OF_PRODUCT[String(product)] ?? []) {
        observed.add(capability);
      }
    }
    return [...observed].filter((capability) => declared.has(capability));
  }

  /** 1..730, clamped. Anything outside is our bug, not a reason to fail a sync. */
  #historyDays(options: SyncOptions): number {
    return Math.max(1, Math.min(Math.trunc(options.historyDays), PLAID_MAX_HISTORY_DAYS));
  }

  /**
   * The port's "hard budget": raise, never truncate silently.
   *
   * A truncated page looks exactly like a provider that has no more data, and
   * the orchestrator would commit the cursor and move on — the one failure mode
   * that loses transactions permanently and without a trace.
   */
  #assertBudget(options: SyncOptions, endpoint: string): void {
    if (options.signal.aborted) {
      throw new ConnectorError(`plaid ${endpoint} aborted before it was sent`, {
        kind: 'transient',
        redactedContext: { endpoint, reason: 'aborted' },
      });
    }
    if (options.clock.nowMs() > options.deadline.getTime()) {
      throw new ConnectorError(`plaid ${endpoint} passed the run's deadline`, {
        kind: 'transient',
        redactedContext: { endpoint, reason: 'deadline' },
      });
    }
  }
}
