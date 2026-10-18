// SPDX-License-Identifier: MIT
import { Link } from '@tanstack/react-router';
import { ChevronLeft, ChevronRight, Waves } from 'lucide-react';
import type { ReactNode } from 'react';

import type { CashFlow } from '../../api/generated/types.gen.ts';
import { categoryHue, type FillHue } from '../../components/finance/chart-hue.ts';
import { EmptyState } from '../../components/patterns/EmptyState.tsx';
import { Skeleton } from '../../components/patterns/Skeleton.tsx';
import { Card } from '../../components/ui/card.tsx';
import { Tabs, TabsIndicator, TabsList, TabsPanel, TabsTab } from '../../components/ui/tabs.tsx';
import { cn } from '../../lib/cn.ts';
import { useCategories } from '../categories/useCategories.ts';
import { staleNote } from '../dashboard/widgets/freshness.ts';
import {
  useIncomeReportQuery,
  useSankeyReportQuery,
  useSpendingReportQuery,
  type ReportWindow,
} from '../reports/api.ts';
import { CategoryMonthBarChart } from '../reports/charts/CategoryMonthBarChart.tsx';
import { SankeyChart } from '../reports/charts/SankeyChart.tsx';
import { useCashFlowQuery } from './api.ts';
import { BreakdownList } from './BreakdownList.tsx';
import { CashFlowBarsChart } from './charts/CashFlowBarsChart.tsx';
import { ComparisonRow, SummaryStrip } from './CashFlowSummary.tsx';
import {
  BREAKDOWNS,
  CASH_FLOW_TABS,
  comparePeriodKeys,
  displaysFor,
  periodLabel,
  shiftPeriodKey,
  thisPeriodLabel,
  TIMEFRAMES,
  withChange,
  type Breakdown,
  type CashFlowTab,
  type CashFlowView,
  type Display,
  type Timeframe,
} from './view.ts';

const TAB_LABELS: Readonly<Record<CashFlowTab, string>> = {
  'cash-flow': 'Cash flow',
  income: 'Income',
  spending: 'Spending',
};
const DISPLAY_LABELS: Readonly<Record<Display, string>> = {
  flow: 'Flow',
  bars: 'Bars',
  categories: 'Categories',
};
const TIMEFRAME_LABELS: Readonly<Record<Timeframe, string>> = {
  month: 'Month',
  quarter: 'Quarter',
  year: 'Year',
};
const BREAKDOWN_LABELS: Readonly<Record<Breakdown, string>> = {
  category: 'By category',
  group: 'By group',
  merchant: 'By merchant',
};
const BREAKDOWN_NOUNS: Readonly<Record<Breakdown, string>> = {
  category: 'categories',
  group: 'groups',
  merchant: 'merchants',
};

function Chips<T extends string>({
  label,
  options,
  value,
  labels,
  onChange,
}: {
  readonly label: string;
  readonly options: readonly T[];
  readonly value: T;
  readonly labels: Readonly<Record<T, string>>;
  readonly onChange: (next: T) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-caption text-text-secondary" aria-hidden="true">
        {label}
      </span>
      <div role="group" aria-label={label} className="flex flex-wrap gap-1">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={option === value}
            onClick={() => onChange(option)}
            className={cn(
              'inline-flex h-8 min-w-10 items-center justify-center rounded-md px-2.5 text-xs font-medium',
              option === value
                ? 'bg-bg-secondary text-text-primary ring-1 ring-border-primary'
                : 'text-text-secondary hover:bg-bg-subtle',
            )}
          >
            {labels[option]}
          </button>
        ))}
      </div>
    </div>
  );
}

/** ‹ March 2026 › and "This month": the period, stepped by key; never past the period today is in. */
function Stepper({
  view,
  resolved,
  current,
  onChange,
}: {
  readonly view: CashFlowView;
  readonly resolved: string | null;
  readonly current: string | null;
  readonly onChange: (period: string | null) => void;
}) {
  const unit = view.timeframe;
  const atCurrent =
    resolved !== null && current !== null && comparePeriodKeys(unit, resolved, current) >= 0;
  const step = (count: number) => {
    if (resolved === null) return;
    const next = shiftPeriodKey(unit, resolved, count);
    onChange(current !== null && next === current ? null : next);
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => step(-1)}
        disabled={resolved === null}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-bg-subtle disabled:opacity-50"
      >
        <ChevronLeft size={16} aria-hidden="true" />
        <span className="sr-only">Previous {unit}</span>
      </button>
      <span
        className="min-w-[8.5rem] text-center text-small font-semibold text-text-primary"
        aria-live="polite"
        data-testid="cash-flow-period"
      >
        {resolved === null ? '…' : periodLabel(unit, resolved)}
      </span>
      <button
        type="button"
        onClick={() => step(1)}
        disabled={resolved === null || atCurrent}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-bg-subtle disabled:opacity-50"
      >
        <ChevronRight size={16} aria-hidden="true" />
        <span className="sr-only">Next {unit}</span>
      </button>
      {view.period !== null && (
        <button
          type="button"
          onClick={() => onChange(null)}
          className="inline-flex h-8 items-center rounded-md px-2.5 text-xs font-medium text-accent-text hover:bg-bg-subtle"
        >
          {thisPeriodLabel(unit)}
        </button>
      )}
    </div>
  );
}

/** The months the categories chart reads: twelve monthly stacks ending with the period (a year: its own months). */
function categoriesWindow(data: CashFlow): ReportWindow {
  if (data.timeframe === 'year') return { from: data.start, to: data.end };
  const months = data.timeframe === 'month' ? 12 : 4;
  const first = data.bars[data.bars.length - months] ?? data.bars[0];
  return { from: first?.from ?? data.start, to: data.end };
}

function Notes({ data }: { readonly data: CashFlow }) {
  const notes: string[] = [];
  if (data.isCurrent && data.through !== null) {
    notes.push(`${periodLabel(data.timeframe, data.period)} so far, through ${data.through}.`);
  }
  if (data.otherCurrencies.length > 0) {
    notes.push(
      `Activity in ${data.otherCurrencies.join(', ')} is not included (never converted); figures are in ${data.currency ?? ''}.`,
    );
  }
  const stale = staleNote(data.lastSyncedAt);
  if (stale !== undefined) notes.push(stale);
  if (notes.length === 0) return null;
  return (
    <ul
      className="flex flex-col gap-0.5 text-caption text-text-secondary"
      data-testid="cash-flow-notes"
    >
      {notes.map((note) => (
        <li key={note}>{note}</li>
      ))}
    </ul>
  );
}

function ChartArea({
  data,
  view,
  onSelectPeriod,
  labelFor,
  hueFor,
}: {
  readonly data: CashFlow;
  readonly view: CashFlowView;
  readonly onSelectPeriod: (period: string) => void;
  readonly labelFor: (categoryId: string | null) => string;
  readonly hueFor: (categoryId: string | null) => FillHue;
}) {
  const currency = data.currency ?? 'USD';
  const window = { from: data.start, to: data.end };
  const unit = TIMEFRAME_LABELS[view.timeframe].toLowerCase();
  // The server names every category the period touched (archived ones too); the categories list covers the rest.
  const serverLabels = new Map(
    [...data.breakdowns.expenses.category, ...data.breakdowns.income.category].flatMap((row) =>
      row.key === null ? [] : [[row.key, row.label] as const],
    ),
  );
  const labelOf = (categoryId: string | null) =>
    (categoryId === null ? undefined : serverLabels.get(categoryId)) ?? labelFor(categoryId);
  // Likewise the persisted hue, so a category is the same colour in the chart as in the list beside it.
  const serverHues = new Map(
    [...data.breakdowns.expenses.category, ...data.breakdowns.income.category].flatMap((row) =>
      row.key === null ? [] : [[row.key, row.hue] as const],
    ),
  );
  const hueOf = (categoryId: string | null): FillHue =>
    categoryId !== null && serverHues.has(categoryId)
      ? categoryHue(categoryId, serverHues.get(categoryId))
      : hueFor(categoryId);
  if (view.display === 'flow') {
    // A merchant band is named from the period's own merchant breakdown (the Sankey carries only ids).
    const merchantNames = new Map(
      data.breakdowns.expenses.merchant.flatMap((row) =>
        row.key === null ? [] : [[row.key, row.label] as const],
      ),
    );
    return (
      <FlowChart
        window={window}
        labelFor={labelOf}
        merchantLabel={(id) => merchantNames.get(id)}
        hueFor={hueOf}
      />
    );
  }
  if (view.display === 'categories') {
    return (
      <CategoriesChart
        side={view.tab === 'income' ? 'income' : 'spending'}
        window={categoriesWindow(data)}
        labelFor={labelOf}
        hueFor={hueOf}
      />
    );
  }
  const series = view.tab === 'income' ? 'income' : view.tab === 'spending' ? 'expenses' : 'both';
  const title =
    series === 'both'
      ? `Income and expenses by ${unit}, with net cash flow`
      : series === 'income'
        ? `Income by ${unit}`
        : `Expenses by ${unit}`;
  return (
    <CashFlowBarsChart
      bars={data.bars}
      timeframe={view.timeframe}
      currency={currency}
      series={series}
      selected={data.period}
      onSelect={onSelectPeriod}
      title={title}
    />
  );
}

function FlowChart({
  window,
  labelFor,
  merchantLabel,
  hueFor,
}: {
  readonly window: ReportWindow;
  readonly labelFor: (categoryId: string | null) => string;
  readonly merchantLabel: (merchantId: string) => string | undefined;
  readonly hueFor: (categoryId: string | null) => FillHue;
}) {
  const query = useSankeyReportQuery(window);
  if (query.isLoading) return <Skeleton variant="block" height={360} />;
  if (query.isError)
    return <p className="text-small text-text-muted">The flow isn't available right now.</p>;
  return (
    <SankeyChart
      nodes={query.data?.nodes ?? []}
      links={query.data?.links ?? []}
      currency={query.data?.currency ?? 'USD'}
      labelFor={(node) =>
        node.refId === null
          ? undefined
          : node.kind === 'merchant'
            ? (merchantLabel(node.refId) ?? 'Merchant')
            : labelFor(node.refId)
      }
      hueFor={hueFor}
    />
  );
}

function CategoriesChart({
  side,
  window,
  labelFor,
  hueFor,
}: {
  readonly side: 'income' | 'spending';
  readonly window: ReportWindow;
  readonly labelFor: (categoryId: string | null) => string;
  readonly hueFor: (categoryId: string | null) => FillHue;
}) {
  const spending = useSpendingReportQuery(window, side === 'spending');
  const income = useIncomeReportQuery(window, side === 'income');
  const query = side === 'income' ? income : spending;
  if (query.isLoading) return <Skeleton variant="block" height={280} />;
  if (query.isError)
    return (
      <p className="text-small text-text-muted">The category chart isn't available right now.</p>
    );
  return (
    <CategoryMonthBarChart
      cells={query.data?.cells ?? []}
      labelFor={labelFor}
      hueFor={hueFor}
      ariaLabel={
        side === 'income' ? 'Income by category and month' : 'Spending by category and month'
      }
    />
  );
}

function Breakdowns({
  data,
  view,
  onBreakdownChange,
}: {
  readonly data: CashFlow;
  readonly view: CashFlowView;
  readonly onBreakdownChange: (next: Breakdown) => void;
}) {
  const currency = data.currency ?? 'USD';
  const key = view.breakdown;
  const unitLabel = periodLabel(view.timeframe, data.period);
  const lists: ReactNode[] = [];
  if (view.tab !== 'spending') {
    lists.push(
      <BreakdownList
        key="income"
        title={`Income ${BREAKDOWN_LABELS[key].toLowerCase()}`}
        rows={data.breakdowns.income[key]}
        currency={currency}
        side="income"
        noun={BREAKDOWN_NOUNS[key]}
        emptyText={`No income in ${unitLabel}.`}
      />,
    );
  }
  if (view.tab !== 'income') {
    lists.push(
      <BreakdownList
        key="expenses"
        title={`Expenses ${BREAKDOWN_LABELS[key].toLowerCase()}`}
        rows={data.breakdowns.expenses[key]}
        currency={currency}
        side="expenses"
        noun={BREAKDOWN_NOUNS[key]}
        emptyText={`No spending in ${unitLabel}.`}
      />,
    );
  }
  return (
    <Card padding="default" data-testid="cash-flow-breakdowns">
      <Chips
        label="Breakdown"
        options={BREAKDOWNS}
        value={key}
        labels={BREAKDOWN_LABELS}
        onChange={onBreakdownChange}
      />
      <div className={cn('mt-4 grid gap-6', lists.length > 1 && 'lg:grid-cols-2')}>{lists}</div>
    </Card>
  );
}

export interface CashFlowScreenProps {
  readonly view: CashFlowView;
  readonly onViewChange: (next: CashFlowView) => void;
}

/**
 * `/cash-flow` — the Cash Flow hub (WP 10.10; Monarch's equivalent): tabs Cash flow / Income / Spending, a
 * Display by and a Timeframe chip row with a period stepper, the summary strip and its comparisons, the chart, and
 * the breakdowns by category, group and merchant. Every figure is `GET /reports/cash-flow`'s, which is Reports' own
 * spending and income over each window; the Flow and Categories displays are Reports' own charts, shared. The whole
 * view lives in the URL (`view.ts`).
 */
export function CashFlowScreen({ view, onViewChange }: CashFlowScreenProps) {
  const query = useCashFlowQuery(view.timeframe, view.period);
  const data = query.data;
  const { byId: categoriesById } = useCategories();
  const labelFor = (categoryId: string | null): string =>
    categoryId !== null
      ? (categoriesById.get(categoryId)?.label ?? 'Unknown category')
      : 'Uncategorised';
  const hueFor = (categoryId: string | null): FillHue =>
    categoryHue(categoryId, categoryId !== null ? categoriesById.get(categoryId)?.hue : null);

  const change = (patch: Partial<CashFlowView>) => onViewChange(withChange(view, patch));
  // While a step loads, the previous period stays on screen (dimmed); the stepper already names the new one.
  const showing = data !== undefined && data.timeframe === view.timeframe ? data : undefined;
  const resolved = view.period ?? showing?.currentPeriod ?? null;
  const stale = query.isPlaceholderData;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-h2 font-semibold text-text-primary">Cash flow</h2>
          <p className="text-small text-text-secondary">
            Money in and money out, period by period. Transfers between your accounts are left out.
          </p>
        </div>
        <Link
          to="/reports"
          className="text-small text-accent-text underline-offset-4 hover:underline"
        >
          Saved reports and budget vs. actual →
        </Link>
      </header>

      <Tabs value={view.tab} onValueChange={(value) => change({ tab: value as CashFlowTab })}>
        <TabsList aria-label="Cash flow views">
          {CASH_FLOW_TABS.map((tab) => (
            <TabsTab key={tab} value={tab}>
              {TAB_LABELS[tab]}
            </TabsTab>
          ))}
          <TabsIndicator />
        </TabsList>

        {CASH_FLOW_TABS.map((tab) => (
          <TabsPanel key={tab} value={tab}>
            {tab === view.tab && (
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-center md:justify-between">
                  <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                    <Chips
                      label="Display by"
                      options={displaysFor(tab)}
                      value={view.display}
                      labels={DISPLAY_LABELS}
                      onChange={(display) => change({ display })}
                    />
                    <Chips
                      label="Timeframe"
                      options={TIMEFRAMES}
                      value={view.timeframe}
                      labels={TIMEFRAME_LABELS}
                      onChange={(timeframe) => change({ timeframe })}
                    />
                  </div>
                  <Stepper
                    view={view}
                    resolved={resolved}
                    current={showing?.currentPeriod ?? null}
                    onChange={(period) => change({ period })}
                  />
                </div>

                <HubBody
                  query={query}
                  data={showing}
                  stale={stale}
                  view={view}
                  onChange={change}
                  labelFor={labelFor}
                  hueFor={hueFor}
                />
              </div>
            )}
          </TabsPanel>
        ))}
      </Tabs>
    </div>
  );
}

function HubBody({
  query,
  data,
  stale,
  view,
  onChange,
  labelFor,
  hueFor,
}: {
  readonly query: ReturnType<typeof useCashFlowQuery>;
  readonly data: CashFlow | undefined;
  readonly stale: boolean;
  readonly view: CashFlowView;
  readonly onChange: (patch: Partial<CashFlowView>) => void;
  readonly labelFor: (categoryId: string | null) => string;
  readonly hueFor: (categoryId: string | null) => FillHue;
}) {
  if (data === undefined) {
    if (query.isError) {
      return (
        <p role="alert" className="text-small text-text-muted">
          Cash flow isn't available right now. Try again in a moment.
        </p>
      );
    }
    return (
      <div role="status" aria-label="Loading cash flow" className="flex flex-col gap-4">
        <Skeleton variant="block" height={96} />
        <Skeleton variant="block" height={260} />
      </div>
    );
  }

  const label = periodLabel(view.timeframe, data.period);
  const anyHistory = data.bars.some((bar) => bar.hasData);
  if (data.currency === null || (!data.summary.hasData && !anyHistory && !data.isFuture)) {
    return (
      <EmptyState
        icon={Waves}
        headline="No transactions to show yet"
        description={`There is nothing in ${label} or the ${view.timeframe}s before it. Connect an account or import a statement and your cash flow appears here.`}
      >
        <Link
          to="/accounts/connections"
          className="text-small text-accent-text underline-offset-4 hover:underline"
        >
          Connect an account
        </Link>
      </EmptyState>
    );
  }

  return (
    <div
      className={cn('flex flex-col gap-4 transition-opacity', stale && 'opacity-60')}
      aria-busy={stale}
    >
      <Notes data={data} />
      {data.isFuture ? (
        <p className="text-small text-text-muted">{label} hasn't started yet.</p>
      ) : !data.summary.hasData ? (
        <p className="text-small text-text-muted" data-testid="cash-flow-no-data">
          No transactions in {label}. The chart below shows the {view.timeframe}s around it.
        </p>
      ) : (
        <>
          <SummaryStrip data={data} tab={view.tab} timeframe={view.timeframe} />
          <ComparisonRow
            data={data}
            tab={view.tab}
            timeframe={view.timeframe}
            compare={view.compare}
            onCompareChange={(compare) => onChange({ compare })}
          />
        </>
      )}
      <Card padding="default">
        <ChartArea
          data={data}
          view={view}
          onSelectPeriod={(period) =>
            onChange({ period: period === data.currentPeriod ? null : period })
          }
          labelFor={labelFor}
          hueFor={hueFor}
        />
      </Card>
      {data.summary.hasData && (
        <Breakdowns
          data={data}
          view={view}
          onBreakdownChange={(breakdown) => onChange({ breakdown })}
        />
      )}
    </div>
  );
}
