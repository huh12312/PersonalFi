// SPDX-License-Identifier: MIT
/**
 * Fakes. Two kinds, and the difference is the point.
 *
 * **`createFakeTransport`** replaces only the socket. Everything above it — the
 * egress guard, the allow-list, the redirect refusal, the header vocabulary,
 * the budget, the decimal-preserving parser, the adapter's own response mapping
 * — is the real code. This is what the adapter suites use, so "no network in
 * tests" costs us no coverage of the parts that can be wrong.
 *
 * **`createFakePriceSource`** replaces the whole port. This is what *consumers*
 * use — the refresh job, and eventually `@ctx/planning`'s snapshotter — because
 * a consumer's tests are about what it does with a quote, not about how the
 * quote was fetched.
 *
 * A fake that replaces too much is how a suite ends up asserting that the fake
 * works. `test/egress-allowlist.test.ts` uses the first kind for exactly that
 * reason: a fake `PriceSource` could not refuse `db:5432`, because it never had
 * an allow-list in it to begin with.
 */
import type { HttpTransport, TransportRequest, TransportResponse } from '@core/platform';
import type { MarketDataProvider } from '../schema/index.ts';
import { ATTRIBUTIONS } from '../attribution.ts';
import { createRateBudget, type RateWindow } from '../rate-limit.ts';
import type {
  FxQuote,
  PriceQuote,
  PriceRequest,
  PriceSource,
  PriceSourceCapabilities,
  SearchHit,
  SourceOutcome,
} from '../price-source.ts';

// ---------------------------------------------------------------------------
// Transport fake
// ---------------------------------------------------------------------------

export interface FakeTransport {
  readonly transport: HttpTransport;
  /** Every request that got past the guard, in order. What a test asserts on. */
  readonly requests: readonly TransportRequest[];
}

export type FakeHandler = (
  request: TransportRequest,
) => TransportResponse | Promise<TransportResponse>;

/**
 * A transport that answers from a handler and records what it was asked.
 *
 * It records the request *after* the guard has run, so a test asserting
 * `requests` is empty is asserting that nothing reached the network — which is
 * the claim every refusal test actually needs to make.
 */
export function createFakeTransport(handler: FakeHandler): FakeTransport {
  const requests: TransportRequest[] = [];
  return {
    requests,
    transport: async (request) => {
      requests.push(request);
      return await handler(request);
    },
  };
}

/** A 200 with this JSON body. */
export function jsonResponse(body: unknown, status = 200): TransportResponse {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { status, body: text, bytesRead: Buffer.byteLength(text), location: null };
}

/** A 3xx. The transport returns it; `classifyStatus` refuses it; nobody follows it. */
export function redirectResponse(location: string, status = 302): TransportResponse {
  return { status, body: '', bytesRead: 0, location };
}

// ---------------------------------------------------------------------------
// Port fake
// ---------------------------------------------------------------------------

export interface FakePriceSourceOptions {
  readonly provider?: MarketDataProvider;
  readonly capabilities?: Partial<PriceSourceCapabilities>;
  readonly hasKey?: boolean;
  /** `${subjectKey}|${date}|${currency}` → a close, as a decimal string. */
  readonly prices?: Readonly<Record<string, string>>;
  /** `${BASE}/${QUOTE}|${date}` → a rate, as a decimal string. */
  readonly fx?: Readonly<Record<string, string>>;
  /** Force an outcome for every call, so a consumer's degradation is testable. */
  readonly outcome?: SourceOutcome<never>;
  readonly now?: () => Date;
  readonly windows?: readonly RateWindow[];
}

export interface FakePriceSource extends PriceSource {
  /** Every price request, in order. */
  readonly priceCalls: readonly PriceRequest[];
  readonly fxCalls: readonly { readonly from: string; readonly to: string; readonly date: string }[];
}

/** The key `FakePriceSourceOptions.prices` is written in. */
export function fakePriceKey(request: PriceRequest): string {
  const subject = request.subject;
  const id =
    subject.kind === 'ticker'
      ? subject.symbol.toUpperCase()
      : subject.kind === 'coin_id'
        ? subject.coinId
        : `${subject.chain}:${subject.contract}`;
  return `${id}|${request.date}|${request.currency.toUpperCase()}`;
}

export function createFakePriceSource(options: FakePriceSourceOptions = {}): FakePriceSource {
  const provider = options.provider ?? 'tiingo';
  const attribution = ATTRIBUTIONS[provider];
  const now = options.now ?? (() => new Date('2026-09-21T03:45:00.000Z'));
  const prices = options.prices ?? {};
  const fx = options.fx ?? {};
  const priceCalls: PriceRequest[] = [];
  const fxCalls: { from: string; to: string; date: string }[] = [];
  const budget = createRateBudget(
    options.windows ?? [{ windowMs: 60_000, limit: 1_000_000, unit: 'request', label: 'fake' }],
  );

  return {
    provider,
    attribution,
    hasKey: options.hasKey ?? true,
    capabilities: {
      prices: options.capabilities?.prices ?? true,
      fx: options.capabilities?.fx ?? true,
      macro: options.capabilities?.macro ?? false,
      search: options.capabilities?.search ?? false,
    },
    priceCalls,
    fxCalls,
    budget: (at) =>
      budget.spent(at).map((entry) => ({
        label: entry.window.label,
        used: entry.used,
        limit: entry.window.limit,
      })),

    price(request: PriceRequest): Promise<SourceOutcome<PriceQuote>> {
      priceCalls.push(request);
      if (options.outcome !== undefined) return Promise.resolve(options.outcome);
      const close = prices[fakePriceKey(request)];
      if (close === undefined) {
        return Promise.resolve({ kind: 'no_data', detail: 'the fake has no price for that key' });
      }
      return Promise.resolve({
        kind: 'ok',
        value: {
          subject: request.subject,
          date: request.date,
          close,
          currency: request.currency.toUpperCase(),
          provider,
          stale: false,
          observedAt: now(),
          attribution,
        },
      });
    },

    fxRate(from: string, to: string, date: string): Promise<SourceOutcome<FxQuote>> {
      fxCalls.push({ from, to, date });
      if (options.outcome !== undefined) return Promise.resolve(options.outcome);
      const rate = fx[`${from.toUpperCase()}/${to.toUpperCase()}|${date}`];
      if (rate === undefined) {
        return Promise.resolve({ kind: 'no_data', detail: 'the fake has no rate for that pair' });
      }
      return Promise.resolve({
        kind: 'ok',
        value: {
          base: from.toUpperCase(),
          quote: to.toUpperCase(),
          date,
          rate,
          provider,
          observedAt: now(),
          attribution,
        },
      });
    },

    search(): Promise<SourceOutcome<readonly SearchHit[]>> {
      return Promise.resolve({ kind: 'ok', value: [] });
    },
  };
}
