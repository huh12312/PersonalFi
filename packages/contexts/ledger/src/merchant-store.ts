// SPDX-License-Identifier: MIT
/**
 * Normalised key → `merchants` row, in a fixed number of queries.
 *
 * `resolveEffective()` is pure and returns a *key*, never a merchant id, because
 * a resolution function that can do I/O is one that will eventually do I/O on the
 * read path for fifty thousand rows (see `effective.ts`). Somebody still has to
 * map the key to a row, and doing it in exactly one place is what stops two write
 * paths — a sync and a user rename — creating two `merchants` rows for one payee
 * and splitting a year of history across them.
 */
import { newId } from '@core/kernel';
import { and, eq, inArray } from 'drizzle-orm';
import { merchants } from '../schema/index.ts';
import type { LedgerExecutor } from './db.ts';

const SELECT_CHUNK = 900;
const INSERT_CHUNK = 400;

/**
 * Resolve every key in `wanted` (key → display name), creating the rows that do
 * not exist yet.
 *
 * `onConflictDoNothing` and then re-select rather than `onConflictDoUpdate`: a
 * concurrent sync may have created the same payee, the unique index
 * `(user_id, normalized_key)` is the arbiter, and re-selecting picks up whichever
 * row won. Updating would also mean a second sighting of a payee could rewrite a
 * display name the user had curated.
 */
export async function ensureMerchants(
  executor: LedgerExecutor,
  userId: string,
  wanted: ReadonlyMap<string, string>,
  now: Date,
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  if (wanted.size === 0) return resolved;

  const keys = [...wanted.keys()];
  await lookup(executor, userId, keys, resolved);

  const missing = keys.filter((key) => !resolved.has(key));
  if (missing.length === 0) return resolved;

  const values = missing.map((key) => ({
    id: newId(),
    userId,
    normalizedKey: key,
    displayName: wanted.get(key) ?? key,
    providerEntityIds: [],
    createdAt: now,
    updatedAt: now,
  }));
  for (const chunk of chunked(values, INSERT_CHUNK)) {
    await executor.insert(merchants).values(chunk).onConflictDoNothing();
  }
  await lookup(executor, userId, missing, resolved);
  return resolved;
}

async function lookup(
  executor: LedgerExecutor,
  userId: string,
  keys: readonly string[],
  into: Map<string, string>,
): Promise<void> {
  for (const chunk of chunked(keys, SELECT_CHUNK)) {
    const rows = await executor
      .select({ id: merchants.id, normalizedKey: merchants.normalizedKey })
      .from(merchants)
      .where(and(eq(merchants.userId, userId), inArray(merchants.normalizedKey, chunk)));
    for (const row of rows) into.set(row.normalizedKey, row.id);
  }
}

function* chunked<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let index = 0; index < items.length; index += size) {
    yield items.slice(index, index + size);
  }
}
