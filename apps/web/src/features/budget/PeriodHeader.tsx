// SPDX-License-Identifier: MIT
import { useState } from 'react';
import { ArrowRight, TrendingDown, TrendingUp } from 'lucide-react';

import type { BudgetPeriod, BudgetPeriodSummary } from '../../api/generated/types.gen.ts';
import { Money } from '../../components/finance/Money.tsx';
import { Button } from '../../components/ui/button.tsx';
import { ConfirmDialog } from '../../components/patterns/ConfirmDialog.tsx';
import { formatDateOnly } from '../../lib/date.ts';
import { useRollBudgetPeriodMutation } from './api.ts';
import { periodCategoryTotals, readyToAssignToneOf } from './envelope-display.ts';
import { PeriodPicker } from './PeriodPicker.tsx';

export interface PeriodHeaderProps {
  budgetId: string;
  period: BudgetPeriod;
  selectedPeriodId: string;
  onSelectPeriod: (period: BudgetPeriodSummary) => void;
}

const RTA_COPY: Record<'opportunity' | 'alert' | 'settled', { label: string; className: string }> =
  {
    opportunity: { label: 'Ready to Assign', className: 'text-money-pos-text' },
    alert: {
      label: 'Ready to Assign is negative — fix this first',
      className: 'text-money-neg-text',
    },
    settled: { label: 'Ready to Assign', className: 'text-text-secondary' },
  };

/**
 * Period header: date range + picker, Ready-to-Assign as "the one opportunity
 * or the one hard alert" (`envelope-display.ts#readyToAssignToneOf`), the
 * category totals row, and the roll-forward action.
 */
export function PeriodHeader({
  budgetId,
  period,
  selectedPeriodId,
  onSelectPeriod,
}: PeriodHeaderProps) {
  const [confirmRollOpen, setConfirmRollOpen] = useState(false);
  const roll = useRollBudgetPeriodMutation();
  const rtaTone = readyToAssignToneOf(period);
  const totals = periodCategoryTotals(period);
  const isViewingCurrent = selectedPeriodId === period.id;

  function handleRoll(): void {
    roll.mutate(
      { body: { budgetId, periodId: period.id } },
      { onSuccess: () => setConfirmRollOpen(false) },
    );
  }

  return (
    <header className="flex flex-col gap-4 rounded-lg border border-border-hairline bg-bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-h2 font-semibold text-text-primary">Budget</h1>
          <p data-testid="period-range" className="text-small text-text-muted">
            {formatDateOnly(period.startDate)} – {formatDateOnly(period.endDate)}
            {period.dirty && ' · recalculating…'}
          </p>
        </div>
        <PeriodPicker
          budgetId={budgetId}
          currentPeriodId={period.id}
          selectedPeriodId={selectedPeriodId}
          onSelect={onSelectPeriod}
        />
      </div>

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p
            className={`flex items-center gap-1.5 text-small font-medium ${RTA_COPY[rtaTone].className}`}
          >
            {rtaTone === 'opportunity' && <TrendingUp size={16} aria-hidden="true" />}
            {rtaTone === 'alert' && <TrendingDown size={16} aria-hidden="true" />}
            {RTA_COPY[rtaTone].label}
          </p>
          <p
            data-testid="ready-to-assign-amount"
            className={`text-h1 font-semibold ${RTA_COPY[rtaTone].className}`}
          >
            <Money value={period.readyToAssign} colorBySign={false} />
          </p>
        </div>

        <dl className="flex gap-6 text-right">
          <div>
            <dt className="text-caption text-text-muted">Assigned</dt>
            <dd className="text-body font-medium tabular-nums">
              <Money
                value={{
                  minor: totals.assigned.minor.toString(),
                  currency: totals.assigned.currency,
                }}
              />
            </dd>
          </div>
          <div>
            <dt className="text-caption text-text-muted">Activity</dt>
            <dd className="text-body font-medium tabular-nums">
              <Money
                value={{
                  minor: totals.activity.minor.toString(),
                  currency: totals.activity.currency,
                }}
              />
            </dd>
          </div>
          <div>
            <dt className="text-caption text-text-muted">Available</dt>
            <dd className="text-body font-medium tabular-nums">
              <Money
                value={{
                  minor: totals.available.minor.toString(),
                  currency: totals.available.currency,
                }}
              />
            </dd>
          </div>
        </dl>

        {isViewingCurrent && (
          <Button
            variant="secondary"
            size="sm"
            className="gap-1.5"
            onClick={() => setConfirmRollOpen(true)}
          >
            Roll to next period
            <ArrowRight size={14} aria-hidden="true" />
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={confirmRollOpen}
        onOpenChange={setConfirmRollOpen}
        title="Roll to the next period?"
        description="This closes the current period and opens the next one, carrying balances forward per each envelope's rollover policy. Overspending is absorbed by Ready-to-Assign."
        confirmLabel="Roll forward"
        confirmVariant="primary"
        busy={roll.isPending}
        onConfirm={handleRoll}
      />
    </header>
  );
}
