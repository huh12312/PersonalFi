// SPDX-License-Identifier: MIT
/**
 * The dismissal ladder: 30 days, then 90, then never again.
 *
 * 02-phase-2-dispatch.md §6 question 4's default, and it is a default about
 * trust rather than about notification volume. An insight the user has already
 * refused, re-offered next Tuesday, is the app arguing with them; the second
 * refusal earns a quarter's silence and the third is taken as an answer.
 *
 * ## Why the ladder is counted per `(advisor_id, key)` and not per row
 *
 * An insight's identity is `(advisor_id, key, period)`. The *period* moves —
 * "dining is over budget" in September is a different row from October's — so a
 * cooldown keyed on the full triple would expire the moment the month did, and
 * a user who dismissed the finding three months running would be asked a fourth
 * time on the first of the month. The ladder therefore drops `period` and
 * counts refusals of the *finding*, which is the thing the user actually said
 * no to.
 *
 * ## Permanent means permanent, and is still reversible by the user
 *
 * The third rung has no expiry. It is not "a very long cooldown": there is no
 * date to wait for, so no clock change, no timezone bug and no backfill can
 * resurrect it. What *can* is the user clearing it — the row stays, with its
 * count, so "you told me to stop showing this on the 4th" is answerable and
 * undoable. A suppression that could not be undone would be the app arguing in
 * the other direction.
 *
 * ## Snooze is a separate axis
 *
 * A snooze is "not now", a dismissal is "not this". They share a column
 * (`suppressed_until`) because the query is the same — *is this finding
 * silenced right now?* — and they do not share a counter, because snoozing
 * three times is not the same statement as refusing three times. `kind`
 * distinguishes them on the row and only `dismiss` advances the ladder.
 */

/** Days of silence after the first and second dismissal. The third is forever. */
export const COOLDOWN_LADDER_DAYS: readonly number[] = Object.freeze([30, 90]);

/** After this many dismissals of the same finding, it is never offered again. */
export const PERMANENT_AFTER_DISMISSALS = COOLDOWN_LADDER_DAYS.length + 1;

export interface CooldownRung {
  /** Days of silence, or `null` when the rung is permanent. */
  readonly days: number | null;
  readonly permanent: boolean;
}

/**
 * The rung a given number of dismissals lands on.
 *
 * `0` is "never dismissed" and is not a rung: it returns zero days and no
 * suppression, so a caller does not have to special-case the first offer.
 */
export function rungFor(dismissCount: number): CooldownRung {
  const count = Math.max(0, Math.trunc(dismissCount));
  if (count === 0) return { days: 0, permanent: false };
  if (count >= PERMANENT_AFTER_DISMISSALS) return { days: null, permanent: true };
  // `count` is 1 or 2 here, and the ladder is 0-indexed.
  return { days: COOLDOWN_LADDER_DAYS[count - 1] ?? null, permanent: false };
}

export interface SuppressionState {
  readonly dismissCount: number;
  readonly suppressedUntil: Date | null;
  readonly permanent: boolean;
}

/**
 * The state after one more dismissal, computed from the state before it.
 *
 * A pure function of `(previous, now)` so that replaying the same dismissal
 * twice — a retry, a pump redelivery — produces the same row rather than
 * advancing the ladder twice. The caller's `ON CONFLICT` supplies the
 * at-most-once half; this supplies the determinism.
 */
export function afterDismissal(previous: SuppressionState | null, now: Date): SuppressionState {
  const dismissCount = (previous?.dismissCount ?? 0) + 1;
  const rung = rungFor(dismissCount);
  if (rung.permanent) return { dismissCount, suppressedUntil: null, permanent: true };
  const until = new Date(now.getTime() + (rung.days ?? 0) * 24 * 60 * 60 * 1000);
  return { dismissCount, suppressedUntil: until, permanent: false };
}

/** A snooze: a date the user chose, and the ladder does not move. */
export function afterSnooze(previous: SuppressionState | null, until: Date): SuppressionState {
  return {
    dismissCount: previous?.dismissCount ?? 0,
    suppressedUntil: until,
    permanent: previous?.permanent ?? false,
  };
}

/** Is this finding silenced at `now`? The one question the feed asks. */
export function isSuppressed(state: SuppressionState | null, now: Date): boolean {
  if (state === null) return false;
  if (state.permanent) return true;
  return state.suppressedUntil !== null && state.suppressedUntil.getTime() > now.getTime();
}

/**
 * The cooldown key: the finding, without the period.
 *
 * A function rather than a template literal at four call sites, because the two
 * halves are user-controlled strings and `advisor_id` may contain the `:` that
 * would otherwise let `a:b` + `c` and `a` + `b:c` collide. The schema's regexes
 * already forbid `|` in both, so it is the separator that cannot be smuggled.
 */
export function cooldownKey(advisorId: string, insightKey: string): string {
  return `${advisorId}|${insightKey}`;
}
