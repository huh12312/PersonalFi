// SPDX-License-Identifier: MIT
/**
 * Client-side rate budgets, with the documented number in the code.
 *
 * 03-phase-3-dispatch.md §3, verbatim: *"Rate limits are implemented with the
 * documented number **in the code**: Tiingo 50/hr and 1,000/day, FRED 120/60 s,
 * CoinGecko ~100/min and 10,000 credits/month, OpenFIGI 25,000 jobs/min."* The
 * exit test states the posture as a sentence: *'the Tiingo adapter refuses its
 * own 1,001st call of a day rather than being refused'*.
 *
 * ## Why refusing ourselves is different from being refused
 *
 * A provider that refuses us answers 429 — sometimes. Tiingo's free tier is
 * documented at 1,000 requests/day; what happens at 1,001 is the provider's
 * business and might be a 429, might be a 403, might be a silent throttle, and
 * on a bad day might be an account suspension for a personal-tier key whose ToS
 * we are one automation bug away from abusing. Discovering the limit by hitting
 * it is a strategy that works until the one time it does not.
 *
 * So the budget is ours: we count what we spend, and the 1,001st call never
 * leaves the process. It is also the only form that can be *tested* without a
 * network — a fake provider that returns 429 tests our handling of their
 * refusal, which is a different claim.
 *
 * ## Sliding windows, and why the spend must be durable
 *
 * Each window is a sliding one (timestamps, pruned), not a fixed bucket: a
 * fixed hourly bucket lets 100 calls through at 10:59 and 11:01 while claiming
 * to permit 50/hour.
 *
 * The in-memory budget alone is not enough, and the reason is the 03:45
 * schedule. A worker that restarts at 03:44 would start the day's refresh with
 * an empty counter and no memory of the 900 requests it made at 03:15, which is
 * precisely how a personal-tier key gets used the way its ToS forbids. So
 * `hydrate()` primes the windows from `market_data_runs` — the table exists for
 * this — and the composition root calls it at boot.
 */

/** The unit a provider bills in. Only `label` reaches a human; the maths is the same. */
export type RateUnit = 'request' | 'credit' | 'job';

export interface RateWindow {
  readonly windowMs: number;
  readonly limit: number;
  readonly unit: RateUnit;
  /** What the provider's own documentation calls it, for the refusal message. */
  readonly label: string;
}

export type RateVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** How long until the oldest spend in the tightest window falls out of it. */
      readonly retryAfterMs: number;
      readonly window: RateWindow;
    };

export interface RateBudget {
  /** Would spending `cost` units now exceed a window? Does not record anything. */
  check(cost: number, now: Date): RateVerdict;
  /** Record a spend. Call after `check` returns ok and the request was actually made. */
  record(cost: number, now: Date): void;
  /** Prime from durable history (`market_data_runs`) so a restart does not reset the day. */
  hydrate(spends: readonly { readonly at: Date; readonly cost: number }[]): void;
  /** What has been spent in each window, for the evidence ledger and the settings screen. */
  spent(now: Date): readonly { readonly window: RateWindow; readonly used: number }[];
  readonly windows: readonly RateWindow[];
}

/**
 * The error an adapter throws — or, more usually, the result it returns — when
 * its own budget says no.
 *
 * `retryAfterMs` is the whole point: a scheduler that knows *when* can wait,
 * and a scheduler that only knows *no* will either drop the work or spin.
 */
export class RateLimitExceededError extends Error {
  readonly provider: string;
  readonly retryAfterMs: number;
  readonly windowLabel: string;
  constructor(provider: string, retryAfterMs: number, windowLabel: string) {
    super(
      `${provider}: this client's own ${windowLabel} budget is spent; ` +
        `retry after ${String(retryAfterMs)} ms`,
    );
    this.name = 'RateLimitExceededError';
    this.provider = provider;
    this.retryAfterMs = retryAfterMs;
    this.windowLabel = windowLabel;
  }
}

export function isRateLimitExceededError(error: unknown): error is RateLimitExceededError {
  return error instanceof RateLimitExceededError;
}

interface Spend {
  readonly at: number;
  readonly cost: number;
}

export function createRateBudget(windows: readonly RateWindow[]): RateBudget {
  for (const window of windows) {
    if (!Number.isInteger(window.limit) || window.limit < 1) {
      throw new RangeError(`${window.label}: a rate limit must be a positive integer`);
    }
    if (!Number.isFinite(window.windowMs) || window.windowMs <= 0) {
      throw new RangeError(`${window.label}: a rate window must be a positive duration`);
    }
  }

  // One list, shared by every window: a spend counts against all of them, and
  // the widest window decides how long a timestamp is worth keeping.
  let spends: Spend[] = [];
  const widest = windows.reduce((max, window) => Math.max(max, window.windowMs), 0);

  function prune(nowMs: number): void {
    const floor = nowMs - widest;
    if (spends.length > 0 && (spends[0]?.at ?? 0) < floor) {
      spends = spends.filter((spend) => spend.at >= floor);
    }
  }

  function usedIn(window: RateWindow, nowMs: number): number {
    const floor = nowMs - window.windowMs;
    let total = 0;
    for (const spend of spends) if (spend.at > floor) total += spend.cost;
    return total;
  }

  return {
    windows,

    check(cost: number, now: Date): RateVerdict {
      const nowMs = now.getTime();
      prune(nowMs);
      for (const window of windows) {
        const used = usedIn(window, nowMs);
        if (used + cost <= window.limit) continue;
        // When does enough spend fall out of this window for `cost` to fit?
        // Walk the spends oldest-first, accumulating what would be freed.
        const floor = nowMs - window.windowMs;
        const live = spends.filter((spend) => spend.at > floor);
        let freed = 0;
        let retryAfterMs = window.windowMs;
        for (const spend of live) {
          freed += spend.cost;
          if (used - freed + cost <= window.limit) {
            retryAfterMs = Math.max(1, spend.at + window.windowMs - nowMs);
            break;
          }
        }
        return { ok: false, retryAfterMs, window };
      }
      return { ok: true };
    },

    record(cost: number, now: Date): void {
      const at = now.getTime();
      spends.push({ at, cost });
      // Keep sorted: `check` walks oldest-first and a clock that goes backwards
      // (it does, under NTP) would otherwise corrupt the retry estimate.
      if (spends.length > 1 && (spends[spends.length - 2]?.at ?? 0) > at) {
        spends.sort((a, b) => a.at - b.at);
      }
      prune(at);
    },

    hydrate(history) {
      for (const entry of history) spends.push({ at: entry.at.getTime(), cost: entry.cost });
      spends.sort((a, b) => a.at - b.at);
    },

    spent(now: Date) {
      const nowMs = now.getTime();
      prune(nowMs);
      return windows.map((window) => ({ window, used: usedIn(window, nowMs) }));
    },
  };
}

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Tiingo: 50 requests/hour **and** 1,000/day (01 §4.1).
 *
 * Both, not the tighter one: they bind at different timescales and a refresh
 * that respects only the daily number would burn the hourly one in ninety
 * seconds. The third documented limit — 500 unique symbols/month — is not a
 * rate and is not modelled here; it is a *coverage* limit, tracked per symbol
 * in `market_data_runs.symbols_asked`, and one person's portfolio is nowhere
 * near it.
 */
export const TIINGO_WINDOWS: readonly RateWindow[] = Object.freeze([
  Object.freeze({ windowMs: HOUR_MS, limit: 50, unit: 'request' as const, label: '50/hour' }),
  Object.freeze({ windowMs: DAY_MS, limit: 1_000, unit: 'request' as const, label: '1,000/day' }),
]);

/** FRED: 120 requests per 60 seconds, no daily cap (01 §4.1). */
export const FRED_WINDOWS: readonly RateWindow[] = Object.freeze([
  Object.freeze({
    windowMs: MINUTE_MS,
    limit: 120,
    unit: 'request' as const,
    label: '120/60 s',
  }),
]);

/**
 * CoinGecko Demo: ~100 calls/minute and **10,000 credits/month** (01 §3.6).
 *
 * The monthly window is 30 days rather than a calendar month, which is
 * deliberately conservative: a sliding 30-day window can never permit more in a
 * calendar month than the calendar month allows, whereas a calendar bucket
 * permits 10,000 on the 31st and 10,000 more on the 1st.
 */
export const COINGECKO_WINDOWS: readonly RateWindow[] = Object.freeze([
  Object.freeze({ windowMs: MINUTE_MS, limit: 100, unit: 'request' as const, label: '100/minute' }),
  Object.freeze({
    windowMs: 30 * DAY_MS,
    limit: 10_000,
    unit: 'credit' as const,
    label: '10,000 credits/month',
  }),
]);

/** OpenFIGI: 25,000 mapping **jobs** per minute with a free key (01 §4.1). */
export const OPENFIGI_WINDOWS: readonly RateWindow[] = Object.freeze([
  Object.freeze({
    windowMs: MINUTE_MS,
    limit: 25_000,
    unit: 'job' as const,
    label: '25,000 jobs/minute',
  }),
]);

/**
 * yfinance/Yahoo: no documented quota, "throttled ad hoc" (01 §4.1).
 *
 * A self-imposed 60/hour, because the honest answer to an undocumented limit is
 * to behave conservatively rather than to pretend there is none. This adapter is
 * opt-in and best-effort by 01 §4.2's ruling; a generous budget would be the
 * wrong signal.
 */
export const YFINANCE_WINDOWS: readonly RateWindow[] = Object.freeze([
  Object.freeze({
    windowMs: HOUR_MS,
    limit: 60,
    unit: 'request' as const,
    label: '60/hour (self-imposed; Yahoo publishes none)',
  }),
]);
