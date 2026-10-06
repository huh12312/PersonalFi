// SPDX-License-Identifier: MIT
/**
 * WP 9.2 — the holder's overlay on an account (CF-16, O-2): `account_overrides`
 * (migration 0035) and its one writer.
 *
 * The theme is D11 applied to an account: provider facts are never mutated, the
 * holder's override outranks them, and one pure resolver decides. And the
 * cross-user rule (09 §5 item 8): another holder's account can never be
 * overridden — proved here predicate by predicate.
 *
 * ## Two layers under every cross-user statement
 *
 * `account_overrides` has a composite foreign key `(user_id, account_id) →
 * accounts (user_id, id)`, and every statement in `src/overrides/store.ts` is
 * also scoped by `user_id` and the account id. Either layer alone refuses a
 * cross-user write, which is exactly why a sabotage that drops one predicate
 * stays green unless the *other* layer is taken away first. So the per-predicate
 * tests run in a scratch database whose composite FK has been dropped
 * ("FK removed"): there every predicate is the only thing standing, each one
 * has a test that can fail without it, and a planted row that the FK would make
 * impossible is what makes a dropped predicate observable. The default-mode
 * tests then prove the layered guarantee with both layers present.
 *
 * ## The provider default is handed in
 *
 * The subtype map is `@ctx/planning`'s (`defaultTaxBucketFor`) and this context
 * may not import it, so the resolver takes the default as an argument and the
 * tests here pass one. That the shipped binding computes the *same* answer from
 * the real map is asserted where both contexts are in scope: `planning`'s
 * `test/db/tax-override.test.ts` and `apps/api`'s `account-overrides-routes`
 * test, both through `apps/api/src/domain.ts` (C5-11).
 */
import { newId } from '@core/kernel';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { upsertAccount } from '../../src/accounts.ts';
import { isLedgerError } from '../../src/errors.ts';
import { LEDGER_EVENTS } from '../../src/events.ts';
import {
  ACCOUNT_ROLES,
  TAX_TREATMENTS,
  VALUATION_BASES,
  clearAccountOverrides,
  getAccountOverride,
  isOverrideNotApplicable,
  listAccountOverrides,
  overrideFingerprint,
  resolveAccountOverlay,
  setAccountOverrides,
  type ProviderTaxDefault,
} from '../../src/overrides/index.ts';
import {
  NO_DATABASE,
  eventPayloads,
  ledgerDatabase,
  seedAccount,
  testClock,
  writeContext,
  type TestDatabase,
} from '../harness.ts';

/** What `defaultTaxBucketFor('investment', '401k')` answers — the stand-in for the map. */
const FOUR_OH_ONE_K: ProviderTaxDefault = { value: 'TAX_DEFERRED', basis: 'subtype' };
const FK = 'account_overrides_account_belongs_to_user';

type Clock = ReturnType<typeof testClock>;

async function seedInvestment(
  database: TestDatabase,
  clock: Clock,
  options: { userId?: string; subtype?: string; name?: string; providerAccountId?: string } = {},
): Promise<{ accountId: string; providerAccountId: string }> {
  const providerAccountId = options.providerAccountId ?? `pa-${newId().slice(-8)}`;
  const result = await database.db.transaction((tx) =>
    upsertAccount(
      tx,
      {
        userId: options.userId ?? database.userId,
        provider: 'plaid',
        providerAccountId,
        name: options.name ?? 'Retirement',
        type: 'investment',
        subtype: options.subtype ?? '401k',
        currency: 'USD',
      },
      writeContext(clock),
    ),
  );
  return { accountId: result.accountId, providerAccountId };
}

async function plantOverride(
  database: TestDatabase,
  row: { userId: string; accountId: string; taxTreatment?: string; role?: string },
): Promise<void> {
  await database.db.execute(sql`
    INSERT INTO account_overrides (id, user_id, account_id, tax_treatment, role)
    VALUES (${newId()}::uuid, ${row.userId}::uuid, ${row.accountId}::uuid,
            ${row.taxTreatment ?? null}, ${row.role ?? null})
  `);
}

async function overrideRows(
  database: TestDatabase,
): Promise<{ user_id: string; account_id: string }[]> {
  const result = await database.db.execute<{ user_id: string; account_id: string }>(
    sql`SELECT user_id, account_id FROM account_overrides ORDER BY created_at, id`,
  );
  return result.rows;
}

function setOverrides(
  database: TestDatabase,
  clock: Clock,
  input: Parameters<typeof setAccountOverrides>[1],
) {
  return database.db.transaction((tx) => setAccountOverrides(tx, input, writeContext(clock)));
}

function clearOverrides(
  database: TestDatabase,
  clock: Clock,
  input: { userId: string; accountId: string },
) {
  return database.db.transaction((tx) => clearAccountOverrides(tx, input, writeContext(clock)));
}

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (isLedgerError(error)) return error.code;
    if (isOverrideNotApplicable(error)) return error.code;
    return `unexpected: ${error instanceof Error ? error.message : String(error)}`;
  }
  return 'did not throw';
}

describe.skipIf(NO_DATABASE)(
  'account overrides — the holder outranks the provider (WP 9.2)',
  () => {
    let database: TestDatabase;
    let clock: Clock;

    beforeAll(async () => {
      database = await ledgerDatabase('overrides');
    }, 300_000);
    afterAll(async () => {
      await database.drop();
    });
    beforeEach(async () => {
      await database.truncate();
      clock = testClock();
    });

    it("a holder-set tax treatment wins over the provider subtype, and clearing it returns to the subtype's", async () => {
      const { accountId, providerAccountId } = await seedInvestment(database, clock);
      const factsOf = async () =>
        (
          await database.db.execute<{ subtype: string; name: string; updated_at: string }>(
            sql`SELECT subtype, name, updated_at FROM accounts WHERE id = ${accountId}::uuid`,
          )
        ).rows;
      const factsBefore = await factsOf();

      // Nothing set: the provider's subtype decides, and the resolver says so.
      const untouched = resolveAccountOverlay({
        override: await getAccountOverride(database.db, { userId: database.userId, accountId }),
        providerTaxDefault: FOUR_OH_ONE_K,
      });
      expect(untouched.taxTreatment).toMatchObject({
        value: 'TAX_DEFERRED',
        source: 'provider_subtype',
      });

      // The holder says it is a Roth: the override wins and the provider's fact is untouched.
      expect(
        await setOverrides(database, clock, {
          userId: database.userId,
          accountId,
          taxTreatment: 'ROTH',
        }),
      ).toEqual({ changed: true, changedFields: ['taxTreatment'], cleared: false });
      const overridden = resolveAccountOverlay({
        override: await getAccountOverride(database.db, { userId: database.userId, accountId }),
        providerTaxDefault: FOUR_OH_ONE_K,
      });
      expect(overridden.taxTreatment).toMatchObject({
        value: 'ROTH',
        source: 'holder',
        override: 'ROTH',
        providerDefault: 'TAX_DEFERRED',
      });
      expect(await factsOf()).toEqual(factsBefore); // provider facts are never mutated

      // A sync that changes the provider's subtype does not undo what the holder said.
      await database.db.transaction((tx) =>
        upsertAccount(
          tx,
          {
            userId: database.userId,
            provider: 'plaid',
            providerAccountId,
            name: 'Retirement',
            type: 'investment',
            subtype: 'ira',
            currency: 'USD',
          },
          writeContext(clock),
        ),
      );
      expect(
        (await getAccountOverride(database.db, { userId: database.userId, accountId }))
          ?.taxTreatment,
      ).toBe('ROTH');

      // Clearing returns to the subtype's default, and says so.
      expect(await clearOverrides(database, clock, { userId: database.userId, accountId })).toEqual(
        {
          changed: true,
          changedFields: ['taxTreatment'],
          cleared: true,
        },
      );
      const back = resolveAccountOverlay({
        override: await getAccountOverride(database.db, { userId: database.userId, accountId }),
        providerTaxDefault: FOUR_OH_ONE_K,
      });
      expect(back.taxTreatment).toMatchObject({
        value: 'TAX_DEFERRED',
        source: 'provider_subtype',
        override: null,
      });

      // Both changes announced — ids and field names, never the values — and a
      // second clear is a no-op that announces nothing.
      expect(await clearOverrides(database, clock, { userId: database.userId, accountId })).toEqual(
        {
          changed: false,
          changedFields: [],
          cleared: false,
        },
      );
      expect(
        await eventPayloads<{ accountId: string; changedFields: string[]; cleared: boolean }>(
          database,
          'ledger.AccountOverrideChanged',
        ),
      ).toEqual([
        { accountId, changedFields: ['taxTreatment'], cleared: false },
        { accountId, changedFields: ['taxTreatment'], cleared: true },
      ]);
    });

    it('an unrecognised subtype reads as an assumption, not as a provider fact', () => {
      const resolved = resolveAccountOverlay({
        override: null,
        providerTaxDefault: { value: 'TAXABLE', basis: 'fallback' },
      });
      expect(resolved.taxTreatment).toMatchObject({
        value: 'TAXABLE',
        source: 'provider_fallback',
      });
      const none = resolveAccountOverlay({
        override: null,
        providerTaxDefault: { value: null, basis: 'none' },
      });
      expect(none.taxTreatment).toMatchObject({ value: null, source: 'none' });
      expect(none.role).toEqual({ value: null, source: 'none' });
      expect(none.valuation).toEqual({ value: 'holdings', source: 'default' });
    });

    it('role and valuation are set, replaced and cleared as a whole; an empty override is no row', async () => {
      const { accountId } = await seedInvestment(database, clock);
      const holder = database.userId;

      expect(
        await setOverrides(database, clock, {
          userId: holder,
          accountId,
          role: 'tax_deferred',
          valuation: 'balance',
        }),
      ).toEqual({ changed: true, changedFields: ['role', 'valuation'], cleared: false });
      expect(await getAccountOverride(database.db, { userId: holder, accountId })).toMatchObject({
        taxTreatment: null,
        role: 'tax_deferred',
        valuation: 'balance',
      });

      // The same values again: nothing changed, nothing announced.
      expect(
        await setOverrides(database, clock, {
          userId: holder,
          accountId,
          role: 'tax_deferred',
          valuation: 'balance',
        }),
      ).toEqual({ changed: false, changedFields: [], cleared: false });

      // A full replacement: an omitted field is cleared.
      expect(
        await setOverrides(database, clock, { userId: holder, accountId, taxTreatment: 'HSA' }),
      ).toEqual({
        changed: true,
        changedFields: ['taxTreatment', 'role', 'valuation'],
        cleared: false,
      });
      expect(await overrideRows(database)).toHaveLength(1);

      // Nothing left set: the row goes, and "no override" has one representation.
      expect(await setOverrides(database, clock, { userId: holder, accountId })).toEqual({
        changed: true,
        changedFields: ['taxTreatment'],
        cleared: true,
      });
      expect(await overrideRows(database)).toHaveLength(0);
      expect(
        (await eventPayloads<{ cleared: boolean }>(database, 'ledger.AccountOverrideChanged')).map(
          (event) => event.cleared,
        ),
      ).toEqual([false, false, true]);
    });

    it('an override the account cannot take is refused by name, and nothing is written', async () => {
      const holder = database.userId;
      const card = await seedAccount(database, clock, { type: 'credit', name: 'Visa' });
      expect(
        await codeOf(
          setOverrides(database, clock, { userId: holder, accountId: card, taxTreatment: 'ROTH' }),
        ),
      ).toBe('ledger.override_not_applicable');
      const checking = await seedAccount(database, clock, { type: 'depository', name: 'Checking' });
      expect(
        await codeOf(
          setOverrides(database, clock, {
            userId: holder,
            accountId: checking,
            valuation: 'balance',
          }),
        ),
      ).toBe('ledger.override_not_applicable');
      // A depository account can carry an HSA treatment (Plaid types HSAs as depository) and a role.
      expect(
        await setOverrides(database, clock, {
          userId: holder,
          accountId: checking,
          taxTreatment: 'HSA',
          role: 'savings',
        }),
      ).toMatchObject({ changed: true });
      expect(await overrideRows(database)).toHaveLength(1);
    });

    it('the fingerprint covers only accounts with something set, in a stable order, and is null when none', async () => {
      const holder = database.userId;
      const a = await seedInvestment(database, clock, { name: 'A' });
      const b = await seedInvestment(database, clock, { name: 'B' });
      expect(
        overrideFingerprint(await listAccountOverrides(database.db, { userId: holder })),
      ).toBeNull();
      await setOverrides(database, clock, {
        userId: holder,
        accountId: b.accountId,
        role: 'savings',
      });
      await setOverrides(database, clock, {
        userId: holder,
        accountId: a.accountId,
        taxTreatment: 'ROTH',
      });
      const fingerprint = overrideFingerprint(
        await listAccountOverrides(database.db, { userId: holder }),
      );
      expect(fingerprint?.map((entry) => entry.accountId)).toEqual(
        [a.accountId, b.accountId].sort(),
      );
      expect(fingerprint?.find((entry) => entry.accountId === a.accountId)).toEqual({
        accountId: a.accountId,
        taxTreatment: 'ROTH',
        role: null,
        valuation: null,
      });
    });

    it('the TypeScript vocabularies and the column CHECKs are the same lists', async () => {
      const result = await database.db.execute<{ def: string }>(sql`
      SELECT pg_get_constraintdef(oid) AS def
        FROM pg_constraint
       WHERE conrelid = 'account_overrides'::regclass AND contype = 'c'
    `);
      const valuesIn = (column: string): string[] => {
        const def = result.rows.map((row) => row.def).find((text) => text.includes(`${column} = ANY`));
        if (def === undefined) throw new Error(`no CHECK on ${column}`);
        return [...def.matchAll(/'([A-Za-z_]+)'::text/gu)].map((match) => match[1] as string);
      };
      expect(valuesIn('tax_treatment').sort()).toEqual([...TAX_TREATMENTS].sort());
      expect(valuesIn('role').sort()).toEqual([...ACCOUNT_ROLES].sort());
      expect(valuesIn('valuation').sort()).toEqual([...VALUATION_BASES].sort());
    });

    it('the event is registered with the ledger, so the pump upcasts it', () => {
      expect(LEDGER_EVENTS.map((event) => event.type)).toContain('ledger.AccountOverrideChanged');
    });

    // -------------------------------------------------------------------------
    // The cross-user rule, with both layers present
    // -------------------------------------------------------------------------

    it("another user's account can never be overridden", async () => {
      const alice = database.userId;
      const bob = await database.createUser('Bob');
      const bobsAccount = await seedInvestment(database, clock, {
        userId: bob,
        name: "Bob's 401k",
      });
      await setOverrides(database, clock, {
        userId: bob,
        accountId: bobsAccount.accountId,
        taxTreatment: 'ROTH',
      });
      const before = await overrideRows(database);
      const eventsBefore = (await eventPayloads(database, 'ledger.AccountOverrideChanged')).length;

      // Set and clear both answer exactly as for an account that does not exist.
      expect(
        await codeOf(
          setOverrides(database, clock, {
            userId: alice,
            accountId: bobsAccount.accountId,
            taxTreatment: 'HSA',
          }),
        ),
      ).toBe('ledger.account_not_found');
      expect(
        await codeOf(
          clearOverrides(database, clock, { userId: alice, accountId: bobsAccount.accountId }),
        ),
      ).toBe('ledger.account_not_found');
      expect(
        await codeOf(setOverrides(database, clock, { userId: alice, accountId: newId() })),
      ).toBe('ledger.account_not_found');

      // Neither read shows Bob's override to Alice.
      expect(
        await getAccountOverride(database.db, { userId: alice, accountId: bobsAccount.accountId }),
      ).toBeNull();
      expect(await listAccountOverrides(database.db, { userId: alice })).toEqual([]);

      // Nothing was written and nothing was announced.
      expect(await overrideRows(database)).toEqual(before);
      expect(
        (await getAccountOverride(database.db, { userId: bob, accountId: bobsAccount.accountId }))
          ?.taxTreatment,
      ).toBe('ROTH');
      expect((await eventPayloads(database, 'ledger.AccountOverrideChanged')).length).toBe(
        eventsBefore,
      );
    });

    it('the composite foreign key refuses a row naming another holder’s account, whatever the code above it does', async () => {
      const alice = database.userId;
      const bob = await database.createUser('Bob');
      const bobsAccount = await seedInvestment(database, clock, { userId: bob });
      let failure: unknown;
      try {
        await plantOverride(database, {
          userId: alice,
          accountId: bobsAccount.accountId,
          taxTreatment: 'ROTH',
        });
      } catch (error) {
        failure = error;
      }
      const cause = (failure as { cause?: { code?: string; constraint?: string } } | undefined)
        ?.cause;
      expect(cause?.code).toBe('23503');
      expect(cause?.constraint).toBe(FK);
      expect(await overrideRows(database)).toEqual([]);
    });
  },
);

// ---------------------------------------------------------------------------
// Every scoping predicate on its own: the composite FK is removed, so the
// predicate is the only thing between Alice and Bob's row.
// ---------------------------------------------------------------------------

describe.skipIf(NO_DATABASE)(
  "another user's account can never be overridden — every predicate on its own (FK removed)",
  () => {
    let database: TestDatabase;
    let clock: Clock;
    let alice: string;
    let bob: string;

    beforeAll(async () => {
      database = await ledgerDatabase('overrides_nofk');
      await database.db.execute(sql.raw(`ALTER TABLE account_overrides DROP CONSTRAINT ${FK}`));
    }, 300_000);
    afterAll(async () => {
      await database.drop();
    });
    beforeEach(async () => {
      await database.truncate();
      clock = testClock();
      alice = database.userId;
      bob = await database.createUser('Bob');
    });

    it('setAccountOverrides: the account lookup is scoped to the holder (accounts.user_id)', async () => {
      const bobs = await seedInvestment(database, clock, { userId: bob });
      expect(
        await codeOf(
          setOverrides(database, clock, {
            userId: alice,
            accountId: bobs.accountId,
            taxTreatment: 'ROTH',
          }),
        ),
      ).toBe('ledger.account_not_found');
      expect(await overrideRows(database)).toEqual([]);
    });

    it('setAccountOverrides: the account lookup is scoped to the account (accounts.id)', async () => {
      await seedInvestment(database, clock, { userId: alice }); // Alice owns *an* account, just not this id
      expect(
        await codeOf(
          setOverrides(database, clock, {
            userId: alice,
            accountId: newId(),
            taxTreatment: 'ROTH',
          }),
        ),
      ).toBe('ledger.account_not_found');
      expect(await overrideRows(database)).toEqual([]);
    });

    it('clearAccountOverrides: the account lookup is scoped to the holder (accounts.user_id)', async () => {
      const bobs = await seedInvestment(database, clock, { userId: bob });
      await plantOverride(database, {
        userId: bob,
        accountId: bobs.accountId,
        taxTreatment: 'ROTH',
      });
      expect(
        await codeOf(clearOverrides(database, clock, { userId: alice, accountId: bobs.accountId })),
      ).toBe('ledger.account_not_found');
      expect(await overrideRows(database)).toHaveLength(1);
    });

    it('clearAccountOverrides: the account lookup is scoped to the account (accounts.id)', async () => {
      await seedInvestment(database, clock, { userId: alice });
      expect(
        await codeOf(clearOverrides(database, clock, { userId: alice, accountId: newId() })),
      ).toBe('ledger.account_not_found');
    });

    it("clearAccountOverrides: the delete is scoped to the holder (account_overrides.user_id) — Bob's row survives", async () => {
      const mine = await seedInvestment(database, clock, { userId: alice });
      // A row the composite FK would make impossible: Bob's override naming Alice's account id.
      await plantOverride(database, {
        userId: bob,
        accountId: mine.accountId,
        taxTreatment: 'ROTH',
      });
      await plantOverride(database, { userId: alice, accountId: mine.accountId, role: 'savings' });
      expect(
        await clearOverrides(database, clock, { userId: alice, accountId: mine.accountId }),
      ).toMatchObject({
        changed: true,
      });
      expect(await overrideRows(database)).toEqual([{ user_id: bob, account_id: mine.accountId }]);
    });

    it("clearAccountOverrides: the delete is scoped to the account (account_overrides.account_id) — her other account's row survives", async () => {
      const x = await seedInvestment(database, clock, { userId: alice, name: 'X' });
      const y = await seedInvestment(database, clock, { userId: alice, name: 'Y' });
      await plantOverride(database, { userId: alice, accountId: y.accountId, role: 'savings' });
      await plantOverride(database, { userId: alice, accountId: x.accountId, role: 'spending' });
      await clearOverrides(database, clock, { userId: alice, accountId: x.accountId });
      expect(await overrideRows(database)).toEqual([{ user_id: alice, account_id: y.accountId }]);
    });

    it("setAccountOverrides emptying a row: the delete is scoped to the holder (account_overrides.user_id) — Bob's row survives", async () => {
      const mine = await seedInvestment(database, clock, { userId: alice });
      await plantOverride(database, {
        userId: bob,
        accountId: mine.accountId,
        taxTreatment: 'ROTH',
      });
      await setOverrides(database, clock, {
        userId: alice,
        accountId: mine.accountId,
        role: 'savings',
      });
      await setOverrides(database, clock, { userId: alice, accountId: mine.accountId });
      expect(await overrideRows(database)).toEqual([{ user_id: bob, account_id: mine.accountId }]);
    });

    it("setAccountOverrides emptying a row: the delete is scoped to the account (account_overrides.account_id) — her other account's row survives", async () => {
      const x = await seedInvestment(database, clock, { userId: alice, name: 'X' });
      const y = await seedInvestment(database, clock, { userId: alice, name: 'Y' });
      await setOverrides(database, clock, {
        userId: alice,
        accountId: y.accountId,
        role: 'savings',
      });
      await setOverrides(database, clock, {
        userId: alice,
        accountId: x.accountId,
        role: 'spending',
      });
      await setOverrides(database, clock, { userId: alice, accountId: x.accountId });
      expect(await overrideRows(database)).toEqual([{ user_id: alice, account_id: y.accountId }]);
    });

    it("getAccountOverride: the read is scoped to the holder (account_overrides.user_id) — Bob's row is invisible", async () => {
      const mine = await seedInvestment(database, clock, { userId: alice });
      await plantOverride(database, {
        userId: bob,
        accountId: mine.accountId,
        taxTreatment: 'ROTH',
      });
      expect(
        await getAccountOverride(database.db, { userId: alice, accountId: mine.accountId }),
      ).toBeNull();
    });

    it("getAccountOverride: the read is scoped to the account (account_overrides.account_id) — she gets this account's row", async () => {
      const x = await seedInvestment(database, clock, { userId: alice, name: 'X' });
      const y = await seedInvestment(database, clock, { userId: alice, name: 'Y' });
      await plantOverride(database, { userId: alice, accountId: y.accountId, role: 'savings' });
      await plantOverride(database, { userId: alice, accountId: x.accountId, role: 'spending' });
      expect(
        (await getAccountOverride(database.db, { userId: alice, accountId: x.accountId }))?.role,
      ).toBe('spending');
    });

    it("listAccountOverrides: the read is scoped to the holder (account_overrides.user_id) — Bob's rows are not listed", async () => {
      const mine = await seedInvestment(database, clock, { userId: alice });
      const bobs = await seedInvestment(database, clock, { userId: bob });
      await plantOverride(database, { userId: alice, accountId: mine.accountId, role: 'savings' });
      await plantOverride(database, {
        userId: bob,
        accountId: bobs.accountId,
        taxTreatment: 'ROTH',
      });
      expect(
        (await listAccountOverrides(database.db, { userId: alice })).map((o) => o.accountId),
      ).toEqual([mine.accountId]);
    });

    it('all of them dropped together: Alice can reach neither the write nor the read of Bob’s account (FK removed)', async () => {
      // The "together" case is asserted by the default-mode test above, with the FK
      // present; here, FK removed, the same statement holds on the predicates alone.
      const bobs = await seedInvestment(database, clock, { userId: bob });
      await plantOverride(database, {
        userId: bob,
        accountId: bobs.accountId,
        taxTreatment: 'ROTH',
      });
      expect(
        await codeOf(
          setOverrides(database, clock, {
            userId: alice,
            accountId: bobs.accountId,
            role: 'savings',
          }),
        ),
      ).toBe('ledger.account_not_found');
      expect(
        await codeOf(clearOverrides(database, clock, { userId: alice, accountId: bobs.accountId })),
      ).toBe('ledger.account_not_found');
      expect(
        await getAccountOverride(database.db, { userId: alice, accountId: bobs.accountId }),
      ).toBeNull();
      expect(await listAccountOverrides(database.db, { userId: alice })).toEqual([]);
      expect(await overrideRows(database)).toEqual([{ user_id: bob, account_id: bobs.accountId }]);
    });
  },
);
