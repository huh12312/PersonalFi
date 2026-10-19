// SPDX-License-Identifier: MIT
import { Link } from '@tanstack/react-router';
import type { BlockDocument } from '../../api/generated/types.gen.ts';
import { Download } from 'lucide-react';
import { useMemo, useState } from 'react';

import { useCurrentBudgetPeriodQuery } from '../budget/api.ts';
import { Button } from '../../components/ui/button.tsx';
import { Skeleton } from '../../components/patterns/Skeleton.tsx';
import { Tabs, TabsIndicator, TabsList, TabsPanel, TabsTab } from '../../components/ui/tabs.tsx';
import { categoryHue, type FillHue } from '../../components/finance/chart-hue.ts';
import { useCategories } from '../categories/useCategories.ts';
import { BlockDocumentView } from '../../components/blocks/BlockRenderer.tsx';
import {
  useBudgetVsActualReportBlocksQuery,
  useExportBundle,
  useIncomeReportBlocksQuery,
  useSankeyReportQuery,
  useSpendingReportBlocksQuery,
  type ReportWindow,
} from './api.ts';
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

  // WP 10.15 (V8): Spending, Income and Budget vs. actual arrive as blocks built by the API from the same report
  // routes' figures; the Sankey stays its own component (no block).
  const spendingQuery = useSpendingReportBlocksQuery(window);
  const incomeQuery = useIncomeReportBlocksQuery(window);
  const sankeyQuery = useSankeyReportQuery(window);
  const currentPeriodQuery = useCurrentBudgetPeriodQuery();
  const budgetVsActualQuery = useBudgetVsActualReportBlocksQuery(
    currentPeriodQuery.data?.period.id,
  );
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
        <p role="alert" className="text-small text-status-danger-text">
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
            <ReportBlocks
              document={spendingQuery.data}
              failed={spendingQuery.isError}
              testId="report-blocks-spending"
            />
          )}
        </TabsPanel>

        <TabsPanel value="income">
          {incomeQuery.isLoading ? (
            <Skeleton variant="block" height={280} />
          ) : (
            <ReportBlocks
              document={incomeQuery.data}
              failed={incomeQuery.isError}
              testId="report-blocks-income"
            />
          )}
        </TabsPanel>

        <TabsPanel value="sankey">
          <p className="mb-2 text-small">
            <Link
              to="/cash-flow"
              className="text-accent-text underline-offset-4 hover:underline"
              data-testid="open-in-cash-flow"
            >
              Open in Cash Flow →
            </Link>{' '}
            <span className="text-text-secondary">
              — the same flow by month, quarter or year, with income, expenses, savings rate and
              comparisons.
            </span>
          </p>
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
          {budgetVsActualQuery.isLoading || currentPeriodQuery.isLoading ? (
            <Skeleton variant="block" height={280} />
          ) : currentPeriodQuery.data === undefined ? (
            <p className="text-small text-text-muted">No budget lines for this period.</p>
          ) : (
            <ReportBlocks
              document={budgetVsActualQuery.data}
              failed={budgetVsActualQuery.isError}
              testId="report-blocks-budget-vs-actual"
            />
          )}
        </TabsPanel>
      </Tabs>
    </div>
  );
}

/** One report section's blocks, or why there are none. */
function ReportBlocks({
  document,
  failed,
  testId,
}: {
  readonly document: BlockDocument | undefined;
  readonly failed: boolean;
  readonly testId: string;
}) {
  if (failed) {
    return (
      <p role="alert" className="text-small text-text-secondary">
        This report could not be loaded.
      </p>
    );
  }
  if (document === undefined) return <Skeleton variant="block" height={280} />;
  return <BlockDocumentView document={document} headingLevel={3} testId={testId} />;
}
