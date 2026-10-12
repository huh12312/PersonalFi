// SPDX-License-Identifier: MIT
/**
 * `provider_credentials` — migration `0041_provider_credentials.sql`.
 *
 * A holder's provider API credentials (today: their Plaid client id and secret),
 * sealed under the KEK. See the migration's header for the custody argument and
 * `src/provider-credentials.ts` for the AAD. This file is the query surface and
 * the ownership claim, not the DDL.
 */
import { byteaColumn, createdAtColumn, idColumn, instantColumn, userIdColumn } from '@core/db';
import { pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';

export const PROVIDER_CREDENTIAL_PROVIDERS = ['plaid'] as const;
export type ProviderCredentialProvider = (typeof PROVIDER_CREDENTIAL_PROVIDERS)[number];

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
    env: text('env').$type<ProviderCredentialEnv>().notNull(),
    /** Last four characters of the client id, for display only. */
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
