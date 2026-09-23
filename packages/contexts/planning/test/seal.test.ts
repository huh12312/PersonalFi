// SPDX-License-Identifier: MIT
/**
 * 08 §3.5's boundary, in the zone the user actually lives in.
 *
 * *"today's row is maintained incrementally and is mutable; at 02:00 local it is
 * sealed and never touched again."*
 *
 * The §5 exit criterion — `'a past date is byte-identical after a second
 * snapshot run'` — is a claim about Postgres (the BEFORE UPDATE trigger, the
 * partial unique index, the actual bytes of two rows) and lives in
 * `test/db/seal.test.ts`, in the `planning-db` project, which is what
 * `vitest.config.ts`'s own comment about this work package anticipates. This
 * file holds the half that needs no database: *when* a day has earned its seal.
 *
 * That half is worth testing on its own because it is where a timezone bug
 * would live, and a timezone bug here is not cosmetic. Sealing on a UTC day
 * boundary would seal the wrong calendar date for every user west of Greenwich
 * for part of every day, and the row it sealed would be one it should still
 * have been filling in.
 */
import { fixedClock } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import {
  SEAL_HOUR_LOCAL,
  SealedRowImmutable,
  assertSealable,
  isSealable,
  localHourIn,
  openDateIn,
  sealableDates,
} from '../src/seal.ts';

const NEW_YORK = 'America/New_York';

describe('the seal boundary', () => {
  it('seals a day once the local clock passes 02:00 on the day after it', () => {
    // 2026-06-15T05:30Z is 01:30 in New York on the 15th: the 14th has closed
    // as a calendar day but has not yet reached its 02:00, so it is still open.
    const before = fixedClock(new Date('2026-06-15T05:30:00Z'));
    expect(localHourIn(NEW_YORK, before.now())).toBe(1);
    expect(isSealable('2026-06-14', before, NEW_YORK)).toBe(false);

    // Half an hour later it is 02:00 local, and the 14th becomes history.
    const at = fixedClock(new Date('2026-06-15T06:00:00Z'));
    expect(localHourIn(NEW_YORK, at.now())).toBe(SEAL_HOUR_LOCAL);
    expect(isSealable('2026-06-14', at, NEW_YORK)).toBe(true);
  });

  it('never seals today, whatever the hour', () => {
    // The one day that may still move. At 23:59 local it is still today.
    const late = fixedClock(new Date('2026-06-16T03:59:00Z'));
    const today = openDateIn(late, NEW_YORK);
    expect(today).toBe('2026-06-15');
    expect(isSealable(today, late, NEW_YORK)).toBe(false);
    // And a future date is not sealable either; a projection is not a snapshot.
    expect(isSealable('2026-06-20', late, NEW_YORK)).toBe(false);
  });

  it('seals anything older than yesterday without consulting the hour', () => {
    // 00:30 local on the 15th. The 14th has not reached its 02:00 yet, but the
    // 13th passed its own 02:00 a full day ago and every day before it is
    // older still. A rule that checked only "is it before today?" would seal
    // the 14th too early; one that checked the hour for every day would leave
    // a backlog unsealed after downtime.
    const clock = fixedClock(new Date('2026-06-15T04:30:00Z'));
    expect(isSealable('2026-06-14', clock, NEW_YORK)).toBe(false);
    expect(isSealable('2026-06-13', clock, NEW_YORK)).toBe(true);
    expect(isSealable('2026-05-01', clock, NEW_YORK)).toBe(true);
  });

  it('holds the boundary across the fall-back hour, which happens twice', () => {
    // US DST ends 2026-11-01. 01:00–02:00 local occurs *twice* that morning:
    // 05:00Z is 01:00 EDT and 06:00Z is 01:00 EST again. Neither is 02:00, so
    // the 31st stays open through both — which is the correct answer and not an
    // obvious one, because a naive "an hour after 00:00 local" would fire in
    // the first pass and seal a day early.
    const firstOnePm = fixedClock(new Date('2026-11-01T05:00:00Z'));
    const repeatedOnePm = fixedClock(new Date('2026-11-01T06:00:00Z'));
    expect(localHourIn(NEW_YORK, firstOnePm.now())).toBe(1);
    expect(localHourIn(NEW_YORK, repeatedOnePm.now())).toBe(1);
    expect(isSealable('2026-10-31', firstOnePm, NEW_YORK)).toBe(false);
    expect(isSealable('2026-10-31', repeatedOnePm, NEW_YORK)).toBe(false);

    // 02:00 local arrives at 07:00Z — five hours after midnight rather than
    // the usual four — and the 31st seals then.
    const twoAm = fixedClock(new Date('2026-11-01T07:00:00Z'));
    expect(localHourIn(NEW_YORK, twoAm.now())).toBe(2);
    expect(isSealable('2026-10-31', twoAm, NEW_YORK)).toBe(true);
  });

  it('still seals on the spring-forward day, when 02:00 local never happens', () => {
    // US DST begins 2026-03-08: at 02:00 EST the clock jumps to 03:00 EDT, so
    // **there is no 02:00 local that day at all**. This is why `isSealable`
    // compares `>= SEAL_HOUR_LOCAL` rather than `=== SEAL_HOUR_LOCAL`: an
    // equality check would simply never fire on this date, and the 7th would
    // stay open until the following night — one unsealed day a year, arriving
    // as "the chart moved retroactively last March".
    const beforeJump = fixedClock(new Date('2026-03-08T06:00:00Z'));
    expect(localHourIn(NEW_YORK, beforeJump.now())).toBe(1);
    expect(isSealable('2026-03-07', beforeJump, NEW_YORK)).toBe(false);

    const afterJump = fixedClock(new Date('2026-03-08T07:00:00Z'));
    expect(localHourIn(NEW_YORK, afterJump.now())).toBe(3);
    expect(isSealable('2026-03-07', afterJump, NEW_YORK)).toBe(true);
  });

  it('disagrees with UTC, which is the entire point', () => {
    // 2026-06-15T05:00Z is the 15th in UTC and still 01:00 on the 15th in New
    // York. A seal computed in UTC would already be treating the 14th as
    // closed; in the user's zone it has an hour left.
    const clock = fixedClock(new Date('2026-06-15T05:00:00Z'));
    expect(openDateIn(clock, 'UTC')).toBe('2026-06-15');
    expect(openDateIn(clock, NEW_YORK)).toBe('2026-06-15');
    expect(isSealable('2026-06-14', clock, 'UTC')).toBe(true);
    expect(isSealable('2026-06-14', clock, NEW_YORK)).toBe(false);

    // And across the date line the open day itself differs.
    expect(openDateIn(fixedClock(new Date('2026-06-15T02:00:00Z')), NEW_YORK)).toBe('2026-06-14');
  });

  it('returns the sealable backlog oldest first', () => {
    // After two days of downtime there is more than one day to close, and the
    // order matters: `runSnapshot` seals oldest first so a failure part-way
    // leaves a contiguous sealed prefix rather than a hole.
    const clock = fixedClock(new Date('2026-06-15T06:00:00Z'));
    expect(
      sealableDates(['2026-06-14', '2026-06-12', '2026-06-15', '2026-06-13'], clock, NEW_YORK),
    ).toEqual(['2026-06-12', '2026-06-13', '2026-06-14']);
  });

  it('refuses a sealed row by name, with the day and revision in the message', () => {
    expect(() =>
      assertSealable({ asOfDate: '2026-06-14', revision: 1, sealedAt: null }),
    ).not.toThrow();

    const sealed = { asOfDate: '2026-06-14', revision: 2, sealedAt: new Date() };
    expect(() => assertSealable(sealed)).toThrow(SealedRowImmutable);
    try {
      assertSealable(sealed);
    } catch (error) {
      const refusal = error as SealedRowImmutable;
      expect(refusal.asOfDate).toBe('2026-06-14');
      expect(refusal.revision).toBe(2);
      // It says what to do instead, not just that it refused.
      expect(refusal.message).toContain('supersedes_id');
    }
  });
});
