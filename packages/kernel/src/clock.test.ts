// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { fixedClock, mutableClock, systemClock, todayIn } from './clock.ts';
import { InvalidValueError } from './errors.ts';

describe('Clock', () => {
  it('freezes time so a time-dependent test cannot be flaky', () => {
    const clock = fixedClock('2026-03-01T04:30:00.000Z');
    expect(clock.now().toISOString()).toBe('2026-03-01T04:30:00.000Z');
    expect(clock.nowMs()).toBe(clock.nowMs());
  });

  it('winds forward for scheduler and rollover scenarios', () => {
    const clock = mutableClock('2026-01-31T12:00:00.000Z');
    clock.advanceMs(24 * 60 * 60 * 1000);
    expect(clock.now().toISOString()).toBe('2026-02-01T12:00:00.000Z');
    clock.setTo('2026-12-25T00:00:00.000Z');
    expect(clock.now().toISOString()).toBe('2026-12-25T00:00:00.000Z');
  });

  it('rejects an unreadable instant instead of producing an Invalid Date', () => {
    expect(() => fixedClock('not a date')).toThrow(InvalidValueError);
  });

  it('resolves "today" in the user zone, not the container zone', () => {
    // 04:30 UTC on March 1st is still February 28th in New York. Getting this
    // wrong moves a transaction between budget months.
    const clock = fixedClock('2026-03-01T04:30:00.000Z');
    expect(todayIn(clock, 'UTC')).toBe('2026-03-01');
    expect(todayIn(clock, 'America/New_York')).toBe('2026-02-28');
    expect(todayIn(clock, 'Asia/Tokyo')).toBe('2026-03-01');
  });

  it('handles a zone east of the date line', () => {
    const clock = fixedClock('2026-06-30T13:00:00.000Z');
    expect(todayIn(clock, 'Pacific/Auckland')).toBe('2026-07-01');
    expect(todayIn(clock, 'America/Los_Angeles')).toBe('2026-06-30');
  });

  it('rejects an unknown zone rather than silently using UTC', () => {
    const clock = fixedClock('2026-03-01T04:30:00.000Z');
    expect(() => todayIn(clock, 'Mars/Olympus_Mons')).toThrow(InvalidValueError);
  });

  it('advances in real time', () => {
    expect(systemClock.nowMs()).toBeGreaterThan(Date.parse('2026-01-01T00:00:00Z'));
  });
});
