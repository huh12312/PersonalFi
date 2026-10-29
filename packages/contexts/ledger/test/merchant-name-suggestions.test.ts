// SPDX-License-Identifier: MIT
/**
 * WP 11.6: merchant display-name suggestions, the ledger's half, against a real
 * Postgres (scratch database `wp116_ledger_*`).
 *
 *   1. **Candidates are noise only**, one per key, most-used first, capped at
 *      fifty — and never a key that already has a row (suggested, dismissed,
 *      refused) or that the holder renamed on any transaction.
 *   2. **An answer is recorded once.** A second record for the same key writes
 *      nothing and changes nothing.
 *   3. **Accept is the manual rename.** Every transaction of the merchant the
 *      holder has not renamed gains `user_merchant_name` — the overlay, through
 *      `setTransactionOverlay` — and lands on the renamed merchant row exactly as
 *      `PATCH /transactions/:id { payeeName }` would have put it; a rename the
 *      holder typed is untouched; `merchants.display_name` of the noise row is
 *      never rewritten; the provider facts are byte-identical.
 *   4. **Dismiss is recorded and final**; the key is not a candidate again.
 *   5. **The migration's CHECKs** refuse a half-written row and a hosted provider.
 */
import { money, newId } from '@core/kernel';
import { createTestDatabase } from '@core/testkit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyProviderTransactions } from '../src/apply.ts';
import {
  MERCHANT_NAME_RUN_CAP,
  acceptMerchantNameSuggestion,
  dismissMerchantNameSuggestion,
  listMerchantNameCandidates,
  listMerchantNameSuggestions,
  recordMerchantNameAnswer,
} from '../src/merchant-name-suggestions.ts';
import { setTransactionOverlay } from '../src/overlay.ts';
import type { ProviderTransactionInput } from '../src/types.ts';
import {
  CORRELATION_ID,
  NO_DATABASE,
  providerTransaction,
  seedAccount,
  testClock,
  writeContext,
  type TestDatabase,
} from './harness.ts';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const MODEL = 'qwen2.5:7b-instruct-q4_K_M@sha256:' + '5'.repeat(64);

describe.skipIf(NO_DATABASE)('merchant.name suggestions (ledger)', () => {
  let database: TestDatabase;
  const clock = testClock();
  let accountId: string;

  beforeAll(async () => {
    database = await createTestDatabase(`wp116_ledger_${newId().replaceAll('-', '').slice(-12)}`);
  });
  afterAll(async () => {
    await database.drop();
  });
  beforeEach(async () => {
    await database.truncate();
    accountId = await seedAccount(database, clock);
  });

  let sequence = 0;
  async function apply(names: readonly string[]): Promise<void> {
    const added: ProviderTransactionInput[] = names.map((name) => {
      sequence += 1;
      return providerTransaction({
        providerTransactionId: `ptx-${String(sequence)}`,
        name,
        // A distinct amount per row, so no two rows are cross-provider duplicates.
        amount: money(BigInt(-100 - sequence), 'USD'),
      });
    });
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

  async function record(
    key: string,
    descriptor: string,
    answer: Parameters<typeof recordMerchantNameAnswer>[2]['answer'],
  ) {
    return recordMerchantNameAnswer(
      database.db,
      { userId: database.userId, clock },
      {
        normalizedKey: key,
        descriptor,
        strippedPrefix: null,
        answer,
        llmProvider: 'ollama',
        llmModel: MODEL,
        runId: newId(),
        inputDigest: DIGEST,
      },
    );
  }

  async function rowsOf(key: string) {
    const result = await database.db.execute<{
      id: string;
      effective_name: string;
      user_merchant_name: string | null;
      normalized_key: string | null;
    }>(sql`
      SELECT t.id, t.effective_name, t.user_merchant_name, m.normalized_key
        FROM transactions t
        JOIN transactions_provider p ON p.id = t.current_fact_id
        LEFT JOIN merchants m ON m.id = t.effective_merchant_id
       WHERE t.user_id = ${database.userId} AND p.name LIKE ${key}
       ORDER BY t.id`);
    return result.rows;
  }

  it('lists noise merchants only, one per key, most-used first', async () => {
    await apply([
      'PAYPAL *EBAYINC',
      'PAYPAL *EBAYINC',
      'PAYPAL *EBAYINC',
      'WHLFDS MKT #10234',
      'WHLFDS MKT #10299',
      'CKO*PATREON* MEMBERSHIP',
      // Clean, a banking operation, the prefix that is the merchant: never candidates.
      'SQ *BLUE BOTTLE COFFEE #4471 OAKLAND CA',
      'CHECK 1234',
      'AMZN Mktp US*2K4TT1FF2',
      'TST* JOES PIZZA 0042',
    ]);
    const listed = await listMerchantNameCandidates(database.db, database.userId);
    expect(
      listed.candidates.map((c) => [
        c.normalizedKey,
        c.descriptor,
        c.strippedPrefix,
        c.transactions,
      ]),
    ).toEqual([
      ['ebayinc', 'Ebayinc', 'PAYPAL *', 3],
      ['whlfdsmkt', 'Whlfds MKT', null, 2],
      ['ckopatreonmembership', 'Cko*patreon* Membership', null, 1],
    ]);
    expect(listed.deferred).toBe(0);
  });

  it('never lists a key with a row — suggested, dismissed or refused — nor one the holder renamed', async () => {
    await apply([
      'PAYPAL *EBAYINC',
      'WHLFDS MKT #10234',
      'CKO*PATREON* MEMBERSHIP',
      'STRBCKS 0042',
      'APPLE.COM/BILL',
    ]);
    await record('ebayinc', 'Ebayinc', { status: 'suggested', displayName: 'Ebay' });
    await record('whlfdsmkt', 'Whlfds MKT', { status: 'refused', refusalClass: 'name.invented' });
    await record('ckopatreonmembership', 'Cko*patreon* Membership', {
      status: 'suggested',
      displayName: 'Patreon Membership',
    });
    const [patreon] = await listMerchantNameSuggestions(database.db, database.userId, {
      statuses: ['suggested'],
    }).then((rows) => rows.filter((row) => row.normalizedKey === 'ckopatreonmembership'));
    await dismissMerchantNameSuggestion(
      database.db,
      { userId: database.userId, suggestionId: patreon?.id ?? '' },
      writeContext(clock),
    );
    // The holder renames the Starbucks abbreviation by hand.
    const [strbcks] = await rowsOf('STRBCKS%');
    await database.db.transaction((tx) =>
      setTransactionOverlay(
        tx,
        {
          userId: database.userId,
          transactionId: strbcks?.id ?? '',
          patch: { userMerchantName: 'Starbucks' },
        },
        writeContext(clock),
      ),
    );

    const listed = await listMerchantNameCandidates(database.db, database.userId);
    expect(listed.candidates.map((c) => c.normalizedKey)).toEqual(['applecombill']);
    expect(listed.skipped).toMatchObject({ asked: 3, renamed: 1 });
  });

  it('caps a run at fifty and defers the rest', async () => {
    const names = Array.from({ length: 53 }, (_unused, index) => {
      // Fifty-three distinct noise merchants: a hash token each.
      const letters =
        String.fromCharCode(65 + (index % 26)) + String.fromCharCode(65 + Math.floor(index / 26));
      return `SHOP${letters} 9${letters}7Q2Z`;
    });
    await apply(names);
    const listed = await listMerchantNameCandidates(database.db, database.userId);
    expect(MERCHANT_NAME_RUN_CAP).toBe(50);
    expect(listed.candidates).toHaveLength(50);
    expect(listed.deferred).toBe(3);
    expect(new Set(listed.candidates.map((c) => c.normalizedKey)).size).toBe(50);
  });

  it('records an answer once; a second record for the key changes nothing', async () => {
    expect(await record('ebayinc', 'Ebayinc', { status: 'suggested', displayName: 'Ebay' })).toBe(
      true,
    );
    expect(
      await record('ebayinc', 'Ebayinc', { status: 'suggested', displayName: 'Something Else' }),
    ).toBe(false);
    const rows = await listMerchantNameSuggestions(database.db, database.userId);
    expect(rows.map((row) => [row.normalizedKey, row.status, row.displayName])).toEqual([
      ['ebayinc', 'suggested', 'Ebay'],
    ]);
  });

  it('accept renames every unrenamed transaction through the overlay, as the manual rename does, and nothing else', async () => {
    await apply(['PAYPAL *EBAYINC', 'PAYPAL *EBAYINC', 'PAYPAL *EBAYINC']);
    const before = await rowsOf('PAYPAL *EBAYINC');
    // The holder already renamed one of the three by hand: theirs is kept.
    await database.db.transaction((tx) =>
      setTransactionOverlay(
        tx,
        {
          userId: database.userId,
          transactionId: before[0]?.id ?? '',
          patch: { userMerchantName: 'My eBay' },
        },
        writeContext(clock),
      ),
    );
    const facts = await database.db.execute(
      sql`SELECT * FROM transactions_provider WHERE user_id = ${database.userId} ORDER BY id`,
    );
    await record('ebayinc', 'Ebayinc', { status: 'suggested', displayName: 'Ebay' });
    const [suggestion] = await listMerchantNameSuggestions(database.db, database.userId);

    const accepted = await acceptMerchantNameSuggestion(
      database.db,
      { userId: database.userId, suggestionId: suggestion?.id ?? '' },
      writeContext(clock),
    );
    expect(accepted.renamed).toBe(2);
    expect(accepted.suggestion.status).toBe('accepted');

    const after = await rowsOf('PAYPAL *EBAYINC');
    expect(
      after.map((row) => [row.user_merchant_name, row.effective_name, row.normalized_key]),
    ).toEqual([
      ['My eBay', 'My eBay', 'myebay'],
      ['Ebay', 'Ebay', 'ebay'],
      ['Ebay', 'Ebay', 'ebay'],
    ]);
    // The noise merchant row's own display name is never rewritten.
    const noise = await database.db.execute<{ display_name: string }>(
      sql`SELECT display_name FROM merchants WHERE user_id = ${database.userId} AND normalized_key = 'ebayinc'`,
    );
    expect(noise.rows[0]?.display_name).toBe('Ebayinc');
    // The provider facts are untouched (D11).
    const factsAfter = await database.db.execute(
      sql`SELECT * FROM transactions_provider WHERE user_id = ${database.userId} ORDER BY id`,
    );
    expect(factsAfter.rows).toEqual(facts.rows);

    // Exactly what the manual rename produces for the same name on a fresh row.
    await apply(['PAYPAL *EBAYINC']);
    const fresh = (await rowsOf('PAYPAL *EBAYINC')).find((row) => row.user_merchant_name === null);
    const manual = await database.db.transaction((tx) =>
      setTransactionOverlay(
        tx,
        {
          userId: database.userId,
          transactionId: fresh?.id ?? '',
          patch: { userMerchantName: 'Ebay' },
        },
        writeContext(clock),
      ),
    );
    const renamed = (await rowsOf('PAYPAL *EBAYINC')).filter(
      (row) => row.user_merchant_name === 'Ebay',
    );
    expect(new Set(renamed.map((row) => row.normalized_key))).toEqual(new Set(['ebay']));
    expect(manual.effective.name).toBe('Ebay');
  });

  it('accept again picks up a transaction that arrived after the first accept; dismiss is final', async () => {
    await apply(['WHLFDS MKT #10234']);
    await record('whlfdsmkt', 'Whlfds MKT', { status: 'suggested', displayName: 'Whlfds' });
    const [suggestion] = await listMerchantNameSuggestions(database.db, database.userId);
    const id = suggestion?.id ?? '';
    expect(
      (
        await acceptMerchantNameSuggestion(
          database.db,
          { userId: database.userId, suggestionId: id },
          writeContext(clock),
        )
      ).renamed,
    ).toBe(1);
    await apply(['WHLFDS MKT #10299']);
    expect(
      (
        await acceptMerchantNameSuggestion(
          database.db,
          { userId: database.userId, suggestionId: id },
          writeContext(clock),
        )
      ).renamed,
    ).toBe(1);
    const dismissed = await dismissMerchantNameSuggestion(
      database.db,
      { userId: database.userId, suggestionId: id },
      writeContext(clock),
    );
    expect(dismissed.status).toBe('dismissed');
    await expect(
      acceptMerchantNameSuggestion(
        database.db,
        { userId: database.userId, suggestionId: id },
        writeContext(clock),
      ),
    ).rejects.toMatchObject({ code: 'ledger.merchant_name_suggestion_closed' });
    await expect(
      dismissMerchantNameSuggestion(
        database.db,
        { userId: database.userId, suggestionId: id },
        writeContext(clock),
      ),
    ).rejects.toMatchObject({ code: 'ledger.merchant_name_suggestion_closed' });
    // The renames the accepts made stay: they are the holder's overlay now.
    expect((await rowsOf('WHLFDS%')).map((row) => row.user_merchant_name)).toEqual([
      'Whlfds',
      'Whlfds',
    ]);
    expect((await listMerchantNameCandidates(database.db, database.userId)).candidates).toEqual([]);
  });

  it('a refused row cannot be accepted, and another holder’s id is not found', async () => {
    await record('whlfdsmkt', 'Whlfds MKT', { status: 'refused', refusalClass: 'name.invented' });
    const [refused] = await listMerchantNameSuggestions(database.db, database.userId);
    await expect(
      acceptMerchantNameSuggestion(
        database.db,
        { userId: database.userId, suggestionId: refused?.id ?? '' },
        writeContext(clock),
      ),
    ).rejects.toMatchObject({ code: 'ledger.merchant_name_suggestion_closed' });
    await expect(
      acceptMerchantNameSuggestion(
        database.db,
        { userId: newId(), suggestionId: refused?.id ?? '' },
        writeContext(clock),
      ),
    ).rejects.toMatchObject({ code: 'ledger.merchant_name_suggestion_not_found' });
  });

  it('the CHECKs refuse a half-written row and any provider but the local one', async () => {
    interface Row {
      readonly key: string;
      readonly status: string;
      readonly name: string | null;
      readonly refusal: string | null;
      readonly provider: string;
      readonly decided: boolean;
    }
    const insert = (row: Row) =>
      database.db.execute(sql`
        INSERT INTO merchant_name_suggestions
          (id, user_id, normalized_key, descriptor, status, display_name, refusal_class, llm_provider,
           llm_model, run_id, input_digest, suggested_at, decided_at)
        VALUES (${newId()}, ${database.userId}, ${row.key}, 'Ebayinc', ${row.status}, ${row.name},
                ${row.refusal}, ${row.provider}, 'm', ${newId()}, ${DIGEST}, now(),
                ${row.decided ? sql`now()` : sql`NULL`})`);
    const ok: Row = {
      key: 'k1',
      status: 'suggested',
      name: 'Ebay',
      refusal: null,
      provider: 'ollama',
      decided: false,
    };
    await expect(insert(ok)).resolves.toBeDefined();
    for (const bad of [
      { ...ok, key: 'k2', name: null }, // a suggestion with no name
      { ...ok, key: 'k3', status: 'refused', refusal: 'name.invented' }, // a refusal with a name
      { ...ok, key: 'k4', status: 'refused', name: null }, // a refusal with no class
      { ...ok, key: 'k5', provider: 'anthropic' }, // a hosted provider
      { ...ok, key: 'k6', status: 'accepted' }, // an accept with no decision instant
      { ...ok, key: 'k7', name: 'x'.repeat(41) }, // a name over forty characters
      { ...ok, key: 'K8' }, // a key that is not a normalized_key
    ] satisfies Row[]) {
      await expect(insert(bad), JSON.stringify(bad)).rejects.toThrow();
    }
    // One row per (user, key).
    await expect(insert(ok)).rejects.toThrow();
  });
});
