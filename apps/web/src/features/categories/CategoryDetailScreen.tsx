// SPDX-License-Identifier: MIT
import { Link } from '@tanstack/react-router';
import { AlertTriangle, ChevronLeft, ChevronRight, Pencil, Tags } from 'lucide-react';
import { useId, useMemo, useState } from 'react';

import type { Category } from '../../api/generated/types.gen.ts';
import { CategoryIcon } from '../../components/finance/CategoryIcon.tsx';
import { iconHue } from '../../components/finance/category-icon.ts';
import { Money } from '../../components/finance/Money.tsx';
import { EmptyState } from '../../components/patterns/EmptyState.tsx';
import { Skeleton } from '../../components/patterns/Skeleton.tsx';
import { Button } from '../../components/ui/button.tsx';
import { Card } from '../../components/ui/card.tsx';
import { useAccountsLookup } from '../accounts/useAccountsLookup.ts';
import { VARIABILITY_LABELS } from '../budget/variability.ts';
import { BulkActionBar } from '../transactions/BulkActionBar.tsx';
import { TransactionDetailSheet } from '../transactions/TransactionDetailSheet.tsx';
import { TransactionsList } from '../transactions/TransactionsList.tsx';
import { useCategoryHistory } from './api.ts';
import { CategoryHistoryChart } from './CategoryHistoryChart.tsx';
import { CreateCategoryDialog } from './CreateCategoryDialog.tsx';
import {
  comparisonSentence,
  historyOf,
  indexOfMonth,
  monthFilter,
  monthLabel,
  monthSentence,
  type HistoryView,
} from './history.ts';
import { useCategories } from './useCategories.ts';

export interface CategoryDetailScreenProps {
  readonly categoryId: string;
  /** The selected month (`YYYY-MM`) from the URL; absent = the current month. */
  readonly month: string | undefined;
  readonly onMonthChange: (month: string) => void;
}

const KIND_LABEL: Record<Category['kind'], string> = {
  expense: 'Expense',
  income: 'Income',
  transfer: 'Transfer',
  investment: 'Investing',
  other: 'Other',
};

function BackLink() {
  return (
    <Link
      to="/cash-flow"
      className="inline-flex min-h-6 items-center gap-0.5 text-small text-accent-text underline-offset-4 hover:underline"
    >
      <ChevronLeft size={14} aria-hidden="true" />
      Cash flow
    </Link>
  );
}

/**
 * `/categories/:id` (WP 10.14, V7; Monarch's equivalent). The header names the category (its icon in a
 * circle of its hue, its group and kind, its variability) with an Edit button; the hero is this month so far with
 * the sentence "This month vs. average month (last 12 months)"; the chart is the trailing 12 complete months and this
 * one, with the dashed average; selecting a month filters the transactions beneath — the `/transactions` list
 * itself (`TransactionsList`, its bulk bar and detail sheet), not a copy — to the category and that month. The
 * selected month is URL state.
 */
export function CategoryDetailScreen({
  categoryId,
  month,
  onMonthChange,
}: CategoryDetailScreenProps) {
  const { byId, categories, isLoading: categoriesLoading } = useCategories();
  const history = useCategoryHistory(categoryId);
  const category = byId.get(categoryId);
  const [editing, setEditing] = useState(false);

  if (categoriesLoading || history.isLoading) {
    return (
      <div
        className="mx-auto flex w-full max-w-4xl flex-col gap-4"
        data-testid="category-detail-loading"
      >
        <Skeleton height={72} variant="block" />
        <Skeleton height={300} variant="block" />
      </div>
    );
  }
  if (category === undefined) {
    return (
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
        <BackLink />
        <EmptyState
          icon={Tags}
          headline="Category not found"
          description="It may have been archived, or the link is out of date."
        />
      </div>
    );
  }
  if (history.isError || history.data === undefined) {
    return (
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
        <BackLink />
        <EmptyState
          icon={AlertTriangle}
          headline="Couldn't load this category's history"
          description="Something went wrong. Try again."
          action={{ label: 'Retry', onClick: () => void history.refetch() }}
        />
      </div>
    );
  }

  const view = historyOf(history.data);
  const parent = category.parentId === null ? null : (byId.get(category.parentId) ?? null);
  const childIds = categories.filter((c) => c.parentId === category.id).map((c) => c.id);
  const ids = history.data.drillThrough?.categoryIds ?? [category.id, ...childIds];

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4" data-testid="category-detail">
      <BackLink />
      <CategoryHeader category={category} parent={parent} onEdit={() => setEditing(true)} />
      <CategoryBody
        category={category}
        view={view}
        ids={ids}
        month={month}
        onMonthChange={onMonthChange}
      />
      <CreateCategoryDialog
        open={editing}
        onOpenChange={setEditing}
        category={category}
        initialLabel={category.label}
        headings={[]}
      />
    </div>
  );
}

function CategoryHeader({
  category,
  parent,
  onEdit,
}: {
  readonly category: Category;
  readonly parent: Category | null;
  readonly onEdit: () => void;
}) {
  const variability = category.variability ?? null;
  return (
    <Card padding="default">
      <div className="flex flex-wrap items-center gap-3" data-testid="category-header">
        <CategoryIcon category={category} size="md" />
        <div className="min-w-0 flex-1">
          <h2 className="break-words text-h2 font-semibold text-text-primary">{category.label}</h2>
          <p className="text-small text-text-secondary">
            {parent === null ? 'Top-level category' : `In ${parent.label}`} ·{' '}
            {KIND_LABEL[category.kind]}
            {category.kind === 'expense' && (
              <>
                {' · '}
                <span
                  className="inline-flex items-center rounded-full border border-border-secondary bg-bg-secondary px-2 py-0.5 text-caption font-medium text-text-secondary"
                  data-testid="category-variability-chip"
                >
                  {variability === null ? 'Unclassified' : VARIABILITY_LABELS[variability]}
                </span>
              </>
            )}
          </p>
        </div>
        <Button variant="secondary" className="gap-1.5" onClick={onEdit}>
          <Pencil size={14} aria-hidden="true" />
          Edit
          <span className="sr-only"> {category.label}</span>
        </Button>
      </div>
    </Card>
  );
}

function CategoryBody({
  category,
  view,
  ids,
  month,
  onMonthChange,
}: {
  readonly category: Category;
  readonly view: HistoryView;
  readonly ids: readonly string[];
  readonly month: string | undefined;
  readonly onMonthChange: (month: string) => void;
}) {
  const headingId = useId();
  const { nameOf } = useAccountsLookup();
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [openTransactionId, setOpenTransactionId] = useState<string | null>(null);
  const selected = indexOfMonth(view, month);
  const selectedMonth = view.months[selected];
  const current = view.months.find((entry) => entry.isCurrent);
  const sentence = comparisonSentence(view);
  const currency = view.currency;
  const search = useMemo(
    () =>
      selectedMonth === undefined ? { categoryIds: [...ids] } : monthFilter(ids, selectedMonth),
    [ids, selectedMonth],
  );
  const signed = (minor: bigint) => (view.side === 'income' ? minor : -minor);

  return (
    <>
      <Card padding="default">
        <section aria-labelledby={headingId} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1" data-testid="category-hero">
            <h3 id={headingId} className="text-small font-medium text-text-secondary">
              {view.side === 'income' ? 'Received' : 'Spent'} this month so far
            </h3>
            {currency === null || current === undefined ? (
              <p className="text-small text-text-muted">No transactions in this category yet.</p>
            ) : (
              <Money
                value={{ minor: signed(current.amountMinor).toString(), currency }}
                signDisplay="auto"
                className="text-[2.25rem] font-semibold leading-tight tabular-nums"
                data-testid="category-hero-amount"
              />
            )}
            <p className="text-caption font-medium text-text-secondary">{sentence.heading}</p>
            <p
              className={
                sentence.withheld ? 'text-small text-text-muted' : 'text-small text-text-primary'
              }
              data-testid="category-comparison"
              data-withheld={sentence.withheld ? 'true' : 'false'}
            >
              {sentence.text}
            </p>
            {view.otherCurrencies.length > 0 && (
              <p className="text-caption text-text-muted">
                Shown in {currency}; also has transactions in {view.otherCurrencies.join(', ')}, not
                converted or added.
              </p>
            )}
          </div>

          {currency !== null && (
            <>
              <div
                className="flex flex-col gap-0.5 rounded-md bg-bg-secondary px-3 py-2 text-small"
                data-testid="category-readout"
              >
                <p className="font-medium text-text-primary">{monthSentence(view, selected)}</p>
                {selectedMonth !== undefined && selectedMonth.inHistory && (
                  <p className="text-caption text-text-secondary">
                    {selectedMonth.transactionCount}{' '}
                    {selectedMonth.transactionCount === 1 ? 'transaction' : 'transactions'}
                  </p>
                )}
              </div>
              <CategoryHistoryChart
                view={view}
                hue={iconHue(category)}
                title={`${category.label} by month`}
                selected={selected}
                onSelect={(index) => {
                  const next = view.months[index];
                  if (next !== undefined) onMonthChange(next.month);
                }}
              />
            </>
          )}
        </section>
      </Card>

      <section aria-labelledby={`${headingId}-transactions`} className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3
            id={`${headingId}-transactions`}
            className="text-h3 font-semibold text-text-primary"
            data-testid="category-transactions-heading"
          >
            Transactions
            {selectedMonth === undefined ? '' : ` in ${monthLabel(selectedMonth)}`}
          </h3>
          <Link
            to="/transactions"
            search={search}
            className="inline-flex min-h-6 items-center gap-0.5 text-small text-accent-text underline-offset-4 hover:underline"
            data-testid="category-see-transactions"
          >
            See transactions
            <ChevronRight size={14} aria-hidden="true" />
          </Link>
        </div>
        <BulkActionBar selectedIds={[...checked]} onClear={() => setChecked(new Set())} />
        <TransactionsList
          search={search}
          accountName={nameOf}
          selected={checked}
          onToggleSelect={(id) =>
            setChecked((prev) => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })
          }
          onOpen={setOpenTransactionId}
          onClearFilters={() => onMonthChange(view.currentMonth)}
        />
        <TransactionDetailSheet
          transactionId={openTransactionId}
          accountName={nameOf}
          onOpenChange={(open) => {
            if (!open) setOpenTransactionId(null);
          }}
        />
      </section>
    </>
  );
}
