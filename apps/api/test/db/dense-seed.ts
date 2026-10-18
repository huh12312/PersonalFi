// SPDX-License-Identifier: MIT
/**
 * The dense 50k corpus WP 10.9 (V2) introduced for its spending-pace budget, shared so a second budget
 * (WP 10.13's net worth by account type) measures over the same data rather than a lookalike.
 *
 * `generateDemoData(1, { monthCount: 1264 })` is 50,040 transactions spread over 1,264 months; `densify`
 * maps every date monotonically (order and same-day pairs preserved) onto the 24 months 2024-10 … 2026-09,
 * about 2,000 rows a month.
 */
import { DateOnly } from '@core/kernel';
import type { generateDemoData } from '@core/seed';

export type Dataset = ReturnType<typeof generateDemoData>;

/** Every date mapped monotonically from the seed's span onto [2024-10-01, 2026-09-30]: same order, same-day pairs kept. */
export function densify(dataset: Dataset): Dataset {
  const dates = dataset.transactions.flatMap((t) =>
    t.pendingOn === null ? [t.postedOn] : [t.postedOn, t.pendingOn],
  );
  const epochs = dates.map((date) => DateOnly.toEpochDay(date));
  const lo = Math.min(...epochs);
  const hi = Math.max(...epochs);
  const targetLo = DateOnly.toEpochDay(DateOnly.of(2024, 10, 1));
  const targetSpan = DateOnly.toEpochDay(DateOnly.of(2026, 9, 30)) - targetLo;
  const map = (date: DateOnly): DateOnly =>
    DateOnly.fromEpochDay(
      targetLo + Math.floor(((DateOnly.toEpochDay(date) - lo) * targetSpan) / Math.max(hi - lo, 1)),
    );
  return {
    ...dataset,
    transactions: dataset.transactions.map((t) => ({
      ...t,
      postedOn: map(t.postedOn),
      pendingOn: t.pendingOn === null ? null : map(t.pendingOn),
    })),
  };
}
