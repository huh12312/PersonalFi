// SPDX-License-Identifier: MIT
/**
 * Which hue a chart entity is drawn in (WP 10.8; docs/design/tokens.md "a hue is assigned once").
 *
 *  - **Categories** carry a persisted `hue` (`categories.hue`, migration 0045), seeded on the server's first
 *    read with `hueForId(id)` from `@core/kernel` and editable after. `categoryHue(id, persisted)` returns the
 *    persisted hue when the caller has it and the same seed otherwise, so a chart drawn before the categories
 *    list arrives, or for an archived category the list omits, paints what the server would have stored.
 *  - **Account types** have a fixed hue, in code (`ACCOUNT_KIND_HUES`).
 *  - **Positional series** (donut slices, a currency per line) take `CHART_FILL_ORDER[i]`, the order whose
 *    adjacent pairs pass the dataviz checks — never cycled: past the thirteenth a series is neutral ("Other").
 *
 * Uncategorised (`null`) and the `other` account type are the neutral fill, never a hue.
 */
import { hueForId, isChartHue, type ChartHue } from '@core/kernel';

import { CHART_FILL_ORDER } from '../../styles/tokens/fills.ts';

export type FillHue = ChartHue | 'neutral';

export function categoryHue(categoryId: string | null, persisted?: string | null): FillHue {
  if (categoryId === null || categoryId === '') return 'neutral';
  if (isChartHue(persisted)) return persisted;
  return hueForId(categoryId);
}

/** `var(--chart-fill-<hue>)` — the mark colour for a hue. */
export function chartFillVar(hue: FillHue): string {
  return `var(--chart-fill-${hue})`;
}

export type ChartEventRole = 'bg' | 'border' | 'dot' | 'fg';

/** `var(--chart-event-<role>-<hue>)` — a timeline marker's wash, border, dot or label ink. */
export function chartEventVar(role: ChartEventRole, hue: ChartHue): string {
  return `var(--chart-event-${role}-${hue})`;
}

export function categoryFillVar(categoryId: string | null, persisted?: string | null): string {
  return chartFillVar(categoryHue(categoryId, persisted));
}

/** The six account kinds a chart groups by. */
export type AccountKind = 'cash' | 'investments' | 'crypto' | 'property' | 'liabilities' | 'other';

export const ACCOUNT_KIND_HUES: Readonly<Record<AccountKind, FillHue>> = {
  cash: 'teal',
  investments: 'indigo',
  crypto: 'orange',
  property: 'brown',
  liabilities: 'red',
  other: 'neutral',
};

export function accountTypeHue(kind: AccountKind): FillHue {
  return ACCOUNT_KIND_HUES[kind];
}

const PROPERTY_SUBTYPES = new Set(['property', 'real_estate', 'home', 'vehicle']);

/** An account's wire `type` (and `subtype`, for manual accounts) → the kind a chart colours it by. */
export function accountKindOf(type: string, subtype?: string | null): AccountKind {
  switch (type) {
    case 'depository':
      return 'cash';
    case 'investment':
      return 'investments';
    case 'crypto':
      return 'crypto';
    case 'credit':
    case 'loan':
      return 'liabilities';
    case 'manual':
      return subtype !== undefined && subtype !== null && PROPERTY_SUBTYPES.has(subtype)
        ? 'property'
        : 'other';
    default:
      return 'other';
  }
}

/** The hue of the `index`th positional series; neutral past the thirteenth (fold into "Other", never cycle). */
export function seriesHue(index: number): FillHue {
  return CHART_FILL_ORDER[index] ?? 'neutral';
}
