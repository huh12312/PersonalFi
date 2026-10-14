// SPDX-License-Identifier: MIT
/**
 * WP 10.5: what `POST /market-data/refresh` did, in words. Pure - the button renders these strings, the tests
 * pin them. Nothing here reaches the network or the DOM.
 */
import type { PriceRefreshSummary } from '../../api/generated/types.gen.ts';

type Summary = PriceRefreshSummary;
type Unpriced = Summary['unpriced'][number];
export type RefreshReason = Unpriced['reason'];
type Provider = Unpriced['provider'];

const PROVIDER_NAMES: Readonly<Record<NonNullable<Provider>, string>> = {
  tiingo: 'Tiingo',
  coingecko: 'CoinGecko',
  fred: 'FRED',
  openfigi: 'OpenFIGI',
  yfinance: 'Yahoo Finance',
};

function providerLabel(provider: Provider): string | null {
  return provider === null ? null : PROVIDER_NAMES[provider];
}

/** Why one security (or FX pair) was not priced, as a short phrase. `provider` names the source that was asked. */
export function reasonWords(reason: RefreshReason, provider: Provider): string {
  const name = providerLabel(provider);
  switch (reason) {
    case 'source_not_configured':
    case 'skipped_no_key':
      return name === null ? 'no key for the provider' : `no ${name} key`;
    case 'no_ticker':
      return 'no ticker';
    case 'no_coin_id':
      return 'no CoinGecko coin id';
    case 'no_data':
      return `${name ?? 'the provider'} had no price`;
    case 'rate_limited':
      return `${name ?? 'the provider'} request budget used up`;
    case 'refused':
      return 'blocked by the egress guard';
    case 'error':
      return `${name ?? 'the provider'} did not answer`;
    case 'no_provider_for_kind':
      return 'no provider prices this kind';
  }
}

/** A security the way a person would name it: its symbol, else its name. */
export function securityLabel(item: { symbol: string | null; name: string | null }): string {
  if (item.symbol !== null && item.symbol !== '') return item.symbol;
  if (item.name !== null && item.name !== '') return item.name;
  return 'Unnamed security';
}

export interface UnpricedLine {
  readonly securityId: string;
  readonly label: string;
  readonly words: string;
  readonly detail: string | null;
}

export interface RefreshDescription {
  /** The one-line answer: "Priced 12 of 13; 1 unpriced: no CoinGecko key." */
  readonly headline: string;
  /** Short second sentences, only when they have something to say (non-priced holdings, failed FX pairs). */
  readonly notes: readonly string[];
  /** Every unpriced security, for the disclosure. */
  readonly unpriced: readonly UnpricedLine[];
  /** headline and notes as a single string. */
  readonly text: string;
}

/** Groups equal phrases, most common first (ties keep the order they were first seen in). */
function groupCounts(phrases: readonly string[]): { phrase: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const phrase of phrases) counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
  return [...counts.entries()]
    .map(([phrase, count]) => ({ phrase, count }))
    .sort((a, b) => b.count - a.count);
}

function headlineOf(summary: Summary, unpricedLines: readonly UnpricedLine[]): string {
  const { priceable, priced, unpriced } = summary.counts;
  if (priceable === 0) return 'Nothing to price: no holdings a provider prices.';
  if (unpriced === 0) return `Priced ${String(priced)} of ${String(priceable)}.`;
  const groups = groupCounts(unpricedLines.map((line) => line.words));
  const reasons =
    groups.length === 1
      ? (groups[0]?.phrase ?? '')
      : groups.map((group) => `${group.phrase} (${String(group.count)})`).join(', ');
  return `Priced ${String(priced)} of ${String(priceable)}; ${String(unpriced)} unpriced: ${reasons}.`;
}

function notPricedNote(count: number): string | null {
  if (count === 0) return null;
  return count === 1
    ? '1 cash or other holding is not priced by a provider.'
    : `${String(count)} cash or other holdings are not priced by a provider.`;
}

/** "EUR→USD rate not fetched: no FRED key." - failed pairs grouped by their reason. */
function fxNotes(pairs: Summary['fx']['pairs']): string[] {
  const failed = pairs.filter((pair) => !pair.fetched);
  const byWords = new Map<string, string[]>();
  for (const pair of failed) {
    const words = pair.reason === null ? '' : reasonWords(pair.reason, 'fred');
    byWords.set(words, [...(byWords.get(words) ?? []), `${pair.base}→${pair.quote}`]);
  }
  return [...byWords.entries()].map(([words, names]) => {
    const subject = `${names.join(', ')} ${names.length === 1 ? 'rate' : 'rates'} not fetched`;
    return words === '' ? `${subject}.` : `${subject}: ${words}.`;
  });
}

export function describeRefresh(summary: Summary): RefreshDescription {
  const unpriced: UnpricedLine[] = summary.unpriced.map((item) => ({
    securityId: item.securityId,
    label: securityLabel(item),
    words: reasonWords(item.reason, item.provider),
    detail: item.detail !== null && item.detail !== '' ? item.detail : null,
  }));
  const headline = headlineOf(summary, unpriced);
  const notePriced = notPricedNote(summary.counts.notPricedByProvider);
  const notes = [...(notePriced === null ? [] : [notePriced]), ...fxNotes(summary.fx.pairs)];
  return { headline, notes, unpriced, text: [headline, ...notes].join(' ') };
}

// ---------------------------------------------------------------------------------------------------------
// The 409
// ---------------------------------------------------------------------------------------------------------

export const REFRESH_TOO_SOON_CODE = 'market_data.refresh_too_soon';

const ISO_INSTANT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})/u;

/** HH:MM in the holder's local time, 24-hour. */
function localClock(instant: Date): string {
  return instant.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}

/** Is `cause` the api's "refreshed less than ten minutes ago"? */
export function isRefreshTooSoon(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    (cause as { code?: unknown }).code === REFRESH_TOO_SOON_CODE
  );
}

/**
 * "Prices were refreshed recently. Try again after 09:10." The instant comes out of the api's `detail` ("Try
 * again after <ISO instant>."); when there is none to read, the detail itself is shown, and failing that a
 * plain "in a few minutes".
 */
export function tooSoonWords(cause: unknown): string {
  const detail =
    typeof cause === 'object' && cause !== null && 'detail' in cause
      ? (cause as { detail?: unknown }).detail
      : undefined;
  const text = typeof detail === 'string' ? detail : '';
  const instant = ISO_INSTANT.exec(text)?.[0];
  if (instant !== undefined) {
    const when = new Date(instant);
    if (!Number.isNaN(when.getTime())) {
      return `Prices were refreshed recently. Try again after ${localClock(when)}.`;
    }
  }
  return text !== ''
    ? `Prices were refreshed recently. ${text}`
    : 'Prices were refreshed recently. Try again in a few minutes.';
}
