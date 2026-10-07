// SPDX-License-Identifier: MIT
/**
 * Where the slider preview's starting balance comes from (WP 9.7, G4-11).
 *
 * The preview used to seed a $250,000 starting balance whenever it knew nothing
 * better — always, since no server field carries one — and then printed "61% of
 * simulated paths succeed" as though that were the holder's number. The server
 * projection starts from the newest **sealed** `net_worth_daily` day, never from
 * a live balance (`projection-service.ts`'s header). The preview now does the
 * same, through the series route the net-worth screen already reads: the newest
 * point with `sealed: true`, and its `investable` total — the part of net worth
 * the engine projects (a house and a loan are not retirement savings).
 *
 * No sealed day, an unreadable series, or a non-dollar base currency means there
 * is nothing of the holder's to start from, and the screen says the figure is a
 * placeholder rather than showing it as theirs.
 */
import type { GetNetWorthSeriesResponse } from '../../../api/generated/types.gen.ts';

export type StartSource =
  | {
      readonly kind: 'sealed';
      /** Whole dollars. */
      readonly amount: number;
      readonly asOfDate: string;
    }
  | { readonly kind: 'placeholder'; readonly reason: 'none_sealed' | 'unavailable' | 'currency' };

/**
 * The newest sealed day's investable balance, or why there is none. Pure: the
 * window is the caller's, and an open day (`sealed: false`) is never used however
 * recent — a number that moves when today does is the thing the seal exists to
 * prevent.
 */
export function pickSealedStart(series: GetNetWorthSeriesResponse): StartSource {
  if (series.baseCurrency !== 'USD') return { kind: 'placeholder', reason: 'currency' };
  let newest: { readonly asOfDate: string; readonly minor: string } | null = null;
  for (const point of series.points) {
    if (!point.sealed || point.investable === null) continue;
    if (newest === null || point.asOfDate > newest.asOfDate) {
      newest = { asOfDate: point.asOfDate, minor: point.investable.minor };
    }
  }
  if (newest === null) return { kind: 'placeholder', reason: 'none_sealed' };
  const dollars = Number(newest.minor) / 100;
  if (!Number.isFinite(dollars) || dollars < 0) {
    return { kind: 'placeholder', reason: 'unavailable' };
  }
  return { kind: 'sealed', amount: Math.round(dollars), asOfDate: newest.asOfDate };
}

export const PLACEHOLDER_REASON_WORDS: Readonly<
  Record<Extract<StartSource, { kind: 'placeholder' }>['reason'], string>
> = {
  none_sealed: 'there is no sealed net-worth day yet',
  unavailable: 'your net-worth series could not be read',
  currency: 'your base currency is not US dollars, which this preview does not model',
};
