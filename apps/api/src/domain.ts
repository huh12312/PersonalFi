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
import { applyProviderTransactions, recordBalance, upsertAccount } from '@ctx/ledger';

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
