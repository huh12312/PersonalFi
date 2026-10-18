// SPDX-License-Identifier: MIT
import { ArrowDownRight, ArrowUpRight, Equal } from 'lucide-react';

import type { CashFlow } from '../../api/generated/types.gen.ts';
import { Money } from '../../components/finance/Money.tsx';
import { cn } from '../../lib/cn.ts';
import {
  COMPARISON_LABELS,
  comparisonOf,
  figureName,
  figuresFor,
  savingsRateOf,
  signedFigureMinor,
  type ComparisonLine,
} from './figures.ts';
import { COMPARISONS, type CashFlowTab, type Comparison, type Timeframe } from './view.ts';

/**
 * The summary strip (Income · Expenses · Net cash flow · Savings rate on the Cash flow tab; the one side on Income
 * and Spending) and the comparison row beneath it (WP 10.10). Figures are signed by the house rule — money in
 * positive, money out negative — and coloured by the sign roles; "so far" on the current period. The savings rate
 * is a percentage only for a complete period with income; otherwise its tile says why not.
 */
export function SummaryStrip({
  data,
  tab,
  timeframe,
}: {
  readonly data: CashFlow;
  readonly tab: CashFlowTab;
  readonly timeframe: Timeframe;
}) {
  const currency = data.currency ?? 'USD';
  const soFar = data.isCurrent ? ' so far' : '';
  const rate = savingsRateOf(data.summary, timeframe);
  return (
    <dl
      className={cn(
        'grid gap-3',
        tab === 'cash-flow' ? 'grid-cols-1 min-[420px]:grid-cols-2 lg:grid-cols-4' : 'grid-cols-1',
      )}
      data-testid="cash-flow-strip"
    >
      {figuresFor(tab).map((figure) => (
        <div
          key={figure}
          className="rounded-lg border border-border-hairline bg-bg-surface p-4"
          data-figure={figure}
        >
          <dt className="text-caption text-text-secondary">
            {figureName(figure)}
            {soFar}
          </dt>
          <dd className="mt-1 text-h2 font-semibold">
            <Money
              value={{ minor: signedFigureMinor(data.summary, figure).toString(), currency }}
              signDisplay={figure === 'net' ? 'exceptZero' : 'auto'}
            />
          </dd>
        </div>
      ))}
      {tab === 'cash-flow' && (
        <div
          className="rounded-lg border border-border-hairline bg-bg-surface p-4"
          data-figure="savings-rate"
        >
          <dt className="text-caption text-text-secondary">Savings rate</dt>
          {rate.kind === 'shown' ? (
            <dd
              className={cn(
                'mt-1 text-h2 font-semibold tabular-nums',
                rate.rate < 0 ? 'text-money-neg-text' : 'text-text-primary',
              )}
            >
              {rate.text}
            </dd>
          ) : (
            <dd className="mt-1 text-small text-text-muted" data-testid="savings-rate-withheld">
              {rate.reason}
            </dd>
          )}
        </div>
      )}
    </dl>
  );
}

const TONE_CLASS = {
  good: 'text-status-success-text',
  bad: 'text-status-danger-text',
  neutral: 'text-text-secondary',
} as const;

function LineIcon({ line }: { readonly line: ComparisonLine }) {
  const Icon =
    line.direction === 'up' ? ArrowUpRight : line.direction === 'down' ? ArrowDownRight : Equal;
  return (
    <Icon size={16} aria-hidden="true" className={cn('mt-0.5 shrink-0', TONE_CLASS[line.tone])} />
  );
}

/** The three framings, one shown at a time, each in money with a direction word — or withheld with the reason. */
export function ComparisonRow({
  data,
  tab,
  timeframe,
  compare,
  onCompareChange,
}: {
  readonly data: CashFlow;
  readonly tab: CashFlowTab;
  readonly timeframe: Timeframe;
  readonly compare: Comparison;
  readonly onCompareChange: (next: Comparison) => void;
}) {
  const comparison = data.comparisons.find((candidate) => candidate.kind === compare);
  const result =
    comparison === undefined ? null : comparisonOf(data, comparison, figuresFor(tab), timeframe);
  return (
    <div
      className="rounded-lg border border-border-hairline bg-bg-surface p-4"
      data-testid="cash-flow-comparison"
    >
      <div role="group" aria-label="Compare with" className="flex flex-wrap gap-1">
        {COMPARISONS.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={option === compare}
            onClick={() => onCompareChange(option)}
            className={cn(
              'inline-flex h-8 items-center justify-center rounded-md px-2.5 text-xs font-medium',
              option === compare
                ? 'bg-bg-secondary text-text-primary ring-1 ring-border-primary'
                : 'text-text-secondary hover:bg-bg-subtle',
            )}
          >
            {COMPARISON_LABELS[option](timeframe)}
          </button>
        ))}
      </div>
      <div className="mt-3" aria-live="polite">
        {result === null ? null : result.kind === 'withheld' ? (
          <p className="text-small text-text-muted" data-testid="comparison-withheld">
            {result.reason}
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {result.lines.map((line) => (
              <li key={line.figure} className="flex items-start gap-2 text-small text-text-primary">
                <LineIcon line={line} />
                <span>{line.text}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
