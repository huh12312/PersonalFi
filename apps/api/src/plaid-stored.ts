// SPDX-License-Identifier: MIT
/**
 * Plaid, with the credentials a holder stored in the product (WP 10.1).
 *
 * Two ways in, one precedence:
 *
 * 1. **The operator's secret files** (`plaid_client_id`, `plaid_secret`,
 *    `plaid_env`, `PLAID_ENABLED`). When they are non-empty, `config.plaid` is
 *    non-null, `createConnectorRegistry` registers the connector statically, and
 *    nothing here runs: the files win, and the product shows them read-only.
 * 2. **The holder's stored credentials** (`provider_credentials`, sealed under the
 *    KEK). With no files, `withStoredPlaid` registers Plaid as a *dynamic*
 *    provider: `registry.connectorFor('plaid', userId)` reads the sealed row,
 *    opens it, builds the client and caches it for a short time; the
 *    `connections.ProviderCredentialsChanged` event (api: dropped in-process by
 *    the route; worker: dropped by its consumer) invalidates the cache. No restart.
 *
 * This is the one place a stored Plaid secret is turned into bytes. It lives in
 * memory only inside the client built from it (the axios default headers, held
 * for the registry cache's short TTL, as the file path holds it for the life of
 * the process), and is never logged, never put in an error message and never
 * returned: the log lines below carry the provider and the environment only.
 *
 * `PLAID_ENABLED` keeps its meaning for the file path alone. It is, separately,
 * the switch that widens the proxy's CSP so Plaid Link's script can load (D26),
 * and that is not something this process can change: a holder who stores
 * credentials in an install whose proxy has `PLAID_ENABLED=false` will register
 * the connector and mint link tokens, and Link will not open in the browser.
 * RUNBOOK says so.
 */
import {
  createPlaidApi,
  PLAID_MANIFEST,
  PLAID_PROVIDER,
  PlaidConnector,
  type PlaidApiLike,
  type PlaidCredentials,
  type PlaidLinkSettings,
} from '@connector/plaid';
import type { AppConfig } from '@core/config';
import type { Database } from '@core/db';
import { systemClock, type Clock } from '@core/kernel';
import type { PlatformLogger } from '@core/platform';
import { isSecretBoxError, type SecretBox } from '@core/secretbox';
import { openProviderCredentials, type ConnectorRegistry } from '@ctx/connections';

/** Builds the Plaid client for a set of credentials. Tests substitute `FakePlaidApi`. */
export type PlaidApiFactory = (credentials: PlaidCredentials) => PlaidApiLike;

export interface StoredPlaidOptions {
  readonly config: AppConfig;
  readonly database: Database;
  /** Resolved fresh on every use: the api's box exists only after unlock. */
  readonly secretBox: () => SecretBox | undefined;
  readonly clock?: Clock;
  readonly logger?: PlatformLogger;
  /** A seam for tests; production builds the real client. */
  readonly apiFactory?: PlaidApiFactory;
}

export interface StoredPlaid {
  /** `PLAID_ALLOW_PRODUCTION` — the same gate the file path has (D16). */
  readonly allowProduction: boolean;
  /** Whether the operator's files configure Plaid (they take precedence). */
  readonly filesConfigured: boolean;
  /** The files' environment, when they do. */
  readonly filesEnvironment: 'sandbox' | 'production' | null;
  /** A connector for `credentials`; used both by the registry and to validate a PUT. */
  buildConnector(credentials: PlaidCredentials): PlaidConnector;
  /** Register Plaid as a dynamic provider on `registry`, unless it already has Plaid. */
  register(registry: ConnectorRegistry): ConnectorRegistry;
}

function linkSettings(config: AppConfig): PlaidLinkSettings {
  const env = config.env;
  return {
    clientName: env.PLAID_CLIENT_NAME,
    countryCodes: env.PLAID_COUNTRY_CODES.split(',')
      .map((code) => code.trim())
      .filter((code) => code.length > 0),
    language: env.PLAID_LANGUAGE,
    redirectUri: env.PLAID_REDIRECT_URI,
    webhookUrl: env.PLAID_WEBHOOK_URL,
  };
}

export function createStoredPlaid(options: StoredPlaidOptions): StoredPlaid {
  const { config, database, logger } = options;
  const clock = options.clock ?? systemClock;
  const apiFactory: PlaidApiFactory = options.apiFactory ?? createPlaidApi;
  const allowProduction = config.env.PLAID_ALLOW_PRODUCTION;
  const settings = linkSettings(config);

  const buildConnector = (credentials: PlaidCredentials): PlaidConnector =>
    new PlaidConnector({ api: apiFactory(credentials), settings, clock });

  return {
    allowProduction,
    filesConfigured: config.plaid !== null,
    filesEnvironment: config.plaid?.environment ?? null,
    buildConnector,
    register(registry) {
      // The operator's files win: an injected or file-configured registry that
      // already has Plaid keeps it, and the product's stored credentials stay
      // dormant (the route says so and refuses to write them).
      if (registry.has(PLAID_PROVIDER)) return registry;
      registry.registerDynamic({
        provider: PLAID_PROVIDER,
        manifest: PLAID_MANIFEST,
        async resolve(userId) {
          const box = options.secretBox();
          if (box === undefined) return null;
          let opened;
          try {
            opened = await openProviderCredentials(database, box, userId, PLAID_PROVIDER);
          } catch (error) {
            // A sealed value that will not open is "no usable credentials", said
            // by name and nothing else: the cause can carry key identifiers. Any
            // other failure (the database) is not that, and propagates so a sync
            // retries instead of being told Plaid does not exist.
            if (!isSecretBoxError(error)) throw error;
            logger?.warn(
              { provider: PLAID_PROVIDER, reason: error.code },
              'stored plaid credentials could not be opened; connector not registered',
            );
            return null;
          }
          if (opened === null) return null;
          if (opened.env === 'production' && !allowProduction) {
            logger?.warn(
              { provider: PLAID_PROVIDER, environment: opened.env },
              'stored plaid credentials are for production but PLAID_ALLOW_PRODUCTION is not set; connector not registered',
            );
            return null;
          }
          const connector = buildConnector({
            clientId: opened.clientId(),
            secret: opened.secret(),
            environment: opened.env,
          });
          logger?.info(
            { provider: PLAID_PROVIDER, environment: opened.env, source: 'stored' },
            'plaid configured from stored credentials; connector registered',
          );
          return connector;
        },
      });
      return registry;
    },
  };
}

/**
 * The composition roots' one-liner: `withStoredPlaid(createConnectorRegistry({…}), stored)`.
 * Both `app.ts` and `worker.ts` build their registry through it, so the api and
 * the worker cannot disagree about where Plaid comes from (re-gate N-5).
 */
export function withStoredPlaid(
  registry: ConnectorRegistry,
  stored: StoredPlaid,
): ConnectorRegistry {
  return stored.register(registry);
}
