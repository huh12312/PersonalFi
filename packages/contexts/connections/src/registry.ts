// SPDX-License-Identifier: MIT
/**
 * `ConnectorRegistry` — provider id → adapter.
 *
 * The one place `provider === 'plaid'` is allowed to appear, and even here it
 * appears as a map key rather than as a branch. 08 §2.2 states the rule: "the
 * orchestrator branches on [capabilities] — no `if (provider === 'plaid')`
 * anywhere outside `adapters/plaid/`". Everything downstream of this lookup
 * works from the `Connector` interface and the capability flags.
 *
 * Populated at the composition root, which is also what makes "swap the
 * aggregator under pressure" a config change: registering `SimpleFinConnector`
 * instead of `PlaidConnector` is one line in `apps/api`, and nothing in this
 * context, in the orchestrator, or in the UI changes.
 */
import { ConnectionsError } from './errors.ts';
import type { Connector, ConnectorManifest } from './port.ts';

export interface RegisteredConnector {
  readonly connector: Connector;
  readonly manifest: ConnectorManifest;
}

export class ConnectorRegistry {
  readonly #byProvider = new Map<string, RegisteredConnector>();

  constructor(entries: readonly RegisteredConnector[] = []) {
    for (const entry of entries) this.register(entry);
  }

  register(entry: RegisteredConnector): void {
    if (entry.manifest.provider !== entry.connector.provider) {
      // A manifest that names a different provider than the adapter it describes
      // would render the wrong icon and, worse, be looked up under an id the
      // adapter never writes into `accounts.provider`.
      throw new ConnectionsError(
        'connections.unknown_provider',
        `manifest provider ${entry.manifest.provider} does not match connector ${entry.connector.provider}`,
      );
    }
    this.#byProvider.set(entry.connector.provider, entry);
  }

  get(provider: string): Connector {
    const entry = this.#byProvider.get(provider);
    if (entry === undefined) {
      // A connection row naming a provider nobody registered is not a provider
      // failure and must not be retried: it means a module is disabled or a
      // deployment is missing an adapter.
      throw new ConnectionsError(
        'connections.unknown_provider',
        `no connector is registered for provider ${JSON.stringify(provider)}`,
      );
    }
    return entry.connector;
  }

  has(provider: string): boolean {
    return this.#byProvider.has(provider);
  }

  /** What the "add a connection" screen renders. Sorted, so the UI is stable. */
  manifests(): readonly ConnectorManifest[] {
    return [...this.#byProvider.values()]
      .map((entry) => entry.manifest)
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }
}
