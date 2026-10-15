// SPDX-License-Identifier: MIT
/**
 * `provider_credentials` — migrations `0041_provider_credentials.sql` and
 * `0043_provider_credentials_market_data.sql`.
 *
 * A holder's provider API credentials (their Plaid client id and secret, and
 * since WP 10.4 their tiingo / fred / coingecko / openfigi keys), sealed under
 * the KEK. See the migration's header for the custody argument and
 * `src/provider-credentials.ts` for the AAD. This file is the query surface and
 * the ownership claim, not the DDL.
 */
import { byteaColumn, createdAtColumn, idColumn, instantColumn, userIdColumn } from '@core/db';
import { pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';

export const PROVIDER_CREDENTIAL_PROVIDERS = [
  'plaid',
  'tiingo',
  'fred',
  'coingecko',
  'openfigi',
  // WP 10.6 (0044): the narrator's hosted providers' keys and an optional
  // Ollama bearer token — single-value keys with 0043's shape.
  'openai',
  'openrouter',
  'anthropic',
  'ollama',
] as const;
export type ProviderCredentialProvider = (typeof PROVIDER_CREDENTIAL_PROVIDERS)[number];

/**
 * The market-data providers whose single API key this table can hold (WP 10.4,
 * migration 0043). Asserted equal to `@ctx/integrations`' keyed providers by the
 * api's market-data credential tests; a subset of the CHECK's list above.
 */
export const MARKET_DATA_KEY_PROVIDERS = ['tiingo', 'fred', 'coingecko', 'openfigi'] as const;
export type MarketDataKeyProvider = (typeof MARKET_DATA_KEY_PROVIDERS)[number];

/** WP 10.6: the language-model keys (and Ollama's optional bearer token). Single values, 0043's shape. */
export const LANGUAGE_MODEL_KEY_PROVIDERS = [
  'openai',
  'openrouter',
  'anthropic',
  'ollama',
] as const;
export type LanguageModelKeyProvider = (typeof LANGUAGE_MODEL_KEY_PROVIDERS)[number];

/** Every provider whose credential is one sealed value rather than Plaid's pair. */
export type SingleKeyProvider = MarketDataKeyProvider | LanguageModelKeyProvider;

export const PROVIDER_CREDENTIAL_ENVS = ['sandbox', 'production'] as const;
export type ProviderCredentialEnv = (typeof PROVIDER_CREDENTIAL_ENVS)[number];

export const providerCredentials = pgTable(
  'provider_credentials',
  {
    id: idColumn(),
    userId: userIdColumn(),
    provider: text('provider').$type<ProviderCredentialProvider>().notNull(),
    /** `SecretBox` envelope. Never plaintext. */
    clientIdSealed: byteaColumn('client_id_sealed').notNull(),
    /** `SecretBox` envelope. Never plaintext, never returned by a route. */
    secretSealed: byteaColumn('secret_sealed').notNull(),
    /** Plaid's environment; NULL for a market-data key (0043's `env_by_provider` CHECK). */
    env: text('env').$type<ProviderCredentialEnv>(),
    /** Last four characters of the client id (or of a market-data key), for display only. */
    clientIdHint: text('client_id_hint').notNull(),
    createdAt: createdAtColumn(),
    rotatedAt: instantColumn('rotated_at'),
  },
  (table) => [
    uniqueIndex('provider_credentials_user_provider_key').on(table.userId, table.provider),
  ],
);

export type ProviderCredentialRow = typeof providerCredentials.$inferSelect;
export type NewProviderCredentialRow = typeof providerCredentials.$inferInsert;
