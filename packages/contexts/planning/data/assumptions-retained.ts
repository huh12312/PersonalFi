// SPDX-License-Identifier: MIT
/**
 * THE FROZEN PREDECESSOR of `./assumptions.ts` — WP 5.5, 05 §2's
 * `GUARDRAIL_REFERENCE_RATE` row. Never edit a byte of `file` below.
 *
 * WP 5.5 moved the guardrail reference rate (07 §5.6's `initial_wr = 0.045 #
 * user-settable`) out of the composition root and into the assumptions file,
 * and decided and recorded REIT's behaviour in the correlation node's note.
 * Both are content, so the file's version — its content hash — moved. A stored
 * override is a delta against a *named* version (WP 4.2), and until now only
 * the current version resolved: every override saved before this change would
 * have refused with `UnknownAssumptionsVersion`, and a holder re-saving from
 * the screen's defaults would have lost them without a word.
 *
 * So the version every override and every run was saved against before WP 5.5
 * is retained here, **frozen**: the exact validated content of
 * `data/assumptions.ts` + `data/us-2026.ts` at `aa76871`, generated from the
 * loaded object (not retyped) and self-contained — it imports nothing, so a
 * later edit to `us-2026.ts` cannot move it. `src/assumptions.ts` re-hashes
 * `file` at load and **refuses to start** if it no longer hashes to `version`:
 * a retained file that drifted would resolve overrides against content they
 * were never computed on, which is the failure this file exists to prevent.
 *
 * What a retained version is for, and what it is not:
 *
 *   * a stored override against it **resolves** (`resolveForUser`,
 *     `resolveOverrides`), so the assumptions screen shows the holder's own
 *     numbers and a re-save carries them onto the current file (PUT re-diffs
 *     against the current version — an explicit act, never a silent rebase);
 *   * a run is **never computed** on it, and a run stored against it reads
 *     back stale — `assumptions_version_retired`, with this version named
 *     (`projection-service.ts`, `readProjection` and `runProjection`).
 *
 * `supplements` carries what this version's runs were computed with but the
 * file itself did not hold: the guardrail reference rate was then the literal
 * `GUARDRAIL_REFERENCE_RATE = '0.045'` in `apps/api/src/domain.ts`. It sits
 * beside `file`, not in it, so the hash is untouched.
 */
import type { AssumptionsFileInput, CitedRateInput } from '../src/assumptions.ts';

export interface RetainedAssumptionsFile {
  /** The content hash `file` must reproduce. Checked at load. */
  readonly version: string;
  /** The day this version stopped being current. */
  readonly retiredOn: string;
  /** Why it was superseded, for the reader of a stale run. */
  readonly supersededBecause: string;
  readonly file: AssumptionsFileInput;
  readonly supplements: { readonly guardrailReferenceRate: CitedRateInput };
}

export const RETAINED_ASSUMPTIONS_FILES: readonly RetainedAssumptionsFile[] = [
  {
    version: 'sha256:d294715e0094c8862c84c278a457656bb6bb68915feb61087d3d7422442ed67f',
    retiredOn: '2026-09-30',
    supersededBecause:
      'WP 5.5: the guardrail reference rate moved into the file (withdrawalPolicy.guardrailReferenceRate) ' +
      "and the correlation node's note records REIT's behaviour",
    supplements: {
      guardrailReferenceRate: {
        kind: 'rate',
        value: '0.045',
        source:
          '07 §5.6 — initial_wr = 0.045 (user-settable); held before WP 5.5 as the literal GUARDRAIL_REFERENCE_RATE in apps/api/src/domain.ts, not in this file',
        asOf: '2026-09-10',
      },
    },
    file: {
      format: 'personalfi.assumptions/1',
      label: 'PersonalFi default assumptions (07 §5.5 and Appendix A, memo of 2026-09-10)',
      capitalMarket: {
        usEquity: {
          expectedReturn: {
            kind: 'rate',
            value: '0.065',
            basis: 'nominal',
            source:
              'PersonalFi default, 07 §5.5 — a blend of the long-run historical ≈10% and Vanguard Capital Markets Model 10-year forecasts as of 2025-12-31, https://corporate.vanguard.com/content/corporatesite/us/en/corp/vemo/vemo-return-forecasts.html (US equity 3.9–5.9%); deliberately conservative',
            asOf: '2025-12-31',
          },
          volatility: {
            kind: 'rate',
            value: '0.17',
            source: 'PersonalFi default, 07 §5.5 — long-run US equity annual standard deviation',
            asOf: '2025-12-31',
          },
        },
        intlDevelopedEquity: {
          expectedReturn: {
            kind: 'rate',
            value: '0.07',
            basis: 'nominal',
            source:
              'PersonalFi default, 07 §5.5 — Vanguard Capital Markets Model 10-year forecasts as of 2025-12-31, https://corporate.vanguard.com/content/corporatesite/us/en/corp/vemo/vemo-return-forecasts.html — non-US developed generally above US in recent runs',
            asOf: '2025-12-31',
          },
          volatility: {
            kind: 'rate',
            value: '0.19',
            source:
              'PersonalFi default, 07 §5.5 — international developed equity annual standard deviation',
            asOf: '2025-12-31',
          },
        },
        emergingEquity: {
          expectedReturn: {
            kind: 'rate',
            value: '0.075',
            basis: 'nominal',
            source:
              'PersonalFi default, 07 §5.5 — historical emerging-market premium over developed',
            asOf: '2026-09-10',
          },
          volatility: {
            kind: 'rate',
            value: '0.24',
            source:
              'PersonalFi default, 07 §5.5 — historical emerging-market volatility, higher than developed',
            asOf: '2026-09-10',
          },
        },
        usAggregateBonds: {
          expectedReturn: {
            kind: 'rate',
            value: '0.045',
            basis: 'nominal',
            source:
              'PersonalFi default, 07 §5.5 — Vanguard Capital Markets Model 10-year forecasts as of 2025-12-31, https://corporate.vanguard.com/content/corporatesite/us/en/corp/vemo/vemo-return-forecasts.html (US aggregate ≈4–5%); consistent with current yields',
            asOf: '2025-12-31',
          },
          volatility: {
            kind: 'rate',
            value: '0.06',
            source: 'PersonalFi default, 07 §5.5 — US aggregate bond annual standard deviation',
            asOf: '2025-12-31',
          },
        },
        tips: {
          expectedReturn: {
            kind: 'rate',
            value: '0.02',
            basis: 'inflation_adjusted',
            source: 'PersonalFi default, 07 §5.5 — current TIPS yields, net of inflation',
            asOf: '2026-09-10',
            note: 'The one expected return in this file stated after inflation (07 §5.5: "2.0% real").',
          },
          volatility: {
            kind: 'rate',
            value: '0.06',
            source: 'PersonalFi default, 07 §5.5 — TIPS annual standard deviation',
            asOf: '2026-09-10',
          },
        },
        cash: {
          expectedReturn: {
            kind: 'rate',
            value: '0.035',
            basis: 'nominal',
            source:
              'PersonalFi default, 07 §5.5 — 3-month T-bill ≈3.93% on 2026-09-10 and trending down (TradingEconomics, https://tradingeconomics.com/united-states/3-month-bill-yield)',
            asOf: '2026-09-10',
          },
          volatility: {
            kind: 'rate',
            value: '0.01',
            source: 'PersonalFi default, 07 §5.5 — T-bill annual standard deviation',
            asOf: '2026-09-10',
          },
        },
        crypto: {
          expectedReturn: {
            kind: 'rate',
            value: '0.065',
            basis: 'nominal',
            source:
              'PersonalFi default, 07 §5.5 and §6.4 — no defensible expected-return estimate exists; set equal to US equity',
            asOf: '2026-09-10',
          },
          volatility: {
            kind: 'rate',
            value: '0.70',
            source: 'PersonalFi default, 07 §5.5 and §6.4 — BTC-weighted crypto volatility',
            asOf: '2026-09-10',
          },
          distribution: {
            kind: 'fact',
            value:
              'Crypto is its own asset class, drawn from a Student-t distribution or a block bootstrap of BTC monthly returns since 2014 — never folded into equity and never lognormal.',
            source: '07 §6.4 (lognormal dramatically understates crypto drawdowns)',
            asOf: '2026-09-10',
          },
          degreesOfFreedom: {
            kind: 'integer',
            value: '3',
            unit: 'degrees_of_freedom',
            source: '07 §6.4 — Student-t(ν=3)',
            asOf: '2026-09-10',
          },
          disclaimer: {
            kind: 'fact',
            value:
              'Crypto has fewer than 15 years of usable price history, all of it within one monetary regime. There is no defensible estimate of its expected return: this plan borrows the US-equity figure and pairs it with crypto’s own, far larger volatility, which is a placeholder and not a forecast. Every plan is also shown with crypto valued at zero; if a plan only works with crypto, that is the finding.',
            source:
              '07 §6.4, mandatory UI treatments 1 and 2 — shown wherever a crypto assumption is shown',
            asOf: '2026-09-10',
          },
        },
        inflation: {
          mean: {
            kind: 'rate',
            value: '0.025',
            basis: 'nominal',
            source:
              'PersonalFi default, 07 §5.5 — long-run target; the 2026 Social Security COLA is 2.8% (SSA press release 2025-10-24)',
            asOf: '2026-09-10',
          },
          volatility: {
            kind: 'rate',
            value: '0.015',
            source: 'PersonalFi default, 07 §5.5 — long-run US CPI annual standard deviation',
            asOf: '2026-09-10',
          },
        },
        wageGrowth: {
          spreadOverInflation: {
            kind: 'rate',
            value: '0.005',
            source:
              'PersonalFi default, 07 §5.5 — long-run growth in wages after inflation; wage growth = inflation + this spread',
            asOf: '2026-09-10',
          },
        },
        equityRiskPremiumCrossCheck: {
          kind: 'rate',
          value: '0.0423',
          source:
            'Damodaran, implied US equity risk premium, January 2026 — https://pages.stern.nyu.edu/~adamodar/New_Home_Page/datafile/histimpl.html (07 §5.5 cross-check row)',
          asOf: '2026-01-01',
          note: 'A cross-check on the US equity default, not an input to any projection.',
        },
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
          'PersonalFi default, 07 §5.5 correlation matrix (annual, after inflation) — a starting point; the bootstrap engine derives correlations empirically. ρ(crypto, US equity) = 0.40 per 07 §6.4.',
        asOf: '2026-09-10',
        note: 'REIT has a correlation row but no expected return or volatility in 07 §5.5, so no REIT allocation can be projected from this file until one is added.',
      },
      socialSecurityStress: {
        fromCalendarYear: {
          kind: 'integer',
          value: '2034',
          unit: 'calendar_year',
          source: '07 §5.8 — the "75% benefit after 2034" stress toggle; a lever, not a forecast',
          asOf: '2026-09-10',
        },
        payableRatio: {
          kind: 'rate',
          value: '0.75',
          source: '07 §5.8 — the "75% benefit after 2034" stress toggle; a lever, not a forecast',
          asOf: '2026-09-10',
        },
      },
      marketReference: {
        treasuryBill3Month: {
          kind: 'rate',
          value: '0.0393',
          source:
            'TradingEconomics, United States 3 Month Bill Yield, https://tradingeconomics.com/united-states/3-month-bill-yield (07 Appendix A, "Market reference points"; used only for C1/C2/C8/D2 thresholds)',
          asOf: '2026-09-10',
        },
        topHighYieldSavingsApy: {
          kind: 'rateRange',
          value: {
            from: '0.042',
            to: '0.045',
          },
          source:
            'Bankrate / Fortune "Top high-yield savings rates, Sept. 10, 2026" (07 Appendix A, "Market reference points")',
          asOf: '2026-09-10',
        },
        nationalAverageSavingsRate: {
          kind: 'rate',
          value: '0.0038',
          source:
            'Bankrate, average savings account interest rate, September 2026 (07 Appendix A, "Market reference points")',
          asOf: '2026-09-10',
        },
        fdicInsuranceLimit: {
          kind: 'money',
          value: {
            minor: 25000000n,
            currency: 'USD',
          },
          source:
            '12 U.S.C. 1821(a)(1)(E); 12 CFR 330.1(o) — per depositor, per institution, per ownership category',
          asOf: '2026-09-10',
        },
      },
      macro: {
        cpiUrbanIndex: {
          kind: 'index',
          value: '334.131',
          source:
            'U.S. Bureau of Labor Statistics, CPI-U all items, seasonally adjusted (1982–84 = 100), August 2026; retrieved via FRED series CPIAUCSL on 2026-09-26',
          asOf: '2026-08-01',
          attribution:
            'This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.',
        },
        cpiUrban12MonthChange: {
          kind: 'rate',
          value: '0.0335',
          source:
            'Computed from BLS CPI-U (FRED CPIAUCSL): 334.131 (2026-08) ÷ 323.291 (2025-08) − 1 = 0.03353, rounded to four places; retrieved 2026-09-26',
          asOf: '2026-08-01',
        },
        treasury10YearYield: {
          kind: 'rate',
          value: '0.0518',
          basis: 'nominal',
          source:
            'Board of Governors of the Federal Reserve System, H.15, 10-year Treasury constant maturity, observation of 2026-09-24; retrieved via FRED series DGS10 on 2026-09-26',
          asOf: '2026-09-24',
          attribution:
            'This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.',
        },
        treasury3MonthYield: {
          kind: 'rate',
          value: '0.0424',
          basis: 'nominal',
          source:
            'Board of Governors of the Federal Reserve System, H.15, 3-month Treasury constant maturity, observation of 2026-09-24; retrieved via FRED series DGS3MO on 2026-09-26',
          asOf: '2026-09-24',
          attribution:
            'This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.',
        },
      },
      taxYears: {
        '2026': {
          retirement: {
            electiveDeferral: {
              kind: 'money',
              value: {
                minor: 2450000n,
                currency: 'USD',
              },
              source:
                'IRS Notice 2025-67 / IR-2025-111, "401(k) limit increases to $24,500 for 2026, IRA limit increases to $7,500", https://www.irs.gov/newsroom/401k-limit-increases-to-24500-for-2026-ira-limit-increases-to-7500 (07 Appendix A, "Retirement contributions")',
              asOf: '2026-01-01',
            },
            catchUpAge50: {
              kind: 'money',
              value: {
                minor: 800000n,
                currency: 'USD',
              },
              source:
                'IRS Notice 2025-67 / IR-2025-111, "401(k) limit increases to $24,500 for 2026, IRA limit increases to $7,500", https://www.irs.gov/newsroom/401k-limit-increases-to-24500-for-2026-ira-limit-increases-to-7500 (07 Appendix A, "Retirement contributions")',
              asOf: '2026-01-01',
            },
            catchUpAge60To63: {
              kind: 'money',
              value: {
                minor: 1125000n,
                currency: 'USD',
              },
              source:
                'IRS Notice 2025-67 / IR-2025-111, "401(k) limit increases to $24,500 for 2026, IRA limit increases to $7,500", https://www.irs.gov/newsroom/401k-limit-increases-to-24500-for-2026-ira-limit-increases-to-7500 (07 Appendix A, "Retirement contributions")',
              asOf: '2026-01-01',
            },
            iraContribution: {
              kind: 'money',
              value: {
                minor: 750000n,
                currency: 'USD',
              },
              source:
                'IRS Notice 2025-67 / IR-2025-111, "401(k) limit increases to $24,500 for 2026, IRA limit increases to $7,500", https://www.irs.gov/newsroom/401k-limit-increases-to-24500-for-2026-ira-limit-increases-to-7500 (07 Appendix A, "Retirement contributions")',
              asOf: '2026-01-01',
            },
            iraCatchUpAge50: {
              kind: 'money',
              value: {
                minor: 110000n,
                currency: 'USD',
              },
              source:
                'IRS Notice 2025-67 / IR-2025-111, "401(k) limit increases to $24,500 for 2026, IRA limit increases to $7,500", https://www.irs.gov/newsroom/401k-limit-increases-to-24500-for-2026-ira-limit-increases-to-7500 (07 Appendix A, "Retirement contributions")',
              asOf: '2026-01-01',
            },
            rothIraPhaseOut: {
              singleOrHoh: {
                kind: 'moneyRange',
                value: {
                  from: {
                    minor: 15300000n,
                    currency: 'USD',
                  },
                  to: {
                    minor: 16800000n,
                    currency: 'USD',
                  },
                },
                source:
                  'IRS Notice 2025-67 / IR-2025-111, "401(k) limit increases to $24,500 for 2026, IRA limit increases to $7,500", https://www.irs.gov/newsroom/401k-limit-increases-to-24500-for-2026-ira-limit-increases-to-7500 (07 Appendix A, "Retirement contributions")',
                asOf: '2026-01-01',
              },
              mfj: {
                kind: 'moneyRange',
                value: {
                  from: {
                    minor: 24200000n,
                    currency: 'USD',
                  },
                  to: {
                    minor: 25200000n,
                    currency: 'USD',
                  },
                },
                source:
                  'IRS Notice 2025-67 / IR-2025-111, "401(k) limit increases to $24,500 for 2026, IRA limit increases to $7,500", https://www.irs.gov/newsroom/401k-limit-increases-to-24500-for-2026-ira-limit-increases-to-7500 (07 Appendix A, "Retirement contributions")',
                asOf: '2026-01-01',
              },
              mfs: {
                kind: 'moneyRange',
                value: {
                  from: {
                    minor: 0n,
                    currency: 'USD',
                  },
                  to: {
                    minor: 1000000n,
                    currency: 'USD',
                  },
                },
                source:
                  'IRS Notice 2025-67 / IR-2025-111, "401(k) limit increases to $24,500 for 2026, IRA limit increases to $7,500", https://www.irs.gov/newsroom/401k-limit-increases-to-24500-for-2026-ira-limit-increases-to-7500 (07 Appendix A, "Retirement contributions")',
                asOf: '2026-01-01',
              },
            },
            traditionalIraDeductionPhaseOut: {
              singleCovered: {
                kind: 'moneyRange',
                value: {
                  from: {
                    minor: 8100000n,
                    currency: 'USD',
                  },
                  to: {
                    minor: 9100000n,
                    currency: 'USD',
                  },
                },
                source:
                  'IRS Notice 2025-67 / IR-2025-111, "401(k) limit increases to $24,500 for 2026, IRA limit increases to $7,500", https://www.irs.gov/newsroom/401k-limit-increases-to-24500-for-2026-ira-limit-increases-to-7500 (07 Appendix A, "Retirement contributions")',
                asOf: '2026-01-01',
              },
              mfjCovered: {
                kind: 'moneyRange',
                value: {
                  from: {
                    minor: 12900000n,
                    currency: 'USD',
                  },
                  to: {
                    minor: 14900000n,
                    currency: 'USD',
                  },
                },
                source:
                  'IRS Notice 2025-67 / IR-2025-111, "401(k) limit increases to $24,500 for 2026, IRA limit increases to $7,500", https://www.irs.gov/newsroom/401k-limit-increases-to-24500-for-2026-ira-limit-increases-to-7500 (07 Appendix A, "Retirement contributions")',
                asOf: '2026-01-01',
              },
              spouseNotCovered: {
                kind: 'moneyRange',
                value: {
                  from: {
                    minor: 24200000n,
                    currency: 'USD',
                  },
                  to: {
                    minor: 25200000n,
                    currency: 'USD',
                  },
                },
                source:
                  'IRS Notice 2025-67 / IR-2025-111, "401(k) limit increases to $24,500 for 2026, IRA limit increases to $7,500", https://www.irs.gov/newsroom/401k-limit-increases-to-24500-for-2026-ira-limit-increases-to-7500 (07 Appendix A, "Retirement contributions")',
                asOf: '2026-01-01',
              },
            },
            saversCreditAgiLimit: {
              mfj: {
                kind: 'money',
                value: {
                  minor: 8050000n,
                  currency: 'USD',
                },
                source:
                  'IRS Notice 2025-67 / IR-2025-111, "401(k) limit increases to $24,500 for 2026, IRA limit increases to $7,500", https://www.irs.gov/newsroom/401k-limit-increases-to-24500-for-2026-ira-limit-increases-to-7500 (07 Appendix A, "Retirement contributions")',
                asOf: '2026-01-01',
              },
              hoh: {
                kind: 'money',
                value: {
                  minor: 6037500n,
                  currency: 'USD',
                },
                source:
                  'IRS Notice 2025-67 / IR-2025-111, "401(k) limit increases to $24,500 for 2026, IRA limit increases to $7,500", https://www.irs.gov/newsroom/401k-limit-increases-to-24500-for-2026-ira-limit-increases-to-7500 (07 Appendix A, "Retirement contributions")',
                asOf: '2026-01-01',
              },
              single: {
                kind: 'money',
                value: {
                  minor: 4025000n,
                  currency: 'USD',
                },
                source:
                  'IRS Notice 2025-67 / IR-2025-111, "401(k) limit increases to $24,500 for 2026, IRA limit increases to $7,500", https://www.irs.gov/newsroom/401k-limit-increases-to-24500-for-2026-ira-limit-increases-to-7500 (07 Appendix A, "Retirement contributions")',
                asOf: '2026-01-01',
              },
            },
            simpleDeferral: {
              standard: {
                kind: 'money',
                value: {
                  minor: 1700000n,
                  currency: 'USD',
                },
                source:
                  'IRS Notice 2025-67 / IR-2025-111, "401(k) limit increases to $24,500 for 2026, IRA limit increases to $7,500", https://www.irs.gov/newsroom/401k-limit-increases-to-24500-for-2026-ira-limit-increases-to-7500 (07 Appendix A, "Retirement contributions")',
                asOf: '2026-01-01',
              },
              applicablePlans: {
                kind: 'money',
                value: {
                  minor: 1810000n,
                  currency: 'USD',
                },
                source:
                  'IRS Notice 2025-67 / IR-2025-111, "401(k) limit increases to $24,500 for 2026, IRA limit increases to $7,500", https://www.irs.gov/newsroom/401k-limit-increases-to-24500-for-2026-ira-limit-increases-to-7500 (07 Appendix A, "Retirement contributions")',
                asOf: '2026-01-01',
              },
            },
            mandatoryRothCatchUpWageThreshold: {
              kind: 'money',
              value: {
                minor: 15000000n,
                currency: 'USD',
              },
              source:
                'IRS Notice 2025-67 / IR-2025-111, "401(k) limit increases to $24,500 for 2026, IRA limit increases to $7,500", https://www.irs.gov/newsroom/401k-limit-increases-to-24500-for-2026-ira-limit-increases-to-7500 (07 Appendix A, "Retirement contributions"); IRC §414(v)(7)(A) as indexed',
              asOf: '2026-01-01',
              note: 'Catch-up contributions must be Roth when prior-year FICA wages from that employer exceeded this.',
            },
          },
          incomeTax: {
            standardDeduction: {
              single: {
                kind: 'money',
                value: {
                  minor: 1610000n,
                  currency: 'USD',
                },
                source:
                  'IRS Rev. Proc. 2025-32 §3.14(1), https://www.irs.gov/pub/irs-drop/rp-25-32.pdf (07 Appendix A, "Income tax")',
                asOf: '2026-01-01',
              },
              mfj: {
                kind: 'money',
                value: {
                  minor: 3220000n,
                  currency: 'USD',
                },
                source:
                  'IRS Rev. Proc. 2025-32 §3.14(1), https://www.irs.gov/pub/irs-drop/rp-25-32.pdf (07 Appendix A, "Income tax")',
                asOf: '2026-01-01',
              },
              mfs: {
                kind: 'money',
                value: {
                  minor: 1610000n,
                  currency: 'USD',
                },
                source:
                  'IRS Rev. Proc. 2025-32 §3.14(1), https://www.irs.gov/pub/irs-drop/rp-25-32.pdf (07 Appendix A, "Income tax")',
                asOf: '2026-01-01',
              },
              hoh: {
                kind: 'money',
                value: {
                  minor: 2415000n,
                  currency: 'USD',
                },
                source:
                  'IRS Rev. Proc. 2025-32 §3.14(1), https://www.irs.gov/pub/irs-drop/rp-25-32.pdf (07 Appendix A, "Income tax")',
                asOf: '2026-01-01',
              },
            },
            brackets: {
              single: {
                kind: 'brackets',
                value: [
                  {
                    over: {
                      minor: 0n,
                      currency: 'USD',
                    },
                    rate: '0.10',
                  },
                  {
                    over: {
                      minor: 1240000n,
                      currency: 'USD',
                    },
                    rate: '0.12',
                  },
                  {
                    over: {
                      minor: 5040000n,
                      currency: 'USD',
                    },
                    rate: '0.22',
                  },
                  {
                    over: {
                      minor: 10570000n,
                      currency: 'USD',
                    },
                    rate: '0.24',
                  },
                  {
                    over: {
                      minor: 20177500n,
                      currency: 'USD',
                    },
                    rate: '0.32',
                  },
                  {
                    over: {
                      minor: 25622500n,
                      currency: 'USD',
                    },
                    rate: '0.35',
                  },
                  {
                    over: {
                      minor: 64060000n,
                      currency: 'USD',
                    },
                    rate: '0.37',
                  },
                ],
                source:
                  'IRS Rev. Proc. 2025-32 §3.01 Table 3 (§1(j)(2)(C)), https://www.irs.gov/pub/irs-drop/rp-25-32.pdf (07 Appendix A, "Income tax")',
                asOf: '2026-01-01',
              },
              mfj: {
                kind: 'brackets',
                value: [
                  {
                    over: {
                      minor: 0n,
                      currency: 'USD',
                    },
                    rate: '0.10',
                  },
                  {
                    over: {
                      minor: 2480000n,
                      currency: 'USD',
                    },
                    rate: '0.12',
                  },
                  {
                    over: {
                      minor: 10080000n,
                      currency: 'USD',
                    },
                    rate: '0.22',
                  },
                  {
                    over: {
                      minor: 21140000n,
                      currency: 'USD',
                    },
                    rate: '0.24',
                  },
                  {
                    over: {
                      minor: 40355000n,
                      currency: 'USD',
                    },
                    rate: '0.32',
                  },
                  {
                    over: {
                      minor: 51245000n,
                      currency: 'USD',
                    },
                    rate: '0.35',
                  },
                  {
                    over: {
                      minor: 76870000n,
                      currency: 'USD',
                    },
                    rate: '0.37',
                  },
                ],
                source:
                  'IRS Rev. Proc. 2025-32 §3.01 Table 1 (§1(j)(2)(A)), https://www.irs.gov/pub/irs-drop/rp-25-32.pdf (07 Appendix A, "Income tax")',
                asOf: '2026-01-01',
                note: 'Appendix A says only "approximately double the single thresholds"; these are the published figures.',
              },
              mfs: {
                kind: 'brackets',
                value: [
                  {
                    over: {
                      minor: 0n,
                      currency: 'USD',
                    },
                    rate: '0.10',
                  },
                  {
                    over: {
                      minor: 1240000n,
                      currency: 'USD',
                    },
                    rate: '0.12',
                  },
                  {
                    over: {
                      minor: 5040000n,
                      currency: 'USD',
                    },
                    rate: '0.22',
                  },
                  {
                    over: {
                      minor: 10570000n,
                      currency: 'USD',
                    },
                    rate: '0.24',
                  },
                  {
                    over: {
                      minor: 20177500n,
                      currency: 'USD',
                    },
                    rate: '0.32',
                  },
                  {
                    over: {
                      minor: 25622500n,
                      currency: 'USD',
                    },
                    rate: '0.35',
                  },
                  {
                    over: {
                      minor: 38435000n,
                      currency: 'USD',
                    },
                    rate: '0.37',
                  },
                ],
                source:
                  'IRS Rev. Proc. 2025-32 §3.01 Table 4 (§1(j)(2)(D)), https://www.irs.gov/pub/irs-drop/rp-25-32.pdf (07 Appendix A, "Income tax")',
                asOf: '2026-01-01',
              },
              hoh: {
                kind: 'brackets',
                value: [
                  {
                    over: {
                      minor: 0n,
                      currency: 'USD',
                    },
                    rate: '0.10',
                  },
                  {
                    over: {
                      minor: 1770000n,
                      currency: 'USD',
                    },
                    rate: '0.12',
                  },
                  {
                    over: {
                      minor: 6745000n,
                      currency: 'USD',
                    },
                    rate: '0.22',
                  },
                  {
                    over: {
                      minor: 10570000n,
                      currency: 'USD',
                    },
                    rate: '0.24',
                  },
                  {
                    over: {
                      minor: 20175000n,
                      currency: 'USD',
                    },
                    rate: '0.32',
                  },
                  {
                    over: {
                      minor: 25620000n,
                      currency: 'USD',
                    },
                    rate: '0.35',
                  },
                  {
                    over: {
                      minor: 64060000n,
                      currency: 'USD',
                    },
                    rate: '0.37',
                  },
                ],
                source:
                  'IRS Rev. Proc. 2025-32 §3.01 Table 2 (§1(j)(2)(B)), https://www.irs.gov/pub/irs-drop/rp-25-32.pdf (07 Appendix A, "Income tax")',
                asOf: '2026-01-01',
              },
            },
            longTermCapitalGains: {
              single: {
                kind: 'brackets',
                value: [
                  {
                    over: {
                      minor: 0n,
                      currency: 'USD',
                    },
                    rate: '0',
                  },
                  {
                    over: {
                      minor: 4945000n,
                      currency: 'USD',
                    },
                    rate: '0.15',
                  },
                  {
                    over: {
                      minor: 54550000n,
                      currency: 'USD',
                    },
                    rate: '0.20',
                  },
                ],
                source:
                  'IRS Rev. Proc. 2025-32 §3.03 (§1(h), §1(j)(5)(B)) "All Other Individuals", https://www.irs.gov/pub/irs-drop/rp-25-32.pdf (07 Appendix A, "Income tax")',
                asOf: '2026-01-01',
                note: 'Appendix A lists $48,350 / $533,400 (single) and $96,700 / $600,050 (MFJ); those are the 2025 figures (Rev. Proc. 2024-40). Rev. Proc. 2025-32 §3.03 is the 2026 table and is what this node carries.',
              },
              mfj: {
                kind: 'brackets',
                value: [
                  {
                    over: {
                      minor: 0n,
                      currency: 'USD',
                    },
                    rate: '0',
                  },
                  {
                    over: {
                      minor: 9890000n,
                      currency: 'USD',
                    },
                    rate: '0.15',
                  },
                  {
                    over: {
                      minor: 61370000n,
                      currency: 'USD',
                    },
                    rate: '0.20',
                  },
                ],
                source:
                  'IRS Rev. Proc. 2025-32 §3.03 (§1(h), §1(j)(5)(B)) "Married Individuals Filing Joint Returns", https://www.irs.gov/pub/irs-drop/rp-25-32.pdf (07 Appendix A, "Income tax")',
                asOf: '2026-01-01',
                note: 'Appendix A lists $48,350 / $533,400 (single) and $96,700 / $600,050 (MFJ); those are the 2025 figures (Rev. Proc. 2024-40). Rev. Proc. 2025-32 §3.03 is the 2026 table and is what this node carries.',
              },
              mfs: {
                kind: 'brackets',
                value: [
                  {
                    over: {
                      minor: 0n,
                      currency: 'USD',
                    },
                    rate: '0',
                  },
                  {
                    over: {
                      minor: 4945000n,
                      currency: 'USD',
                    },
                    rate: '0.15',
                  },
                  {
                    over: {
                      minor: 30685000n,
                      currency: 'USD',
                    },
                    rate: '0.20',
                  },
                ],
                source:
                  'IRS Rev. Proc. 2025-32 §3.03 (§1(h), §1(j)(5)(B)) "Married Individuals Filing Separate Returns", https://www.irs.gov/pub/irs-drop/rp-25-32.pdf (07 Appendix A, "Income tax")',
                asOf: '2026-01-01',
              },
              hoh: {
                kind: 'brackets',
                value: [
                  {
                    over: {
                      minor: 0n,
                      currency: 'USD',
                    },
                    rate: '0',
                  },
                  {
                    over: {
                      minor: 6620000n,
                      currency: 'USD',
                    },
                    rate: '0.15',
                  },
                  {
                    over: {
                      minor: 57960000n,
                      currency: 'USD',
                    },
                    rate: '0.20',
                  },
                ],
                source:
                  'IRS Rev. Proc. 2025-32 §3.03 (§1(h), §1(j)(5)(B)) "Heads of Household", https://www.irs.gov/pub/irs-drop/rp-25-32.pdf (07 Appendix A, "Income tax")',
                asOf: '2026-01-01',
              },
            },
            netInvestmentIncomeTax: {
              rate: {
                kind: 'rate',
                value: '0.038',
                source: 'IRC §1411(a)(1) (07 Appendix A, "Income tax": NIIT 3.8%)',
                asOf: '2026-01-01',
              },
              threshold: {
                single: {
                  kind: 'money',
                  value: {
                    minor: 20000000n,
                    currency: 'USD',
                  },
                  source: 'IRC §1411(b)(3) — not indexed (07 Appendix A)',
                  asOf: '2026-01-01',
                },
                mfj: {
                  kind: 'money',
                  value: {
                    minor: 25000000n,
                    currency: 'USD',
                  },
                  source: 'IRC §1411(b)(1) — not indexed (07 Appendix A)',
                  asOf: '2026-01-01',
                },
                mfs: {
                  kind: 'money',
                  value: {
                    minor: 12500000n,
                    currency: 'USD',
                  },
                  source: 'IRC §1411(b)(2) — not indexed',
                  asOf: '2026-01-01',
                },
                hoh: {
                  kind: 'money',
                  value: {
                    minor: 20000000n,
                    currency: 'USD',
                  },
                  source: 'IRC §1411(b)(3) — not indexed',
                  asOf: '2026-01-01',
                },
              },
            },
            capitalLossOrdinaryOffset: {
              standard: {
                kind: 'money',
                value: {
                  minor: 300000n,
                  currency: 'USD',
                },
                source:
                  'IRC §1211(b)(1) (07 Appendix A: "$3,000/yr, remainder carries forward", §1212(b))',
                asOf: '2026-01-01',
              },
              mfs: {
                kind: 'money',
                value: {
                  minor: 150000n,
                  currency: 'USD',
                },
                source: 'IRC §1211(b)(1), married filing separately',
                asOf: '2026-01-01',
              },
            },
          },
          hsa: {
            selfOnly: {
              kind: 'money',
              value: {
                minor: 440000n,
                currency: 'USD',
              },
              source:
                'IRS Rev. Proc. 2025-19 §2.01(1) (IRC §223(b)(2) as adjusted), https://www.irs.gov/pub/irs-drop/rp-25-19.pdf (07 Appendix A, "HSA")',
              asOf: '2026-01-01',
            },
            family: {
              kind: 'money',
              value: {
                minor: 875000n,
                currency: 'USD',
              },
              source:
                'IRS Rev. Proc. 2025-19 §2.01(1) (IRC §223(b)(2) as adjusted), https://www.irs.gov/pub/irs-drop/rp-25-19.pdf (07 Appendix A, "HSA")',
              asOf: '2026-01-01',
            },
            catchUpAge55: {
              kind: 'money',
              value: {
                minor: 100000n,
                currency: 'USD',
              },
              source: 'IRC §223(b)(3)(B) — statutory, not indexed (07 Appendix A, "HSA")',
              asOf: '2026-01-01',
            },
          },
          socialSecurity: {
            cola: {
              kind: 'rate',
              value: '0.028',
              source:
                'Social Security Administration, press release 2025-10-24, "Social Security Announces 2.8 Percent Benefit Increase for 2026", https://www.ssa.gov/news/en/press/releases/2025-10-24.html (07 Appendix A, "Social Security (2026)"; 07 §5.8)',
              asOf: '2026-01-01',
            },
            taxableWageBase: {
              kind: 'money',
              value: {
                minor: 18450000n,
                currency: 'USD',
              },
              source:
                'Social Security Administration, Office of the Chief Actuary, contribution and benefit base, https://www.ssa.gov/oact/cola/cbb.html (07 Appendix A, "Social Security (2026)"; 07 §5.8)',
              asOf: '2026-01-01',
            },
            bendPoints: {
              first: {
                kind: 'money',
                value: {
                  minor: 128600n,
                  currency: 'USD',
                },
                source:
                  'Social Security Administration, Office of the Chief Actuary, PIA bend points, https://www.ssa.gov/oact/cola/bendpoints.html (07 Appendix A, "Social Security (2026)"; 07 §5.8)',
                asOf: '2026-01-01',
                note: 'Monthly AIME dollars, for workers first eligible (age 62) in 2026.',
              },
              second: {
                kind: 'money',
                value: {
                  minor: 774900n,
                  currency: 'USD',
                },
                source:
                  'Social Security Administration, Office of the Chief Actuary, PIA bend points, https://www.ssa.gov/oact/cola/bendpoints.html (07 Appendix A, "Social Security (2026)"; 07 §5.8)',
                asOf: '2026-01-01',
                note: 'Monthly AIME dollars, for workers first eligible (age 62) in 2026.',
              },
            },
            piaFactors: {
              belowFirst: {
                kind: 'rate',
                value: '0.90',
                source: 'Social Security Act §215(a)(1)(A)(i), 42 U.S.C. 415 (07 §5.8 step 3)',
                asOf: '2026-01-01',
              },
              betweenBendPoints: {
                kind: 'rate',
                value: '0.32',
                source: 'Social Security Act §215(a)(1)(A)(ii), 42 U.S.C. 415 (07 §5.8 step 3)',
                asOf: '2026-01-01',
              },
              aboveSecond: {
                kind: 'rate',
                value: '0.15',
                source: 'Social Security Act §215(a)(1)(A)(iii), 42 U.S.C. 415 (07 §5.8 step 3)',
                asOf: '2026-01-01',
              },
            },
            fullRetirementAge: {
              kind: 'ageSchedule',
              value: [
                {
                  bornFrom: '1960',
                  bornThrough: null,
                  age: '67',
                },
              ],
              source:
                'Social Security Act §216(l)(1), 42 U.S.C. 416(l) (07 Appendix A: "Full retirement age, born 1960+ — 67")',
              asOf: '2026-01-01',
              note: 'Only the 1960+ cohort is encoded. An earlier birth year has no row and a lookup must refuse it.',
            },
            earlyReductionPerMonth: {
              first36Months: {
                kind: 'fraction',
                value: {
                  numerator: '5',
                  denominator: '900',
                },
                source:
                  '20 CFR 404.410(a) — 5/9 of 1% per month for the first 36 months before FRA (07 §5.8 step 5)',
                asOf: '2026-01-01',
              },
              beyond36Months: {
                kind: 'fraction',
                value: {
                  numerator: '5',
                  denominator: '1200',
                },
                source:
                  '20 CFR 404.410(a) — 5/12 of 1% per month beyond 36 months (07 §5.8 step 5)',
                asOf: '2026-01-01',
              },
            },
            delayedRetirementCreditPerYear: {
              kind: 'rate',
              value: '0.08',
              source:
                '20 CFR 404.313(a), born 1943 or later — 2/3 of 1% per month (07 Appendix A: "8%/yr to age 70")',
              asOf: '2026-01-01',
            },
            delayedRetirementCreditEndsAtAge: {
              kind: 'integer',
              value: '70',
              unit: 'age_years',
              source: '20 CFR 404.313(a) (07 Appendix A: "8%/yr to age 70")',
              asOf: '2026-01-01',
            },
          },
          rmd: {
            startAge: {
              kind: 'ageSchedule',
              value: [
                {
                  bornFrom: '1951',
                  bornThrough: '1959',
                  age: '73',
                },
                {
                  bornFrom: '1960',
                  bornThrough: null,
                  age: '75',
                },
              ],
              source:
                'SECURE 2.0 Act §107, IRC §401(a)(9)(C)(v) (07 Appendix A, "RMDs (SECURE 2.0)"; CRS IF12750, https://www.congress.gov/crs-product/IF12750)',
              asOf: '2026-01-01',
              note: 'Birth years before 1951 are already past their start age and are not encoded.',
            },
            firstDistributionDeadline: {
              kind: 'fact',
              value:
                'The first RMD is due by April 1 of the year after the year the owner reaches RMD age; every later RMD by December 31. Deferring the first to April 1 puts two RMDs in that calendar year.',
              source:
                'IRC §401(a)(9)(C)(i); Treas. Reg. §1.401(a)(9)-2 (07 Appendix A, "RMDs (SECURE 2.0)"; CRS IF12750, https://www.congress.gov/crs-product/IF12750)',
              asOf: '2026-01-01',
            },
            missedDistributionExcise: {
              kind: 'rate',
              value: '0.25',
              source:
                'SECURE 2.0 Act §302, IRC §4974(a) (07 Appendix A, "RMDs (SECURE 2.0)"; CRS IF12750, https://www.congress.gov/crs-product/IF12750)',
              asOf: '2026-01-01',
            },
            missedDistributionExciseIfCorrected: {
              kind: 'rate',
              value: '0.10',
              source:
                'SECURE 2.0 Act §302, IRC §4974(e) (07 Appendix A, "RMDs (SECURE 2.0)"; CRS IF12750, https://www.congress.gov/crs-product/IF12750)',
              asOf: '2026-01-01',
            },
            designatedRothAccounts: {
              kind: 'fact',
              value:
                'Roth 401(k) and 403(b) accounts have no required minimum distributions during the owner’s life; a Roth IRA never had them for the owner.',
              source:
                'SECURE 2.0 Act §325, IRC §402A(d)(5) (07 Appendix A, "RMDs (SECURE 2.0)"; CRS IF12750, https://www.congress.gov/crs-product/IF12750)',
              asOf: '2026-01-01',
              effective: '2024-01-01',
            },
          },
          digitalAssets: {
            costBasisTracking: {
              kind: 'fact',
              value:
                'Cost basis is tracked per wallet or account; a safe harbor allocates legacy universal basis.',
              source: 'IRS Rev. Proc. 2024-28 (07 Appendix A, "Digital assets")',
              asOf: '2026-09-10',
              effective: '2025-01-01',
            },
            form1099Da: {
              kind: 'fact',
              value:
                'Brokers report gross proceeds for 2025 transactions, and gross proceeds plus adjusted basis for 2026 transactions.',
              source:
                'Treas. Reg. §1.6045-1 as amended by T.D. 10000 (07 Appendix A, "Digital assets")',
              asOf: '2026-09-10',
              effective: '2026-01-01',
            },
            washSale: {
              kind: 'fact',
              value:
                'The §1091 wash-sale rule does not apply to digital assets; legislation to extend it was proposed in 2026.',
              source:
                'IRC §1091 ("stock or securities"); 07 Appendix A, "Digital assets" (CNBC 2026-07-28)',
              asOf: '2026-09-10',
            },
            stakingRewards: {
              kind: 'fact',
              value:
                'Staking rewards are ordinary income at fair market value when the taxpayer gains dominion and control.',
              source: 'IRS Rev. Rul. 2023-14 (07 Appendix A, "Digital assets"; 07 §6.5)',
              asOf: '2026-09-10',
            },
          },
        },
      },
    },
  },
];
