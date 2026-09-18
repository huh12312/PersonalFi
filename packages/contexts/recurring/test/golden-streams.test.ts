// SPDX-License-Identifier: MIT
/**
 * The gate: 07 §2.12's P/R targets on the synthetic corpus, and zero
 * subscriptions on the adversarial one.
 *
 * The operating point is **swept, not asserted**. A test that hard-codes a
 * threshold and checks precision at it measures whether somebody remembered to
 * update the constant; this one walks the confidence threshold, takes 07
 * §2.12's rule — the highest recall at which precision is still ≥ 0.95 — and
 * then asserts the targets there. If the engine gets worse, no threshold
 * rescues it.
 *
 * Everything here runs against `test/corpora/`, whose generator is deterministic
 * from a seed. Full numbers, including the whole curve, are regenerated for the
 * evidence file by `node test/corpora/report.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
  ADVERSARIAL_FAMILIES,
  adversarialCorpus,
  unclassifiedFacts,
} from './corpora/adversarial.ts';
import {
  DEFAULT_THRESHOLDS,
  evaluate,
  operatingPoint,
  precisionRecallCurve,
  runDetection,
} from './corpora/metrics.ts';
import { syntheticCorpus } from './corpora/synthetic.ts';
import { CANDIDATE_CONFIDENCE } from '../src/index.ts';

const corpus = syntheticCorpus();
const result = runDetection(corpus.inputs, corpus.facts, corpus.today);
const curve = precisionRecallCurve(result, corpus.gold, DEFAULT_THRESHOLDS);
const point = operatingPoint(curve);
const metrics = evaluate(corpus, result, point.threshold);

describe('golden streams', () => {
  it('precision ≥ 0.95 and recall ≥ 0.85 on the synthetic corpus', () => {
    expect(metrics.precision).toBeGreaterThanOrEqual(0.95);
    expect(metrics.recall).toBeGreaterThanOrEqual(0.85);

    // The operating point must be a real point on a real curve: inside the
    // band 07 §2.4 defines for "ask the user", and reached with a corpus that
    // actually contains negatives to get wrong.
    expect(point.threshold).toBeGreaterThanOrEqual(CANDIDATE_CONFIDENCE);
    expect(point.threshold).toBeLessThanOrEqual(0.99);
    expect(metrics.goldCount).toBeGreaterThan(30);
    expect(corpus.noiseMerchantCount).toBeGreaterThan(0.25 * corpus.merchantCount);

    // Precision is bought, not free: at the bottom of the curve it is well
    // under target, so the sweep is choosing rather than confirming.
    expect((curve[0] as (typeof curve)[number]).precision).toBeLessThan(0.95);
  });

  it('the remaining 07 §2.12 metrics hold at the operating point', () => {
    expect(metrics.cadenceAccuracy).toBeGreaterThanOrEqual(0.92);
    expect(metrics.nextDueMaeMonthlyDays).toBeLessThanOrEqual(2);
    expect(metrics.nextDueMaeAnnualDays).toBeLessThanOrEqual(5);
    expect(metrics.amountMape).toBeLessThanOrEqual(0.01);
    expect(metrics.priceChangePrecision).toBeGreaterThanOrEqual(0.9);
    expect(metrics.priceChangeRecall).toBeGreaterThanOrEqual(0.85);
    // 07 §2.8's ladder cannot reach LIKELY_CANCELED inside 1.5 periods — it
    // needs two missed periods plus grace by construction. The rung that meets
    // 07 §2.12's target is AT_RISK, which is the one the user is shown.
    expect(metrics.atRiskLeadPeriods).toBeLessThanOrEqual(1.5);
  });

  it('every injected reality is observed in the output, not merely generated', () => {
    // A corpus that injects a card migration proves nothing unless something in
    // the result shows the engine met it.
    const migrations = result.streams.filter((stream) => stream.mergeProposal !== null);
    expect(migrations.length).toBeGreaterThan(0);
    expect(migrations[0]?.mergeProposal?.reason).toBe('CARD_MIGRATION');
    expect(migrations[0]?.accountIds.length).toBe(2);
    // …and the migrated stream is not being called a cancellation.
    expect(migrations.every((stream) => stream.status !== 'LIKELY_CANCELED')).toBe(true);

    const duplicates = result.streams.filter((stream) =>
      stream.occurrences.some((occurrence) => occurrence.duplicateOf !== null),
    );
    expect(duplicates.length).toBeGreaterThan(0);

    const dormant = result.streams.filter(
      (stream) => stream.status === 'LIKELY_CANCELED' || stream.status === 'CANCELED',
    );
    expect(dormant.length).toBeGreaterThan(0);
    expect(dormant.every((stream) => stream.nextDue === null || stream.status !== 'CANCELED')).toBe(
      true,
    );

    expect(result.priceChanges.length).toBeGreaterThan(0);
    expect(result.priceChanges.every((change) => change.direction === 'INCREASE')).toBe(true);

    expect(result.duplicateServices.length).toBeGreaterThan(0);
    // 07 §2.9 refinement (a): the bundled merchant is not in a cross-service finding.
    const bundled = [...corpus.facts.entries()]
      .filter(([, facts]) => facts.bundleSku != null)
      .map(([merchantId]) => merchantId);
    const crossServiceKeys = result.duplicateServices
      .filter((finding) => finding.kind === 'CROSS_SERVICE')
      .flatMap((finding) => finding.streamKeys);
    for (const merchantId of bundled) {
      expect(crossServiceKeys.some((key) => key.startsWith(`${merchantId}:`))).toBe(false);
    }

    // Pending rows were dropped rather than modelled.
    expect(result.diagnostics.skippedPending).toBeGreaterThan(0);
  });

  it('a refund never becomes recurring income', () => {
    const inflows = result.streams.filter((stream) => stream.sign === 'INFLOW');
    expect(inflows.length).toBeGreaterThan(0);
    for (const stream of inflows) {
      if (stream.type !== 'RECURRING_INCOME') continue;
      // The only inflow streams typed as income are the payroll ones.
      expect(corpus.facts.get(stream.merchantId)?.class).toBe('PAYROLL');
    }
  });
});

describe('adversarial streams', () => {
  const adversarial = adversarialCorpus();

  it('the adversarial corpus yields zero SUBSCRIPTION streams', () => {
    for (const [label, facts] of [
      ['classified', adversarial.facts],
      // The case a metadata-only defence fails open on: no payee is classified.
      ['unclassified', unclassifiedFacts()],
    ] as const) {
      const outcome = runDetection(adversarial.inputs, facts, adversarial.today);
      const subscriptions = outcome.streams.filter((stream) => stream.type === 'SUBSCRIPTION');
      expect(subscriptions.map((stream) => stream.merchantId), label).toEqual([]);

      // And every family is accounted for with a named reason, so a green test
      // cannot mean "the engine found nothing at all".
      expect(outcome.streams.length, label).toBe(Object.values(ADVERSARIAL_FAMILIES).length);
      for (const stream of outcome.streams) {
        expect(stream.suppressions.length, `${label} ${stream.merchantId}`).toBeGreaterThan(0);
      }
    }
  });

  it('each adversarial family is refused for the reason it should be', () => {
    const outcome = runDetection(adversarial.inputs, adversarial.facts, adversarial.today);
    const byMerchant = new Map(outcome.streams.map((stream) => [stream.merchantId, stream]));

    expect(byMerchant.get(ADVERSARIAL_FAMILIES.mortgageAutopay)?.type).toBe('LOAN_PAYMENT');
    expect(byMerchant.get(ADVERSARIAL_FAMILIES.rentViaVenmo)?.type).toBe('RECURRING_BILL');
    expect(byMerchant.get(ADVERSARIAL_FAMILIES.coffeeHabit)?.type).toBe('FREQUENT_MERCHANT');
    expect(byMerchant.get(ADVERSARIAL_FAMILIES.estimatedTax)?.cadenceScore).toBeLessThan(0.7);

    // With the classes removed, the shape-only ceiling does the same job.
    const blind = runDetection(adversarial.inputs, unclassifiedFacts(), adversarial.today);
    const blindByMerchant = new Map(blind.streams.map((stream) => [stream.merchantId, stream]));
    for (const merchantId of [
      ADVERSARIAL_FAMILIES.mortgageAutopay,
      ADVERSARIAL_FAMILIES.rentViaVenmo,
    ]) {
      expect(
        blindByMerchant.get(merchantId)?.suppressions.map((suppression) => suppression.reason),
      ).toContain('amount_above_subscription_ceiling');
    }
  });

  it('removing the ceiling makes the adversarial gate go red', () => {
    // The sabotage, run as a test rather than described in a document: with the
    // classes gone *and* the ceiling raised out of reach, rent and a mortgage
    // become subscriptions. A control nobody has watched fail is not evidence.
    const sabotaged = runDetection(adversarial.inputs, unclassifiedFacts(), adversarial.today, {
      subscriptionMonthlyCeilingMajor: 10_000_000n,
    });
    const subscriptions = sabotaged.streams
      .filter((stream) => stream.type === 'SUBSCRIPTION')
      .map((stream) => stream.merchantId)
      .sort();
    expect(subscriptions).toEqual(
      [ADVERSARIAL_FAMILIES.mortgageAutopay, ADVERSARIAL_FAMILIES.rentViaVenmo].sort(),
    );
  });
});
