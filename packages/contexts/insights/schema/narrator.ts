// SPDX-License-Identifier: MIT
/**
 * The language model in Settings (WP 10.6; migration `0044_narrator_settings.sql`;
 * decision D30, which revises D22).
 *
 * `narrator_settings` says which model narrates for a holder; no row is the
 * behaviour before WP 10.6 (the operator's `LOCAL_MODEL_*` environment, else no
 * narrator). `narrator_provider_consents` keeps the holder's consent, per hosted
 * provider, to send the narrator's minimised, previewed and approved payload
 * there — with the exact consent text version they ticked. A hosted provider is
 * made active only over a standing consent row (the route's rule, and
 * `apps/api/test/db/narrator-settings-routes.test.ts`'s).
 */
import { createdAtColumn, idColumn, instantColumn, updatedAtColumn, userIdColumn } from '@core/db';
import { sql } from 'drizzle-orm';
import { pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/** Every narrator provider the product knows, and `off`. */
export const NARRATOR_PROVIDER_VALUES = [
  'ollama',
  'openai',
  'openrouter',
  'anthropic',
  'off',
] as const;
export type NarratorProviderValue = (typeof NARRATOR_PROVIDER_VALUES)[number];

/** The hosted providers: each needs the holder's own key and consent. */
export const HOSTED_NARRATOR_PROVIDERS = ['openai', 'openrouter', 'anthropic'] as const;
export type HostedNarratorProvider = (typeof HOSTED_NARRATOR_PROVIDERS)[number];

export const narratorSettings = pgTable('narrator_settings', {
  userId: uuid('user_id').primaryKey(),
  activeProvider: text('active_provider').$type<NarratorProviderValue>().notNull(),
  openaiModel: text('openai_model'),
  openrouterModel: text('openrouter_model'),
  anthropicModel: text('anthropic_model'),
  ollamaEndpoint: text('ollama_endpoint'),
  ollamaModel: text('ollama_model'),
  ollamaDigest: text('ollama_digest'),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
});

export type NarratorSettingsRow = typeof narratorSettings.$inferSelect;
export type NewNarratorSettingsRow = typeof narratorSettings.$inferInsert;

export const narratorProviderConsents = pgTable(
  'narrator_provider_consents',
  {
    id: idColumn(),
    userId: userIdColumn(),
    provider: text('provider').$type<HostedNarratorProvider>().notNull(),
    consentTextVersion: text('consent_text_version').notNull(),
    consentTextSha256: text('consent_text_sha256').notNull(),
    consentedAt: instantColumn('consented_at').notNull(),
    withdrawnAt: instantColumn('withdrawn_at'),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex('narrator_provider_consents_standing_idx')
      .on(table.userId, table.provider)
      .where(sql`withdrawn_at IS NULL`),
  ],
);

export type NarratorProviderConsentRow = typeof narratorProviderConsents.$inferSelect;
