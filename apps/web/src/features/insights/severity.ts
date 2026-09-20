// SPDX-License-Identifier: MIT
import type { Insight } from '../../api/generated/types.gen.ts';

/** Severity-dominant ordering, matching `@ctx/insights`' own `rankableOf`/alert-budget ranking (urgent first). */
const SEVERITY_RANK: Record<string, number> = { urgent: 0, warning: 1, notable: 2, info: 3 };

export function severityRank(severity: string): number {
  return SEVERITY_RANK[severity] ?? 4;
}

/** The one $-impact figure a card headlines: annualized when the advisor claimed one, else the one-time figure, else none. Never both, and never a value the insight itself didn't carry. */
export function headlineImpactOf(
  insight: Pick<Insight, 'annualizedImpact' | 'oneTimeImpact'>,
): { kind: 'annualized' | 'one_time'; money: NonNullable<Insight['annualizedImpact']> } | null {
  if (insight.annualizedImpact !== null)
    return { kind: 'annualized', money: insight.annualizedImpact };
  if (insight.oneTimeImpact !== null) return { kind: 'one_time', money: insight.oneTimeImpact };
  return null;
}

export function confidencePercentLabel(confidence: number): string {
  return `${String(Math.round(Math.min(1, Math.max(0, confidence)) * 100))}% confidence`;
}
