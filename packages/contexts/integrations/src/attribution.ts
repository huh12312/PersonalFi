// SPDX-License-Identifier: MIT
/**
 * Attribution is a licence condition, not a courtesy.
 *
 * 03-phase-3-dispatch.md §3 states it that way on purpose: *"CoinGecko requires
 * 'Data provided by CoinGecko' with logo and hyperlink on any surface showing a
 * crypto price, FRED requires its exact disclaimer string, and Tiingo's
 * personal tier forbids redistribution."* 01 §3.6 is blunter: the CoinGecko
 * attribution element is *"a hard license condition, not a courtesy"*.
 *
 * ## Why an obligation travels with the data
 *
 * A UI cannot render an obligation it was never told about. If the API returns
 * a crypto price as a bare number, the only thing standing between this
 * deployment and a licence breach is a developer remembering, in a different
 * package, months later, that this particular number came from CoinGecko. That
 * is not a control.
 *
 * So every quote carries its provider, every provider has an `Attribution`
 * here, and the read model computes `attributionRequirementsOf(...)` — the set
 * of obligations the surface about to render these numbers *must* satisfy.
 * WP 3.12's e2e test (`'the CoinGecko attribution is present on every screen
 * showing a crypto price'`) asserts against the rendered page; this module is
 * what makes that assertion possible rather than a guess, and
 * `test/attribution.test.ts` → `'the CoinGecko read model carries the
 * attribution requirement'` is its half of the seam.
 *
 * ## Redistribution is a separate axis
 *
 * Tiingo requires no badge. What its free tier forbids is *redistribution*:
 * "your own personal use… may not display or share the data with another person
 * or organization" (01 §4.1). That is not an attribution obligation and folding
 * it into one would lose it. It is recorded here as `redistribution:
 * 'forbidden'`, which is the field an export path or a sharing feature has to
 * consult — and the reason WP 3.13's `?encrypt=true` export and any future
 * "share my portfolio" feature must ask before they ship.
 */
import type { MarketDataProvider } from '../schema/index.ts';

/** Where an obligation binds. `any_price` means every surface showing one of these numbers. */
export type AttributionSurface = 'any_price' | 'any_macro_figure' | 'settings';

export interface Attribution {
  readonly provider: MarketDataProvider;
  /**
   * `true` ⇒ the licence requires this on screen. A UI that omits it is in
   * breach, not merely impolite.
   */
  readonly required: boolean;
  /** The exact string to render. Not a template; providers specify wording. */
  readonly text: string;
  /** The hyperlink the text must carry, or `null` when none is required. */
  readonly linkUrl: string | null;
  /** A logo the licence requires beside the text, or `null`. */
  readonly logoRequired: boolean;
  /** Which surfaces the obligation binds on. */
  readonly surfaces: readonly AttributionSurface[];
  /** The clause, quoted, so a reviewer can check the claim rather than trust it. */
  readonly clause: string;
  /** Whether this provider's data may leave the deployment. */
  readonly redistribution: 'forbidden' | 'permitted_with_attribution' | 'unrestricted';
}

/**
 * The obligations, per provider, sourced from 01 §3.6 and §4.1.
 *
 * Quoted clauses are copied from the research document rather than paraphrased.
 * A paraphrase of a licence condition is a new licence condition.
 */
export const ATTRIBUTIONS: Readonly<Record<MarketDataProvider, Attribution>> = Object.freeze({
  coingecko: Object.freeze({
    provider: 'coingecko' as const,
    required: true,
    text: 'Data provided by CoinGecko',
    linkUrl: 'https://www.coingecko.com',
    logoRequired: true,
    surfaces: Object.freeze(['any_price' as const, 'settings' as const]),
    clause:
      'CoinGecko Demo (free tier): "Attribution required even on free tier — must display ' +
      '\'Data provided by CoinGecko\' with logo + hyperlink" (01 §3.6, citing CoinGecko\'s ' +
      'Attribution Guide). 01 §3.6: "a hard license condition, not a courtesy".',
    redistribution: 'permitted_with_attribution' as const,
  }),

  fred: Object.freeze({
    provider: 'fred' as const,
    required: true,
    // The exact string. Not "uses FRED data" and not a reworded version: 01
    // §4.3 quotes it verbatim and the ® is part of it.
    text:
      'This product uses the FRED® API but is not endorsed or certified by the ' +
      'Federal Reserve Bank of St. Louis.',
    linkUrl: 'https://fred.stlouisfed.org/docs/api/terms_of_use.html',
    logoRequired: false,
    surfaces: Object.freeze(['any_macro_figure' as const, 'settings' as const]),
    clause:
      'FRED API terms: 01 §4.1 "Attribution string required"; 01 §4.3 gives the exact ' +
      'sentence — "Requires displaying: \'This product uses the FRED® API but is not ' +
      'endorsed or certified by the Federal Reserve Bank of St. Louis.\'"',
    redistribution: 'permitted_with_attribution' as const,
  }),

  tiingo: Object.freeze({
    provider: 'tiingo' as const,
    // No badge is required. What is required is that the data does not leave.
    required: false,
    text: '',
    linkUrl: null,
    logoRequired: false,
    surfaces: Object.freeze([]),
    clause:
      'Tiingo free tier ToS (01 §4.1): "your own personal use… may not display or share the ' +
      'data with another person or organization." 01 §4.3 records that this language is why ' +
      'Tiingo is D17\'s default — it is "an almost exact description of our deployment model".',
    redistribution: 'forbidden' as const,
  }),

  openfigi: Object.freeze({
    provider: 'openfigi' as const,
    required: false,
    text: '',
    linkUrl: null,
    logoRequired: false,
    surfaces: Object.freeze([]),
    clause: 'OpenFIGI (01 §4.1): "25,000 mapping jobs/min with free key… Free." No badge required.',
    redistribution: 'unrestricted' as const,
  }),

  yfinance: Object.freeze({
    provider: 'yfinance' as const,
    required: false,
    text: '',
    linkUrl: null,
    logoRequired: false,
    surfaces: Object.freeze([]),
    clause:
      'Yahoo via yfinance (01 §4.2): "The library is Apache-2.0 and safe to depend on from MIT ' +
      'code. The legal risk is the data, not the code." There is no Yahoo data licence, so ' +
      'there is no attribution that would make redistribution lawful; this adapter is opt-in ' +
      'and labelled best-effort, and is never the documented default (D17).',
    redistribution: 'forbidden' as const,
  }),
});

/**
 * The obligations a surface rendering these providers' numbers must satisfy.
 *
 * Deduplicated and ordered by provider name so the read model is stable — a UI
 * test asserting on an array should not go red because a set iterated
 * differently.
 */
export function attributionRequirementsOf(
  providers: Iterable<MarketDataProvider>,
): readonly Attribution[] {
  const required = new Map<MarketDataProvider, Attribution>();
  for (const provider of providers) {
    const attribution = ATTRIBUTIONS[provider];
    if (attribution.required) required.set(provider, attribution);
  }
  return [...required.values()].sort((a, b) => a.provider.localeCompare(b.provider));
}

/** Does this provider's licence forbid the data leaving the deployment? */
export function forbidsRedistribution(provider: MarketDataProvider): boolean {
  return ATTRIBUTIONS[provider].redistribution === 'forbidden';
}
