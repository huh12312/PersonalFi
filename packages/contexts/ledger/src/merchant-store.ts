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
import { and, eq, inArray, sql } from 'drizzle-orm';
import { merchants } from '../schema/index.ts';
import type { LedgerExecutor } from './db.ts';
import { resolveMerchantIdentity } from './normalise.ts';

const SELECT_CHUNK = 900;
const INSERT_CHUNK = 400;

/** A locale-free total order on keys (`normalized_key` is `[a-z0-9]+`, so code points suffice). */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** What the write path knows about one payee it wants a row for. */
export interface WantedMerchant {
  readonly display: string;
  /**
   * Provider entity ids, already namespaced `provider:entityId` by
   * `resolveMerchantIdentity`. Evidence for a later entity-first merge (D25),
   * never the identity itself.
   */
  readonly entityIds: readonly string[];
}

/**
 * Resolve every key in `wanted` (key → display name and provider evidence),
 * creating the rows that do not exist yet.
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
  wanted: ReadonlyMap<string, WantedMerchant>,
  now: Date,
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  if (wanted.size === 0) return resolved;

  // One global key order for every write below. Two syncs for one holder
  // (eight connections on the nightly chain; two providers for one payee) can
  // be resolving overlapping keys at the same moment, each inside its own
  // transaction. A multi-row `INSERT … ON CONFLICT DO NOTHING` takes the unique
  // index's locks in the order of its VALUES, and a per-key UPDATE takes its
  // row lock as it goes; with the keys in two different orders each side ends
  // up holding what the other wants — Postgres `40P01`, "deadlock detected",
  // which the sync records as `INTERNAL` and never retries (CI 2026-10-28, the
  // nightly chain's first sync). Sorted, every writer takes the same locks in
  // the same order and one simply waits for the other.
  // `merchant-store-order.test.ts` runs the two orders concurrently.
  const keys = [...wanted.keys()].sort(byCodePoint);
  await lookup(executor, userId, keys, resolved);

  const missing = keys.filter((key) => !resolved.has(key));
  if (missing.length > 0) {
    const values = missing.map((key) => ({
      id: newId(),
      userId,
      normalizedKey: key,
      displayName: wanted.get(key)?.display ?? key,
      providerEntityIds: [...(wanted.get(key)?.entityIds ?? [])],
      createdAt: now,
      updatedAt: now,
    }));
    for (const chunk of chunked(values, INSERT_CHUNK)) {
      await executor.insert(merchants).values(chunk).onConflictDoNothing();
    }
    await lookup(executor, userId, missing, resolved);
  }

  await recordEntityIds(executor, userId, wanted, now);
  return resolved;
}

/**
 * Union any newly-seen provider entity ids onto the rows that already exist.
 *
 * A union in SQL rather than read-modify-write in TypeScript, because two syncs
 * for two providers can be resolving the same payee at the same moment and a
 * read-modify-write would silently drop one of their ids. `array_cat` + a
 * de-duplicating rewrite under the row lock the `UPDATE` already takes is
 * atomic; the `WHERE NOT ... @>` makes a re-sync that learns nothing write
 * nothing, so this costs one indexed probe on the common path.
 *
 * The ids travel as **one JSON parameter** and are rebuilt into a `text[]` in
 * SQL, not interpolated as a JavaScript array: Drizzle's `sql` template expands
 * an interpolated array into a comma-separated *parameter list* — `($1, $2)`, a
 * row constructor — so `${ids}::text[]` fails with `cannot cast type record to
 * text[]`. `@ctx/categorization`'s `seedSystemTaxonomy` learned this the same
 * way and documents it at length.
 */
async function recordEntityIds(
  executor: LedgerExecutor,
  userId: string,
  wanted: ReadonlyMap<string, WantedMerchant>,
  now: Date,
): Promise<void> {
  for (const key of [...wanted.keys()].sort(byCodePoint)) {
    const entry = wanted.get(key);
    if (entry === undefined || entry.entityIds.length === 0) continue;
    const json = JSON.stringify([...entry.entityIds]);
    await executor.execute(sql`
      UPDATE merchants
         SET provider_entity_ids = ARRAY(
               SELECT DISTINCT unnest(
                 array_cat(
                   provider_entity_ids,
                   ARRAY(SELECT jsonb_array_elements_text(${json}::jsonb))
                 )
               )
               ORDER BY 1
             ),
             updated_at = ${now}
       WHERE user_id = ${userId}
         AND normalized_key = ${key}
         AND NOT (provider_entity_ids @> ARRAY(SELECT jsonb_array_elements_text(${json}::jsonb)))
    `);
  }
}

/**
 * Retire `merchants` rows that decision D25 says should never have existed.
 *
 * The repair half of D25, and the reason there is no `0009_*.sql` backfill: the
 * rule is ~200 lines of tokenisation and an English operation vocabulary, and a
 * SQL transcription of it would be a second implementation that drifts from the
 * first the day somebody adds a word. Worse, it could not even be written
 * faithfully — `merchants.normalized_key` is squashed to `[a-z0-9]+`, so
 * `transfertorewardsvisa` has no token boundaries left for SQL to find. What the
 * rule *can* be re-run against is `display_name`, which is the cleaned residue
 * with its spacing intact, so that is what this reads.
 *
 * Deletion rather than a flag, and safe to delete: the only foreign key into
 * `merchants` is `transactions.effective_merchant_id`, declared `ON DELETE SET
 * NULL` in migration 0004, so the unlink is the database's own doing and cannot
 * be forgotten. Nothing the user authored is lost — a renamed payee lives in the
 * `user_merchant_name` overlay on the transaction, never here.
 *
 * Idempotent, and cheap on the second run: it walks `merchants` (tens of rows),
 * not `transactions` (tens of thousands), and a database already repaired finds
 * nothing to do.
 */
export async function pruneNoiseMerchants(
  executor: LedgerExecutor,
  userId: string,
): Promise<{ readonly deleted: number; readonly keys: readonly string[] }> {
  const rows = await executor
    .select({
      id: merchants.id,
      normalizedKey: merchants.normalizedKey,
      displayName: merchants.displayName,
    })
    .from(merchants)
    .where(eq(merchants.userId, userId));

  const noise = rows.filter(
    (row) => resolveMerchantIdentity({ name: row.displayName }).key === null,
  );
  if (noise.length === 0) return { deleted: 0, keys: [] };

  for (const chunk of chunked(noise, SELECT_CHUNK)) {
    await executor.delete(merchants).where(
      and(
        eq(merchants.userId, userId),
        inArray(
          merchants.id,
          chunk.map((row) => row.id),
        ),
      ),
    );
  }
  return { deleted: noise.length, keys: noise.map((row) => row.normalizedKey).sort() };
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
