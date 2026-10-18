// SPDX-License-Identifier: MIT
import { Link } from '@tanstack/react-router';
import { ChevronRight, HeartPulse } from 'lucide-react';
import { useId } from 'react';

import type {
  HealthOverview,
  HealthPillar,
  HealthThreshold,
} from '../../api/generated/types.gen.ts';
import { DateOnlyText } from '../../components/finance/DateOnlyText.tsx';
import { ChartDataTable } from '../../components/patterns/ChartDataTable.tsx';
import { EmptyState } from '../../components/patterns/EmptyState.tsx';
import { SkeletonText } from '../../components/patterns/Skeleton.tsx';
import { Card } from '../../components/ui/card.tsx';
import { cn } from '../../lib/cn.ts';
import { formatDateOnly } from '../../lib/date.ts';
import { COMPONENT_LABEL } from './format.ts';
import { deltaVs30Days, scoreSeries } from './history.ts';
import { BandChip, InputsList, LivingCover, WithheldChip } from './parts.tsx';
import { PILLAR_MEANING, PILLAR_SLUG, valueText, weightText } from './pillars.ts';
import { ScoreGauge } from './ScoreGauge.tsx';
import { Sparkline } from './Sparkline.tsx';
import { tierLineOf, tierOf } from './tiers.ts';
import { useHealthOverview } from './useHealthOverview.ts';

const TIER_TEXT = {
  warning: 'text-status-warning-text',
  success: 'text-status-success-text',
  info: 'text-status-info-text',
  danger: 'text-status-danger-text',
} as const;

export function scoreText(score: number): string {
  return Number.isInteger(score) ? String(score) : score.toFixed(1);
}

/** Loading, error and "not computed yet" — shared by the screen and the pillar detail. */
export function HealthStates({ state }: { readonly state: 'loading' | 'error' | 'not-computed' }) {
  if (state === 'loading') {
    return (
      <div role="status" aria-busy="true" aria-label="Loading your financial health">
        <SkeletonText lines={8} />
      </div>
    );
  }
  if (state === 'not-computed') {
    return (
      <EmptyState
        icon={HeartPulse}
        headline="Your first health score hasn’t been computed yet"
        description="It is computed every morning at about 04:10, and whenever you open this screen once the app can build one."
      />
    );
  }
  return (
    <p role="alert" className="text-small text-text-secondary">
      Your financial health could not be loaded right now.
    </p>
  );
}

function HealthHero({ health }: { readonly health: HealthOverview }) {
  const headingId = useId();
  const tier = health.score === null ? null : tierOf(health.score);
  const series = scoreSeries(health.history);
  const delta = deltaVs30Days(health.history, health.asOfDate, health.score);
  return (
    <Card padding="default" data-testid="health-hero">
      <section aria-labelledby={headingId} className="flex flex-wrap items-center gap-x-8 gap-y-4">
        <ScoreGauge score={health.score} size="md" />
        <div className="flex min-w-[min(18rem,100%)] flex-1 flex-col gap-2">
          <h2 id={headingId} className="text-small font-medium text-text-secondary">
            Your financial health
          </h2>
          {tier === null || health.score === null ? (
            <p className="text-h2 font-semibold text-text-primary" data-testid="health-tier">
              Not scored yet
            </p>
          ) : (
            <p
              className={cn('text-h2 font-semibold', TIER_TEXT[tier.status])}
              data-testid="health-tier"
            >
              {tier.word}
              <span className="sr-only"> — {scoreText(health.score)} out of 100</span>
            </p>
          )}
          <p className="text-body text-text-primary" data-testid="health-tier-line">
            {tierLineOf(health.score, health.pillars, health.thresholds)}
          </p>
          <p className="text-caption text-text-muted" data-testid="health-as-of">
            As of <DateOnlyText value={health.asOfDate} />
            {health.asOfDate !== health.today &&
              ' — today’s score could not be computed, so this is the latest one'}
          </p>
          <div className="mt-2 flex flex-col gap-1">
            <p className="text-small text-text-secondary" data-testid="health-delta">
              {delta.words}
              {delta.kind === 'delta' && (
                <span className="text-text-muted">
                  {' '}
                  ({scoreText(delta.baseScore)} on {formatDateOnly(delta.baseDate)})
                </span>
              )}
            </p>
            <Sparkline
              points={series}
              label="Your score over the last 90 days"
              formatValue={(value) => `${scoreText(value)} / 100`}
              domain={[0, 100]}
              minSpan={10}
              withheldText="Your score’s history starts once there are two days of scores."
              testId="health-history-sparkline"
            />
            {health.history.length > 0 && (
              <ChartDataTable
                caption="Score history"
                columns={['Date', 'Score']}
                rows={[...health.history]
                  .sort((a, b) => b.asOfDate.localeCompare(a.asOfDate))
                  .map((entry) => [
                    formatDateOnly(entry.asOfDate),
                    entry.score === null ? 'Not scored' : `${scoreText(entry.score)} / 100`,
                  ])}
              />
            )}
          </div>
        </div>
      </section>
    </Card>
  );
}

function PillarCard({ pillar }: { readonly pillar: HealthPillar }) {
  const headingId = useId();
  const label = COMPONENT_LABEL[pillar.component];
  return (
    <li className="min-w-0" data-pillar={pillar.component} data-pillar-status={pillar.status}>
      <Card padding="default" className="flex h-full flex-col gap-2">
        <section aria-labelledby={headingId} className="flex h-full flex-col gap-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h3 id={headingId} className="text-h3 font-semibold text-text-primary">
              {label}
            </h3>
            {pillar.status === 'scored' ? <BandChip band={pillar.band} /> : <WithheldChip />}
          </div>
          {pillar.status === 'scored' ? (
            <p className="text-h2 font-semibold text-text-primary" data-testid="pillar-score">
              {String(pillar.score)}
              <span className="text-small font-normal text-text-muted"> / 100</span>
            </p>
          ) : null}
          <p className="text-small text-text-secondary">{PILLAR_MEANING[pillar.component]}</p>
          {pillar.status === 'scored' ? (
            <>
              <p className="text-small text-text-primary" data-testid="pillar-value">
                Your figure:{' '}
                <strong className="font-semibold">
                  {valueText(pillar.component, pillar.value)}
                </strong>
              </p>
              <p className="text-caption text-text-muted">
                Counts for {weightText(pillar.weight)} of your score
              </p>
            </>
          ) : (
            <div className="flex flex-col gap-1 text-small" data-testid="pillar-withheld">
              <p className="text-text-secondary">
                <span className="font-medium text-text-primary">Why: </span>
                {pillar.reason}
              </p>
              <p className="text-text-secondary">
                <span className="font-medium text-text-primary">To unlock: </span>
                {pillar.unlock}
              </p>
            </div>
          )}
          <InputsList inputs={pillar.inputs} />
          {pillar.livingCover !== undefined && <LivingCover cover={pillar.livingCover} />}
          <div className="mt-auto pt-1">
            <Link
              to="/health/$pillar"
              params={{ pillar: PILLAR_SLUG[pillar.component] }}
              className="inline-flex min-h-6 items-center gap-0.5 text-small font-medium text-accent-text underline-offset-4 hover:underline"
            >
              See detail<span className="sr-only"> — {label}</span>
              <ChevronRight size={14} aria-hidden="true" />
            </Link>
          </div>
        </section>
      </Card>
    </li>
  );
}

export function PillarsGrid({
  pillars,
}: {
  readonly pillars: readonly HealthPillar[];
  readonly thresholds?: readonly HealthThreshold[];
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="@container flex flex-col gap-3">
      <h2 id={headingId} className="text-h3 font-semibold text-text-primary">
        The six pillars
      </h2>
      <ul
        className="grid grid-cols-1 gap-4 @xl:grid-cols-2 @3xl:grid-cols-3"
        data-testid="pillars-grid"
      >
        {pillars.map((pillar) => (
          <PillarCard key={pillar.component} pillar={pillar} />
        ))}
      </ul>
    </section>
  );
}

/**
 * `/health` (WP 10.12, V5; Monarch's equivalent): the score as a gauge
 * with its tier in words and the one thing to do next, its as-of date and its 90-day history with the change
 * since 30 days ago; then a card per pillar — scored with its inputs, or withheld with why and what would unlock
 * it, never a zero. Every figure here is a field of `GET /insights/health`.
 */
export function HealthScreen() {
  const { query, health, notComputed } = useHealthOverview();
  if (query.isLoading) return <HealthStates state="loading" />;
  if (notComputed) return <HealthStates state="not-computed" />;
  if (query.isError || health === undefined) return <HealthStates state="error" />;
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <HealthHero health={health} />
      <PillarsGrid pillars={health.pillars} />
    </div>
  );
}
