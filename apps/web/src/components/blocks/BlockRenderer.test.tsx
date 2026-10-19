// SPDX-License-Identifier: MIT
import { BLOCK_FIXTURES } from '@core/kernel';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { renderWidget } from '../../features/dashboard/test-utils.tsx';
import { BlockDocumentView, BlockRenderer } from './BlockRenderer.tsx';
import { StackedBarsInner } from './StackedBarsBlockView.tsx';

/** WP 10.15: one test per kind, and the honesty paths the renderer exists to keep. */

function draw(blocks: readonly unknown[]) {
  return renderWidget(<BlockRenderer blocks={blocks} />);
}

function fixture(kind: string): unknown {
  const found = BLOCK_FIXTURES.valid.find((block) => block.kind === kind);
  if (found === undefined) throw new Error(`no fixture for ${kind}`);
  return found;
}

describe('BlockRenderer', () => {
  it('draws every valid fixture as its own kind, and nothing as unsupported', async () => {
    const corpus = BLOCK_FIXTURES.valid.map((block) =>
      block.kind === 'transactions-list' ? { ...block, transactionIds: [] } : block,
    );
    draw(corpus);
    const renderer = await screen.findByTestId('block-renderer');
    const kinds = [...renderer.querySelectorAll(':scope > [data-block-kind]')].map((node) =>
      node.getAttribute('data-block-kind'),
    );
    expect(kinds).toEqual(corpus.map((block) => block.kind));
    expect(screen.queryByTestId('block-unsupported')).not.toBeInTheDocument();
  });

  it('an unknown kind is a visible "Unsupported block" row, never dropped', async () => {
    draw([
      { kind: 'text', content: 'Before', size: 'body' },
      { kind: 'merchants-list' },
      { kind: 'divider' },
    ]);
    expect(await screen.findByTestId('block-unsupported')).toHaveTextContent(
      'Unsupported block (merchants-list)',
    );
    expect(screen.getByText('Before')).toBeInTheDocument();
    expect(document.querySelectorAll('[data-block-kind]')).toHaveLength(3);
  });

  it('a known kind that breaks its rules (a hex hue) is a visible "Invalid block" row', async () => {
    draw([{ kind: 'badge', label: 'x', variant: '#ff0000' }]);
    expect(await screen.findByTestId('block-unsupported')).toHaveTextContent(
      'Invalid block (badge)',
    );
  });

  it('a document of another contract version says so', async () => {
    renderWidget(<BlockDocumentView document={{ contractVersion: 2, blocks: [] }} />);
    expect(await screen.findByTestId('block-unsupported')).toHaveTextContent(
      'Unsupported block document (version 2)',
    );
  });

  it('text: a heading is a heading, a body a paragraph', async () => {
    draw([
      { kind: 'text', content: 'This week', size: 'heading' },
      { kind: 'text', content: 'Small print', size: 'caption', role: 'muted' },
    ]);
    expect(await screen.findByRole('heading', { name: 'This week', level: 3 })).toBeInTheDocument();
    expect(screen.getByText('Small print').tagName).toBe('P');
  });

  it('text, narration: the badge names the provider and model; the template is one click away', async () => {
    draw([fixture('text'), BLOCK_FIXTURES.valid[1]]);
    expect(await screen.findByText('Groceries ran higher than usual.')).toBeInTheDocument();
    expect(
      screen.getByText('Narrated by the local model qwen2.5:7b-instruct-q4_K_M'),
    ).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'See the template wording' }));
    expect(screen.getByTestId('narration-template-text')).toHaveTextContent(
      'Groceries have run higher than usual lately.',
    );
  });

  it('text, narration withheld or pending: the template wording, the badge or the note, never bare', async () => {
    draw([
      {
        kind: 'text',
        content: 'Template words.',
        size: 'body',
        role: 'narration',
        narration: {
          status: 'withheld',
          narratedBy: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
          templateContent: 'Template words.',
        },
      },
      {
        kind: 'text',
        content: 'Other template.',
        size: 'body',
        role: 'narration',
        narration: { status: 'pending', narratedBy: null, templateContent: 'Other template.' },
      },
    ]);
    expect(await screen.findByTestId('narration-withheld')).toHaveTextContent(
      'Narrated by Anthropic claude-sonnet-5-5',
    );
    expect(screen.getByTestId('narration-pending')).toBeInTheDocument();
    expect(screen.getByText('Template words.')).toBeInTheDocument();
  });

  it('info: the value, or the withheld reason', async () => {
    draw(BLOCK_FIXTURES.valid.filter((block) => block.kind === 'info'));
    expect(await screen.findByText('2026-W11')).toBeInTheDocument();
    expect(screen.getByTestId('block-withheld')).toHaveTextContent(
      'Not scored until two snapshots exist.',
    );
  });

  it('money: by-sign wears the income/expense pair; none wears the text ink', async () => {
    draw([
      {
        kind: 'money',
        id: 'a',
        label: 'Out',
        amountMinor: '-12345',
        currency: 'USD',
        signColour: 'by-sign',
      },
      {
        kind: 'money',
        id: 'b',
        label: 'In',
        amountMinor: '5000',
        currency: 'USD',
        signColour: 'by-sign',
      },
      { kind: 'money', id: 'c', label: 'Plain', amountMinor: '-700', currency: 'USD' },
    ]);
    const ink = (text: string) => screen.getByText(text).parentElement?.className ?? '';
    await screen.findByText('−$123.45');
    expect(ink('−$123.45')).toContain('text-money-neg-text');
    expect(ink('+$50.00')).toContain('text-money-pos-text');
    expect(ink('−$7.00')).not.toMatch(/text-money-(neg|pos)/);
  });

  it('money withheld: the reason in words, never a zero', async () => {
    draw([fixture('money'), BLOCK_FIXTURES.valid[5]]);
    const withheld = await screen.findByTestId('block-withheld');
    expect(withheld).toHaveTextContent('No dollar figure.');
    const saved = withheld.closest('[data-block-kind="money"]') as HTMLElement;
    expect(within(saved).queryByText(/\$0\.00|\$0\b/)).not.toBeInTheDocument();
  });

  it('horizontal-bars: rows with their figures, a linked row is a link, the table repeats them', async () => {
    draw([fixture('horizontal-bars')]);
    const group = await screen.findByRole('group', { name: 'Ranked by dollar impact' });
    expect(within(group).getByText('$1,200.00')).toBeInTheDocument();
    expect(within(group).getByRole('link', { name: /Groceries/ })).toHaveAttribute(
      'href',
      '/categories/0190a000-0000-7000-8000-000000000001',
    );
    expect(group.querySelectorAll('[data-share-bar]')).toHaveLength(2);
    expect(within(group).getByRole('button', { name: /View as table/ })).toBeInTheDocument();
  });

  it('pie: a named donut, a legend with every slice and its value, and a table', async () => {
    draw([fixture('pie')]);
    const group = await screen.findByRole('group', { name: 'Spending mix' });
    expect(
      within(group).getByRole('img', {
        name: /Spending mix: Groceries \$300\.00, Dining \$100\.00/,
      }),
    ).toBeInTheDocument();
    expect(within(group).getByRole('list', { name: 'Spending mix: legend' })).toHaveTextContent(
      '$300.00',
    );
  });

  it('stacked-bars: segments in their hues, a linked segment a link, the table with its links', async () => {
    const block = fixture('stacked-bars') as Parameters<typeof StackedBarsInner>[0]['block'];
    renderWidget(<StackedBarsInner block={block} width={480} />);
    const groceries = await screen.findByRole('link', {
      name: 'Groceries, 2026-02, $300.00, view transactions',
    });
    expect(groceries.getAttribute('fill')).toBe('var(--chart-fill-green)');
    expect(document.querySelector('[data-segment="d"]')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('stacked-bars: the table lists every segment', async () => {
    draw([fixture('stacked-bars')]);
    await userEvent.setup().click(await screen.findByRole('button', { name: /View as table/ }));
    const table = screen.getByRole('table');
    expect(within(table).getByText('Groceries')).toBeInTheDocument();
    expect(within(table).getByText('$100.00')).toBeInTheDocument();
  });

  it('sparkline-row: a named line, from the first value to the last, and a table', async () => {
    draw([fixture('sparkline-row')]);
    expect(
      await screen.findByRole('img', { name: 'Health score: 3 values from 80 to 83.75' }),
    ).toBeInTheDocument();
    expect(screen.getByText('From 80 to 83.75')).toBeInTheDocument();
  });

  it("meter: the budget meter in the block's state; no budget draws no bar", async () => {
    draw(BLOCK_FIXTURES.valid.filter((block) => block.kind === 'meter'));
    const meter = await screen.findByRole('meter', { name: 'Groceries: spent of budget' });
    expect(meter).toHaveAttribute('data-meter-state', 'on_pace');
    expect(meter.getAttribute('aria-valuetext')).toContain('55% of the period elapsed');
    expect(document.querySelector('[data-meter-tick]')).not.toBeNull();
    expect(screen.getAllByRole('meter')).toHaveLength(1);
    expect(screen.getByText(/no amount set/)).toBeInTheDocument();
  });

  it("net-worth: V6's stacked chart over the block's buckets, with its table", async () => {
    draw([fixture('net-worth')]);
    expect(await screen.findByRole('button', { name: /View as table/ })).toBeInTheDocument();
    expect(document.querySelector('[data-block-chart="net-worth"]')).not.toBeNull();
  });

  it('transactions-list: an empty list says so', async () => {
    draw([{ kind: 'transactions-list', title: 'Behind this', transactionIds: [] }]);
    expect(await screen.findByText('No transactions.')).toBeInTheDocument();
  });

  it('table: caption, row headers, money, links with their full names, badges, and "—" for nothing', async () => {
    draw([fixture('table')]);
    const table = await screen.findByRole('table', { name: 'Budget versus actual' });
    expect(
      within(table)
        .getAllByRole('rowheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Groceries', 'Rent']);
    expect(within(table).getByRole('link', { name: 'Groceries' })).toHaveAttribute(
      'href',
      '/categories/0190a000-0000-7000-8000-000000000001',
    );
    expect(within(table).getByText('$500.00')).toBeInTheDocument();
    expect(within(table).getByText('Cash')).toBeInTheDocument();
  });

  it('badge, cta, divider, group: words, an in-app link, a hairline, a titled group with nested blocks', async () => {
    draw([fixture('badge'), fixture('cta'), fixture('divider'), fixture('group')]);
    expect(await screen.findByText('Carried from last week')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See your financial health' })).toHaveAttribute(
      'href',
      '/health',
    );
    expect(screen.getByRole('separator')).toBeInTheDocument();
    const nested = screen.getByRole('group', { name: 'Nested' });
    expect(within(nested).getByRole('heading', { name: 'Nested', level: 3 })).toBeInTheDocument();
    expect(within(nested).getByText('Inner')).toBeInTheDocument();
  });

  it('a cta follows its href in-app', async () => {
    draw([fixture('cta')]);
    await userEvent
      .setup()
      .click(await screen.findByRole('link', { name: 'See your financial health' }));
    expect(await screen.findByText('screen /health')).toBeInTheDocument();
  });

  it('BlockLink refuses an href that is not an in-app path, even past the schema', async () => {
    // A table cell's href is drawn through BlockLink; feed it an already-parsed block the schema would refuse.
    const { BlockLink } = await import('./BlockLink.tsx');
    renderWidget(
      <>
        <BlockLink href="https://example.com">outside</BlockLink>
        <BlockLink href="//example.com">protocol-relative</BlockLink>
        <BlockLink href="/transactions">inside</BlockLink>
      </>,
    );
    expect(await screen.findByText('outside')).not.toHaveAttribute('href');
    expect(screen.queryByRole('link', { name: 'outside' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'protocol-relative' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'inside' })).toHaveAttribute('href', '/transactions');
  });
});
