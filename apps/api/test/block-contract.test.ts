// SPDX-License-Identifier: MIT
/**
 * WP 10.15 (V8): the block contract, server side.
 *
 *   * Every kind round-trips the schema; every entry of the kernel's refusal corpus is refused (the web's schema
 *     test runs the same corpus — `apps/web/src/components/blocks/schema.test.ts`).
 *   * `blockDocument` — what every builder's output passes through before it leaves — refuses an unknown kind, a hex
 *     colour, an external href and a stacked total that is not its sum.
 *   * The builders: figures are the source wire's own, a withheld figure carries its reason, the builders are pure.
 *   * The web's test-support copy of the builders (used by its unit tests and Playwright mocks) is the same code.
 */
import { readFileSync } from 'node:fs';
import { BLOCK_FIXTURES, type Block } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import {
  briefItemBlocks,
  briefOverviewBlocks,
  itemBodyBlock,
  type BriefForBlocks,
  type BriefItemForBlocks,
} from '../src/blocks/brief.ts';
import { categoryHref, transactionsHref } from '../src/blocks/hrefs.ts';
import {
  budgetVsActualBlocks,
  categoryMonthBlocks,
  type BudgetVsActualLineWire,
  type CategoryMonthCellWire,
} from '../src/blocks/reports.ts';
import { blockDocument, blockDocumentSchema, blockSchema } from '../src/blocks/schema.ts';

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe('the block schema (server)', () => {
  it('every kind round-trips: one valid fixture per kind, parsed back to itself', () => {
    const kinds = new Set(BLOCK_FIXTURES.valid.map((block) => block.kind));
    expect(kinds.size).toBe(15);
    for (const block of BLOCK_FIXTURES.valid) {
      const parsed = blockSchema.parse(JSON.parse(JSON.stringify(block)));
      expect(parsed).toEqual(block);
    }
  });

  it.each(BLOCK_FIXTURES.invalid.map((entry) => [entry.why, entry.block] as const))(
    'refuses %s',
    (_why, block) => {
      expect(blockSchema.safeParse(block).success).toBe(false);
    },
  );

  it('blockDocument refuses an unknown kind and a hex colour rather than sending them', () => {
    expect(() => blockDocument([{ kind: 'merchants-list' } as unknown as Block])).toThrow();
    expect(() =>
      blockDocument([
        {
          kind: 'pie',
          currency: null,
          slices: [{ label: 'A', value: '1', hue: '#ff0000' }],
        } as unknown as Block,
      ]),
    ).toThrow();
    expect(() =>
      blockDocument([{ kind: 'cta', label: 'Out', href: 'https://example.com/', variant: 'link' }]),
    ).toThrow();
    expect(blockDocument([{ kind: 'divider' }])).toEqual({
      contractVersion: 1,
      blocks: [{ kind: 'divider' }],
    });
    expect(blockDocumentSchema.safeParse({ contractVersion: 2, blocks: [] }).success).toBe(false);
  });
});

describe('hrefs', () => {
  it('a drill-through becomes the /transactions search the router reads', () => {
    expect(transactionsHref({ categoryIds: ['c1'], from: '2026-01-01', to: '2026-01-31' })).toBe(
      '/transactions?categoryIds=%5B%22c1%22%5D&from=2026-01-01&to=2026-01-31',
    );
    expect(transactionsHref({ uncategorized: true, from: '2026-01-01', to: '2026-01-31' })).toBe(
      '/transactions?uncategorized=true&from=2026-01-01&to=2026-01-31',
    );
    expect(categoryHref('c1', '2026-02')).toBe('/categories/c1?month=2026-02');
  });
});

const USD = (minor: string) => ({ minor, currency: 'USD' });

function cell(
  month: string,
  categoryId: string | null,
  minor: string,
  count = 1,
): CategoryMonthCellWire {
  return {
    month,
    categoryId,
    amount: USD(minor),
    transactionCount: count,
    drillThrough: {
      ...(categoryId === null ? {} : { categoryIds: [categoryId] }),
      from: `${month}-01`,
      to: `${month}-28`,
    },
  };
}

describe('report blocks: every figure is the source cell’s', () => {
  const cells = deepFreeze([
    cell('2026-02', 'groceries', '-30000', 4),
    cell('2026-01', 'groceries', '-12000', 2),
    cell('2026-01', null, '-500', 1),
    cell('2026-01', 'dining', '0', 0),
    { ...cell('2026-01', 'travel', '-9900', 1), amount: { minor: '-9900', currency: 'CAD' } },
  ]);
  const lookup = (id: string | null) =>
    id === null
      ? { label: 'Uncategorised', hue: 'neutral' as const }
      : { label: id[0]?.toUpperCase() + id.slice(1), hue: 'green' as const };

  it('one stacked-bars block per currency; a bar per month ascending; a zero cell not drawn', () => {
    const blocks = categoryMonthBlocks(cells, lookup, 'Spending');
    expect(
      blocks.map((block) => (block.kind === 'stacked-bars' ? block.title : block.kind)),
    ).toEqual(['Spending (CAD)', 'Spending (USD)']);
    const usd = blocks[1];
    if (usd?.kind !== 'stacked-bars') throw new Error('expected stacked bars');
    expect(usd.data.map((bar) => bar.x)).toEqual(['2026-01', '2026-02']);
    // Figure equality: every drawn segment is a cell, every non-zero USD cell is a segment, values are magnitudes.
    const drawn = usd.data.flatMap((bar) =>
      bar.groups.map((group) => [bar.x, group.key, group.value, group.count, group.href]),
    );
    const expected = cells
      .filter((c) => c.amount.currency === 'USD' && c.amount.minor !== '0')
      .map((c) => [
        c.month,
        c.categoryId ?? 'uncategorised',
        c.amount.minor.replace('-', ''),
        c.transactionCount,
        transactionsHref(c.drillThrough),
      ]);
    expect(drawn.sort()).toEqual(expected.sort());
    expect(blockDocument(blocks).blocks).toHaveLength(2);
  });

  it('no cells: the sentence the screen always said, not an empty chart', () => {
    expect(categoryMonthBlocks([], lookup, 'Spending')).toEqual([
      { kind: 'text', content: 'No activity in this window.', size: 'body', role: 'muted' },
    ]);
  });

  it('budget vs. actual: a row per line, the route’s money in its cells, overspend as badges', () => {
    const lines: BudgetVsActualLineWire[] = deepFreeze([
      {
        id: 'l1',
        categoryId: 'groceries',
        name: 'Groceries',
        assigned: USD('50000'),
        activity: USD('-62000'),
        available: USD('-12000'),
        cashOverspend: USD('12000'),
        creditOverspend: USD('0'),
        drillThrough: { categoryIds: ['groceries'], from: '2026-03-01', to: '2026-03-31' },
      },
    ]);
    const [table] = budgetVsActualBlocks(lines);
    if (table?.kind !== 'table') throw new Error('expected a table');
    const row = table.rows[0];
    expect(row?.cells.map((c) => c.value)).toEqual([
      'Groceries',
      { amountMinor: '50000', currency: 'USD' },
      { amountMinor: '-62000', currency: 'USD' },
      { amountMinor: '-12000', currency: 'USD' },
      null,
      'transactions',
    ]);
    expect(row?.cells[0]?.href).toBe('/categories/groceries');
    expect(row?.cells[4]?.badges).toEqual([{ label: 'Cash', variant: 'danger' }]);
    expect(blockDocument([table]).blocks).toHaveLength(1);
  });
});

function item(
  id: string,
  annual: string | null,
  narration: BriefItemForBlocks['narration'],
): BriefItemForBlocks {
  return {
    id,
    section: 'ranked',
    title: `Item ${id}`,
    summaryMd: `Template ${id}.`,
    carried: id === 'b',
    annualizedImpact: annual === null ? null : USD(annual),
    oneTimeImpact: null,
    narration,
  };
}

const NONE = { status: 'none', textShown: false, summaryMd: null, narratedBy: null } as const;

describe('brief blocks', () => {
  it('the narration statuses: shown, withheld (R-2), pending, none', () => {
    const by = { provider: 'anthropic' as const, model: 'claude-sonnet-5-5' };
    expect(
      itemBodyBlock(
        item('a', null, { status: 'narrated', textShown: true, summaryMd: 'N.', narratedBy: by }),
      ),
    ).toMatchObject({
      role: 'narration',
      content: 'N.',
      narration: { status: 'narrated', narratedBy: by, templateContent: 'Template a.' },
    });
    expect(
      itemBodyBlock(
        item('a', null, { status: 'narrated', textShown: false, summaryMd: null, narratedBy: by }),
      ),
    ).toMatchObject({
      role: 'narration',
      content: 'Template a.',
      narration: { status: 'withheld' },
    });
    expect(
      itemBodyBlock(
        item('a', null, { status: 'pending', textShown: true, summaryMd: null, narratedBy: null }),
      ),
    ).toMatchObject({
      role: 'narration',
      content: 'Template a.',
      narration: { status: 'pending' },
    });
    expect(itemBodyBlock(item('a', null, NONE))).toEqual({
      kind: 'text',
      id: 'summary-a',
      content: 'Template a.',
      size: 'body',
      role: 'secondary',
    });
  });

  it('a card’s figure is the item’s; no figure is withheld with the reason, never a zero', () => {
    const [, figured] = briefItemBlocks(item('a', '-120000', NONE));
    expect(figured).toMatchObject({
      kind: 'money',
      amountMinor: '-120000',
      currency: 'USD',
      label: 'Per year',
    });
    const [, withheld, badge] = briefItemBlocks(item('b', null, NONE));
    expect(withheld).toMatchObject({
      kind: 'money',
      amountMinor: null,
      withheld: expect.any(String),
    });
    expect(badge).toMatchObject({ kind: 'badge', label: 'Carried from last week' });
  });

  it('the overview is a pure function of the served Brief; bars carry only the items’ own figures', () => {
    const brief: BriefForBlocks = deepFreeze({
      isoWeek: '2026-W41',
      nothingMaterial: false,
      items: [item('a', '120000', NONE), item('b', '30000', NONE), item('c', null, NONE)],
    });
    const before = JSON.stringify(brief);
    const blocks = briefOverviewBlocks(
      brief,
      { kind: 'scored', overall: 72.5, isoWeek: '2026-W41' },
      [],
    );
    expect(JSON.stringify(brief)).toBe(before);
    const parsed = blockDocument(blocks);
    const ranked = parsed.blocks.find((block) => block.id === 'brief-ranked');
    if (ranked?.kind !== 'group') throw new Error('expected the ranked group');
    const bars = ranked.blocks[0];
    if (bars?.kind !== 'horizontal-bars') throw new Error('expected bars');
    expect(bars.bars.map((bar) => [bar.rightLabel, bar.barPercent])).toEqual([
      [{ amountMinor: '120000', currency: 'USD' }, 100],
      [{ amountMinor: '30000', currency: 'USD' }, 25],
    ]);
    expect(JSON.stringify(parsed)).toContain('72.5 / 100');
  });
});

describe('the web’s test-support copy of the builders is the same code', () => {
  const squash = (text: string) => text.replace(/\s+/gu, '');
  function functionsOf(source: string): Map<string, string> {
    const found = new Map<string, string>();
    const pattern = /^(?:export )?function (\w+)[\s\S]*?^\}$/gmu;
    for (const match of source.matchAll(pattern)) found.set(match[1] ?? '', squash(match[0]));
    return found;
  }
  const copy = functionsOf(
    readFileSync(new URL('../../web/src/test-support/block-fixtures.ts', import.meta.url), 'utf8'),
  );

  it.each(['hrefs.ts', 'reports.ts', 'brief.ts'])('%s', (file) => {
    let source = readFileSync(new URL(`../src/blocks/${file}`, import.meta.url), 'utf8');
    if (file === 'brief.ts') source = source.replace(/\bmagnitude\b/gu, 'magnitudeBig');
    const server = functionsOf(source);
    expect(server.size).toBeGreaterThan(0);
    for (const [name, body] of server) {
      expect(
        copy.get(name),
        `${file}#${name} differs in apps/web/src/test-support/block-fixtures.ts`,
      ).toBe(body);
    }
  });
});
