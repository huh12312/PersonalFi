// SPDX-License-Identifier: MIT
import { DateOnlyText } from '../../../components/finance/DateOnlyText.tsx';
import { cn } from '../../../lib/cn.ts';
import { deltaVs30Days } from '../../health/history.ts';
import { ScoreGauge } from '../../health/ScoreGauge.tsx';
import { tierOf } from '../../health/tiers.ts';
import { useHealthOverview } from '../../health/useHealthOverview.ts';
import { DashboardWidgetCard, type WidgetState } from '../DashboardWidgetCard.tsx';

const TIER_TEXT = {
  warning: 'text-status-warning-text',
  success: 'text-status-success-text',
  info: 'text-status-info-text',
  danger: 'text-status-danger-text',
} as const;

/**
 * Financial health (WP 10.12; Monarch's equivalent): the gauge at `sm`, the tier in words and the change
 * since 30 days ago, from the same `GET /insights/health` the Health screen reads. No score is said, never drawn as
 * a zero; a snapshot that is not today's says its date.
 */
export function FinancialHealthWidget() {
  const { query, health, notComputed } = useHealthOverview();
  const state: WidgetState = query.isLoading
    ? { kind: 'loading' }
    : notComputed
      ? {
          kind: 'empty',
          message: 'Your first health score hasn’t been computed yet.',
          fix: { to: '/health', label: 'Open Financial health' },
        }
      : query.isError || health === undefined
        ? { kind: 'error', message: 'Your financial health isn’t available right now.' }
        : health.score === null
          ? {
              kind: 'empty',
              message: 'There isn’t enough data to score yet.',
              fix: { to: '/health', label: 'See what would unlock it' },
            }
          : { kind: 'ready' };

  const tier = health?.score == null ? null : tierOf(health.score);
  const delta =
    health === undefined ? null : deltaVs30Days(health.history, health.asOfDate, health.score);

  return (
    <DashboardWidgetCard
      id="financial-health"
      title="Financial health"
      seeAll={{ to: '/health', label: 'See all' }}
      state={state}
      {...(health !== undefined && health.asOfDate !== health.today
        ? {
            asOf: (
              <>
                As of <DateOnlyText value={health.asOfDate} />
              </>
            ),
          }
        : {})}
    >
      {health !== undefined && health.score !== null && tier !== null && (
        <div className="flex flex-wrap items-center gap-4">
          <ScoreGauge score={health.score} size="sm" />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <p
              className={cn('text-h3 font-semibold', TIER_TEXT[tier.status])}
              data-testid="widget-health-tier"
            >
              {tier.word}
            </p>
            {delta !== null && (
              <p className="text-small text-text-secondary" data-testid="widget-health-delta">
                {delta.words}
              </p>
            )}
          </div>
        </div>
      )}
    </DashboardWidgetCard>
  );
}
