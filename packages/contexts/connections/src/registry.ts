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
import { systemClock, type Clock } from '@core/kernel';
import { ConnectionsError } from './errors.ts';
import type { Connector, ConnectorManifest } from './port.ts';

export interface RegisteredConnector {
  readonly connector: Connector;
  readonly manifest: ConnectorManifest;
}

/**
 * A provider that exists only while its holder has credentials for it (WP 10.1).
 *
 * The static entries above are decided once, at boot, from the operator's files.
 * A holder who pastes their own Plaid keys into the product changes the answer
 * while the process runs, so the answer is a question asked per holder: `resolve`
 * returns the adapter built from that holder's stored credentials, or `null`
 * when there are none (or they are unusable). The registry caches the answer for
 * a short time and `invalidate` drops it, which is what a
 * `connections.ProviderCredentialsChanged` event does.
 */
export interface DynamicConnector {
  readonly provider: string;
  readonly manifest: ConnectorManifest;
  resolve(userId: string): Promise<Connector | null>;
}

/** Short on purpose: a replaced key reaches a process the event cannot reach within this. */
export const DEFAULT_DYNAMIC_TTL_MS = 30_000;

export interface ConnectorRegistryOptions {
  readonly clock?: Clock;
  /** How long a resolved (or absent) dynamic connector is trusted. */
  readonly dynamicTtlMs?: number;
}

interface CacheEntry {
  readonly expiresAtMs: number;
  readonly connector: Connector | null;
}

export class ConnectorRegistry {
  readonly #byProvider = new Map<string, RegisteredConnector>();
  readonly #dynamic = new Map<string, DynamicConnector>();
  /** Keyed `provider\0userId`. */
  readonly #cache = new Map<string, CacheEntry>();
  readonly #inflight = new Map<string, Promise<Connector | null>>();
  /** Bumped by `invalidate`, so a resolve that began before it cannot repopulate the cache. */
  #generation = 0;
  readonly #clock: Clock;
  readonly #ttlMs: number;

  constructor(
    entries: readonly RegisteredConnector[] = [],
    options: ConnectorRegistryOptions = {},
  ) {
    this.#clock = options.clock ?? systemClock;
    this.#ttlMs = options.dynamicTtlMs ?? DEFAULT_DYNAMIC_TTL_MS;
    for (const entry of entries) this.register(entry);
  }

  /**
   * Register a provider that is resolved per holder. A static registration of
   * the same provider wins: the operator's files take precedence, and `has`/`get`
   * never consult the dynamic entry for it.
   */
  registerDynamic(entry: DynamicConnector): void {
    if (entry.manifest.provider !== entry.provider) {
      throw new ConnectionsError(
        'connections.unknown_provider',
        `manifest provider ${entry.manifest.provider} does not match dynamic provider ${entry.provider}`,
      );
    }
    this.#dynamic.set(entry.provider, entry);
  }

  /** Drop what was resolved for one provider (or all), for every holder. */
  invalidate(provider?: string): void {
    this.#generation += 1;
    for (const key of [...this.#cache.keys()]) {
      if (provider === undefined || key.startsWith(`${provider}\0`)) this.#cache.delete(key);
    }
    for (const key of [...this.#inflight.keys()]) {
      if (provider === undefined || key.startsWith(`${provider}\0`)) this.#inflight.delete(key);
    }
  }

  async #resolveDynamic(provider: string, userId: string): Promise<Connector | null> {
    const entry = this.#dynamic.get(provider);
    if (entry === undefined) return null;
    const key = `${provider}\0${userId}`;
    const cached = this.#cache.get(key);
    if (cached !== undefined && cached.expiresAtMs > this.#clock.nowMs()) return cached.connector;
    const pending = this.#inflight.get(key);
    if (pending !== undefined) return pending;

    const generation = this.#generation;
    const started = entry
      .resolve(userId)
      .then((connector) => {
        if (generation === this.#generation) {
          this.#cache.set(key, {
            connector,
            expiresAtMs: this.#clock.nowMs() + this.#ttlMs,
          });
        }
        return connector;
      })
      .finally(() => {
        if (this.#inflight.get(key) === started) this.#inflight.delete(key);
      });
    this.#inflight.set(key, started);
    return started;
  }

  /**
   * The adapter for `provider` as `userId` sees it: a static registration, else
   * the holder's own dynamic one. Throws `connections.unknown_provider` when
   * neither exists, exactly as `get` does.
   */
  async connectorFor(provider: string, userId: string): Promise<Connector> {
    const staticEntry = this.#byProvider.get(provider);
    if (staticEntry !== undefined) return staticEntry.connector;
    const dynamic = await this.#resolveDynamic(provider, userId);
    if (dynamic === null) return this.get(provider);
    return dynamic;
  }

  async hasFor(provider: string, userId: string): Promise<boolean> {
    if (this.#byProvider.has(provider)) return true;
    return (await this.#resolveDynamic(provider, userId)) !== null;
  }

  /** `manifests()` plus every dynamic provider this holder currently has. */
  async manifestsFor(userId: string): Promise<readonly ConnectorManifest[]> {
    const manifests = [...this.manifests()];
    for (const entry of this.#dynamic.values()) {
      if (this.#byProvider.has(entry.provider)) continue;
      if ((await this.#resolveDynamic(entry.provider, userId)) !== null) {
        manifests.push(entry.manifest);
      }
    }
    return manifests.sort((a, b) => a.displayName.localeCompare(b.displayName));
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
