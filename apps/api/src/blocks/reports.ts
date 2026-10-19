// SPDX-License-Identifier: MIT
/**
 * Reports as blocks (WP 10.15, V8): the Reports screen's Spending, Income and Budget-vs-actual sections, built from
 * exactly the wire figures `GET /reports/spending|income|budget-vs-actual` return.
 *
 * **No figure of its own.** Every builder takes the source route's wire output (the same function computes both —
 * `routes/reports.ts`) and only re-arranges it: a cell's amount becomes a segment and a table cell, a line's
 * `assigned`/`activity`/`available` become table cells. The one number a builder writes that the route does not
 * carry is a stacked bar's `total`, and the schema refuses a `total` that is not the sum of the bar's own
 * segments, so it cannot carry a figure either. `test/report-blocks.test.ts` asserts figure-for-figure equality.
 *
 * The Sankey stays a bespoke component; it has no block.
 */
import type { Block, BlockHue, StackedBarGroup, TableCell } from '@core/kernel';
import { categoryHref, transactionsHref, type DrillThroughWire } from './hrefs.ts';

export interface CategoryMonthCellWire {
  readonly month: string;
  readonly categoryId: string | null;
  readonly amount: { readonly minor: string; readonly currency: string };
  readonly transactionCount: number;
  readonly drillThrough: DrillThroughWire;
}

export interface CategoryLabel {
  readonly label: string;
  readonly hue: BlockHue;
}

export type CategoryLookup = (categoryId: string | null) => CategoryLabel;

function magnitude(minor: string): string {
  return minor.startsWith('-') ? minor.slice(1) : minor;
}

/**
 * Category × month as one `stacked-bars` block per currency: a bar per month (ascending), a segment per category
 * in the category's persisted hue, each segment drilling to its transactions and naming its category screen in the
 * table. Amounts are magnitudes, as the screen has always drawn and listed them (`signDisplay="never"`). A zero
 * cell is not drawn, as before. No cells: one sentence, the same the screen said.
 */
export function categoryMonthBlocks(
  cells: readonly CategoryMonthCellWire[],
  lookup: CategoryLookup,
  title: string,
): Block[] {
  const shown = cells.filter((cell) => cell.amount.minor !== '0' && cell.amount.minor !== '-0');
  if (shown.length === 0) {
    return [{ kind: 'text', content: 'No activity in this window.', size: 'body', role: 'muted' }];
  }
  const currencies = [...new Set(shown.map((cell) => cell.amount.currency))].sort();
  return currencies.map((currency): Block => {
    const byMonth = new Map<string, StackedBarGroup[]>();
    for (const cell of shown) {
      if (cell.amount.currency !== currency) continue;
      const category = lookup(cell.categoryId);
      const group: StackedBarGroup = {
        key: cell.categoryId ?? 'uncategorised',
        label: category.label,
        value: magnitude(cell.amount.minor),
        hue: category.hue,
        href: transactionsHref(cell.drillThrough),
        ...(cell.categoryId === null
          ? {}
          : { labelHref: categoryHref(cell.categoryId, cell.month) }),
        count: cell.transactionCount,
      };
      const bucket = byMonth.get(cell.month);
      if (bucket === undefined) byMonth.set(cell.month, [group]);
      else bucket.push(group);
    }
    return {
      kind: 'stacked-bars',
      id: `category-month-${currency}`,
      title: currencies.length > 1 ? `${title} (${currency})` : title,
      currency,
      data: [...byMonth.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, groups]) => ({
          x: month,
          total: groups.reduce((sum, group) => sum + BigInt(group.value), 0n).toString(),
          groups,
        })),
    };
  });
}

export interface BudgetVsActualLineWire {
  readonly id: string;
  readonly categoryId: string | null;
  readonly name: string | null;
  readonly assigned: { readonly minor: string; readonly currency: string };
  readonly activity: { readonly minor: string; readonly currency: string };
  readonly available: { readonly minor: string; readonly currency: string };
  readonly cashOverspend: { readonly minor: string; readonly currency: string };
  readonly creditOverspend: { readonly minor: string; readonly currency: string };
  readonly drillThrough: DrillThroughWire;
}

function moneyCell(value: { readonly minor: string; readonly currency: string }): TableCell {
  return { value: { amountMinor: value.minor, currency: value.currency } };
}

/**
 * Budget vs. actual as one `table` block: a row per category line, the name linking to its category screen and a
 * "transactions" cell to its drill-through, Assigned / Activity / Available as the route's money, Overspend as the
 * Cash and Credit badges (or "—"). No lines: the screen's sentence.
 */
export function budgetVsActualBlocks(lines: readonly BudgetVsActualLineWire[]): Block[] {
  if (lines.length === 0) {
    return [
      { kind: 'text', content: 'No budget lines for this period.', size: 'body', role: 'muted' },
    ];
  }
  return [
    {
      kind: 'table',
      id: 'budget-vs-actual',
      caption: 'Budget versus actual by category, this period',
      columns: [
        { key: 'category', label: 'Category' },
        { key: 'assigned', label: 'Assigned', align: 'end' },
        { key: 'activity', label: 'Activity', align: 'end' },
        { key: 'available', label: 'Available', align: 'end' },
        { key: 'overspend', label: 'Overspend', align: 'end' },
        { key: 'transactions', label: 'Transactions', align: 'end' },
      ],
      rows: lines.map((line) => {
        const name = line.name ?? 'Category';
        const badges = [
          ...(line.cashOverspend.minor === '0'
            ? []
            : [{ label: 'Cash', variant: 'danger' as const }]),
          ...(line.creditOverspend.minor === '0'
            ? []
            : [{ label: 'Credit', variant: 'warning' as const }]),
        ];
        return {
          key: line.id,
          cells: [
            line.categoryId === null
              ? { value: name }
              : { value: name, href: categoryHref(line.categoryId) },
            moneyCell(line.assigned),
            moneyCell(line.activity),
            moneyCell(line.available),
            badges.length === 0 ? { value: null } : { value: null, badges },
            {
              value: 'transactions',
              href: transactionsHref(line.drillThrough),
              hrefLabel: `transactions in ${name}`,
            },
          ],
        };
      }),
    },
  ];
}
