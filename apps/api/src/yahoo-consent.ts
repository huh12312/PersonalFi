// SPDX-License-Identifier: MIT
/**
 * The consent a holder gives before Yahoo Finance may be used for their prices
 * (WP 12.6; decision D33; docs/research/14 §2-§3).
 *
 * Shown beside a checkbox on the Yahoo Finance card in Settings → Market data.
 * Until it is ticked, `PUT /market-data/priority` refuses to place `yfinance`
 * in any ladder and the worker's adapter refuses every request; unticking it
 * withdraws `yfinance` from every ladder in the same transaction.
 * `market_data_consents` records the version and the sha256 of these exact
 * bytes. Changing a word is a new version: every standing consent then stops
 * counting (the adapter compares version **and** hash), and the holder is asked
 * again. The narrator's consent (`narrator-consent.ts`) is the pattern.
 *
 * The text says, in plain words, research 14 §2's five facts — unofficial;
 * Yahoo's terms prohibit automated collection; personal use only; best effort,
 * may stop working; not licensed for redistribution — and what leaves the
 * machine.
 */
import type { ConsentText } from '@ctx/integrations';
import { sha256 } from '@core/secretbox';

export const YAHOO_CONSENT_VERSION = 'yahoo-consent/1';

/** What leaves the machine, in the consent's words and the card's. */
export const YAHOO_CONSENT_WHAT_LEAVES =
  'the ticker symbols and dates asked for, sent by the yahoo sidecar to Yahoo — never your name, an account, a quantity or an amount';

export const YAHOO_CONSENT_TEXT =
  'Use Yahoo Finance, through the yfinance library, for prices on this install. I understand that: ' +
  'it is unofficial — Yahoo does not offer or support it; Yahoo’s terms prohibit automated collection ' +
  'of its data; it is for my personal use only; it is best effort and may stop working at any time ' +
  'without notice; and the data is not licensed for redistribution, so I will not share it. ' +
  `What leaves this machine: ${YAHOO_CONSENT_WHAT_LEAVES}.`;

export function yahooConsentSha256(): string {
  const digest = sha256(new TextEncoder().encode(YAHOO_CONSENT_TEXT));
  return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** The current text, as `@ctx/integrations`' consent functions take it. */
export function currentYahooConsent(): ConsentText {
  return { version: YAHOO_CONSENT_VERSION, sha256: yahooConsentSha256() };
}
