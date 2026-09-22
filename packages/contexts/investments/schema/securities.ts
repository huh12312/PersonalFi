// SPDX-License-Identifier: MIT
/**
 * `securities`, `security_identifiers` and `security_overlay` — migration
 * `0013_securities.sql`.
 *
 * See that file's header for the design: why a provider's own id can never be
 * an identity (the `identity_kind` CHECK, which has no `proprietary` member),
 * why `identifier_key` is written rather than `GENERATED`, and why the strength
 * ordering lives in `src/identifiers.ts` instead of in an `ORDER BY`.
 *
 * This file is the *query surface*, not the DDL. Indexes, `CHECK` constraints
 * and the two unique keys live in the migration, which is the one ordered,
 * forward-only history of the database; declaring them twice is how the two
 * drift apart. The `unique()` markers below are the exception and are present
 * only because Drizzle's `onConflictDoUpdate` needs a target expression.
 */
import {
  createdAtColumn,
  currencyColumn,
  flagColumn,
  idColumn,
  instantColumn,
  updatedAtColumn,
  userIdColumn,
} from '@core/db';
import { numeric, pgTable, smallint, text, unique, uuid } from 'drizzle-orm/pg-core';

/**
 * 08 §2.5's identifier union, verbatim, plus `figi`.
 *
 * Stated here as well as in `src/identifiers.ts` because a column CHECK and a
 * domain rule are two different artefacts that must agree; `identifiers.test.ts`
 * asserts the two lists are identical, which is the only way that agreement
 * survives an edit to one of them.
 */
export const IDENTIFIER_KINDS = [
  'figi',
  'isin',
  'cusip',
  'ticker',
  'chain_contract',
  'proprietary',
] as const;
export type IdentifierKind = (typeof IDENTIFIER_KINDS)[number];

/**
 * The kinds a `securities` row may exist *because of*.
 *
 * `proprietary` is absent, and the absence is the control (D25 applied to
 * securities): a Plaid `security_id` is stable within one Item and meaningless
 * outside it, so a row minted from one would be a second row for an asset some
 * other provider already named.
 */
export const IDENTITY_KINDS = ['figi', 'isin', 'cusip', 'ticker', 'chain_contract'] as const;
export type IdentityKind = (typeof IDENTITY_KINDS)[number];

/** 07 §4.3's taxonomy, kept small exactly as that section asks. */
export const ASSET_CLASSES = [
  'US_EQUITY',
  'INTL_DEV_EQUITY',
  'EM_EQUITY',
  'US_BOND',
  'INTL_BOND',
  'TIPS',
  'REAL_ESTATE',
  'COMMODITY',
  'CRYPTO',
  'CASH',
  'OTHER',
  'UNCLASSIFIED',
] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

export const REGIONS = ['US', 'DEV_EX_US', 'EM', 'GLOBAL', 'UNKNOWN'] as const;
export type Region = (typeof REGIONS)[number];

export const SECURITY_TYPES = [
  'equity',
  'etf',
  'mutual_fund',
  'crypto',
  'bond',
  'cash',
  'other',
] as const;
export type SecurityType = (typeof SECURITY_TYPES)[number];

/**
 * 07 §4.3's waterfall rungs, first hit wins.
 *
 * `PROVIDER` is not in 07's list and is deliberately added: Plaid's `type` and
 * `is_cash_equivalent` are a real, if thin, answer, and recording them as
 * `PROVIDER` rather than laundering them as `NAME_HEURISTIC` is the difference
 * between "we know where this came from" and a number nobody can account for.
 * `UNCLASSIFIED` is a positive statement that the waterfall ran and fell
 * through every rung — not the absence of one.
 */
export const CLASSIFICATION_SOURCES = [
  'USER_OVERRIDE',
  'LOCAL_SEED_TABLE',
  'SEC_EDGAR',
  'ISSUER_HOLDINGS',
  'NAME_HEURISTIC',
  'SIC_SECTOR_MAP',
  'PROVIDER',
  'UNCLASSIFIED',
] as const;
export type ClassificationSource = (typeof CLASSIFICATION_SOURCES)[number];

/** A unit-interval ratio. `NUMERIC(9,6)`; never a float (D3, and the migrate-test ban). */
function ratioColumn(name: string) {
  return numeric(name, { precision: 9, scale: 6, mode: 'string' });
}

export const securities = pgTable(
  'securities',
  {
    id: idColumn(),
    userId: userIdColumn(),

    /** The kind of the strongest name this row is known by. Never `proprietary`. */
    identityKind: text('identity_kind').$type<IdentityKind>().notNull(),
    /** `securityIdentifierKeyOf` of that name. Unique per user. */
    identityKey: text('identity_key').notNull(),

    ticker: text('ticker'),
    mic: text('mic'),
    cusip: text('cusip'),
    isin: text('isin'),
    figi: text('figi'),
    chain: text('chain'),
    /** `'native'` for a chain's own coin — see `NATIVE_ASSETS` in `src/identifiers.ts`. */
    contract: text('contract'),

    name: text('name'),
    type: text('type').$type<SecurityType>().notNull(),
    currency: currencyColumn(),
    expenseRatio: ratioColumn('expense_ratio'),
    isCashEquivalent: flagColumn('is_cash_equivalent').notNull(),

    assetClass: text('asset_class').$type<AssetClass>().notNull(),
    region: text('region').$type<Region>().notNull(),
    sector: text('sector').notNull(),

    classificationSource: text('classification_source').$type<ClassificationSource>().notNull(),
    classifiedAt: instantColumn('classified_at'),
    classificationDepth: smallint('classification_depth').notNull(),
    /** `|Σ classified weights − 1|`. 07 §4.3 flags a fund above 0.05. */
    classificationResidual: ratioColumn('classification_residual'),
    classificationFlagged: flagColumn('classification_flagged').notNull(),

    /** The surviving row, when two turned out to be one asset. */
    mergedIntoId: uuid('merged_into_id'),

    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [unique('securities_user_identity_uniq').on(table.userId, table.identityKey)],
);

export type SecurityRow = typeof securities.$inferSelect;
export type NewSecurityRow = typeof securities.$inferInsert;

export const securityIdentifiers = pgTable(
  'security_identifiers',
  {
    id: idColumn(),
    userId: userIdColumn(),
    securityId: uuid('security_id').notNull(),

    kind: text('kind').$type<IdentifierKind>().notNull(),
    value: text('value').notNull(),
    chain: text('chain'),
    mic: text('mic'),
    identifierKey: text('identifier_key').notNull(),

    /** Who said so. `null` means we derived it (OpenFIGI, the seed table). */
    provider: text('provider'),
    confidence: numeric('confidence', { precision: 5, scale: 4, mode: 'string' }).notNull(),

    firstSeenAt: instantColumn('first_seen_at').notNull(),
    lastSeenAt: instantColumn('last_seen_at').notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [unique('security_identifiers_user_key_uniq').on(table.userId, table.identifierKey)],
);

export type SecurityIdentifierRow = typeof securityIdentifiers.$inferSelect;
export type NewSecurityIdentifierRow = typeof securityIdentifiers.$inferInsert;

/** The fields a user may override. `locked_fields` is a subset of these names. */
export const OVERLAY_FIELDS = [
  'asset_class',
  'region',
  'sector',
  'name',
  'expense_ratio',
  'is_cash_equivalent',
] as const;
export type OverlayField = (typeof OVERLAY_FIELDS)[number];

export const securityOverlay = pgTable(
  'security_overlay',
  {
    id: idColumn(),
    userId: userIdColumn(),
    securityId: uuid('security_id').notNull(),

    assetClass: text('asset_class').$type<AssetClass>(),
    region: text('region').$type<Region>(),
    sector: text('sector'),
    name: text('name'),
    expenseRatio: ratioColumn('expense_ratio'),
    isCashEquivalent: flagColumn('is_cash_equivalent'),
    note: text('note'),

    /** Only a locked field wins. 04 §2.2's sparse overlay, verbatim. */
    lockedFields: text('locked_fields').array().$type<OverlayField[]>().notNull(),

    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [unique('security_overlay_user_security_uniq').on(table.userId, table.securityId)],
);

export type SecurityOverlayRow = typeof securityOverlay.$inferSelect;
export type NewSecurityOverlayRow = typeof securityOverlay.$inferInsert;
