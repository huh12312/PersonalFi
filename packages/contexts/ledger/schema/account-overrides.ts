// SPDX-License-Identifier: MIT
import { createdAtColumn, idColumn, updatedAtColumn, userIdColumn } from '@core/db';
import { pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * The four buckets a projection starts from. Identical, member for member, to
 * `@ctx/planning`'s `TAX_BUCKETS`: this context may not import that one, and
 * `apps/api/src/domain.ts` is where TypeScript checks the two still fit.
 */
export const TAX_TREATMENTS = ['TAXABLE', 'TAX_DEFERRED', 'ROTH', 'HSA'] as const;
export type TaxTreatment = (typeof TAX_TREATMENTS)[number];

/**
 * AC-7's account role (docs/research/09-requirements-prd.md: "spending, savings,
 * taxable, tax-deferred, tax-free, liability"), the vocabulary wp4.3 §9 item 1
 * names as the end state. A role is the holder's own classification, for advice
 * and for reading; the projection's tax input is `tax_treatment`, set
 * separately, so a role can never move a projection by itself.
 */
export const ACCOUNT_ROLES = [
  'spending',
  'savings',
  'taxable',
  'tax_deferred',
  'tax_free',
  'liability',
] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

/**
 * How an investment or crypto account is valued. `holdings` (the default) is
 * Σ quantity x price. `balance` counts an account that has no priced holdings at
 * its latest typed balance, and says so wherever it appears (O-2). Each list is
 * also a CHECK in `0035_account_overrides.sql`; the db test asserts they agree.
 */
export const VALUATION_BASES = ['holdings', 'balance'] as const;
export type ValuationBasis = (typeof VALUATION_BASES)[number];

/**
 * Who manages an investment account (WP 10.3, `0042_account_overrides_management.sql`):
 * a human advisor, a robo-advisor, or the holder. `NULL` is "unclassified" and
 * is never inferred — a provider knows the institution, not who picks the
 * trades. Groups `GET /investments/performance/by-management`; moves no
 * projection. Also a CHECK; the db test asserts the two agree.
 */
export const MANAGEMENT_STYLES = ['advisor', 'robo_advisor', 'self_directed'] as const;
export type ManagementStyle = (typeof MANAGEMENT_STYLES)[number];

/**
 * The holder's overlay on an account (migration `0035_account_overrides.sql`).
 *
 * One row per `(user_id, account_id)`, present exactly when at least one of the
 * four fields is set (three from 0035, `management` from 0042). `accounts` stays the provider's: a sync refreshes it, an
 * override survives the refresh, and one pure resolver
 * (`resolveAccountOverlay`) decides which wins.
 *
 * The DDL lives in the migration; this is the query surface and the ownership
 * claim. `accountId` carries no `.references()` here because the real constraint
 * is composite — `(user_id, account_id) REFERENCES accounts (user_id, id)` — and
 * Drizzle's single-column `.references()` cannot say that.
 */
export const accountOverrides = pgTable(
  'account_overrides',
  {
    id: idColumn(),
    userId: userIdColumn(),
    accountId: uuid('account_id').notNull(),
    taxTreatment: text('tax_treatment').$type<TaxTreatment>(),
    role: text('role').$type<AccountRole>(),
    valuation: text('valuation').$type<ValuationBasis>(),
    /** WP 10.3, migration 0042. */
    management: text('management').$type<ManagementStyle>(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [uniqueIndex('account_overrides_user_account_uniq').on(table.userId, table.accountId)],
);

export type AccountOverrideRow = typeof accountOverrides.$inferSelect;
export type NewAccountOverrideRow = typeof accountOverrides.$inferInsert;
