// SPDX-License-Identifier: MIT
/**
 * US federal parameters for tax year 2026 — 07 Appendix A, transcribed from the
 * primary sources and cited number by number.
 *
 * Data, not code. This module imports nothing at runtime (the one import is
 * `import type`, erased before execution), so a copy of it can be loaded from
 * anywhere — which is what the content-hash test does to prove a comment is not
 * a value. It is validated, frozen and hashed by `src/assumptions.ts`, and read
 * through `taxYear(assumptions, 2026)` and nothing else.
 *
 * `asOf` for law is `2026-01-01`: the date these figures are in force from for
 * tax year 2026, not the date the notice was published. The publication is in
 * `source`.
 *
 * Where Appendix A and the primary source disagree, the primary source wins and
 * the node's `note` says so — see `incomeTax.longTermCapitalGains`, where
 * Appendix A carries the 2025 breakpoints.
 */
import type { UsTaxYearInput } from '../src/assumptions.ts';

const IN_FORCE = '2026-01-01';

const NOTICE_2025_67 =
  'IRS Notice 2025-67 / IR-2025-111, "401(k) limit increases to $24,500 for 2026, IRA limit ' +
  'increases to $7,500", https://www.irs.gov/newsroom/401k-limit-increases-to-24500-for-2026-ira-limit-increases-to-7500 ' +
  '(07 Appendix A, "Retirement contributions")';
const REV_PROC_2025_32 = (section: string): string =>
  `IRS Rev. Proc. 2025-32 ${section}, https://www.irs.gov/pub/irs-drop/rp-25-32.pdf ` +
  '(07 Appendix A, "Income tax")';
const REV_PROC_2025_19 =
  'IRS Rev. Proc. 2025-19 §2.01(1) (IRC §223(b)(2) as adjusted), ' +
  'https://www.irs.gov/pub/irs-drop/rp-25-19.pdf (07 Appendix A, "HSA")';
const SSA_2026 = (what: string): string =>
  `Social Security Administration, ${what} (07 Appendix A, "Social Security (2026)"; 07 §5.8)`;
const SECURE_2 = (what: string): string =>
  `${what} (07 Appendix A, "RMDs (SECURE 2.0)"; CRS IF12750, https://www.congress.gov/crs-product/IF12750)`;

/** Whole US dollars → a `Money` literal. Exact: `bigint`, never a float. */
const usd = (whole: bigint) => ({ minor: whole * 100n, currency: 'USD' as const });

const money = (whole: bigint, source: string, asOf: string, note?: string) => ({
  kind: 'money' as const,
  value: usd(whole),
  source,
  asOf,
  ...(note === undefined ? {} : { note }),
});

const range = (from: bigint, to: bigint, source: string, asOf: string) => ({
  kind: 'moneyRange' as const,
  value: { from: usd(from), to: usd(to) },
  source,
  asOf,
});

const rate = (value: string, source: string, asOf: string, note?: string) => ({
  kind: 'rate' as const,
  value,
  source,
  asOf,
  ...(note === undefined ? {} : { note }),
});

const fact = (value: string, source: string, asOf: string, effective?: string) => ({
  kind: 'fact' as const,
  value,
  source,
  asOf,
  ...(effective === undefined ? {} : { effective }),
});

/** One bracket schedule: `[over, rate]` pairs, the rate applying to income over `over`. */
const brackets = (
  rows: readonly (readonly [bigint, string])[],
  source: string,
  asOf: string,
  note?: string,
) => ({
  kind: 'brackets' as const,
  value: rows.map(([over, bracketRate]) => ({ over: usd(over), rate: bracketRate })),
  source,
  asOf,
  ...(note === undefined ? {} : { note }),
});

const LTCG_NOTE =
  'Appendix A lists $48,350 / $533,400 (single) and $96,700 / $600,050 (MFJ); those are the 2025 ' +
  'figures (Rev. Proc. 2024-40). Rev. Proc. 2025-32 §3.03 is the 2026 table and is what this node carries.';

export const US_2026 = {
  retirement: {
    electiveDeferral: money(24_500n, NOTICE_2025_67, IN_FORCE),
    catchUpAge50: money(8_000n, NOTICE_2025_67, IN_FORCE),
    catchUpAge60To63: money(11_250n, NOTICE_2025_67, IN_FORCE),
    iraContribution: money(7_500n, NOTICE_2025_67, IN_FORCE),
    iraCatchUpAge50: money(1_100n, NOTICE_2025_67, IN_FORCE),
    rothIraPhaseOut: {
      singleOrHoh: range(153_000n, 168_000n, NOTICE_2025_67, IN_FORCE),
      mfj: range(242_000n, 252_000n, NOTICE_2025_67, IN_FORCE),
      mfs: range(0n, 10_000n, NOTICE_2025_67, IN_FORCE),
    },
    traditionalIraDeductionPhaseOut: {
      singleCovered: range(81_000n, 91_000n, NOTICE_2025_67, IN_FORCE),
      mfjCovered: range(129_000n, 149_000n, NOTICE_2025_67, IN_FORCE),
      spouseNotCovered: range(242_000n, 252_000n, NOTICE_2025_67, IN_FORCE),
    },
    saversCreditAgiLimit: {
      mfj: money(80_500n, NOTICE_2025_67, IN_FORCE),
      hoh: money(60_375n, NOTICE_2025_67, IN_FORCE),
      single: money(40_250n, NOTICE_2025_67, IN_FORCE),
    },
    simpleDeferral: {
      standard: money(17_000n, NOTICE_2025_67, IN_FORCE),
      applicablePlans: money(18_100n, NOTICE_2025_67, IN_FORCE),
    },
    mandatoryRothCatchUpWageThreshold: money(
      150_000n,
      `${NOTICE_2025_67}; IRC §414(v)(7)(A) as indexed`,
      IN_FORCE,
      'Catch-up contributions must be Roth when prior-year FICA wages from that employer exceeded this.',
    ),
  },

  incomeTax: {
    standardDeduction: {
      single: money(16_100n, REV_PROC_2025_32('§3.14(1)'), IN_FORCE),
      mfj: money(32_200n, REV_PROC_2025_32('§3.14(1)'), IN_FORCE),
      mfs: money(16_100n, REV_PROC_2025_32('§3.14(1)'), IN_FORCE),
      hoh: money(24_150n, REV_PROC_2025_32('§3.14(1)'), IN_FORCE),
    },
    brackets: {
      single: brackets(
        [
          [0n, '0.10'],
          [12_400n, '0.12'],
          [50_400n, '0.22'],
          [105_700n, '0.24'],
          [201_775n, '0.32'],
          [256_225n, '0.35'],
          [640_600n, '0.37'],
        ],
        REV_PROC_2025_32('§3.01 Table 3 (§1(j)(2)(C))'),
        IN_FORCE,
      ),
      mfj: brackets(
        [
          [0n, '0.10'],
          [24_800n, '0.12'],
          [100_800n, '0.22'],
          [211_400n, '0.24'],
          [403_550n, '0.32'],
          [512_450n, '0.35'],
          [768_700n, '0.37'],
        ],
        REV_PROC_2025_32('§3.01 Table 1 (§1(j)(2)(A))'),
        IN_FORCE,
        'Appendix A says only "approximately double the single thresholds"; these are the published figures.',
      ),
      mfs: brackets(
        [
          [0n, '0.10'],
          [12_400n, '0.12'],
          [50_400n, '0.22'],
          [105_700n, '0.24'],
          [201_775n, '0.32'],
          [256_225n, '0.35'],
          [384_350n, '0.37'],
        ],
        REV_PROC_2025_32('§3.01 Table 4 (§1(j)(2)(D))'),
        IN_FORCE,
      ),
      hoh: brackets(
        [
          [0n, '0.10'],
          [17_700n, '0.12'],
          [67_450n, '0.22'],
          [105_700n, '0.24'],
          [201_750n, '0.32'],
          [256_200n, '0.35'],
          [640_600n, '0.37'],
        ],
        REV_PROC_2025_32('§3.01 Table 2 (§1(j)(2)(B))'),
        IN_FORCE,
      ),
    },
    longTermCapitalGains: {
      single: brackets(
        [
          [0n, '0'],
          [49_450n, '0.15'],
          [545_500n, '0.20'],
        ],
        REV_PROC_2025_32('§3.03 (§1(h), §1(j)(5)(B)) "All Other Individuals"'),
        IN_FORCE,
        LTCG_NOTE,
      ),
      mfj: brackets(
        [
          [0n, '0'],
          [98_900n, '0.15'],
          [613_700n, '0.20'],
        ],
        REV_PROC_2025_32('§3.03 (§1(h), §1(j)(5)(B)) "Married Individuals Filing Joint Returns"'),
        IN_FORCE,
        LTCG_NOTE,
      ),
      mfs: brackets(
        [
          [0n, '0'],
          [49_450n, '0.15'],
          [306_850n, '0.20'],
        ],
        REV_PROC_2025_32(
          '§3.03 (§1(h), §1(j)(5)(B)) "Married Individuals Filing Separate Returns"',
        ),
        IN_FORCE,
      ),
      hoh: brackets(
        [
          [0n, '0'],
          [66_200n, '0.15'],
          [579_600n, '0.20'],
        ],
        REV_PROC_2025_32('§3.03 (§1(h), §1(j)(5)(B)) "Heads of Household"'),
        IN_FORCE,
      ),
    },
    netInvestmentIncomeTax: {
      rate: rate('0.038', 'IRC §1411(a)(1) (07 Appendix A, "Income tax": NIIT 3.8%)', IN_FORCE),
      threshold: {
        single: money(200_000n, 'IRC §1411(b)(3) — not indexed (07 Appendix A)', IN_FORCE),
        mfj: money(250_000n, 'IRC §1411(b)(1) — not indexed (07 Appendix A)', IN_FORCE),
        mfs: money(125_000n, 'IRC §1411(b)(2) — not indexed', IN_FORCE),
        hoh: money(200_000n, 'IRC §1411(b)(3) — not indexed', IN_FORCE),
      },
    },
    capitalLossOrdinaryOffset: {
      standard: money(
        3_000n,
        'IRC §1211(b)(1) (07 Appendix A: "$3,000/yr, remainder carries forward", §1212(b))',
        IN_FORCE,
      ),
      mfs: money(1_500n, 'IRC §1211(b)(1), married filing separately', IN_FORCE),
    },
  },

  hsa: {
    selfOnly: money(4_400n, REV_PROC_2025_19, IN_FORCE),
    family: money(8_750n, REV_PROC_2025_19, IN_FORCE),
    catchUpAge55: money(
      1_000n,
      'IRC §223(b)(3)(B) — statutory, not indexed (07 Appendix A, "HSA")',
      IN_FORCE,
    ),
  },

  socialSecurity: {
    cola: rate(
      '0.028',
      SSA_2026(
        'press release 2025-10-24, "Social Security Announces 2.8 Percent Benefit Increase for 2026", ' +
          'https://www.ssa.gov/news/en/press/releases/2025-10-24.html',
      ),
      IN_FORCE,
    ),
    taxableWageBase: money(
      184_500n,
      SSA_2026(
        'Office of the Chief Actuary, contribution and benefit base, https://www.ssa.gov/oact/cola/cbb.html',
      ),
      IN_FORCE,
    ),
    bendPoints: {
      first: money(
        1_286n,
        SSA_2026(
          'Office of the Chief Actuary, PIA bend points, https://www.ssa.gov/oact/cola/bendpoints.html',
        ),
        IN_FORCE,
        'Monthly AIME dollars, for workers first eligible (age 62) in 2026.',
      ),
      second: money(
        7_749n,
        SSA_2026(
          'Office of the Chief Actuary, PIA bend points, https://www.ssa.gov/oact/cola/bendpoints.html',
        ),
        IN_FORCE,
        'Monthly AIME dollars, for workers first eligible (age 62) in 2026.',
      ),
    },
    piaFactors: {
      belowFirst: rate(
        '0.90',
        'Social Security Act §215(a)(1)(A)(i), 42 U.S.C. 415 (07 §5.8 step 3)',
        IN_FORCE,
      ),
      betweenBendPoints: rate(
        '0.32',
        'Social Security Act §215(a)(1)(A)(ii), 42 U.S.C. 415 (07 §5.8 step 3)',
        IN_FORCE,
      ),
      aboveSecond: rate(
        '0.15',
        'Social Security Act §215(a)(1)(A)(iii), 42 U.S.C. 415 (07 §5.8 step 3)',
        IN_FORCE,
      ),
    },
    fullRetirementAge: {
      kind: 'ageSchedule',
      value: [{ bornFrom: '1960', bornThrough: null, age: '67' }],
      source:
        'Social Security Act §216(l)(1), 42 U.S.C. 416(l) (07 Appendix A: "Full retirement age, born 1960+ — 67")',
      asOf: IN_FORCE,
      note: 'Only the 1960+ cohort is encoded. An earlier birth year has no row and a lookup must refuse it.',
    },
    earlyReductionPerMonth: {
      first36Months: {
        kind: 'fraction',
        value: { numerator: '5', denominator: '900' },
        source:
          '20 CFR 404.410(a) — 5/9 of 1% per month for the first 36 months before FRA (07 §5.8 step 5)',
        asOf: IN_FORCE,
      },
      beyond36Months: {
        kind: 'fraction',
        value: { numerator: '5', denominator: '1200' },
        source: '20 CFR 404.410(a) — 5/12 of 1% per month beyond 36 months (07 §5.8 step 5)',
        asOf: IN_FORCE,
      },
    },
    delayedRetirementCreditPerYear: rate(
      '0.08',
      '20 CFR 404.313(a), born 1943 or later — 2/3 of 1% per month (07 Appendix A: "8%/yr to age 70")',
      IN_FORCE,
    ),
    delayedRetirementCreditEndsAtAge: {
      kind: 'integer',
      value: '70',
      unit: 'age_years',
      source: '20 CFR 404.313(a) (07 Appendix A: "8%/yr to age 70")',
      asOf: IN_FORCE,
    },
  },

  rmd: {
    startAge: {
      kind: 'ageSchedule',
      value: [
        { bornFrom: '1951', bornThrough: '1959', age: '73' },
        { bornFrom: '1960', bornThrough: null, age: '75' },
      ],
      source: SECURE_2('SECURE 2.0 Act §107, IRC §401(a)(9)(C)(v)'),
      asOf: IN_FORCE,
      note: 'Birth years before 1951 are already past their start age and are not encoded.',
    },
    firstDistributionDeadline: fact(
      'The first RMD is due by April 1 of the year after the year the owner reaches RMD age; every later ' +
        'RMD by December 31. Deferring the first to April 1 puts two RMDs in that calendar year.',
      SECURE_2('IRC §401(a)(9)(C)(i); Treas. Reg. §1.401(a)(9)-2'),
      IN_FORCE,
    ),
    missedDistributionExcise: rate('0.25', SECURE_2('SECURE 2.0 Act §302, IRC §4974(a)'), IN_FORCE),
    missedDistributionExciseIfCorrected: rate(
      '0.10',
      SECURE_2('SECURE 2.0 Act §302, IRC §4974(e)'),
      IN_FORCE,
    ),
    designatedRothAccounts: fact(
      'Roth 401(k) and 403(b) accounts have no required minimum distributions during the owner’s life; a ' +
        'Roth IRA never had them for the owner.',
      SECURE_2('SECURE 2.0 Act §325, IRC §402A(d)(5)'),
      IN_FORCE,
      '2024-01-01',
    ),
  },

  digitalAssets: {
    costBasisTracking: fact(
      'Cost basis is tracked per wallet or account; a safe harbor allocates legacy universal basis.',
      'IRS Rev. Proc. 2024-28 (07 Appendix A, "Digital assets")',
      '2026-09-10',
      '2025-01-01',
    ),
    form1099Da: fact(
      'Brokers report gross proceeds for 2025 transactions, and gross proceeds plus adjusted basis for 2026 transactions.',
      'Treas. Reg. §1.6045-1 as amended by T.D. 10000 (07 Appendix A, "Digital assets")',
      '2026-09-10',
      '2026-01-01',
    ),
    washSale: fact(
      'The §1091 wash-sale rule does not apply to digital assets; legislation to extend it was proposed in 2026.',
      'IRC §1091 ("stock or securities"); 07 Appendix A, "Digital assets" (CNBC 2026-07-28)',
      '2026-09-10',
    ),
    stakingRewards: fact(
      'Staking rewards are ordinary income at fair market value when the taxpayer gains dominion and control.',
      'IRS Rev. Rul. 2023-14 (07 Appendix A, "Digital assets"; 07 §6.5)',
      '2026-09-10',
    ),
  },
} satisfies UsTaxYearInput;
