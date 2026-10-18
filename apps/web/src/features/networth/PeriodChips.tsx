// SPDX-License-Identifier: MIT
import { cn } from '../../lib/cn.ts';
import { DASHBOARD_PERIOD_LABELS, DASHBOARD_PERIODS, type DashboardPeriod } from './search.ts';

/**
 * The net-worth period chips — 1M 3M 6M 1Y All (WP 10.9's, shared by the widget and, since WP 10.13, the full
 * view). Each name keeps the visible text first (2.5.3 Label in Name) and says what it means: "3M: the last 3
 * months".
 */
export function PeriodChips({
  value,
  onChange,
  label = 'Net worth period',
}: {
  readonly value: DashboardPeriod;
  readonly onChange: (period: DashboardPeriod) => void;
  readonly label?: string;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1">
      {DASHBOARD_PERIODS.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={option === value}
          onClick={() => onChange(option)}
          className={cn(
            'inline-flex h-8 min-w-10 items-center justify-center rounded-md px-2 text-xs font-medium',
            option === value
              ? 'bg-bg-secondary text-text-primary ring-1 ring-border-primary'
              : 'text-text-secondary hover:bg-bg-subtle',
          )}
        >
          {DASHBOARD_PERIOD_LABELS[option].short}
          <span className="sr-only">: {DASHBOARD_PERIOD_LABELS[option].long}</span>
        </button>
      ))}
    </div>
  );
}
