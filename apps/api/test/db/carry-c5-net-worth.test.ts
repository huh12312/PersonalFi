// SPDX-License-Identifier: MIT
/**
 * WP 5.13b, carrying Phase 4 gate condition C-5 (G4-5,
 * `docs/evidence/phase-4/gate-security-review.md` §2.5, row `P3-C8r`/`P3-C9r`/`P3-C9s`).
 *
 * G4-5's finding: three route-level controls in `apps/api/src/routes/investments.ts`
 * and `apps/api/src/routes/net-worth.ts` are each correct *and untested* —
 * sabotaging them left every suite in the tree green:
 *
 *   - `P3-C8r` — `readUnresolvedSecurities`'s own `WHERE user_id = …` dropped:
 *     **green**, because "no api-db test references `unresolved` at all."
 *   - `P3-C9r` — `readLastSnapshotFxFailure`'s `AND user_id = $2` weakened to
 *     `AND $2::uuid IS NOT NULL`: **green**, "no test references
 *     `lastSnapshotFailure`."
 *   - `P3-C9s` — `POST /net-worth/fx-rates`'s `requireFreshSession` swapped for
 *     `requireSession`: **green**, "no test calls the route."
 *
 * This file closes all three gaps with route-level tests. `apps/api/src/routes/**`
 * is outside this work package's ownership (`docs/plan/05-phase-5-dispatch.md`'s
 * WP 5.13 entry withholds it explicitly, alongside `modules.ts`/`app.ts`/
 * `platform.ts`), so — unlike C-3's and C-4's predicates, which live in
 * `@ctx/planning` and `domain.ts` and could be sabotaged and restored in place —
 * **the verify-first sabotage the condition asks for could not be performed
 * against the route files themselves** without touching a file this WP may
 * not edit, even temporarily. See this suite's own test bodies below for the
 * exact line each test would catch, and
 * `docs/evidence/phase-5/wp5.13-carry-overs.md` §4.3's "Needs the
 * orchestrator" for the three-line diffs a route-owning session could apply
 * and revert in under a minute to complete the red/green cycle formally.
 *
 * Each test is written to fail specifically and only on the control it names —
 * not merely "something about the response changed" — so that tracing the
 * assertion back to the one line in the route file it depends on is a
 * five-second read, which is the next best thing to an executed sabotage.
 */
import { newId, systemClock } from '@core/kernel';
import { appendEvent, platformExecutor } from '@core/platform';
import { SecurityResolutionFailed } from '@ctx/investments';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  NO_DATABASE,
  createApiHarness,
  expectStatus,
  problemOf,
  type ApiHarness,
} from '../helpers/api-harness.ts';

const DAY_MS = 86_400_000;

/**
 * A real `investments.SecurityResolutionFailed`, appended by the production
 * writer (`appendEvent` over the context's own `defineEvent`; G9-15, C9-9). The
 * hand-written row this replaces was "shaped exactly like" one but lacked the
 * `syncRunId` key the event's schema requires and named an abstain reason
 * (`no_match`) that is not one of `ABSTAIN_REASONS`, so no writer could have stored it.
 */
async function insertUnresolvedEvent(
  h: ApiHarness,
  input: { readonly userId: string; readonly provider: string; readonly name: string },
): Promise<void> {
  await appendEvent(
    platformExecutor(h.database.db),
    SecurityResolutionFailed.create(
      {
        provider: input.provider,
        syncRunId: null,
        providerSecurityId: null,
        name: input.name,
        identifiers: [],
        abstentions: [{ tier: 'ticker', reason: 'absent', detail: null }],
      },
      { userId: input.userId, aggregateId: null, correlationId: newId(), causationId: null },
      systemClock,
    ),
  );
}

describe.skipIf(NO_DATABASE)(
  "WP 5.13b carry C-5 (G4-5) — unresolved securities and lastSnapshotFailure are the caller's own",
  () => {
    let h: ApiHarness;

    beforeAll(async () => {
      h = await createApiHarness({ suite: 'wp513b-c5' });
    }, 120_000);

    afterAll(async () => {
      await h.close();
    });

    it(
      "GET /holdings' unresolved list names the caller's own unresolved securities, never another holder's — " +
        'readUnresolvedSecurities (routes/investments.ts) reads `domain_events WHERE user_id = …`',
      async () => {
        const otherUserId = await h.database.createUser('Bob (unresolved)');
        const theirs = await h.issueSession({ userId: otherUserId, fresh: true });

        // Bob's failure, planted first, with a name distinctive enough that
        // finding it in Alice's response could not be a coincidence.
        await insertUnresolvedEvent(h, {
          userId: otherUserId,
          provider: 'plaid',
          name: 'BOBS-ONLY-UNRESOLVED-SECURITY',
        });
        // The caller's own failure, a different name.
        await insertUnresolvedEvent(h, {
          userId: h.userId,
          provider: 'plaid',
          name: 'ALICES-OWN-UNRESOLVED-SECURITY',
        });

        const mine = await h.request({ method: 'GET', url: '/holdings', session: h.stale });
        expectStatus(mine, 200);
        const body = mine.json() as { unresolved: readonly { name: string | null }[] };
        const names = body.unresolved.map((row) => row.name);
        expect(names, "the caller's own failure is present").toContain(
          'ALICES-OWN-UNRESOLVED-SECURITY',
        );
        expect(
          names,
          // If `readUnresolvedSecurities`'s `WHERE user_id = ${userId}::uuid`
          // (routes/investments.ts, ~line 336) were dropped, this is exactly
          // what would appear — the whole point of the predicate.
          "never another holder's — dropping the WHERE user_id predicate would surface this",
        ).not.toContain('BOBS-ONLY-UNRESOLVED-SECURITY');

        // And the reverse: Bob's own read shows only his.
        const theirsResponse = await h.request({
          method: 'GET',
          url: '/holdings',
          session: theirs,
        });
        expectStatus(theirsResponse, 200);
        const theirBody = theirsResponse.json() as {
          unresolved: readonly { name: string | null }[];
        };
        const theirNames = theirBody.unresolved.map((row) => row.name);
        expect(theirNames).toContain('BOBS-ONLY-UNRESOLVED-SECURITY');
        expect(theirNames).not.toContain('ALICES-OWN-UNRESOLVED-SECURITY');
      },
    );

    it(
      "GET /net-worth/series' lastSnapshotFailure is the caller's own most recent snapshot failure, never another holder's — " +
        'readLastSnapshotFxFailure (routes/net-worth.ts) reads `jobs WHERE kind = … AND user_id = $2`',
      async () => {
        const otherUserId = await h.database.createUser('Bob (fx failure)');
        const theirs = await h.issueSession({ userId: otherUserId, fresh: true });

        const fxJobRow = (userId: string, message: string, ageMs: number) =>
          // fixture: jobs row written by SQL because the failure state is the runner's UPDATE (status 'failed', last_error = serializeError(cause)) after a real handler throws, and driving a scheduled snapshot to an FX failure is not what this test is about; the runner could leave it as a failed planning.net_worth_snapshot job whose last_error carries the thrown error's name and message (a subset of what serializeError stores), as here.
          h.database.db.execute(sql`
            INSERT INTO jobs (
              id, user_id, kind, payload, status, last_error, correlation_id, created_at, updated_at
            ) VALUES (
              ${newId()}::uuid, ${userId}::uuid, 'planning.net_worth_snapshot', '{}'::jsonb,
              'failed',
              ${JSON.stringify({ name: 'FxRateUnavailable', message })}::jsonb,
              ${newId()}::uuid,
              now() - ${ageMs} * interval '1 millisecond',
              now() - ${ageMs} * interval '1 millisecond'
            )
          `);

        // Bob's failure is the *newer* row — if the reader answered "the
        // newest row over anyone" rather than "the caller's own newest row",
        // Alice's read below would show Bob's message instead of her own or
        // instead of nothing.
        await fxJobRow(otherUserId, 'BOBS-OWN-FX-FAILURE-MESSAGE-CAD-USD', 1_000);
        await fxJobRow(h.userId, 'ALICES-OWN-FX-FAILURE-MESSAGE-EUR-USD', 10 * DAY_MS);

        const mine = await h.request({
          method: 'GET',
          url: '/net-worth/series',
          session: h.stale,
        });
        expectStatus(mine, 200);
        const body = mine.json() as { lastSnapshotFailure: { message: string } | null };
        expect(
          body.lastSnapshotFailure?.message,
          // If `readLastSnapshotFxFailure`'s `AND user_id = $2` (routes/net-worth.ts,
          // ~line 158) were weakened to merely require `$2` to be non-null,
          // this is exactly what Alice's read would show instead — Bob's row,
          // because it is newer.
          "the caller's own failure, never another holder's newer one",
        ).toBe('ALICES-OWN-FX-FAILURE-MESSAGE-EUR-USD');

        const theirsResponse = await h.request({
          method: 'GET',
          url: '/net-worth/series',
          session: theirs,
        });
        expectStatus(theirsResponse, 200);
        const theirBody = theirsResponse.json() as {
          lastSnapshotFailure: { message: string } | null;
        };
        expect(theirBody.lastSnapshotFailure?.message).toBe('BOBS-OWN-FX-FAILURE-MESSAGE-CAD-USD');
      },
    );

    it(
      'POST /net-worth/fx-rates refuses a stale session (D21 step-up) — ' +
        "the handler's own `guards.requireFreshSession(request)` (routes/net-worth.ts, ~line 376)",
      async () => {
        const stale = await h.request({
          method: 'POST',
          url: '/net-worth/fx-rates',
          session: h.stale,
          body: { base: 'CAD', quote: 'USD', rateDate: '2026-06-01', rate: '1.35' },
        });
        // If `requireFreshSession` here were weakened to `requireSession` (the
        // exact P3-C9s sabotage the gate ran), this would read 200 instead —
        // the manual FX-rate entry route would accept a stale session, the one
        // shape D21 exists to refuse for every route that writes a fact the
        // next automated retry immediately trusts.
        expect(stale.statusCode, 'a stale session must never reach the write below').toBe(403);
        expect(problemOf(stale)['code']).toBe('step_up_required');

        // The fresh-session control case: the same request succeeds, so the
        // 403 above is genuinely about staleness and not about a malformed
        // body or a route that always refuses.
        const fresh = await h.request({
          method: 'POST',
          url: '/net-worth/fx-rates',
          session: h.fresh,
          body: { base: 'CAD', quote: 'USD', rateDate: '2026-06-01', rate: '1.35' },
        });
        expectStatus(fresh, 200);
      },
    );
  },
);
