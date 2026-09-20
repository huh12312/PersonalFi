// SPDX-License-Identifier: MIT
import { CalendarDays } from 'lucide-react';

import type { GetRecurringUpcomingResponse } from '../../api/generated/types.gen.ts';
import { EmptyState } from '../../components/patterns/EmptyState.tsx';
import { DateOnlyText } from '../../components/finance/DateOnlyText.tsx';
import { Money } from '../../components/finance/Money.tsx';

export interface UpcomingCalendarProps {
  calendar: GetRecurringUpcomingResponse;
  nameOf: (merchantId: string) => string;
}

/** The 30-day calendar of expected charges (`GET /recurring/upcoming`) — one row per day that actually has a charge, never a blank 30-row grid. */
export function UpcomingCalendar({ calendar, nameOf }: UpcomingCalendarProps) {
  const daysWithCharges = calendar.days.filter((day) => day.charges.length > 0);

  if (daysWithCharges.length === 0) {
    return (
      <EmptyState
        icon={CalendarDays}
        headline="Nothing scheduled in the next 30 days"
        description="No confirmed or detected charge is expected to land before then."
      />
    );
  }

  return (
    <ol className="flex flex-col gap-3">
      {daysWithCharges.map((day) => (
        <li key={day.date}>
          <div className="flex items-baseline justify-between">
            <DateOnlyText value={day.date} className="text-small font-medium text-text-primary" />
            <span className="text-caption text-text-muted">
              {day.outflow.minor !== '0' && <Money value={day.outflow} className="mr-2" />}
              {day.inflow.minor !== '0' && <Money value={day.inflow} />}
            </span>
          </div>
          <ul className="mt-1 flex flex-col gap-1">
            {day.charges.map((charge) => (
              <li
                key={`${charge.seriesId}-${charge.date}`}
                className="flex items-center justify-between rounded-md bg-bg-subtle px-2.5 py-1.5 text-small"
              >
                <span className="truncate text-text-secondary">{nameOf(charge.merchantId)}</span>
                <Money value={charge.expected} className="shrink-0" />
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}
