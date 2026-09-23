// SPDX-License-Identifier: MIT
/**
 * `FxReader` — 08 §1.3 #7's `rate(from, to, date)`, and the one number this
 * system refuses to guess.
 *
 * ## Why a missing rate throws
 *
 * Decision D4 requires every foreign-currency amount to be stored twice — the
 * native amount, and the base-currency amount with the `fx_rate` and
 * `fx_rate_date` that produced it. 08 §6.6 states the failure mode it is
 * guarding against: *"A missing rate is an explicit `FxRateUnavailable` domain
 * error with a UI affordance to enter one manually — never a silent 1.0."*
 *
 * The reason that rule needs a *type* behind it rather than a code review is
 * what a silent 1.0 looks like from the outside. A CAD account counted at par
 * is not obviously wrong on a screen: the number is plausible, the arithmetic
 * is clean, nothing logs, and the error is roughly 35% of that account forever.
 * A thrown `FxRateUnavailable` is the opposite in every respect — it is loud,
 * it names the pair and the date, and it cannot be ignored by a caller who
 * simply did not think about currencies.
 *
 * So `rate()` returns a rate or throws. There is no `| null` for a caller to
 * `?? 1` their way past, and there is no default parameter that would let one
 * appear. The one legitimate 1.0 in the system — `USD → USD` — is answered
 * *structurally*, as `{ kind: 'identity' }`, and never by reading a row:
 * `fx_rates_is_a_real_pair` refuses `base = quote` at the schema level, so no
 * query can find a stored 1.0 and mistake it for something a provider said.
 *
 * `src/fx.test.ts` → `'a missing FX rate is an explicit error, never 1.0'`
 * sabotages this: it deletes the pair and asserts the throw, then asserts that
 * no path through this module can return `1` for a pair it has no row for.
 *
 * ## Inversion, and why only one direction is stored
 *
 * FRED publishes each pair in a fixed direction that is part of the series'
 * identity (`DEXUSEU` is dollars per euro, `DEXCAUS` is Canadian dollars per
 * dollar — see `@ctx/integrations`' `FRED_FX_SERIES`). Storing both directions
 * would mean two rows that must agree to fifteen places forever, and they would
 * not: `1/1.085` does not round-trip. So exactly one row is stored per pair per
 * day, and the other direction is computed here, at read time, flagged
 * `inverted: true` so a caller can see which way the stored observation ran.
 *
 * The arithmetic is `Quantity`'s, which is exact decimal over strings. There is
 * no `number` anywhere in this file — D3, and the Phase 3 risk table's first
 * row.
 */
import { Quantity, type Clock } from '@core/kernel';
import { and, desc, eq, lte, sql } from 'drizzle-orm';
import { fxRates, type FxRowSource } from '../schema/index.ts';
import type { InvestmentsExecutor } from './store.ts';

/**
 * No rate, and therefore no answer.
 *
 * Carries the pair, the date and what was consulted, because the UI affordance
 * 08 §6.6 requires ("enter one manually") needs to be able to say *which* rate
 * it is asking the user for.
 */
export class FxRateUnavailable extends Error {
  override readonly name = 'FxRateUnavailable';
  readonly base: string;
  readonly quote: string;
  readonly date: string;
  /** Directions actually queried, for the error message and for evidence. */
  readonly consulted: readonly string[];

  constructor(base: string, quote: string, date: string, consulted: readonly string[]) {
    super(
      `no FX rate for ${base}/${quote} on or before ${date} (consulted ${consulted.join(', ')}). ` +
        'This is deliberately an error rather than a 1.0: D4 stores every foreign amount with the ' +
        'rate that produced it, and a par conversion would be plausible, invisible and wrong.',
    );
    this.base = base;
    this.quote = quote;
    this.date = date;
    this.consulted = consulted;
  }
}

export function isFxRateUnavailable(error: unknown): error is FxRateUnavailable {
  return error instanceof FxRateUnavailable;
}

/**
 * A rate, and the provenance D4 requires to be stored alongside every converted
 * amount.
 *
 * `rateDate` is the date of the observation actually used, which is **not**
 * necessarily the date asked for: a Sunday has no FX print, so Friday's rate is
 * carried forward and `carriedForward` says so. D4 wants `fx_rate_date` on the
 * row, and this is the field it comes from — recording the date asked for would
 * make a Friday rate claim to be a Sunday one.
 */
export interface FxRate {
  readonly base: string;
  readonly quote: string;
  /** 1 `base` = `rate` `quote`, as an exact decimal string. */
  readonly rate: string;
  /** `identity` when base and quote are the same currency; no row was read. */
  readonly source: FxRowSource | 'identity';
  /** The date of the observation used. Goes into D4's `fx_rate_date`. */
  readonly rateDate: string;
  /** The stored row ran the other way and was inverted here. */
  readonly inverted: boolean;
  /** No print on the date asked for; an earlier observation was used. */
  readonly carriedForward: boolean;
  readonly observedAt: Date;
}

/** One stored `fx_rates` row, in the shape this reader reasons about. */
export interface FxRateRecord {
  readonly base: string;
  readonly quote: string;
  readonly rate: string;
  readonly rateDate: string;
  readonly source: FxRowSource;
  readonly observedAt: Date;
}

/**
 * The persistence this reader needs, and nothing more.
 *
 * One method. It answers "the best row for this exact direction on or before
 * this date", where *best* is the store's business: `user_override` outranks a
 * provider on the same day, and a later date outranks an earlier one. Keeping
 * the ranking in the query rather than in the reader means the in-memory fake
 * and Postgres must agree about it, which is what `test/db/fx.test.ts` checks.
 */
export interface FxStore {
  latestOnOrBefore(
    userId: string,
    base: string,
    quote: string,
    date: string,
  ): Promise<FxRateRecord | null>;
}

export interface FxReader {
  /**
   * 1 `from` = *n* `to` on `date`.
   *
   * @throws {FxRateUnavailable} when no observation exists in either direction.
   */
  rate(from: string, to: string, date: string): Promise<FxRate>;
}

export interface FxReaderOptions {
  readonly store: FxStore;
  readonly userId: string;
  readonly clock?: Clock;
}

export function createFxReader(options: FxReaderOptions): FxReader {
  const { store, userId } = options;

  return {
    async rate(from: string, to: string, date: string): Promise<FxRate> {
      const base = normaliseCurrency(from);
      const quote = normaliseCurrency(to);

      // The identity, answered without touching the database. This is the only
      // 1.0 this module will ever produce, it is reachable only when the two
      // codes are literally equal, and it is labelled `identity` so a stored
      // rate and a tautology are never confused in a read model.
      if (base === quote) {
        return {
          base,
          quote,
          rate: '1',
          source: 'identity',
          rateDate: date,
          inverted: false,
          carriedForward: false,
          observedAt: new Date(0),
        };
      }

      const direct = await store.latestOnOrBefore(userId, base, quote, date);
      if (direct !== null) {
        return {
          base,
          quote,
          rate: direct.rate,
          source: direct.source,
          rateDate: direct.rateDate,
          inverted: false,
          carriedForward: direct.rateDate !== date,
          observedAt: direct.observedAt,
        };
      }

      // The other direction. FRED stores `DEXCAUS` as CAD per USD; a caller
      // asking CAD→USD gets `1/rate` rather than nothing, and the flag records
      // that the observation ran the other way.
      const reverse = await store.latestOnOrBefore(userId, quote, base, date);
      if (reverse !== null) {
        return {
          base,
          quote,
          rate: invert(reverse.rate),
          source: reverse.source,
          rateDate: reverse.rateDate,
          inverted: true,
          carriedForward: reverse.rateDate !== date,
          observedAt: reverse.observedAt,
        };
      }

      // Deliberately not a cross via USD. Chaining EUR→USD→CAD would produce a
      // number with no observation behind it, and D4 requires a *historical
      // rate*, not a plausible one. The UI's manual-entry affordance (08 §6.6)
      // is the intended next step, and it writes a `user_override` row that the
      // direct lookup above then finds.
      throw new FxRateUnavailable(base, quote, date, [
        `${base}/${quote}`,
        `${quote}/${base} (inverted)`,
      ]);
    },
  };
}

/**
 * `1 / rate`, exactly, over decimal strings.
 *
 * `Quantity.divide` is `decimal.js` underneath and never sees a float. A stored
 * rate is `NUMERIC(20,10)` and strictly positive (`fx_rates_rate_is_positive`),
 * so the zero case cannot come from the database — but it can come from a fake,
 * and a division by zero that produced `Infinity` would be exactly the silent
 * nonsense this module exists to prevent.
 */
export function invert(rate: string): string {
  const divisor = Quantity.of(rate);
  if (Quantity.isZero(divisor)) {
    throw new RangeError('an exchange rate of zero cannot be inverted');
  }
  return Quantity.divide(Quantity.of('1'), divisor);
}

function normaliseCurrency(code: string): string {
  const upper = code.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(upper)) {
    throw new TypeError(`${code} is not an ISO-4217 alphabetic currency code`);
  }
  return upper;
}

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

/**
 * The real store, over `0015_market_data.sql`.
 *
 * The ORDER BY is the ranking: latest observation first, and `user_override`
 * ahead of any provider on the same date. A user who typed a rate in meant it,
 * and a refresh that later fetched the same day must not overwrite their
 * judgement — which is why the override wins in the query rather than by being
 * written last.
 */
export function drizzleFxStore(db: InvestmentsExecutor): FxStore {
  return {
    async latestOnOrBefore(userId, base, quote, date) {
      const rows = await db
        .select({
          base: fxRates.baseCurrency,
          quote: fxRates.quoteCurrency,
          rate: fxRates.rate,
          rateDate: fxRates.rateDate,
          source: fxRates.source,
          observedAt: fxRates.observedAt,
        })
        .from(fxRates)
        .where(
          and(
            eq(fxRates.userId, userId),
            eq(fxRates.baseCurrency, base),
            eq(fxRates.quoteCurrency, quote),
            lte(fxRates.rateDate, date),
          ),
        )
        .orderBy(
          desc(fxRates.rateDate),
          sql`case when ${fxRates.source} = 'user_override' then 0 else 1 end`,
        )
        .limit(1);

      const row = rows[0];
      return row === undefined ? null : { ...row, observedAt: new Date(row.observedAt) };
    },
  };
}

/**
 * An in-memory store with the same ranking, for the unit proofs.
 *
 * It enforces the schema's one refusal that matters here — `base !== quote` —
 * so a fixture cannot create the stored 1.0 the migration forbids and then have
 * a test pass because of it.
 */
export function inMemoryFxStore(seed: readonly FxRateRecord[] = []): FxStore & {
  put(record: FxRateRecord): void;
} {
  const records: FxRateRecord[] = [];

  function put(record: FxRateRecord): void {
    if (record.base === record.quote) {
      throw new RangeError(
        `fx_rates_is_a_real_pair: ${record.base}/${record.quote} is the identity, which is ` +
          'answered by FxReader without a row and may never be stored',
      );
    }
    records.push(record);
  }

  for (const record of seed) put(record);

  return {
    put,
    latestOnOrBefore(userId, base, quote, date) {
      void userId;
      const candidates = records
        .filter((r) => r.base === base && r.quote === quote && r.rateDate <= date)
        .sort((a, b) => {
          if (a.rateDate !== b.rateDate) return a.rateDate < b.rateDate ? 1 : -1;
          const rank = (s: FxRowSource): number => (s === 'user_override' ? 0 : 1);
          return rank(a.source) - rank(b.source);
        });
      return Promise.resolve(candidates[0] ?? null);
    },
  };
}
