// SPDX-License-Identifier: MIT
import { Link } from '@tanstack/react-router';

import type { BudgetVsActualLine } from '../../api/generated/types.gen.ts';
import { Money } from '../../components/finance/Money.tsx';
import { toTransactionsSearch } from './drill-through.ts';
import { ScrollRegion } from '../../components/patterns/ScrollRegion.tsx';

export interface BudgetVsActualTableProps {
  lines: readonly BudgetVsActualLine[];
}

/**
 * Budget-vs-actual, one row per category line (`GET /reports/budget-vs-actual`
 * — `kind: 'category'` only, per `wp2.8-reports.md` §3: "CCP lines are a
 * budgeting-screen concern, not a report"). Every row's name is a link to
 * the filtered transaction list via its own `drillThrough`.
 */
export function BudgetVsActualTable({ lines }: BudgetVsActualTableProps) {
  if (lines.length === 0) {
    return <p className="text-small text-text-muted">No budget lines for this period.</p>;
  }

  return (
    <ScrollRegion label="Budget versus actual by category">
      <table className="w-full border-collapse text-small">
        <caption className="sr-only">Budget versus actual by category, this period</caption>
        <thead>
          <tr className="border-b border-border-hairline text-left text-caption text-text-muted">
            <th scope="col" className="py-2 pr-2">
              Category
            </th>
            <th scope="col" className="py-2 pr-2 text-right">
              Assigned
            </th>
            <th scope="col" className="py-2 pr-2 text-right">
              Activity
            </th>
            <th scope="col" className="py-2 pr-2 text-right">
              Available
            </th>
            <th scope="col" className="py-2 text-right">
              Overspend
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => {
            const cashOver = line.cashOverspend.minor !== '0';
            const creditOver = line.creditOverspend.minor !== '0';
            return (
              <tr key={line.id} className="border-b border-border-hairline last:border-0">
                <th scope="row" className="py-2 pr-2 text-left font-medium text-text-primary">
                  <Link
                    to="/transactions"
                    search={toTransactionsSearch(line.drillThrough)}
                    className="hover:underline"
                  >
                    {line.name ?? 'Category'}
                  </Link>
                </th>
                <td className="py-2 pr-2 text-right tabular-nums">
                  <Money value={line.assigned} />
                </td>
                <td className="py-2 pr-2 text-right tabular-nums">
                  <Money value={line.activity} />
                </td>
                <td className="py-2 pr-2 text-right tabular-nums">
                  <Money value={line.available} />
                </td>
                <td className="py-2 text-right">
                  {cashOver && (
                    <span className="inline-block rounded bg-danger px-1.5 py-0.5 text-caption text-on-danger">
                      Cash
                    </span>
                  )}
                  {creditOver && (
                    <span className="ml-1 inline-block rounded bg-status-warning px-1.5 py-0.5 text-caption text-on-status-warning">
                      Credit
                    </span>
                  )}
                  {!cashOver && !creditOver && <span aria-hidden="true">—</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </ScrollRegion>
  );
}
