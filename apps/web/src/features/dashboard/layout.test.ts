// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import openapi from '../../../../../packages/contracts/openapi/openapi.json';
import {
  defaultLayout,
  moveWidget,
  normaliseLayout,
  setVisible,
  visibleWidgets,
  WIDGET_IDS,
  WIDGET_TITLES,
} from './layout.ts';

describe('the dashboard layout (WP 10.9)', () => {
  it('the web’s widget list is the contract’s, in the same order (the server’s default)', () => {
    const schemas = (openapi as { components: { schemas: Record<string, unknown> } }).components
      .schemas;
    const entry = schemas['DashboardLayoutEntry'] as { properties: { id: { enum: string[] } } };
    expect([...WIDGET_IDS]).toEqual(entry.properties.id.enum);
    expect(Object.keys(WIDGET_TITLES).sort()).toEqual([...WIDGET_IDS].sort());
  });

  it('the default: every widget, shown, net worth first', () => {
    expect(defaultLayout().map((entry) => entry.id)).toEqual([...WIDGET_IDS]);
    expect(defaultLayout().every((entry) => entry.visible)).toBe(true);
  });

  it('normalising drops unknown and repeated ids and appends the missing, shown', () => {
    const layout = normaliseLayout([
      { id: 'goals', visible: false },
      { id: 'from-the-future', visible: true },
      { id: 'goals', visible: true },
      { id: 'budgets', visible: true },
    ]);
    expect(layout.slice(0, 2)).toEqual([
      { id: 'goals', visible: false },
      { id: 'budgets', visible: true },
    ]);
    expect(layout).toHaveLength(WIDGET_IDS.length);
    expect(layout.slice(2).every((entry) => entry.visible)).toBe(true);
  });

  it('moves one step, and not past either end', () => {
    const layout = defaultLayout();
    expect(
      moveWidget(layout, 'spending-pace', -1)
        .map((entry) => entry.id)
        .slice(0, 2),
    ).toEqual(['spending-pace', 'net-worth']);
    expect(moveWidget(layout, 'net-worth', -1)).toEqual(layout);
    // The last widget (WP 10.12: Financial health, after Top insights) cannot move further down.
    expect(moveWidget(layout, 'financial-health', 1)).toEqual(layout);
    expect(WIDGET_IDS.slice(-2)).toEqual(['top-insights', 'financial-health']);
  });

  it('a hidden widget is not among the visible', () => {
    const layout = setVisible(defaultLayout(), 'budgets', false);
    expect(visibleWidgets(layout)).not.toContain('budgets');
    expect(visibleWidgets(layout)).toHaveLength(WIDGET_IDS.length - 1);
  });
});
