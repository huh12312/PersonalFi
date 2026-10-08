// SPDX-License-Identifier: MIT
/**
 * `PriceReader` — 08 §1.3 #7's `price(securityId, date, currency)`, 07 §6.1's
 * ladder, and the 24-hour staleness rule.
 *
 * ## The ladder (07 §6.1)
 *
 * *"user override > exchange fill > CoinGecko/CoinPaprika free API > last
 * known."* Four rungs, tried strongest-first, first answer wins:
 *
 *   1. **`user_override`** — the user typed a number. Nothing outranks a human
 *      who looked at the position and disagreed, which is why the migration
 *      pins this rung to 1 with a CHECK rather than trusting a seed.
 *   2. **`exchange_fill`** — a price we actually *paid*, taken from an
 *      investment transaction on that day. It beats any provider quote because
 *      it is not an estimate of anything; it is what happened.
 *   3. **The providers**, in the order `price_source_priority` says — Tiingo
 *      for equities and funds, CoinGecko for crypto (D17).
 *   4. **`last_known`** — no row for this date, so the most recent *earlier*
 *      observation is carried forward and **labelled**.
 *
 * The ladder is per security kind and user-editable (§6 of the dispatch), so it
 * is rows in `price_source_priority` rather than an `ORDER BY` in this file.
 * `DEFAULT_LADDERS` below is what an install starts with.
 *
 * ## `last_known` is a label, never a row
 *
 * 07 §6.1: *"Store price_snapshot(asset, ts, price, source) — **never recompute
 * history from today's price**."* A carry-forward that got written back as an
 * observation would do exactly that: tomorrow's refresh would find a row for
 * today, carry *it* forward, and within a week the chart would be a flat line
 * made of one real print. So `last_known` is absent from `prices.source`'s
 * CHECK (`prices_source_is_an_observation`) and appears only here, on the way
 * out, as `rung: 'last_known'` with `carriedForward: true`.
 *
 * `src/prices.test.ts` → `'a carry-forward is a label, never a written row'`.
 *
 * ## Staleness is a statement about *now*, so it is computed, not stored
 *
 * 07 §6.1: *"if last price > 24h old, mark the holding STALE and exclude from
 * 'as of now' deltas."* That is a claim about the clock at read time. A boolean
 * written at insert time is correct for a day and then silently wrong forever
 * while still reading as authoritative — the worst kind of wrong, because
 * nothing about the row looks stale.
 *
 * So `prices.observed_at` records when the provider answered, and
 * `priceStalenessOf(observedAt, now)` decides. The only stored flag,
 * `prices.stale`, is a *different and narrower* fact: the provider itself
 * served a carry-forward rather than a close for the day asked about. Both
 * travel on the read model, and `providerCarriedForward` is named so it cannot
 * be mistaken for the clock rule.
 *
 * `src/prices.test.ts` → `'a price older than 24 h is STALE and excluded from
 * as-of-now deltas'`.
 */
import type { Clock } from '@core/kernel';
import { newId, systemClock } from '@core/kernel';
import { and, eq, sql } from 'drizzle-orm';
import {
  prices,
  priceSourcePriority,
  type PriceRowSource,
  type PriceSourceName,
} from '../schema/index.ts';
import type { InvestmentsExecutor } from './store.ts';

/**
 * 07 §6.1's threshold, as a constant rather than a magic number at the
 * comparison site.
 */
export const PRICE_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * `FRESH` or `STALE`. A closed pair rather than a boolean, because
 * `stale: false` and `fresh: true` read identically at a call site and one of
 * them is always the wrong way round.
 */
export type PriceStaleness = 'FRESH' | 'STALE';

/**
 * The rule, in one place.
 *
 * Strictly greater than 24 hours is STALE; exactly 24 hours is not. A boundary
 * has to fall somewhere and "older than 24h" (07 §6.1's words) is the reading
 * that makes a price taken at yesterday's close still fresh at today's close.
 * A future `observedAt` — a clock skew between the worker and Postgres — is
 * FRESH rather than an error; it is not this function's job to police clocks,
 * and treating skew as staleness would hide prices that had just arrived.
 */
export function priceStalenessOf(observedAt: Date, now: Date): PriceStaleness {
  return now.getTime() - observedAt.getTime() > PRICE_STALE_AFTER_MS ? 'STALE' : 'FRESH';
}

/**
 * One answer from the ladder, with everything a caller needs to decide whether
 * it may use it.
 */
export interface PricePoint {
  readonly securityId: string;
  /** The date of the observation used — **not** necessarily the date asked for. */
  readonly priceDate: string;
  readonly close: string;
  readonly currency: string;
  /** Which rung answered. `last_known` never appears on a stored row. */
  readonly rung: PriceSourceName;
  /** The stored row's own source. `null` when the rung is `last_known`'s label. */
  readonly source: PriceRowSource;
  /** No observation for the date asked for; an earlier one was carried forward. */
  readonly carriedForward: boolean;
  /** The *provider* said it was serving a carry-forward. Not the clock rule. */
  readonly providerCarriedForward: boolean;
  readonly observedAt: Date;
  /** 07 §6.1's 24-hour rule, computed against the clock at read time. */
  readonly staleness: PriceStaleness;
  /**
   * 07 §6.1: a STALE price is *"excluded from 'as of now' deltas"*.
   *
   * Computed here rather than left to each caller, because "is this price
   * allowed into a delta?" is one rule and five callers re-deriving it is five
   * chances to get it wrong. A net-worth seal still *uses* a stale price — 08
   * §3.7 says it seals with the last known price flagged `stale_price` — so
   * this flag governs deltas, not display.
   */
  readonly includeInAsOfNowDeltas: boolean;
}

/** One stored `prices` row, in the shape the ladder reasons about. */
export interface PriceRecord {
  readonly securityId: string;
  readonly priceDate: string;
  readonly close: string;
  readonly currency: string;
  readonly source: PriceRowSource;
  readonly stale: boolean;
  readonly observedAt: Date;
}

/**
 * The default ladder per security kind, seeded into `price_source_priority`.
 *
 * Rung numbers are sparse on purpose: `user_override` is pinned to 1 and
 * `last_known` to 99 by CHECK, and leaving gaps between the provider rungs lets
 * a user insert a source without renumbering the ones below it.
 */
export const DEFAULT_LADDERS: Readonly<Record<string, readonly PriceSourceName[]>> = Object.freeze({
  equity: Object.freeze(['user_override', 'exchange_fill', 'tiingo', 'last_known'] as const),
  etf: Object.freeze(['user_override', 'exchange_fill', 'tiingo', 'last_known'] as const),
  mutual_fund: Object.freeze(['user_override', 'exchange_fill', 'tiingo', 'last_known'] as const),
  // D17: CoinGecko is the crypto source. An exchange fill still outranks it —
  // what we paid on Coinbase beats what CoinGecko thought the day's close was.
  crypto: Object.freeze(['user_override', 'exchange_fill', 'coingecko', 'last_known'] as const),
  bond: Object.freeze(['user_override', 'exchange_fill', 'last_known'] as const),
  // Cash is worth its face value in its own currency; the ladder exists so the
  // user can still override a stale or odd position.
  cash: Object.freeze(['user_override', 'last_known'] as const),
  other: Object.freeze(['user_override', 'exchange_fill', 'last_known'] as const),
});

/** Turn a ladder into the rows `price_source_priority` stores. */
export function ladderRows(
  userId: string,
  kind: string,
  ladder: readonly PriceSourceName[],
): readonly { userId: string; securityKind: string; rung: number; source: PriceSourceName }[] {
  return ladder.map((source, index) => ({
    userId,
    securityKind: kind,
    // The two pinned rungs the migration enforces; everything else is spaced.
    rung: source === 'user_override' ? 1 : source === 'last_known' ? 99 : 10 * (index + 1),
    source,
  }));
}

export interface PriceStore {
  /**
   * The observations the ladder can use for this security in this currency at
   * `date`: every row dated exactly `date` (any rung may match one) and every
   * row of the newest date **before** it (the `last_known` rung's carry-forward).
   * Nothing else on or before `date` is ever consulted, so nothing else is read:
   * the cost is the number of sources, not the years of history held (P-6).
   */
  observationsForLadder(
    userId: string,
    securityId: string,
    currency: string,
    date: string,
  ): Promise<readonly PriceRecord[]>;
  /**
   * `observationsForLadder` for many securities in one round trip. Every
   * requested id has an entry (empty when it has no usable row).
   */
  observationsForLadderMany(
    userId: string,
    securityIds: readonly string[],
    currency: string,
    date: string,
  ): Promise<ReadonlyMap<string, readonly PriceRecord[]>>;
  /** The user's ladder for a security kind, strongest rung first. Empty ⇒ default. */
  ladderFor(userId: string, kind: string): Promise<readonly PriceSourceName[]>;
}

export interface PriceReader {
  /**
   * The best price for this security on this date, in this currency.
   *
   * `null` when no rung can answer — no observation exists at all. That is a
   * different thing from a missing FX rate (which throws): a security with no
   * price yet is an ordinary state on a fresh install, and 08 §3.7's net-worth
   * seal has to be able to render "no price" rather than fail.
   */
  price(securityId: string, date: string, currency: string): Promise<PricePoint | null>;
  /**
   * `price` for many securities at once, in a fixed number of round trips (one
   * ladder read per distinct security kind and one observations read), and
   * answering exactly what `price` answers for each id. Every id is a key of the
   * result; `null` is the same "no rung can answer" `price` returns.
   */
  priceMany(
    securityIds: readonly string[],
    date: string,
    currency: string,
  ): Promise<ReadonlyMap<string, PricePoint | null>>;
}

export interface PriceReaderOptions {
  readonly store: PriceStore;
  readonly userId: string;
  /** How the security is classified, which chooses the ladder. */
  readonly kindOf: (securityId: string) => Promise<string>;
  readonly clock?: Clock;
}

export function createPriceReader(options: PriceReaderOptions): PriceReader {
  const { store, userId } = options;
  const clock = options.clock ?? systemClock;

  async function ladderOf(kind: string): Promise<readonly PriceSourceName[]> {
    const configured = await store.ladderFor(userId, kind);
    return configured.length > 0
      ? configured
      : (DEFAULT_LADDERS[kind] ?? DEFAULT_LADDERS['other'] ?? []);
  }

  return {
    async price(securityId: string, date: string, currency: string): Promise<PricePoint | null> {
      const quoteCurrency = currency.trim().toUpperCase();
      const kind = await options.kindOf(securityId);
      const ladder = await ladderOf(kind);
      const observations = await store.observationsForLadder(
        userId,
        securityId,
        quoteCurrency,
        date,
      );
      return walkLadder(observations, ladder, date, clock.now());
    },

    async priceMany(
      securityIds: readonly string[],
      date: string,
      currency: string,
    ): Promise<ReadonlyMap<string, PricePoint | null>> {
      const quoteCurrency = currency.trim().toUpperCase();
      const unique = [...new Set(securityIds)];
      const kindOfId = new Map<string, string>();
      for (const securityId of unique) kindOfId.set(securityId, await options.kindOf(securityId));
      const ladders = new Map<string, readonly PriceSourceName[]>();
      for (const kind of new Set(kindOfId.values())) ladders.set(kind, await ladderOf(kind));
      const observations = await store.observationsForLadderMany(
        userId,
        unique,
        quoteCurrency,
        date,
      );
      const now = clock.now();
      const result = new Map<string, PricePoint | null>();
      for (const securityId of unique) {
        const ladder = ladders.get(kindOfId.get(securityId) ?? 'other') ?? [];
        result.set(securityId, walkLadder(observations.get(securityId) ?? [], ladder, date, now));
      }
      return result;
    },
  };
}

/**
 * 07 §6.1's ladder over one security's usable observations. One function for
 * `price` and `priceMany`, so the batched path cannot answer differently.
 */
function walkLadder(
  observations: readonly PriceRecord[],
  ladder: readonly PriceSourceName[],
  date: string,
  now: Date,
): PricePoint | null {
  if (observations.length === 0) return null;
  const onDate = observations.filter((row) => row.priceDate === date);

  for (const rung of ladder) {
    if (rung === 'last_known') {
      // The fourth rung. The most recent observation *strictly before* the
      // date asked for, from any source — a carry-forward does not get to
      // be choosy, it gets to be labelled.
      const earlier = observations
        .filter((row) => row.priceDate < date)
        .sort((a, b) => (a.priceDate < b.priceDate ? 1 : -1))[0];
      if (earlier === undefined) continue;
      return pointOf(earlier, 'last_known', date, now);
    }
    // `fred` and other non-price sources can appear in a user-edited ladder;
    // they simply never match a `prices` row, which is the honest outcome.
    const match = onDate.find((row) => row.source === (rung as PriceRowSource));
    if (match !== undefined) return pointOf(match, rung, date, now);
  }

  return null;
}

function pointOf(
  row: PriceRecord,
  rung: PriceSourceName,
  requestedDate: string,
  now: Date,
): PricePoint {
  const staleness = priceStalenessOf(row.observedAt, now);
  return {
    securityId: row.securityId,
    priceDate: row.priceDate,
    close: row.close,
    currency: row.currency,
    rung,
    source: row.source,
    carriedForward: row.priceDate !== requestedDate,
    providerCarriedForward: row.stale,
    observedAt: row.observedAt,
    staleness,
    // 07 §6.1, in one place. A STALE price may still be displayed and may still
    // seal a net-worth snapshot (08 §3.7, flagged `stale_price`); what it may
    // not do is contribute to an "as of now" delta, because the delta would be
    // measuring the passage of time rather than a change in value.
    includeInAsOfNowDeltas: staleness === 'FRESH',
  };
}

// ---------------------------------------------------------------------------
// The user override write path
// ---------------------------------------------------------------------------

export interface UserPriceOverride {
  readonly securityId: string;
  readonly priceDate: string;
  readonly close: string;
  readonly currency: string;
}

/**
 * Write the rung-1 price: the user looked at the position and disagreed.
 *
 * `observed_at` is *now*, not the price date, and that is deliberate. The
 * 24-hour rule asks "how old is this information?", and information a user
 * entered thirty seconds ago about last Tuesday's close is thirty seconds old.
 * Stamping it with the price date would mark a freshly-typed override STALE the
 * instant it was saved.
 *
 * Upsert rather than insert: a user correcting their own typo should not
 * produce two rows the ladder then has to choose between, and the unique index
 * `(user_id, security_id, price_date, source, currency)` is the target.
 */
export async function recordUserPriceOverride(
  db: InvestmentsExecutor,
  userId: string,
  override: UserPriceOverride,
  clock: Clock = systemClock,
): Promise<void> {
  const observedAt = clock.now();
  await db
    .insert(prices)
    .values({
      id: newId(),
      userId,
      securityId: override.securityId,
      priceDate: override.priceDate,
      source: 'user_override',
      close: override.close,
      currency: override.currency.toUpperCase(),
      stale: false,
      observedAt,
    })
    .onConflictDoUpdate({
      target: [prices.userId, prices.securityId, prices.priceDate, prices.source, prices.currency],
      set: { close: override.close, observedAt, stale: false, updatedAt: observedAt },
    });
}

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

export function drizzlePriceStore(db: InvestmentsExecutor): PriceStore {
  async function many(
    userId: string,
    securityIds: readonly string[],
    currency: string,
    date: string,
  ): Promise<ReadonlyMap<string, readonly PriceRecord[]>> {
    const bySecurity = new Map<string, PriceRecord[]>(securityIds.map((id) => [id, []]));
    if (securityIds.length === 0) return bySecurity;
    // Two index probes per security (`prices_user_security_date_idx`): the rows
    // dated `date`, and the rows of the newest date before it. The correlated
    // `max()` is the carry-forward's date; the join then takes every source's
    // row on it. No LIMIT is needed because the date, not a row count, bounds it.
    const result = await db.execute<{
      security_id: string;
      price_date: string;
      close: string;
      currency: string;
      source: PriceRowSource;
      stale: boolean;
      observed_at: Date | string;
    }>(sql`
      SELECT p.security_id,
             to_char(p.price_date, 'YYYY-MM-DD') AS price_date,
             p.close::text AS close,
             p.currency,
             p.source,
             p.stale,
             p.observed_at
        FROM unnest(${sql.param([...securityIds])}::uuid[]) AS s(id)
       CROSS JOIN LATERAL (
              SELECT ${date}::date AS d
              UNION ALL
              SELECT max(q.price_date)
                FROM prices q
               WHERE q.user_id = ${userId}::uuid
                 AND q.security_id = s.id
                 AND q.currency = ${currency}
                 AND q.price_date < ${date}::date
            ) AS wanted
        JOIN prices p
          ON p.user_id = ${userId}::uuid
         AND p.security_id = s.id
         AND p.currency = ${currency}
         AND p.price_date = wanted.d
    `);
    for (const row of result.rows) {
      bySecurity.get(row.security_id)?.push({
        securityId: row.security_id,
        priceDate: row.price_date,
        close: row.close,
        currency: row.currency,
        source: row.source,
        stale: row.stale,
        observedAt: new Date(row.observed_at),
      });
    }
    return bySecurity;
  }

  return {
    async observationsForLadder(userId, securityId, currency, date) {
      return (await many(userId, [securityId], currency, date)).get(securityId) ?? [];
    },

    observationsForLadderMany: many,

    async ladderFor(userId, kind) {
      const rows = await db
        .select({ source: priceSourcePriority.source, rung: priceSourcePriority.rung })
        .from(priceSourcePriority)
        .where(
          and(
            eq(priceSourcePriority.userId, userId),
            eq(priceSourcePriority.securityKind, kind),
            eq(priceSourcePriority.enabled, true),
          ),
        )
        .orderBy(priceSourcePriority.rung);
      return rows.map((row) => row.source);
    },
  };
}

/** The in-memory store the ladder proofs run against. */
export function inMemoryPriceStore(
  seed: readonly PriceRecord[] = [],
  ladders: Readonly<Record<string, readonly PriceSourceName[]>> = {},
): PriceStore & { put(record: PriceRecord): void } {
  const records: PriceRecord[] = [...seed];
  /** The same bound the SQL store applies: the date itself and the newest date before it. */
  function boundedFor(securityId: string, currency: string, date: string): PriceRecord[] {
    const mine = records.filter((r) => r.securityId === securityId && r.currency === currency);
    const earlier = mine.filter((r) => r.priceDate < date).map((r) => r.priceDate);
    const newestEarlier = earlier.length === 0 ? null : earlier.reduce((a, b) => (a > b ? a : b));
    return mine
      .filter((r) => r.priceDate === date || r.priceDate === newestEarlier)
      .sort((a, b) => (a.priceDate < b.priceDate ? 1 : -1));
  }
  return {
    put(record) {
      // The schema's control, enforced in the fake: `last_known` is not a
      // member of `prices.source`, so a carry-forward cannot be written back.
      if ((record.source as string) === 'last_known') {
        throw new RangeError(
          'prices_source_is_an_observation: last_known is a read-time label and may never be ' +
            'stored — 07 §6.1, "never recompute history from today\'s price"',
        );
      }
      records.push(record);
    },
    observationsForLadder(userId, securityId, currency, date) {
      void userId;
      return Promise.resolve(boundedFor(securityId, currency, date));
    },
    observationsForLadderMany(userId, securityIds, currency, date) {
      void userId;
      return Promise.resolve(
        new Map(securityIds.map((id) => [id, boundedFor(id, currency, date)] as const)),
      );
    },
    ladderFor(userId, kind) {
      void userId;
      return Promise.resolve(ladders[kind] ?? []);
    },
  };
}
