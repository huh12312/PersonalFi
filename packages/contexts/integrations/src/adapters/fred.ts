// SPDX-License-Identifier: MIT
/**
 * FRED — macro series, FX, and *the market rate C1 and C2 have been withholding
 * for since Phase 2*.
 *
 * 03-phase-3-dispatch.md §3 names that last one explicitly, and WP 3.10 repeats
 * why it matters: *"a hardcoded 4% would be a numeral nothing could account
 * for."* An advisor that says "you could earn 4%" has to be able to say where
 * the 4% came from, and `DGS10` on a dated observation is an answer; a literal
 * in a source file is not.
 *
 * ## Attribution is required, and the string is exact
 *
 * 01 §4.3: *"Requires displaying: 'This product uses the FRED® API but is not
 * endorsed or certified by the Federal Reserve Bank of St. Louis.'"* The ® is
 * part of it. It is in `ATTRIBUTIONS.fred`, it travels on every quote this
 * adapter returns, and `test/attribution.test.ts` asserts it is non-empty and
 * unchanged.
 *
 * ## The one provider whose key must go in the URL
 *
 * FRED has no header authentication: `api_key` is a query parameter, full stop.
 * That is why `secrets.ts` exists in the shape it does and why `http.ts` never
 * interpolates a URL into an error message. `test/log-hygiene.test.ts` and
 * `test/custody.test.ts` both sabotage this adapter specifically, because it is
 * the one where a mistake is possible.
 *
 * ## FX as a series, and the direction problem
 *
 * FRED publishes FX as daily series, each with a *fixed direction that is part
 * of the series' identity*: `DEXUSEU` is US dollars per euro, `DEXCAUS` is
 * Canadian dollars per US dollar. Get that backwards and a CAD account is
 * wrong by a factor of ~1.9 — plausible, invisible, and exactly the class of
 * error D4 exists to prevent. So the table below stores the direction beside
 * the series id, and `FxReader` inverts a stored pair rather than this adapter
 * guessing.
 *
 * A pair with no series is `no_data`, never an approximation via USD. Chaining
 * EUR→USD→CAD would produce a number with no observation behind it, and D4's
 * requirement is a *historical rate*, not a plausible one.
 */
import { ATTRIBUTIONS } from '../attribution.ts';
import { arrayOf, decimalAt, isDecimalLiteral, plainDecimal, recordOf, stringAt } from '../json.ts';
import type { ProviderClient } from '../http.ts';
import { createRateBudget, FRED_WINDOWS, type RateBudget } from '../rate-limit.ts';
import type { ApiKey } from '../secrets.ts';
import {
  unsupported,
  type FxQuote,
  type MacroObservation,
  type PriceQuote,
  type PriceSource,
  type SearchHit,
  type SourceOutcome,
} from '../price-source.ts';
import { budgetReport, callJson, isIsoDate, type CallContext } from './common.ts';

/**
 * Pair → the FRED series that quotes it, and in which direction.
 *
 * `base`/`quote` state what **the series itself** means: one unit of `base`
 * costs `value` units of `quote`. `DEXUSEU` is "U.S. Dollars to One Euro", so
 * base EUR, quote USD.
 *
 * Deliberately short. Every entry is a claim about a published series' meaning
 * and a wrong one is invisible; five verified pairs beat twenty guessed ones,
 * and an unlisted pair degrades to `no_data` with a manual-entry affordance
 * (08 §6.6), which is the honest failure.
 */
export const FRED_FX_SERIES: readonly {
  readonly seriesId: string;
  readonly base: string;
  readonly quote: string;
}[] = Object.freeze([
  Object.freeze({ seriesId: 'DEXUSEU', base: 'EUR', quote: 'USD' }),
  Object.freeze({ seriesId: 'DEXUSUK', base: 'GBP', quote: 'USD' }),
  Object.freeze({ seriesId: 'DEXCAUS', base: 'USD', quote: 'CAD' }),
  Object.freeze({ seriesId: 'DEXJPUS', base: 'USD', quote: 'JPY' }),
  Object.freeze({ seriesId: 'DEXSZUS', base: 'USD', quote: 'CHF' }),
  Object.freeze({ seriesId: 'DEXUSAL', base: 'AUD', quote: 'USD' }),
]);

/** The series WP 3.10's rules will name. Here so the id is written down once. */
export const FRED_MACRO_SERIES = Object.freeze({
  /** 10-year Treasury constant maturity — the risk-free rate. */
  treasury10y: 'DGS10',
  /** 3-month Treasury bill — the "what is cash earning?" rate. */
  treasury3m: 'DGS3MO',
  /** CPI, all urban consumers — inflation-adjusted projections. */
  cpi: 'CPIAUCSL',
});

export interface FredOptions {
  readonly client: ProviderClient;
  readonly key: ApiKey;
  readonly now: () => Date;
  readonly budget?: RateBudget;
}

export interface FredSource extends PriceSource {
  /** A macro observation on or before `date`. The C1/C2 market rate. */
  macro(seriesId: string, date: string): Promise<SourceOutcome<MacroObservation>>;
}

export function createFredSource(options: FredOptions): FredSource {
  const budget = options.budget ?? createRateBudget(FRED_WINDOWS);
  const context: CallContext = {
    client: options.client,
    key: options.key,
    budget,
    now: options.now,
  };
  const attribution = ATTRIBUTIONS.fred;

  /**
   * `GET /fred/series/observations`, windowed to one day.
   *
   * `file_type=json` because the default is XML. `api_key` in the query,
   * because FRED offers nothing else — see the header.
   */
  async function observation(
    seriesId: string,
    date: string,
  ): Promise<SourceOutcome<{ readonly date: string; readonly value: string }>> {
    if (!isIsoDate(date)) return { kind: 'error', detail: `${date} is not a YYYY-MM-DD date` };

    const call = await callJson(context, {
      method: 'GET',
      path: '/fred/series/observations',
      query: {
        series_id: seriesId,
        api_key: options.key.reveal(),
        file_type: 'json',
        observation_start: date,
        observation_end: date,
      },
    });
    if (!call.ok) return call.outcome;

    const rows = arrayOf(recordOf(call.body)?.['observations']);
    if (rows === null) {
      return { kind: 'error', detail: `fred returned no observations array for ${seriesId}` };
    }
    const row = rows[0];
    if (row === undefined) {
      return { kind: 'no_data', detail: `fred has no ${seriesId} observation for ${date}` };
    }
    // FRED marks a missing observation — a market holiday — with the string
    // ".". It is not a number, it is not zero, and treating it as either would
    // put a 0.00 exchange rate into the database.
    const raw = stringAt(row, 'value') ?? decimalAt(row, 'value');
    if (raw === null || raw === '.' || !isDecimalLiteral(raw)) {
      return {
        kind: 'no_data',
        detail: `fred reported ${seriesId} as unavailable on ${date} (value "${String(raw)}")`,
      };
    }
    return {
      kind: 'ok',
      value: { date: stringAt(row, 'date') ?? date, value: plainDecimal(raw) },
    };
  }

  return {
    provider: 'fred',
    attribution,
    hasKey: options.key.present,
    capabilities: { prices: false, fx: true, macro: true, search: false },
    budget: (now) => budgetReport(budget, now),

    price(): Promise<SourceOutcome<PriceQuote>> {
      return Promise.resolve(unsupported<PriceQuote>('fred', 'security prices'));
    },

    search(): Promise<SourceOutcome<readonly SearchHit[]>> {
      return Promise.resolve(unsupported<readonly SearchHit[]>('fred', 'symbol search'));
    },

    async fxRate(from: string, to: string, date: string): Promise<SourceOutcome<FxQuote>> {
      const base = from.toUpperCase();
      const quote = to.toUpperCase();
      if (base === quote) {
        // Not this adapter's business. `FxReader` answers the identity without
        // a provider and without a row (D4) — an adapter that returned 1.0 here
        // would be manufacturing the exact value 08 §6.6 forbids.
        return {
          kind: 'error',
          detail: 'the identity rate is answered by FxReader, never fetched',
        };
      }

      const direct = FRED_FX_SERIES.find(
        (series) => series.base === base && series.quote === quote,
      );
      const inverse = FRED_FX_SERIES.find(
        (series) => series.base === quote && series.quote === base,
      );
      const series = direct ?? inverse;
      if (series === undefined) {
        return {
          kind: 'no_data',
          detail:
            `no FRED series quotes ${base}/${quote}. A cross via USD would be a number with ` +
            'no observation behind it; D4 requires a historical rate, not a plausible one.',
        };
      }

      const result = await observation(series.seriesId, date);
      if (result.kind !== 'ok') return result;

      // The series answers in its own direction. If we asked for the inverse,
      // say so honestly: return the pair the *series* quotes, and let
      // `FxReader` invert it at read time from a single stored row.
      return {
        kind: 'ok',
        value: {
          base: series.base,
          quote: series.quote,
          date: result.value.date,
          rate: result.value.value,
          provider: 'fred',
          observedAt: options.now(),
          attribution,
        },
      };
    },

    async macro(seriesId: string, date: string): Promise<SourceOutcome<MacroObservation>> {
      const result = await observation(seriesId, date);
      if (result.kind !== 'ok') return result;
      return {
        kind: 'ok',
        value: {
          seriesId,
          date: result.value.date,
          value: result.value.value,
          provider: 'fred',
          observedAt: options.now(),
          attribution,
        },
      };
    },
  };
}
