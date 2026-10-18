// SPDX-License-Identifier: MIT
/**
 * The chart-hue vocabulary (WP 10.8, docs/research/10-visual-design-notes.md §3 V1).
 *
 * Thirteen named hues — Radix Colors scales, vendored in `apps/web/src/styles` — that a category, an account
 * type or any other chart entity is drawn in. The names are the contract: the database stores one of them
 * (`categories.hue`, migration 0045, CHECK over exactly this list), the web reads `--chart-fill-<hue>`.
 *
 * It lives in the kernel because two contexts must agree on it byte for byte: `@ctx/categorization` assigns a
 * hue to a category on first read and persists it, and the web computes the same hue for a category it has not
 * yet seen a persisted value for. Both call `hueForId`; neither has its own hash.
 *
 * **A hue is assigned once.** `hueForId` only seeds the first value; after that the stored hue is the truth
 * (a user may change it), and nothing re-derives it.
 */
export const CHART_HUES = [
  'teal',
  'green',
  'red',
  'orange',
  'yellow',
  'cyan',
  'purple',
  'indigo',
  'lime',
  'mint',
  'pink',
  'brown',
  'sky',
] as const;

export type ChartHue = (typeof CHART_HUES)[number];

export function isChartHue(value: unknown): value is ChartHue {
  return typeof value === 'string' && (CHART_HUES as readonly string[]).includes(value);
}

/**
 * Deterministic hue for an id: 32-bit FNV-1a over the id's UTF-16 code units (lower-cased, so a UUID's case
 * never changes its hue), reduced modulo 13. FNV-1a's low bits are well mixed, so v7 UUIDs that share a long
 * timestamp prefix still spread evenly over the thirteen (pinned by a distribution test).
 */
export function hueForId(id: string): ChartHue {
  const text = id.toLowerCase();
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return CHART_HUES[hash % CHART_HUES.length] as ChartHue;
}
