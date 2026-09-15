// SPDX-License-Identifier: MIT
/**
 * `FakePlaidApi` — the eleven methods of `PlaidApiLike`, driven by fixtures.
 *
 * There are no Plaid credentials on this machine, so everything below the
 * network is a recorded shape and this object is the network. It is deliberately
 * *not* a mock library: it is a small state machine with the three behaviours
 * that actually make `/transactions/sync` hard, and each one is a real scenario
 * rather than a stub someone will forget to keep honest.
 *
 *   1. **The cursor chain.** `cursor` resolves to a page by lookup, so replaying
 *      a cursor returns the identical page (the port's `sync/idempotent`), the
 *      terminal cursor returns an empty page that does not move (the port's
 *      `sync/terminates`), and a cursor nobody issued is an `INVALID_FIELD`.
 *   2. **Mutation during pagination.** One scripted page index throws
 *      `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`, once, and then succeeds —
 *      which is exactly the shape of the real condition (an institution posted
 *      something while we were paging) and the only way to prove the adapter
 *      classifies it as `page_one` rather than `resume`.
 *   3. **An Item that is broken, rate limited, or gone.**
 *
 * ## The errors are axios-shaped on purpose, and hostile on purpose
 *
 * `plaidAxiosError` builds an error with `config.data` set to the **real request
 * body** — which contains the access token — and `config.headers` carrying a
 * stand-in `PLAID-SECRET`. That is what a live axios rejection looks like, and
 * it is the trap `errors.ts` exists to avoid: attach that object as a
 * `ConnectorError` cause and the first structured log line prints the token.
 * `log-hygiene.test.ts` searches every artefact the adapter produces for those
 * two strings. A fake that threw a tidy `{error_code}` object would have let
 * that bug ship.
 */
import type {
  AccountBase,
  AccountsBalanceGetRequest,
  AccountsGetRequest,
  AccountsGetResponse,
  InvestmentsHoldingsGetRequest,
  InvestmentsHoldingsGetResponse,
  InvestmentsTransactionsGetRequest,
  InvestmentsTransactionsGetResponse,
  Item,
  ItemGetRequest,
  ItemGetResponse,
  ItemPublicTokenExchangeRequest,
  ItemPublicTokenExchangeResponse,
  ItemRemoveRequest,
  ItemRemoveResponse,
  LiabilitiesGetRequest,
  LiabilitiesGetResponse,
  LinkTokenCreateRequest,
  LinkTokenCreateResponse,
  TransactionsSyncRequest,
  TransactionsSyncResponse,
} from 'plaid';
import type { PlaidApiLike, PlaidResponse } from '../src/api.ts';
import type { PlaidErrorShape } from '../src/errors.ts';

/** A stand-in for `PLAID-SECRET` in the error's request config. Never real. */
export const FAKE_PLAID_SECRET = 'fake-plaid-secret-000000000000';

export interface FakeFailure {
  readonly error: PlaidErrorShape;
  readonly status?: number;
  readonly headers?: Record<string, string>;
}

export interface FakeItemSpec {
  readonly accessToken: string;
  readonly publicToken?: string;
  readonly item: Item;
  readonly accounts: readonly AccountBase[];
  /** The scripted cursor chain. `pages[0]` answers a request with no cursor. */
  readonly pages: readonly TransactionsSyncResponse[];
  readonly holdings?: InvestmentsHoldingsGetResponse;
  readonly investmentTransactions?: InvestmentsTransactionsGetResponse;
  readonly liabilities?: LiabilitiesGetResponse;
  /** Thrown by every data call on this Item. The broken-Item scenarios. */
  readonly failWith?: FakeFailure;
  /** Throw `MUTATION_DURING_PAGINATION` the first time this page is asked for. */
  readonly mutateAtPage?: number;
}

export interface FakeCall {
  readonly endpoint: string;
  readonly request: unknown;
}

interface FakeItemState {
  spec: FakeItemSpec;
  removed: boolean;
  mutationsLeft: number;
}

export interface PlaidAxiosLikeError extends Error {
  isAxiosError: true;
  config: { url: string; headers: Record<string, string>; data: string };
  response: {
    status: number;
    headers: Record<string, string>;
    data: PlaidErrorShape;
    config: { url: string; headers: Record<string, string>; data: string };
  };
}

/**
 * An error shaped exactly like the one axios raises for a Plaid 4xx/5xx.
 *
 * Including the parts that carry secrets. See the file comment.
 */
export function plaidAxiosError(
  endpoint: string,
  error: PlaidErrorShape,
  requestBody: unknown,
  options: { status?: number; headers?: Record<string, string> } = {},
): PlaidAxiosLikeError {
  const status = options.status ?? error.status ?? 400;
  const config = {
    url: `https://sandbox.plaid.com/${endpoint}`,
    headers: {
      'PLAID-CLIENT-ID': 'fake-client-id',
      'PLAID-SECRET': FAKE_PLAID_SECRET,
      'Plaid-Version': '2020-09-14',
    },
    data: JSON.stringify(requestBody),
  };
  const thrown = new Error(`Request failed with status code ${status}`) as PlaidAxiosLikeError;
  thrown.name = 'AxiosError';
  thrown.isAxiosError = true;
  thrown.config = config;
  thrown.response = {
    status,
    headers: options.headers ?? {},
    data: { ...error, status },
    config,
  };
  return thrown;
}

export const PLAID_ERRORS = Object.freeze({
  ITEM_LOGIN_REQUIRED: {
    error_type: 'ITEM_ERROR',
    error_code: 'ITEM_LOGIN_REQUIRED',
    error_message:
      'the login details of this item have changed (credentials, MFA, or required user action) ' +
      'and a user login is required to update this information.',
    request_id: 'req-item-login-required',
    status: 400,
  },
  RATE_LIMIT_EXCEEDED: {
    error_type: 'RATE_LIMIT_EXCEEDED',
    error_code: 'TRANSACTIONS_LIMIT',
    error_message: 'rate limit exceeded for this endpoint. please try again later.',
    request_id: 'req-rate-limited',
    status: 429,
  },
  MUTATION_DURING_PAGINATION: {
    error_type: 'TRANSACTIONS_ERROR',
    error_code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION',
    error_message:
      'underlying transaction data changed since the last page was fetched. please restart ' +
      'pagination from the first page.',
    request_id: 'req-mutation-during-pagination',
    status: 400,
  },
  INVALID_CURSOR: {
    error_type: 'INVALID_REQUEST',
    error_code: 'INVALID_FIELD',
    error_message: 'cursor must be a valid cursor previously returned by /transactions/sync',
    request_id: 'req-invalid-cursor',
    status: 400,
  },
  ITEM_NOT_FOUND: {
    error_type: 'ITEM_ERROR',
    error_code: 'ITEM_NOT_FOUND',
    error_message: 'the Item you requested cannot be found.',
    request_id: 'req-item-not-found',
    status: 400,
  },
  INVALID_ACCESS_TOKEN: {
    error_type: 'INVALID_INPUT',
    error_code: 'INVALID_ACCESS_TOKEN',
    error_message: 'provided access token is in an invalid format.',
    request_id: 'req-invalid-access-token',
    status: 400,
  },
  INSTITUTION_DOWN: {
    error_type: 'INSTITUTION_ERROR',
    error_code: 'INSTITUTION_DOWN',
    error_message: 'this institution is not currently responding to this request.',
    request_id: 'req-institution-down',
    status: 400,
  },
  PRODUCT_NOT_READY: {
    error_type: 'ITEM_ERROR',
    error_code: 'PRODUCT_NOT_READY',
    error_message: 'the requested product is not yet ready. please provide a webhook or try again.',
    request_id: 'req-product-not-ready',
    status: 400,
  },
  PRODUCTS_NOT_SUPPORTED: {
    error_type: 'ITEM_ERROR',
    error_code: 'PRODUCTS_NOT_SUPPORTED',
    error_message: 'the following products are not supported by this institution: [liabilities]',
    request_id: 'req-products-not-supported',
    status: 400,
  },
  INVALID_PUBLIC_TOKEN: {
    error_type: 'INVALID_INPUT',
    error_code: 'INVALID_PUBLIC_TOKEN',
    error_message: 'provided public token is in an invalid format.',
    request_id: 'req-invalid-public-token',
    status: 400,
  },
}) satisfies Readonly<Record<string, PlaidErrorShape>>;

export class FakePlaidApi implements PlaidApiLike {
  readonly calls: FakeCall[] = [];
  readonly #items = new Map<string, FakeItemState>();
  readonly #byPublicToken = new Map<string, string>();
  #linkTokenSerial = 0;

  constructor(specs: readonly FakeItemSpec[] = []) {
    for (const spec of specs) this.addItem(spec);
  }

  addItem(spec: FakeItemSpec): void {
    this.#items.set(spec.accessToken, {
      spec,
      removed: false,
      mutationsLeft: spec.mutateAtPage === undefined ? 0 : 1,
    });
    if (spec.publicToken !== undefined) {
      this.#byPublicToken.set(spec.publicToken, spec.accessToken);
    }
  }

  /** Every request sent to one endpoint, in order. The request-pin assertions. */
  requestsTo(endpoint: string): unknown[] {
    return this.calls.filter((call) => call.endpoint === endpoint).map((call) => call.request);
  }

  countOf(endpoint: string): number {
    return this.calls.filter((call) => call.endpoint === endpoint).length;
  }

  // -------------------------------------------------------------------------

  async linkTokenCreate(
    request: LinkTokenCreateRequest,
  ): Promise<PlaidResponse<LinkTokenCreateResponse>> {
    this.#record('link/token/create', request);
    this.#linkTokenSerial += 1;
    return {
      data: {
        link_token: `link-sandbox-${this.#linkTokenSerial}`,
        // ~4 hours, per 01 §1.5.
        expiration: '2026-06-01T16:00:00Z',
        request_id: `req-link-token-${this.#linkTokenSerial}`,
      },
    };
  }

  async itemPublicTokenExchange(
    request: ItemPublicTokenExchangeRequest,
  ): Promise<PlaidResponse<ItemPublicTokenExchangeResponse>> {
    this.#record('item/public_token/exchange', request);
    const accessToken = this.#byPublicToken.get(request.public_token);
    if (accessToken === undefined) {
      throw plaidAxiosError(
        'item/public_token/exchange',
        PLAID_ERRORS.INVALID_PUBLIC_TOKEN,
        request,
      );
    }
    const state = this.#items.get(accessToken);
    return {
      data: {
        access_token: accessToken,
        item_id: state?.spec.item.item_id ?? 'item-unknown',
        request_id: 'req-exchange',
      },
    };
  }

  async itemGet(request: ItemGetRequest): Promise<PlaidResponse<ItemGetResponse>> {
    this.#record('item/get', request);
    // `/item/get` still answers for an Item carrying an error — that is the
    // whole point of it as a health probe — so it does not go through
    // `#dataItem`. It does refuse for an Item that has been removed.
    const state = this.#live(request.access_token, 'item/get', request);
    return {
      data: {
        item: { ...state.spec.item, error: (state.spec.failWith?.error ?? null) as Item['error'] },
        request_id: 'req-item-get',
      } as ItemGetResponse,
    };
  }

  async itemRemove(request: ItemRemoveRequest): Promise<PlaidResponse<ItemRemoveResponse>> {
    this.#record('item/remove', request);
    const state = this.#live(request.access_token, 'item/remove', request);
    state.removed = true;
    return { data: { request_id: 'req-item-remove' } };
  }

  async accountsGet(request: AccountsGetRequest): Promise<PlaidResponse<AccountsGetResponse>> {
    this.#record('accounts/get', request);
    const state = this.#dataItem(request.access_token, 'accounts/get', request);
    return {
      data: {
        accounts: [...state.spec.accounts],
        item: state.spec.item,
        request_id: 'req-accounts-get',
      },
    };
  }

  async accountsBalanceGet(
    request: AccountsBalanceGetRequest,
  ): Promise<PlaidResponse<AccountsGetResponse>> {
    this.#record('accounts/balance/get', request);
    const state = this.#dataItem(request.access_token, 'accounts/balance/get', request);
    return {
      data: {
        accounts: [...state.spec.accounts],
        item: state.spec.item,
        request_id: 'req-accounts-balance-get',
      },
    };
  }

  async transactionsSync(
    request: TransactionsSyncRequest,
  ): Promise<PlaidResponse<TransactionsSyncResponse>> {
    this.#record('transactions/sync', request);
    const state = this.#dataItem(request.access_token, 'transactions/sync', request);
    const pages = state.spec.pages;
    const index = pageIndexOf(pages, request.cursor);

    if (index === null) {
      throw plaidAxiosError('transactions/sync', PLAID_ERRORS.INVALID_CURSOR, request);
    }
    if (index === state.spec.mutateAtPage && state.mutationsLeft > 0) {
      state.mutationsLeft -= 1;
      throw plaidAxiosError('transactions/sync', PLAID_ERRORS.MUTATION_DURING_PAGINATION, request);
    }

    const page = pages[index];
    if (page !== undefined) return { data: page };

    // Past the end. Plaid answers with an empty update and the cursor unchanged,
    // which is what makes the port's "a sync past the end must not move the
    // cursor" check meaningful rather than vacuous.
    const last = pages.at(-1);
    return {
      data: {
        accounts: [...state.spec.accounts],
        added: [],
        modified: [],
        removed: [],
        next_cursor: last?.next_cursor ?? '',
        has_more: false,
        transactions_update_status:
          last?.transactions_update_status ?? ('HISTORICAL_UPDATE_COMPLETE' as never),
        request_id: 'req-transactions-sync-terminal',
      },
    };
  }

  async investmentsHoldingsGet(
    request: InvestmentsHoldingsGetRequest,
  ): Promise<PlaidResponse<InvestmentsHoldingsGetResponse>> {
    this.#record('investments/holdings/get', request);
    const state = this.#dataItem(request.access_token, 'investments/holdings/get', request);
    const holdings = state.spec.holdings;
    if (holdings === undefined) {
      throw plaidAxiosError('investments/holdings/get', PLAID_ERRORS.PRODUCTS_NOT_SUPPORTED, request);
    }
    return { data: holdings };
  }

  async investmentsTransactionsGet(
    request: InvestmentsTransactionsGetRequest,
  ): Promise<PlaidResponse<InvestmentsTransactionsGetResponse>> {
    this.#record('investments/transactions/get', request);
    const state = this.#dataItem(request.access_token, 'investments/transactions/get', request);
    const all = state.spec.investmentTransactions;
    if (all === undefined) {
      throw plaidAxiosError(
        'investments/transactions/get',
        PLAID_ERRORS.PRODUCTS_NOT_SUPPORTED,
        request,
      );
    }
    // Real offset/count paging, so the adapter's loop is exercised rather than
    // assumed: a single-page fixture would never notice a missing `offset`.
    const offset = request.options?.offset ?? 0;
    const count = request.options?.count ?? 500;
    return {
      data: {
        ...all,
        investment_transactions: all.investment_transactions.slice(offset, offset + count),
      },
    };
  }

  async liabilitiesGet(
    request: LiabilitiesGetRequest,
  ): Promise<PlaidResponse<LiabilitiesGetResponse>> {
    this.#record('liabilities/get', request);
    const state = this.#dataItem(request.access_token, 'liabilities/get', request);
    const liabilities = state.spec.liabilities;
    if (liabilities === undefined) {
      throw plaidAxiosError('liabilities/get', PLAID_ERRORS.PRODUCTS_NOT_SUPPORTED, request);
    }
    return { data: liabilities };
  }

  // -------------------------------------------------------------------------

  #record(endpoint: string, request: unknown): void {
    this.calls.push({ endpoint, request });
  }

  /** Exists and has not been removed. */
  #live(accessToken: string, endpoint: string, request: unknown): FakeItemState {
    const state = this.#items.get(accessToken);
    if (state === undefined) {
      throw plaidAxiosError(endpoint, PLAID_ERRORS.INVALID_ACCESS_TOKEN, request);
    }
    if (state.removed) {
      throw plaidAxiosError(endpoint, PLAID_ERRORS.ITEM_NOT_FOUND, request);
    }
    return state;
  }

  /** ...and is not carrying an Item-level error. */
  #dataItem(accessToken: string, endpoint: string, request: unknown): FakeItemState {
    const state = this.#live(accessToken, endpoint, request);
    const failure = state.spec.failWith;
    if (failure !== undefined) {
      throw plaidAxiosError(endpoint, failure.error, request, {
        ...(failure.status === undefined ? {} : { status: failure.status }),
        ...(failure.headers === undefined ? {} : { headers: failure.headers }),
      });
    }
    return state;
  }
}

/**
 * Resolve a request cursor to a page index.
 *
 * `undefined` (omitted) is page 0. Otherwise the cursor must be the
 * `next_cursor` of some page, and the answer is the page after it —
 * `pages.length` meaning "past the end". `null` means no page has ever issued
 * this cursor, which is an `INVALID_FIELD`.
 */
function pageIndexOf(
  pages: readonly TransactionsSyncResponse[],
  cursor: string | undefined,
): number | null {
  if (cursor === undefined) return 0;
  const index = pages.findIndex((page) => page.next_cursor === cursor);
  return index === -1 ? null : index + 1;
}
