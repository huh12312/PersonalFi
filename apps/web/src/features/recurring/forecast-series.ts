// SPDX-License-Identifier: MIT
/**
 * Turns `GET /recurring/forecast`'s flat `charges[]` (each a banded
 * `ProjectedCharge`) into the day-by-day cumulative series
 * `ForecastBandChart` plots, the per-charge marks it draws on each due date,
 * and the shape of the window (nothing due, nothing uncertain, or a real
 * band). Pure and independently testable — the chart component only has to
 * draw what this produces.
 *
 * **Signs.** The wire is signed by house convention (`@ctx/recurring`'s
 * `ProjectedCharge`: "an outflow is negative"; `forwardCashFlow` sums
 * `expected`/`low`/`high` straight into `net`/`netLow`/`netHigh`). Until
 * WP 10.7 this file negated an outflow's amount a second time, so a real
 * $10 outflow would have plotted as +$10 (unseen only because the screens it
 * ran on had no charge in the window). Every amount is now read as a
 * magnitude and signed by `sign`, which is correct for the signed wire and
 * for a magnitude-only fixture alike: an outflow can never plot above zero.
 *
 * "Worst case" then depends on `sign`: an outflow's worst case is its
 * *larger* magnitude (more spent); an inflow's is its *smaller* magnitude
 * (less received). Getting this backwards would show a band that's
 * optimistic exactly where it needs to be conservative.
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

function magnitude(money: MoneyJson): number {
  return Math.abs(Number(BigInt(money.minor)));
}

/** A magnitude, signed by direction: an outflow subtracts, an inflow adds. */
function signedMinor(money: MoneyJson, sign: 'OUTFLOW' | 'INFLOW'): number {
  const value = magnitude(money);
  return sign === 'OUTFLOW' ? -value : value;
}

/** The pessimistic and optimistic signed ends of one charge's amount band. */
function bandEnds(charge: ForecastChargeInput): { worst: number; best: number } {
  const a = magnitude(charge.low);
  const b = magnitude(charge.high);
  const small = Math.min(a, b);
  const large = Math.max(a, b);
  return charge.sign === 'OUTFLOW'
    ? { worst: -large, best: -small }
    : { worst: small, best: large };
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
    // Worst case: an outflow's larger magnitude (spends more) or an inflow's
    // smaller magnitude (receives less). Best case is the mirror image.
    const { worst, best } = bandEnds(charge);
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

// ---------------------------------------------------------------------------
// WP 10.7: a mark per expected charge, the window's shape, the empty statement
// ---------------------------------------------------------------------------

/** A charge as the forecast route sends it, with what a mark needs to name it. */
export interface ForecastMarkInput extends ForecastChargeInput {
  readonly seriesId: string;
  readonly merchantId: string;
  readonly cadence: string;
}

/** One expected charge on its due date: what the chart draws in its charge lane, the readout lists and the table carries. */
export interface ChargeMark {
  readonly date: string;
  readonly seriesId: string;
  readonly merchantId: string;
  readonly name: string;
  readonly sign: 'OUTFLOW' | 'INFLOW';
  /** Signed: an outflow is negative. */
  readonly expectedMinor: number;
  /** Signed worst and best ends of this charge's own amount band (equal when the amount is fixed). */
  readonly worstMinor: number;
  readonly bestMinor: number;
  /** 0 for the first charge on its day, 1 for the second, …: the row it takes in the chart's charge lane. */
  readonly rank: number;
}

/**
 * One mark per charge (never one per day: two charges on the 1st are two marks), ordered by date and then by
 * the size of the charge, largest first, so the lane's first row on a busy day is the charge that moves the
 * total most. Charges outside `[from, to]` are dropped (the route never sends one, but a mark off the axis would
 * be drawn outside the plot).
 */
export function buildChargeMarks(
  from: string,
  to: string,
  charges: readonly ForecastMarkInput[],
  nameOf: (merchantId: string) => string,
): ChargeMark[] {
  const inWindow = charges
    .filter((charge) => charge.date >= from && charge.date <= to)
    .map((charge) => {
      const { worst, best } = bandEnds(charge);
      return {
        date: charge.date,
        seriesId: charge.seriesId,
        merchantId: charge.merchantId,
        name: nameOf(charge.merchantId),
        sign: charge.sign,
        expectedMinor: signedMinor(charge.expected, charge.sign),
        worstMinor: worst,
        bestMinor: best,
      };
    })
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        Math.abs(b.expectedMinor) - Math.abs(a.expectedMinor) ||
        a.name.localeCompare(b.name),
    );
  const seen = new Map<string, number>();
  return inWindow.map((mark) => {
    const rank = seen.get(mark.date) ?? 0;
    seen.set(mark.date, rank + 1);
    return { ...mark, rank };
  });
}

/**
 * What the window holds, which decides what the card may honestly draw:
 *
 *  - `'empty'`: no charge falls in the window. A line would be a flat $0 that looks like a projection and is
 *    not one, so the card draws no line and says why instead.
 *  - `'certain'`: charges, but every one has a fixed amount, so the band has no width. The line is drawn; the
 *    card says the band is missing because nothing is uncertain, not because it failed to draw.
 *  - `'banded'`: at least one charge has a range.
 */
export type ForecastShape = 'empty' | 'certain' | 'banded';

export function forecastShape(
  points: readonly ForecastPoint[],
  marks: readonly ChargeMark[],
): ForecastShape {
  if (marks.length === 0) return 'empty';
  const flat = points.every((point) => point.cumulativeLowMinor === point.cumulativeHighMinor);
  return flat ? 'certain' : 'banded';
}

/** A series as `GET /recurring/series` sends it, reduced to what the empty statement needs. */
export interface StreamInput {
  readonly id: string;
  readonly merchantId: string;
  readonly cadence: string;
  readonly state: string;
}

/** Streams the user has (not archived) that put no charge in this window: the reason the window can be empty. */
export function streamsOutsideWindow(
  series: readonly StreamInput[],
  marks: readonly ChargeMark[],
): StreamInput[] {
  const charged = new Set(marks.map((mark) => mark.seriesId));
  return series.filter((stream) => stream.state !== 'ARCHIVED' && !charged.has(stream.id));
}

/**
 * The sentence the empty window shows in place of a line: "No charges expected in the next 30 days — 1 stream
 * (Uber, yearly) has no due date in this window." Names at most three streams; the rest are counted.
 */
export function describeEmptyWindow(
  days: number,
  streams: readonly StreamInput[],
  nameOf: (merchantId: string) => string,
  cadenceOf: (cadence: string) => string,
): string {
  const lead = `No charges expected in the next ${String(days)} days`;
  if (streams.length === 0) {
    return `${lead} — no recurring streams have been confirmed or detected yet.`;
  }
  const named = streams
    .slice(0, 3)
    .map((stream) => `${nameOf(stream.merchantId)}, ${cadenceOf(stream.cadence).toLowerCase()}`);
  const more = streams.length - named.length;
  const list = more > 0 ? `${named.join('; ')}; and ${String(more)} more` : named.join('; ');
  const count = `${String(streams.length)} stream${streams.length === 1 ? '' : 's'}`;
  const verb = streams.length === 1 ? 'has' : 'have';
  return `${lead} — ${count} (${list}) ${verb} no due date in this window.`;
}
