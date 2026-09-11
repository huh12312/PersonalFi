// SPDX-License-Identifier: MIT
import { dateOnly, type DateOnly } from './date-only.ts';
import { InvalidValueError } from './errors.ts';

/**
 * The only sanctioned source of "now".
 *
 * `new Date()` and `Date.now()` are lint-banned outside this file. Time-dependent
 * bugs are the dominant bug class in budgeting and recurring detection, and an
 * injected clock is what makes those tests deterministic instead of flaky.
 */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  nowMs(): number;
  /** The current instant. Always UTC on the wire; never used for calendar maths. */
  now(): Date;
}

const realNow = (): number => Date.now();

export const systemClock: Clock = Object.freeze({
  nowMs: realNow,
  now: () => new Date(realNow()),
});

/** A clock frozen at one instant. */
export function fixedClock(instant: Date | string | number): Clock {
  const ms = typeof instant === 'number' ? instant : new Date(instant).getTime();
  if (!Number.isFinite(ms)) {
    throw new InvalidValueError('instant', `cannot read a time from ${JSON.stringify(instant)}`);
  }
  return Object.freeze({ nowMs: () => ms, now: () => new Date(ms) });
}

export interface MutableClock extends Clock {
  /** Move the clock forward (or back, with a negative value). */
  advanceMs(deltaMs: number): void;
  setTo(instant: Date | string | number): void;
}

/** A clock tests can wind forward, for scheduler and rollover scenarios. */
export function mutableClock(start: Date | string | number): MutableClock {
  let ms = fixedClock(start).nowMs();
  return {
    nowMs: () => ms,
    now: () => new Date(ms),
    advanceMs: (deltaMs: number) => {
      ms += deltaMs;
    },
    setTo: (instant) => {
      ms = fixedClock(instant).nowMs();
    },
  };
}

const partFormatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = partFormatters.get(timeZone);
  if (cached !== undefined) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    throw new InvalidValueError('time zone', `unknown IANA zone ${JSON.stringify(timeZone)}`);
  }
  partFormatters.set(timeZone, formatter);
  return formatter;
}

/**
 * The calendar date it is *right now* in a given IANA zone.
 *
 * Every period boundary in the app — budget months, "today", digest windows, the
 * daily snapshot seal — is computed from the user's zone, never the container's
 * `TZ` and never the browser's.
 */
export function todayIn(clock: Clock, timeZone: string): DateOnly {
  const parts = formatterFor(timeZone).formatToParts(clock.now());
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    if (part === undefined)
      throw new InvalidValueError('time zone', `no ${type} part for ${timeZone}`);
    return Number(part.value);
  };
  return dateOnly(get('year'), get('month'), get('day'));
}
