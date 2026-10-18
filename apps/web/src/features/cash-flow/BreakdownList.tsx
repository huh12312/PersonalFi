// SPDX-License-Identifier: MIT
import { Link } from '@tanstack/react-router';

import type { CashFlowBreakdownRow } from '../../api/generated/types.gen.ts';
import { chartEventVar, chartFillVar } from '../../components/finance/chart-hue.ts';
import { Money } from '../../components/finance/Money.tsx';
import { isChartHue } from '@core/kernel';
import { toTransactionsSearch } from '../reports/drill-through.ts';
import { foldTail, initialsOf, type FoldedRow } from './figures.ts';

const SHARE = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });

export interface BreakdownListProps {
  /** "Expenses by category" — names the list for assistive tech and heads it on screen. */
  readonly title: string;
  readonly rows: readonly CashFlowBreakdownRow[];
  readonly currency: string;
  /** 'income' shows amounts as money in; 'expenses' as money out. */
  readonly side: 'income' | 'expenses';
  /** What a folded row counts: "categories", "groups", "merchants". */
  readonly noun: string;
  /** Said when the side has nothing in the period. */
  readonly emptyText: string;
}

/**
 * One breakdown, as Monarch's horizontal bar rows (WP 10.10): a two-letter avatar tinted by the row's hue, the
 * label and its transaction count, a bar whose length is the row's share of the side's total, the amount right-aligned
 * and the share as a small secondary figure. Sorted largest first (the server's order); past twelve rows the rest
 * fold into "Other" with how many it holds. Each row drills to `/transactions` with the row's own filter (the
 * Reports drill-through, reused); "Other" and "No merchant" are not links, because no filter reaches exactly them.
 *
 * The bar is decorative — the share is printed beside it — and the hue is identity only (categories by their
 * persisted hue, merchants by `hueForId`); text never wears it (dataviz: text uses text roles).
 */
export function BreakdownList({
  title,
  rows,
  currency,
  side,
  noun,
  emptyText,
}: BreakdownListProps) {
  const folded = foldTail(rows, undefined, noun);
  if (folded.length === 0) {
    return (
      <section aria-label={title}>
        <h3 className="text-small font-semibold text-text-primary">{title}</h3>
        <p className="mt-2 text-small text-text-muted">{emptyText}</p>
      </section>
    );
  }
  return (
    <section aria-label={title}>
      <h3 className="text-small font-semibold text-text-primary">{title}</h3>
      <ul className="mt-2 flex flex-col" data-testid="breakdown-rows">
        {folded.map((row) => (
          <li key={row.key ?? 'none'} className="border-t border-border-hairline first:border-t-0">
            <BreakdownRow row={row} currency={currency} side={side} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function Avatar({ row }: { readonly row: FoldedRow }) {
  const hue = isChartHue(row.hue) ? row.hue : null;
  return (
    <span
      aria-hidden="true"
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
      style={
        hue === null
          ? { background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }
          : { background: chartEventVar('bg', hue), color: chartEventVar('fg', hue) }
      }
    >
      {row.folded !== undefined ? '+' : initialsOf(row.label)}
    </span>
  );
}

function BreakdownRow({
  row,
  currency,
  side,
}: {
  readonly row: FoldedRow;
  readonly currency: string;
  readonly side: 'income' | 'expenses';
}) {
  const share = row.share === null ? null : Math.max(0, Math.min(1, row.share));
  const signed = side === 'expenses' ? -BigInt(row.sumMinor) : BigInt(row.sumMinor);
  const fill = isChartHue(row.hue) ? chartFillVar(row.hue) : chartFillVar('neutral');
  const body = (
    <div className="flex items-center gap-3 py-2.5">
      <Avatar row={row} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="truncate text-small font-medium text-text-primary">{row.label}</span>
          <Money
            value={{ minor: signed.toString(), currency }}
            signDisplay="auto"
            colorBySign={false}
            className="shrink-0 text-small font-medium text-text-primary"
          />
        </div>
        <div className="mt-1 flex items-center gap-3">
          <div
            className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-tertiary"
            aria-hidden="true"
          >
            <div
              className="h-full rounded-full"
              data-share-bar=""
              style={{ width: `${String((share ?? 0) * 100)}%`, background: fill }}
            />
          </div>
          <span className="w-24 shrink-0 text-right text-caption tabular-nums text-text-secondary">
            {share === null ? '—' : SHARE.format(row.share ?? 0)}
            <span className="text-text-muted">
              {' · '}
              {row.count} {row.count === 1 ? 'txn' : 'txns'}
            </span>
          </span>
        </div>
      </div>
    </div>
  );
  if (row.drillThrough === null) return <div className="px-1">{body}</div>;
  return (
    <Link
      to="/transactions"
      search={toTransactionsSearch(row.drillThrough)}
      className="block rounded-md px-1 outline-none hover:bg-bg-subtle focus-visible:ring-2 focus-visible:ring-focus-ring"
    >
      {body}
      <span className="sr-only">, view transactions</span>
    </Link>
  );
}
