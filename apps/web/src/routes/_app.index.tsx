// SPDX-License-Identifier: MIT
import { createFileRoute } from '@tanstack/react-router';

import { Percent } from '../components/finance/Percent.tsx';
import { StatTile } from '../components/finance/StatTile.tsx';
import { Card } from '../components/ui/card.tsx';
import { NetWorthAreaChart } from '../charts/NetWorthAreaChart.tsx';
import { Money } from '../components/finance/Money.tsx';
import { TopInsightsWidget } from '../features/insights/TopInsightsWidget.tsx';

export const Route = createFileRoute('/_app/')({
  component: DashboardRoute,
});

/**
 * `/` — Dashboard. The hero net-worth stat and the 90-day area chart, which
 * together prove the visx pipeline end to end. The cash-flow card,
 * needs-attention strip and upcoming bills wait on features that read real
 * data.
 */
function DashboardRoute() {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <Card padding="default">
        <StatTile
          label="Net worth"
          size="hero"
          value={<Money value={{ minor: '8890400', currency: 'USD' }} colorBySign={false} />}
          delta={
            <span className="inline-flex items-center gap-1.5">
              <Money value={{ minor: '421000', currency: 'USD' }} />
              <Percent value={0.021} colorBySign />
              <span className="text-text-muted">this month</span>
            </span>
          }
        />
        <NetWorthAreaChart className="mt-4" />
      </Card>
      <TopInsightsWidget />
    </div>
  );
}
