// SPDX-License-Identifier: MIT
import { Link } from '@tanstack/react-router';
import { Download } from 'lucide-react';
import { useMemo, useState } from 'react';

import { useCurrentBudgetPeriodQuery } from '../budget/api.ts';
import { Button } from '../../components/ui/button.tsx';
import { Skeleton } from '../../components/patterns/Skeleton.tsx';
import { Tabs, TabsIndicator, TabsList, TabsPanel, TabsTab } from '../../components/ui/tabs.tsx';
import { categoryHue, type FillHue } from '../../components/finance/chart-hue.ts';
import { useCategories } from '../categories/useCategories.ts';
import {
  useBudgetVsActualReportQuery,
  useExportBundle,
  useIncomeReportQuery,
  useSankeyReportQuery,
  useSpendingReportQuery,
  type ReportWindow,
} from './api.ts';
import { BudgetVsActualTable } from './BudgetVsActualTable.tsx';
import { CategoryMonthBarChart } from './charts/CategoryMonthBarChart.tsx';
import { SankeyChart } from './charts/SankeyChart.tsx';

const WINDOW_OPTIONS = [
  { months: 3, label: 'Last 3 months' },
  { months: 6, label: 'Last 6 months' },
  { months: 12, label: 'Last 12 months' },
];

function windowFor(months: number, today: Date): ReportWindow {
  const to = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
  const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1 - months, 1));
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

/**
 * `/reports` — spending/income by category and month (stacked bars),
 * a cash-flow Sankey, and budget-vs-actual for the current period, every
 * cell/link/row drilling through to `/transactions` (`drill-through.ts`).
 * Export ("download my data") sits here rather than a settings screen
 * because `wp2.8-reports.md` §8 explicitly names it as "available if
 * wanted" for this work package and nowhere else claims it.
 */
export function ReportsScreen() {
  const [months, setMonths] = useState(6);
  const window = useMemo(() => windowFor(months, new Date()), [months]);

  const { byId: categoriesById } = useCategories();
  const labelFor = (categoryId: string | null): string =>
    categoryId !== null ? (categoriesById.get(categoryId)?.label ?? categoryId) : 'Uncategorised';
  // A category's persisted hue (WP 10.8), the same on every chart; the server's seed until the list arrives.
  const hueFor = (categoryId: string | null): FillHue =>
    categoryHue(categoryId, categoryId !== null ? categoriesById.get(categoryId)?.hue : null);

  const spendingQuery = useSpendingReportQuery(window);
  const incomeQuery = useIncomeReportQuery(window);
  const sankeyQuery = useSankeyReportQuery(window);
  const currentPeriodQuery = useCurrentBudgetPeriodQuery();
  const budgetVsActualQuery = useBudgetVsActualReportQuery(currentPeriodQuery.data?.period.id);
  const exportBundle = useExportBundle();

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-h2 font-semibold text-text-primary">Reports</h2>
          <Link
            to="/budget"
            className="text-small text-accent-text underline-offset-4 hover:underline"
          >
            ← Back to budget
          </Link>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="reports-window" className="sr-only">
            Time range
          </label>
          <select
            id="reports-window"
            className="h-9 rounded-md border border-border-strong bg-bg-surface px-2 text-small"
            value={months}
            onChange={(event) => setMonths(Number(event.target.value))}
          >
            {WINDOW_OPTIONS.map((option) => (
              <option key={option.months} value={option.months}>
                {option.label}
              </option>
            ))}
          </select>
          <Button
            variant="secondary"
            size="sm"
            className="gap-1.5"
            onClick={() => void exportBundle.exportBundle()}
            disabled={exportBundle.isExporting || exportBundle.stepUpBusy}
          >
            <Download size={14} aria-hidden="true" />
            {exportBundle.isExporting || exportBundle.stepUpBusy ? 'Preparing…' : 'Export my data'}
          </Button>
        </div>
      </header>

      {exportBundle.stepUpError !== null && (
        <p role="alert" className="text-small text-status-critical">
          {exportBundle.stepUpError}
        </p>
      )}

      <Tabs defaultValue="spending">
        <TabsList aria-label="Report sections">
          <TabsTab value="spending">Spending</TabsTab>
          <TabsTab value="income">Income</TabsTab>
          <TabsTab value="sankey">Cash flow</TabsTab>
          <TabsTab value="budget-vs-actual">Budget vs. actual</TabsTab>
          <TabsIndicator />
        </TabsList>

        <TabsPanel value="spending">
          {spendingQuery.isLoading ? (
            <Skeleton variant="block" height={280} />
          ) : (
            <CategoryMonthBarChart
              cells={spendingQuery.data?.cells ?? []}
              labelFor={labelFor}
              hueFor={hueFor}
              ariaLabel="Spending by category and month"
            />
          )}
        </TabsPanel>

        <TabsPanel value="income">
          {incomeQuery.isLoading ? (
            <Skeleton variant="block" height={280} />
          ) : (
            <CategoryMonthBarChart
              cells={incomeQuery.data?.cells ?? []}
              labelFor={labelFor}
              hueFor={hueFor}
              ariaLabel="Income by category and month"
            />
          )}
        </TabsPanel>

        <TabsPanel value="sankey">
          {sankeyQuery.isLoading ? (
            <Skeleton variant="block" height={360} />
          ) : (
            <SankeyChart
              nodes={sankeyQuery.data?.nodes ?? []}
              links={sankeyQuery.data?.links ?? []}
              currency={sankeyQuery.data?.currency ?? 'USD'}
              labelFor={(node) => (node.refId !== null ? labelFor(node.refId) : undefined)}
              hueFor={hueFor}
            />
          )}
        </TabsPanel>

        <TabsPanel value="budget-vs-actual">
          {budgetVsActualQuery.isLoading ? (
            <Skeleton variant="block" height={280} />
          ) : (
            <BudgetVsActualTable lines={budgetVsActualQuery.data?.lines ?? []} />
          )}
        </TabsPanel>
      </Tabs>
    </div>
  );
}
