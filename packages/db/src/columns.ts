// SPDX-License-Identifier: MIT
import { bigint, boolean, char, date, numeric, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * The column vocabulary every table in PersonalFi is built from.
 *
 * These exist so the storage rules in docs/CONVENTIONS.md are expressed once, in
 * code, rather than re-decided per table. Using a raw `numeric()` for a money
 * column is a review comment, not a style preference.
 */

/** UUIDv7 primary key. Generated app-side with `newId()`, never `gen_random_uuid()`. */
export function idColumn(name = 'id') {
  return uuid(name).primaryKey();
}

/**
 * The ownership column. Every user-scoped table carries it from the first
 * migration (decision D6): single user now, multi-user additive later.
 *
 * Declared without `.references()` on purpose — `users` is owned by `@ctx/identity`
 * and `@core/db` must not import a context. The foreign key is declared in SQL.
 */
export function userIdColumn(name = 'user_id') {
  return uuid(name).notNull();
}

/** A genuine instant. Always `timestamptz`, always stored UTC. */
export function instantColumn(name: string) {
  return timestamp(name, { withTimezone: true, mode: 'date' });
}

export function createdAtColumn(name = 'created_at') {
  return instantColumn(name).notNull().defaultNow();
}

export function updatedAtColumn(name = 'updated_at') {
  return instantColumn(name).notNull().defaultNow();
}

/**
 * A business date: a bank's calendar date, with no time and no zone.
 * `mode: 'string'` keeps it as `YYYY-MM-DD`, which is the kernel's `DateOnly`.
 */
export function dateColumn(name: string) {
  return date(name, { mode: 'string' });
}

/**
 * The integer minor units half of a money pair. Always paired with
 * `currencyColumn`; a bare amount with no currency is a bug waiting for the first
 * non-USD row.
 *
 * House sign convention: negative = outflow, positive = inflow. Provider adapters
 * normalise to it at the edge.
 */
export function amountMinorColumn(name: string) {
  return bigint(name, { mode: 'bigint' });
}

/** The ISO-4217 half of a money pair. */
export function currencyColumn(name = 'currency') {
  return char(name, { length: 3 });
}

/**
 * A security or crypto quantity. `NUMERIC(38,18)` so 18-decimal tokens survive,
 * read back as a decimal *string* (`Quantity`), never as a float.
 */
export function quantityColumn(name: string) {
  return numeric(name, { precision: 38, scale: 18, mode: 'string' });
}

/** A unit price or FX rate: sub-cent precision, so not minor units. */
export function rateColumn(name: string) {
  return numeric(name, { precision: 20, scale: 10, mode: 'string' });
}

export function flagColumn(name: string) {
  return boolean(name);
}
