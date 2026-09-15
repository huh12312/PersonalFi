// SPDX-License-Identifier: MIT
/**
 * The composition root's domain wiring: Ledger and Connections, joined up.
 *
 * `apps/` is the only layer allowed to do this. `@ctx/connections` declares the
 * three ledger functions it needs as a *port* (`LedgerWriter`) because
 * `personalfi/layer-imports` denies `@ctx/*` → `@ctx/*` unconditionally, and the
 * port's own doc comment names this file as where the real implementations get
 * passed in.
 *
 * ## `ledgerWriter` is the type check
 *
 * The three properties below are bare references to `@ctx/ledger`'s exports, not
 * adapter functions. That is deliberate and it is the entire safety mechanism:
 * the day the ledger changes `applyProviderTransactions`'s signature,
 * `pnpm typecheck` fails *here*, in the eleven lines that assert the two halves
 * still fit. WP 1.2's evidence note lists this as its one deferred item —
 * "nothing in `@ctx/connections`'s own test suite can prove the shapes still
 * match" — and this is the thing that closes it.
 *
 * ## Process-local adapters
 *
 * `ManualConnector`, `CsvImportConnector` and `SeedConnector` stage their rows in
 * **process memory** (WP 1.2: `ManualStore`, `CsvImportConnector#staged`). A
 * connection of one of those providers can therefore only be synced by the
 * process that staged it, which is why `PROCESS_LOCAL_PROVIDERS` exists and why
 * `POST /connections/:id/sync` runs those inline instead of enqueuing a job the
 * worker would pick up and find nothing for. See the evidence note; making the
 * manual/CSV staging area durable is `@ctx/connections`'s to do, not this file's.
 */
import { CSV_MANIFEST, CsvImportConnector, IMPORT_PROVIDER } from '@connector/csv';
import {
  MANUAL_MANIFEST,
  MANUAL_PROVIDER,
  ManualConnector,
  ManualStore,
  SEED_PROVIDER,
} from '@connector/manual';
import type { Database } from '@core/db';
import type { Clock } from '@core/kernel';
import type { PlatformLogger } from '@core/platform';
import type { SecretBox } from '@core/secretbox';
import {
  ConnectorRegistry,
  SyncOrchestrator,
  type LedgerWriter,
  type RegisteredConnector,
} from '@ctx/connections';
import type { LedgerPort } from '@ctx/categorization';
import {
  applyProviderTransactions,
  listForCategorization,
  recordBalance,
  setRuleCategory,
  upsertAccount,
  type LedgerDatabase,
} from '@ctx/ledger';

/**
 * `@ctx/ledger`, as `@ctx/connections` asked for it.
 *
 * Three references and no adapter functions. If this stops compiling, the port
 * and the system of record have drifted and one of them is wrong.
 */
export const ledgerWriter: LedgerWriter = {
  applyProviderTransactions,
  upsertAccount,
  recordBalance,
};

/**
 * `@ctx/categorization`'s `LedgerPort`, for real.
 *
 * Unlike `ledgerWriter` above, this is a genuine adapter rather than bare
 * function references, and has to be: `@ctx/categorization`'s
 * `CategorizableTransaction` and `@ctx/ledger`'s `listForCategorization` row are
 * deliberately two different types (`@ctx/ledger` cannot import the other
 * context's type without importing the other context, which is exactly what
 * this port exists to avoid — decision D8), so something has to translate
 * between them, and this file — the composition root — is the only layer
 * allowed to.
 *
 * `writeRuleCategory` is the one write `@ctx/categorization` makes into another
 * context's table, and it is routed through `setRuleCategory` — the one ledger
 * function that touches `rule_category_id` and nothing else (wp1.4 evidence §6).
 * It is deliberately not routed through the categorization write's own
 * transaction: the two contexts do not share one, by design, the same way
 * `ledgerWriter`'s three functions each open their own.
 */
export function createCategorizationLedgerPort(database: LedgerDatabase, clock: Clock): LedgerPort {
  return {
    async listForCategorization(input) {
      const page = await listForCategorization(database, {
        userId: input.userId,
        filters: {
          ...(input.transactionIds === undefined ? {} : { transactionIds: input.transactionIds }),
          ...(input.accountIds === undefined ? {} : { accountIds: input.accountIds }),
          ...(input.dateFrom === undefined ? {} : { dateFrom: input.dateFrom }),
          ...(input.dateTo === undefined ? {} : { dateTo: input.dateTo }),
        },
        cursor: input.cursor ?? null,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
      return {
        items: page.items.map((row) => ({
          id: row.id,
          accountId: row.accountId,
          accountType: row.accountType,
          payee: row.payee,
          rawDescriptor: row.rawDescriptor,
          providerMerchantName: row.providerMerchantName,
          merchantId: row.merchantId,
          amountMinor: row.amount.minor,
          currency: row.amount.currency,
          date: row.date,
          providerCategory: row.providerCategory,
          // No provider or import path populates an MCC yet (wp1.4 evidence §8,
          // "MCC tier"); @ctx/ledger has no column to read one from.
          mcc: null,
          isTransfer: row.isTransfer,
          userCategoryId: row.userCategoryId,
        })),
        nextCursor: page.nextCursor,
      };
    },
    async writeRuleCategory(input) {
      await database.transaction(async (tx) =>
        setRuleCategory(
          tx,
          {
            userId: input.userId,
            transactionId: input.transactionId,
            ruleCategoryId: input.ruleCategoryId,
          },
          { clock, correlationId: input.correlationId, causationId: input.causationId ?? null },
        ),
      );
    },
  };
}

/**
 * Adapters whose staged rows live in this process's memory.
 *
 * Read `PROCESS_LOCAL_PROVIDERS.has(provider)` as "syncing this connection is
 * only meaningful in the process that linked it". A durable adapter — Plaid,
 * SimpleFIN, anything with a credential and a remote — is absent from this set
 * and syncs through the job queue like everything else.
 */
export const PROCESS_LOCAL_PROVIDERS: ReadonlySet<string> = new Set([
  MANUAL_PROVIDER,
  IMPORT_PROVIDER,
  SEED_PROVIDER,
]);

export interface ConnectorRegistryOptions {
  /** Extra adapters. The seed connector is injected here by the test harness. */
  readonly extra?: readonly RegisteredConnector[];
}

/**
 * Provider id → adapter, for this deployment.
 *
 * 08 §2.7's test of the abstraction is that adding a provider needs no UI change:
 * the "Add a connection" screen renders from `registry.manifests()`, so a new
 * adapter appears in the UI by being registered here and nowhere else.
 */
export function createConnectorRegistry(options: ConnectorRegistryOptions = {}): ConnectorRegistry {
  const registry = new ConnectorRegistry([
    { connector: new ManualConnector({ store: new ManualStore() }), manifest: MANUAL_MANIFEST },
    { connector: new CsvImportConnector(), manifest: CSV_MANIFEST },
  ]);

  // WP 1.3 hook — one line, and the Plaid adapter is live:
  // registry.register({ connector: new PlaidConnector(plaidOptions), manifest: PLAID_MANIFEST });

  for (const entry of options.extra ?? []) registry.register(entry);
  return registry;
}

export interface DomainRuntimeOptions {
  readonly database: Database;
  readonly clock: Clock;
  readonly logger: PlatformLogger;
  readonly registry: ConnectorRegistry;
  /** `null` until the KEK is derived; a locked application has no orchestrator. */
  readonly secretBox: SecretBox;
}

/** Everything a connections route needs, constructed once the app is unlocked. */
export interface DomainRuntime {
  readonly database: Database;
  readonly registry: ConnectorRegistry;
  readonly orchestrator: SyncOrchestrator;
  readonly secretBox: SecretBox;
  readonly clock: Clock;
}

export function createDomainRuntime(options: DomainRuntimeOptions): DomainRuntime {
  const orchestrator = new SyncOrchestrator({
    database: options.database,
    registry: options.registry,
    secretBox: options.secretBox,
    ledgerWriter,
    clock: options.clock,
    logger: options.logger,
  });
  return {
    database: options.database,
    registry: options.registry,
    orchestrator,
    secretBox: options.secretBox,
    clock: options.clock,
  };
}
