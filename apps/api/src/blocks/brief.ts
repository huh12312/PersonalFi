// SPDX-License-Identifier: MIT
/**
 * The Brief as blocks (WP 10.15, V8).
 *
 * Built from the Brief exactly as `routes/brief.ts` serialises it — the stored week, its stored items, each item's
 * narration as `narrationOfItem` reported it — plus two reads the screen already made on its own: the latest
 * health score (`GET /insights/health-score`) and the holder's undismissed net-worth milestones (`GET
 * /net-worth/milestones`). Nothing is recomputed and nothing is ranked here: the order is the Brief's.
 *
 * **The narrator never sees a block.** The narration request is assembled from `insights` rows by
 * `@ctx/insights`' `advisors/local/findings.ts` before any Brief is read; this module is a pure function of the
 * already-served Brief and is imported by the route alone (`test/brief-blocks.test.ts` and
 * `test/db/brief-blocks.test.ts` prove both). A narration is carried as the text the route already sends
 * (`narration.summaryMd`, present only when `NARRATION_TEXT_SHOWN`), under its badge, and the numerals rule
 * (`validate/numerals.ts`) still governs that text at the narrator's gate — a block adds no figure to it.
 */
import type { Block, BlockNarration } from '@core/kernel';

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

function magnitude(minor: string): bigint {
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
    (top, row) => (magnitude(row.money.minor) > top ? magnitude(row.money.minor) : top),
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
      barPercent: barPercentOf(magnitude(money.minor), max),
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
