// SPDX-License-Identifier: MIT
/**
 * The labelled golden set, and the harness that grades the engine against it.
 *
 * ## Where the labels come from, and why they are not the seed's
 *
 * `@core/seed`'s `SeedMerchant.category` is, in its own words, "a loose hint, not
 * a taxonomy" — twelve strings (`dining`, `groceries`, `subscriptions`, …) chosen
 * before this context existed. They cannot be the ground truth for a two-level
 * taxonomy, and not only because they are coarser: they *cut across* it. The
 * seed files Netflix, Spotify, iCloud and Adobe all under `subscriptions`, while
 * our taxonomy puts the first two under Entertainment (streaming video, streaming
 * audio) and the second two under Subscriptions (cloud storage, software). Grading
 * against the seed's strings would mark two correct answers wrong.
 *
 * So the labels are **derived and hand-checked here**, one per merchant in the
 * seed's catalogue, written down in `GROUND_TRUTH` below so they can be argued
 * with. That is the WP brief's instruction ("if the seed lacks category labels,
 * derive a labelled set from its merchant table and document it"), and this file
 * is the documentation.
 *
 * ## What is excluded, and why that is not cheating
 *
 * Transactions with no merchant — internal transfers, refunds, interest, fees —
 * are excluded from the graded set. They are excluded because they are not
 * *this* engine's job: `@ctx/ledger`'s transfer pairing already marks both legs
 * of an internal movement and the Phase 1 exit criterion for them is its own
 * ("spend totals contain zero internal transfers"). Grading them here would
 * measure the ledger's heuristic and report the number as ours. The count of
 * excluded rows is reported alongside every metric so the denominator is never
 * mistaken for the whole dataset.
 *
 * ## The train/test split
 *
 * **By date, not at random.** The first 70% of the history trains, the last 30%
 * is graded. A random split leaks: the same merchant appears on both sides with
 * near-identical descriptors, and a model that has memorised `SQ *BLUE BOTTLE
 * COFFEE` scores beautifully while learning nothing. A temporal split is also the
 * honest simulation of how the thing is actually used — the model only ever knows
 * the past.
 */
import { DateOnly, Money } from '@core/kernel';
// `@core/seed` is reached through `harness.ts` rather than imported here: that
// file is the one place in this package that carries the boundary-lint directive
// for it, so landing the policy entry proposed in the evidence document is a
// deletion in one file rather than a hunt through the suite.
import { generateDemoData } from './harness.ts';
import type { CategorizableTransaction } from '../src/index.ts';
import {
  COLD_MODEL,
  cleanDescriptor,
  decide,
  featuresOf,
  fingerprint,
  train,
} from '../src/index.ts';
import type { ClassifierModel, Decision, MerchantDefault, Rule } from '../src/index.ts';
import { UNCATEGORISED_KEY, isAssignableKey } from '../src/taxonomy.ts';

/**
 * Our category for each merchant in `@core/seed`'s catalogue.
 *
 * Hand-assigned against `packages/seed/src/merchants.ts`. Judgement calls worth
 * noting, because a reader should be able to disagree with them explicitly:
 *
 *   * Costco is `groceries.supermarkets`, not `shopping.general_merchandise` —
 *     the seed models it with grocery-sized amounts and grocery cadence.
 *   * REI is `shopping.hobbies` (sporting goods), not general merchandise.
 *   * Chase Mortgage is `debt.mortgage`, not `housing.rent`: the taxonomy files
 *     principal repayment under debt so Phase 4's payoff modelling has it.
 *   * State Farm is `insurance.auto`, the most common single line for a US
 *     household with one insurer; the seed does not say which policy it is.
 *   * Planet Fitness and Equinox are `personal_care.fitness`, not a subscription:
 *     the taxonomy files gyms with the body, not with the software.
 */
export const GROUND_TRUTH: ReadonlyMap<string, string> = new Map([
  ['Blue Bottle Coffee', 'dining.coffee'],
  ['The French Laundry', 'dining.restaurants'],
  ["Trader Joe's", 'groceries.supermarkets'],
  ['Whole Foods Market', 'groceries.supermarkets'],
  ['Costco Wholesale', 'groceries.supermarkets'],
  ['Safeway', 'groceries.supermarkets'],
  ['Amazon', 'shopping.online_marketplaces'],
  ['Target', 'shopping.general_merchandise'],
  ['Shell Oil', 'transport.fuel'],
  ['Chevron', 'transport.fuel'],
  ['Uber', 'transport.rideshare'],
  ['Lyft', 'transport.rideshare'],
  ['Netflix', 'entertainment.streaming'],
  ['Spotify', 'entertainment.music'],
  ['iCloud', 'subscriptions.cloud_storage'],
  ['Adobe Creative Cloud', 'subscriptions.software'],
  ['Planet Fitness', 'personal_care.fitness'],
  ['Equinox', 'personal_care.fitness'],
  ['Kaiser Permanente', 'health.primary_care'],
  ['CVS Pharmacy', 'health.pharmacy'],
  ['PG&E', 'utilities.electricity_and_gas'],
  ['Comcast Xfinity', 'utilities.internet'],
  ['AT&T Wireless', 'utilities.mobile_phone'],
  ['State Farm Insurance', 'insurance.auto'],
  ['Chase Mortgage', 'debt.mortgage'],
  ['AMC Theatres', 'entertainment.events'],
  ["Dave's Hot Chicken", 'dining.fast_food'],
  ['Philz Coffee', 'dining.coffee'],
  ['REI', 'shopping.hobbies'],
  ['Delta Air Lines', 'travel.flights'],
  ['Marriott Hotels', 'travel.lodging'],
  ['Acme Corp Payroll', 'income.salary'],
]);

/**
 * The PFC v2 code a provider would plausibly send for each merchant.
 *
 * **Read the caveat before reading the number this produces.** These codes are
 * written by us, so the provider-tier accuracy they yield measures the *mapping
 * table*, not the provider — it answers "if Plaid sends `FOOD_AND_DRINK_COFFEE`
 * for Blue Bottle, does our map put it in the right place?" and nothing more.
 * It cannot measure whether Plaid's enrichment is any good, because the seed
 * carries no provider categories at all (`@core/seed` predates this context and
 * models a raw descriptor, which is the harder and more useful thing).
 *
 * They are deliberately *not* one-to-one with `GROUND_TRUTH`. Four of them are
 * coarser than the truth — Plaid has no "coffee vs restaurant" distinction for
 * Philz, no separate code for a gym franchise's membership — so the provider tier
 * is expected to get those wrong, and the evidence document reports that it does.
 * A synthetic provider signal that agreed with the labels everywhere would prove
 * only that this map was written twice.
 */
export const SYNTHETIC_PFC: ReadonlyMap<string, string> = new Map([
  ['Blue Bottle Coffee', 'FOOD_AND_DRINK_COFFEE'],
  ['The French Laundry', 'FOOD_AND_DRINK_RESTAURANT'],
  ["Trader Joe's", 'FOOD_AND_DRINK_GROCERIES'],
  ['Whole Foods Market', 'FOOD_AND_DRINK_GROCERIES'],
  ['Costco Wholesale', 'GENERAL_MERCHANDISE_SUPERSTORES'],
  ['Safeway', 'FOOD_AND_DRINK_GROCERIES'],
  ['Amazon', 'GENERAL_MERCHANDISE_ONLINE_MARKETPLACES'],
  ['Target', 'GENERAL_MERCHANDISE_DEPARTMENT_STORES'],
  ['Shell Oil', 'TRANSPORTATION_GAS'],
  ['Chevron', 'TRANSPORTATION_GAS'],
  ['Uber', 'TRANSPORTATION_TAXIS_AND_RIDE_SHARES'],
  ['Lyft', 'TRANSPORTATION_TAXIS_AND_RIDE_SHARES'],
  ['Netflix', 'ENTERTAINMENT_TV_AND_MOVIES'],
  ['Spotify', 'ENTERTAINMENT_MUSIC_AND_AUDIO'],
  ['iCloud', 'GENERAL_MERCHANDISE_ELECTRONICS'],
  ['Adobe Creative Cloud', 'GENERAL_MERCHANDISE_ELECTRONICS'],
  ['Planet Fitness', 'PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS'],
  ['Equinox', 'PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS'],
  ['Kaiser Permanente', 'MEDICAL_PRIMARY_CARE'],
  ['CVS Pharmacy', 'MEDICAL_PHARMACIES_AND_SUPPLEMENTS'],
  ['PG&E', 'RENT_AND_UTILITIES_GAS_AND_ELECTRICITY'],
  ['Comcast Xfinity', 'RENT_AND_UTILITIES_INTERNET_AND_CABLE'],
  ['AT&T Wireless', 'RENT_AND_UTILITIES_TELEPHONE'],
  ['State Farm Insurance', 'GENERAL_SERVICES_INSURANCE'],
  ['Chase Mortgage', 'LOAN_PAYMENTS_MORTGAGE_PAYMENT'],
  ['AMC Theatres', 'ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS'],
  ["Dave's Hot Chicken", 'FOOD_AND_DRINK_FAST_FOOD'],
  ['Philz Coffee', 'FOOD_AND_DRINK_RESTAURANT'],
  ['REI', 'GENERAL_MERCHANDISE_SPORTING_GOODS'],
  ['Delta Air Lines', 'TRAVEL_FLIGHTS'],
  ['Marriott Hotels', 'TRAVEL_LODGING'],
  ['Acme Corp Payroll', 'INCOME_SALARY'],
]);

export interface LabelledTransaction extends CategorizableTransaction {
  readonly expectedKey: string;
  readonly merchantName: string;
}

export interface GoldenDataset {
  readonly train: readonly LabelledTransaction[];
  readonly test: readonly LabelledTransaction[];
  /** Rows with no merchant: transfers, refunds, interest, fees. Not graded. */
  readonly excluded: number;
  readonly merchantCount: number;
}

export interface BuildOptions {
  readonly seed?: number;
  /** Fraction of the date-ordered history used for training. */
  readonly trainFraction?: number;
  /** Attach a synthetic `provider_category` to every row. */
  readonly withProviderCategory?: boolean;
}

export function buildGoldenDataset(options: BuildOptions = {}): GoldenDataset {
  const dataset = generateDemoData(options.seed ?? 1);
  const merchantsById = new Map(dataset.merchants.map((merchant) => [merchant.id, merchant]));
  const accountsById = new Map(dataset.accounts.map((account) => [account.id, account]));

  const labelled: LabelledTransaction[] = [];
  let excluded = 0;

  for (const transaction of dataset.transactions) {
    const merchant =
      transaction.merchantId === null ? undefined : merchantsById.get(transaction.merchantId);
    const expectedKey =
      merchant === undefined ? undefined : GROUND_TRUTH.get(merchant.canonicalName);
    if (merchant === undefined || expectedKey === undefined) {
      excluded += 1;
      continue;
    }

    const amount = Money.fromJSON(transaction.amount);
    const account = accountsById.get(transaction.accountId);
    const pfc = SYNTHETIC_PFC.get(merchant.canonicalName);

    labelled.push({
      id: transaction.id,
      accountId: transaction.accountId,
      accountType: ledgerAccountType(account?.type ?? null),
      // The *raw descriptor* is the payee, deliberately: the seed supplies the
      // clean `canonicalName` too, and handing that to the engine would skip the
      // entire normalisation pipeline and inflate every number below.
      payee: transaction.descriptorRaw,
      rawDescriptor: transaction.descriptorRaw,
      providerMerchantName: null,
      // **Our** merchant key, not the seed's `merchantId`.
      //
      // Handing the engine the seed's own merchant id would give it a perfect
      // grouping for free, and the merchant-memory tier would then be a lookup
      // table keyed on the answer — which scored a flattering and meaningless
      // 100% in the first run of this harness. In production the merchant id
      // comes from normalising the descriptor, so here it comes from normalising
      // the descriptor too: every wrongly-split or wrongly-merged cluster costs
      // accuracy, exactly as it would in the app.
      merchantId: merchantKeyOf(transaction.descriptorRaw),
      amountMinor: amount.minor,
      currency: amount.currency,
      date: DateOnly.parse(transaction.postedOn),
      providerCategory:
        options.withProviderCategory === true && pfc !== undefined
          ? { primary: primaryOf(pfc), detailed: pfc, confidence_level: 'HIGH' }
          : null,
      mcc: null,
      isTransfer: false,
      userCategoryId: null,
      expectedKey,
      merchantName: merchant.canonicalName,
    });
  }

  labelled.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const splitAt = Math.floor(labelled.length * (options.trainFraction ?? 0.7));

  return {
    train: labelled.slice(0, splitAt),
    test: labelled.slice(splitAt),
    excluded,
    merchantCount: new Set(labelled.map((entry) => entry.merchantName)).size,
  };
}

/**
 * A merchant identifier derived the way the app derives one: by cleaning the
 * descriptor and fingerprinting it. Two descriptors that our pipeline fails to
 * converge become two merchants here, and the accuracy number pays for it.
 */
function merchantKeyOf(descriptor: string): string {
  return fingerprint(cleanDescriptor(descriptor).cleaned);
}

function primaryOf(detailed: string): string {
  // The primary is the code minus its detail suffix; for the synthetic codes
  // above, the known primaries are enumerated here rather than parsed, because
  // every primary contains underscores and splitting on one gets it wrong.
  const primaries = [
    'FOOD_AND_DRINK',
    'GENERAL_MERCHANDISE',
    'GENERAL_SERVICES',
    'TRANSPORTATION',
    'ENTERTAINMENT',
    'PERSONAL_CARE',
    'MEDICAL',
    'RENT_AND_UTILITIES',
    'LOAN_PAYMENTS',
    'TRAVEL',
    'INCOME',
  ];
  return primaries.find((primary) => detailed.startsWith(`${primary}_`)) ?? detailed;
}

function ledgerAccountType(seedType: string | null): string | null {
  switch (seedType) {
    case 'checking':
    case 'savings':
      return 'depository';
    case 'credit_card':
      return 'credit';
    case 'brokerage':
      return 'investment';
    case 'crypto_exchange':
      return 'crypto';
    case 'mortgage':
      return 'loan';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Running a configuration
// ---------------------------------------------------------------------------

export interface EvaluationConfig {
  readonly name: string;
  readonly rules?: readonly Rule[];
  /** Learn merchant defaults from the training split. */
  readonly useMerchantDefaults?: boolean;
  /** Train the classifier on the training split. */
  readonly useClassifier?: boolean;
  /** Let the provider tier see the synthetic PFC codes. */
  readonly useProvider?: boolean;
  readonly confidenceFloor?: number;
}

export interface EvaluationResult {
  readonly config: string;
  readonly total: number;
  /** Decided as something other than `uncategorised`. */
  readonly decided: number;
  readonly correct: number;
  readonly incorrect: number;
  readonly abstained: number;
  /** correct / decided — of the answers it gave, how many were right. */
  readonly precision: number;
  /** correct / total — of everything, how much it got right. 04's "accuracy". */
  readonly recall: number;
  readonly abstainRate: number;
  /** correct / total, counting only rows it answered at all. */
  readonly coverage: number;
  readonly bySource: Readonly<Record<string, { decided: number; correct: number }>>;
  /** The worst offenders, for the failure report. */
  readonly topErrors: readonly { merchant: string; expected: string; got: string; count: number }[];
}

export function evaluate(dataset: GoldenDataset, config: EvaluationConfig): EvaluationResult {
  const classifier: ClassifierModel =
    config.useClassifier === true
      ? train(
          dataset.train.map((entry) => ({
            features: featuresOf({
              cleanedPayee: cleanDescriptor(entry.rawDescriptor).cleaned,
              amountMinor: entry.amountMinor,
              accountType: entry.accountType,
              mcc: entry.mcc,
            }),
            categoryKey: entry.expectedKey,
          })),
        )
      : COLD_MODEL;

  const merchantDefaults = new Map<string, MerchantDefault>();
  if (config.useMerchantDefaults === true) {
    const support = new Map<string, Map<string, number>>();
    for (const entry of dataset.train) {
      if (entry.merchantId === null) continue;
      const perMerchant = support.get(entry.merchantId) ?? new Map<string, number>();
      perMerchant.set(entry.expectedKey, (perMerchant.get(entry.expectedKey) ?? 0) + 1);
      support.set(entry.merchantId, perMerchant);
    }
    for (const [merchantId, counts] of support) {
      const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      if (best === undefined) continue;
      merchantDefaults.set(merchantId, {
        categoryKey: best[0],
        locked: false,
        supportCount: best[1],
      });
    }
  }

  let decided = 0;
  let correct = 0;
  let abstained = 0;
  const bySource: Record<string, { decided: number; correct: number }> = {};
  const errors = new Map<
    string,
    { merchant: string; expected: string; got: string; count: number }
  >();

  for (const entry of dataset.test) {
    const decision: Decision = decide(
      {
        transactionId: entry.id,
        payee: entry.payee,
        cleanedPayee: cleanDescriptor(entry.rawDescriptor).cleaned,
        amountMinor: entry.amountMinor,
        currency: entry.currency,
        accountId: entry.accountId,
        accountType: entry.accountType,
        date: entry.date,
        providerCategory: config.useProvider === true ? entry.providerCategory : null,
        mcc: entry.mcc,
        isTransfer: entry.isTransfer,
        userCategoryId: null,
      },
      {
        rules: config.rules ?? [],
        merchantDefault:
          entry.merchantId === null ? null : (merchantDefaults.get(entry.merchantId) ?? null),
        classifier,
        confidenceFloor: config.confidenceFloor ?? 0.6,
        merchantSupportThreshold: 3,
      },
    );

    if (decision.categoryKey === UNCATEGORISED_KEY || decision.source === 'none') {
      abstained += 1;
      continue;
    }
    decided += 1;
    const bucket = (bySource[decision.source] ??= { decided: 0, correct: 0 });
    bucket.decided += 1;

    if (decision.categoryKey === entry.expectedKey) {
      correct += 1;
      bucket.correct += 1;
      continue;
    }
    const key = `${entry.merchantName}|${entry.expectedKey}|${decision.categoryKey}`;
    const existing = errors.get(key);
    if (existing === undefined) {
      errors.set(key, {
        merchant: entry.merchantName,
        expected: entry.expectedKey,
        got: decision.categoryKey,
        count: 1,
      });
    } else {
      errors.set(key, { ...existing, count: existing.count + 1 });
    }
  }

  const total = dataset.test.length;
  return {
    config: config.name,
    total,
    decided,
    correct,
    incorrect: decided - correct,
    abstained,
    precision: decided === 0 ? 0 : correct / decided,
    recall: total === 0 ? 0 : correct / total,
    abstainRate: total === 0 ? 0 : abstained / total,
    coverage: total === 0 ? 0 : decided / total,
    bySource,
    topErrors: [...errors.values()].sort((a, b) => b.count - a.count).slice(0, 8),
  };
}

/**
 * Rules a user would plausibly write for this dataset.
 *
 * Four, not forty. They exist to exercise the rule tier and to demonstrate that
 * a rule beats the tiers below it, not to inflate the accuracy number — writing
 * one rule per merchant would produce 100% and measure nothing except that
 * `matchRule` works. Each of these is the kind of rule the "always categorise X
 * as Y" button produces, plus one amount-conditioned rule and one that only
 * applies to a particular account.
 */
export function sampleRules(userId: string): readonly Rule[] {
  const rule = (
    index: number,
    name: string,
    conditions: Rule['conditions'],
    categoryKey: string,
  ): Rule => ({
    id: `00000000-0000-7000-8000-0000000000${String(index).padStart(2, '0')}`,
    userId,
    name,
    priority: 100 + index,
    enabled: true,
    conditions,
    actions: [{ type: 'set_category', categoryKey }],
    runOnSync: true,
    stopProcessing: false,
    createdFromTransactionId: null,
  });

  const rules = [
    rule(
      1,
      'Amazon is shopping',
      { all: [{ type: 'payee', match: 'contains', value: 'AMAZON' }], any: [] },
      'shopping.online_marketplaces',
    ),
    rule(
      2,
      'Philz is coffee',
      { all: [{ type: 'payee', match: 'contains', value: 'PHILZ' }], any: [] },
      'dining.coffee',
    ),
    rule(
      3,
      'iCloud is cloud storage',
      { all: [{ type: 'payee', match: 'contains', value: 'ICLOUD' }], any: [] },
      'subscriptions.cloud_storage',
    ),
    rule(
      4,
      'Big Costco runs are still groceries',
      {
        all: [
          { type: 'payee', match: 'contains', value: 'COSTCO' },
          { type: 'amount', minMinor: null, maxMinor: '-5000', absolute: false },
        ],
        any: [],
      },
      'groceries.supermarkets',
    ),
  ];

  for (const entry of rules) {
    if (!isAssignableKey((entry.actions[0] as { categoryKey: string }).categoryKey)) {
      throw new Error(`sample rule ${entry.name} names a category that is not a leaf`);
    }
  }
  return rules;
}

/**
 * Leave-one-merchant-out: how well does it do on a merchant it has never seen?
 *
 * This is the number that keeps the headline honest. The seed has 32 merchants
 * with clean, consistent descriptor families and 24 months of history, so once
 * merchant memory has warmed up, "accuracy" mostly measures whether the same
 * merchant looks the same twice — which it does, and which is why the full-stack
 * figure is so high. Real data has a long tail: a restaurant visited once, a
 * contractor paid once, a shop that closed.
 *
 * So for each merchant in turn, everything about that merchant is removed from
 * training and the engine is graded on its transactions cold. Merchant memory
 * has nothing; the classifier has only the amount bucket, the account type, the
 * direction, and whatever tokens this merchant happens to share with others; the
 * provider tier is the only one with a real signal, which is exactly the argument
 * for having it at all.
 *
 * Reported, not gated. The Phase 1 exit criterion is about seeded data as a
 * whole, and gating on a number the seed cannot fairly produce would be theatre.
 */
export function evaluateColdMerchants(
  dataset: GoldenDataset,
  config: EvaluationConfig,
): EvaluationResult {
  const merchants = [...new Set(dataset.train.map((entry) => entry.merchantName))];
  const combined: EvaluationResult[] = [];

  for (const merchant of merchants) {
    const held: GoldenDataset = {
      train: dataset.train.filter((entry) => entry.merchantName !== merchant),
      test: dataset.test.filter((entry) => entry.merchantName === merchant),
      excluded: dataset.excluded,
      merchantCount: dataset.merchantCount - 1,
    };
    if (held.test.length === 0) continue;
    combined.push(evaluate(held, config));
  }

  const total = combined.reduce((sum, result) => sum + result.total, 0);
  const decided = combined.reduce((sum, result) => sum + result.decided, 0);
  const correct = combined.reduce((sum, result) => sum + result.correct, 0);
  const abstained = combined.reduce((sum, result) => sum + result.abstained, 0);

  return {
    config: `${config.name} (cold merchant)`,
    total,
    decided,
    correct,
    incorrect: decided - correct,
    abstained,
    precision: decided === 0 ? 0 : correct / decided,
    recall: total === 0 ? 0 : correct / total,
    abstainRate: total === 0 ? 0 : abstained / total,
    coverage: total === 0 ? 0 : decided / total,
    bySource: {},
    topErrors: combined
      .flatMap((result) => result.topErrors)
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
  };
}
