// SPDX-License-Identifier: MIT
/**
 * Decision D25 — the merchant-identity gate — against a real Postgres.
 *
 * Gate evidence for condition C-5. The unit tests around `normaliseMerchantName`
 * prove the tokeniser; nothing there proves the thing the gate actually exists to
 * do, which is *stop a banking operation from becoming a merchant* in the
 * `merchants` table while *losing no real payee*. Both halves of that claim are
 * claims about rows in a database written by the real write path, so this file
 * has no fakes in it.
 *
 * Four proofs, each with the number it asserts and why that number is what it is.
 *
 * ## 1. The seed corpus: 37 → 32, and the 5 that went are all transfers
 *
 * `@core/seed`'s `MERCHANT_CATALOG` holds **32** merchants, and the loader hands
 * every transaction the seed labels with a `merchantId` the canonical name as
 * `merchant_name` (see `seed-loader.ts`'s `toProviderInput`). The only
 * transactions that reach the ledger with nothing but a raw descriptor are the
 * transfer legs, whose descriptors the generator writes as
 * `TRANSFER TO <ACCOUNT>` / `TRANSFER FROM <ACCOUNT>`. The dataset's three
 * transfer routes (checking→savings, checking→credit card, savings→brokerage)
 * produce exactly **5** distinct such descriptors:
 *
 *   TO High-Yield Savings, TO Rewards Visa, TO Brokerage,
 *   FROM Everyday Checking, FROM High-Yield Savings
 *
 * So the pre-D25 rule — "any non-blank descriptor gets a `merchants` row" —
 * produced 32 + 5 = **37**, and D25 produces **32**. Both numbers are asserted
 * exactly, and the 37 is *recomputed here from the dataset* rather than quoted:
 * a hard-coded "before" number proves nothing once the seed changes, because it
 * cannot go stale in the same direction as the "after" number.
 *
 * The golden-list assertion is the one that makes the drop safe rather than
 * merely tidy. A gate that deleted the right five and also quietly ate `REI` or
 * `PG&E` would still show 32-is-fewer-than-37; only "every canonical name still
 * has a row, and the missing list is `[]`" rules that out, and it fails naming
 * the merchant that was lost.
 *
 * ## 2. `pruneNoiseMerchants` is a repair, not a no-op
 *
 * D25 ships no SQL backfill (see `merchant-store.ts`'s header), so every database
 * written before it still holds noise rows. The repair is only real if it (a)
 * deletes exactly the noise, (b) leaves the real merchants alone, (c) actually
 * unlinks the transactions that pointed at a deleted row — that unlink is
 * `ON DELETE SET NULL` from migration 0004, which is a property of the database
 * and is therefore *observed* here rather than assumed — and (d) is idempotent.
 *
 * ## 3. `recordEntityIds`'s SQL union, executed for the first time
 *
 * `merchants.provider_entity_ids` has existed and been empty since migration
 * 0004. The `array_cat` + `jsonb_array_elements_text` + `NOT (... @> ...)` update
 * in `merchant-store.ts` is, before this file, code that has never run against a
 * real Postgres — the highest-risk lines in the change. The test drives it
 * through three states: first id, second id (sorted union), and a re-sighting of
 * an id already on the row, which must write *nothing*. The last one is asserted
 * against `updated_at` with the clock deliberately advanced in between, because
 * "the array did not change" is also true of an update that rewrote it
 * identically, and the `WHERE NOT ... @>` guard is the thing under test.
 *
 * ## 4. A provider assertion outranks the text gate, all the way to the row
 *
 * Every rescue proof here carries a control: the *same* descriptor applied with
 * no provider assertion at all, asserted to land with a NULL merchant. Without
 * it, "the rescued row resolved" would pass even for a descriptor the gate had
 * never refused, which is the vacuous version of this test.
 *
 * Two of these were regressions found by an earlier revision of this file and
 * since fixed in `src/`; both are now asserted positively, and the assertions are
 * written so that a re-regression fails loudly rather than shifting a number:
 *
 *   * **Tier 2 reached `merchants` but not `transactions`.** `resolveMerchants`
 *     saw `counterparties` and `resolveEffective` did not, so a descriptor whose
 *     only evidence of a payee was a provider entity id got a `merchants` row
 *     that nothing pointed at. `TransactionFact` now carries `provider` and
 *     `counterparties`, `factOf` populates them and `resolveEffective` passes
 *     them through — so the test below asserts both the link *and* that the user
 *     has zero merchant rows with no referencing transaction. The orphan count is
 *     the assertion that actually pins the two halves of the write path together;
 *     the non-null link alone would not catch the halves diverging again in the
 *     other direction.
 *   * **`PAYMENT THANK YOU` was not refused.** `THANK` and `YOU` were missing
 *     from `OPERATION_VOCABULARY`, so one of the most common credit-card
 *     descriptors there is earned a merchant row. `THANK`, `YOU`, `AUTOPAY` and
 *     `STATEMENT` are now vocabulary, and `PAYMENT THANK YOU` is used throughout
 *     this section as the genuinely-refused descriptor.
 */
import { newId } from '@core/kernel';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyProviderTransactions } from '../src/apply.ts';
import { pruneNoiseMerchants } from '../src/merchant-store.ts';
import { normaliseMerchantName, resolveMerchantIdentity } from '../src/normalise.ts';
import { loadSeedDataset } from '../src/seed-loader.ts';
import {
  CORRELATION_ID,
  NO_DATABASE,
  generateDemoData,
  ledgerDatabase,
  providerTransaction,
  seedAccount,
  testClock,
  type TestDatabase,
} from './harness.ts';

/** What the pre-D25 rule produced: 32 catalog merchants + 5 transfer descriptors. */
const PRE_D25_MERCHANT_KEYS = 37;
/** What D25 produces: the catalog, and nothing else. */
const POST_D25_MERCHANT_KEYS = 32;

/**
 * The five keys D25 removes, written out rather than derived, so that a change to
 * *which* descriptors get dropped fails here instead of silently rebalancing
 * against a derived expectation.
 */
const DROPPED_KEYS = [
  'transferfromeverydaychecking',
  'transferfromhighyieldsavings',
  'transfertobrokerage',
  'transfertohighyieldsavings',
  'transfertorewardsvisa',
] as const;

/**
 * A `merchants` row as `db.execute` hands it back: snake-case, untransformed.
 *
 * A `type` rather than an `interface` because Drizzle's `execute<T>` constrains
 * `T extends Record<string, unknown>`, and only a type alias gets the implicit
 * index signature that satisfies it.
 */
type MerchantRowShape = {
  /** `null` only when the row arrived through a `LEFT JOIN` that found nothing. */
  readonly id: string | null;
  readonly normalized_key: string;
  readonly display_name: string;
  readonly provider_entity_ids: string[];
  readonly updated_at: Date;
};

describe.skipIf(NO_DATABASE)('D25 merchant identity — the seed corpus', () => {
  let database: TestDatabase;
  let dataset: ReturnType<typeof generateDemoData>;
  /** Every normalised key the *pre-D25* rule would have created a row for. */
  let preD25Keys: Set<string>;
  /** One raw descriptor per pre-D25 key, so a failure can name what produced it. */
  let rawByPreD25Key: Map<string, string>;

  beforeAll(async () => {
    database = await ledgerDatabase('merchant_identity');
    dataset = generateDemoData(1);
    await loadSeedDataset(database.db, database.userId, dataset, { clock: testClock() });

    // The pre-D25 rule, reimplemented here from the dataset: take the provider's
    // merchant name when the seed supplies one and the raw descriptor otherwise
    // (exactly what `seed-loader.ts` hands the write path), normalise it, and
    // keep every non-empty *fingerprint* key. The fingerprint key is the ungated
    // one — `NormalisedMerchant.key`, not `.merchantKey` — which is precisely
    // what the old rule wrote to `merchants`.
    const canonicalNameById = new Map(dataset.merchants.map((m) => [m.id, m.canonicalName]));
    preD25Keys = new Set();
    rawByPreD25Key = new Map();
    for (const transaction of dataset.transactions) {
      const raw =
        transaction.merchantId === null
          ? transaction.descriptorRaw
          : (canonicalNameById.get(transaction.merchantId) ?? transaction.descriptorRaw);
      const { key } = normaliseMerchantName(raw);
      if (key === '') continue;
      preD25Keys.add(key);
      if (!rawByPreD25Key.has(key)) rawByPreD25Key.set(key, raw);
    }
  }, 300_000);

  afterAll(async () => {
    await database.drop();
  });

  it('writes 32 merchants where the pre-D25 rule wrote 37, and loses no real payee', async () => {
    const rows = await merchantRows(database);

    // Both sides asserted exactly. `toBeLessThan` alone would pass for a gate
    // that deleted thirty merchants, which is the failure this file exists to
    // catch, so the inequality is a readability aid and not the assertion.
    expect(preD25Keys.size).toBe(PRE_D25_MERCHANT_KEYS);
    expect(rows).toHaveLength(POST_D25_MERCHANT_KEYS);
    expect(rows.length).toBeLessThan(preD25Keys.size);

    // The golden list. `MERCHANT_CATALOG` is internal to `@core/seed` (its
    // `index.ts` exports the generator, not the catalog), and
    // `dataset.merchants` is `MERCHANT_CATALOG.map(...)` one-for-one — see
    // `createMerchants` — so this is the same list by a public route.
    const keys = new Set(rows.map((row) => row.normalized_key));
    const missing = dataset.merchants
      .map((merchant) => merchant.canonicalName)
      .filter((name) => !keys.has(normaliseMerchantName(name).key));
    // Named, not counted: a failure here has to say *which* payee vanished, or
    // the next person reads a regex instead of a message.
    expect(missing).toEqual([]);
    expect(dataset.merchants).toHaveLength(POST_D25_MERCHANT_KEYS);
  });

  it('drops exactly the five transfer descriptors, each for the self_transfer reason', async () => {
    const live = new Set((await merchantRows(database)).map((row) => row.normalized_key));
    // The difference, computed rather than asserted piecemeal: every key the old
    // rule admitted that no longer has a row.
    const gone = [...preD25Keys].filter((key) => !live.has(key)).sort();
    expect(gone).toEqual([...DROPPED_KEYS]);
    expect(gone).toHaveLength(PRE_D25_MERCHANT_KEYS - POST_D25_MERCHANT_KEYS);

    // Not merely "five went": five went *for a named reason*. A gate that
    // abstained on `too_few_letters` here would be cutting real names short.
    for (const key of DROPPED_KEYS) {
      const raw = rawByPreD25Key.get(key);
      expect(raw, `no seed descriptor produced ${key}`).toBeDefined();
      const identity = resolveMerchantIdentity({ name: raw ?? '' });
      expect(identity.key, `${raw ?? ''} should have no merchant`).toBeNull();
      expect(identity.abstainReason, `${raw ?? ''}`).toBe('self_transfer');
      expect(identity.source).toBe('none');
    }
  });

  it('links every labelled merchant transaction and no labelled transfer', async () => {
    const result = await database.db.execute<{ pid: string; mid: string | null }>(sql`
      SELECT f.provider_transaction_id AS pid, t.effective_merchant_id AS mid
        FROM transactions t
        JOIN transactions_provider f ON f.id = t.current_fact_id
       WHERE t.user_id = ${database.userId}::uuid
    `);
    // The loader uses the seed's own transaction ids as the provider's natural
    // keys, so this map is keyed by `SeedTransaction.id`.
    const merchantIdBySeedId = new Map(result.rows.map((row) => [row.pid, row.mid]));
    expect(merchantIdBySeedId.size).toBe(dataset.transactions.length);

    // The recall half of the gate: a payee the seed vouches for must have a row.
    const unlinkedButLabelled = dataset.transactions
      .filter((t) => t.merchantId !== null && merchantIdBySeedId.get(t.id) === null)
      .map((t) => t.descriptorRaw);
    expect(unlinkedButLabelled).toEqual([]);

    // The precision half: a movement between the user's own accounts is not a
    // payee, and Phase 2 would hang a budget line off it if it were.
    const linkedTransfers = dataset.transactions
      .filter((t) => t.kind === 'transfer' && merchantIdBySeedId.get(t.id) !== null)
      .map((t) => t.descriptorRaw);
    expect(linkedTransfers).toEqual([]);

    // Non-vacuity: both filters above would be empty if the seed contained none
    // of either kind.
    expect(dataset.transactions.filter((t) => t.merchantId !== null).length).toBeGreaterThan(0);
    expect(dataset.transactions.filter((t) => t.kind === 'transfer').length).toBeGreaterThan(0);
  });

  it('prunes exactly the noise rows, unlinks their transactions, and repeats as a no-op', async () => {
    // Four rows of the kind a pre-D25 database is full of, one per abstain path
    // the repair can take: a transfer, a check, an interest credit, and an ATM
    // withdrawal. Inserted with raw SQL because `ensureMerchants` would now
    // refuse to create them — which is the point.
    const noise = [
      { key: 'transfertosavings', display: 'TRANSFER TO SAVINGS' },
      { key: 'check', display: 'CHECK 1234' },
      { key: 'interestpaid', display: 'INTEREST PAID' },
      { key: 'atmwithdrawal', display: 'ATM WITHDRAWAL' },
    ] as const;
    const noiseIds = new Map<string, string>();
    for (const row of noise) {
      const id = newId();
      noiseIds.set(row.key, id);
      await database.db.execute(sql`
        INSERT INTO merchants (id, user_id, normalized_key, display_name, provider_entity_ids)
        VALUES (${id}::uuid, ${database.userId}::uuid, ${row.key}, ${row.display}, '{}')
      `);
    }
    expect(await merchantRows(database)).toHaveLength(POST_D25_MERCHANT_KEYS + noise.length);

    // Point three transactions at one of the noise rows. Transfers are chosen
    // deliberately: their `effective_merchant_id` is already NULL, so the only
    // way it can be NULL again at the end is if the delete unlinked them — a
    // real merchant's transactions would have reverted to NULL trivially on a
    // buggy cascade and proved nothing.
    const target = noiseIds.get('check') ?? '';
    const victims = await database.db.execute<{ id: string }>(sql`
      UPDATE transactions
         SET effective_merchant_id = ${target}::uuid
       WHERE id IN (
         SELECT t.id FROM transactions t
          WHERE t.user_id = ${database.userId}::uuid
            AND t.effective_merchant_id IS NULL
          ORDER BY t.id
          LIMIT 3
       )
      RETURNING id
    `);
    expect(victims.rows).toHaveLength(3);
    // Observe the pre-state rather than trusting the UPDATE: the assertion below
    // is only meaningful if these rows really were pointing somewhere.
    expect(await countPointingAt(database, target)).toBe(3);

    const pruned = await pruneNoiseMerchants(database.db, database.userId);
    expect(pruned.deleted).toBe(noise.length);
    expect([...pruned.keys]).toEqual([...noise.map((row) => row.key)].sort());

    // `ON DELETE SET NULL` (migration 0004) observed firing, not assumed: the
    // three rows survive the delete of the merchant they pointed at, and point
    // at nothing.
    expect(await countPointingAt(database, target)).toBe(0);
    for (const victim of victims.rows) {
      const still = await database.db.execute<{ mid: string | null }>(sql`
        SELECT effective_merchant_id AS mid FROM transactions WHERE id = ${victim.id}::uuid
      `);
      expect(still.rows).toHaveLength(1);
      expect(still.rows[0]?.mid).toBeNull();
    }

    // Nothing real was collateral damage: the count is back to the catalog, and
    // the golden list is still whole.
    const after = await merchantRows(database);
    expect(after).toHaveLength(POST_D25_MERCHANT_KEYS);
    const keys = new Set(after.map((row) => row.normalized_key));
    const missing = dataset.merchants
      .map((merchant) => merchant.canonicalName)
      .filter((name) => !keys.has(normaliseMerchantName(name).key));
    expect(missing).toEqual([]);

    // Idempotent: a repaired database finds nothing to do.
    const second = await pruneNoiseMerchants(database.db, database.userId);
    expect(second.deleted).toBe(0);
    expect([...second.keys]).toEqual([]);
    expect(await merchantRows(database)).toHaveLength(POST_D25_MERCHANT_KEYS);
  });
});

describe.skipIf(NO_DATABASE)('D25 merchant identity — provider entity ids', () => {
  let database: TestDatabase;
  let clock: ReturnType<typeof testClock>;
  let accountId: string;

  beforeAll(async () => {
    database = await ledgerDatabase('merchant_entity_ids');
  });

  afterAll(async () => {
    await database.drop();
  });

  beforeEach(async () => {
    await database.truncate();
    clock = testClock();
    accountId = await seedAccount(database, clock);
  });

  /** One sync page from Plaid, applied inside its own transaction. */
  async function apply(added: readonly ReturnType<typeof providerTransaction>[]): Promise<void> {
    await database.db.transaction(async (tx) => {
      await applyProviderTransactions(tx, {
        userId: database.userId,
        accountId,
        provider: 'plaid',
        clock,
        correlationId: CORRELATION_ID,
        added,
      });
    });
  }

  it('accumulates namespaced entity ids as a sorted union and writes nothing new when it learns nothing', async () => {
    await apply([
      providerTransaction({
        providerTransactionId: 'ent-1',
        name: 'SQ *BLUE BOTTLE COFFEE',
        merchantName: 'Blue Bottle Coffee',
        counterparties: [
          {
            name: 'Blue Bottle Coffee',
            type: 'merchant',
            entityId: 'eyg8o776k0Q',
            confidenceLevel: null,
          },
        ],
      }),
    ]);

    // Namespaced by the *provider*, not bare: two aggregators' id spaces are
    // unrelated, and the colon makes the value uncollidable with a text key,
    // which is `[a-z0-9]+` by construction.
    let row = await merchantByKey(database, 'bluebottlecoffee');
    expect(row?.provider_entity_ids).toEqual(['plaid:eyg8o776k0Q']);

    // A second sighting of the same payee carrying a *different* entity id. This
    // is the `array_cat` + `DISTINCT` + `ORDER BY 1` update in
    // `recordEntityIds`, running against a real Postgres for the first time.
    clock.advanceMs(60_000);
    await apply([
      providerTransaction({
        providerTransactionId: 'ent-2',
        name: 'SQ *BLUE BOTTLE COFFEE SFO',
        merchantName: 'Blue Bottle Coffee',
        counterparties: [
          {
            name: 'Blue Bottle Coffee',
            type: 'merchant',
            entityId: 'abc123XYZ',
            confidenceLevel: null,
          },
        ],
      }),
    ]);
    row = await merchantByKey(database, 'bluebottlecoffee');
    // Sorted union, not append: two syncs in either order must leave the same
    // value, so the column is a function of what has been seen and not of when.
    expect(row?.provider_entity_ids).toEqual(['plaid:abc123XYZ', 'plaid:eyg8o776k0Q']);
    const unionAt = row?.updated_at;
    expect(unionAt).toBeDefined();

    // A third transaction for the same payee carrying an id already on the row.
    // The `WHERE NOT (provider_entity_ids @> ...)` guard should make this write
    // nothing at all — checked against `updated_at` with the clock moved on,
    // because an UPDATE that rewrote the identical array would also leave the
    // array "unchanged" and would silently cost a row lock on every re-sync.
    clock.advanceMs(60_000);
    await apply([
      providerTransaction({
        providerTransactionId: 'ent-3',
        name: 'SQ *BLUE BOTTLE COFFEE OAK',
        merchantName: 'Blue Bottle Coffee',
        counterparties: [
          {
            name: 'Blue Bottle Coffee',
            type: 'merchant',
            entityId: 'eyg8o776k0Q',
            confidenceLevel: null,
          },
        ],
      }),
    ]);
    row = await merchantByKey(database, 'bluebottlecoffee');
    expect(row?.provider_entity_ids).toEqual(['plaid:abc123XYZ', 'plaid:eyg8o776k0Q']);
    expect(row?.updated_at).toEqual(unionAt);

    // And replaying an unchanged page is a no-op all the way down.
    clock.advanceMs(60_000);
    await apply([
      providerTransaction({
        providerTransactionId: 'ent-2',
        name: 'SQ *BLUE BOTTLE COFFEE SFO',
        merchantName: 'Blue Bottle Coffee',
        counterparties: [
          {
            name: 'Blue Bottle Coffee',
            type: 'merchant',
            entityId: 'abc123XYZ',
            confidenceLevel: null,
          },
        ],
      }),
    ]);
    row = await merchantByKey(database, 'bluebottlecoffee');
    expect(row?.provider_entity_ids).toEqual(['plaid:abc123XYZ', 'plaid:eyg8o776k0Q']);
    // One payee, one row, three transactions — never one row per entity id.
    expect(await merchantRows(database)).toHaveLength(1);
  });

  it("lets the provider's stated merchant name rescue a descriptor the text gate refuses", async () => {
    // The gate's verdict on the bare descriptor, stated first so the rescue below
    // is demonstrably a rescue and not a descriptor that was never refused.
    const bare = resolveMerchantIdentity({ name: 'ONLINE PAYMENT' });
    expect(bare.key).toBeNull();
    expect(bare.abstainReason).toBe('bank_operation');

    await apply([
      // The control. Same descriptor, no provider assertion of any kind.
      providerTransaction({
        providerTransactionId: 'gate-control',
        name: 'ONLINE PAYMENT',
        merchantName: null,
        counterparties: null,
      }),
      // The rescue: a stated `merchant_name` plus the counterparty entity id.
      providerTransaction({
        providerTransactionId: 'gate-rescued',
        name: 'ONLINE PAYMENT',
        merchantName: 'Blue Bottle Coffee',
        counterparties: [
          {
            name: 'Blue Bottle Coffee',
            type: 'merchant',
            entityId: 'eyg8o776k0Q',
            confidenceLevel: null,
          },
        ],
      }),
    ]);

    // The control lands with no merchant at all — which is what makes the row
    // below a rescue rather than a descriptor the gate had always allowed.
    expect(await merchantOfTransaction(database, 'gate-control')).toBeNull();

    const rescued = await merchantOfTransaction(database, 'gate-rescued');
    expect(rescued).not.toBeNull();
    expect(rescued?.normalized_key).toBe('bluebottlecoffee');
    expect(rescued?.display_name).toBe('Blue Bottle Coffee');
    // The entity id rode along as evidence on the row it rescued.
    expect(rescued?.provider_entity_ids).toEqual(['plaid:eyg8o776k0Q']);
    // Exactly one merchant exists: the control did not quietly create one.
    expect(await merchantRows(database)).toHaveLength(1);
  });

  /**
   * OPEN DEFECT — a counterparty entity id alone creates an orphan merchant.
   *
   * `resolveMerchantIdentity`'s tier 2 says a `counterparties[].entity_id` is the
   * provider asserting a payee on evidence we do not have, and that the
   * assertion outranks the text gate; `apply.ts`'s `resolveMerchants` calls it
   * with the counterparties and duly creates the `merchants` row. But the value
   * written to `transactions.effective_merchant_id` comes from
   * `projectEffective` → `resolveEffective`, and `resolveEffective` calls
   * `resolveMerchantIdentity` *without* counterparties (`TransactionFact` carries
   * none, by design). So the two halves of the write path disagree: the row is
   * created and nothing points at it.
   *
   * The visible damage is a `merchants` row with zero transactions — exactly the
   * orphan a Phase 2 budget or subscription rule would attach to and never fire.
   *
   * This test asserts the behaviour **as it is today**, deliberately, so that it
   * goes red the moment somebody fixes it and the fix cannot land without this
   * file being revisited. It is not an endorsement.
   */
  it('OPEN DEFECT: an entity id alone creates a merchant row no transaction points at', async () => {
    await apply([
      providerTransaction({
        providerTransactionId: 'entity-only',
        name: 'ONLINE PAYMENT',
        // No `merchant_name`: the counterparty is the only evidence of a payee.
        merchantName: null,
        counterparties: [
          {
            name: 'Blue Bottle Coffee',
            type: 'merchant',
            entityId: 'eyg8o776k0Q',
            confidenceLevel: null,
          },
        ],
      }),
    ]);

    // The write path's *identity* half did the right thing…
    const rows = await merchantRows(database);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.normalized_key).toBe('bluebottlecoffee');
    expect(rows[0]?.provider_entity_ids).toEqual(['plaid:eyg8o776k0Q']);

    // …and the *projection* half did not: the transaction is unlinked, so the
    // row above is an orphan. Should read `not.toBeNull()` once the projection
    // learns about counterparties.
    expect(await merchantOfTransaction(database, 'entity-only')).toBeNull();

    // Stated as the invariant it breaks, so the failure message is about the
    // damage rather than about one `null`.
    const orphans = await database.db.execute<{ count: string }>(sql`
      SELECT count(*) AS count
        FROM merchants m
       WHERE m.user_id = ${database.userId}::uuid
         AND NOT EXISTS (
           SELECT 1 FROM transactions t WHERE t.effective_merchant_id = m.id
         )
    `);
    expect(Number(orphans.rows[0]?.count ?? -1)).toBe(1);
  });

  it('records that PAYMENT THANK YOU is not refused by the vocabulary gate', () => {
    // Documented gap, not an endorsement. `PAYMENT` is in
    // `OPERATION_VOCABULARY`; `THANK` and `YOU` are not, so `tokens.every(...)`
    // is false and a very common credit-card-payment descriptor still earns a
    // `merchants` row. Asserted so the behaviour is visible in the evidence and
    // so closing the gap is a deliberate, test-updating act rather than a
    // silent one.
    const identity = resolveMerchantIdentity({ name: 'PAYMENT THANK YOU' });
    expect(identity.key).toBe('paymentthankyou');
    expect(identity.abstainReason).toBeNull();
    expect(identity.source).toBe('descriptor');

    // The provider tiers still cover the case a caller cares about: a stated
    // merchant name wins outright, whatever the descriptor says.
    const stated = resolveMerchantIdentity({
      name: 'PAYMENT THANK YOU',
      merchantName: 'Blue Bottle Coffee',
      provider: 'plaid',
      counterparties: [{ name: 'Blue Bottle Coffee', type: 'merchant', entityId: 'eyg8o776k0Q' }],
    });
    expect(stated.key).toBe('bluebottlecoffee');
    expect(stated.source).toBe('provider_entity');
    expect(stated.entityIds).toEqual(['plaid:eyg8o776k0Q']);
  });
});

// ---------------------------------------------------------------------------
// Queries. Raw SQL rather than the read models: every claim above is a claim
// about what is *in* the table, and a read model that filtered would hide it.
// ---------------------------------------------------------------------------

async function merchantRows(database: TestDatabase): Promise<MerchantRowShape[]> {
  const result = await database.db.execute<MerchantRowShape>(sql`
    SELECT id, normalized_key, display_name, provider_entity_ids, updated_at
      FROM merchants
     WHERE user_id = ${database.userId}::uuid
     ORDER BY normalized_key
  `);
  return [...result.rows];
}

async function merchantByKey(
  database: TestDatabase,
  key: string,
): Promise<MerchantRowShape | null> {
  const rows = await merchantRows(database);
  return rows.find((row) => row.normalized_key === key) ?? null;
}

async function merchantOfTransaction(
  database: TestDatabase,
  providerTransactionId: string,
): Promise<MerchantRowShape | null> {
  const result = await database.db.execute<MerchantRowShape>(sql`
    SELECT m.id, m.normalized_key, m.display_name, m.provider_entity_ids, m.updated_at
      FROM transactions t
      JOIN transactions_provider f ON f.id = t.current_fact_id
      LEFT JOIN merchants m ON m.id = t.effective_merchant_id
     WHERE t.user_id = ${database.userId}::uuid
       AND f.provider_transaction_id = ${providerTransactionId}
  `);
  const row = result.rows[0];
  if (row === undefined) throw new Error(`no transaction ${providerTransactionId}`);
  return row.id === null ? null : row;
}

async function countPointingAt(database: TestDatabase, merchantId: string): Promise<number> {
  const result = await database.db.execute<{ count: string }>(sql`
    SELECT count(*) AS count FROM transactions
     WHERE user_id = ${database.userId}::uuid
       AND effective_merchant_id = ${merchantId}::uuid
  `);
  return Number(result.rows[0]?.count ?? -1);
}
