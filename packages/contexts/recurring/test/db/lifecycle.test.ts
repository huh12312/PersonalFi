// SPDX-License-Identifier: MIT
/**
 * The two claims that make the candidate pipeline worth having.
 *
 * 04 §5.1 and the Phase 2 dispatch both say the same thing in different words:
 * a false "you have a subscription" destroys trust faster than a missed one, so
 * detection proposes and a human decides — and once the human has decided, the
 * detector does not get another vote. That is two properties, and they fail in
 * opposite directions:
 *
 *   * **the pin** — a series the user confirmed must survive a pass that would
 *     otherwise have withdrawn it. The failure mode is an app that forgets a
 *     subscription because the merchant skipped a month.
 *   * **the veto** — a merchant the user rejected must never be proposed again,
 *     no matter how obviously recurring it looks. The failure mode is an app
 *     that asks the same question every week, which is the same as an app that
 *     cannot be told anything.
 *
 * Both are asserted against a real Postgres because both are ultimately about
 * rows surviving a write: `recurring_series_confirmed_not_archived` and
 * `recurring_candidates_override_on_reject` are CHECK constraints, and a fake
 * would only assert that the fake has them.
 */
import { DateOnly } from '@core/kernel';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recurringCandidates, recurringSeries } from '../../schema/index.ts';
import { listCandidates } from '../../src/read.ts';
import { confirmSeries, rejectCandidate, rejectSeries, runDetection } from '../../src/service.ts';
import {
  EPOCH,
  NO_DATABASE,
  ZONE,
  clockAt,
  contextFor,
  countRows,
  inMemoryLedgerPort,
  monthlyRows,
  recurringDatabase,
  type TestDatabase,
} from './harness.ts';

const ACCOUNT = '01920000-0000-7000-8000-00000000a001';
const MERCHANT_PINNED = '01920000-0000-7000-8000-00000000b001';
const MERCHANT_CONTROL = '01920000-0000-7000-8000-00000000b002';
const MERCHANT_REJECTED = '01920000-0000-7000-8000-00000000b003';
const MERCHANT_INNOCENT = '01920000-0000-7000-8000-00000000b004';

/** The last occurrence lands the day before "today", so nothing is overdue. */
const LAST_ON = DateOnly.parse('2026-06-14');

describe.skipIf(NO_DATABASE)('the recurring lifecycle', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await recurringDatabase('lifecycle');
  }, 180_000);

  afterAll(async () => {
    await database.drop();
  });

  it('a confirmed series survives a re-run that would have rejected it', async () => {
    await database.truncate();
    const context = contextFor(database.userId, clockAt(EPOCH));

    // Six flawless monthly charges at each of two merchants. Both clear the
    // 0.80 auto-confirm bar (src/confidence.test.ts pins the band), so the only
    // difference between them at the end of this test is the user's decision.
    const rows = [
      ...monthlyRows({
        merchantId: MERCHANT_PINNED,
        accountId: ACCOUNT,
        lastOn: LAST_ON,
        count: 6,
        minor: -1_599n,
      }),
      ...monthlyRows({
        merchantId: MERCHANT_CONTROL,
        accountId: ACCOUNT,
        lastOn: LAST_ON,
        count: 6,
        minor: -2_499n,
      }),
    ];

    const first = await runDetection(
      database.db,
      context,
      { port: inMemoryLedgerPort(rows) },
      { timeZone: ZONE },
    );
    expect(first.seriesInserted, 'both streams should be detected').toBe(2);

    const detected = await database.db
      .select()
      .from(recurringSeries)
      .where(eq(recurringSeries.userId, database.userId));
    const pinned = detected.find((row) => row.merchantId === MERCHANT_PINNED);
    const control = detected.find((row) => row.merchantId === MERCHANT_CONTROL);
    expect(pinned).toBeDefined();
    expect(control).toBeDefined();
    if (pinned === undefined || control === undefined) return;
    expect(pinned.userConfirmed, 'the detector never sets the pin itself').toBe(false);

    // The human decides.
    const confirmed = await confirmSeries(database.db, context, { seriesId: pinned.id });
    expect(confirmed?.userConfirmed).toBe(true);
    expect(confirmed?.state).toBe('ACTIVE');

    // Now a pass that would withdraw both: the ledger has nothing to say about
    // either merchant any more. This is the shape of every way a series gets
    // dropped — tombstoned rows, a merchant re-identified, a history window
    // that no longer reaches back far enough — reduced to its essence.
    const second = await runDetection(
      database.db,
      context,
      { port: inMemoryLedgerPort([]) },
      { timeZone: ZONE },
    );
    expect(second.streams, 'the detector proposes nothing this pass').toBe(0);

    const after = await database.db
      .select()
      .from(recurringSeries)
      .where(eq(recurringSeries.userId, database.userId));
    const pinnedAfter = after.find((row) => row.id === pinned.id);
    const controlAfter = after.find((row) => row.id === control.id);

    // The pin held.
    expect(pinnedAfter?.state, 'a confirmed series is never archived').toBe('ACTIVE');
    expect(pinnedAfter?.userConfirmed).toBe(true);
    expect(pinnedAfter?.archivedAt).toBeNull();
    expect(pinnedAfter?.confirmedAt).not.toBeNull();

    // …and the control proves the sweep that would have archived it really ran,
    // so the assertion above is about the pin and not about a pass that did
    // nothing at all.
    expect(controlAfter?.state, 'an unconfirmed series is withdrawn').toBe('ARCHIVED');
    expect(controlAfter?.archivedAt).not.toBeNull();
    expect(second.seriesArchived).toBe(1);
  });

  it('a rejected merchant never returns as a candidate', async () => {
    await database.truncate();
    const context = contextFor(database.userId, clockAt(EPOCH));

    // Two occurrences each: 07 §2.4 caps an n=2 stream at 0.70, which is inside
    // the [0.55, 0.80) candidate band, so both merchants ask a question rather
    // than auto-confirming.
    const rejectedRows = monthlyRows({
      merchantId: MERCHANT_REJECTED,
      accountId: ACCOUNT,
      lastOn: LAST_ON,
      count: 2,
      minor: -899n,
    });
    const innocentRows = monthlyRows({
      merchantId: MERCHANT_INNOCENT,
      accountId: ACCOUNT,
      lastOn: LAST_ON,
      count: 2,
      minor: -1_299n,
    });
    const port = inMemoryLedgerPort([...rejectedRows, ...innocentRows]);

    const first = await runDetection(database.db, context, { port }, { timeZone: ZONE });
    expect(first.candidatesProposed, 'both streams ask a question').toBe(2);

    const queue = await listCandidates(database.db, { userId: database.userId });
    const toReject = queue.find((entry) => entry.merchantId === MERCHANT_REJECTED);
    expect(toReject, 'the merchant we are about to reject was proposed').toBeDefined();
    if (toReject === undefined) return;

    // The user says no. Default scope is MERCHANT: "never this payee again".
    const rejection = await rejectCandidate(database.db, context, {
      candidateId: toReject.candidateId,
      reason: 'not a subscription',
    });
    expect(rejection?.scope).toBe('MERCHANT');

    // Re-run the *same* history, unscoped, twice — a nightly re-detect and a
    // user pressing "look again". Neither may resurrect the question.
    const second = await runDetection(database.db, context, { port }, { timeZone: ZONE });
    const third = await runDetection(database.db, context, { port }, { timeZone: ZONE });

    // The strongest form of the claim: the rejected merchant's transactions are
    // not merely filtered out of the answer, they never reach the engine. Only
    // the innocent merchant's two rows were read.
    expect(second.inputs, 'a rejected payee is filtered on the input side').toBe(
      innocentRows.length,
    );
    expect(third.inputs).toBe(innocentRows.length);
    expect(second.candidatesProposed, 'nothing new is proposed').toBe(0);
    expect(third.candidatesProposed).toBe(0);

    const queueAfter = await listCandidates(database.db, { userId: database.userId });
    expect(
      queueAfter.map((entry) => entry.merchantId),
      'only the merchant the user never ruled on is still asking',
    ).toEqual([MERCHANT_INNOCENT]);

    // The decision itself is intact and carries the override that enforces it.
    const decided = await database.db
      .select()
      .from(recurringCandidates)
      .where(
        and(
          eq(recurringCandidates.userId, database.userId),
          eq(recurringCandidates.merchantId, MERCHANT_REJECTED),
        ),
      );
    expect(decided).toHaveLength(1);
    expect(decided[0]?.state).toBe('REJECTED');
    expect(decided[0]?.override).toBe('NOT_RECURRING');
    expect(decided[0]?.overrideScope).toBe('MERCHANT');
    expect(decided[0]?.decidedReason).toBe('not a subscription');
    expect(decided[0]?.decidedAt).not.toBeNull();

    // And nothing renders it: the series row is archived, not resurrected.
    const series = await database.db
      .select()
      .from(recurringSeries)
      .where(
        and(
          eq(recurringSeries.userId, database.userId),
          eq(recurringSeries.merchantId, MERCHANT_REJECTED),
        ),
      );
    expect(series).toHaveLength(1);
    expect(series[0]?.state).toBe('ARCHIVED');

    // A scoped pass — what the consumer actually runs when a sync touches that
    // payee — declines to do any work at all.
    const scoped = await runDetection(
      database.db,
      context,
      { port },
      { timeZone: ZONE, merchantIds: [MERCHANT_REJECTED] },
    );
    expect(scoped.merchantsSkippedByOverride).toBe(1);
    expect(scoped.merchantsScoped).toBe(0);
    expect(scoped.inputs).toBe(0);

    // Total rows are unchanged by three re-runs: a rejection does not
    // accumulate history, it settles it.
    expect(await countRows(database, 'recurring_candidates')).toBe(2);
  });

  it('a rejection recorded against an auto-confirmed series is just as permanent', async () => {
    await database.truncate();
    const context = contextFor(database.userId, clockAt(EPOCH));

    // Six occurrences: above the auto-confirm bar, so this series was never
    // queued as a question and there is no candidate row to write the override
    // onto. `recordRejection` creates one, which is the only reason rejecting
    // something the user was never asked about works at all.
    const rows = monthlyRows({
      merchantId: MERCHANT_REJECTED,
      accountId: ACCOUNT,
      lastOn: LAST_ON,
      count: 6,
      minor: -1_099n,
    });
    const port = inMemoryLedgerPort(rows);

    const first = await runDetection(database.db, context, { port }, { timeZone: ZONE });
    expect(first.candidatesProposed, 'nothing to ask: it auto-confirmed').toBe(0);
    expect(first.autoConfirmed).toBe(1);

    const series = await database.db
      .select()
      .from(recurringSeries)
      .where(eq(recurringSeries.userId, database.userId));
    expect(series).toHaveLength(1);
    const target = series[0];
    if (target === undefined) return;
    expect(target.state).toBe('ACTIVE');

    const rejection = await rejectSeries(database.db, context, {
      seriesId: target.id,
      reason: 'this is my rent',
    });
    expect(rejection?.candidateId).toBeDefined();

    const second = await runDetection(database.db, context, { port }, { timeZone: ZONE });
    expect(second.inputs, 'the payee is gone from the input side').toBe(0);
    expect(second.streams).toBe(0);

    const after = await database.db
      .select()
      .from(recurringSeries)
      .where(eq(recurringSeries.userId, database.userId));
    expect(after[0]?.state).toBe('ARCHIVED');
    expect(after[0]?.userConfirmed, 'a rejection withdraws the pin').toBe(false);
    expect(await listCandidates(database.db, { userId: database.userId })).toHaveLength(0);
  });

  it('a stream-scoped rejection silences one plan and not the whole payee', async () => {
    await database.truncate();
    const context = contextFor(database.userId, clockAt(EPOCH));

    // One merchant, two genuinely different streams — 07 §2.12's
    // ANNUAL_TO_MONTHLY reality in miniature: two distinct amounts at one payee
    // land in two amount buckets and therefore two `stream_key`s.
    const cheap = monthlyRows({
      merchantId: MERCHANT_REJECTED,
      accountId: ACCOUNT,
      lastOn: LAST_ON,
      count: 2,
      minor: -499n,
    });
    const dear = monthlyRows({
      merchantId: MERCHANT_REJECTED,
      accountId: ACCOUNT,
      lastOn: DateOnly.addDays(LAST_ON, -3),
      count: 2,
      minor: -9_999n,
    });
    const port = inMemoryLedgerPort([...cheap, ...dear]);

    const first = await runDetection(database.db, context, { port }, { timeZone: ZONE });
    expect(first.candidatesProposed).toBeGreaterThanOrEqual(2);

    const queue = await listCandidates(database.db, { userId: database.userId });
    const target = queue.find((entry) => entry.amount.minor === -9_999n);
    expect(target).toBeDefined();
    if (target === undefined) return;

    await rejectCandidate(database.db, context, {
      candidateId: target.candidateId,
      scope: 'STREAM',
      reason: 'wrong plan',
    });

    const second = await runDetection(database.db, context, { port }, { timeZone: ZONE });
    // The payee is still read — a STREAM-scoped refusal is not a merchant ban —
    // but the refused stream is not written or re-proposed.
    expect(second.inputs, 'the merchant is still in scope').toBe(cheap.length + dear.length);

    const queueAfter = await listCandidates(database.db, { userId: database.userId });
    expect(queueAfter.map((entry) => entry.amount.minor)).toEqual([-499n]);
  });
});
