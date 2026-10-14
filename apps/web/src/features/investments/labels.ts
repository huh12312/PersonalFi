// SPDX-License-Identifier: MIT
import type { AggregatedHolding } from '../../api/generated/types.gen.ts';
import type { AllocationDimension } from './search.ts';

type AssetClass = AggregatedHolding['assetClass'];
type Region = AggregatedHolding['region'];

/**
 * Wire enum → the words a person reads. Display only: the enum value itself
 * is what goes back to the API (`?target=US_EQUITY:0.6`), never the label.
 */
const ASSET_CLASS_LABELS: Record<AssetClass, string> = {
  US_EQUITY: 'US equity',
  INTL_DEV_EQUITY: 'International developed equity',
  EM_EQUITY: 'Emerging-market equity',
  US_BOND: 'US bonds',
  INTL_BOND: 'International bonds',
  TIPS: 'TIPS',
  REAL_ESTATE: 'Real estate',
  COMMODITY: 'Commodities',
  CRYPTO: 'Crypto',
  CASH: 'Cash',
  OTHER: 'Other',
  UNCLASSIFIED: 'Unclassified',
};

const REGION_LABELS: Record<Region, string> = {
  US: 'United States',
  DEV_EX_US: 'Developed ex-US',
  EM: 'Emerging markets',
  GLOBAL: 'Global',
  UNKNOWN: 'Unknown',
};

export function assetClassLabel(value: string): string {
  return ASSET_CLASS_LABELS[value as AssetClass] ?? value;
}

export function regionLabel(value: string): string {
  return REGION_LABELS[value as Region] ?? value;
}

/**
 * A slice key's label, by the dimension it came from. Sector keys are already
 * free text from the classifier (`"Information Technology"`, `"UNKNOWN"`), so
 * only the two enum dimensions get a lookup.
 */
export function sliceLabel(dimension: AllocationDimension, key: string): string {
  if (dimension === 'asset_class') return assetClassLabel(key);
  if (dimension === 'region') return regionLabel(key);
  return key === 'UNKNOWN' ? 'Unknown' : key;
}

export const DIMENSION_LABELS: Record<AllocationDimension, string> = {
  asset_class: 'Asset class',
  region: 'Region',
  sector: 'Sector',
};

const SECURITY_TYPE_LABELS: Record<AggregatedHolding['securityType'], string> = {
  equity: 'Equity',
  etf: 'ETF',
  mutual_fund: 'Mutual fund',
  crypto: 'Crypto',
  bond: 'Bond',
  cash: 'Cash',
  other: 'Other',
};

export function securityTypeLabel(value: AggregatedHolding['securityType']): string {
  return SECURITY_TYPE_LABELS[value];
}

const BASIS_METHOD_LABELS: Record<string, string> = {
  FIFO: 'FIFO — first in, first out',
  LIFO: 'LIFO — last in, first out',
  HIFO: 'HIFO — highest cost first',
  SPECIFIC_ID: 'Specific identification',
  AVERAGE_COST: 'Average cost (mutual funds only)',
};

export function basisMethodLabel(value: string): string {
  return BASIS_METHOD_LABELS[value] ?? value;
}

const EXCLUSION_REASONS: Record<string, string> = {
  stale_price: 'the price is stale',
  price_unknown: 'no price is known',
  currency_mismatch: 'its currency differs from the portfolio currency',
  // WP 10.4: a position whose security nobody could identify (`holdingId` is the unresolved row's id).
  security_unresolved: 'the security could not be identified',
};

export function exclusionReasonLabel(reason: string): string {
  return EXCLUSION_REASONS[reason] ?? reason;
}

/**
 * What an `excluded[]` entry is called. The api sends the ticker (or, for an unidentified position, the
 * provider's own name) as `symbol`; an id is never shown for an unidentified position, because it is a row id
 * that changes on every sync, not something a holder can recognise.
 */
export function excludedItemLabel(item: {
  readonly holdingId: string;
  readonly symbol: string | null;
  readonly reason: string;
}): string {
  if (item.symbol !== null) return item.symbol;
  return item.reason === 'security_unresolved' ? 'An unnamed position' : item.holdingId;
}

const UNREALIZED_REASONS: Record<string, string> = {
  basis_unknown: 'cost basis unknown',
  price_unknown: 'price unknown',
  currency_mismatch: 'currency mismatch',
};

export function unrealizedReasonLabel(reason: string | null): string | null {
  if (reason === null) return null;
  return UNREALIZED_REASONS[reason] ?? reason;
}

/**
 * A wire `Ratio` decimal string (`"0.4323001299"`) as a `number`, for
 * `formatPercent` and for the geometry of an arc.
 *
 * This is the only string→number conversion in this feature and it is
 * presentation-only: docs/plan/03-phase-3-dispatch.md's risk table permits
 * `toNumberApproximate` "for presentation", and no money value ever goes
 * through it — every dollar figure on these screens is rendered straight
 * from the server's `Money` wire shape by `<Money>`.
 */
export function ratioToNumber(ratio: string): number {
  const parsed = Number(ratio);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** A wire percentage-points decimal string (`"-3.25"`) as a `number`, presentation only. */
export function pointsToNumber(points: string): number {
  const parsed = Number(points);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** WP 10.3: the Activity tab's "Type" column and filter. */
export const ACTIVITY_KIND_LABELS: Readonly<Record<string, string>> = {
  buy: 'Buy',
  sell: 'Sell',
  dividend: 'Dividend',
  reinvested_dividend: 'Reinvested dividend',
  interest: 'Interest',
  contribution: 'Contribution / transfer in',
  withdrawal: 'Withdrawal / transfer out',
  fee: 'Fee',
  tax: 'Tax withheld',
  split: 'Split',
  other: 'Other',
};

export function activityKindLabel(kind: string): string {
  return ACTIVITY_KIND_LABELS[kind] ?? kind;
}

/** WP 10.3: who manages an account, as the holder reads it. */
export const MANAGEMENT_SCOPE_LABELS: Readonly<Record<string, string>> = {
  advisor: 'Advisor',
  robo_advisor: 'Robo-advisor',
  self_directed: 'Self-directed',
  unclassified: 'Not classified',
};

export function managementLabel(value: string): string {
  return MANAGEMENT_SCOPE_LABELS[value] ?? value;
}

/** `BROKER`/`IMPORTED`/`USER` → where the row came from, in words. */
export function activitySourceLabel(source: string): string {
  switch (source) {
    case 'BROKER':
      return 'Broker';
    case 'IMPORTED':
      return 'Imported';
    case 'USER':
      return 'Entered by you';
    default:
      return source;
  }
}
