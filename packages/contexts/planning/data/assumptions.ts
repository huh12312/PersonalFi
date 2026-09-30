// SPDX-License-Identifier: MIT
/**
 * PersonalFi's default planning assumptions — 07 §5.5, §6.4 and Appendix A —
 * with the year-keyed US tax tables beside them.
 *
 * Data, not code: no runtime import but its sibling `./us-2026.ts`. Read only
 * through `src/assumptions.ts`, which validates it with zod, freezes it, and
 * versions it by content hash. Every number sits in a cited node carrying a
 * `source` and an `asOf`; the `source` is shown in the UI beside the number
 * (07 §5.5), so it is written for a reader, primary source first.
 *
 * `asOf` means the date the figure is true as of: a forecast's basis date, a
 * market observation's date, a law's in-force date. The capital-market figures
 * are PersonalFi's chosen defaults and say so — 07 §5.5 is where each one was
 * chosen, and the `source` names the evidence it was chosen against.
 *
 * Changing any value, source, date or note here changes `assumptionsVersion()`.
 * Changing a comment does not. That is tested.
 */
import type { AssumptionsFileInput } from '../src/assumptions.ts';
import { US_2026 } from './us-2026.ts';

const MEMO = '2026-09-10';
const VCMM_BASIS = '2025-12-31';

const DEFAULT_55 = (basis: string): string => `PersonalFi default, 07 §5.5 — ${basis}`;
const VCMM =
  'Vanguard Capital Markets Model 10-year forecasts as of 2025-12-31, ' +
  'https://corporate.vanguard.com/content/corporatesite/us/en/corp/vemo/vemo-return-forecasts.html';

const FRED_ATTRIBUTION =
  'This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.';

const nominal = (value: string, source: string, asOf: string, note?: string) => ({
  kind: 'rate' as const,
  value,
  basis: 'nominal' as const,
  source,
  asOf,
  ...(note === undefined ? {} : { note }),
});

const plainRate = (value: string, source: string, asOf: string, note?: string) => ({
  kind: 'rate' as const,
  value,
  source,
  asOf,
  ...(note === undefined ? {} : { note }),
});

export const ASSUMPTIONS_FILE = {
  format: 'personalfi.assumptions/1',
  label: 'PersonalFi default assumptions (07 §5.5 and Appendix A, memo of 2026-09-10)',

  capitalMarket: {
    usEquity: {
      expectedReturn: nominal(
        '0.065',
        DEFAULT_55(
          `a blend of the long-run historical ≈10% and ${VCMM} (US equity 3.9–5.9%); deliberately conservative`,
        ),
        VCMM_BASIS,
      ),
      volatility: plainRate(
        '0.17',
        DEFAULT_55('long-run US equity annual standard deviation'),
        VCMM_BASIS,
      ),
    },
    intlDevelopedEquity: {
      expectedReturn: nominal(
        '0.07',
        DEFAULT_55(`${VCMM} — non-US developed generally above US in recent runs`),
        VCMM_BASIS,
      ),
      volatility: plainRate(
        '0.19',
        DEFAULT_55('international developed equity annual standard deviation'),
        VCMM_BASIS,
      ),
    },
    emergingEquity: {
      expectedReturn: nominal(
        '0.075',
        DEFAULT_55('historical emerging-market premium over developed'),
        MEMO,
      ),
      volatility: plainRate(
        '0.24',
        DEFAULT_55('historical emerging-market volatility, higher than developed'),
        MEMO,
      ),
    },
    usAggregateBonds: {
      expectedReturn: nominal(
        '0.045',
        DEFAULT_55(`${VCMM} (US aggregate ≈4–5%); consistent with current yields`),
        VCMM_BASIS,
      ),
      volatility: plainRate(
        '0.06',
        DEFAULT_55('US aggregate bond annual standard deviation'),
        VCMM_BASIS,
      ),
    },
    tips: {
      expectedReturn: {
        kind: 'rate',
        value: '0.02',
        basis: 'inflation_adjusted',
        source: DEFAULT_55('current TIPS yields, net of inflation'),
        asOf: MEMO,
        note: 'The one expected return in this file stated after inflation (07 §5.5: "2.0% real").',
      },
      volatility: plainRate('0.06', DEFAULT_55('TIPS annual standard deviation'), MEMO),
    },
    cash: {
      expectedReturn: nominal(
        '0.035',
        DEFAULT_55(
          '3-month T-bill ≈3.93% on 2026-09-10 and trending down (TradingEconomics, ' +
            'https://tradingeconomics.com/united-states/3-month-bill-yield)',
        ),
        MEMO,
      ),
      volatility: plainRate('0.01', DEFAULT_55('T-bill annual standard deviation'), MEMO),
    },
    crypto: {
      expectedReturn: nominal(
        '0.065',
        'PersonalFi default, 07 §5.5 and §6.4 — no defensible expected-return estimate exists; set equal to US equity',
        MEMO,
      ),
      volatility: plainRate(
        '0.70',
        'PersonalFi default, 07 §5.5 and §6.4 — BTC-weighted crypto volatility',
        MEMO,
      ),
      distribution: {
        kind: 'fact',
        value:
          'Crypto is its own asset class, drawn from a Student-t distribution or a block bootstrap of BTC ' +
          'monthly returns since 2014 — never folded into equity and never lognormal.',
        source: '07 §6.4 (lognormal dramatically understates crypto drawdowns)',
        asOf: MEMO,
      },
      degreesOfFreedom: {
        kind: 'integer',
        value: '3',
        unit: 'degrees_of_freedom',
        source: '07 §6.4 — Student-t(ν=3)',
        asOf: MEMO,
      },
      disclaimer: {
        kind: 'fact',
        value:
          'Crypto has fewer than 15 years of usable price history, all of it within one monetary regime. ' +
          'There is no defensible estimate of its expected return: this plan borrows the US-equity figure ' +
          'and pairs it with crypto’s own, far larger volatility, which is a placeholder and not a forecast. ' +
          'Every plan is also shown with crypto valued at zero; if a plan only works with crypto, that is ' +
          'the finding.',
        source:
          '07 §6.4, mandatory UI treatments 1 and 2 — shown wherever a crypto assumption is shown',
        asOf: MEMO,
      },
    },
    inflation: {
      mean: nominal(
        '0.025',
        DEFAULT_55(
          'long-run target; the 2026 Social Security COLA is 2.8% (SSA press release 2025-10-24)',
        ),
        MEMO,
      ),
      volatility: plainRate('0.015', DEFAULT_55('long-run US CPI annual standard deviation'), MEMO),
    },
    wageGrowth: {
      spreadOverInflation: plainRate(
        '0.005',
        DEFAULT_55(
          'long-run growth in wages after inflation; wage growth = inflation + this spread',
        ),
        MEMO,
      ),
    },
    equityRiskPremiumCrossCheck: plainRate(
      '0.0423',
      'Damodaran, implied US equity risk premium, January 2026 — ' +
        'https://pages.stern.nyu.edu/~adamodar/New_Home_Page/datafile/histimpl.html (07 §5.5 cross-check row)',
      '2026-01-01',
      'A cross-check on the US equity default, not an input to any projection.',
    ),
  },

  correlation: {
    kind: 'correlation',
    value: {
      assets: ['USEQ', 'INTL', 'EM', 'BOND', 'TIPS', 'REIT', 'CASH', 'CRYPTO'],
      matrix: [
        ['1.00', '0.85', '0.75', '0.10', '0.00', '0.70', '-0.05', '0.40'],
        ['0.85', '1.00', '0.85', '0.10', '0.05', '0.65', '-0.05', '0.35'],
        ['0.75', '0.85', '1.00', '0.05', '0.05', '0.60', '-0.05', '0.40'],
        ['0.10', '0.10', '0.05', '1.00', '0.70', '0.25', '0.20', '0.05'],
        ['0.00', '0.05', '0.05', '0.70', '1.00', '0.25', '0.25', '0.05'],
        ['0.70', '0.65', '0.60', '0.25', '0.25', '1.00', '0.00', '0.30'],
        ['-0.05', '-0.05', '-0.05', '0.20', '0.25', '0.00', '1.00', '0.00'],
        ['0.40', '0.35', '0.40', '0.05', '0.05', '0.30', '0.00', '1.00'],
      ],
    },
    source:
      'PersonalFi default, 07 §5.5 correlation matrix (annual, after inflation) — a starting point; ' +
      'the bootstrap engine derives correlations empirically. ρ(crypto, US equity) = 0.40 per 07 §6.4.',
    asOf: MEMO,
    note:
      'REIT has a correlation row but no expected return or volatility in 07 §5.5. The engines have no ' +
      'asset-class input, so a REIT holding is never refused and never given its own μ/σ: the net-worth ' +
      "snapshot sums it into its account's tax bucket and it is projected at that bucket's glidepath " +
      'equity/bond blend, like every other holding. The REIT row enters only the lognormal engine’s ' +
      'Cholesky factorisation, as part of the positive-definiteness check, and never moves a draw ' +
      '(decided and pinned by WP 5.5).',
  },

  // WP 5.5: 07 §5.6's `initial_wr`, moved here from the composition root's
  // `GUARDRAIL_REFERENCE_RATE` literal. Overridable (07 marks it user-settable);
  // adding it moved this file's version, and the previous version is retained,
  // frozen, in `./assumptions-retained.ts` so overrides saved against it resolve.
  withdrawalPolicy: {
    guardrailReferenceRate: plainRate(
      '0.045',
      '07 §5.6 — initial_wr = 0.045 (user-settable): the initial withdrawal rate the Guyton-Klinger ' +
        'guardrail band is drawn around (07 R7: the band is this rate times the guardrail multiples, ' +
        "WP 4.4's GUYTON_KLINGER). Held until WP 5.5 as a literal in the composition root",
      MEMO,
      'A reference for reading this year’s withdrawal rate against, not an input to any projection: ' +
        'the engine’s guardrails move spending from the plan’s own first-year rate.',
    ),
  },

  socialSecurityStress: {
    fromCalendarYear: {
      kind: 'integer',
      value: '2034',
      unit: 'calendar_year',
      source: '07 §5.8 — the "75% benefit after 2034" stress toggle; a lever, not a forecast',
      asOf: MEMO,
    },
    payableRatio: plainRate(
      '0.75',
      '07 §5.8 — the "75% benefit after 2034" stress toggle; a lever, not a forecast',
      MEMO,
    ),
  },

  marketReference: {
    treasuryBill3Month: plainRate(
      '0.0393',
      'TradingEconomics, United States 3 Month Bill Yield, https://tradingeconomics.com/united-states/3-month-bill-yield ' +
        '(07 Appendix A, "Market reference points"; used only for C1/C2/C8/D2 thresholds)',
      MEMO,
    ),
    topHighYieldSavingsApy: {
      kind: 'rateRange',
      value: { from: '0.042', to: '0.045' },
      source:
        'Bankrate / Fortune "Top high-yield savings rates, Sept. 10, 2026" ' +
        '(07 Appendix A, "Market reference points")',
      asOf: MEMO,
    },
    nationalAverageSavingsRate: plainRate(
      '0.0038',
      'Bankrate, average savings account interest rate, September 2026 ' +
        '(07 Appendix A, "Market reference points")',
      MEMO,
    ),
    fdicInsuranceLimit: {
      kind: 'money',
      value: { minor: 25_000_000n, currency: 'USD' },
      source:
        '12 U.S.C. 1821(a)(1)(E); 12 CFR 330.1(o) — per depositor, per institution, per ownership category',
      asOf: MEMO,
    },
  },

  // WP 4.2's macro decision (evidence §6): a dated constant here, not a
  // `macro_observations` table. Refreshed by editing this block, which moves
  // the version — the audit trail 07 §7.3 wants.
  macro: {
    cpiUrbanIndex: {
      kind: 'index',
      value: '334.131',
      source:
        'U.S. Bureau of Labor Statistics, CPI-U all items, seasonally adjusted (1982–84 = 100), August 2026; ' +
        'retrieved via FRED series CPIAUCSL on 2026-09-26',
      asOf: '2026-08-01',
      attribution: FRED_ATTRIBUTION,
    },
    cpiUrban12MonthChange: plainRate(
      '0.0335',
      'Computed from BLS CPI-U (FRED CPIAUCSL): 334.131 (2026-08) ÷ 323.291 (2025-08) − 1 = 0.03353, ' +
        'rounded to four places; retrieved 2026-09-26',
      '2026-08-01',
    ),
    treasury10YearYield: {
      kind: 'rate',
      value: '0.0518',
      basis: 'nominal',
      source:
        'Board of Governors of the Federal Reserve System, H.15, 10-year Treasury constant maturity, ' +
        'observation of 2026-09-24; retrieved via FRED series DGS10 on 2026-09-26',
      asOf: '2026-09-24',
      attribution: FRED_ATTRIBUTION,
    },
    treasury3MonthYield: {
      kind: 'rate',
      value: '0.0424',
      basis: 'nominal',
      source:
        'Board of Governors of the Federal Reserve System, H.15, 3-month Treasury constant maturity, ' +
        'observation of 2026-09-24; retrieved via FRED series DGS3MO on 2026-09-26',
      asOf: '2026-09-24',
      attribution: FRED_ATTRIBUTION,
    },
  },

  taxYears: {
    '2026': US_2026,
  },
} satisfies AssumptionsFileInput;
