// SPDX-License-Identifier: MIT
/**
 * Assumptions: one file, versioned, cited (WP 4.2; 07 §5.5 and Appendix A).
 *
 * 07 §5.5 asks for `config/assumptions.yaml`, "versioned, user-overridable,
 * **with the source string displayed in the UI next to each number**", and
 * Appendix A asks for `config/tax/us_2026.yaml`, "keyed by year, never inlined
 * in code". This repo has no YAML loader and D14 says not to add one for this,
 * so the file is two checked-in TypeScript modules under `../data/` — the
 * `@ctx/investments` `data/asset-classes.json` precedent — and this module is
 * the only thing that reads them.
 *
 * ## Four rules this module enforces, and where
 *
 *   * **Every number is cited.** Each number sits inside a *cited node* — an
 *     object with a `kind`, a `value`, a non-empty `source` and an `asOf` date.
 *     `assumptionsFileSchema` refuses a node without either at load, the data
 *     files' `satisfies` refuses it at `tsc`, and
 *     `'every number in the assumptions file carries a non-empty source and an
 *     as_of date'` walks the raw structure independently of both. A table
 *     (a bracket schedule, the correlation matrix) is one cited node, because it
 *     is one table in one primary source; every number inside it carries that
 *     node's citation.
 *   * **Rates and ratios are decimal strings; money limits are `Money`.** 08
 *     §6.5. No `number` reaches either — `node scripts/check-numeric-boundaries.ts`
 *     is the mechanised half. The engine converts once, at WP 4.4's boundary.
 *   * **The version is the content.** `assumptionsVersion()` is
 *     `sha256:` + SHA-256 over the canonical JSON of the *validated values*
 *     (sources, dates and notes included — they are what the UI shows). A
 *     comment is not a value: the modules' comments never reach the object, so
 *     they cannot move the hash. Canonical JSON sorts keys at every level, so
 *     the hash does not depend on property order or on the process that computed
 *     it (the 3.10a §7.3 OpenAPI non-determinism is why that is tested across
 *     two processes).
 *   * **A user's overrides are deltas against a named version, never a copy.**
 *     `diffOverrides` drops every override equal to the default it would
 *     replace, so an unchanged default is never pinned: when the file's default
 *     moves, the user follows it. `resolveOverrides` refuses a version it does
 *     not hold rather than applying a delta to a file it was not computed
 *     against. When a change moves the version, the previous file is **retained
 *     frozen** (`../data/assumptions-retained.ts`, WP 5.5) so the overrides
 *     saved against it still resolve; no run is computed on a retained version,
 *     and a run stored against one reads back stale with the version named. `plan_assumptions` (migration 0021) is the storage, and its CHECK
 *     refuses anything but a flat `path → decimal string` object, so a copy of
 *     the file cannot even be expressed in the column.
 *
 * ## A 2027 lookup fails loudly
 *
 * `taxYear(assumptions, 2027)` throws `AssumptionsYearUnavailable` naming the
 * year and the years the file holds. There is no "latest year ≤ requested"
 * fallback anywhere: a 2026 contribution limit silently applied to 2027 is a
 * wrong number that looks exactly like a right one.
 */
import { appendEvent, canonicalJson, configHash, defineEvent } from '@core/platform';
import {
  fixedClock,
  money,
  newId,
  parseDateOnly,
  todayIn,
  type Clock,
  type DateOnly,
  type Money,
} from '@core/kernel';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { ASSUMPTIONS_FILE } from '../data/assumptions.ts';
import { RETAINED_ASSUMPTIONS_FILES } from '../data/assumptions-retained.ts';
import { platformOf, type PlanningExecutor } from './store.ts';

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

/** A decimal written as a string: `'0.065'`, `'-0.05'`, `'1'`. Never a float. */
export const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/;
const VERSION_PATTERN = /^sha256:[0-9a-f]{64}$/;

const decimalString = z.string().regex(DECIMAL_PATTERN, 'a decimal string such as "0.065"');
const integerString = z.string().regex(INTEGER_PATTERN, 'a non-negative integer string');
const isoDate = z.string().refine((text) => {
  try {
    return parseDateOnly(text) === text;
  } catch {
    return false;
  }
}, 'a calendar date as YYYY-MM-DD');

/** `sha256:<64 hex>` — the content hash of one assumptions file. */
export type AssumptionsVersion = string & { readonly __brand: 'AssumptionsVersion' };

/**
 * Scale a decimal string to an integer at `scale` fractional digits, exactly.
 * The comparison primitive for decimal strings: no float is ever formed.
 */
function scaled(decimal: string, scale: number): bigint {
  const negative = decimal.startsWith('-');
  const unsigned = negative ? decimal.slice(1) : decimal;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  if (fraction.length > scale) throw new Error(`decimal ${decimal} exceeds scale ${String(scale)}`);
  const digits = BigInt(whole + fraction.padEnd(scale, '0'));
  return negative ? -digits : digits;
}

function fractionDigits(decimal: string): number {
  const dot = decimal.indexOf('.');
  return dot === -1 ? 0 : decimal.length - dot - 1;
}

/** -1, 0 or 1. Exact over decimal strings of any scale. */
export function compareDecimal(left: string, right: string): -1 | 0 | 1 {
  const scale = Math.max(fractionDigits(left), fractionDigits(right));
  const a = scaled(left, scale);
  const b = scaled(right, scale);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `'0.0650'` → `'0.065'`, `'-0'` → `'0'`, `'2.'` is not a decimal and never reaches here. */
export function canonicalDecimal(decimal: string): string {
  let text = decimal;
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '');
  return text === '-0' ? '0' : text;
}

// ---------------------------------------------------------------------------
// Cited nodes — the only place a number may live in the file
// ---------------------------------------------------------------------------

const citation = {
  /** Who says so: the primary source first, then the design memo line that chose it. */
  source: z.string().trim().min(1),
  /** The date the figure is true as of — effective date for law, observation date for markets. */
  asOf: isoDate,
  note: z.string().trim().min(1).optional(),
  /** A licence condition that travels with the figure (FRED's, per WP 3.4 §4). */
  attribution: z.string().trim().min(1).optional(),
};

const moneyLiteral = z
  .strictObject({ minor: z.bigint().nonnegative(), currency: z.literal('USD') })
  .transform((literal): Money => money(literal.minor, literal.currency));

const citedMoney = z.strictObject({ kind: z.literal('money'), value: moneyLiteral, ...citation });
const citedMoneyRange = z
  .strictObject({
    kind: z.literal('moneyRange'),
    value: z.strictObject({ from: moneyLiteral, to: moneyLiteral }),
    ...citation,
  })
  .refine((node) => node.value.from.minor <= node.value.to.minor, 'a range runs low to high');
const citedRate = z.strictObject({
  kind: z.literal('rate'),
  value: decimalString,
  /** Whether the rate is before or after inflation. Absent for a rate that is neither (a tax rate). */
  basis: z.enum(['nominal', 'inflation_adjusted']).optional(),
  ...citation,
});
const citedRateRange = z
  .strictObject({
    kind: z.literal('rateRange'),
    value: z.strictObject({ from: decimalString, to: decimalString }),
    ...citation,
  })
  .refine(
    (node) => compareDecimal(node.value.from, node.value.to) <= 0,
    'a range runs low to high',
  );
const citedInteger = z.strictObject({
  kind: z.literal('integer'),
  value: integerString,
  unit: z.enum(['age_years', 'calendar_year', 'months', 'degrees_of_freedom']),
  ...citation,
});
const citedFraction = z
  .strictObject({
    kind: z.literal('fraction'),
    value: z.strictObject({ numerator: integerString, denominator: integerString }),
    ...citation,
  })
  .refine((node) => node.value.denominator !== '0', 'a denominator is never zero');
const citedIndex = z.strictObject({ kind: z.literal('index'), value: decimalString, ...citation });
const citedFact = z.strictObject({
  kind: z.literal('fact'),
  value: z.string().trim().min(1),
  effective: isoDate.optional(),
  ...citation,
});

const bracket = z.strictObject({ over: moneyLiteral, rate: decimalString });
const citedBrackets = z
  .strictObject({ kind: z.literal('brackets'), value: z.array(bracket).min(1), ...citation })
  .superRefine((node, context) => {
    const [first] = node.value;
    if (first !== undefined && first.over.minor !== 0n) {
      context.addIssue({ code: 'custom', message: 'the first bracket starts at zero' });
    }
    node.value.forEach((entry, index) => {
      if (compareDecimal(entry.rate, '0') < 0 || compareDecimal(entry.rate, '1') > 0) {
        context.addIssue({ code: 'custom', message: `bracket ${String(index)} rate outside 0..1` });
      }
      const previous = node.value[index - 1];
      if (previous !== undefined && previous.over.minor >= entry.over.minor) {
        context.addIssue({ code: 'custom', message: `bracket ${String(index)} does not ascend` });
      }
      if (previous !== undefined && compareDecimal(previous.rate, entry.rate) > 0) {
        context.addIssue({ code: 'custom', message: `bracket ${String(index)} rate descends` });
      }
    });
  });

const ageRow = z.strictObject({
  bornFrom: integerString,
  bornThrough: integerString.nullable(),
  age: integerString,
});
const citedAgeSchedule = z
  .strictObject({ kind: z.literal('ageSchedule'), value: z.array(ageRow).min(1), ...citation })
  .superRefine((node, context) => {
    node.value.forEach((row, index) => {
      const next = node.value[index + 1];
      if (row.bornThrough === null && next !== undefined) {
        context.addIssue({ code: 'custom', message: 'only the last cohort may be open-ended' });
      }
      if (row.bornThrough !== null && BigInt(row.bornThrough) < BigInt(row.bornFrom)) {
        context.addIssue({
          code: 'custom',
          message: `cohort ${String(index)} ends before it starts`,
        });
      }
      if (next !== undefined && row.bornThrough !== null) {
        if (BigInt(next.bornFrom) !== BigInt(row.bornThrough) + 1n) {
          context.addIssue({
            code: 'custom',
            message: `cohort ${String(index + 1)} is not contiguous`,
          });
        }
      }
    });
  });

const citedCorrelation = z
  .strictObject({
    kind: z.literal('correlation'),
    value: z.strictObject({
      assets: z.array(z.string().regex(/^[A-Z]+$/)).min(2),
      matrix: z.array(z.array(decimalString)),
    }),
    ...citation,
  })
  .superRefine((node, context) => {
    const { assets, matrix } = node.value;
    if (new Set(assets).size !== assets.length) {
      context.addIssue({ code: 'custom', message: 'correlation assets repeat' });
    }
    if (matrix.length !== assets.length || matrix.some((row) => row.length !== assets.length)) {
      context.addIssue({ code: 'custom', message: 'the correlation matrix is not n × n' });
      return;
    }
    matrix.forEach((row, i) =>
      row.forEach((cell, j) => {
        if (compareDecimal(cell, '-1') < 0 || compareDecimal(cell, '1') > 0) {
          context.addIssue({
            code: 'custom',
            message: `ρ[${String(i)}][${String(j)}] outside -1..1`,
          });
        }
        if (i === j && compareDecimal(cell, '1') !== 0) {
          context.addIssue({ code: 'custom', message: `ρ[${String(i)}][${String(i)}] is not 1` });
        }
        const mirror = matrix[j]?.[i];
        if (mirror === undefined || compareDecimal(cell, mirror) !== 0) {
          context.addIssue({
            code: 'custom',
            message: `ρ[${String(i)}][${String(j)}] is not symmetric`,
          });
        }
      }),
    );
  });

/** Every `kind` a cited node may carry. The walk in the test reads this list. */
export const CITED_KINDS = [
  'money',
  'moneyRange',
  'rate',
  'rateRange',
  'integer',
  'fraction',
  'index',
  'fact',
  'brackets',
  'ageSchedule',
  'correlation',
] as const;
export type CitedKind = (typeof CITED_KINDS)[number];

// ---------------------------------------------------------------------------
// The US tax year (Appendix A) and the whole file
// ---------------------------------------------------------------------------

const byFilingStatus = <T extends z.ZodType>(node: T) =>
  z.strictObject({ single: node, mfj: node, mfs: node, hoh: node });

export const FILING_STATUSES = ['single', 'mfj', 'mfs', 'hoh'] as const;
export type FilingStatus = (typeof FILING_STATUSES)[number];

const usTaxYearSchema = z.strictObject({
  retirement: z.strictObject({
    electiveDeferral: citedMoney,
    catchUpAge50: citedMoney,
    catchUpAge60To63: citedMoney,
    iraContribution: citedMoney,
    iraCatchUpAge50: citedMoney,
    rothIraPhaseOut: z.strictObject({
      singleOrHoh: citedMoneyRange,
      mfj: citedMoneyRange,
      mfs: citedMoneyRange,
    }),
    traditionalIraDeductionPhaseOut: z.strictObject({
      singleCovered: citedMoneyRange,
      mfjCovered: citedMoneyRange,
      spouseNotCovered: citedMoneyRange,
    }),
    saversCreditAgiLimit: z.strictObject({ mfj: citedMoney, hoh: citedMoney, single: citedMoney }),
    simpleDeferral: z.strictObject({ standard: citedMoney, applicablePlans: citedMoney }),
    mandatoryRothCatchUpWageThreshold: citedMoney,
  }),
  incomeTax: z.strictObject({
    standardDeduction: byFilingStatus(citedMoney),
    brackets: byFilingStatus(citedBrackets),
    longTermCapitalGains: byFilingStatus(citedBrackets),
    netInvestmentIncomeTax: z.strictObject({
      rate: citedRate,
      threshold: byFilingStatus(citedMoney),
    }),
    capitalLossOrdinaryOffset: z.strictObject({ standard: citedMoney, mfs: citedMoney }),
  }),
  hsa: z.strictObject({ selfOnly: citedMoney, family: citedMoney, catchUpAge55: citedMoney }),
  socialSecurity: z.strictObject({
    cola: citedRate,
    taxableWageBase: citedMoney,
    bendPoints: z.strictObject({ first: citedMoney, second: citedMoney }),
    piaFactors: z.strictObject({
      belowFirst: citedRate,
      betweenBendPoints: citedRate,
      aboveSecond: citedRate,
    }),
    fullRetirementAge: citedAgeSchedule,
    earlyReductionPerMonth: z.strictObject({
      first36Months: citedFraction,
      beyond36Months: citedFraction,
    }),
    delayedRetirementCreditPerYear: citedRate,
    delayedRetirementCreditEndsAtAge: citedInteger,
  }),
  rmd: z.strictObject({
    startAge: citedAgeSchedule,
    firstDistributionDeadline: citedFact,
    missedDistributionExcise: citedRate,
    missedDistributionExciseIfCorrected: citedRate,
    designatedRothAccounts: citedFact,
  }),
  digitalAssets: z.strictObject({
    costBasisTracking: citedFact,
    form1099Da: citedFact,
    washSale: citedFact,
    stakingRewards: citedFact,
  }),
});

const assetAssumption = z.strictObject({ expectedReturn: citedRate, volatility: citedRate });

export const assumptionsFileSchema = z.strictObject({
  format: z.literal('personalfi.assumptions/1'),
  label: z.string().trim().min(1),
  capitalMarket: z.strictObject({
    usEquity: assetAssumption,
    intlDevelopedEquity: assetAssumption,
    emergingEquity: assetAssumption,
    usAggregateBonds: assetAssumption,
    tips: assetAssumption,
    cash: assetAssumption,
    crypto: z.strictObject({
      expectedReturn: citedRate,
      volatility: citedRate,
      distribution: citedFact,
      degreesOfFreedom: citedInteger,
      disclaimer: citedFact,
    }),
    inflation: z.strictObject({ mean: citedRate, volatility: citedRate }),
    wageGrowth: z.strictObject({ spreadOverInflation: citedRate }),
    equityRiskPremiumCrossCheck: citedRate,
  }),
  correlation: citedCorrelation,
  /**
   * WP 5.5. Optional **in the schema only** so the frozen predecessor
   * (`data/assumptions-retained.ts`), which predates it, still validates and
   * still hashes to its own version. The current file cannot omit it:
   * `parseAssumptions` refuses a file missing any `OVERRIDABLE_PATHS` node, and
   * this is one.
   */
  withdrawalPolicy: z.strictObject({ guardrailReferenceRate: citedRate }).optional(),
  socialSecurityStress: z.strictObject({ fromCalendarYear: citedInteger, payableRatio: citedRate }),
  marketReference: z.strictObject({
    treasuryBill3Month: citedRate,
    topHighYieldSavingsApy: citedRateRange,
    nationalAverageSavingsRate: citedRate,
    fdicInsuranceLimit: citedMoney,
  }),
  macro: z.strictObject({
    cpiUrbanIndex: citedIndex,
    cpiUrban12MonthChange: citedRate,
    treasury10YearYield: citedRate,
    treasury3MonthYield: citedRate,
  }),
  /** Keyed by the tax year as a string. There is no default year. */
  taxYears: z.record(z.string().regex(/^\d{4}$/), usTaxYearSchema),
});

/** What the data modules are written against (`satisfies`). Money is a `{ minor, currency }` literal. */
export type AssumptionsFileInput = z.input<typeof assumptionsFileSchema>;
export type UsTaxYearInput = z.input<typeof usTaxYearSchema>;
/** The validated file. Money is kernel `Money`. */
export type AssumptionsFile = z.output<typeof assumptionsFileSchema>;
export type UsTaxYear = z.output<typeof usTaxYearSchema>;
export type CitedRate = z.output<typeof citedRate>;
export type CitedRateInput = z.input<typeof citedRate>;

// ---------------------------------------------------------------------------
// Load, hash, freeze
// ---------------------------------------------------------------------------

export interface Assumptions {
  readonly version: AssumptionsVersion;
  readonly file: AssumptionsFile;
  /**
   * Present on a **retained predecessor** only (WP 5.5): a superseded file this
   * build still holds so a stored override against it resolves. A run is never
   * computed on a retained version, and one stored against it reads back stale
   * with the version named (`projection-service.ts`).
   */
  readonly retained?: {
    readonly retiredOn: string;
    readonly supersededBecause: string;
    readonly guardrailReferenceRate: CitedRate;
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

/** `bigint` → decimal string, recursively; JSON cannot carry one and `canonicalJson` would throw. */
function hashable(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(hashable);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, hashable(inner)]));
  }
  return value;
}

/** Validate any raw file and return its version. The hash test's entry point for a probe copy. */
export function hashAssumptionsFile(raw: unknown): AssumptionsVersion {
  return versionOf(assumptionsFileSchema.parse(raw));
}

function versionOf(file: AssumptionsFile): AssumptionsVersion {
  return `sha256:${configHash(hashable(file) as Record<string, unknown>)}` as AssumptionsVersion;
}

/** The canonical JSON the version is the hash of. Exposed for the evidence, not for callers. */
export function canonicalAssumptionsJson(assumptions: Assumptions): string {
  return canonicalJson(hashable(assumptions.file));
}

/**
 * Validate, freeze and version one raw file. Throws a `ZodError` naming every
 * problem at once — a file with an uncited number must not load at all.
 */
export function parseAssumptions(raw: unknown): Assumptions {
  const file = deepFreeze(assumptionsFileSchema.parse(raw));
  for (const path of OVERRIDABLE_PATHS) {
    const node = nodeAt(file, path);
    if (!isCitedRate(node)) {
      throw new Error(
        `overridable path ${path} does not name a cited rate in the assumptions file`,
      );
    }
  }
  return Object.freeze({ version: versionOf(file), file });
}

let current: Assumptions | null = null;

/**
 * The checked-in file, validated, frozen and hashed — once per process.
 *
 * Lazy rather than at import, so a malformed file fails the test that names the
 * rule it broke instead of every test file that imports `@ctx/planning`. The
 * composition root should call this at boot so the API refuses to start on a
 * bad file (see the WP 4.2 evidence, "For the orchestrator").
 */
export function loadAssumptions(): Assumptions {
  current ??= parseAssumptions(ASSUMPTIONS_FILE);
  return current;
}

/** The current file's content hash. What every projection run records (07 §7.3). */
export function assumptionsVersion(): AssumptionsVersion {
  return loadAssumptions().version;
}

let retained: readonly Assumptions[] | null = null;

/**
 * The frozen predecessors (`data/assumptions-retained.ts`), validated, each
 * **re-hashed and refused unless it reproduces the version it is named by** —
 * a retained file that drifted would resolve a holder's overrides against
 * content they were never computed on. Once per process, like the current file.
 */
export function retainedAssumptions(): readonly Assumptions[] {
  retained ??= Object.freeze(
    RETAINED_ASSUMPTIONS_FILES.map((entry) => {
      const file = deepFreeze(assumptionsFileSchema.parse(entry.file));
      const version = versionOf(file);
      if (version !== entry.version) {
        throw new Error(
          `the retained assumptions file named ${entry.version} hashes to ${version}: a frozen ` +
            'predecessor was edited, and overrides saved against it would resolve against ' +
            'content they were never computed on — restore it byte for byte',
        );
      }
      if (version === loadAssumptions().version) {
        throw new Error(`the retained assumptions file ${version} is the current file`);
      }
      const guardrailReferenceRate = citedRate.parse(entry.supplements.guardrailReferenceRate);
      return Object.freeze({
        version,
        file,
        retained: deepFreeze({
          retiredOn: entry.retiredOn,
          supersededBecause: entry.supersededBecause,
          guardrailReferenceRate,
        }),
      });
    }),
  );
  return retained;
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/** A stored override names a file version this process does not hold. 409, `domain`. */
export class UnknownAssumptionsVersion extends Error {
  override readonly name = 'UnknownAssumptionsVersion';
  readonly code = 'planning.assumptions_version_unknown';
  readonly requested: string;
  readonly known: readonly string[];

  constructor(requested: string, known: readonly string[]) {
    super(
      `assumptions version ${requested} is not a version this build holds ` +
        `(known: ${known.join(', ') || 'none'}). A delta is only meaningful against the file it ` +
        'was computed from; it is never re-applied to a different one silently.',
    );
    this.requested = requested;
    this.known = known;
  }
}

/** A lookup for a tax year the file does not hold. 422, `domain`. */
export class AssumptionsYearUnavailable extends Error {
  override readonly name = 'AssumptionsYearUnavailable';
  readonly code = 'planning.assumptions_year_unavailable';
  readonly year: number;
  readonly available: readonly string[];

  constructor(year: number, available: readonly string[]) {
    super(
      `the assumptions file has no ${String(year)} tax year (it holds ${available.join(', ')}). ` +
        'A previous year is never reused: limits, brackets and bend points are re-published ' +
        'every year and a stale one looks exactly like a right one.',
    );
    this.year = year;
    this.available = available;
  }
}

/** An override for a path that is not overridable, or a value that is not a sane rate. 422, `user`. */
export class AssumptionOverrideRefused extends Error {
  override readonly name = 'AssumptionOverrideRefused';
  readonly code: 'planning.assumptions_path_unknown' | 'planning.assumptions_value_invalid';
  readonly path: string;

  constructor(
    code: 'planning.assumptions_path_unknown' | 'planning.assumptions_value_invalid',
    path: string,
    detail: string,
  ) {
    super(`override ${path}: ${detail}`);
    this.code = code;
    this.path = path;
  }
}

const REFUSAL_CODES = new Set([
  'planning.assumptions_version_unknown',
  'planning.assumptions_year_unavailable',
  'planning.assumptions_path_unknown',
  'planning.assumptions_value_invalid',
]);

/** A predicate rather than `instanceof`, for the reason `isFxRateUnavailable` gives. */
export function isAssumptionsRefusal(
  error: unknown,
): error is UnknownAssumptionsVersion | AssumptionsYearUnavailable | AssumptionOverrideRefused {
  if (!(error instanceof Error)) return false;
  const code: unknown = (error as Error & { code?: unknown }).code;
  return typeof code === 'string' && REFUSAL_CODES.has(code);
}

// ---------------------------------------------------------------------------
// Year-keyed lookups
// ---------------------------------------------------------------------------

/** The tax year's parameters, or `AssumptionsYearUnavailable`. There is no fallback year. */
export function taxYear(assumptions: Assumptions, year: number): UsTaxYear {
  const table = assumptions.file.taxYears[String(year)];
  if (table === undefined) {
    throw new AssumptionsYearUnavailable(year, Object.keys(assumptions.file.taxYears).sort());
  }
  return table;
}

// ---------------------------------------------------------------------------
// Overrides: deltas against a named version
// ---------------------------------------------------------------------------

/**
 * The paths a user may override. The capital-market assumptions only: 07 §5.5
 * makes those user-overridable, and they are opinions. The tax year is law —
 * a different contribution limit is a new file version, not a preference — and
 * the correlation matrix is not overridable cell by cell because an edited cell
 * can make it non-positive-definite, which WP 4.5's Cholesky cannot factor.
 *
 * One exception to "capital-market only", WP 5.5: the **guardrail reference
 * rate** — 07 §5.6's `initial_wr = 0.045 # user-settable`, the withdrawal rate
 * R7's Guyton-Klinger band is drawn around. 07 marks it user-settable in so
 * many words; until WP 5.5 it was a literal in the composition root.
 */
export const OVERRIDABLE_PATHS = [
  'capitalMarket.usEquity.expectedReturn',
  'capitalMarket.usEquity.volatility',
  'capitalMarket.intlDevelopedEquity.expectedReturn',
  'capitalMarket.intlDevelopedEquity.volatility',
  'capitalMarket.emergingEquity.expectedReturn',
  'capitalMarket.emergingEquity.volatility',
  'capitalMarket.usAggregateBonds.expectedReturn',
  'capitalMarket.usAggregateBonds.volatility',
  'capitalMarket.tips.expectedReturn',
  'capitalMarket.tips.volatility',
  'capitalMarket.cash.expectedReturn',
  'capitalMarket.cash.volatility',
  'capitalMarket.crypto.expectedReturn',
  'capitalMarket.crypto.volatility',
  'capitalMarket.inflation.mean',
  'capitalMarket.inflation.volatility',
  'capitalMarket.wageGrowth.spreadOverInflation',
  'withdrawalPolicy.guardrailReferenceRate',
] as const;
export type OverridablePath = (typeof OVERRIDABLE_PATHS)[number];

const OVERRIDABLE = new Set<string>(OVERRIDABLE_PATHS);

/** Inclusive sanity bounds, as decimal strings. A volatility is never negative. */
function boundsFor(path: string): readonly [string, string] {
  if (path === 'withdrawalPolicy.guardrailReferenceRate') return ['0', '1'];
  return path.endsWith('.volatility') ? ['0', '2'] : ['-1', '1'];
}

/** A sparse `path → decimal string` map. Never a copy of the file. */
export type AssumptionDeltas = Readonly<Partial<Record<OverridablePath, string>>>;

function nodeAt(file: AssumptionsFile, path: string): unknown {
  let cursor: unknown = file;
  for (const key of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

function isCitedRate(node: unknown): node is CitedRate {
  return (
    node !== null &&
    typeof node === 'object' &&
    (node as { kind?: unknown }).kind === 'rate' &&
    typeof (node as { value?: unknown }).value === 'string'
  );
}

function defaultAt(assumptions: Assumptions, path: OverridablePath): CitedRate {
  const node = nodeAt(assumptions.file, path);
  if (!isCitedRate(node)) throw new Error(`no cited rate at ${path}`);
  return node;
}

/**
 * The user's desired values → the delta to store.
 *
 * Every entry equal to the default it would replace is **dropped**, exactly
 * compared as decimals (`'0.0650'` equals `'0.065'`). That is the rule the
 * dispatch states — an override that silently pins a stale default is worse
 * than no override — and it is what lets a changed default reach a user who
 * never disagreed with the old one. What remains is canonicalised and frozen.
 *
 * @throws {AssumptionOverrideRefused} an unknown path, a non-decimal, or a value outside the path's bounds.
 */
export function diffOverrides(
  assumptions: Assumptions,
  desired: Readonly<Record<string, string>>,
): AssumptionDeltas {
  const delta: Partial<Record<OverridablePath, string>> = {};
  for (const [path, raw] of Object.entries(desired).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!OVERRIDABLE.has(path)) {
      throw new AssumptionOverrideRefused(
        'planning.assumptions_path_unknown',
        path,
        'not an overridable assumption; the tax year is law and changes only with a new file version',
      );
    }
    const overridable = path as OverridablePath;
    if (!isCitedRate(nodeAt(assumptions.file, path))) {
      // A retained predecessor predates a path added since (WP 5.5's guardrail
      // rate): no override could have been saved against it there.
      throw new AssumptionOverrideRefused(
        'planning.assumptions_path_unknown',
        path,
        `not an assumption of file version ${assumptions.version}`,
      );
    }
    if (typeof raw !== 'string' || !DECIMAL_PATTERN.test(raw) || fractionDigits(raw) > 12) {
      throw new AssumptionOverrideRefused(
        'planning.assumptions_value_invalid',
        path,
        'a rate is a decimal string with at most 12 decimal places, e.g. "0.055" — never a number',
      );
    }
    const [low, high] = boundsFor(path);
    if (compareDecimal(raw, low) < 0 || compareDecimal(raw, high) > 0) {
      throw new AssumptionOverrideRefused(
        'planning.assumptions_value_invalid',
        path,
        `${raw} is outside ${low}..${high}`,
      );
    }
    if (compareDecimal(raw, defaultAt(assumptions, overridable).value) === 0) continue;
    delta[overridable] = canonicalDecimal(raw);
  }
  return Object.freeze(delta);
}

/** One applied override, with the default it displaced — the UI shows both. */
export interface AppliedOverride {
  readonly path: OverridablePath;
  readonly value: string;
  readonly default: CitedRate;
}

/** The file with a user's deltas applied. `version` is still the *file's* version. */
export interface ResolvedAssumptions {
  readonly version: AssumptionsVersion;
  readonly file: AssumptionsFile;
  readonly overrides: readonly AppliedOverride[];
}

/**
 * Apply a delta to a file. The override replaces the node's value and its
 * citation — the source of an overridden number is the user, dated the day they
 * set it — and the displaced default is kept beside it in `overrides`.
 */
export function applyOverrides(
  assumptions: Assumptions,
  deltas: AssumptionDeltas,
  overriddenOn: DateOnly,
): ResolvedAssumptions {
  const file = structuredClone(assumptions.file) as AssumptionsFile;
  const overrides: AppliedOverride[] = [];
  for (const path of OVERRIDABLE_PATHS) {
    const replacement = deltas[path];
    if (replacement === undefined) continue;
    const displaced = defaultAt(assumptions, path);
    const keys = path.split('.');
    const leaf = keys.pop() as string;
    const parent = nodeAt(file, keys.join('.')) as Record<string, CitedRate>;
    parent[leaf] = {
      ...displaced,
      value: replacement,
      source: `Your override (the default is ${displaced.value}: ${displaced.source})`,
      asOf: overriddenOn,
    };
    overrides.push({ path, value: replacement, default: displaced });
  }
  return deepFreeze({ version: assumptions.version, file, overrides });
}

/**
 * Versions this build can resolve a delta against: the checked-in file, and
 * — since WP 5.5 — its frozen predecessors, each marked `retained`.
 */
export type AssumptionsRegistry = ReadonlyMap<string, Assumptions>;

/**
 * The current file first, then every retained predecessor. A holder's override
 * against a retained version resolves; a run is computed only on a version
 * `computableVersions` names.
 */
export function currentRegistry(): AssumptionsRegistry {
  const assumptions = loadAssumptions();
  return new Map<string, Assumptions>([
    [assumptions.version, assumptions],
    ...retainedAssumptions().map((entry) => [entry.version, entry] as const),
  ]);
}

/**
 * The versions a run may be **computed** on: every registry entry that is not
 * a retained predecessor. This is what a refusal or a stale label calls
 * `known` — the versions a holder's plan can move onto.
 */
export function computableVersions(registry: AssumptionsRegistry): readonly string[] {
  return [...registry.entries()]
    .filter(([, entry]) => entry.retained === undefined)
    .map(([version]) => version);
}

/** `true` when `version` is held only as a frozen predecessor: resolvable, never computed on. */
export function isRetainedVersion(registry: AssumptionsRegistry, version: string): boolean {
  return registry.get(version)?.retained !== undefined;
}

/**
 * The guardrail reference rate a set of assumptions carries — 07 §5.6's
 * `initial_wr`, cited, with the holder's override applied when there is one
 * (`applyOverrides` replaces the node's value and its citation). WP 5.5's
 * replacement for the composition root's `GUARDRAIL_REFERENCE_RATE` literal.
 *
 * A retained predecessor predates the node; its runs were computed with the
 * literal it then lived in, which the frozen module records beside the file.
 * Takes a registry entry or a resolved set; for a resolved set against a
 * retained version, pass the registry so the predecessor's figure is found.
 */
export function guardrailReferenceRate(
  assumptions: { readonly version: string; readonly file: AssumptionsFile },
  registry: AssumptionsRegistry = currentRegistry(),
): CitedRate {
  const node = assumptions.file.withdrawalPolicy?.guardrailReferenceRate;
  if (node !== undefined) return node;
  const predecessor = registry.get(assumptions.version)?.retained;
  if (predecessor !== undefined) return predecessor.guardrailReferenceRate;
  throw new Error(
    `assumptions version ${assumptions.version} carries no guardrail reference rate and is not a ` +
      'retained predecessor that records one',
  );
}

/**
 * Resolve a stored delta against the version it names.
 *
 * @throws {UnknownAssumptionsVersion} the named version is not in `registry` —
 *   never silently re-applied to today's file (WP 4.6 reads this as "stale").
 */
export function resolveOverrides(
  stored: { readonly assumptionsVersion: string; readonly deltas: AssumptionDeltas },
  overriddenOn: DateOnly,
  registry: AssumptionsRegistry = currentRegistry(),
): ResolvedAssumptions {
  const assumptions = registry.get(stored.assumptionsVersion);
  if (assumptions === undefined) {
    throw new UnknownAssumptionsVersion(stored.assumptionsVersion, computableVersions(registry));
  }
  // Re-validate on the way in: the column's CHECK is structural, this is semantic.
  const checked = diffOverrides(assumptions, stored.deltas);
  return applyOverrides(assumptions, checked, overriddenOn);
}

// ---------------------------------------------------------------------------
// The event
// ---------------------------------------------------------------------------

/**
 * `planning.AssumptionsOverridden` — payload discipline as `events.ts`: the
 * paths that are overridden and how many, never the values. A consumer that
 * wants the numbers re-reads them, which is also how it sees a later change.
 */
export const assumptionsOverriddenPayloadSchema = z.object({
  assumptionsVersion: z.string().regex(VERSION_PATTERN),
  overriddenPaths: z.array(z.enum(OVERRIDABLE_PATHS)),
  overrideCount: z.int().nonnegative(),
});
export type AssumptionsOverriddenPayload = z.infer<typeof assumptionsOverriddenPayloadSchema>;

/**
 * Defined here rather than in `events.ts` for this wave only (WP 4.1 owns that
 * file concurrently); `events.ts` re-exports it and lists it in
 * `PLANNING_EVENTS` — the lines are in the WP 4.2 evidence.
 */
export const AssumptionsOverridden = defineEvent({
  type: 'planning.AssumptionsOverridden',
  aggregateType: 'plan_assumptions',
  description:
    "A user's assumption overrides were replaced. The payload names the file version the " +
    'deltas are against and the overridden paths — never the values, which are re-read. An ' +
    'empty `overriddenPaths` means every assumption is back on its default.',
  schema: assumptionsOverriddenPayloadSchema,
});

// ---------------------------------------------------------------------------
// Storage: `plan_assumptions` (migration 0021)
// ---------------------------------------------------------------------------

const storedDeltasSchema = z.record(z.string(), decimalString);

export interface StoredOverrides {
  readonly id: string;
  readonly assumptionsVersion: string;
  readonly deltas: AssumptionDeltas;
  readonly updatedAt: Date;
}

interface RawOverrideRow extends Record<string, unknown> {
  id: string;
  assumptions_version: string;
  deltas: unknown;
  updated_at: Date | string;
}

function storedOf(raw: RawOverrideRow): StoredOverrides {
  return {
    id: raw.id,
    assumptionsVersion: raw.assumptions_version,
    deltas: Object.freeze(storedDeltasSchema.parse(raw.deltas)) as AssumptionDeltas,
    updatedAt: new Date(raw.updated_at),
  };
}

/**
 * Replace a user's overrides (PUT semantics) and emit `planning.AssumptionsOverridden`.
 *
 * `desired` is the whole set of values the user wants; what is stored is only
 * the part that differs from the current file — `diffOverrides` — against the
 * current file's version. Pass a transaction: the row and the event are one
 * fact, and an event announcing an override that then rolled back has told a
 * consumer something untrue.
 */
export async function saveOverrides(
  executor: PlanningExecutor,
  input: {
    readonly userId: string;
    readonly desired: Readonly<Record<string, string>>;
    readonly clock: Clock;
    readonly correlationId: string;
    readonly causationId?: string | null;
  },
  assumptions: Assumptions = loadAssumptions(),
): Promise<StoredOverrides> {
  const deltas = diffOverrides(assumptions, input.desired);
  const now = input.clock.now();
  const result = await executor.execute<RawOverrideRow>(sql`
    INSERT INTO plan_assumptions (id, user_id, assumptions_version, deltas, created_at, updated_at)
    VALUES (${newId()}::uuid, ${input.userId}::uuid, ${assumptions.version},
            ${JSON.stringify(deltas)}::jsonb, ${now}, ${now})
    ON CONFLICT (user_id) DO UPDATE
      SET assumptions_version = EXCLUDED.assumptions_version,
          deltas = EXCLUDED.deltas,
          updated_at = EXCLUDED.updated_at
    RETURNING id, assumptions_version, deltas, updated_at
  `);
  const row = result.rows[0];
  if (row === undefined) throw new Error('plan_assumptions upsert returned no row');
  const stored = storedOf(row);
  const paths = Object.keys(deltas).sort() as OverridablePath[];
  await appendEvent(
    platformOf(executor),
    AssumptionsOverridden.create(
      {
        assumptionsVersion: assumptions.version,
        overriddenPaths: paths,
        overrideCount: paths.length,
      },
      {
        userId: input.userId,
        aggregateId: stored.id,
        correlationId: input.correlationId,
        causationId: input.causationId ?? null,
      },
      input.clock,
    ),
  );
  return stored;
}

/** A user's stored overrides, or `null` when they have never set one. Scoped by `user_id`. */
export async function loadOverrides(
  executor: PlanningExecutor,
  userId: string,
): Promise<StoredOverrides | null> {
  const result = await executor.execute<RawOverrideRow>(sql`
    SELECT id, assumptions_version, deltas, updated_at
      FROM plan_assumptions
     WHERE user_id = ${userId}::uuid
  `);
  const row = result.rows[0];
  return row === undefined ? null : storedOf(row);
}

/**
 * The assumptions a projection for this user runs on.
 *
 * No row: the current file, no overrides. A row: its delta resolved against
 * **its** version, with the override dated in the user's zone.
 *
 * @throws {UnknownAssumptionsVersion} the row names a version this build does not hold.
 */
export async function resolveForUser(
  executor: PlanningExecutor,
  input: { readonly userId: string; readonly timeZone: string },
  registry: AssumptionsRegistry = currentRegistry(),
): Promise<ResolvedAssumptions> {
  const stored = await loadOverrides(executor, input.userId);
  if (stored === null) {
    const assumptions = loadAssumptions();
    return { version: assumptions.version, file: assumptions.file, overrides: [] };
  }
  return resolveOverrides(stored, todayIn(fixedClock(stored.updatedAt), input.timeZone), registry);
}
