// SPDX-License-Identifier: MIT
import { Link } from '@tanstack/react-router';
import { AlertOctagon, AlertTriangle, CheckCircle2, CircleDashed, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import type { HealthLivingCover, HealthPillarDatum } from '../../api/generated/types.gen.ts';
import { Badge } from '../../components/ui/badge.tsx';
import { BAND_LABEL } from './format.ts';
import { inputText, moneyText } from './pillars.ts';
import type { HealthBand } from './types.ts';
import { BAND_STATUS } from './zones.ts';

const BAND_ICON: Record<HealthBand, LucideIcon> = {
  poor: AlertOctagon,
  fair: AlertTriangle,
  good: CheckCircle2,
  excellent: Sparkles,
};

/** A band as a status chip: the quartet, an icon and the word — never colour alone. */
export function BandChip({
  band,
  suffix,
}: {
  readonly band: HealthBand;
  readonly suffix?: string;
}) {
  const Icon = BAND_ICON[band];
  return (
    <Badge
      variant={BAND_STATUS[band]}
      icon={<Icon size={12} aria-hidden="true" />}
      data-band={band}
    >
      {BAND_LABEL[band]}
      {suffix === undefined ? null : <span className="font-normal">{suffix}</span>}
    </Badge>
  );
}

export function WithheldChip() {
  return (
    <Badge
      variant="neutral"
      icon={<CircleDashed size={12} aria-hidden="true" />}
      data-band="withheld"
    >
      Not scored
    </Badge>
  );
}

/** "Built from:" — the inputs a pillar's figure was computed from, as the server stated them. */
export function InputsList({ inputs }: { readonly inputs: readonly HealthPillarDatum[] }) {
  if (inputs.length === 0) return null;
  return (
    <div data-testid="pillar-inputs">
      <p className="text-caption font-medium text-text-secondary">Built from:</p>
      <dl className="mt-1 flex flex-col gap-0.5 text-caption">
        {inputs.map((input) => (
          <div key={input.key} className="flex flex-wrap justify-between gap-x-3">
            <dt className="text-text-muted">{input.label}</dt>
            <dd className="text-text-primary tabular-nums">{inputText(input)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * The emergency-fund pillar's living-expenses cover (from the budget's variability, V4): shown beside the scored
 * figure and never scored. Withheld until a category is classified, with the way to do that.
 */
export function LivingCover({
  cover,
  detailed = false,
}: {
  readonly cover: HealthLivingCover;
  readonly detailed?: boolean;
}) {
  if (cover.status === 'withheld') {
    return (
      <div
        className="rounded-md border border-border-divider bg-bg-secondary p-2 text-caption"
        data-testid="living-cover-withheld"
      >
        <p className="font-medium text-text-secondary">Living expenses: not measured yet</p>
        <p className="mt-0.5 text-text-muted">{cover.reason}</p>
        <p className="mt-0.5 text-text-secondary">
          To unlock:{' '}
          <Link
            to="/budget"
            search={{ view: 'variability' }}
            className="font-medium text-accent-text underline underline-offset-4"
          >
            {cover.unlock}
          </Link>
        </p>
      </div>
    );
  }
  const living = cover.livingExpenses;
  return (
    <div
      className="rounded-md border border-border-divider bg-bg-secondary p-2 text-caption"
      data-testid="living-cover"
    >
      <p className="text-text-secondary">
        Your cash covers{' '}
        <strong className="font-semibold text-text-primary">{cover.months} months</strong> of living
        expenses ({moneyText(living.monthly)} a month).{' '}
        <BandChip band={cover.band} suffix=" · shown, not scored" />
      </p>
      {detailed && (
        <ul className="mt-1 flex flex-col gap-0.5 text-text-muted">
          <li>
            Fixed categories ({String(living.fixedCategoryCount)}):{' '}
            {moneyText(living.fixedMonthlyAverage)} a month, the average of{' '}
            {living.fixedWindow.from} to {living.fixedWindow.to}.
          </li>
          <li>
            Non-monthly categories ({String(living.nonMonthlyCategoryCount)}):{' '}
            {moneyText(living.nonMonthlyMonthlyShare)} a month, a twelfth of{' '}
            {living.nonMonthlyWindow.from} to {living.nonMonthlyWindow.to}.
          </li>
          <li>Flexible and unclassified categories are not counted.</li>
        </ul>
      )}
    </div>
  );
}
