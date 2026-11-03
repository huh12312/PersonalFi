// SPDX-License-Identifier: MIT
/**
 * Yahoo Finance through `yfinance` — **opt-in, unofficial, best effort**
 * (WP 12.6, D33; docs/research/14).
 *
 * The posture is 01 §4.2's, unchanged since September: never a documented
 * default; opt-in, clearly labelled, best-effort. Yahoo publishes no data
 * licence and its terms prohibit automated collection; `yfinance`'s README
 * says the API "is intended for personal use only". So:
 *
 *   * **No direct egress.** This adapter never dials Yahoo. It speaks HTTP to
 *     the `yahoo` sidecar (`YAHOO_SIDECAR_ENDPOINT`, a compose service on the
 *     `yahoo` network) through `@core/platform`'s local-endpoint transport —
 *     one host, one port, every resolved address private, no redirects — and
 *     only the sidecar reaches `query1`/`query2.finance.yahoo.com`.
 *     `policyFor('yfinance')` throws, and `MARKET_DATA_ALLOWED_HOSTS` does not
 *     name Yahoo, so neither the api nor the worker can reach it directly.
 *   * **Two halves before every request** (research 14 §3): the operator's
 *     (`operatorEnabled`, from `YAHOO_FINANCE_ENABLED`) and the holder's
 *     (`consentHolds`, a standing consent to the current `yahoo-consent/1`
 *     text). Both are asked before *each* request, not only when the adapter
 *     is built, so a consent withdrawn mid-run stops the next call. A missing
 *     half is a `refused` outcome that never reaches the transport.
 *   * **The budget** is `YFINANCE_WINDOWS` (60 an hour, self-imposed; Yahoo
 *     publishes none), through the context's rate-limit module, checked before
 *     the socket opens and recorded once the sidecar answered.
 *   * **429 backs off exponentially** — one minute, doubling, at most an hour,
 *     never less than the sidecar's `Retry-After` — and inside the backoff
 *     every call is `rate_limited` without a request.
 *   * **Failure is an outcome, never a throw.** A 429 is `rate_limited` with
 *     the reason; a shape change is `error` with the reason; the refresh
 *     carries on and the ladder's `last_known` rung answers for the day.
 *   * **Attribution** "Yahoo Finance via yfinance — unofficial, best effort"
 *     travels on every quote (`ATTRIBUTIONS.yfinance`), and redistribution is
 *     `forbidden`.
 *
 * Only `ticker` subjects: a CoinGecko coin id is not a Yahoo symbol, and
 * guessing `BTC-USD` from `bitcoin` would be a guess. FX is answered (the
 * sidecar's `/fx`), but the refresh stores FX from FRED only (D17, and
 * `fx_rates`' CHECK names no `yfinance`).
 */
import {
  isLocalEndpointRefusedError,
  type LocalEndpointRequest,
  type LocalEndpointResponse,
} from '@core/platform';
import { ATTRIBUTIONS } from '../attribution.ts';
import { arrayOf, decimalAt, parseDecimalJson, plainDecimal, recordOf, stringAt } from '../json.ts';
import { createRateBudget, YFINANCE_WINDOWS, type RateBudget } from '../rate-limit.ts';
import type {
  FxQuote,
  PriceQuote,
  PriceRequest,
  PriceSource,
  SearchHit,
  SourceOutcome,
} from '../price-source.ts';
import { budgetReport, isIsoDate } from './common.ts';

/** The one capability the adapter needs: `createLocalEndpointTransport(...)` satisfies it. */
export interface YahooSidecarTransport {
  request(request: LocalEndpointRequest): Promise<LocalEndpointResponse>;
}

/** The refusal codes the two gates record in `market_data_runs.refusal_code`. */
export const YFINANCE_GATE_CODES = {
  operator: 'yfinance_not_enabled',
  consent: 'yfinance_consent_missing',
} as const;

/** The first backoff after a 429, doubling per consecutive 429. */
export const YFINANCE_BACKOFF_BASE_MS = 60_000;
/** The longest backoff. */
export const YFINANCE_BACKOFF_MAX_MS = 60 * 60_000;
/** Per request to the sidecar; the sidecar caps each of its own Yahoo calls at 15 s. */
export const YFINANCE_SIDECAR_TIMEOUT_MS = 45_000;
/** A quote or a search page is a few hundred bytes; 256 KiB is the headroom. */
export const YFINANCE_SIDECAR_MAX_BYTES = 256 * 1024;

export interface YfinanceOptions {
  readonly transport: YahooSidecarTransport;
  readonly now: () => Date;
  /** Injected so a restart can be primed from `market_data_runs`. */
  readonly budget?: RateBudget;
  /** The operator half: `YAHOO_FINANCE_ENABLED`. */
  readonly operatorEnabled: boolean;
  /** The holder half, asked before every request: a standing consent to the current text. */
  readonly consentHolds: () => Promise<boolean>;
}

type Sidecar =
  | { readonly ok: true; readonly body: unknown }
  | { readonly ok: false; readonly outcome: SourceOutcome<never> };

export function createYfinancePriceSource(options: YfinanceOptions): PriceSource {
  const budget = options.budget ?? createRateBudget(YFINANCE_WINDOWS);
  const attribution = ATTRIBUTIONS.yfinance;
  let consecutive429 = 0;
  let backoffUntilMs = 0;

  async function call(
    path: '/quote' | '/fx' | '/search',
    query: Readonly<Record<string, string>>,
  ): Promise<Sidecar> {
    // 1. The operator half. Without it nothing is asked, not even the holder.
    if (!options.operatorEnabled) {
      return refusal(
        YFINANCE_GATE_CODES.operator,
        'Yahoo Finance is not enabled on this install (YAHOO_FINANCE_ENABLED is not true)',
      );
    }
    // 2. The holder half, read now, for this request.
    let consented: boolean;
    try {
      consented = await options.consentHolds();
    } catch {
      consented = false; // a failed read is not a consent
    }
    if (!consented) {
      return refusal(
        YFINANCE_GATE_CODES.consent,
        'the holder has not consented to the current Yahoo Finance terms (Settings → Market data)',
      );
    }
    // 3. Our own backoff after a 429.
    const nowMs = options.now().getTime();
    if (nowMs < backoffUntilMs) {
      return rateLimited(
        backoffUntilMs - nowMs,
        'Yahoo answered 429 Too Many Requests recently; backing off (refused here, not by Yahoo)',
      );
    }
    // 4. Our own budget.
    const verdict = budget.check(1, options.now());
    if (!verdict.ok) {
      return rateLimited(
        verdict.retryAfterMs,
        `yfinance: this client's own ${verdict.window.label} budget is spent ` +
          '(refused here, not by Yahoo)',
      );
    }

    let response: LocalEndpointResponse;
    try {
      response = await options.transport.request({
        method: 'GET',
        path,
        query,
        headers: { accept: 'application/json' },
        timeoutMs: YFINANCE_SIDECAR_TIMEOUT_MS,
        maxResponseBytes: YFINANCE_SIDECAR_MAX_BYTES,
      });
    } catch (error) {
      if (isLocalEndpointRefusedError(error)) {
        if (
          error.code === 'connection_failed' ||
          error.code === 'timeout' ||
          error.code === 'dns_resolution_failed'
        ) {
          return {
            ok: false,
            outcome: {
              kind: 'error',
              detail:
                `the yahoo sidecar did not answer (${error.code}); is the \`yahoo\` profile up? ` +
                '(docker compose --profile yahoo up -d)',
            },
          };
        }
        return refusal(error.code, `the yahoo sidecar endpoint was refused: ${error.message}`);
      }
      return {
        ok: false,
        outcome: { kind: 'error', detail: 'the yahoo sidecar request failed unexpectedly' },
      };
    }

    let body: unknown;
    try {
      body = parseDecimalJson(response.body);
    } catch {
      budget.record(1, options.now());
      return shapeChanged('the yahoo sidecar answered something other than JSON');
    }
    const error = stringAt(body, 'error');
    const detail = (stringAt(body, 'detail') ?? '').slice(0, 300);

    if (response.status === 200) {
      budget.record(1, options.now());
      consecutive429 = 0;
      backoffUntilMs = 0;
      return { ok: true, body };
    }
    if (response.status === 429) {
      const retryAfterS = Number.parseInt(decimalAt(body, 'retryAfterSeconds') ?? '0', 10);
      if (error !== 'budget_spent') {
        budget.record(1, options.now());
        consecutive429 += 1;
      }
      const backoff = Math.min(
        YFINANCE_BACKOFF_BASE_MS * 2 ** Math.max(0, consecutive429 - 1),
        YFINANCE_BACKOFF_MAX_MS,
      );
      const waitMs = Math.max(
        Number.isFinite(retryAfterS) ? retryAfterS * 1000 : 0,
        error === 'budget_spent' ? 0 : backoff,
      );
      backoffUntilMs = options.now().getTime() + waitMs;
      return rateLimited(
        waitMs,
        error === 'budget_spent'
          ? `the yahoo sidecar's own 60/hour budget is spent: ${detail}`
          : `Yahoo answered 429 Too Many Requests (via the sidecar); backing off: ${detail}`,
      );
    }
    if (response.status === 400) {
      return {
        ok: false,
        outcome: { kind: 'error', detail: `the sidecar refused the request: ${detail}` },
      };
    }
    budget.record(1, options.now());
    if (response.status === 404 && error === 'no_data') {
      return { ok: false, outcome: { kind: 'no_data', detail: `Yahoo has no close: ${detail}` } };
    }
    if (error === 'shape_changed') return shapeChanged(detail);
    if (error === 'host_refused') {
      return refusal(
        'upstream_host_refused',
        `the yahoo sidecar refused a destination other than Yahoo's two query hosts: ${detail}`,
      );
    }
    return {
      ok: false,
      outcome: {
        kind: 'error',
        detail: `Yahoo is unavailable (sidecar HTTP ${String(response.status)}): ${detail || (error ?? 'no detail')}`,
      },
    };
  }

  return {
    provider: 'yfinance',
    attribution,
    // No key: the two gates are what stand where a key would.
    hasKey: options.operatorEnabled,
    capabilities: { prices: true, fx: true, macro: false, search: true },
    budget: (now) => budgetReport(budget, now),

    async price(request: PriceRequest): Promise<SourceOutcome<PriceQuote>> {
      if (request.subject.kind !== 'ticker') {
        return {
          kind: 'no_data',
          detail: `yfinance prices securities by ticker; asked for a ${request.subject.kind}`,
        };
      }
      if (!isIsoDate(request.date)) {
        return { kind: 'error', detail: `${request.date} is not a YYYY-MM-DD date` };
      }
      const result = await call('/quote', {
        symbol: request.subject.symbol,
        date: request.date,
      });
      if (!result.ok) return result.outcome;
      const date = stringAt(result.body, 'date');
      const close = decimalAt(result.body, 'close');
      const currency = stringAt(result.body, 'currency');
      if (date === null || !isIsoDate(date) || date > request.date || close === null) {
        return shapeChanged('the quote carried no usable date or close').outcome;
      }
      if (currency === null || !/^[A-Z]{3}$/.test(currency)) {
        return shapeChanged('the quote carried no ISO-4217 currency').outcome;
      }
      if (currency !== request.currency) {
        // As Tiingo: never converted here. D4 keeps a rate dated in fx_rates.
        return {
          kind: 'no_data',
          detail:
            `Yahoo quotes ${request.subject.symbol} in ${currency}; ${request.currency} would ` +
            'require an FX conversion, which belongs in fx_rates with its own date (D4)',
        };
      }
      return {
        kind: 'ok',
        value: {
          subject: request.subject,
          date,
          close: plainDecimal(close),
          currency,
          provider: 'yfinance',
          stale: date !== request.date,
          observedAt: options.now(),
          attribution,
        },
      };
    },

    async fxRate(from: string, to: string, date: string): Promise<SourceOutcome<FxQuote>> {
      if (!isIsoDate(date)) return { kind: 'error', detail: `${date} is not a YYYY-MM-DD date` };
      const result = await call('/fx', { from, to, date });
      if (!result.ok) return result.outcome;
      const rateDate = stringAt(result.body, 'date');
      const rate = decimalAt(result.body, 'rate');
      if (rateDate === null || !isIsoDate(rateDate) || rateDate > date || rate === null) {
        return shapeChanged('the rate carried no usable date or value').outcome;
      }
      return {
        kind: 'ok',
        value: {
          base: from,
          quote: to,
          date: rateDate,
          rate: plainDecimal(rate),
          provider: 'yfinance',
          observedAt: options.now(),
          attribution,
        },
      };
    },

    async search(symbol: string): Promise<SourceOutcome<readonly SearchHit[]>> {
      const result = await call('/search', { q: symbol });
      if (!result.ok) return result.outcome;
      const rows = arrayOf(recordOf(result.body)?.['results']);
      if (rows === null) return shapeChanged('search answered no results array').outcome;
      const hits: SearchHit[] = [];
      for (const row of rows) {
        const found = stringAt(row, 'symbol');
        if (found === null) continue;
        hits.push({
          symbol: found,
          name: stringAt(row, 'name'),
          kind: stringAt(row, 'kind'),
          provider: 'yfinance',
        });
      }
      return { kind: 'ok', value: hits };
    },
  };
}

function refusal(code: string, detail: string): Sidecar {
  return { ok: false, outcome: { kind: 'refused', code, detail } };
}

function rateLimited(retryAfterMs: number, detail: string): Sidecar {
  return {
    ok: false,
    outcome: { kind: 'rate_limited', retryAfterMs: Math.max(1, Math.ceil(retryAfterMs)), detail },
  };
}

function shapeChanged(detail: string): {
  readonly ok: false;
  readonly outcome: SourceOutcome<never>;
} {
  return {
    ok: false,
    outcome: {
      kind: 'error',
      detail: `Yahoo's response shape changed (yfinance could not read it): ${detail}`,
    },
  };
}
