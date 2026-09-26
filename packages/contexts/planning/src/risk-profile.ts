// SPDX-License-Identifier: MIT
/**
 * The risk questionnaire, its consistency penalty, and the tax-bracket band
 * (WP 4.1).
 *
 * ## What the instrument is for
 *
 * 02 §3's Wealthfront Path row names the feature: *"risk questionnaire with a
 * consistency penalty"*. The failure it exists to stop is specific. People
 * describe themselves as braver than they behave — the classic finding behind
 * every serious risk instrument is that stated tolerance collapses in the first
 * real drawdown — and a questionnaire that simply averages what someone *says*
 * with what they have *done* launders the inconsistency into a confident
 * middle score. Averaging "I would buy more" (5) with "I sold most of it" (1)
 * gives a 3, which is a portfolio the holder has already demonstrated he will
 * sell at the bottom.
 *
 * So each **disposition** is asked in two framings:
 *
 *   * **stated** — a hypothetical or a self-description ("what would you do?");
 *   * **revealed** — what the holder has actually done or actually holds.
 *
 * and when the two disagree the disposition is credited with the **more
 * conservative** of the two, never the mean. The distance between what
 * averaging would have credited and what was credited is the **consistency
 * penalty**; it is stored on the row, shown, and explained line by line.
 *
 * ## The arithmetic, exactly
 *
 * Every option is worth 1–5 points (1 = most conservative). For a disposition
 * with stated points `s` and revealed points `r`:
 *
 *     unpenalised_d = s + r            (what averaging credits, doubled)
 *     credited_d    = 2 × min(s, r)    (the conservative framing, doubled)
 *     penalty_d     = unpenalised_d − credited_d = |s − r|
 *
 * Doubling keeps every quantity an integer — a mean of 3.5 is 7 points — so the
 * score is a small whole number and the penalty is exactly `Σ |s − r|`, which a
 * reader can check on their fingers. Over three dispositions the composite runs
 * 6–30 and the penalty 0–12.
 *
 * A revealed framing may be answered **"no evidence"** ("I haven't been through
 * a fall like that"). That is not inconsistency, but it is not confirmation
 * either, so it is credited as `r = min(s, 3)`: a stated answer at or below the
 * midpoint stands unpenalised, and one above it is credited only up to the
 * midpoint until behaviour confirms it. The penalty that produces is
 * `max(0, s − 3)` and the explanation says why in words.
 *
 * ## Why a pure function over the stored document
 *
 * `tolerance` is **derived, never typed in**, and `deriveTolerance(answers)`
 * reads nothing but the `answers` JSONB exactly as the row stores it — the
 * instrument version and one option id per item. There is no hidden input, so
 * the score on any stored row can be re-derived from that row alone years
 * later, and `test/risk-profile.test.ts` does exactly that. An instrument
 * change is a new version (`risk-v2`); `deriveTolerance` refuses a version it
 * does not know rather than scoring old answers against new points.
 *
 * ## The band
 *
 * 08 §4.2 and the published `risk.profile` scope: the tax bracket crosses as a
 * **band, never a figure**. `taxBracketBand` takes a taxable income and a
 * bracket schedule, returns `'10-12'`, `'22-32'` or `'35-37'`, and the income
 * goes no further — `buildRiskProfileRecord` has no field it could be written
 * to. The schedule is an **input**, not a constant here: 07 Appendix A says the
 * thresholds are *"keyed by year, never inlined in code"*, and WP 4.2's
 * assumptions file is where they live.
 */
import { Money, newId, type Clock } from '@core/kernel';
import { appendEvent } from '@core/platform';
import type { LiquidityNeed, RiskTolerance } from '../schema/goals.ts';
import { LIQUIDITY_NEEDS, RISK_TOLERANCES } from '../schema/goals.ts';
import type { FilingStatus } from './assumptions.ts';
import { PlanningError } from './errors.ts';
import { RiskProfileAnswered } from './events.ts';
import {
  insertRiskProfile,
  latestRiskProfile,
  riskProfileHistory,
  type StoredRiskProfile,
} from './goals-store.ts';
import { platformOf, type PlanningExecutor } from './store.ts';

// ---------------------------------------------------------------------------
// The instrument
// ---------------------------------------------------------------------------

export const RISK_INSTRUMENT_VERSION = 'risk-v1' as const;
export type RiskInstrumentVersion = typeof RISK_INSTRUMENT_VERSION;

export const RISK_DISPOSITIONS = ['drawdown', 'volatility', 'risk_identity'] as const;
export type RiskDisposition = (typeof RISK_DISPOSITIONS)[number];

export const RISK_FRAMINGS = ['stated', 'revealed'] as const;
export type RiskFraming = (typeof RISK_FRAMINGS)[number];

/** `'drawdown.stated'` — the key an answer is stored under. */
export type RiskItemId = `${RiskDisposition}.${RiskFraming}`;

/** 1 (most conservative) to 5, or `null` for a revealed "no evidence" answer. */
export type RiskPoints = 1 | 2 | 3 | 4 | 5;

export interface RiskOption {
  readonly id: string;
  readonly label: string;
  readonly points: RiskPoints | null;
}

export interface RiskItem {
  readonly id: RiskItemId;
  readonly disposition: RiskDisposition;
  readonly framing: RiskFraming;
  readonly prompt: string;
  readonly options: readonly RiskOption[];
}

function option(id: string, points: RiskPoints | null, label: string): RiskOption {
  return Object.freeze({ id, points, label });
}

/**
 * `risk-v1`. Three dispositions, two framings each. Option ids are stored;
 * labels and prompts are presentation and may be reworded without a version
 * bump. **Points may not change without a new version** — that would silently
 * re-score every stored profile.
 */
const RISK_ITEMS: readonly RiskItem[] = [
  {
    id: 'drawdown.stated',
    disposition: 'drawdown',
    framing: 'stated',
    prompt:
      'Suppose your long-term investments fell 25% over a few months, and nobody could ' +
      'tell you whether they would fall further. What would you do?',
    options: [
      option('sell_all', 1, 'Sell everything and move to cash'),
      option('sell_some', 2, 'Sell some of it to limit further losses'),
      option('hold_pause', 3, 'Hold, but stop adding new money until it recovers'),
      option('hold', 4, 'Hold and keep contributing as planned'),
      option('buy_more', 5, 'Invest extra while prices are lower'),
    ],
  },
  {
    id: 'drawdown.revealed',
    disposition: 'drawdown',
    framing: 'revealed',
    prompt:
      'Think of the last time investments you held fell sharply — 2022, March 2020, or any ' +
      'fall of 20% or more. What did you actually do at the time?',
    options: [
      option('sold_all', 1, 'I sold all or most of it'),
      option('sold_some', 2, 'I sold some of it'),
      option('paused', 3, 'I kept it but stopped or cut my contributions'),
      option('held', 4, 'I changed nothing'),
      option('bought', 5, 'I added money on purpose because prices had fallen'),
      option('no_evidence', null, "I haven't held investments through a fall like that"),
    ],
  },
  {
    id: 'volatility.stated',
    disposition: 'volatility',
    framing: 'stated',
    prompt:
      'You invest $10,000 for one year. Which range of possible outcomes would you choose? ' +
      'Wider ranges have higher average outcomes.',
    options: [
      option('range_narrowest', 1, '$9,800 to $10,600'),
      option('range_narrow', 2, '$9,200 to $11,000'),
      option('range_middle', 3, '$8,500 to $11,500'),
      option('range_wide', 4, '$7,500 to $12,200'),
      option('range_widest', 5, '$6,500 to $13,000'),
    ],
  },
  {
    id: 'volatility.revealed',
    disposition: 'volatility',
    framing: 'revealed',
    prompt:
      'Roughly what share of your long-term savings is in stocks or stock funds today, ' +
      'counting retirement accounts?',
    options: [
      option('stocks_under_20', 1, 'Less than a fifth'),
      option('stocks_20_to_40', 2, 'A fifth to two fifths'),
      option('stocks_40_to_60', 3, 'About half'),
      option('stocks_60_to_80', 4, 'Three fifths to four fifths'),
      option('stocks_over_80', 5, 'More than four fifths'),
      option('no_evidence', null, "I don't have long-term savings invested yet"),
    ],
  },
  {
    id: 'risk_identity.stated',
    disposition: 'risk_identity',
    framing: 'stated',
    prompt: 'How would you describe yourself when it comes to financial risk?',
    options: [
      option('avoid', 1, 'I avoid it wherever I can'),
      option('cautious', 2, 'I accept a little, reluctantly'),
      option('balanced', 3, 'I weigh it against the reward, case by case'),
      option('willing', 4, 'I am comfortable with it for a better long-run return'),
      option('seek', 5, 'I look for it; higher risk is how returns are earned'),
    ],
  },
  {
    id: 'risk_identity.revealed',
    disposition: 'risk_identity',
    framing: 'revealed',
    prompt:
      'Over the last few years, when you had money to set aside, where did most of it ' +
      'actually go?',
    options: [
      option('cash', 1, 'A savings account or cash'),
      option('mostly_safe', 2, 'Mostly cash or bonds, a little in stocks'),
      option('split', 3, 'Roughly even between safe savings and stock investments'),
      option('mostly_stocks', 4, 'Mostly stock investments'),
      option('concentrated', 5, 'Individual stocks, crypto, or other concentrated bets'),
      option('no_evidence', null, 'I have not had money to set aside'),
    ],
  },
];

export const RISK_INSTRUMENT: readonly RiskItem[] = Object.freeze(
  RISK_ITEMS.map((item) => Object.freeze({ ...item, options: Object.freeze([...item.options]) })),
);

const ITEMS_BY_ID: ReadonlyMap<string, RiskItem> = new Map(
  RISK_INSTRUMENT.map((item) => [item.id, item]),
);

/** The points "no evidence" is credited at: the instrument's midpoint. */
export const NO_EVIDENCE_CEILING: RiskPoints = 3;

/**
 * Composite (6–30) → tolerance. Five equal bands of five points. The lower
 * bound of each band is inclusive; a composite below 6 cannot occur.
 */
export const TOLERANCE_BANDS: readonly {
  readonly tolerance: RiskTolerance;
  readonly minPoints: number;
}[] = Object.freeze([
  { tolerance: 'aggressive', minPoints: 26 },
  { tolerance: 'moderate_aggressive', minPoints: 21 },
  { tolerance: 'moderate', minPoints: 16 },
  { tolerance: 'moderate_conservative', minPoints: 11 },
  { tolerance: 'conservative', minPoints: 0 },
]);

export function toleranceFor(points: number): RiskTolerance {
  for (const band of TOLERANCE_BANDS) if (points >= band.minPoints) return band.tolerance;
  return 'conservative';
}

// ---------------------------------------------------------------------------
// The stored document, and the derivation over it
// ---------------------------------------------------------------------------

/**
 * Exactly what `risk_profile.answers` holds, and **all** that it holds —
 * `risk_profile_answers_are_well_formed` refuses any other key, and any value
 * that is not an option id beginning with a letter.
 */
export interface RiskAnswers {
  readonly instrument: RiskInstrumentVersion;
  readonly items: Readonly<Record<RiskItemId, string>>;
}

export interface DispositionScore {
  readonly disposition: RiskDisposition;
  readonly statedOption: string;
  readonly revealedOption: string;
  readonly stated: RiskPoints;
  /** The revealed points as credited: `min(s, 3)` when the answer was "no evidence". */
  readonly revealed: RiskPoints;
  readonly revealedWasNoEvidence: boolean;
  /** `s + r`: what averaging the two framings would have credited, doubled. */
  readonly unpenalised: number;
  /** `2 × min(s, r)`: the more conservative framing, doubled. */
  readonly credited: number;
  /** `|s − r|`. */
  readonly penalty: number;
}

export interface ToleranceDerivation {
  readonly instrument: RiskInstrumentVersion;
  readonly tolerance: RiskTolerance;
  /** Σ credited. Stored as `risk_profile.composite_score`. */
  readonly compositeScore: number;
  /** Σ unpenalised. Stored as `risk_profile.unpenalised_score`. */
  readonly unpenalisedScore: number;
  /** Σ penalty = unpenalised − composite. Stored as `risk_profile.consistency_penalty`. */
  readonly consistencyPenalty: number;
  /** What the tolerance would have been had the framings been averaged. */
  readonly toleranceIfAveraged: RiskTolerance;
  readonly dispositions: readonly DispositionScore[];
  /** One sentence per disposition, then the total. Shown to the holder verbatim. */
  readonly explanation: readonly string[];
}

function refuse(message: string): never {
  throw new PlanningError('planning.risk_answers_invalid', message);
}

function optionOf(item: RiskItem, optionId: unknown): RiskOption {
  if (typeof optionId !== 'string') {
    refuse(`${item.id}: expected an option id string, got ${typeof optionId}`);
  }
  const found = item.options.find((candidate) => candidate.id === optionId);
  if (found === undefined) refuse(`${item.id}: '${optionId}' is not an option of ${item.id}`);
  return found;
}

const DISPOSITION_LABEL: Readonly<Record<RiskDisposition, string>> = {
  drawdown: 'Falls in value',
  volatility: 'Range of outcomes',
  risk_identity: 'Attitude to risk',
};

function halves(points: number): string {
  return points % 2 === 0 ? String(points / 2) : `${String((points - 1) / 2)}.5`;
}

/**
 * The one pure function the tolerance comes from.
 *
 * Accepts `unknown` because its real input is a JSONB document read back from
 * Postgres, and it validates everything: an unknown instrument version, a
 * missing item, an extra item, or an option id the item does not offer is a
 * `planning.risk_answers_invalid` — never a partial score.
 */
export function deriveTolerance(answers: unknown): ToleranceDerivation {
  if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) {
    refuse('answers must be an object');
  }
  const document = answers as Record<string, unknown>;
  const keys = Object.keys(document).sort();
  if (keys.length !== 2 || keys[0] !== 'instrument' || keys[1] !== 'items') {
    refuse(`answers must hold exactly {instrument, items}; got {${keys.join(', ')}}`);
  }
  if (document['instrument'] !== RISK_INSTRUMENT_VERSION) {
    refuse(
      `instrument ${JSON.stringify(document['instrument'])} is not ${RISK_INSTRUMENT_VERSION}; ` +
        'answers are never re-scored against a different instrument',
    );
  }
  const items = document['items'];
  if (items === null || typeof items !== 'object' || Array.isArray(items)) {
    refuse('answers.items must be an object');
  }
  const given = items as Record<string, unknown>;
  for (const key of Object.keys(given)) {
    if (!ITEMS_BY_ID.has(key)) refuse(`'${key}' is not an item of ${RISK_INSTRUMENT_VERSION}`);
  }

  const dispositions: DispositionScore[] = [];
  const explanation: string[] = [];
  for (const disposition of RISK_DISPOSITIONS) {
    const statedItem = ITEMS_BY_ID.get(`${disposition}.stated`);
    const revealedItem = ITEMS_BY_ID.get(`${disposition}.revealed`);
    if (statedItem === undefined || revealedItem === undefined) {
      throw new Error(`instrument ${RISK_INSTRUMENT_VERSION} lacks a framing of ${disposition}`);
    }
    if (!(statedItem.id in given)) refuse(`${statedItem.id} is unanswered`);
    if (!(revealedItem.id in given)) refuse(`${revealedItem.id} is unanswered`);
    const statedOption = optionOf(statedItem, given[statedItem.id]);
    const revealedOption = optionOf(revealedItem, given[revealedItem.id]);
    const stated = statedOption.points;
    if (stated === null) throw new Error(`${statedItem.id} offers an option with no points`);

    const noEvidence = revealedOption.points === null;
    const revealed: RiskPoints = noEvidence
      ? (Math.min(stated, NO_EVIDENCE_CEILING) as RiskPoints)
      : (revealedOption.points as RiskPoints);

    const unpenalised = stated + revealed;
    const credited = 2 * Math.min(stated, revealed);
    const penalty = unpenalised - credited;
    dispositions.push({
      disposition,
      statedOption: statedOption.id,
      revealedOption: revealedOption.id,
      stated,
      revealed,
      revealedWasNoEvidence: noEvidence,
      unpenalised,
      credited,
      penalty,
    });

    const label = DISPOSITION_LABEL[disposition];
    if (noEvidence && penalty > 0) {
      explanation.push(
        `${label}: you said "${statedOption.label}" (${String(stated)}), and there is no ` +
          `past behaviour to confirm it yet, so it is credited at the midpoint ` +
          `(${String(NO_EVIDENCE_CEILING)}) until there is. Penalty ${String(penalty)}.`,
      );
    } else if (penalty > 0) {
      explanation.push(
        `${label}: you said "${statedOption.label}" (${String(stated)}), but what you have ` +
          `actually done or hold is "${revealedOption.label}" (${String(revealed)}). ` +
          `The score takes the more conservative answer, ${String(Math.min(stated, revealed))}, ` +
          `not the average, ${halves(unpenalised)}. Penalty ${String(penalty)}.`,
      );
    } else {
      explanation.push(`${label}: both answers agree at ${String(stated)}. No penalty.`);
    }
  }

  const compositeScore = dispositions.reduce((total, row) => total + row.credited, 0);
  const unpenalisedScore = dispositions.reduce((total, row) => total + row.unpenalised, 0);
  const consistencyPenalty = unpenalisedScore - compositeScore;
  const tolerance = toleranceFor(compositeScore);
  const toleranceIfAveraged = toleranceFor(unpenalisedScore);

  explanation.push(
    consistencyPenalty === 0
      ? `Total ${String(compositeScore)} of 30: ${tolerance}. Your answers were consistent.`
      : `Total ${String(compositeScore)} of 30: ${tolerance}. Averaging the two framings ` +
          `would have given ${String(unpenalisedScore)} (${toleranceIfAveraged}); the ` +
          `${String(consistencyPenalty)}-point consistency penalty is the difference.`,
  );

  return Object.freeze({
    instrument: RISK_INSTRUMENT_VERSION,
    tolerance,
    compositeScore,
    unpenalisedScore,
    consistencyPenalty,
    toleranceIfAveraged,
    dispositions: Object.freeze(dispositions),
    explanation: Object.freeze(explanation),
  });
}

// ---------------------------------------------------------------------------
// The tax-bracket band
// ---------------------------------------------------------------------------

/**
 * One year's ordinary-income brackets for one filing status.
 *
 * Structurally the `value` of one of WP 4.2's `brackets` nodes
 * (`data/us-2026.ts`, `{ over: Money, rate: '0.22' }[]`), with the year,
 * status and citation carried alongside; `FilingStatus` is WP 4.2's
 * (`single | mfj | mfs | hoh`), not a second vocabulary.
 *
 * `rate` is a decimal-string ratio (`'0.22'`), never a `number`. `over` is the
 * taxable income *above* which `rate` applies — Rev. Proc. 2025-32's own
 * phrasing ("22% > $50,400") — so the first bracket's `over` is zero and an
 * income exactly on a threshold stays in the lower bracket.
 */
export interface BracketSchedule {
  readonly taxYear: number;
  readonly filingStatus: FilingStatus;
  readonly brackets: readonly { readonly rate: string; readonly over: Money }[];
  readonly source: string;
  readonly asOf: string;
}

/**
 * Which brackets share a band, by index into a seven-bracket schedule.
 *
 * Three bands, following 08 §4.2's own example (`'22-32'`): low (10–12%),
 * middle (22–32%), high (35–37%). Coarse on purpose — the middle band spans
 * roughly $50k to $256k of single-filer taxable income, which is enough for a
 * Roth-vs-traditional nudge and not enough to reconstruct a salary. A schedule
 * with a different number of brackets is refused rather than banded by guess:
 * a changed bracket structure is a decision about disclosure, not arithmetic.
 */
export const BAND_GROUPS: readonly (readonly number[])[] = Object.freeze([
  Object.freeze([0, 1]),
  Object.freeze([2, 3, 4]),
  Object.freeze([5, 6]),
]);

/** `'10-12'`, `'22-32'`, `'35-37'` — whole-percent marginal rates, never an income. */
export type TaxBracketBand = string;

const RATIO = /^0\.(\d{1,6})$/;

/** `'0.22'` → `'22'`, exactly, with no float in between. */
function wholePercent(rate: string): string {
  const match = RATIO.exec(rate);
  if (match?.[1] === undefined) throw new Error(`bracket rate ${rate} is not a ratio below 1`);
  const fraction = match[1];
  const unscaled = BigInt(fraction) * 100n;
  const divisor = 10n ** BigInt(fraction.length);
  if (unscaled % divisor !== 0n) {
    throw new Error(`bracket rate ${rate} is not a whole percentage`);
  }
  return (unscaled / divisor).toString();
}

/** The index of the marginal bracket a taxable income falls in. */
export function marginalBracketIndex(taxableIncome: Money, schedule: BracketSchedule): number {
  let index = 0;
  schedule.brackets.forEach((bracket, position) => {
    if (position > 0 && Money.compare(taxableIncome, bracket.over) > 0) index = position;
  });
  return index;
}

/**
 * Taxable income → band. The income is compared and discarded; the return value
 * is a label of two whole-percent rates, and nothing about it varies within a
 * band — two incomes in the same band produce the same string.
 */
export function taxBracketBand(taxableIncome: Money, schedule: BracketSchedule): TaxBracketBand {
  if (schedule.brackets.length !== 7) {
    throw new Error(
      `a ${String(schedule.brackets.length)}-bracket schedule has no band grouping; ` +
        'BAND_GROUPS is defined over seven brackets',
    );
  }
  const first = schedule.brackets[0];
  if (first === undefined || first.over.minor !== 0n) {
    throw new Error('the first bracket must apply from zero');
  }
  if (taxableIncome.currency !== first.over.currency) {
    throw new PlanningError(
      'planning.risk_income_invalid',
      `income is in ${taxableIncome.currency}; the ${String(schedule.taxYear)} schedule is in ` +
        first.over.currency,
    );
  }
  if (Money.isNegative(taxableIncome)) {
    throw new PlanningError('planning.risk_income_invalid', 'taxable income cannot be negative');
  }
  const index = marginalBracketIndex(taxableIncome, schedule);
  const group = BAND_GROUPS.find((candidate) => candidate.includes(index));
  const low = group?.[0];
  const high = group?.[group.length - 1];
  const lowRate = low === undefined ? undefined : schedule.brackets[low]?.rate;
  const highRate = high === undefined ? undefined : schedule.brackets[high]?.rate;
  if (lowRate === undefined || highRate === undefined) {
    throw new Error(`bracket ${String(index)} is in no band`);
  }
  return `${wholePercent(lowRate)}-${wholePercent(highRate)}`;
}

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

export interface RiskProfileInput {
  /** The questionnaire document, exactly as it will be stored. */
  readonly answers: RiskAnswers;
  readonly horizonYears: number;
  readonly liquidityNeed: LiquidityNeed;
  /**
   * The income the band is derived from. Used once, inside
   * `buildRiskProfileRecord`, and never copied anywhere. `null` when the holder
   * declines — the band is then `null`, which is honest; a guessed band is not.
   */
  readonly income: {
    readonly taxableIncome: Money;
    readonly schedule: BracketSchedule;
  } | null;
}

/**
 * Every column of one `risk_profile` row, and nothing else. The store writes
 * each field of this record and no other value, so "the exact income never
 * reaches the row" is a property of this type: there is no field to put it in.
 */
export interface RiskProfileRecord {
  readonly id: string;
  readonly tolerance: RiskTolerance;
  readonly compositeScore: number;
  readonly unpenalisedScore: number;
  readonly consistencyPenalty: number;
  readonly horizonYears: number;
  readonly taxBracketBand: TaxBracketBand | null;
  readonly liquidityNeed: LiquidityNeed;
  readonly answers: RiskAnswers;
  readonly answeredAt: Date;
}

/**
 * Validate, derive, band, and drop the income. Pure apart from `newId()`.
 *
 * The answers are copied into a fresh object with only `instrument` and
 * `items`, and each item value is re-read from the instrument's own option id,
 * so a caller that smuggled an extra key into the document — or passed an
 * object with an `income` property on it — does not get it stored.
 */
export function buildRiskProfileRecord(
  input: RiskProfileInput,
  answeredAt: Date,
): { readonly record: RiskProfileRecord; readonly derivation: ToleranceDerivation } {
  const derivation = deriveTolerance(input.answers);
  if (!Number.isInteger(input.horizonYears) || input.horizonYears < 0 || input.horizonYears > 100) {
    refuse(`horizonYears must be a whole number of years from 0 to 100`);
  }
  if (!LIQUIDITY_NEEDS.includes(input.liquidityNeed)) {
    refuse(`liquidityNeed must be one of ${LIQUIDITY_NEEDS.join(', ')}`);
  }
  if (!RISK_TOLERANCES.includes(derivation.tolerance)) {
    throw new Error(`derived tolerance ${derivation.tolerance} is not in the vocabulary`);
  }

  const items = {} as Record<RiskItemId, string>;
  for (const row of derivation.dispositions) {
    items[`${row.disposition}.stated`] = row.statedOption;
    items[`${row.disposition}.revealed`] = row.revealedOption;
  }
  const answers: RiskAnswers = Object.freeze({
    instrument: derivation.instrument,
    items: Object.freeze(items),
  });

  const band =
    input.income === null
      ? null
      : taxBracketBand(input.income.taxableIncome, input.income.schedule);

  const record: RiskProfileRecord = Object.freeze({
    id: newId(),
    tolerance: derivation.tolerance,
    compositeScore: derivation.compositeScore,
    unpenalisedScore: derivation.unpenalisedScore,
    consistencyPenalty: derivation.consistencyPenalty,
    horizonYears: input.horizonYears,
    taxBracketBand: band,
    liquidityNeed: input.liquidityNeed,
    answers,
    answeredAt,
  });
  return { record, derivation };
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export type { StoredRiskProfile } from './goals-store.ts';

/**
 * Answer the questionnaire: derive, band, write one new row, and append
 * `planning.RiskProfileAnswered` — on one executor, so pass a transaction.
 *
 * Returns the stored row and the derivation, whose `explanation` is what the
 * screen shows beside the score.
 */
export async function answerRiskProfile(
  executor: PlanningExecutor,
  context: {
    readonly userId: string;
    readonly clock: Clock;
    readonly correlationId: string;
    readonly causationId?: string | null;
  },
  input: RiskProfileInput,
): Promise<{ readonly profile: StoredRiskProfile; readonly derivation: ToleranceDerivation }> {
  const { record, derivation } = buildRiskProfileRecord(input, context.clock.now());
  const profile = await insertRiskProfile(executor, { userId: context.userId, record });
  await appendEvent(
    platformOf(executor),
    RiskProfileAnswered.create(
      {
        riskProfileId: profile.id,
        instrument: derivation.instrument,
        tolerance: profile.tolerance,
        consistencyPenalty: profile.consistencyPenalty,
      },
      {
        userId: context.userId,
        aggregateId: profile.id,
        correlationId: context.correlationId,
        causationId: context.causationId ?? null,
      },
      context.clock,
    ),
  );
  return { profile, derivation };
}

/** The holder's current profile — the newest answering — or `null`. */
export function currentRiskProfile(
  executor: PlanningExecutor,
  userId: string,
): Promise<StoredRiskProfile | null> {
  return latestRiskProfile(executor, userId);
}

/** Every answering, newest first. */
export function riskProfileAnswers(
  executor: PlanningExecutor,
  userId: string,
): Promise<readonly StoredRiskProfile[]> {
  return riskProfileHistory(executor, userId);
}
