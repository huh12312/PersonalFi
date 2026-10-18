// SPDX-License-Identifier: MIT
import { Link } from '@tanstack/react-router';
import { ChevronLeft } from 'lucide-react';
import { useId } from 'react';

import type { HealthOverview, HealthPillar } from '../../api/generated/types.gen.ts';
import { DateOnlyText } from '../../components/finance/DateOnlyText.tsx';
import { Card } from '../../components/ui/card.tsx';
import { DateOnly } from '@core/kernel';
import { BAND_LABEL, COMPONENT_LABEL } from './format.ts';
import { HealthStates, scoreText } from './HealthScreen.tsx';
import { HealthZoneChart } from './HealthZoneChart.tsx';
import { pillarScoreSeries, pillarValueSeries } from './history.ts';
import { BandChip, InputsList, LivingCover, WithheldChip } from './parts.tsx';
import {
  componentOfSlug,
  ladderOf,
  metricText,
  PILLAR_MEANING,
  valueText,
  weightText,
} from './pillars.ts';
import { Sparkline } from './Sparkline.tsx';
import { nextStepOf } from './tiers.ts';
import type { HealthComponentId } from './types.ts';
import { useHealthOverview } from './useHealthOverview.ts';
import { metricNumber } from './zones.ts';

function BackLink() {
  return (
    <Link
      to="/health"
      className="inline-flex min-h-6 items-center gap-0.5 text-small text-accent-text underline-offset-4 hover:underline"
    >
      <ChevronLeft size={14} aria-hidden="true" />
      Financial health
    </Link>
  );
}

function PillarDetail({
  health,
  component,
}: {
  readonly health: HealthOverview;
  readonly component: HealthComponentId;
}) {
  const headingId = useId();
  const pillar = health.pillars.find((p) => p.component === component) as HealthPillar;
  const threshold = health.thresholds.find((t) => t.component === component)!;
  const label = COMPONENT_LABEL[component];
  const formatValue = (value: number) => metricText(threshold.unit, value);
  const windowStart = DateOnly.addDays(DateOnly.parse(health.today), -89);
  const step = pillar.status === 'scored' ? nextStepOf(pillar, threshold) : null;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <BackLink />
      <Card padding="default">
        <section aria-labelledby={headingId} className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <h2 id={headingId} className="text-h2 font-semibold text-text-primary">
              {label}
            </h2>
            {pillar.status === 'scored' ? <BandChip band={pillar.band} /> : <WithheldChip />}
          </div>
          <p className="text-body text-text-secondary">{PILLAR_MEANING[component]}</p>
          {pillar.status === 'scored' ? (
            <p className="text-small text-text-primary" data-testid="pillar-detail-figure">
              Your figure is{' '}
              <strong className="font-semibold">{valueText(component, pillar.value)}</strong>, which
              is {BAND_LABEL[pillar.band].toLowerCase()}: this pillar scores{' '}
              <strong className="font-semibold">{String(pillar.score)} / 100</strong> and counts for{' '}
              {weightText(pillar.weight)} of your score (as of{' '}
              <DateOnlyText value={health.asOfDate} />
              ).
              {step !== null && ` To move up a band: ${step}.`}
            </p>
          ) : (
            <div className="flex flex-col gap-1 text-small" data-testid="pillar-withheld">
              <p className="text-text-secondary">
                <span className="font-medium text-text-primary">Not scored. Why: </span>
                {pillar.reason}
              </p>
              <p className="text-text-secondary">
                <span className="font-medium text-text-primary">To unlock: </span>
                {pillar.unlock}
              </p>
            </div>
          )}
        </section>
      </Card>

      <Card padding="default">
        <h3 className="text-h3 font-semibold text-text-primary">Where you are</h3>
        <p className="mb-3 text-caption text-text-muted">
          The zones are the scoring rules’ own bands; the line is your figure each day it was
          measured.
        </p>
        <HealthZoneChart
          label={label}
          threshold={threshold}
          history={pillarValueSeries(health.history, component)}
          current={
            pillar.status === 'scored'
              ? { date: health.asOfDate, value: metricNumber(pillar.value) }
              : null
          }
          formatValue={formatValue}
          windowStart={windowStart}
        />
        <h4 className="mt-4 text-small font-semibold text-text-primary">
          How this pillar is scored
        </h4>
        <ul
          className="mt-1 flex flex-col gap-0.5 text-small text-text-secondary"
          data-testid="pillar-ladder"
        >
          {ladderOf(threshold).map((step) => (
            <li key={step.band}>{step.words}</li>
          ))}
        </ul>
      </Card>

      <Card padding="default">
        <h3 className="text-h3 font-semibold text-text-primary">This pillar’s score over time</h3>
        <div className="mt-2">
          <Sparkline
            points={pillarScoreSeries(health.history, component)}
            label={`${label} score over the last 90 days`}
            formatValue={(value) => `${scoreText(value)} / 100`}
            domain={[0, 100]}
            minSpan={10}
            withheldText="This pillar’s history starts once it has been scored on two days."
            testId="pillar-history-sparkline"
          />
        </div>
      </Card>

      <Card padding="default" className="flex flex-col gap-3">
        <h3 className="text-h3 font-semibold text-text-primary">What it is built from</h3>
        {pillar.inputs.length === 0 ? (
          <p className="text-small text-text-muted">
            No inputs were available for this pillar today.
          </p>
        ) : (
          <InputsList inputs={pillar.inputs} />
        )}
        {pillar.livingCover !== undefined && <LivingCover cover={pillar.livingCover} detailed />}
      </Card>
    </div>
  );
}

/** `/health/$pillar` (WP 10.12): one pillar against its health zones, its history, its ladder and its inputs. */
export function HealthPillarScreen({ slug }: { readonly slug: string }) {
  const { query, health, notComputed } = useHealthOverview();
  const component = componentOfSlug(slug);
  if (component === null) {
    return (
      <div className="mx-auto flex max-w-4xl flex-col gap-3">
        <BackLink />
        <p className="text-body text-text-secondary" data-testid="pillar-not-found">
          There is no pillar called “{slug}”. The six pillars are on the Financial health screen.
        </p>
      </div>
    );
  }
  if (query.isLoading) return <HealthStates state="loading" />;
  if (notComputed) return <HealthStates state="not-computed" />;
  if (query.isError || health === undefined) return <HealthStates state="error" />;
  return <PillarDetail health={health} component={component} />;
}
