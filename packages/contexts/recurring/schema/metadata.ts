// SPDX-License-Identifier: MIT
/**
 * `subscription_metadata` and `price_change_events` — migration `0010_recurring.sql`.
 *
 * `subscription_metadata` is read *back into* detection as the engine's
 * `MerchantFacts` (07 §2.9's bundle and household refinements, 07 §2.4's
 * merchant prior), which is what keeps it from drifting into decoration.
 * `price_change_events` carries 07 §2.6's two-sided changepoints with the
 * before/after transaction ids an insight has to cite.
 */
import {
  amountMinorColumn,
  createdAtColumn,
  currencyColumn,
  dateColumn,
  flagColumn,
  idColumn,
  instantColumn,
  updatedAtColumn,
  userIdColumn,
} from '@core/db';
import { pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';

export const USAGE_DECLARATIONS = ['USED', 'UNUSED', 'UNKNOWN'] as const;
export type UsageDeclaration = (typeof USAGE_DECLARATIONS)[number];

/**
 * 07 §2.10: we have no usage telemetry. Only a `USER_DECLARED` answer earns a
 * confident message; a `HEURISTIC` one is corroborating signal and says so.
 */
export const USAGE_SOURCES = ['USER_DECLARED', 'HEURISTIC'] as const;
export type UsageSource = (typeof USAGE_SOURCES)[number];

export const subscriptionMetadata = pgTable(
  'subscription_metadata',
  {
    id: idColumn(),
    userId: userIdColumn(),
    seriesId: uuid('series_id').notNull(),
    /** A 07 §2.9 taxonomy node (`media/video`), never a merchant name. */
    serviceNode: text('service_node'),
    bundleSku: text('bundle_sku'),
    forSomeoneElse: flagColumn('for_someone_else').notNull(),
    merchantClass: text('merchant_class'),
    planName: text('plan_name'),
    standardPriceMinor: amountMinorColumn('standard_price_minor'),
    standardPriceCurrency: currencyColumn('standard_price_currency'),
    usageDeclaration: text('usage_declaration').$type<UsageDeclaration>(),
    usageSource: text('usage_source').$type<UsageSource>(),
    usageDeclaredAt: instantColumn('usage_declared_at'),
    cancelUrl: text('cancel_url'),
    notes: text('notes'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [unique('subscription_metadata_series_uniq').on(table.seriesId)],
);

export type SubscriptionMetadataRow = typeof subscriptionMetadata.$inferSelect;
export type NewSubscriptionMetadataRow = typeof subscriptionMetadata.$inferInsert;

export const priceChangeEvents = pgTable(
  'price_change_events',
  {
    id: idColumn(),
    userId: userIdColumn(),
    seriesId: uuid('series_id').notNull(),
    direction: text('direction').$type<'INCREASE' | 'DECREASE'>().notNull(),
    effectiveDate: dateColumn('effective_date').notNull(),
    /** Magnitudes, not signed amounts — see the migration header. */
    fromMinor: amountMinorColumn('from_minor').notNull(),
    toMinor: amountMinorColumn('to_minor').notNull(),
    deltaMinor: amountMinorColumn('delta_minor').notNull(),
    annualImpactMinor: amountMinorColumn('annual_impact_minor').notNull(),
    currency: currencyColumn().notNull(),
    confirmed: flagColumn('confirmed').notNull(),
    priorTransactionIds: uuid('prior_transaction_ids').array().notNull(),
    recentTransactionIds: uuid('recent_transaction_ids').array().notNull(),
    /** Written by `@ctx/notifications` (WP 2.4), never by this context. */
    notifiedAt: instantColumn('notified_at'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique('price_change_events_natural_uniq').on(
      table.seriesId,
      table.effectiveDate,
      table.direction,
    ),
  ],
);

export type PriceChangeEventRow = typeof priceChangeEvents.$inferSelect;
export type NewPriceChangeEventRow = typeof priceChangeEvents.$inferInsert;
