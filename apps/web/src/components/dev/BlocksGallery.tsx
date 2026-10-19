// SPDX-License-Identifier: MIT
import { BLOCK_FIXTURES } from '@core/kernel';

import { BlockRenderer } from '../blocks/BlockRenderer.tsx';

/**
 * `/dev/kitchen-sink`'s "Blocks" section (WP 10.15, V8): every block kind, drawn by the one renderer in whichever
 * theme the enclosing panel sets — the kernel's fixture corpus (one valid block per kind, the same corpus both Zod
 * schemas are tested against), then the honesty paths: a withheld amount, a meter with no budget, a narration whose
 * text is withheld and one still pending, and the two rows a block that cannot be drawn becomes.
 *
 * The `transactions-list` here names no transaction: the kitchen sink has no ledger to resolve one from, and the
 * list says so rather than inventing a row.
 */
const EXTRA: readonly unknown[] = [
  { kind: 'divider' },
  { kind: 'text', content: 'The honesty paths', size: 'heading' },
  {
    kind: 'money',
    label: 'Dollar impact',
    amountMinor: null,
    currency: 'USD',
    withheld: 'No dollar figure: this finding claims none.',
  },
  {
    kind: 'money',
    label: 'Net this month',
    amountMinor: '42000',
    currency: 'USD',
    signColour: 'by-sign',
  },
  {
    kind: 'meter',
    label: 'Gifts',
    spentMinor: '1200',
    budgetedMinor: '0',
    currency: 'USD',
    state: 'no_budget',
  },
  {
    kind: 'meter',
    label: 'Dining',
    spentMinor: '61000',
    budgetedMinor: '50000',
    currency: 'USD',
    tickPercent: 55,
    state: 'over',
  },
  {
    kind: 'text',
    content: 'Groceries have run higher than usual lately.',
    size: 'body',
    role: 'narration',
    narration: {
      status: 'withheld',
      narratedBy: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
      templateContent: 'Groceries have run higher than usual lately.',
    },
  },
  {
    kind: 'text',
    content: 'Groceries have run higher than usual lately.',
    size: 'body',
    role: 'narration',
    narration: {
      status: 'pending',
      narratedBy: null,
      templateContent: 'Groceries have run higher than usual lately.',
    },
  },
  { kind: 'merchants-list', merchants: [] },
  { kind: 'money', label: 'A float', amountMinor: '12.5', currency: 'USD' },
];

/** Every `title` and `caption` suffixed with the theme, so the two panels' regions and groups have distinct names. */
function named(raw: unknown, suffix: string): unknown {
  if (Array.isArray(raw)) return raw.map((item) => named(item, suffix));
  if (raw === null || typeof raw !== 'object') return raw;
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [
      key,
      (key === 'title' || key === 'caption') && typeof value === 'string'
        ? `${value} (${suffix})`
        : named(value, suffix),
    ]),
  );
}

export function BlocksGallery({ theme }: { readonly theme: string }) {
  const corpus = BLOCK_FIXTURES.valid.map((block) =>
    block.kind === 'transactions-list' ? { ...block, transactionIds: [] } : block,
  );
  return (
    <div data-testid="blocks-gallery">
      <BlockRenderer blocks={named([...corpus, ...EXTRA], theme) as unknown[]} headingLevel={3} />
    </div>
  );
}
