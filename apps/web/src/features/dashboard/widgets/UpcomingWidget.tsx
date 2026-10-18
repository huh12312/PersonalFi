// SPDX-License-Identifier: MIT
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';

import {
  getRecurringUpcomingOptions,
  getSafeToSpendOptions,
} from '../../../api/generated/@tanstack/react-query.gen.ts';
import { Money } from '../../../components/finance/Money.tsx';
import { StatTile } from '../../../components/finance/StatTile.tsx';
import { formatDateOnly } from '../../../lib/date.ts';
import { parseWireMoney } from '../../../lib/money.ts';
import { useMerchantNames } from '../../recurring/useMerchantNames.ts';
import { DashboardWidgetCard, type WidgetState } from '../DashboardWidgetCard.tsx';
import { wire } from './pace.ts';
import { chargesWithin, lowestBalance } from './upcoming.ts';

/** How far the list looks ahead. The balance projection uses the whole 30-day calendar, as the Recurring screen. */
export const UPCOMING_LIST_DAYS = 7;
const CALENDAR_DAYS = 30;

/**
 * Upcoming (WP 10.9; Monarch's Pulse): the charges expected in the next seven days, Safe to spend (the figure the
 * Recurring screen's Forward cash flow card shows, WP 10.7 — the same request), and, when the projected balance
 * would go below zero inside the 30-day window, a warning in words naming how low and when.
 */
export function UpcomingWidget() {
  // The same two requests (same query keys) `RecurringScreen` makes, so the cache serves both screens.
  const upcomingQuery = useQuery(getRecurringUpcomingOptions({ query: { days: CALENDAR_DAYS } }));
  const safeQuery = useQuery(getSafeToSpendOptions({ query: {} }));
  const calendar = upcomingQuery.data;
  const safe = safeQuery.data;
  const charges = calendar === undefined ? [] : chargesWithin(calendar, UPCOMING_LIST_DAYS);
  const { nameOf } = useMerchantNames(charges.map((entry) => entry.charge.merchantId));

  const state: WidgetState =
    upcomingQuery.isLoading || safeQuery.isLoading
      ? { kind: 'loading' }
      : upcomingQuery.isError || calendar === undefined
        ? { kind: 'error', message: "Upcoming charges aren't available right now." }
        : calendar.chargeCount === 0
          ? {
              kind: 'empty',
              message:
                'No recurring charges are expected in the next 30 days: none has been detected or confirmed yet.',
              fix: { to: '/recurring', label: 'Review recurring' },
            }
          : { kind: 'ready' };

  const lowest =
    calendar === undefined || safe === undefined
      ? null
      : lowestBalance(parseWireMoney(safe.availableCash), calendar);
  const overdraft = lowest !== null && lowest.balance.minor < 0n;

  return (
    <DashboardWidgetCard
      id="upcoming"
      title="Upcoming"
      subtitle="The next 7 days"
      seeAll={{ to: '/recurring', label: 'See all' }}
      state={state}
    >
      {safe !== undefined && (
        <StatTile
          label="Safe to spend"
          size="display"
          value={<Money value={safe.safe} signDisplay="auto" colorBySign />}
          hint="Cash on hand, less the worst case of every charge due"
        />
      )}
      {overdraft && lowest !== null && (
        <p
          role="status"
          className="mt-3 flex items-start gap-1.5 rounded-md border border-status-danger-border bg-status-danger-bg px-3 py-2 text-small text-status-danger-text"
          data-testid="overdraft-warning"
        >
          <AlertTriangle size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
          <span>
            Your cash could run short: the projected balance falls to{' '}
            <Money
              value={wire(lowest.balance)}
              signDisplay="auto"
              colorBySign={false}
              className="font-semibold"
            />{' '}
            on {formatDateOnly(lowest.date, 'EEE, MMM d')}, counting every expected charge and
            income.
          </span>
        </p>
      )}
      {charges.length === 0 ? (
        <p className="mt-3 text-small text-text-secondary">
          Nothing is expected in the next 7 days.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-1.5" aria-label="Expected in the next 7 days">
          {charges.map(({ date, charge }) => (
            <li
              key={`${charge.seriesId}-${date}-${String(charge.slot)}`}
              className="flex items-baseline justify-between gap-3 text-small"
            >
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="w-14 shrink-0 text-caption text-text-muted tabular-nums">
                  {formatDateOnly(date, 'EEE d')}
                </span>
                <span className="truncate text-text-primary">{nameOf(charge.merchantId)}</span>
              </span>
              <Money value={charge.expected} className="shrink-0" />
            </li>
          ))}
        </ul>
      )}
    </DashboardWidgetCard>
  );
}
