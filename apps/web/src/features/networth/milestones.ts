// SPDX-License-Identifier: MIT
import type { NetWorthMilestone } from '../../api/generated/types.gen.ts';
import { formatDateOnly } from '../../lib/date.ts';
import { formatMoney, parseWireMoney } from '../../lib/money.ts';

/**
 * The dashboard's one-line milestone notice (WP 10.13, V6) in words. Up through a round figure: "You crossed
 * $50,000 in net worth on Oct 3"; the zero line: "Your net worth rose above zero on Oct 3" / "fell below zero
 * on Oct 3". The figure is a whole number of major units (every rung is), so it is written without cents.
 */
export function milestoneSentence(milestone: NetWorthMilestone): string {
  const on = formatDateOnly(milestone.crossedOn, 'MMM d');
  if (milestone.milestone.minor === '0') {
    return milestone.direction === 'up'
      ? `Your net worth rose above zero on ${on}`
      : `Your net worth fell below zero on ${on}`;
  }
  const figure = formatMoney(parseWireMoney(milestone.milestone), { signDisplay: 'auto' }).replace(
    /\.00$/u,
    '',
  );
  return `You crossed ${figure} in net worth on ${on}`;
}

/**
 * Which milestone the notice names: the newest crossing, the highest on that day (the list arrives newest
 * first, highest first within a day). Dismissing it dismisses every milestone listed — a jump across $25k and
 * $50k is one event for the holder, and an older one they never saw is subsumed by the newer.
 */
export function noticeOf(
  milestones: readonly NetWorthMilestone[] | undefined,
): { readonly sentence: string; readonly ids: readonly string[] } | null {
  const newest = milestones?.[0];
  if (newest === undefined) return null;
  return { sentence: milestoneSentence(newest), ids: milestones!.map((m) => m.id) };
}
