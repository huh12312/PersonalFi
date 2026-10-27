// SPDX-License-Identifier: MIT
/**
 * Test fixtures: blocks built the way the server builds them (WP 10.15).
 *
 * A verbatim copy of `apps/api/src/blocks/{hrefs,reports,brief}.ts` (pure functions over the served wire shapes;
 * they import nothing but kernel types; the brief builder's `magnitude` is renamed `magnitudeBig` here, beside the
 * reports builder's), so the web's unit tests and the Playwright mocks serve a Brief and a report
 * whose blocks are exactly what the API would send for the same figures. The API's own tests pin those builders;
 * if they change, re-copy this file (`diff` the three bodies).
 */
import type { Block, BlockHue, BlockNarration, StackedBarGroup, TableCell } from '@core/kernel';

import type { BlockDocument as GeneratedBlockDocument } from '../api/generated/types.gen.ts';

// ---- apps/api/src/blocks/hrefs.ts ----

export interface DrillThroughWire {
  readonly categoryIds?: readonly string[] | undefined;
  readonly merchantIds?: readonly string[] | undefined;
  readonly uncategorized?: boolean | undefined;
  readonly from: string;
  readonly to: string;
}

export function transactionsHref(drill: DrillThroughWire): string {
  const parts: string[] = [];
  if (drill.categoryIds !== undefined && drill.categoryIds.length > 0) {
    parts.push(`categoryIds=${encodeURIComponent(JSON.stringify([...drill.categoryIds]))}`);
  }
  if (drill.merchantIds !== undefined && drill.merchantIds.length > 0) {
    parts.push(`merchantIds=${encodeURIComponent(JSON.stringify([...drill.merchantIds]))}`);
  }
  if (drill.uncategorized === true) parts.push('uncategorized=true');
  parts.push(`from=${encodeURIComponent(drill.from)}`, `to=${encodeURIComponent(drill.to)}`);
  return `/transactions?${parts.join('&')}`;
}

/** V7's category screen; `month` (`YYYY-MM`) selects that month on it. */
export function categoryHref(categoryId: string, month?: string): string {
  const path = `/categories/${encodeURIComponent(categoryId)}`;
  return month === undefined ? path : `${path}?month=${encodeURIComponent(month)}`;
}

// ---- apps/api/src/blocks/reports.ts ----

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
  categoryLookup: CategoryLookup,
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
      const category = categoryLookup(cell.categoryId);
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

// ---- apps/api/src/blocks/brief.ts ----

type WireMoney = { readonly minor: string; readonly currency: string };

export interface BriefItemForBlocks {
  readonly id: string;
  readonly section: 'ranked' | 'attention';
  readonly title: string;
  readonly summaryMd: string;
  readonly carried: boolean;
  readonly annualizedImpact: WireMoney | null;
  readonly oneTimeImpact: WireMoney | null;
  readonly narration: {
    readonly status: 'narrated' | 'pending' | 'none';
    readonly textShown: boolean;
    readonly summaryMd: string | null;
    readonly narratedBy: {
      readonly provider: 'ollama' | 'openai' | 'openrouter' | 'anthropic';
      readonly model: string;
    } | null;
  };
}

export interface BriefForBlocks {
  readonly isoWeek: string;
  readonly nothingMaterial: boolean;
  readonly items: readonly BriefItemForBlocks[];
}

export type HealthForBlocks =
  | { readonly kind: 'scored'; readonly overall: number; readonly isoWeek: string }
  | { readonly kind: 'unscored'; readonly isoWeek: string }
  | { readonly kind: 'not_computed' };

export interface MilestoneForBlocks {
  readonly id: string;
  readonly milestone: WireMoney;
  readonly direction: 'up' | 'down';
  readonly crossedOn: string;
}

/** The Brief's own five-card cap, the second enforcement the screen keeps (`BriefScreen.tsx`). */
export const BRIEF_RANKED_CAP = 5;

/** The figure a card headlines: annualised when the item claims one, else one-time, else none (`severity.ts`). */
function headlineOf(
  item: BriefItemForBlocks,
): { kind: 'annualized' | 'one_time'; money: WireMoney } | null {
  if (item.annualizedImpact !== null) return { kind: 'annualized', money: item.annualizedImpact };
  if (item.oneTimeImpact !== null) return { kind: 'one_time', money: item.oneTimeImpact };
  return null;
}

function magnitudeBig(minor: string): bigint {
  const value = BigInt(minor);
  return value < 0n ? -value : value;
}

/** `100 × |a| / max`, to one decimal — the bar's length, never shown as a figure. */
function barPercentOf(amount: bigint, max: bigint): number {
  if (max === 0n) return 0;
  return Number((amount * 1000n) / max) / 10;
}

/**
 * The item's body: its wording, under the narration badge whenever a narration exists or is expected.
 *
 *   * `narrated` and the text is shown → the narrator's wording, the template one click away.
 *   * `narrated` and the text is withheld (Phase 5 gate R-2) → the template's wording, the badge saying a wording
 *     exists and is not shown yet.
 *   * `pending` → the template's wording, "an AI-assisted wording may follow".
 *   * `none` → the template's wording as plain text.
 */
export function itemBodyBlock(item: BriefItemForBlocks): Block {
  const { narration } = item;
  if (narration.status === 'none') {
    return {
      kind: 'text',
      id: `summary-${item.id}`,
      content: item.summaryMd,
      size: 'body',
      role: 'secondary',
    };
  }
  const shown =
    narration.status === 'narrated' && narration.textShown && narration.summaryMd !== null;
  const status: BlockNarration['status'] =
    narration.status === 'pending' ? 'pending' : shown ? 'narrated' : 'withheld';
  return {
    kind: 'text',
    id: `narration-${item.id}`,
    content: shown && narration.summaryMd !== null ? narration.summaryMd : item.summaryMd,
    size: 'body',
    role: 'narration',
    narration: { status, narratedBy: narration.narratedBy, templateContent: item.summaryMd },
  };
}

/** One card's deterministic content: its body, its headline figure (or why there is none), the carried badge. */
export function briefItemBlocks(item: BriefItemForBlocks): Block[] {
  const headline = headlineOf(item);
  const blocks: Block[] = [itemBodyBlock(item)];
  blocks.push(
    headline === null
      ? {
          kind: 'money',
          id: `impact-${item.id}`,
          label: 'Dollar impact',
          amountMinor: null,
          currency: item.annualizedImpact?.currency ?? item.oneTimeImpact?.currency ?? 'USD',
          withheld: 'No dollar figure: this finding claims none.',
        }
      : {
          kind: 'money',
          id: `impact-${item.id}`,
          label: headline.kind === 'annualized' ? 'Per year' : 'One-time',
          amountMinor: headline.money.minor,
          currency: headline.money.currency,
          signColour: 'none',
        },
  );
  if (item.carried) {
    blocks.push({
      kind: 'badge',
      id: `carried-${item.id}`,
      label: 'Carried from last week',
      variant: 'neutral',
    });
  }
  return blocks;
}

function impactBars(
  items: readonly BriefItemForBlocks[],
  kind: 'annualized' | 'one_time',
  currency: string,
): Block | null {
  const rows = items.flatMap((item) => {
    const headline = headlineOf(item);
    return headline !== null && headline.kind === kind && headline.money.currency === currency
      ? [{ item, money: headline.money }]
      : [];
  });
  if (rows.length === 0) return null;
  const max = rows.reduce(
    (top, row) => (magnitudeBig(row.money.minor) > top ? magnitudeBig(row.money.minor) : top),
    0n,
  );
  return {
    kind: 'horizontal-bars',
    id: `ranked-${kind}-${currency}`,
    title: kind === 'annualized' ? 'Ranked actions, per year' : 'Ranked actions, one-time',
    topRightLabel: kind === 'annualized' ? 'per year' : 'one-time',
    bars: rows.map(({ item, money }) => ({
      label: item.title,
      hue: 'teal',
      barPercent: barPercentOf(magnitudeBig(money.minor), max),
      rightLabel: { amountMinor: money.minor, currency: money.currency },
    })),
  };
}

/**
 * The Brief's overview, above the cards: the week, the ranked actions by dollar impact (one bar list per kind of
 * figure and currency — a yearly figure and a one-time figure are never drawn on one scale; an item with no figure
 * is named, not drawn as zero), the milestones if any, and the health link card.
 */
export function briefOverviewBlocks(
  brief: BriefForBlocks,
  health: HealthForBlocks,
  milestones: readonly MilestoneForBlocks[],
): Block[] {
  const ranked = brief.items.filter((item) => item.section === 'ranked').slice(0, BRIEF_RANKED_CAP);
  const attention = brief.items.filter((item) => item.section === 'attention');
  const blocks: Block[] = [];

  blocks.push({
    kind: 'group',
    id: 'brief-week',
    title: 'The week',
    blocks: [
      { kind: 'info', id: 'brief-week-label', label: 'Week', value: brief.isoWeek },
      {
        kind: 'info',
        id: 'brief-week-ranked',
        label: 'Ranked actions',
        value: String(ranked.length),
      },
      {
        kind: 'info',
        id: 'brief-week-attention',
        label: 'Needs attention',
        value: String(attention.length),
      },
    ],
  });

  if (!brief.nothingMaterial && ranked.length > 0) {
    const currencies = [
      ...new Set(
        ranked.flatMap((item) => {
          const headline = headlineOf(item);
          return headline === null ? [] : [headline.money.currency];
        }),
      ),
    ].sort();
    const bars = currencies.flatMap((currency) =>
      (['annualized', 'one_time'] as const).flatMap((kind) => {
        const block = impactBars(ranked, kind, currency);
        return block === null ? [] : [block];
      }),
    );
    const unfigured = ranked.filter((item) => headlineOf(item) === null);
    const group: Block[] = [...bars];
    if (unfigured.length > 0) {
      group.push({
        kind: 'text',
        id: 'ranked-unfigured',
        content: `No dollar figure: ${unfigured.map((item) => item.title).join('; ')}.`,
        size: 'caption',
        role: 'muted',
      });
    }
    blocks.push({ kind: 'group', id: 'brief-ranked', title: 'By dollar impact', blocks: group });
  }

  if (milestones.length > 0) {
    blocks.push({
      kind: 'group',
      id: 'brief-milestones',
      title: 'Net worth milestones',
      blocks: [
        ...milestones.slice(0, 3).map((milestone): Block => ({
          kind: 'money',
          id: `milestone-${milestone.id}`,
          label: milestone.direction === 'up' ? 'Net worth reached' : 'Net worth fell to',
          amountMinor: milestone.milestone.minor,
          currency: milestone.milestone.currency,
          hint: `On ${milestone.crossedOn}.`,
        })),
        {
          kind: 'cta',
          id: 'brief-milestones-open',
          label: 'See net worth',
          href: '/',
          variant: 'link',
        },
      ],
    });
  }

  blocks.push({
    kind: 'group',
    id: 'brief-health',
    title: 'Financial health score',
    blocks: [
      health.kind === 'scored'
        ? {
            kind: 'info',
            id: 'brief-health-score',
            label: 'This week’s score',
            value: `${String(health.overall)} / 100`,
          }
        : {
            kind: 'info',
            id: 'brief-health-score',
            label: 'This week’s score',
            value: null,
            withheld:
              health.kind === 'unscored'
                ? 'Not enough data to compute.'
                : 'Not computed yet. It is calculated along with your weekly Brief.',
          },
      {
        kind: 'text',
        id: 'brief-health-about',
        content:
          'Your score as a gauge, its six pillars and how it has moved are on the Financial health screen.',
        size: 'body',
        role: 'secondary',
      },
      {
        kind: 'cta',
        id: 'brief-health-open',
        label: 'Open Financial health',
        href: '/health',
        variant: 'link',
      },
    ],
  });

  return blocks;
}

// ---- helpers for tests and mocks ----

/** A wire `BlockDocument` (the generated type's arrays are mutable; the kernel's are readonly). */
export function blockDocumentOf(blocks: readonly Block[]): GeneratedBlockDocument {
  return { contractVersion: 1, blocks: blocks as unknown as GeneratedBlockDocument['blocks'] };
}

type BriefLike = BriefForBlocks & {
  readonly items: readonly (BriefItemForBlocks & Record<string, unknown>)[];
};

/**
 * A served Brief with its blocks, as the route builds them: every item's `blocks` from its own fields, the Brief's
 * from the items, the health score and the milestones.
 */
export function withBriefBlocks<B extends BriefLike>(
  brief: B,
  health: HealthForBlocks = { kind: 'not_computed' },
  milestones: readonly MilestoneForBlocks[] = [],
): B & { blocks: GeneratedBlockDocument } {
  return {
    ...brief,
    items: brief.items.map((item) => ({ ...item, blocks: blockDocumentOf(briefItemBlocks(item)) })),
    blocks: blockDocumentOf(briefOverviewBlocks(brief, health, milestones)),
  };
}
