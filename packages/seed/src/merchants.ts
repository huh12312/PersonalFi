// SPDX-License-Identifier: MIT
import { pick, randomInt, randomUuid, type Rng } from './prng.ts';
import type { SeedMerchant } from './types.ts';

/**
 * Realistic statement-descriptor noise.
 *
 * A categoriser and a merchant-normalisation pipeline (Phase 1, 08 §5.2) live
 * or die on descriptors that look like what a bank actually sends, not a clean
 * `canonicalName`. Each style below is a real, recognisable pattern:
 *
 *   - `square`     `SQ *BLUE BOTTLE COFFEE`      — Square-processed card-present
 *   - `toast`      `TST* THE FRENCH LAUNDRY`      — Toast POS (restaurants)
 *   - `amazon`     `AMZN Mktp US*2K4TT1FF2`       — Amazon order-id suffix
 *   - `storeNumber``COSTCO WHSE #1234 SEATTLE WA` — big-box with a store number
 *   - `cityState`  `SHELL OIL 57443021 PORTLAND OR` — gas/utility with a city tail
 *   - `plain`      `NETFLIX.COM`                   — subscriptions rarely add noise
 */
type DescriptorStyle = 'square' | 'toast' | 'amazon' | 'storeNumber' | 'cityState' | 'plain';

export interface MerchantTemplate {
  readonly canonicalName: string;
  readonly category: string;
  readonly style: DescriptorStyle;
  /** Typical single-purchase amount range, as positive decimal dollars. */
  readonly amountRange: readonly [number, number];
}

/** ~30 merchants spanning the categories a demo household actually spends in. */
export const MERCHANT_CATALOG: readonly MerchantTemplate[] = [
  { canonicalName: 'Blue Bottle Coffee', category: 'dining', style: 'square', amountRange: [4, 9] },
  {
    canonicalName: 'The French Laundry',
    category: 'dining',
    style: 'toast',
    amountRange: [40, 220],
  },
  {
    canonicalName: "Trader Joe's",
    category: 'groceries',
    style: 'storeNumber',
    amountRange: [25, 140],
  },
  {
    canonicalName: 'Whole Foods Market',
    category: 'groceries',
    style: 'storeNumber',
    amountRange: [30, 180],
  },
  {
    canonicalName: 'Costco Wholesale',
    category: 'groceries',
    style: 'storeNumber',
    amountRange: [60, 320],
  },
  { canonicalName: 'Safeway', category: 'groceries', style: 'storeNumber', amountRange: [20, 150] },
  { canonicalName: 'Amazon', category: 'shopping', style: 'amazon', amountRange: [8, 220] },
  { canonicalName: 'Target', category: 'shopping', style: 'storeNumber', amountRange: [15, 160] },
  { canonicalName: 'Shell Oil', category: 'transport', style: 'cityState', amountRange: [30, 75] },
  { canonicalName: 'Chevron', category: 'transport', style: 'cityState', amountRange: [30, 75] },
  { canonicalName: 'Uber', category: 'transport', style: 'plain', amountRange: [9, 45] },
  { canonicalName: 'Lyft', category: 'transport', style: 'plain', amountRange: [9, 45] },
  {
    canonicalName: 'Netflix',
    category: 'subscriptions',
    style: 'plain',
    amountRange: [15.49, 15.49],
  },
  {
    canonicalName: 'Spotify',
    category: 'subscriptions',
    style: 'plain',
    amountRange: [11.99, 11.99],
  },
  { canonicalName: 'iCloud', category: 'subscriptions', style: 'plain', amountRange: [2.99, 2.99] },
  {
    canonicalName: 'Adobe Creative Cloud',
    category: 'subscriptions',
    style: 'plain',
    amountRange: [59.99, 59.99],
  },
  {
    canonicalName: 'Planet Fitness',
    category: 'health',
    style: 'plain',
    amountRange: [24.99, 24.99],
  },
  { canonicalName: 'Equinox', category: 'health', style: 'plain', amountRange: [220, 220] },
  {
    canonicalName: 'Kaiser Permanente',
    category: 'health',
    style: 'plain',
    amountRange: [35, 220],
  },
  { canonicalName: 'CVS Pharmacy', category: 'health', style: 'storeNumber', amountRange: [8, 60] },
  { canonicalName: 'PG&E', category: 'utilities', style: 'plain', amountRange: [60, 260] },
  {
    canonicalName: 'Comcast Xfinity',
    category: 'utilities',
    style: 'plain',
    amountRange: [79.99, 79.99],
  },
  { canonicalName: 'AT&T Wireless', category: 'utilities', style: 'plain', amountRange: [85, 85] },
  {
    canonicalName: 'State Farm Insurance',
    category: 'insurance',
    style: 'plain',
    amountRange: [140, 140],
  },
  {
    canonicalName: 'Chase Mortgage',
    category: 'housing',
    style: 'plain',
    amountRange: [2200, 2200],
  },
  {
    canonicalName: 'AMC Theatres',
    category: 'entertainment',
    style: 'storeNumber',
    amountRange: [12, 45],
  },
  {
    canonicalName: "Dave's Hot Chicken",
    category: 'dining',
    style: 'square',
    amountRange: [10, 28],
  },
  { canonicalName: 'Philz Coffee', category: 'dining', style: 'square', amountRange: [4, 8] },
  { canonicalName: 'REI', category: 'shopping', style: 'storeNumber', amountRange: [20, 300] },
  { canonicalName: 'Delta Air Lines', category: 'travel', style: 'plain', amountRange: [180, 650] },
  {
    canonicalName: 'Marriott Hotels',
    category: 'travel',
    style: 'cityState',
    amountRange: [140, 420],
  },
  // Not somewhere the household spends — the source of its own income
  // (biweekly payroll deposit, `transactions.ts`'s one non-spending series).
  {
    canonicalName: 'Acme Corp Payroll',
    category: 'income',
    style: 'plain',
    amountRange: [3_100, 3_100],
  },
] as const;

const CITY_STATES = [
  ['SEATTLE', 'WA'],
  ['PORTLAND', 'OR'],
  ['OAKLAND', 'CA'],
  ['DENVER', 'CO'],
  ['AUSTIN', 'TX'],
  ['CHICAGO', 'IL'],
] as const;

function alnum(rng: Rng, length: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < length; i += 1) out += pick(rng, [...alphabet]);
  return out;
}

/** Render one raw statement descriptor for `template`, with per-call noise. */
export function renderDescriptor(rng: Rng, template: MerchantTemplate): string {
  const name = template.canonicalName.toUpperCase();
  const [city, state] = pick(rng, CITY_STATES);
  switch (template.style) {
    case 'square':
      return `SQ *${name}`;
    case 'toast':
      return `TST* ${name}`;
    case 'amazon':
      return `AMZN Mktp US*${alnum(rng, 7)}`;
    case 'storeNumber':
      return `${name} #${randomInt(rng, 100, 9_999)} ${city} ${state}`;
    case 'cityState':
      return `${name} ${randomInt(rng, 10_000_00, 99_999_99)} ${city} ${state}`;
    case 'plain':
      return name;
  }
}

/** Materialise the catalog into `SeedMerchant`s with deterministic ids. */
export function createMerchants(rng: Rng): SeedMerchant[] {
  return MERCHANT_CATALOG.map((template) => ({
    id: randomUuid(rng),
    canonicalName: template.canonicalName,
    category: template.category,
  }));
}
