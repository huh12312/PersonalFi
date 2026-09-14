// SPDX-License-Identifier: MIT
/**
 * The `Connector` port (08 §2.3, 04 §4.1, 01 §2.4, master plan §3.3).
 *
 * Everything a provider is, reduced to nine methods. `ManualConnector` and
 * `CsvImportConnector` implementing the same port as Plaid is the tell that the
 * abstraction is right: the orchestrator, the events, and the sync-run history
 * all work identically (08 §2.6).
 *
 * ## The cursor contract — four rules that make sync correct rather than merely working
 *
 * 1. **The cursor is opaque.** It is a string. We never parse it, never compare
 *    two of them, never construct one. `cursorOf` exists so an adapter can brand
 *    a string it produced; nothing else may call it.
 * 2. **A cursor is committed only in the same transaction that commits the
 *    page's data.** That is why `syncTransactions` returns one page per call
 *    rather than an array: page → ledger write → advance cursor → `COMMIT`. A
 *    cursor advanced outside the write transaction is permanent, silent data
 *    loss, because the provider will never resend (01 §5.1).
 * 3. **`nextCursor === null` with `hasMore === false`** means the provider has no
 *    incremental support. The orchestrator falls back to a windowed full pull and
 *    lets the fingerprint and the natural key deduplicate.
 * 4. **A provider may invalidate a cursor.** `ConnectorError` with condition
 *    `CURSOR_EXPIRED` and `restart: 'from_null'`. The orchestrator restarts from
 *    `null` and relies on idempotent upsert — *never* by deleting data.
 *
 * ## What an adapter must not do
 *
 * - **Never write to the database.** A page is data; the caller owns persistence
 *   and the transaction boundary. This is what keeps an adapter testable against
 *   recorded fixtures with no database at all (04 §4.1).
 * - **Never persist a credential.** `connect` hands secrets back once;
 *   `@ctx/connections` seals them with `SecretBox` and hands them back through
 *   `ConnectionHandle.secret()` on each call.
 * - **Never log a credential.** Conformance asserts that serialising a handle
 *   yields no secret value, which is why `secret` is a function and not a field.
 * - **Never decide retry policy.** Classify the failure as a `ConnectorError`
 *   and stop; the orchestrator owns what happens next (08 §2.4).
 */
import { DateOnly, type Brand, type Clock } from '@core/kernel';
import type { Capability, ConnectorCapabilities } from './capabilities.ts';
import type {
  ProviderAccountFact,
  ProviderBalanceFact,
  ProviderHoldingFact,
  ProviderLiabilityFact,
  ProviderTransactionFact,
} from './facts.ts';

/**
 * An opaque provider sync token.
 *
 * Branded so a `providerTransactionId` cannot be passed where a cursor belongs.
 * The brand is erased at runtime; it is a string in the column and on the wire.
 */
export type Cursor = Brand<string, 'Cursor'>;

/** Brand a string the provider gave us. The only legitimate way to make a `Cursor`. */
export function cursorOf(value: string): Cursor {
  return value as Cursor;
}

/**
 * What an adapter is handed on every call.
 *
 * `secret` is a **function**, not a field. A field survives `JSON.stringify`, a
 * structured log line, an error's `redactedContext` and a debugger's object
 * dump; a closure does not. The cost is one call site per credential and the
 * benefit is that P0-1 ("no token in logs") is enforced by the shape of the type
 * rather than by everyone remembering.
 */
export interface ConnectionHandle {
  readonly connectionId: string;
  readonly userId: string;
  readonly provider: string;
  /** The provider's own id for this connection: a Plaid `item_id`, a file name. */
  readonly providerConnectionId: string;
  /** Opened from `connections.sealed_credentials` immediately before the call. */
  readonly secret: (name: string) => string | null;
}

/** Reference to one provider transaction, for `removed[]`. */
export interface ProviderTransactionRef {
  readonly providerAccountId: string;
  readonly providerTransactionId: string;
}

export const SYNC_REASONS = [
  'initial',
  'scheduled',
  'manual',
  'backfill',
  'repair',
  'webhook',
] as const;

export type SyncReason = (typeof SYNC_REASONS)[number];

export interface SyncOptions {
  readonly reason: SyncReason;
  /**
   * How far back to ask for. D16/01 §5.1: 730 on the first sync, or the
   * provider's `historyWindowDays` if that is smaller — Plaid's default is 90
   * and accepting it silently loses ~21 months we can never get back without
   * re-linking.
   */
  readonly historyDays: number;
  /** Rows per page. Plaid's ceiling is 500; the orchestrator's default is 500. */
  readonly pageSize: number;
  /** Hard budget. An adapter that cannot finish must raise, not truncate silently. */
  readonly deadline: Date;
  readonly signal: AbortSignal;
  readonly clock: Clock;
}

/**
 * One page of transaction truth.
 *
 * The four fields are Plaid's `/transactions/sync` shape, adopted as the
 * internal contract because it is the most expressive (01 §2.4): "diffing down
 * to a weaker model is easy; upgrading a weak model to a strong one after the
 * fact is not." A provider without a cursor gets a shim adapter that diffs a
 * fetched window against local state and synthesises `added`/`modified`/`removed`.
 */
export interface TransactionPage {
  readonly added: readonly ProviderTransactionFact[];
  readonly modified: readonly ProviderTransactionFact[];
  /** Ids only — Plaid's `removed[]` carries no objects, and neither do we. */
  readonly removed: readonly ProviderTransactionRef[];
  /**
   * Accounts this page mentions, when the provider volunteers them. The
   * orchestrator upserts them before the transactions so a first page cannot
   * reference an account that does not exist yet.
   */
  readonly accounts: readonly ProviderAccountFact[];
  readonly nextCursor: Cursor | null;
  readonly hasMore: boolean;
}

/** Everything the link flow produced. Secrets go straight to `SecretBox`. */
export interface ConnectResult {
  readonly providerConnectionId: string;
  readonly displayName: string;
  /**
   * Name → value. Sealed by `@ctx/connections` before it touches a disk and
   * never returned to the caller again.
   */
  readonly credentials: Readonly<Record<string, string>>;
  readonly accounts: readonly ProviderAccountFact[];
  /**
   * Capabilities *observed* during linking, where the provider tells us (Plaid's
   * `available_products`). Narrows, never widens, the declared set.
   */
  readonly observedCapabilities: readonly Capability[] | null;
  /** Open-banking style consent expiry, when the provider states one. */
  readonly consentExpiresAt: Date | null;
}

/** A cheap liveness probe. Must not consume refresh budget (08 §2.3). */
export interface ConnectorHealth {
  readonly reachable: boolean;
  readonly checkedAt: Date;
  readonly detail: string | null;
}

/**
 * The port.
 *
 * `connect` takes `unknown`: a Plaid public token, an API key form, an uploaded
 * file and a batch of hand-typed rows have nothing in common, and pretending
 * otherwise would mean a union that grows with every adapter. Each adapter
 * validates its own input with zod at the edge and raises
 * `ConnectorError{kind:'invalid_input'}` if it does not match — which is exactly
 * the contract the conformance suite checks.
 */
export interface Connector {
  /** Stable id. Matches `accounts.provider` and `connections.provider`. */
  readonly provider: string;
  readonly displayName: string;

  /**
   * What this adapter can do. A method rather than a field because a connector
   * built around a user-supplied mapping profile (CSV) computes it.
   */
  capabilities(): ConnectorCapabilities;

  /** Turn the user's completion artifact into durable credentials and accounts. */
  connect(input: unknown): Promise<ConnectResult>;

  /** Enumerate accounts. Called after linking and on every full sync. */
  listAccounts(handle: ConnectionHandle): Promise<readonly ProviderAccountFact[]>;

  /**
   * One page. `cursor === null` means "from the beginning of the window".
   *
   * MUST be resumable and MUST NOT write anything: the caller owns persistence
   * and the transaction boundary (04 §4.1).
   */
  syncTransactions(
    handle: ConnectionHandle,
    cursor: Cursor | null,
    options: SyncOptions,
  ): Promise<TransactionPage>;

  syncBalances(
    handle: ConnectionHandle,
    options: SyncOptions,
  ): Promise<readonly ProviderBalanceFact[]>;

  /** Only when `holdings` is declared; otherwise raise `unsupported`. */
  syncHoldings?(
    handle: ConnectionHandle,
    options: SyncOptions,
  ): Promise<readonly ProviderHoldingFact[]>;

  /** Only when `liabilities` is declared; otherwise raise `unsupported`. */
  syncLiabilities?(
    handle: ConnectionHandle,
    options: SyncOptions,
  ): Promise<readonly ProviderLiabilityFact[]>;

  /**
   * Best-effort revocation at the provider. The local purge is the caller's job
   * and happens whether this succeeds or not — a provider that is down must not
   * be able to prevent a user from disconnecting.
   */
  disconnect(handle: ConnectionHandle): Promise<void>;

  health?(handle: ConnectionHandle): Promise<ConnectorHealth>;
}

/** How linking starts, for the "Add a connection" screen. */
export const LINK_KINDS = [
  /** The provider runs the flow: Plaid Link, an OAuth redirect. */
  'provider_hosted',
  /** We collect an API key or a token ourselves. */
  'credential_form',
  /** The user hands us a file. */
  'file_upload',
  /** The user types the accounts. */
  'manual_entry',
] as const;

export type LinkKind = (typeof LINK_KINDS)[number];

/**
 * What the UI renders a provider from, so adding one needs no UI change (08 §2.7).
 *
 * Data, not components. `iconKey` names an asset the web app already ships
 * rather than carrying a URL or an SVG: a manifest is served from the API, and a
 * field the server controls that the browser renders as markup or fetches as a
 * resource is a hole. The UI maps an unknown key to a generic bank glyph, so a
 * Phase 2 adapter is renderable the day it registers and pretty the day someone
 * draws it.
 */
export interface ConnectorManifest {
  readonly provider: string;
  readonly displayName: string;
  readonly description: string;
  /** Asset key, lower-snake, from the web app's own icon set. Never a URL. */
  readonly iconKey: string;
  readonly linkKind: LinkKind;
  /** Where to read more. `null` when there is nothing to read. */
  readonly docsUrl: string | null;
}

/**
 * The earliest date a connector will be asked about.
 *
 * `null` means "no floor": the file, or the user, is the window. Clamping the
 * request to the declared window here rather than in each adapter is what makes
 * SimpleFIN's 90 days (01 §2.2) a data point instead of a special case.
 */
export function windowStart(
  capabilities: ConnectorCapabilities,
  requestedDays: number,
  today: DateOnly,
): DateOnly | null {
  if (capabilities.historyWindowDays === 'unbounded') return null;
  return DateOnly.addDays(today, -Math.min(requestedDays, capabilities.historyWindowDays));
}
