// SPDX-License-Identifier: MIT
/**
 * Regenerates the tables in `docs/evidence/phase-2/wp2.2-recurring-engine.md`.
 *
 * ```
 * node packages/contexts/recurring/test/corpora/report.ts
 * node packages/contexts/recurring/test/corpora/report.ts --sabotage
 * ```
 *
 * Evidence that cannot be regenerated is a screenshot of a number somebody
 * typed. This prints the P/R curve, the operating point, the eight metrics of
 * 07 §2.12 and the adversarial result straight from the same functions the gate
 * asserts on, so the document and the test cannot drift apart without one of
 * them going red.
 *
 * `--sabotage` inverts 07 §2.3's cadence tie-break (prefer the *shortest* among
 * near-ties instead of the longest) and prints the same tables, which is the
 * "observe the control go red" half of the gate standard.
 */

import { adversarialCorpus, unclassifiedFacts } from './adversarial.ts';
import {
  DEFAULT_THRESHOLDS,
  evaluate,
  operatingPoint,
  precisionRecallCurve,
  runDetection,
  surfacedStreams,
} from './metrics.ts';
import { REALITY_NOTES, syntheticCorpus } from './synthetic.ts';
import { periodsPerYear } from '../../src/index.ts';

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

const sabotageArg = process.argv.find((argument) => argument.startsWith('--sabotage'));
const sabotage: 'none' | 'tiebreak' | 'ceiling' =
  sabotageArg === undefined ? 'none' : sabotageArg.includes('ceiling') ? 'ceiling' : 'tiebreak';

const corpus = syntheticCorpus();
const result = runDetection(corpus.inputs, corpus.facts, corpus.today, {
  preferLongestCadence: sabotage !== 'tiebreak',
});
const curve = precisionRecallCurve(result, corpus.gold, DEFAULT_THRESHOLDS);
const point = operatingPoint(curve);
const metrics = evaluate(corpus, result, point.threshold);

write(
  sabotage === 'none'
    ? '## Golden corpus'
    : sabotage === 'tiebreak'
      ? '## Sabotage: cadence tie-break inverted (prefer the SHORTEST among near-ties)'
      : '## Sabotage: subscription ceiling removed',
);
write('');
write(
  `inputs=${corpus.inputs.length} merchants=${corpus.merchantCount} noise=${corpus.noiseMerchantCount} ` +
    `gold=${metrics.goldCount} streams=${result.streams.length}`,
);
write('');
write('| threshold | precision | recall | predicted | matched |');
write('|---|---|---|---|---|');
for (const row of curve) {
  if (Math.round(row.threshold * 100) % 5 !== 0) continue;
  write(
    `| ${row.threshold.toFixed(2)} | ${row.precision.toFixed(3)} | ${row.recall.toFixed(3)} | ${row.predicted} | ${row.matched} |`,
  );
}
write('');
write(
  `operating point: threshold=${point.threshold.toFixed(2)} precision=${point.precision.toFixed(3)} recall=${point.recall.toFixed(3)}`,
);
write('');
write('| # | metric (07 §2.12) | target | measured |');
write('|---|---|---|---|');
write(`| 1 | stream precision | ≥ 0.95 | ${metrics.precision.toFixed(3)} |`);
write(`| 2 | stream recall | ≥ 0.85 | ${metrics.recall.toFixed(3)} |`);
write(`| 3 | cadence accuracy | ≥ 0.92 | ${metrics.cadenceAccuracy.toFixed(3)} |`);
write(
  `| 4 | next-due MAE (days) | ≤ 2.0 monthly / ≤ 5.0 annual | ${metrics.nextDueMaeMonthlyDays.toFixed(2)} / ${metrics.nextDueMaeAnnualDays.toFixed(2)} (all ${metrics.nextDueMaeDays.toFixed(2)}) |`,
);
write(`| 5 | amount MAPE (FIXED) | ≤ 1% | ${(metrics.amountMape * 100).toFixed(2)}% |`);
write(
  `| 6 | price-change P/R | ≥ 0.90 / ≥ 0.85 | ${metrics.priceChangePrecision.toFixed(3)} / ${metrics.priceChangeRecall.toFixed(3)} |`,
);
write(
  `| 7 | cancellation lead time | ≤ 1.5 periods | AT_RISK ${metrics.atRiskLeadPeriods.toFixed(2)}, LIKELY_CANCELED ${metrics.cancellationLeadPeriods.toFixed(2)} |`,
);
write('| 8 | trial-conversion recall | ≥ 0.80 | not implemented (07 §2.7 needs a price table) |');
write('');
write(
  `false positives: ${metrics.falsePositives.map((stream) => stream.streamKey).join(', ') || 'none'}`,
);
write(
  `missed: ${metrics.missed.map((stream) => `${stream.goldId}/${stream.merchantId}`).join(', ') || 'none'}`,
);
write('');

// How often does the tie-break actually decide anything, and what does getting
// it wrong cost? Always measured longest-vs-shortest on the *unsabotaged*
// engine, so the line means the same thing in both modes.
const longest = runDetection(corpus.inputs, corpus.facts, corpus.today, {
  preferLongestCadence: true,
});
const shortest = runDetection(corpus.inputs, corpus.facts, corpus.today, {
  preferLongestCadence: false,
});
const byKeyShortest = new Map(shortest.streams.map((stream) => [stream.streamKey, stream]));
const relabelled = longest.streams.filter(
  (stream) => byKeyShortest.get(stream.streamKey)?.cadence !== stream.cadence,
);
let periodsLongest = 0;
let periodsShortest = 0;
for (const stream of relabelled) {
  const other = byKeyShortest.get(stream.streamKey);
  if (stream.cadence === 'UNKNOWN' || other === undefined || other.cadence === 'UNKNOWN') continue;
  periodsLongest += periodsPerYear(stream.cadence);
  periodsShortest += periodsPerYear(other.cadence);
}
write(
  `tie-break: ${relabelled.length}/${longest.streams.length} streams change cadence when it is inverted; ` +
    `${relabelled.filter((stream) => stream.cadenceScore >= 0.7).length} of those score >= 0.70; ` +
    `promised charges/year for those streams ${periodsLongest} -> ${periodsShortest} ` +
    `(${(periodsShortest / Math.max(1, periodsLongest)).toFixed(1)}x)`,
);
write('');

const adversarial = adversarialCorpus();
for (const [label, facts] of [
  ['classified', adversarial.facts],
  ['all UNKNOWN', unclassifiedFacts()],
] as const) {
  const advResult = runDetection(adversarial.inputs, facts, adversarial.today, {
    preferLongestCadence: sabotage !== 'tiebreak',
    ...(sabotage === 'ceiling' ? { subscriptionMonthlyCeilingMajor: 10_000_000n } : {}),
  });
  const subscriptions = advResult.streams.filter((stream) => stream.type === 'SUBSCRIPTION');
  write(
    `adversarial (${label}): streams=${advResult.streams.length} SUBSCRIPTION=${subscriptions.length}`,
  );
  for (const stream of advResult.streams) {
    write(
      `  ${stream.merchantId} type=${stream.type} cadence=${stream.cadence} ` +
        `score=${stream.cadenceScore.toFixed(3)} model=${stream.amountModel} ` +
        `confidence=${stream.confidence.toFixed(3)} why=${stream.suppressions.map((s) => s.reason).join('|') || '-'}`,
    );
  }
  write(`  surfaced at operating point: ${surfacedStreams(advResult, point.threshold).length}`);
}

write('');
write('| reality | injection | the engine must |');
write('|---|---|---|');
for (const note of REALITY_NOTES) {
  write(
    `| \`${note.reality}\` × ${corpus.realityCounts.get(note.reality) ?? 0} | ${note.injection} | ${note.theEngineMust} |`,
  );
}
