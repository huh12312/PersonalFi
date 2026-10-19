// SPDX-License-Identifier: MIT
/**
 * The block vocabulary (WP 10.15, V8; docs/research/10-visual-design-notes.md §1.4 "Reports as
 * server-driven blocks"; docs/design/blocks.md).
 *
 * A block is one deterministic, server-built piece of a screen — a heading, a figure, a bar list, a table — that
 * the web draws with one renderer (`apps/web/src/components/blocks/BlockRenderer.tsx`). The Brief, Reports and
 * the kitchen sink speak it, so the three stop drawing their own. **A block is never model output**: every block
 * is built by server code from figures the source route already exposes, and nothing here reaches a narrator.
 *
 * ## Why the vocabulary lives here and the Zod schemas do not
 *
 * Both sides validate blocks with Zod (`apps/api/src/blocks/schema.ts`, published as `Block` in the OpenAPI
 * document, and `apps/web/src/components/blocks/schema.ts`). Zod cannot be imported from the kernel (it is not one
 * of the kernel's dependencies, and adding one is a lockfile change), so this file holds what the two schemas are
 * built from — the kinds, the enumerations, the patterns, the TypeScript shape — and a fixture corpus
 * (`BLOCK_FIXTURES`) that both sides' tests run, so an accept/reject drift between them fails a test.
 *
 * ## The rules (mechanised by the schemas)
 *
 *   * **Money is minor units + currency**, as an integer string — never a float, never a pre-formatted string.
 *   * **A colour is a hue name or a role name**, never a hex: every colour field is an enumeration below.
 *   * **An href is an in-app path** (`/categories/…`), never a scheme, a host or a protocol-relative `//`.
 *   * **A withheld figure carries its reason**, never a zero (`amountMinor: null` requires `withheld`).
 *   * **A stacked bar's `total` is the sum of its own groups**, so it can never carry a figure of its own.
 *   * **Unknown kinds are rejected by the server** and drawn by the web as a visible "Unsupported block" row.
 */
import { CHART_HUES } from './hue.ts';

/** The integer that crosses the wire with every block document. Bumped on a breaking change to a kind. */
export const BLOCK_CONTRACT_VERSION = 1;

export const BLOCK_KINDS = [
  'text',
  'info',
  'money',
  'horizontal-bars',
  'pie',
  'stacked-bars',
  'sparkline-row',
  'meter',
  'net-worth',
  'transactions-list',
  'table',
  'badge',
  'cta',
  'divider',
  'group',
] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

export function isBlockKind(value: unknown): value is BlockKind {
  return typeof value === 'string' && (BLOCK_KINDS as readonly string[]).includes(value);
}

export const BLOCK_TEXT_SIZES = ['body', 'heading', 'eyebrow', 'caption'] as const;
export const BLOCK_TEXT_WEIGHTS = ['regular', 'medium', 'semibold'] as const;
/** Text roles: the three text inks, and `narration` — a narrator's wording, always under its badge. */
export const BLOCK_TEXT_ROLES = ['primary', 'secondary', 'muted', 'narration'] as const;
/** A mark's colour: one of the thirteen chart hues, or the neutral fill (Uncategorised, "Other"). */
export const BLOCK_HUES = [...CHART_HUES, 'neutral'] as const;
/** A badge's (and a table cell badge's) role: the status quartets, the accent, or neutral. */
export const BLOCK_BADGE_VARIANTS = [
  'neutral',
  'accent',
  'success',
  'warning',
  'danger',
  'info',
] as const;
export const BLOCK_CTA_VARIANTS = ['primary', 'secondary', 'link'] as const;
/** `none`: the ink of the surrounding text. `by-sign`: the CVD-safe income/expense pair by the amount's sign. */
export const BLOCK_SIGN_COLOURS = ['none', 'by-sign'] as const;
/** The budget meter's states (`apps/web/src/components/finance/budget-meter.ts`), `no_budget` withholding the bar. */
export const BLOCK_METER_STATES = [
  'under',
  'within',
  'on_pace',
  'ahead',
  'over',
  'no_budget',
] as const;
export const BLOCK_NET_WORTH_BUCKETINGS = ['day', 'week', 'month'] as const;
/** `@ctx/planning`'s `NET_WORTH_SEGMENT_KINDS`, in its order (V6's bucket shape is reused as is). */
export const BLOCK_NET_WORTH_SEGMENT_KINDS = [
  'cash',
  'investments',
  'crypto',
  'property',
  'other',
  'liabilities',
] as const;
export const BLOCK_NARRATION_STATUSES = ['narrated', 'withheld', 'pending'] as const;
export const BLOCK_NARRATION_PROVIDERS = ['ollama', 'openai', 'openrouter', 'anthropic'] as const;
export const BLOCK_TABLE_ALIGNS = ['start', 'end'] as const;

/** Integer minor units, as a string. */
export const BLOCK_MINOR_PATTERN = /^-?\d{1,19}$/u;
/** A non-negative decimal (a score, a count): never a money figure — those are minor units. */
export const BLOCK_DECIMAL_PATTERN = /^-?\d{1,19}(\.\d{1,12})?$/u;
export const BLOCK_CURRENCY_PATTERN = /^[A-Z]{3}$/u;
/**
 * An in-app path: one leading `/`, not `//` (protocol-relative), no backslash (browsers fold `\` into `/`), no
 * whitespace and no control characters. `javascript:`, `https://…` and `//evil.example` all fail it.
 */
export const BLOCK_HREF_PATTERN = /^\/(?![/\\])[^\s\\]*$/u;
/** The shortest a label may be, and the longest any text in a block may be. */
export const BLOCK_TEXT_MAX = 2000;
export const BLOCK_LABEL_MAX = 200;
/** Nesting depth of `group` blocks (a document is depth 0). */
export const BLOCK_MAX_DEPTH = 4;

export function isInAppHref(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 2048 && BLOCK_HREF_PATTERN.test(value);
}

export type BlockHue = (typeof BLOCK_HUES)[number];
export type BlockBadgeVariant = (typeof BLOCK_BADGE_VARIANTS)[number];
export type BlockMeterState = (typeof BLOCK_METER_STATES)[number];

/** Money inside a block. `amountMinor` is integer minor units as a string. */
export interface BlockMoney {
  readonly amountMinor: string;
  readonly currency: string;
}

/** A label is words or money; money is never pre-formatted on the server. */
export type BlockLabel = string | BlockMoney;

export interface BlockNarration {
  readonly status: (typeof BLOCK_NARRATION_STATUSES)[number];
  /** Who wrote the wording (WP 10.6), as the run recorded it; `null` when it recorded nobody. */
  readonly narratedBy: {
    readonly provider: (typeof BLOCK_NARRATION_PROVIDERS)[number];
    readonly model: string;
  } | null;
  /** The built-in's own deterministic wording, one click away under the narration. */
  readonly templateContent: string;
}

export interface TextBlock {
  readonly kind: 'text';
  readonly id?: string;
  /**
   * The words. For `role: 'narration'` this is the narrator's wording when `narration.status` is `narrated`, and
   * the built-in's template wording otherwise (the narration is withheld or pending, and the badge says so).
   */
  readonly content: string;
  readonly size: (typeof BLOCK_TEXT_SIZES)[number];
  readonly weight?: (typeof BLOCK_TEXT_WEIGHTS)[number];
  readonly role?: (typeof BLOCK_TEXT_ROLES)[number];
  /** Required exactly when `role` is `narration`. */
  readonly narration?: BlockNarration;
}

export interface InfoBlock {
  readonly kind: 'info';
  readonly id?: string;
  readonly label: string;
  /** `null` exactly when `withheld` says why. */
  readonly value: BlockLabel | null;
  readonly hint?: string;
  readonly withheld?: string;
}

export interface MoneyBlock {
  readonly kind: 'money';
  readonly id?: string;
  readonly label: string;
  /** `null` exactly when `withheld` says why — a withheld figure is never a zero. */
  readonly amountMinor: string | null;
  readonly currency: string;
  readonly signColour?: (typeof BLOCK_SIGN_COLOURS)[number];
  readonly hint?: string;
  readonly withheld?: string;
}

export interface HorizontalBar {
  readonly label: string;
  readonly hue: BlockHue;
  /** 0–100: the bar's length as a share of the longest; presentation, never a figure. */
  readonly barPercent: number;
  readonly leftLabel?: BlockLabel;
  readonly rightLabel: BlockLabel;
  readonly href?: string;
}

export interface HorizontalBarsBlock {
  readonly kind: 'horizontal-bars';
  readonly id?: string;
  readonly title?: string;
  readonly topRightLabel?: BlockLabel;
  readonly bars: readonly HorizontalBar[];
  readonly smallBarStyle?: boolean;
}

export interface PieBlock {
  readonly kind: 'pie';
  readonly id?: string;
  readonly title?: string;
  /** Slice values are minor units in this currency, or plain counts when `null`. */
  readonly currency: string | null;
  readonly slices: readonly {
    readonly label: string;
    readonly value: string;
    readonly hue: BlockHue;
  }[];
}

export interface StackedBarGroup {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly hue: BlockHue;
  /** Where the segment drills to (the transactions behind it). */
  readonly href?: string;
  /** Where the group's name links to in the table (its category screen). */
  readonly labelHref?: string;
  /** How many transactions stand behind the segment, when the source route says (a "Transactions" column). */
  readonly count?: number;
}

export interface StackedBarsBlock {
  readonly kind: 'stacked-bars';
  readonly id?: string;
  readonly title?: string;
  /** Values are minor units in this currency, or plain counts when `null`. */
  readonly currency: string | null;
  readonly data: readonly {
    readonly x: string;
    /** Σ `groups[].value`, exactly — the bar's height, never a figure of its own. */
    readonly total: string;
    readonly groups: readonly StackedBarGroup[];
  }[];
}

export interface SparklineRowBlock {
  readonly kind: 'sparkline-row';
  readonly id?: string;
  readonly label: string;
  readonly rightLabel?: BlockLabel;
  readonly hue?: BlockHue;
  /** Oldest first. Decimal strings; minor units when `currency` is set. */
  readonly values: readonly string[];
  readonly currency?: string;
  readonly hideValueChange?: boolean;
  readonly title?: string;
  readonly largeStyle?: boolean;
}

export interface MeterBlock {
  readonly kind: 'meter';
  readonly id?: string;
  readonly label: string;
  readonly spentMinor: string;
  /** `"0"` (with state `no_budget`) withholds the bar: "no amount set", never an empty meter. */
  readonly budgetedMinor: string;
  readonly currency: string;
  /** 0–100: the pace tick, the share of the period elapsed; absent when the period is not running. */
  readonly tickPercent?: number;
  readonly state: BlockMeterState;
}

export interface NetWorthBucketWire {
  readonly start: string;
  readonly end: string;
  readonly asOfDate: string | null;
  readonly netWorth: { readonly minor: string; readonly currency: string } | null;
  readonly segments: readonly {
    readonly kind: (typeof BLOCK_NET_WORTH_SEGMENT_KINDS)[number];
    readonly amount: { readonly minor: string; readonly currency: string };
    readonly accounts: number;
  }[];
  readonly sealed: boolean;
  readonly source: string | null;
}

export interface NetWorthBlock {
  readonly kind: 'net-worth';
  readonly id?: string;
  readonly title?: string;
  readonly currency: string;
  readonly bucketing: (typeof BLOCK_NET_WORTH_BUCKETINGS)[number];
  /** V6's `NetWorthBucket` shape, as `GET /net-worth/series?bucket=` returns it. */
  readonly buckets: readonly NetWorthBucketWire[];
}

export interface TransactionsListBlock {
  readonly kind: 'transactions-list';
  readonly id?: string;
  readonly title?: string;
  /** Resolved by the web through the existing transactions list; a block never carries a transaction's figures. */
  readonly transactionIds: readonly string[];
}

export interface TableCell {
  /** `null` is "—": nothing to show, stated, not a zero. */
  readonly value: BlockLabel | null;
  readonly href?: string;
  /** Words for a screen reader when the visible link text is not enough ("transactions in Groceries"). */
  readonly hrefLabel?: string;
  readonly badges?: readonly { readonly label: string; readonly variant: BlockBadgeVariant }[];
}

export interface TableBlock {
  readonly kind: 'table';
  readonly id?: string;
  readonly caption: string;
  readonly columns: readonly {
    readonly key: string;
    readonly label: string;
    readonly align?: (typeof BLOCK_TABLE_ALIGNS)[number];
  }[];
  /** The first cell of each row is its row header. Every row has one cell per column. */
  readonly rows: readonly { readonly key: string; readonly cells: readonly TableCell[] }[];
}

export interface BadgeBlock {
  readonly kind: 'badge';
  readonly id?: string;
  readonly label: string;
  readonly variant: BlockBadgeVariant;
}

export interface CtaBlock {
  readonly kind: 'cta';
  readonly id?: string;
  readonly label: string;
  readonly href: string;
  readonly variant: (typeof BLOCK_CTA_VARIANTS)[number];
}

export interface DividerBlock {
  readonly kind: 'divider';
  readonly id?: string;
}

export interface GroupBlock {
  readonly kind: 'group';
  readonly id?: string;
  readonly title?: string;
  readonly blocks: readonly Block[];
}

export type Block =
  | TextBlock
  | InfoBlock
  | MoneyBlock
  | HorizontalBarsBlock
  | PieBlock
  | StackedBarsBlock
  | SparklineRowBlock
  | MeterBlock
  | NetWorthBlock
  | TransactionsListBlock
  | TableBlock
  | BadgeBlock
  | CtaBlock
  | DividerBlock
  | GroupBlock;

export interface BlockDocument {
  readonly contractVersion: typeof BLOCK_CONTRACT_VERSION;
  readonly blocks: readonly Block[];
}

/**
 * The cross-field rules a JSON Schema cannot say, written once and called by both Zod schemas' `superRefine`.
 * Returns the problems (empty = valid). `block` has already passed the field-level checks.
 */
export function blockRuleProblems(block: Block): readonly string[] {
  const problems: string[] = [];
  switch (block.kind) {
    case 'text':
      if ((block.role === 'narration') !== (block.narration !== undefined)) {
        problems.push(
          'a narration text block carries `narration`, and only a narration block does',
        );
      }
      break;
    case 'info':
      if ((block.value === null) !== (block.withheld !== undefined)) {
        problems.push('an info value is null exactly when `withheld` gives the reason');
      }
      break;
    case 'money':
      if ((block.amountMinor === null) !== (block.withheld !== undefined)) {
        problems.push('a money amount is null exactly when `withheld` gives the reason');
      }
      break;
    case 'meter':
      if ((block.budgetedMinor === '0') !== (block.state === 'no_budget')) {
        problems.push('a meter with no budget is `no_budget`, and only such a meter is');
      }
      break;
    case 'stacked-bars':
      for (const bar of block.data) {
        let sum = 0n;
        for (const group of bar.groups) sum += BigInt(group.value);
        if (sum.toString() !== BigInt(bar.total).toString()) {
          problems.push(
            `stacked bar ${bar.x}: total ${bar.total} is not the sum of its groups (${sum.toString()})`,
          );
        }
      }
      break;
    case 'table':
      for (const row of block.rows) {
        if (row.cells.length !== block.columns.length) {
          problems.push(
            `table row ${row.key}: ${String(row.cells.length)} cells for ${String(block.columns.length)} columns`,
          );
        }
      }
      break;
    default:
      break;
  }
  return problems;
}

/** How deep a block nests `group`s (a leaf is 0). */
export function blockDepth(block: Block): number {
  if (block.kind !== 'group') return 0;
  let deepest = 0;
  for (const child of block.blocks) deepest = Math.max(deepest, blockDepth(child));
  return deepest + 1;
}

const HUE_SET: ReadonlySet<string> = new Set(BLOCK_HUES);

export function isBlockHue(value: unknown): value is BlockHue {
  return typeof value === 'string' && HUE_SET.has(value);
}

const USD = 'USD';

/**
 * One valid block of every kind, and a list of blocks each side must refuse. Run by the API's contract test and
 * by the web's schema test; the two must agree on every entry.
 */
export const BLOCK_FIXTURES: {
  readonly valid: readonly Block[];
  readonly invalid: readonly { readonly why: string; readonly block: unknown }[];
} = {
  valid: [
    { kind: 'text', content: 'This week', size: 'heading', weight: 'semibold' },
    {
      kind: 'text',
      content: 'Groceries ran higher than usual.',
      size: 'body',
      role: 'narration',
      narration: {
        status: 'narrated',
        narratedBy: { provider: 'ollama', model: 'qwen2.5:7b-instruct-q4_K_M' },
        templateContent: 'Groceries have run higher than usual lately.',
      },
    },
    { kind: 'info', label: 'Week', value: '2026-W11' },
    {
      kind: 'info',
      label: 'Score',
      value: null,
      withheld: 'Not scored until two snapshots exist.',
    },
    { kind: 'money', label: 'Spent', amountMinor: '-12345', currency: USD, signColour: 'by-sign' },
    {
      kind: 'money',
      label: 'Saved',
      amountMinor: null,
      currency: USD,
      withheld: 'No dollar figure.',
    },
    {
      kind: 'horizontal-bars',
      title: 'Ranked by dollar impact',
      topRightLabel: 'per year',
      bars: [
        {
          label: 'Groceries',
          hue: 'green',
          barPercent: 100,
          rightLabel: { amountMinor: '120000', currency: USD },
          href: '/categories/0190a000-0000-7000-8000-000000000001',
        },
        { label: 'Other', hue: 'neutral', barPercent: 12.5, rightLabel: '1 item' },
      ],
    },
    {
      kind: 'pie',
      title: 'Spending mix',
      currency: USD,
      slices: [
        { label: 'Groceries', value: '30000', hue: 'green' },
        { label: 'Dining', value: '10000', hue: 'orange' },
      ],
    },
    {
      kind: 'stacked-bars',
      title: 'Spending by month',
      currency: USD,
      data: [
        {
          x: '2026-02',
          total: '40000',
          groups: [
            {
              key: 'g',
              label: 'Groceries',
              value: '30000',
              hue: 'green',
              href: '/transactions?from=2026-02-01',
            },
            { key: 'd', label: 'Dining', value: '10000', hue: 'orange' },
          ],
        },
      ],
    },
    {
      kind: 'sparkline-row',
      label: 'Health score',
      rightLabel: '83.75',
      hue: 'teal',
      values: ['80', '81.5', '83.75'],
    },
    {
      kind: 'meter',
      label: 'Groceries',
      spentMinor: '30000',
      budgetedMinor: '50000',
      currency: USD,
      tickPercent: 55,
      state: 'on_pace',
    },
    {
      kind: 'meter',
      label: 'Gifts',
      spentMinor: '1200',
      budgetedMinor: '0',
      currency: USD,
      state: 'no_budget',
    },
    {
      kind: 'net-worth',
      currency: USD,
      bucketing: 'month',
      buckets: [
        {
          start: '2026-02-01',
          end: '2026-02-28',
          asOfDate: '2026-02-28',
          netWorth: { minor: '500000', currency: USD },
          segments: [
            { kind: 'cash', amount: { minor: '600000', currency: USD }, accounts: 1 },
            { kind: 'liabilities', amount: { minor: '-100000', currency: USD }, accounts: 1 },
          ],
          sealed: true,
          source: 'snapshot',
        },
      ],
    },
    {
      kind: 'transactions-list',
      title: 'Behind this',
      transactionIds: ['0190a000-0000-7000-8000-000000000009'],
    },
    {
      kind: 'table',
      caption: 'Budget versus actual',
      columns: [
        { key: 'category', label: 'Category' },
        { key: 'assigned', label: 'Assigned', align: 'end' },
      ],
      rows: [
        {
          key: 'r1',
          cells: [
            { value: 'Groceries', href: '/categories/0190a000-0000-7000-8000-000000000001' },
            { value: { amountMinor: '50000', currency: USD } },
          ],
        },
        {
          key: 'r2',
          cells: [
            { value: 'Rent' },
            { value: null, badges: [{ label: 'Cash', variant: 'danger' }] },
          ],
        },
      ],
    },
    { kind: 'badge', label: 'Carried from last week', variant: 'neutral' },
    { kind: 'cta', label: 'See your financial health', href: '/health', variant: 'link' },
    { kind: 'divider' },
    {
      kind: 'group',
      title: 'Nested',
      blocks: [{ kind: 'group', blocks: [{ kind: 'badge', label: 'Inner', variant: 'info' }] }],
    },
  ],
  invalid: [
    { why: 'an unknown kind', block: { kind: 'merchants-list', merchants: [] } },
    {
      why: 'a hex colour',
      block: { kind: 'pie', currency: null, slices: [{ label: 'A', value: '1', hue: '#ff0000' }] },
    },
    {
      why: 'a hex colour on a bar',
      block: {
        kind: 'horizontal-bars',
        bars: [{ label: 'A', hue: '#12a594', barPercent: 1, rightLabel: 'x' }],
      },
    },
    {
      why: 'an external href',
      block: { kind: 'cta', label: 'Go', href: 'https://example.com', variant: 'link' },
    },
    {
      why: 'a protocol-relative href',
      block: { kind: 'cta', label: 'Go', href: '//example.com', variant: 'link' },
    },
    {
      why: 'a javascript: href',
      block: { kind: 'cta', label: 'Go', href: 'javascript:alert(1)', variant: 'link' },
    },
    {
      why: 'a float amount',
      block: { kind: 'money', label: 'A', amountMinor: '12.5', currency: USD },
    },
    {
      why: 'a number amount',
      block: { kind: 'money', label: 'A', amountMinor: 1250, currency: USD },
    },
    {
      why: 'a withheld figure as zero with no reason',
      block: { kind: 'money', label: 'A', amountMinor: null, currency: USD },
    },
    {
      why: 'a figure and a withheld reason at once',
      block: { kind: 'money', label: 'A', amountMinor: '0', currency: USD, withheld: 'No figure.' },
    },
    {
      why: 'a stacked total that is not the sum',
      block: {
        kind: 'stacked-bars',
        currency: USD,
        data: [{ x: 'a', total: '5', groups: [{ key: 'k', label: 'K', value: '4', hue: 'teal' }] }],
      },
    },
    {
      why: 'a narration without its badge data',
      block: { kind: 'text', content: 'x', size: 'body', role: 'narration' },
    },
    {
      why: 'a lower-case currency',
      block: { kind: 'money', label: 'A', amountMinor: '1', currency: 'usd' },
    },
    {
      why: 'a bar percent over 100',
      block: {
        kind: 'horizontal-bars',
        bars: [{ label: 'A', hue: 'teal', barPercent: 101, rightLabel: 'x' }],
      },
    },
    {
      why: 'a table row with the wrong cell count',
      block: {
        kind: 'table',
        caption: 'c',
        columns: [{ key: 'a', label: 'A' }],
        rows: [{ key: 'r', cells: [] }],
      },
    },
    {
      why: 'a meter with no budget drawn as a state',
      block: {
        kind: 'meter',
        label: 'A',
        spentMinor: '1',
        budgetedMinor: '0',
        currency: USD,
        state: 'over',
      },
    },
    { why: 'an unknown field', block: { kind: 'divider', colour: '#000000' } },
    {
      why: 'groups nested too deep',
      block: {
        kind: 'group',
        blocks: [
          {
            kind: 'group',
            blocks: [
              {
                kind: 'group',
                blocks: [{ kind: 'group', blocks: [{ kind: 'group', blocks: [] }] }],
              },
            ],
          },
        ],
      },
    },
  ],
};
