// SPDX-License-Identifier: MIT
/**
 * The confidence score of 07 §2.4, verbatim, with its early-detection cap.
 *
 * ```
 * x1 = cadence_score
 * x2 = amount_stability   = clamp(1 - cv/0.35, 0, 1)
 * x3 = maturity           = min(1, (n - 1) / 4)
 * x4 = merchant_prior     = 1.0 known subscription | 0.5 unknown | 0.1 known retail
 * x5 = recency            = clamp(1 - days_since_last / (2 * period_days), 0, 1)
 * x6 = coverage_completeness
 *
 * confidence = sigmoid(-2.2 + 2.0x1 + 1.4x2 + 1.1x3 + 0.9x4 + 0.8x5 + 0.7x6)
 * ```
 *
 * It is a float, deliberately: a confidence is a score, not money, and
 * CONVENTIONS allows floats exactly here. It never touches an amount.
 *
 * **n = 2 is capped at 0.70 and typed `EARLY_DETECTION`** (07 §2.4, mirroring
 * Plaid's matured-at-three rule). Two points define an interval, not a pattern:
 * two January charges from the same shop are a coincidence until a third one
 * says otherwise. The cap only ever *lowers* the score, which is what keeps
 * confidence monotone in `n` — `confidence.test.ts` asserts that as a property,
 * because a cap written as an assignment rather than a `min` would break it and
 * nothing else would notice.
 */

import { clamp01, sigmoid } from './stats.ts';
import type { MerchantClass } from './types.ts';

export const EARLY_DETECTION_MAX_OCCURRENCES = 2;
export const EARLY_DETECTION_CAP = 0.7;

/** 07 §2.4 bands: auto-confirm, ask, or keep to ourselves. */
export const AUTO_CONFIRM_CONFIDENCE = 0.8;
export const CANDIDATE_CONFIDENCE = 0.55;

export const WEIGHTS = Object.freeze({
  intercept: -2.2,
  cadence: 2.0,
  amountStability: 1.4,
  maturity: 1.1,
  merchantPrior: 0.9,
  recency: 0.8,
  coverage: 0.7,
});

/** 07 §2.4 x4. A class the caller supplies; the engine never infers it from text. */
export function merchantPrior(merchantClass: MerchantClass): number {
  switch (merchantClass) {
    case 'SUBSCRIPTION':
      return 1.0;
    case 'UTILITY':
    case 'LOAN':
    case 'PAYROLL':
      return 0.8;
    case 'TAX':
    case 'P2P':
    case 'UNKNOWN':
      return 0.5;
    case 'RETAIL':
      return 0.1;
  }
}

export interface ConfidenceFeatures {
  readonly cadenceScore: number;
  readonly amountStability: number;
  readonly maturity: number;
  readonly merchantPrior: number;
  readonly recency: number;
  readonly coverage: number;
}

export interface ConfidenceInputs {
  readonly cadenceScore: number;
  readonly amountCv: number;
  readonly occurrences: number;
  readonly merchantClass: MerchantClass;
  readonly daysSinceLast: number;
  readonly periodDays: number;
  readonly coverage: number;
}

export interface ConfidenceOutcome {
  readonly confidence: number;
  readonly features: ConfidenceFeatures;
  readonly earlyDetection: boolean;
  /** 07 §2.4: an early-detection stream never drives a `$`-impact insight. */
  readonly eligibleForImpact: boolean;
}

export function featuresOf(inputs: ConfidenceInputs): ConfidenceFeatures {
  return {
    cadenceScore: clamp01(inputs.cadenceScore),
    amountStability: clamp01(1 - inputs.amountCv / 0.35),
    maturity: Math.min(1, Math.max(0, (inputs.occurrences - 1) / 4)),
    merchantPrior: merchantPrior(inputs.merchantClass),
    recency:
      inputs.periodDays <= 0
        ? 0
        : clamp01(1 - inputs.daysSinceLast / (2 * inputs.periodDays)),
    coverage: clamp01(inputs.coverage),
  };
}

export function scoreConfidence(inputs: ConfidenceInputs): ConfidenceOutcome {
  const features = featuresOf(inputs);
  const raw = sigmoid(
    WEIGHTS.intercept +
      WEIGHTS.cadence * features.cadenceScore +
      WEIGHTS.amountStability * features.amountStability +
      WEIGHTS.maturity * features.maturity +
      WEIGHTS.merchantPrior * features.merchantPrior +
      WEIGHTS.recency * features.recency +
      WEIGHTS.coverage * features.coverage,
  );

  const earlyDetection = inputs.occurrences <= EARLY_DETECTION_MAX_OCCURRENCES;
  // A `min`, never an assignment: the cap must only ever lower the score.
  const confidence = earlyDetection ? Math.min(raw, EARLY_DETECTION_CAP) : raw;

  return { confidence, features, earlyDetection, eligibleForImpact: !earlyDetection };
}
