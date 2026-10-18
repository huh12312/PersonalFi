// SPDX-License-Identifier: MIT
import type { DashboardLayoutEntry } from '../../api/generated/types.gen.ts';

/**
 * The dashboard's widgets, in their default order (WP 10.9). The server's `DASHBOARD_WIDGETS`
 * (`apps/api/src/routes/dashboard.ts`) is the same list; `layout.test.ts` pins the two together through the
 * generated contract's enum.
 */
export const WIDGET_IDS = [
  'net-worth',
  'spending-pace',
  'budgets',
  'upcoming',
  'to-review',
  'goals',
  'investments',
  'top-insights',
  // WP 10.12: the health gauge, after Top insights.
  'financial-health',
] as const satisfies readonly DashboardLayoutEntry['id'][];

export type WidgetId = (typeof WIDGET_IDS)[number];

export interface LayoutEntry {
  readonly id: WidgetId;
  readonly visible: boolean;
}

/** What the Customize sheet calls each widget (and the widget card's own title). */
export const WIDGET_TITLES: Record<WidgetId, string> = {
  'net-worth': 'Net worth',
  'spending-pace': 'Spending pace',
  budgets: 'Budgets',
  upcoming: 'Upcoming',
  'to-review': 'To review',
  goals: 'Goals',
  investments: 'Investments',
  'top-insights': 'Top insights',
  'financial-health': 'Financial health',
};

/** Widgets that span two columns of the grid where there are two or more. */
export const WIDE_WIDGETS: ReadonlySet<WidgetId> = new Set<WidgetId>(['net-worth']);

export function defaultLayout(): LayoutEntry[] {
  return WIDGET_IDS.map((id) => ({ id, visible: true }));
}

const KNOWN = new Set<string>(WIDGET_IDS);

/**
 * A layout from the server → the layout to draw: ids this build does not draw (a newer server) dropped, repeats
 * dropped, widgets the layout does not name appended, shown. The server normalises too; this is so a web build and
 * a server build that disagree about the widget list still draw every widget exactly once.
 */
export function normaliseLayout(
  entries: readonly { id: string; visible: boolean }[],
): LayoutEntry[] {
  const seen = new Set<string>();
  const out: LayoutEntry[] = [];
  for (const entry of entries) {
    if (!KNOWN.has(entry.id) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push({ id: entry.id as WidgetId, visible: entry.visible });
  }
  for (const id of WIDGET_IDS) if (!seen.has(id)) out.push({ id, visible: true });
  return out;
}

/** Move one widget up (`-1`) or down (`+1`); a move past either end is no move. */
export function moveWidget(
  layout: readonly LayoutEntry[],
  id: WidgetId,
  delta: -1 | 1,
): LayoutEntry[] {
  const index = layout.findIndex((entry) => entry.id === id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= layout.length) return [...layout];
  const next = [...layout];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved!);
  return next;
}

export function setVisible(
  layout: readonly LayoutEntry[],
  id: WidgetId,
  visible: boolean,
): LayoutEntry[] {
  return layout.map((entry) => (entry.id === id ? { ...entry, visible } : entry));
}

export function visibleWidgets(layout: readonly LayoutEntry[]): WidgetId[] {
  return layout.filter((entry) => entry.visible).map((entry) => entry.id);
}
