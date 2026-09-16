// SPDX-License-Identifier: MIT
/**
 * `CsvImportConnector` — a file is a provider.
 *
 * The same port as Plaid, so the orchestrator, the events and the sync-run
 * history all work identically (08 §2.6). What differs is only what the
 * capabilities say: no webhooks, no reconnect (there is no credential to
 * refresh — you re-upload), and an unbounded history window, because the window
 * is whatever the file contains.
 *
 * The cursor is an offset into the staged rows. A 10,000-row statement therefore
 * arrives as pages and is committed per page, like everything else — which is
 * what keeps the import inside the 30-second budget of 08 §7 without one
 * transaction holding a lock over `transactions` for the whole of it.
 *
 * ## Durable staging (decision D-5), and why `addFile` stays synchronous
 *
 * `#staged` is an in-memory `Map`, unchanged from before this connector had a
 * durable backing store: it is still what `addFile` and `connect` write to,
 * synchronously, and still what every read comes from. `apps/api/src/routes/connections.ts`
 * calls `connector.addFile(...)` directly, unawaited, so `addFile` returning a
 * `Promise` would silently break that call site — a route this package's
 * OWNERSHIP.md does not claim, and so cannot change to accommodate an async
 * `addFile`.
 *
 * `StagingStore` (`staging.ts`) is a mirror this connector reads from and
 * writes to at the one seam every request already crosses: `#sync`, called at
 * the top of every method that receives a `ConnectionHandle` (`listAccounts`,
 * `syncTransactions`, `syncBalances`) — every method `connect` and `addFile`
 * are *not*, because neither is told a `connectionId` or a `userId`.
 * `apps/api`'s route always calls the orchestrator (which calls those three)
 * in the same request, immediately after staging a file, so by the time the
 * HTTP response returns, whatever `addFile` staged has already been flushed to
 * the durable store. The gap this leaves: a *second* `addFile` call, in a
 * process that has never synced this connection since it booted, stages onto
 * an empty local `Map` and reports `skipped: 0` for rows another process
 * already staged durably. Recorded in
 * docs/evidence/phase-1/wp1.2-connections.md's "Durable staging (D-5)"
 * section — the ledger's own natural-key upsert still absorbs the eventual
 * duplicate, per `addFile`'s own comment below.
 */
import {
  ConnectorError,
  assertSupports,
  cursorOf,
  emptyPage,
  type ConnectResult,
  type ConnectionHandle,
  type Connector,
  type ConnectorCapabilities,
  type ConnectorManifest,
  type Cursor,
  type ProviderAccountFact,
  type ProviderBalanceFact,
  type ProviderTransactionFact,
  type SyncOptions,
  type TransactionPage,
} from '@connector/port';
import { newId } from '@core/kernel';
import { parseCsvProfile } from './config.ts';
import { asInvalidInput } from './errors.ts';
import { IMPORT_PROVIDER, importFile, type ImportFileInput } from './import.ts';
import { presetById, type CsvProfile } from './presets.ts';
import type { StagingStore } from './staging.ts';

export const CSV_CAPABILITIES: ConnectorCapabilities = Object.freeze({
  supports: Object.freeze([
    'accounts',
    'transactions',
    'balances',
    'incremental_sync',
    'historical_backfill',
  ] as const),
  // The file is the window, and it is not ours to bound.
  historyWindowDays: 'unbounded',
  minSyncIntervalSeconds: 0,
  refreshBudgetPerDay: null,
  supportsWebhooks: false,
  // A file import has no credential that can expire; the fix is a new file.
  reconnectFlow: 'reupload',
  consentWindowDays: null,
  currencies: 'multi',
});

export const CSV_MANIFEST: ConnectorManifest = Object.freeze({
  provider: IMPORT_PROVIDER,
  displayName: 'File import',
  description:
    'CSV with a column mapping, OFX/QFX from a bank download, or QIF from Quicken. Re-importing ' +
    'the same file changes nothing: every row is identified by a hash of its own content.',
  iconKey: 'file_arrow_up',
  linkKind: 'file_upload',
  docsUrl: null,
});

interface Staged {
  readonly accounts: Map<string, ProviderAccountFact>;
  readonly balances: Map<string, ProviderBalanceFact>;
  /** Append-only. The cursor is an index into this. */
  readonly transactions: ProviderTransactionFact[];
  /** Ids already staged, so importing an overlapping file does not restage them. */
  readonly seen: Set<string>;
}

export interface CsvConnectorOptions {
  /** Rows per page. 500 matches Plaid's ceiling, so the orchestrator sees one shape. */
  readonly pageSize?: number;
}

/**
 * What `connect` accepts.
 *
 * Not validated with zod, unlike `ManualConnector`'s: the useful validation here
 * is the parse itself, which produces a line number and a reason, and a zod
 * schema over `{name, content}` would only restate that the caller passed two
 * strings while making the real error arrive one layer later.
 */
export interface CsvConnectInput {
  readonly displayName: string;
  readonly providerConnectionId?: string;
  readonly files: readonly CsvFileInput[];
}

export interface CsvFileInput extends Omit<ImportFileInput, 'profile'> {
  /** A `CsvProfile`, or the id of one of `CSV_PRESETS`. */
  readonly profile?: CsvProfile | string;
}

export class CsvImportConnector implements Connector {
  readonly provider = IMPORT_PROVIDER;
  readonly displayName = CSV_MANIFEST.displayName;
  readonly #staged = new Map<string, Staged>();
  /** `null` until `attachStagingStore` runs — a test with no database, say. */
  #durable: StagingStore | null = null;
  /** How many of `#staged`'s transactions, per connection, are already durable. */
  readonly #flushed = new Map<string, number>();
  readonly #pageSize: number;

  constructor(options: CsvConnectorOptions = {}) {
    this.#pageSize = options.pageSize ?? 500;
  }

  /**
   * Point this connector at a durable mirror. Called once, at boot, by
   * `apps/api/src/domain.ts` — the one place a `Database` and this registry
   * both exist. See the module comment for why `addFile` itself never touches
   * it directly.
   */
  attachStagingStore(store: StagingStore): void {
    this.#durable = store;
  }

  capabilities(): ConnectorCapabilities {
    return CSV_CAPABILITIES;
  }

  async connect(input: unknown): Promise<ConnectResult> {
    const request = input as CsvConnectInput | undefined;
    if (
      request === null ||
      typeof request !== 'object' ||
      typeof request.displayName !== 'string' ||
      !Array.isArray(request.files) ||
      request.files.length === 0
    ) {
      throw new ConnectorError('a file import needs a display name and at least one file', {
        kind: 'invalid_input',
        condition: 'CONFIG_ERROR',
      });
    }

    const providerConnectionId = request.providerConnectionId ?? newId();
    this.#open(providerConnectionId);
    for (const file of request.files) this.addFile(providerConnectionId, file);

    return {
      providerConnectionId,
      displayName: request.displayName,
      // A file import holds no credential. Nothing to seal, nothing to leak,
      // nothing to rotate — which is also why `reconnectFlow` is `reupload`.
      credentials: {},
      accounts: [...this.#state(providerConnectionId).accounts.values()],
      observedCapabilities: null,
      consentExpiresAt: null,
    };
  }

  /**
   * Stage another file onto an existing connection.
   *
   * The user's monthly download lands here. Rows already staged under the same
   * id are skipped, so importing January and then January-plus-February adds
   * only February's rows to the page stream — and even if it did not, the
   * ledger's natural-key upsert would make the replay a no-op. Two layers,
   * because the cheap one saves the pages and the durable one saves the data.
   */
  addFile(providerConnectionId: string, file: CsvFileInput): { staged: number; skipped: number } {
    const state = this.#state(providerConnectionId);
    const profile = resolveProfile(file);

    // Rebuilt rather than spread: `CsvFileInput.profile` may be a preset *id*,
    // and `exactOptionalPropertyTypes` is right to refuse handing that on as if
    // it were a resolved profile.
    const request: ImportFileInput = {
      name: file.name,
      content: file.content,
      ...(file.format === undefined ? {} : { format: file.format }),
      ...(file.account === undefined ? {} : { account: file.account }),
      ...(profile === null ? {} : { profile }),
    };

    let result;
    try {
      result = importFile(request);
    } catch (cause) {
      throw asInvalidInput(cause, file.name);
    }

    for (const account of result.accounts) state.accounts.set(account.providerAccountId, account);
    for (const balance of result.balances) state.balances.set(balance.providerAccountId, balance);

    let staged = 0;
    let skipped = 0;
    for (const transaction of result.transactions) {
      if (state.seen.has(transaction.providerTransactionId)) {
        skipped += 1;
        continue;
      }
      state.seen.add(transaction.providerTransactionId);
      state.transactions.push(transaction);
      staged += 1;
    }
    return { staged, skipped };
  }

  async listAccounts(handle: ConnectionHandle): Promise<readonly ProviderAccountFact[]> {
    await this.#sync(handle);
    return [...this.#state(handle.providerConnectionId).accounts.values()];
  }

  async syncTransactions(
    handle: ConnectionHandle,
    cursor: Cursor | null,
    _options: SyncOptions,
  ): Promise<TransactionPage> {
    await this.#sync(handle);
    const state = this.#state(handle.providerConnectionId);
    const from = parseCursor(cursor, state.transactions.length);
    const slice = state.transactions.slice(from, from + this.#pageSize);
    const accounts = cursor === null ? [...state.accounts.values()] : [];

    if (slice.length === 0) {
      return { ...emptyPage(cursorOf(String(from))), accounts };
    }

    return {
      added: slice,
      // A statement never revises or retracts a row it already printed. If a
      // bank reissues a corrected statement it is a new file with new content,
      // and therefore new ids — which is why this is honestly always empty
      // rather than defensively populated.
      modified: [],
      removed: [],
      accounts,
      nextCursor: cursorOf(String(from + slice.length)),
      hasMore: from + slice.length < state.transactions.length,
    };
  }

  async syncBalances(
    handle: ConnectionHandle,
    _options: SyncOptions,
  ): Promise<readonly ProviderBalanceFact[]> {
    await this.#sync(handle);
    assertSupports(this.provider, this.capabilities(), 'balances');
    // Empty for CSV and QIF, populated for OFX (`LEDGERBAL`). An empty array here
    // is honest: the file genuinely stated no balance.
    return [...this.#state(handle.providerConnectionId).balances.values()];
  }

  async disconnect(handle: ConnectionHandle): Promise<void> {
    this.#staged.delete(handle.providerConnectionId);
    this.#flushed.delete(handle.providerConnectionId);
    if (this.#durable !== null) await this.#durable.close(handle.connectionId);
  }

  #open(providerConnectionId: string): void {
    if (this.#staged.has(providerConnectionId)) return;
    this.#staged.set(providerConnectionId, {
      accounts: new Map(),
      balances: new Map(),
      transactions: [],
      seen: new Set(),
    });
  }

  #state(providerConnectionId: string): Staged {
    const state = this.#staged.get(providerConnectionId);
    if (state === undefined) {
      throw ConnectorError.fromCondition(
        'AUTH_REQUIRED',
        'this import has been disconnected; upload the file again',
        { redactedContext: { providerConnectionId } },
      );
    }
    return state;
  }

  /**
   * Make `#staged` current before a call reads it: hydrate from `#durable` if
   * this process has never opened the connection, then flush whatever
   * `#staged` now holds back to `#durable` so a *different* process — the
   * worker, or the api after a restart — can see it next. See the module
   * comment for why `addFile` cannot do this itself.
   */
  async #sync(handle: ConnectionHandle): Promise<void> {
    const durable = this.#durable;
    if (durable === null) return; // `#state` below throws if nothing was ever staged.
    if (!this.#staged.has(handle.providerConnectionId)) {
      if (await durable.has(handle.connectionId)) await this.#hydrate(handle);
    }
    await this.#flush(handle);
  }

  async #hydrate(handle: ConnectionHandle): Promise<void> {
    const durable = this.#durable;
    if (durable === null) return;
    const { connectionId, providerConnectionId } = handle;
    const [accounts, balances, entries] = await Promise.all([
      durable.accounts(connectionId),
      durable.balances(connectionId),
      durable.entriesAfter(connectionId, 0, Number.MAX_SAFE_INTEGER),
    ]);
    this.#open(providerConnectionId);
    const state = this.#state(providerConnectionId);
    for (const account of accounts) state.accounts.set(account.providerAccountId, account);
    for (const balance of balances) state.balances.set(balance.providerAccountId, balance);
    // Durable order is staging order (see the migration's `seq` column), so
    // replaying it in order reproduces the same array `addFile` would have
    // built — which is what keeps the offset-based cursor meaning the same
    // position in either process.
    for (const entry of entries) {
      if (entry.fact === null) continue; // this connector only ever stages `added`.
      state.seen.add(entry.providerTransactionId);
      state.transactions.push(entry.fact);
    }
    this.#flushed.set(providerConnectionId, entries.length);
  }

  async #flush(handle: ConnectionHandle): Promise<void> {
    const durable = this.#durable;
    if (durable === null) return;
    const state = this.#staged.get(handle.providerConnectionId);
    if (state === undefined) return; // nothing local to flush; #state() below will throw.
    const { connectionId, userId, providerConnectionId } = handle;
    await durable.open(connectionId, userId);

    const accounts = [...state.accounts.values()];
    if (accounts.length > 0) await durable.putAccounts(connectionId, userId, accounts);

    const balances = [...state.balances.values()];
    if (balances.length > 0) await durable.putBalances(connectionId, userId, balances);

    const already = this.#flushed.get(providerConnectionId) ?? 0;
    const pending = state.transactions.slice(already);
    if (pending.length > 0) {
      await durable.appendTransactions(
        connectionId,
        userId,
        pending.map((fact) => ({
          kind: 'added',
          providerAccountId: fact.providerAccountId,
          providerTransactionId: fact.providerTransactionId,
          fact,
        })),
      );
      this.#flushed.set(providerConnectionId, state.transactions.length);
    }
  }
}

function resolveProfile(file: CsvFileInput): CsvProfile | null {
  if (file.profile === undefined) return null;
  // Validated rather than trusted, even though the type says `CsvProfile`: the
  // profile that reaches here is user data read back out of `connections.config`
  // (JSONB), where it was `unknown` until someone asserted otherwise. See
  // `config.ts` for what a profile that drifted does if nobody checks it.
  if (typeof file.profile !== 'string') return parseCsvProfile(file.profile);
  const preset = presetById(file.profile);
  if (preset === null) {
    throw new ConnectorError(`no import preset named ${JSON.stringify(file.profile)}`, {
      kind: 'invalid_input',
      condition: 'CONFIG_ERROR',
    });
  }
  return preset;
}

function parseCursor(cursor: Cursor | null, staged: number): number {
  if (cursor === null) return 0;
  const value = Number(cursor);
  if (!Number.isInteger(value) || value < 0 || value > staged) {
    // A cursor past the end means the staged rows are gone — the process
    // restarted, and this connector's staging is in memory. A full re-pull is
    // the honest recovery and it is safe: every id is a content hash.
    throw ConnectorError.fromCondition(
      'CURSOR_EXPIRED',
      'the staged import no longer has this page',
    );
  }
  return value;
}
