// SPDX-License-Identifier: MIT
import { useQuery } from '@tanstack/react-query';
import {
  AlertOctagon,
  AlertTriangle,
  CheckCircle2,
  HelpCircle,
  Minus,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { getHealthScoreOptions } from '../../api/generated/@tanstack/react-query.gen.ts';
import type { Problem } from '../../api/generated/types.gen.ts';
import { Card } from '../../components/ui/card.tsx';
import { Money } from '../../components/finance/Money.tsx';
import { SkeletonText } from '../../components/patterns/Skeleton.tsx';
import {
  BAND_LABEL,
  COMPONENT_LABEL,
  COMPONENT_UNIT,
  DIRECTION_GLYPH,
  DIRECTION_LABEL,
  formatMonths,
  formatRatioPercent,
} from './format.ts';
import {
  isMoneyValue,
  type HealthBand,
  type HealthComponentResult,
  type HealthScoreWireResponse,
} from './types.ts';

const BAND_ICON: Record<HealthBand, LucideIcon> = {
  poor: AlertOctagon,
  fair: AlertTriangle,
  good: CheckCircle2,
  excellent: CheckCircle2,
};

const DIRECTION_ICON: Record<HealthComponentResult['direction'], LucideIcon> = {
  improved: TrendingUp,
  worsened: TrendingDown,
  unchanged: Minus,
  no_previous_data: HelpCircle,
};

function ComponentValue({ component }: { component: HealthComponentResult }) {
  if (isMoneyValue(component.value)) {
    return <Money value={component.value} colorBySign={false} />;
  }
  const unit = COMPONENT_UNIT[component.component];
  return (
    <span>
      {unit === 'months' ? formatMonths(component.value) : formatRatioPercent(component.value)}
    </span>
  );
}

function DirectionCell({ direction }: { direction: HealthComponentResult['direction'] }) {
  const Icon = DIRECTION_ICON[direction];
  return (
    <span className="inline-flex items-center gap-1 text-small text-text-secondary">
      <Icon size={14} aria-hidden="true" />
      {/* The glyph and the word both render — never colour or the glyph alone (WCAG 2.2 AA). */}
      <span aria-hidden="true">{DIRECTION_GLYPH[direction]}</span>
      <span>{DIRECTION_LABEL[direction]}</span>
    </span>
  );
}

function BandBadge({ band }: { band: HealthBand }) {
  const Icon = BAND_ICON[band];
  return (
    <span className="inline-flex items-center gap-1 text-small text-text-secondary">
      <Icon size={14} aria-hidden="true" />
      <span>{BAND_LABEL[band]}</span>
    </span>
  );
}

function ComponentRow({ component }: { component: HealthComponentResult }) {
  return (
    <li
      data-testid="health-component-row"
      className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-md bg-bg-subtle p-3 sm:grid-cols-5 sm:items-center"
    >
      <span className="col-span-2 font-medium text-text-primary sm:col-span-1">
        {COMPONENT_LABEL[component.component]}
      </span>
      <span className="text-text-secondary">
        <ComponentValue component={component} />
      </span>
      <span className="text-text-secondary">Weight: {formatRatioPercent(component.weight)}</span>
      <BandBadge band={component.band} />
      <DirectionCell direction={component.direction} />
    </li>
  );
}

/**
 * The health score (05-phase-5-dispatch.md §3 WP 5.11): the overall figure
 * only beside its six named rows — never shown on its own — each with
 * value, weight and direction in words as well as a glyph, and every
 * excluded component named rather than scored as zero.
 *
 * `GET /insights/health-score` is a 404 `insights.health_score_not_computed`
 * stub until WP 5.8 lands (`docs/evidence/phase-5/wp5.10-routes.md`); that
 * 404 is handled here as "not computed yet", not as an error.
 */
export function HealthScoreSection() {
  const query = useQuery(getHealthScoreOptions());

  if (query.isLoading) {
    return (
      <Card padding="default" data-testid="health-score-loading">
        <SkeletonText lines={6} />
      </Card>
    );
  }

  if (query.isError) {
    const problem = query.error as Problem;
    if (problem.code === 'insights.health_score_not_computed') {
      return (
        <Card padding="default" data-testid="health-score-not-computed">
          <h2 className="text-h3 text-text-primary">Financial health score</h2>
          <p className="mt-1 text-small text-text-secondary">
            Not computed yet. It is calculated along with your weekly Brief.
          </p>
        </Card>
      );
    }
    return (
      <Card padding="default" data-testid="health-score-error">
        <p role="alert" className="text-small text-text-secondary">
          Could not load your health score.
        </p>
      </Card>
    );
  }

  // `GetHealthScoreResponses` has no 200 branch yet (see `./types.ts`'s
  // header) — this is the one, documented cast from `unknown` to the real
  // wire shape `apps/api/src/routes/brief.ts`'s route actually serves
  // (`{ healthScore: {...} }`), not a guess at a new field.
  const { healthScore: result } = query.data as HealthScoreWireResponse;

  return (
    <Card padding="default" data-testid="health-score-section">
      <h2 className="text-h3 text-text-primary">Financial health score</h2>
      <p className="mt-1 text-small text-text-secondary" data-testid="health-score-overall">
        {result.overall !== null
          ? `Overall: ${String(result.overall)} / 100`
          : 'Overall: not enough data to compute yet'}
      </p>

      <ul className="mt-3 flex flex-col gap-2">
        {result.components.map((component) => (
          <ComponentRow key={component.component} component={component} />
        ))}
      </ul>

      {result.excluded.length > 0 && (
        <div className="mt-3" data-testid="health-excluded">
          <h3 className="text-small font-semibold text-text-primary">Not included this week</h3>
          <ul className="mt-1 flex flex-col gap-1">
            {result.excluded.map((excluded) => (
              <li key={excluded.component} className="text-caption text-text-muted">
                <span className="font-medium text-text-secondary">
                  {COMPONENT_LABEL[excluded.component]}:
                </span>{' '}
                {excluded.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
