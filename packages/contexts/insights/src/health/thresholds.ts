// SPDX-License-Identifier: MIT
/**
 * The health score's band thresholds — one cited data file beside the code,
 * every boundary with a source string (05-phase-5-dispatch.md §3 WP 5.8,
 * applying `docs/evidence/phase-4/wp4.2-assumptions.md`'s cited-node rule one
 * context over: "every number lives in a cited node").
 *
 * Six components, four bands each (`poor` / `fair` / `good` / `excellent`),
 * three ascending boundaries dividing them. The boundaries are always stored
 * in ascending numeric order regardless of which direction is "better" —
 * `higherIsBetter` on `ComponentBandDefinition` is what a comparison reads to
 * decide which end of the ladder a figure wants to be at — so a reviewer can
 * scan the three numbers on one line and know the ladder is complete without
 * re-deriving which end is good.
 *
 * Three boundaries are this repository's own, already-cited numbers, reused
 * rather than re-invented (07-advisory-domain.md's own rules, read at the
 * lines named below): `U7`'s 10% subscription-load review trigger, `I5`'s 10%
 * single-position concentration trigger, and WP 5.6/5.7's own $25/$50
 * materiality floors. The rest are well-known, stable personal-finance
 * guidance (CFPB, Fidelity) that this session did not re-fetch — the same
 * posture `wp4.2-assumptions.md` §9/§10 takes for the SSA bend points
 * (ssa.gov returned 403 from this sandbox): a `source` string that is honest
 * about being unverified this session is still a citation, and a silently
 * invented number is not. Every `memo` boundary is this package's own
 * graduation of the cited one, stated as such rather than attributed to a
 * source that never said it.
 */

/** The six named components, in catalogue order — `score.ts`'s own iteration order. */
export const HEALTH_COMPONENT_IDS = [
  'emergency_fund_months',
  'savings_rate',
  'debt_to_income',
  'subscription_load',
  'diversification',
  'fee_drag',
] as const;
export type HealthComponentId = (typeof HEALTH_COMPONENT_IDS)[number];

export const HEALTH_BANDS = ['poor', 'fair', 'good', 'excellent'] as const;
export type HealthBand = (typeof HEALTH_BANDS)[number];

/** Discrete per-band score, 0-100. A plain ladder: no component interpolates within a band. */
export const BAND_SCORE: Readonly<Record<HealthBand, number>> = Object.freeze({
  poor: 25,
  fair: 50,
  good: 75,
  excellent: 100,
});

/** `{ value, source, asOf?, note? }` — `wp4.2-assumptions.md`'s cited-node shape, one field over. */
export interface CitedThreshold {
  /** A decimal string: months, a ratio, or USD major units, matching `ComponentBandDefinition.unit`. */
  readonly value: string;
  readonly source: string;
  readonly asOf?: string;
  readonly note?: string;
}

export type ComponentUnit = 'months' | 'ratio' | 'usd_per_year';

export interface ComponentBandDefinition {
  readonly component: HealthComponentId;
  readonly unit: ComponentUnit;
  /** `true`: more is better (emergency fund, savings rate). `false`: less is better (everything else). */
  readonly higherIsBetter: boolean;
  /** Ascending. `[poor/fair, fair/good, good/excellent]` when `higherIsBetter`; the ladder reads in reverse otherwise. */
  readonly boundaries: readonly [CitedThreshold, CitedThreshold, CitedThreshold];
}

const ssaEraNote =
  'well-known, stable personal-finance guidance; not re-fetched this session — ' +
  'the wp4.2-assumptions.md §9 posture for a source this sandbox could not reach live.';

export const HEALTH_BAND_THRESHOLDS: Readonly<Record<HealthComponentId, ComponentBandDefinition>> =
  Object.freeze({
    emergency_fund_months: {
      component: 'emergency_fund_months',
      unit: 'months',
      higherIsBetter: true,
      boundaries: [
        {
          value: '1',
          source: 'memo: PersonalFi default — under one month is below any conventional guidance range.',
        },
        {
          value: '3',
          source:
            "Consumer Financial Protection Bureau, consumer education on emergency savings; Fidelity " +
            'Viewpoints, "How much should you have in an emergency fund?" — commonly cited lower bound ' +
            'of a 3-to-6-month range.',
          note: ssaEraNote,
        },
        {
          value: '6',
          source:
            'Same guidance, upper bound of the commonly cited 3-to-6-month range.',
          note: ssaEraNote,
        },
      ],
    },
    savings_rate: {
      component: 'savings_rate',
      unit: 'ratio',
      higherIsBetter: true,
      boundaries: [
        {
          value: '0.05',
          source: "memo: PersonalFi default — one third of Fidelity's 15% target, below.",
        },
        {
          value: '0.10',
          source: "memo: PersonalFi default — two thirds of Fidelity's 15% target, below.",
        },
        {
          value: '0.15',
          source:
            'Fidelity Viewpoints, "The 50/15/5 rule: a guideline for saving and spending" — save 15% ' +
            'of pre-tax income (including any employer match) toward retirement.',
          note: ssaEraNote,
        },
      ],
    },
    debt_to_income: {
      component: 'debt_to_income',
      unit: 'ratio',
      higherIsBetter: false,
      boundaries: [
        {
          value: '0.20',
          source: "memo: PersonalFi default — roughly half of the 43% ceiling below, named excellent.",
        },
        {
          value: '0.36',
          source:
            'Consumer Financial Protection Bureau, "What is a debt-to-income ratio?" — a DTI at or ' +
            'below 36% is commonly described as manageable.',
          note: ssaEraNote,
        },
        {
          value: '0.43',
          source:
            'Ability-to-Repay/Qualified Mortgage Rule, 12 CFR 1026.43(e)(2)(vi) — the 43% back-end ' +
            'debt-to-income ceiling for a Qualified Mortgage.',
          note: ssaEraNote,
        },
      ],
    },
    subscription_load: {
      component: 'subscription_load',
      unit: 'ratio',
      higherIsBetter: false,
      boundaries: [
        {
          value: '0.02',
          source: 'memo: PersonalFi default — one fifth of U7’s review trigger, below.',
        },
        {
          value: '0.05',
          source: 'memo: PersonalFi default — half of U7’s review trigger, below.',
        },
        {
          value: '0.10',
          source:
            '07-advisory-domain.md, rule U7: "Σ subscription annual > 10% of take-home" → "Review ' +
            'all". Generalised here from a review trigger to the poor/fair boundary of this ladder.',
        },
      ],
    },
    diversification: {
      component: 'diversification',
      unit: 'ratio',
      higherIsBetter: false,
      boundaries: [
        {
          value: '0.05',
          source: 'memo: PersonalFi default — half of I5’s concentration trigger, below.',
        },
        {
          value: '0.10',
          source:
            '07-advisory-domain.md, rule I5: "Employer stock (incl. ESPP/RSU) > 10% of investable ' +
            'assets" flagged P0. Generalised here from employer stock specifically to any single top ' +
            'position — the same 10% figure 07 already uses as a concentration trigger.',
        },
        {
          value: '0.25',
          source: 'memo: PersonalFi default — two and a half times I5’s trigger, named poor above it.',
        },
      ],
    },
    fee_drag: {
      component: 'fee_drag',
      unit: 'usd_per_year',
      higherIsBetter: false,
      boundaries: [
        {
          value: '25.00',
          source:
            "05-phase-5-dispatch.md §3 WP 5.7 / docs/evidence/phase-5/wp5.7-anomaly-fees.md §1: the " +
            "$25 anomaly materiality floor (09 Q17, ADV-5) `SnapshotBuilder` already applies.",
        },
        {
          value: '50.00',
          source:
            "05-phase-5-dispatch.md §3 WP 5.6: the Brief's own $50 ranking floor, reused by " +
            '`brief/ranking.ts`.',
        },
        {
          value: '150.00',
          source: 'memo: PersonalFi default — three times the Brief’s $50 floor, named poor above it.',
        },
      ],
    },
  });

/** Classify a decimal-space (`months`/`ratio`) figure against its component's ladder. */
export function classifyDecimal(
  componentId: HealthComponentId,
  parse: (text: string) => bigint | null,
  compare: (a: bigint, b: bigint) => number,
  figure: bigint,
): HealthBand {
  const definition = HEALTH_BAND_THRESHOLDS[componentId];
  const parsed = definition.boundaries.map((boundary) => {
    const value = parse(boundary.value);
    if (value === null) {
      throw new Error(`threshold boundary for ${componentId} does not parse: ${boundary.value}`);
    }
    return value;
  }) as [bigint, bigint, bigint];
  const [b1, b2, b3] = parsed;
  if (definition.higherIsBetter) {
    if (compare(figure, b1) < 0) return 'poor';
    if (compare(figure, b2) < 0) return 'fair';
    if (compare(figure, b3) < 0) return 'good';
    return 'excellent';
  }
  if (compare(figure, b1) < 0) return 'excellent';
  if (compare(figure, b2) < 0) return 'good';
  if (compare(figure, b3) < 0) return 'fair';
  return 'poor';
}
