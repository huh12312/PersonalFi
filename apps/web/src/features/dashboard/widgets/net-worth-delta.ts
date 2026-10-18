// SPDX-License-Identifier: MIT
import { Money as MoneyKernel, type Money } from '@core/kernel';

import { parseWireMoney } from '../../../lib/money.ts';
import type { RawSeriesPoint } from '../../networth/series.ts';

export interface NetWorthDelta {
  readonly from: string;
  readonly to: string;
  readonly change: Money;
  /** change ÷ |opening|, a float for display only; `null` when the opening value is zero. */
  readonly ratio: number | null;
}

/**
 * The change over the window: the latest valued day against the first valued day **in the same currency** (a
 * window that spans a base-currency change has no honest single delta). `null` with fewer than two valued days —
 * a change the app did not compute is never shown (gate G3-2's rule for the hero, applied to the delta).
 */
export function netWorthDelta(points: readonly RawSeriesPoint[]): NetWorthDelta | null {
  const valued = points.filter((point) => point.netWorth !== null);
  const last = valued.at(-1);
  if (last?.netWorth == null) return null;
  const first = valued.find((point) => point.netWorth?.currency === last.netWorth?.currency);
  if (first?.netWorth == null || first.asOfDate === last.asOfDate) return null;
  const opening = parseWireMoney(first.netWorth);
  const closing = parseWireMoney(last.netWorth);
  const change = MoneyKernel.subtract(closing, opening);
  const base = MoneyKernel.absolute(opening);
  // Presentation only: a percentage for the label, from exact minor units.
  const ratio = MoneyKernel.isZero(base) ? null : Number(change.minor) / Number(base.minor);
  return { from: first.asOfDate, to: last.asOfDate, change, ratio };
}
