// SPDX-License-Identifier: MIT
/**
 * The slice of `PlaidApi` this adapter is allowed to use.
 *
 * Eleven methods out of roughly three hundred. The narrow interface is what
 * makes `FakePlaidApi` eleven methods rather than a mock of the whole SDK, and
 * it is also a standing statement of scope: adding `/auth/get` means editing
 * this file, in a diff a reviewer sees, rather than reaching for a method that
 * happened to be on the object (D16 — no Auth, no Identity).
 *
 * The response type is `{ data: T }` rather than axios's `AxiosResponse<T>` for
 * the same reason. `AxiosResponse` carries `config`, and `config` carries the
 * request body — which contains the access token. A fake that had to produce one
 * would have to produce that too, and the first `console.log(response)` in a
 * debugging session would print the token. `PlaidApi` is still structurally
 * assignable to this interface, because `AxiosResponse<T>` has a `data: T`; what
 * the narrowing removes is our *ability* to reach the rest.
 */
import type {
  AccountsBalanceGetRequest,
  AccountsGetRequest,
  AccountsGetResponse,
  InvestmentsHoldingsGetRequest,
  InvestmentsHoldingsGetResponse,
  InvestmentsTransactionsGetRequest,
  InvestmentsTransactionsGetResponse,
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
  SandboxItemResetLoginRequest,
  SandboxItemResetLoginResponse,
  SandboxPublicTokenCreateRequest,
  SandboxPublicTokenCreateResponse,
  TransactionsSyncRequest,
  TransactionsSyncResponse,
} from 'plaid';

/** Just the payload. See the file comment for why `AxiosResponse` is not used. */
export interface PlaidResponse<T> {
  readonly data: T;
}

export interface PlaidApiLike {
  linkTokenCreate(request: LinkTokenCreateRequest): Promise<PlaidResponse<LinkTokenCreateResponse>>;
  itemPublicTokenExchange(
    request: ItemPublicTokenExchangeRequest,
  ): Promise<PlaidResponse<ItemPublicTokenExchangeResponse>>;
  itemGet(request: ItemGetRequest): Promise<PlaidResponse<ItemGetResponse>>;
  itemRemove(request: ItemRemoveRequest): Promise<PlaidResponse<ItemRemoveResponse>>;
  accountsGet(request: AccountsGetRequest): Promise<PlaidResponse<AccountsGetResponse>>;
  accountsBalanceGet(
    request: AccountsBalanceGetRequest,
  ): Promise<PlaidResponse<AccountsGetResponse>>;
  transactionsSync(
    request: TransactionsSyncRequest,
  ): Promise<PlaidResponse<TransactionsSyncResponse>>;
  investmentsHoldingsGet(
    request: InvestmentsHoldingsGetRequest,
  ): Promise<PlaidResponse<InvestmentsHoldingsGetResponse>>;
  investmentsTransactionsGet(
    request: InvestmentsTransactionsGetRequest,
  ): Promise<PlaidResponse<InvestmentsTransactionsGetResponse>>;
  liabilitiesGet(request: LiabilitiesGetRequest): Promise<PlaidResponse<LiabilitiesGetResponse>>;
}

/**
 * The Sandbox-only helpers, kept off `PlaidApiLike` on purpose.
 *
 * `PlaidConnector` must not be able to call `/sandbox/item/reset_login`: it is a
 * test affordance, and an adapter that can reach it is one bad merge away from
 * resetting a live Item. The live smoke test asks for this interface explicitly.
 */
export interface PlaidSandboxApiLike {
  sandboxPublicTokenCreate(
    request: SandboxPublicTokenCreateRequest,
  ): Promise<PlaidResponse<SandboxPublicTokenCreateResponse>>;
  sandboxItemResetLogin(
    request: SandboxItemResetLoginRequest,
  ): Promise<PlaidResponse<SandboxItemResetLoginResponse>>;
}

/**
 * Everything the adapter needs that is not a credential of the *user's*.
 *
 * `clientId`/`secret`/`environment` belong to `client.ts` and never reach the
 * connector; what the connector needs are the Link-flow parameters, because
 * `/link/token/create` is the one call whose body is deployment configuration
 * rather than provider data.
 *
 * WP 1.3 does not own `packages/config`, so this is an injected object and the
 * exact schema lines it wants are written down in
 * `docs/evidence/phase-1/wp1.3-plaid.md` for whoever does own it.
 */
export interface PlaidLinkSettings {
  /** Shown in Link's header. The user's own words for this machine. */
  readonly clientName: string;
  /** ISO-3166-1 alpha-2, e.g. `['US']`. Drives which institutions Link offers. */
  readonly countryCodes: readonly string[];
  /** ISO-639-1, e.g. `'en'`. */
  readonly language: string;
  /**
   * Derived from `PUBLIC_HOST`, e.g. `https://<node>.<tailnet>.ts.net/link/oauth`
   * (D12). `null` disables OAuth institutions rather than sending a URL Plaid
   * has not been told about, which is a hard `INVALID_FIELD`.
   *
   * 01 §1.7: Production OAuth needs a *browser-reachable* HTTPS redirect, and
   * D12 resolves that with Tailscale Serve rather than public ingress. It must
   * also be registered under **Allowed redirect URIs** in the Plaid Dashboard;
   * nothing in code can check that, so the evidence doc says it out loud.
   */
  readonly redirectUri: string | null;
  /**
   * D12: **null by default.** Polling is the default ingestion path and webhooks
   * are an optional compose profile. A non-null value here is also what makes
   * `plaidCapabilities({webhooksConfigured: true})` honest.
   */
  readonly webhookUrl: string | null;
}

/**
 * Where a log line goes, if anywhere.
 *
 * Deliberately not `@core/platform`'s `PlatformLogger`: the boundary rule
 * (`scripts/eslint-boundaries.js`) does not let a connector import it, and it
 * should not — an adapter that could reach the platform could reach the outbox.
 * Structurally compatible with pino and with `PlatformLogger`, so the
 * composition root passes its own logger straight in.
 */
export interface PlaidLogger {
  debug(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
}

export const silentPlaidLogger: PlaidLogger = Object.freeze({
  debug: () => {},
  warn: () => {},
});
