// SPDX-License-Identifier: MIT
import type { GetMarketDataSettingsResponse } from '../../api/generated/types.gen.ts';

type Yahoo = GetMarketDataSettingsResponse['yahoo'];

export const YAHOO_CONSENT_TEXT =
  // The api's own text (apps/api/src/yahoo-consent.ts, `yahoo-consent/1`), verbatim.
  'Use Yahoo Finance, through the yfinance library, for prices on this install. I understand that: it is unofficial — Yahoo does not offer or support it; Yahoo’s terms prohibit automated collection of its data; it is for my personal use only; it is best effort and may stop working at any time without notice; and the data is not licensed for redistribution, so I will not share it. What leaves this machine: the ticker symbols and dates asked for, sent by the yahoo sidecar to Yahoo — never your name, an account, a quantity or an amount.';

export const YAHOO_ATTRIBUTION: Yahoo['attribution'] = {
  provider: 'yfinance',
  required: true,
  text: 'Yahoo Finance via yfinance — unofficial, best effort',
  linkUrl: null,
  logoRequired: false,
  surfaces: ['any_price', 'settings'],
  clause: 'Yahoo Finance via yfinance: unofficial and best effort.',
  redistribution: 'forbidden',
};

/** `GET /market-data/settings`'s `yahoo` field, the default: operator half off, no consent, no placements. */
export function yahooSettings(overrides: Partial<Yahoo> = {}): Yahoo {
  return {
    operatorEnabled: false,
    consent: { given: false, consentedAt: null, version: null },
    consentVersion: 'yahoo-consent/1',
    consentText: YAHOO_CONSENT_TEXT,
    consentSha256: 'sha256:b9b043cbf9ecf05061d08f729849e7f688745f227895408df69ec703fadc9e89',
    whatLeaves:
      'the ticker symbols and dates asked for, sent by the yahoo sidecar to Yahoo — never your name, an account, a quantity or an amount',
    ready: false,
    notReady: 'operator_disabled',
    placements: [],
    lastOutcome: null,
    budget: [{ label: 'requests/hour', used: 0, limit: 60 }],
    attribution: YAHOO_ATTRIBUTION,
    ...overrides,
  };
}
