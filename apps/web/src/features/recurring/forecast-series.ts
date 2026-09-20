// SPDX-License-Identifier: MIT
/**
 * Turns `GET /recurring/forecast`'s flat `charges[]` (each a signed,
 * banded `ProjectedCharge`) into the day-by-day cumulative series
 * `ForecastBandChart` plots. Pure and independently testable — the chart
 * component only has to draw the points this produces.
 *
 * A charge's `low`/`high` are magnitudes (07's amount band), not already
 * signed by direction, so "worst case" depends on `sign`: an outflow's worst
 * case is its *larger* magnitude (more spent), which is `-high`; an
 * inflow's worst case is its *smaller* magnitude (less received), which is
 * `+low`. Getting this backwards would show a band that's optimistic exactly
 * where it needs to be conservative.
 */
import type { MoneyJson } from '@core/kernel';

export interface ForecastChargeInput {
  readonly date: string;
  readonly sign: 'OUTFLOW' | 'INFLOW';
  readonly expected: MoneyJson;
  readonly low: MoneyJson;
  readonly high: MoneyJson;
}

export interface ForecastPoint {
  readonly date: string;
  readonly cumulativeExpectedMinor: number;
  readonly cumulativeLowMinor: number;
  readonly cumulativeHighMinor: number;
}

/** A magnitude, signed by direction: an outflow subtracts, an inflow adds. */
function signedMinor(money: MoneyJson, sign: 'OUTFLOW' | 'INFLOW'): number {
  const magnitude = Number(BigInt(money.minor));
  return sign === 'OUTFLOW' ? -magnitude : magnitude;
}

function nextDay(dateOnly: string): string {
  const date = new Date(`${dateOnly}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/** Every calendar day from `from` to `to`, inclusive, as `DateOnly` strings. Capped at 400 to keep a malformed range from looping forever. */
export function enumerateDays(from: string, to: string): string[] {
  const days: string[] = [];
  let cursor = from;
  let guard = 0;
  while (cursor <= to && guard < 400) {
    days.push(cursor);
    cursor = nextDay(cursor);
    guard += 1;
  }
  return days;
}

/**
 * Day-by-day cumulative net cash flow: `expected` is the point estimate,
 * `low`/`high` the running worst/best case. A day with no charge carries the
 * previous day's cumulative total forward (flat), never resets to zero.
 */
export function buildForecastBand(
  from: string,
  to: string,
  charges: readonly ForecastChargeInput[],
): ForecastPoint[] {
  const deltasByDate = new Map<string, { expected: number; worst: number; best: number }>();
  for (const charge of charges) {
    const expected = signedMinor(charge.expected, charge.sign);
    const outflow = charge.sign === 'OUTFLOW';
    // Worst case: an outflow's high magnitude (spends more) or an inflow's
    // low magnitude (receives less). Best case is the mirror image.
    const worst = outflow ? -Number(BigInt(charge.high.minor)) : Number(BigInt(charge.low.minor));
    const best = outflow ? -Number(BigInt(charge.low.minor)) : Number(BigInt(charge.high.minor));
    const existing = deltasByDate.get(charge.date) ?? { expected: 0, worst: 0, best: 0 };
    deltasByDate.set(charge.date, {
      expected: existing.expected + expected,
      worst: existing.worst + worst,
      best: existing.best + best,
    });
  }

  let cumulativeExpected = 0;
  let cumulativeLow = 0;
  let cumulativeHigh = 0;
  const points: ForecastPoint[] = [];
  for (const date of enumerateDays(from, to)) {
    const delta = deltasByDate.get(date);
    if (delta !== undefined) {
      cumulativeExpected += delta.expected;
      cumulativeLow += delta.worst;
      cumulativeHigh += delta.best;
    }
    points.push({
      date,
      cumulativeExpectedMinor: cumulativeExpected,
      cumulativeLowMinor: cumulativeLow,
      cumulativeHighMinor: cumulativeHigh,
    });
  }
  return points;
}
