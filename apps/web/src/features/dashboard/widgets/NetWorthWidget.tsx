// SPDX-License-Identifier: MIT
import { useState } from 'react';

import { useNetWorthSeriesPeriodQuery } from '../../networth/api.ts';
import { NetWorthDashboardSection } from '../../networth/NetWorthChart.tsx';
import { NetWorthHero } from '../../networth/NetWorthHero.tsx';
import { heroSelectionOf, type NetWorthSelection } from '../../networth/NetWorthStackedCharts.tsx';
import { PeriodChips } from '../../networth/PeriodChips.tsx';
import {
  DEFAULT_DASHBOARD_PERIOD,
  type DashboardPeriod,
  type NetWorthRange,
} from '../../networth/search.ts';
import { DashboardWidgetCard, type WidgetState } from '../DashboardWidgetCard.tsx';

/** Re-exported where WP 10.9 put it; the component lives with the net-worth feature since WP 10.13. */
export { NetWorthHero };

export interface NetWorthWidgetProps {
  /** URL-synced range for the full-history dialog (`_app.index.tsx`'s `netWorthRange`). */
  readonly range?: NetWorthRange;
  readonly onRangeChange?: (range: NetWorthRange) => void;
}

/**
 * Net worth (WP 10.9): the hero figure with its change over the chosen period, the chips, the chart — since
 * WP 10.13 stacked by account type with the net line over it, scrubbable, the hero following the scrub.
 */
export function NetWorthWidget({ range, onRangeChange }: NetWorthWidgetProps) {
  const [period, setPeriod] = useState<DashboardPeriod>(DEFAULT_DASHBOARD_PERIOD);
  const [selection, setSelection] = useState<NetWorthSelection | null>(null);
  const query = useNetWorthSeriesPeriodQuery(period);
  // The body renders once there is an answer (the hero says "—" and the chart says why when there is nothing). A
  // failed read is the error state, *not* the body: the body's hero and chart are observers of the same query, and
  // mounting them over an errored query refetches it (TanStack's retry-on-mount), which flipped this card to
  // loading, unmounted them, failed again and remounted them — a render loop found by DashboardScreen.test.tsx.
  const state: WidgetState = query.isError
    ? { kind: 'error', message: "Net worth history isn't available right now." }
    : query.data === undefined
      ? { kind: 'loading' }
      : { kind: 'ready' };

  return (
    <DashboardWidgetCard
      id="net-worth"
      title="Net worth"
      seeAll={{ to: '/accounts', label: 'Accounts' }}
      state={state}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <NetWorthHero period={period} selection={heroSelectionOf(query.data, period, selection)} />
        <PeriodChips
          value={period}
          onChange={(next) => {
            setSelection(null);
            setPeriod(next);
          }}
        />
      </div>
      <NetWorthDashboardSection
        className="mt-4"
        period={period}
        selection={selection}
        onSelectionChange={setSelection}
        {...(range === undefined ? {} : { range })}
        {...(onRangeChange === undefined ? {} : { onRangeChange })}
      />
    </DashboardWidgetCard>
  );
}
