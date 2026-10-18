// SPDX-License-Identifier: MIT
import type { ReactNode } from 'react';

import type { NetWorthRange } from '../../networth/search.ts';
import type { WidgetId } from '../layout.ts';
import { BudgetsWidget } from './BudgetsWidget.tsx';
import { GoalsWidget } from './GoalsWidget.tsx';
import { InvestmentsWidget } from './InvestmentsWidget.tsx';
import { NetWorthWidget } from './NetWorthWidget.tsx';
import { SpendingPaceWidget } from './SpendingPaceWidget.tsx';
import { ToReviewWidget } from './ToReviewWidget.tsx';
import { TopInsightsDashboardWidget } from './TopInsightsDashboardWidget.tsx';
import { UpcomingWidget } from './UpcomingWidget.tsx';

export interface WidgetContext {
  readonly netWorthRange?: NetWorthRange;
  readonly onNetWorthRangeChange?: (range: NetWorthRange) => void;
}

/** Each widget id → the self-contained component that draws it (each owns its own query and its own states). */
export function renderWidget(id: WidgetId, context: WidgetContext): ReactNode {
  switch (id) {
    case 'net-worth':
      return (
        <NetWorthWidget
          {...(context.netWorthRange === undefined ? {} : { range: context.netWorthRange })}
          {...(context.onNetWorthRangeChange === undefined
            ? {}
            : { onRangeChange: context.onNetWorthRangeChange })}
        />
      );
    case 'spending-pace':
      return <SpendingPaceWidget />;
    case 'budgets':
      return <BudgetsWidget />;
    case 'upcoming':
      return <UpcomingWidget />;
    case 'to-review':
      return <ToReviewWidget />;
    case 'goals':
      return <GoalsWidget />;
    case 'investments':
      return <InvestmentsWidget />;
    case 'top-insights':
      return <TopInsightsDashboardWidget />;
  }
}
