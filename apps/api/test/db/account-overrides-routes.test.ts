// SPDX-License-Identifier: MIT
/**
 * WP 9.2 — the holder's overlay on an account, through the real application.
 *
 * `PUT /accounts/{id}/overrides`, `DELETE /accounts/{id}/overrides`,
 * `GET /accounts/valuation`, the `overlay` block on `GET /accounts`, and the
 * `account_overrides_changed` staleness on the plan routes. Everything here goes
 * through `buildApp` (`app.ts`) and the shipped `domain.ts` binding — the real
 * session guard, the real error handler, the real `planningPortsFor` and
 * `planningCashflowReaderFor` — never a parallel construction of any of them
 * (C5-11). The ledger-level and planning-level tests (`ledger/test/db/
 * account-overrides.test.ts`, `planning/test/db/tax-override.test.ts`) prove the
 * pieces; this file proves they are joined.
 *
 * The two planning exit tests are mirrored here by name, because a planning
 * test cannot import `domain.ts` (`personalfi/layer-imports`).
 *
 * Every account here is shaped like a Plaid one (`upsertAccount` with a
 * subtype — the manual connector has no subtype), written through the ledger's
 * own writers.
 */
import { Money, systemClock } from '@core/kernel';
import { recordBalance, upsertAccount } from '@ctx/ledger';
import { computeNetWorth, sealDay, upsertOpenDay } from '@ctx/planning';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planningCashflowReaderFor, planningPortsFor } from '../../src/domain.ts';
import {
  NO_DATABASE,
  createApiHarness,
  expectStatus,
  problemOf,
  type ApiHarness,
  type TestSession,
} from '../helpers/api-harness.ts';

const DAY_MS = 86_400_000;
const day = (offsetDays: number): string =>
  new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);

interface OverlayWire {
  taxTreatment: {
    effective: string | null;
    source: string;
    override: string | null;
    providerDefault: string | null;
  };
  role: { effective: string | null; source: string };
  valuation: { effective: string; source: string };
}
interface AccountWire {
  id: string;
  name: string;
  overlay: OverlayWire;
}
interface OutcomeWire {
  status: string;
  run: { id: string; inputDigest?: string } | null;
  staleness: null | {
    reason: string;
    changes?: { accountId: string; field: string; from: string | null; to: string | null }[];
  };
}

describe.skipIf(NO_DATABASE)('account overrides, through the real application (WP 9.2)', () => {
  let h: ApiHarness;
  let alice: TestSession;
  let bob: TestSession;
  let aliceId: string;
  let bobId: string;
  let rollover: string; // Plaid says IRA
  let typedBrokerage: string; // Plaid says brokerage; no holdings synced
  let checking: string;
  let card: string;
  let bobs401k: string;
  let baselineId: string;
  let sealedDay: string;

  const put = (session: TestSession | undefined, accountId: string, body: unknown) =>
    h.request({
      method: 'PUT',
      url: `/accounts/${accountId}/overrides`,
      ...(session === undefined ? {} : { session }),
      body,
    });
  const del = (session: TestSession | undefined, accountId: string) =>
    h.request({
      method: 'DELETE',
      url: `/accounts/${accountId}/overrides`,
      ...(session === undefined ? {} : { session }),
    });
  const accountsOf = async (session: TestSession): Promise<AccountWire[]> => {
    const response = await h.request({ method: 'GET', url: '/accounts', session });
    expectStatus(response, 200);
    return (response.json() as { accounts: AccountWire[] }).accounts;
  };
  const overlayOf = async (session: TestSession, accountId: string): Promise<OverlayWire> => {
    const found = (await accountsOf(session)).find((account) => account.id === accountId);
    if (found === undefined) throw new Error(`no account ${accountId}`);
    return found.overlay;
  };
  const overrideRows = async () =>
    (
      await h.database.db.execute<{
        user_id: string;
        account_id: string;
        tax_treatment: string | null;
      }>(
        sql`SELECT user_id, account_id, tax_treatment FROM account_overrides ORDER BY created_at, id`,
      )
    ).rows;

  async function openAccount(
    userId: string,
    spec: {
      name: string;
      type: 'investment' | 'depository' | 'credit';
      subtype: string;
      balance?: string;
    },
  ): Promise<string> {
    const { accountId } = await h.database.db.transaction((tx) =>
      upsertAccount(
        tx,
        {
          userId,
          provider: 'plaid',
          providerAccountId: `pa-${spec.name.replaceAll(' ', '-').toLowerCase()}`,
          name: spec.name,
          type: spec.type,
          subtype: spec.subtype,
          currency: 'USD',
        },
        { clock: systemClock, correlationId: '01920000-0000-7000-8000-0000000000d9' },
      ),
    );
    if (spec.balance !== undefined) {
      await h.database.db.transaction((tx) =>
        recordBalance(
          tx,
          {
            userId,
            accountId,
            current: Money.of(BigInt(spec.balance as string), 'USD'),
            asOf: new Date(Date.now() - 3 * DAY_MS),
            source: 'manual',
          },
          { clock: systemClock, correlationId: '01920000-0000-7000-8000-0000000000d9' },
        ),
      );
    }
    return accountId;
  }

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp92-overrides' });
    aliceId = h.userId;
    // A session *without* a step-up assertion: these routes need only a session.
    alice = h.stale;
    bobId = await h.database.createUser('Bob');
    bob = await h.issueSession({ userId: bobId });

    rollover = await openAccount(aliceId, {
      name: 'Rollover',
      type: 'investment',
      subtype: 'ira',
      balance: '25000000',
    });
    typedBrokerage = await openAccount(aliceId, {
      name: 'Typed brokerage',
      type: 'investment',
      subtype: 'brokerage',
      balance: '10000000',
    });
    checking = await openAccount(aliceId, {
      name: 'Checking',
      type: 'depository',
      subtype: 'checking',
      balance: '300000',
    });
    card = await openAccount(aliceId, {
      name: 'Visa',
      type: 'credit',
      subtype: 'credit card',
      balance: '-40000',
    });
    bobs401k = await openAccount(bobId, {
      name: 'Bob 401k',
      type: 'investment',
      subtype: '401k',
      balance: '9000000',
    });
  }, 300_000);

  afterAll(async () => {
    await h.close();
  });

  // -------------------------------------------------------------------------
  // The overlay on GET /accounts
  // -------------------------------------------------------------------------

  it('GET /accounts says what each account is and where that came from', async () => {
    const accounts = await accountsOf(alice);
    const by = new Map(accounts.map((account) => [account.id, account.overlay]));
    // The provider's subtype named it.
    expect(by.get(rollover)?.taxTreatment).toEqual({
      effective: 'TAX_DEFERRED',
      source: 'provider_subtype',
      override: null,
      providerDefault: 'TAX_DEFERRED',
    });
    // Nothing recognised the subtype: TAXABLE is an assumption, and says so.
    expect(by.get(typedBrokerage)?.taxTreatment).toMatchObject({
      effective: 'TAXABLE',
      source: 'provider_fallback',
    });
    // A cash account has no bucket at all.
    expect(by.get(checking)?.taxTreatment).toMatchObject({ effective: null, source: 'none' });
    expect(by.get(rollover)?.valuation).toEqual({ effective: 'holdings', source: 'default' });
    expect(by.get(rollover)?.role).toEqual({ effective: null, source: 'none' });
  });

  // -------------------------------------------------------------------------
  // The first ledger exit test, through the shipped composition
  // -------------------------------------------------------------------------

  it("a holder-set tax treatment wins over the provider subtype, and clearing it returns to the subtype's", async () => {
    const reader = planningCashflowReaderFor(h.database.db, {
      userId: aliceId,
      timeZone: 'UTC',
      clock: systemClock,
    });
    const bucketOf = async (accountId: string) =>
      (await reader.accounts(aliceId, day(-1))).find((entry) => entry.accountId === accountId)
        ?.taxBucket;

    expect(await bucketOf(rollover)).toBe('TAX_DEFERRED');

    const set = await put(alice, rollover, { taxTreatment: 'ROTH' });
    expectStatus(set, 200);
    const body = set.json() as { account: AccountWire; changed: boolean };
    expect(body.changed).toBe(true);
    expect(body.account.overlay.taxTreatment).toEqual({
      effective: 'ROTH',
      source: 'holder',
      override: 'ROTH',
      providerDefault: 'TAX_DEFERRED',
    });
    // The shipped binding the projection starts from agrees with the screen.
    expect(await bucketOf(rollover)).toBe('ROTH');
    // The provider's own fact is untouched.
    const subtype = await h.database.db.execute<{ subtype: string }>(
      sql`SELECT subtype FROM accounts WHERE id = ${rollover}::uuid`,
    );
    expect(subtype.rows[0]?.subtype).toBe('ira');

    const cleared = await del(alice, rollover);
    expectStatus(cleared, 200);
    expect((cleared.json() as { account: AccountWire }).account.overlay.taxTreatment).toMatchObject(
      {
        effective: 'TAX_DEFERRED',
        source: 'provider_subtype',
        override: null,
      },
    );
    expect(await bucketOf(rollover)).toBe('TAX_DEFERRED');
    expect((await overrideRows()).length).toBe(0);

    // Clearing again changes nothing.
    const again = await del(alice, rollover);
    expectStatus(again, 200);
    expect((again.json() as { changed: boolean }).changed).toBe(false);
  });

  // -------------------------------------------------------------------------
  // The two planning exit tests, through the real routes
  // -------------------------------------------------------------------------

  describe('the plan and the net-worth valuation', () => {
    beforeAll(async () => {
      // The holder says the rollover is valued by its typed balance (O-2).
      expectStatus(await put(alice, rollover, { valuation: 'balance', role: 'tax_deferred' }), 200);

      sealedDay = day(-2);
      const ports = planningPortsFor(h.database.db, {
        userId: aliceId,
        timeZone: 'UTC',
        clock: systemClock,
      });
      const snapshot = await computeNetWorth(ports, {
        userId: aliceId,
        asOfDate: sealedDay,
        baseCurrency: 'USD',
      });
      await upsertOpenDay(h.database.db, { userId: aliceId, snapshot, clock: systemClock });
      await sealDay(h.database.db, { userId: aliceId, asOfDate: sealedDay, clock: systemClock });

      const baseline = await h.request({
        method: 'POST',
        url: '/plan/scenarios',
        session: alice,
        body: {
          kind: 'baseline',
          name: 'My baseline',
          profile: {
            birthDate: '1980-01-01',
            retirementAge: 65,
            planEndAge: 95,
            currency: 'USD',
            glidepath: { kind: 'age_based' },
            contributionGrowth: 'flat',
            annualSpending: { minor: '4000000', currency: 'USD' },
            withdrawalPolicy: 'constant_real',
            spendingFloor: 'none',
            taxDeferredRate: '0.15',
            socialSecurity: null,
            pensions: [],
            contributions: { TAXABLE: { minor: '600000', currency: 'USD' } },
          },
        },
      });
      expectStatus(baseline, 201);
      baselineId = (baseline.json() as { id: string }).id;
    }, 120_000);

    const project = (body: Record<string, unknown> = {}) =>
      h.request({
        method: 'POST',
        url: `/plan/scenarios/${baselineId}/projections`,
        session: alice,
        body: { method: 'deterministic', ...body },
      });

    it('an account valued by balance counts at that balance and is labelled so; one valued by holdings with none is named unvalued, never zero', async () => {
      const response = await h.request({
        method: 'GET',
        url: '/accounts/valuation',
        session: alice,
      });
      expectStatus(response, 200);
      const valuation = response.json() as {
        unvalued: { accountId: string; name: string; reason: string }[];
        byBalance: { accountId: string; name: string }[];
      };
      expect(valuation.byBalance).toEqual([{ accountId: rollover, name: 'Rollover' }]);
      expect(valuation.unvalued).toEqual([
        { accountId: typedBrokerage, name: 'Typed brokerage', reason: 'no_priced_holding' },
      ]);

      // The sealed day, computed by the shipped ports: the rollover at its $250,000 with
      // the label on its breakdown entry; the typed brokerage's $100,000 counted nowhere.
      const row = (
        await h.database.db.execute<{
          net_worth_minor: string;
          accounts_unvalued: number;
          breakdown: { accountId: string; baseMinor: string; valuedBy?: string }[];
        }>(sql`
          SELECT net_worth_minor::text, accounts_unvalued, breakdown
            FROM net_worth_daily
           WHERE user_id = ${aliceId}::uuid AND as_of_date = ${sealedDay}::date
        `)
      ).rows[0];
      const entry = row?.breakdown.find((candidate) => candidate.accountId === rollover);
      expect(entry).toMatchObject({ baseMinor: '25000000', valuedBy: 'balance_override' });
      expect(row?.breakdown.some((candidate) => candidate.accountId === typedBrokerage)).toBe(
        false,
      );
      expect(row?.accounts_unvalued).toBe(1);
      // 250,000 + 3,000 checking - 400 card; the $100,000 brokerage is not in it and is not a zero.
      expect(row?.net_worth_minor).toBe(String(25_000_000 + 300_000 - 40_000));

      // Holdings win once the holder takes the basis back: the rollover is unvalued, named, not zero.
      expectStatus(await put(alice, rollover, { role: 'tax_deferred' }), 200);
      const after = (await (
        await h.request({ method: 'GET', url: '/accounts/valuation', session: alice })
      ).json()) as { unvalued: { accountId: string }[]; byBalance: unknown[] };
      expect(after.byBalance).toEqual([]);
      expect(after.unvalued.map((entry2) => entry2.accountId).sort()).toEqual(
        [rollover, typedBrokerage].sort(),
      );
      // Put it back for the staleness test below.
      expectStatus(await put(alice, rollover, { valuation: 'balance', role: 'tax_deferred' }), 200);
    });

    it('after a tax-treatment change the stored baseline reads stale and names why', async () => {
      const first = await project();
      expectStatus(first, 200);
      const firstBody = first.json() as OutcomeWire;
      expect(['computed', 'cached']).toContain(firstBody.status);
      const firstRunId = firstBody.run?.id as string;

      const fresh = await h.request({
        method: 'GET',
        url: `/plan/projections/${firstRunId}`,
        session: alice,
      });
      expect((fresh.json() as OutcomeWire).staleness).toBeNull();

      // The holder says the rollover is a Roth. (PUT replaces: the valuation and role are restated.)
      expectStatus(
        await put(alice, rollover, {
          taxTreatment: 'ROTH',
          valuation: 'balance',
          role: 'tax_deferred',
        }),
        200,
      );

      const stale = await h.request({
        method: 'GET',
        url: `/plan/projections/${firstRunId}`,
        session: alice,
      });
      expectStatus(stale, 200);
      const staleBody = stale.json() as OutcomeWire;
      expect(staleBody.status).toBe('stale');
      expect(staleBody.staleness).toEqual({
        reason: 'account_overrides_changed',
        changes: [{ accountId: rollover, field: 'taxTreatment', from: null, to: 'ROTH' }],
      });
      expect(staleBody.run?.id).toBe(firstRunId); // exactly as stored

      // Asking for the plan again does not recompute behind the holder's back.
      const asked = await project();
      expectStatus(asked, 200);
      const askedBody = asked.json() as OutcomeWire;
      expect(askedBody.status).toBe('stale');
      expect(askedBody.run?.id).toBe(firstRunId);
      const runs = await h.database.db.execute<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM projection_runs WHERE user_id = ${aliceId}::uuid`,
      );
      expect(runs.rows[0]?.n).toBe('1');

      // Only an explicit ask computes — and the new run is fresh, from the new treatment.
      const accepted = await project({ acceptAccountChanges: true });
      expectStatus(accepted, 200);
      const acceptedBody = accepted.json() as OutcomeWire;
      expect(acceptedBody.status).toBe('computed');
      expect(acceptedBody.run?.id).not.toBe(firstRunId);
      const read = await h.request({
        method: 'GET',
        url: `/plan/projections/${acceptedBody.run?.id}`,
        session: alice,
      });
      expect((read.json() as OutcomeWire).staleness).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // The route rules
  // -------------------------------------------------------------------------

  it('a session is required for PUT, DELETE and GET /accounts/valuation, and no step-up is', async () => {
    // A mutating request carries a bogus-but-well-formed session on purpose: the root
    // CSRF hook answers an anonymous PUT/DELETE with its own 403 before any handler
    // runs (`rules-routes.test.ts` makes the same point), and this claim is the
    // route's own guard.
    const bogus: TestSession = {
      accessToken: 'not-a-real-session-token',
      csrf: 'x'.repeat(40),
      fresh: false,
    };
    expectStatus(await put(bogus, checking, { role: 'spending' }), 401);
    expectStatus(await del(bogus, checking), 401);
    expectStatus(await h.request({ method: 'GET', url: '/accounts/valuation' }), 401);
    expectStatus(
      await h.request({ method: 'GET', url: '/accounts/valuation', session: bogus }),
      401,
    );
    // `h.stale` carries no step-up assertion; none of the three asks for one.
    expectStatus(await put(alice, checking, { role: 'spending' }), 200);
    expectStatus(await del(alice, checking), 200);
  });

  it("a second holder's account 404s, never 403-with-existence, and nothing is written or announced", async () => {
    const before = await overrideRows();
    const eventsBefore = await h.database.db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM domain_events WHERE event_type = 'ledger.AccountOverrideChanged'`,
    );

    const theirs = await put(bob, rollover, { taxTreatment: 'HSA' });
    expectStatus(theirs, 404);
    const nothing = await put(bob, '01920000-0000-7000-8000-00000000dead', { taxTreatment: 'HSA' });
    expectStatus(nothing, 404);
    // The same answer for "belongs to someone else" and "does not exist".
    expect(problemOf(theirs)['code']).toBe('ledger.account_not_found');
    expect(problemOf(theirs)['code']).toBe(problemOf(nothing)['code']);
    expect(problemOf(theirs)['title']).toBe(problemOf(nothing)['title']);

    const clearTheirs = await del(bob, rollover);
    expectStatus(clearTheirs, 404);
    expect(problemOf(clearTheirs)['code']).toBe('ledger.account_not_found');

    expect(await overrideRows()).toEqual(before);
    const eventsAfter = await h.database.db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM domain_events WHERE event_type = 'ledger.AccountOverrideChanged'`,
    );
    expect(eventsAfter.rows).toEqual(eventsBefore.rows);

    // Bob sees only his own accounts and only his own overlay; his valuation list is his.
    expect((await accountsOf(bob)).map((account) => account.id)).toEqual([bobs401k]);
    const bobsValuation = (await (
      await h.request({ method: 'GET', url: '/accounts/valuation', session: bob })
    ).json()) as { unvalued: { accountId: string }[]; byBalance: unknown[] };
    expect(bobsValuation.byBalance).toEqual([]);
    expect(bobsValuation.unvalued.map((entry) => entry.accountId)).toEqual([bobs401k]);

    // And Bob's own override lands on Bob's account only.
    expectStatus(await put(bob, bobs401k, { taxTreatment: 'ROTH' }), 200);
    expect((await overlayOf(alice, rollover)).taxTreatment.override).not.toBe('HSA');
    expect(
      (await overrideRows()).filter((row) => row.user_id === bobId).map((row) => row.account_id),
    ).toEqual([bobs401k]);
    expectStatus(await del(bob, bobs401k), 200);
  });

  it('an override an account cannot take is a 422 by name; a body outside the closed lists is a 400', async () => {
    const liability = await put(alice, card, { taxTreatment: 'ROTH' });
    expectStatus(liability, 422);
    expect(problemOf(liability)['code']).toBe('ledger.override_not_applicable');
    const cash = await put(alice, checking, { valuation: 'balance' });
    expectStatus(cash, 422);
    expect(problemOf(cash)['code']).toBe('ledger.override_not_applicable');
    expectStatus(await put(alice, rollover, { taxTreatment: 'PENSION' }), 400);
    expectStatus(await put(alice, rollover, { role: 'whatever' }), 400);
    expectStatus(await put(alice, rollover, { valuation: 'guess' }), 400);
  });

  it('every change is announced as ledger.AccountOverrideChanged — the account and the field names, never the values', async () => {
    const events = await h.database.db.execute<{ payload: Record<string, unknown> }>(
      sql`SELECT payload FROM domain_events WHERE event_type = 'ledger.AccountOverrideChanged' ORDER BY seq`,
    );
    expect(events.rows.length).toBeGreaterThan(0);
    for (const event of events.rows) {
      expect(Object.keys(event.payload).sort()).toEqual(['accountId', 'changedFields', 'cleared']);
    }
    expect(JSON.stringify(events.rows)).not.toContain('ROTH');
  });
});
