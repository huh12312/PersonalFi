// SPDX-License-Identifier: MIT
/**
 * `market_data_consents` — migration `0064_market_data_consent.sql` (WP 12.6, D33).
 *
 * The holder's consent to an opt-in market-data provider. Today exactly one:
 * `yfinance`, whose data has no licence and whose terms prohibit automated
 * collection (docs/research/14 §2), so the holder is asked in words before a
 * single request may leave on their behalf. The shape is 0044's
 * `narrator_provider_consents`: a version naming the wording, the sha256 of
 * its bytes, when given, when withdrawn; never deleted.
 *
 * The CHECK constraints live in the migration.
 */
import { createdAtColumn, idColumn, instantColumn, userIdColumn } from '@core/db';
import { pgTable, text } from 'drizzle-orm/pg-core';

/** The providers a holder consents to. A keyed provider's consent is pasting a key. */
export const CONSENTED_MARKET_DATA_PROVIDERS = ['yfinance'] as const;
export type ConsentedMarketDataProvider = (typeof CONSENTED_MARKET_DATA_PROVIDERS)[number];

export const marketDataConsents = pgTable('market_data_consents', {
  id: idColumn(),
  userId: userIdColumn(),
  provider: text('provider').$type<ConsentedMarketDataProvider>().notNull(),
  consentTextVersion: text('consent_text_version').notNull(),
  consentTextSha256: text('consent_text_sha256').notNull(),
  consentedAt: instantColumn('consented_at').notNull(),
  withdrawnAt: instantColumn('withdrawn_at'),
  createdAt: createdAtColumn(),
});

export type MarketDataConsentRow = typeof marketDataConsents.$inferSelect;
