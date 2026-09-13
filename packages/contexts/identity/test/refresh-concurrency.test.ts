// SPDX-License-Identifier: MIT
/**
 * **M-4: refresh rotation is atomic, so a race produces one winner and one
 * detection — never two live generations.**
 *
 * `sessions.ts` calls reuse detection "the single highest-value detection in the
 * system", and it is right: it is the one control that catches an attacker who
 * has already stolen a refresh cookie. The gate found that the control had a
 * hole precisely where such an attacker operates.
 *
 * The old `refresh()` was `SELECT`, then check `superseded_by IS NULL AND
 * revoked_at IS NULL` in TypeScript, then `INSERT` the new generation, then
 * `UPDATE` the old one — four round trips, no transaction, no conditional
 * update. Two concurrent presentations of the same token both passed the check
 * before either wrote. Result: two live generations in one family, two valid
 * access tokens, and *no* `session.reuse_detected` event. An attacker racing the
 * legitimate client evades the detection designed for exactly that attack.
 *
 * The fix makes the claim itself the atomic operation — one
 * `UPDATE ... WHERE refresh_token_hash = $1 AND superseded_by IS NULL AND
 * revoked_at IS NULL ... RETURNING` — so the database picks the winner.
 *
 * **Why this file needs a real Postgres and cannot be faked.** What is under test
 * is row-level locking and predicate re-evaluation against the committed row
 * version. A fake would assert that the fake serialises, which is the one thing
 * that was never in doubt. The pool is sized so the concurrent calls genuinely
 * occupy distinct backends rather than queueing on one connection — a
 * single-connection pool would serialise the race away and turn this file green
 * against the very code it exists to reject.
 *
 * **gate-security-review-2.md R-2.** Sabotaging `refresh()` back to the
 * pre-M-4 select-then-update shape used to fail only the 8-racer test —
 * every other race here still passed, for the wrong reason: with a lazily-
 * created `max: 6` pool, the *first* race a test file ran only had as many
 * backends as `pg` had gotten around to opening, so a 2-way race was
 * effectively serialised and racer B always observed an already-superseded
 * row (the *correct* row shape either way) rather than genuinely racing the
 * claim. Fixed by (1) warming the pool to its full `max` in `beforeEach` so
 * every test — not just whichever happens to run first — starts with `max`
 * live backends, and (2) raising every race in this file to `RACERS`
 * concurrent callers instead of 2, since 2 concurrent callers against an
 * N-backend pool is not the wide-race guarantee the test names claim.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN_URL,
  createIdentityHarness,
  requestContext,
  type IdentityHarness,
} from './harness.ts';

const describeWithDb = ADMIN_URL === undefined ? describe.skip : describe;

/**
 * Concurrent presentations per race. Enough that a lost update would show,
 * and the pool below is warmed to exactly this many backends so `pg`'s lazy
 * backend creation cannot partially serialise the first race in the file.
 */
const RACERS = 8;

/**
 * `createIdentityHarness` DROPs this name before creating it (harness.ts).
 * A fixed name is fine when this suite runs alone, but this repo runs
 * multiple agents against the same dev Postgres concurrently — a second
 * concurrent run of this file (or a stale one) would DROP the first run's
 * database out from under it mid-race. Unique per process and per file load.
 */
const SCRATCH_DB = `personalfi_gateb_${process.pid}_${randomBytes(4).toString('hex')}`;

describeWithDb('refresh rotation is atomic under concurrency (M-4)', () => {
  let harness: IdentityHarness;

  beforeAll(async () => {
    harness = await createIdentityHarness(SCRATCH_DB, { poolMax: RACERS });
  }, 120_000);

  afterAll(async () => {
    await harness.drop();
  }, 30_000);

  beforeEach(async () => {
    await harness.reset();
    // Warm the pool to its full `max` (R-2): without this, the first race
    // this describe block runs would only engage as many backends as `pg`
    // had lazily opened so far, understating the real parallelism and
    // letting a non-atomic `refresh()` pass by accident.
    await Promise.all(Array.from({ length: RACERS }, () => harness.db.query('SELECT 1')));
  });

  const sessions = () => harness.identity.sessions;

  const issue = () =>
    sessions().issue({
      userId: harness.userId,
      authMethod: 'webauthn',
      trustedDevice: false,
      fresh: false,
      context: requestContext(),
    });

  async function countEvents(kind: string): Promise<number> {
    const result = await harness.db.query(
      `SELECT count(*)::int AS n FROM security_events WHERE kind = $1`,
      [kind],
    );
    return Number(result.rows[0]?.['n'] ?? 0);
  }

  async function liveGenerations(familyId: string): Promise<number> {
    const result = await harness.db.query(
      `SELECT count(*)::int AS n FROM sessions
        WHERE family_id = $1 AND superseded_by IS NULL AND revoked_at IS NULL`,
      [familyId],
    );
    return Number(result.rows[0]?.['n'] ?? 0);
  }

  it('yields exactly one success when refreshes race the same token', async () => {
    const issued = await issue();

    // Promise.all, not sequential: every call is in flight before any
    // commits, which is the whole point. Sequentially this always passed.
    // RACERS calls, not 2 (R-2): with a warmed `max: RACERS` pool this is
    // the smallest race that cannot be won by accident of connection timing.
    const outcomes = await Promise.allSettled(
      Array.from({ length: RACERS }, () => sessions().refresh(issued.refreshToken, requestContext())),
    );

    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(RACERS - 1);
    for (const outcome of rejected) {
      expect(outcome.reason).toMatchObject({ code: 'session_reuse_detected' });
    }
  });

  it('records the reuse rather than silently issuing two generations', async () => {
    const issued = await issue();

    await Promise.allSettled(
      Array.from({ length: RACERS }, () => sessions().refresh(issued.refreshToken, requestContext())),
    );

    // Every loser is an independent presentation of the same stolen token, and
    // #rejectUnclaimableRefresh records one event per presentation — so RACERS
    // - 1 events, not 1 (that was an artifact of the old 2-racer version of
    // this test, which had exactly one loser). Under the pre-M-4 implementation
    // this was 0 regardless of racer count — the failure was entirely silent,
    // which is what made it worth a finding.
    expect(await countEvents('session.reuse_detected')).toBe(RACERS - 1);

    // And the family was burned down, so the winner's brand-new generation does
    // not survive either: a race is indistinguishable from theft, and the safe
    // reading is theft.
    expect(await liveGenerations(issued.session.familyId)).toBe(0);
  });

  it('survives a wider race: one winner, the rest detected', async () => {
    const issued = await issue();

    const outcomes = await Promise.allSettled(
      Array.from({ length: RACERS }, () =>
        sessions().refresh(issued.refreshToken, requestContext()),
      ),
    );

    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);

    // Every loser must be a *reuse* verdict, not an expiry: an attacker must not
    // be able to convert a detection into an ordinary 401 by adding parallelism.
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        expect(outcome.reason).toMatchObject({ code: 'session_reuse_detected' });
      }
    }
    expect(await liveGenerations(issued.session.familyId)).toBe(0);
  });

  it('never leaves two usable access tokens behind', async () => {
    // The bare consequence, stated without reference to events or columns: after
    // a race, at most one of the returned access tokens may authenticate.
    // RACERS calls, not 2 (R-2) — see the top-of-file comment.
    const issued = await issue();

    const outcomes = await Promise.allSettled(
      Array.from({ length: RACERS }, () => sessions().refresh(issued.refreshToken, requestContext())),
    );

    const tokens = outcomes.flatMap((outcome) =>
      outcome.status === 'fulfilled' ? [outcome.value.accessToken] : [],
    );
    const authenticated = await Promise.all(tokens.map((token) => sessions().authenticate(token)));

    expect(authenticated.filter((session) => session !== null)).toHaveLength(0);
  });

  it('still rotates cleanly when there is no race', async () => {
    // Non-vacuity for the whole file: a `refresh()` that always threw would pass
    // every assertion above.
    const issued = await issue();

    const rotated = await sessions().refresh(issued.refreshToken, requestContext());

    expect(rotated.session.familyId).toBe(issued.session.familyId);
    expect(rotated.session.id).not.toBe(issued.session.id);
    expect(await sessions().authenticate(rotated.accessToken)).not.toBeNull();
    expect(await countEvents('session.reuse_detected')).toBe(0);
    expect(await countEvents('session.refreshed')).toBe(1);
  });

  it('does not report an expired family as reuse', async () => {
    // Expiry is not theft. If a timed-out family produced
    // `session.reuse_detected`, the one alert worth waking up for would fire on
    // its own every fortnight and stop being read.
    const issued = await issue();
    harness.clock.advanceMs(400 * 24 * 60 * 60 * 1_000);

    await expect(sessions().refresh(issued.refreshToken, requestContext())).rejects.toMatchObject({
      code: 'session_expired',
    });
    expect(await countEvents('session.reuse_detected')).toBe(0);
  });
});
