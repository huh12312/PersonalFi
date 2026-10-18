// SPDX-License-Identifier: MIT
/**
 * Net worth by account type, bucketed (WP 10.13, V6 of the visual programme): the stacked bars under
 * the net line on the dashboard widget and the full history.
 *
 * ## The bucketing rule
 *
 * A bucket is a calendar **day**, an ISO **week** (Monday to Sunday) or a calendar **month**, in the
 * holder's own calendar (`as_of_date` is already a local business date). Its figure is the **closing**
 * one: the current revision of the **last day in the bucket, inside the requested window, that has a
 * snapshot** — net worth is a stock, so a week's bar is where the week ended, never a sum or an average
 * of its days. The first and last buckets are cut at the window's edges (a window opening on a Thursday
 * starts with a Thursday-to-Sunday week). A bucket with no snapshot at all is returned with no figure
 * (`asOfDate`, `netWorthMinor` null, no segments) — a gap, never a zero.
 *
 * ## Segments sum to the net, exactly
 *
 * The segments are the closing day's `breakdown` entries that count towards net worth (`inNetWorth`),
 * summed by account type in minor units of the day's base currency. `net_worth_minor` is
 * `assets_minor - liabilities_minor` (0017's CHECK), and `net-worth.ts` builds both from the same
 * `inNetWorth` entries with a liability's contribution stored signed, so Σ segments = net worth for every
 * bucket, by construction — and `test/db/buckets.test.ts` asserts it against `readSeries` anyway.
 *
 * ## Account type
 *
 * The six kinds the web colours by `accountTypeHue` (cash → teal, investments → indigo, crypto → orange,
 * property → brown, liabilities → red, other → neutral). The breakdown stores Planning's own valuation
 * class (`cash | credit | loan | investment | manual_asset | other`) and the side, which cannot tell
 * crypto from a brokerage account or a house from a savings bond, so the composition root hands in the
 * ledger's `type`/`subtype` per account (`SegmentAccountLookup`); an account the ledger no longer lists
 * falls back to the breakdown's own class. **The side decides first**: every liability-side entry is
 * `liabilities`, whatever its type, because that is the split `liabilities_minor` was summed by.
 *
 * ## One read
 *
 * One statement: the current revision per day, the closing day per bucket (both `DISTINCT ON` over the
 * series index), and only those days' breakdowns unnested. A ten-year window reads 3,653 small index rows
 * and detoasts ~120 breakdowns.
 */
import { DateOnly } from '@core/kernel';
import { sql } from 'drizzle-orm';
import type { PlanningExecutor } from './store.ts';

export const NET_WORTH_BUCKETINGS = ['day', 'week', 'month'] as const;
export type NetWorthBucketing = (typeof NET_WORTH_BUCKETINGS)[number];

/** The six account types, in stacking order: assets outward from the zero line, liabilities below it. */
export const NET_WORTH_SEGMENT_KINDS = [
  'cash',
  'investments',
  'crypto',
  'property',
  'other',
  'liabilities',
] as const;
export type NetWorthSegmentKind = (typeof NET_WORTH_SEGMENT_KINDS)[number];

export interface NetWorthSegment {
  readonly kind: NetWorthSegmentKind;
  /** Σ of the type's signed contributions, minor units of the bucket's currency. */
  readonly amountMinor: bigint;
  /** How many accounts contributed. */
  readonly accounts: number;
}

export interface NetWorthBucket {
  /** First and last calendar day of the bucket, cut at the window's edges. */
  readonly start: string;
  readonly end: string;
  /** The closing snapshot day the figure is from; `null` when the bucket has no snapshot. */
  readonly asOfDate: string | null;
  readonly currency: string | null;
  readonly netWorthMinor: bigint | null;
  /** Only the kinds present on the closing day, in `NET_WORTH_SEGMENT_KINDS` order. */
  readonly segments: readonly NetWorthSegment[];
}

/** The ledger's account type and subtype, by account id — the composition root's lookup. */
export type SegmentAccountLookup = ReadonlyMap<
  string,
  { readonly type: string; readonly subtype: string | null }
>;

/** Manual-account subtypes drawn as property (the web's `accountKindOf` uses the same set). */
const PROPERTY_SUBTYPES = new Set(['property', 'real_estate', 'home', 'vehicle']);

/**
 * The account type a breakdown entry is drawn as. The side decides first (every liability-side entry is
 * `liabilities`); then the ledger's type and subtype when the account is known; else Planning's own
 * valuation class.
 */
export function segmentKindOf(
  entry: { readonly kind: string; readonly side: string },
  account?: { readonly type: string; readonly subtype: string | null },
): NetWorthSegmentKind {
  if (entry.side === 'liability') return 'liabilities';
  if (account !== undefined) {
    switch (account.type) {
      case 'depository':
        return 'cash';
      case 'investment':
        return 'investments';
      case 'crypto':
        return 'crypto';
      case 'manual':
        return account.subtype !== null && PROPERTY_SUBTYPES.has(account.subtype)
          ? 'property'
          : 'other';
      default:
        return 'other';
    }
  }
  switch (entry.kind) {
    case 'cash':
      return 'cash';
    case 'investment':
      return 'investments';
    default:
      return 'other';
  }
}

/** The first day of the bucket holding `date`: the day itself, the Monday on or before it, or the 1st. */
export function bucketStartOf(date: string, bucketing: NetWorthBucketing): string {
  const day = DateOnly.parse(date);
  switch (bucketing) {
    case 'day':
      return day;
    case 'week': {
      // dayOfWeek: 0 = Sunday … 6 = Saturday. Monday-start (ISO): Sunday goes back six days.
      const offset = (DateOnly.dayOfWeek(day) + 6) % 7;
      return DateOnly.addDays(day, -offset);
    }
    case 'month':
      return DateOnly.startOfMonth(day);
  }
}

function bucketLastDayOf(start: DateOnly, bucketing: NetWorthBucketing): DateOnly {
  switch (bucketing) {
    case 'day':
      return start;
    case 'week':
      return DateOnly.addDays(start, 6);
    case 'month':
      return DateOnly.endOfMonth(start);
  }
}

/** Every bucket touching `[from, to]`, oldest first, each cut at the window's edges. */
export function bucketSpine(
  from: string,
  to: string,
  bucketing: NetWorthBucketing,
): { readonly key: string; readonly start: string; readonly end: string }[] {
  const lo = DateOnly.parse(from);
  const hi = DateOnly.parse(to);
  const spine: { key: string; start: string; end: string }[] = [];
  let key = DateOnly.parse(bucketStartOf(lo, bucketing));
  while (!DateOnly.isAfter(key, hi)) {
    const last = bucketLastDayOf(key, bucketing);
    spine.push({ key, start: DateOnly.max(key, lo), end: DateOnly.min(last, hi) });
    key = DateOnly.addDays(last, 1);
  }
  return spine;
}

interface BucketRow extends Record<string, unknown> {
  bucket_start: string;
  as_of_date: string;
  base_currency: string;
  net_worth_minor: string | bigint;
  account_id: string | null;
  entry_kind: string | null;
  side: string | null;
  base_minor: string | bigint | null;
}

/** The SQL expression for a day's bucket key — the same rule as `bucketStartOf`. */
function bucketKeySql(bucketing: NetWorthBucketing) {
  switch (bucketing) {
    case 'day':
      return sql`as_of_date`;
    case 'week':
      // ISO day of week: Monday = 1 … Sunday = 7, so Monday is `as_of_date - 0`.
      return sql`(as_of_date - (extract(isodow FROM as_of_date)::int - 1))`;
    case 'month':
      return sql`date_trunc('month', as_of_date::timestamp)::date`;
  }
}

/**
 * Every bucket in `[from, to]` with its closing figure and its segments by account type, in one read of
 * `net_worth_daily`. A bucket with no snapshot is present with nulls (a gap).
 */
export async function readNetWorthBuckets(
  executor: PlanningExecutor,
  input: {
    readonly userId: string;
    readonly from: string;
    readonly to: string;
    readonly bucketing: NetWorthBucketing;
    readonly accounts: SegmentAccountLookup;
  },
): Promise<readonly NetWorthBucket[]> {
  const key = bucketKeySql(input.bucketing);
  const result = await executor.execute<BucketRow>(sql`
    WITH days AS (
      SELECT DISTINCT ON (as_of_date) id, as_of_date
        FROM net_worth_daily
       WHERE user_id = ${input.userId}::uuid
         AND as_of_date >= ${input.from}::date
         AND as_of_date <= ${input.to}::date
       ORDER BY as_of_date, revision DESC
    ),
    closing AS (
      SELECT DISTINCT ON (bucket_start) bucket_start, id
        FROM (SELECT id, as_of_date, ${key} AS bucket_start FROM days) AS keyed
       ORDER BY bucket_start, as_of_date DESC
    )
    SELECT to_char(closing.bucket_start, 'YYYY-MM-DD') AS bucket_start,
           to_char(n.as_of_date, 'YYYY-MM-DD') AS as_of_date,
           n.base_currency,
           n.net_worth_minor,
           entry ->> 'accountId' AS account_id,
           entry ->> 'kind' AS entry_kind,
           entry ->> 'side' AS side,
           entry ->> 'baseMinor' AS base_minor
      FROM closing
      JOIN net_worth_daily AS n ON n.id = closing.id
      LEFT JOIN LATERAL jsonb_array_elements(n.breakdown) AS entry
             ON (entry ->> 'inNetWorth')::boolean
     ORDER BY closing.bucket_start
  `);

  interface Acc {
    asOfDate: string;
    currency: string;
    netWorthMinor: bigint;
    sums: Map<NetWorthSegmentKind, { amountMinor: bigint; accounts: number }>;
  }
  const byKey = new Map<string, Acc>();
  for (const row of result.rows) {
    const keyText = String(row.bucket_start).slice(0, 10);
    let acc = byKey.get(keyText);
    if (acc === undefined) {
      acc = {
        asOfDate: String(row.as_of_date).slice(0, 10),
        currency: row.base_currency.trim(),
        netWorthMinor: BigInt(row.net_worth_minor),
        sums: new Map(),
      };
      byKey.set(keyText, acc);
    }
    if (row.account_id === null || row.base_minor === null) continue;
    const kind = segmentKindOf(
      { kind: row.entry_kind ?? 'other', side: row.side ?? 'asset' },
      input.accounts.get(row.account_id),
    );
    const sum = acc.sums.get(kind) ?? { amountMinor: 0n, accounts: 0 };
    sum.amountMinor += BigInt(row.base_minor);
    sum.accounts += 1;
    acc.sums.set(kind, sum);
  }

  return bucketSpine(input.from, input.to, input.bucketing).map(({ key: keyText, start, end }) => {
    const acc = byKey.get(keyText);
    if (acc === undefined) {
      return { start, end, asOfDate: null, currency: null, netWorthMinor: null, segments: [] };
    }
    const segments: NetWorthSegment[] = [];
    for (const kind of NET_WORTH_SEGMENT_KINDS) {
      const sum = acc.sums.get(kind);
      if (sum !== undefined) segments.push({ kind, ...sum });
    }
    return {
      start,
      end,
      asOfDate: acc.asOfDate,
      currency: acc.currency,
      netWorthMinor: acc.netWorthMinor,
      segments,
    };
  });
}
