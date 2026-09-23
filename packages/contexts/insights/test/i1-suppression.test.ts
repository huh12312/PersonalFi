// SPDX-License-Identifier: MIT
/**
 * 07 §4.3, normative: *"rule I1 must suppress itself when `unclassified_pct >
 * 10%`."*
 *
 * The assertion that matters is not "I1 is quiet on the noisy snapshot" — a
 * rule that never fired at all would pass that. It is the **pair**: the same
 * portfolio, the same targets, the same weights, one number moved past the
 * ceiling, and the output goes from three drift insights to none. That pair is
 * what makes the silence attributable to the suppression rather than to
 * anything else.
 *
 * The sabotage this suite documents, run by hand and reverted immediately, is
 * in §6 of `docs/evidence/phase-3/wp3.10-advisor-catalog-v2.md`: raising
 * `UNCLASSIFIED_SUPPRESSION_THRESHOLD` from `0.1` to `0.9` makes the noisy case
 * speak, and the third test below goes red with the drift figures it should
 * have withheld printed in the failure message.
 */
import { describe, expect, it } from 'vitest';
import { investingDrift } from '../src/advisors/builtin/investing/index.ts';
import { UNCLASSIFIED_SUPPRESSION_THRESHOLD } from '../src/advisors/builtin/shared.ts';
import { contextOf } from '../src/advisors/support.ts';
import type { AdvisorSnapshot } from '../src/contract/snapshot.ts';
import { noisySeedSnapshot, requestFor, seedSnapshot } from './advisors/seed.ts';

function run(snapshot: AdvisorSnapshot) {
  return investingDrift.evaluate(contextOf(requestFor(investingDrift.manifest, snapshot)));
}

describe('I1 self-suppression', () => {
  it('I1 withholds when unclassified exceeds 10 percent', async () => {
    const clean = await seedSnapshot('drift');
    const noisy = await noisySeedSnapshot();

    // The pair. Same portfolio, same targets, one number moved.
    const cleanOutput = run(clean);
    expect(cleanOutput.insights.length, 'I1 should speak below the ceiling').toBeGreaterThan(0);
    expect(cleanOutput.warnings).toEqual([]);

    const noisyOutput = run(noisy);
    expect(noisyOutput.insights, 'I1 must withhold above the ceiling').toEqual([]);

    // Withheld, not merely absent: the reason lands on `advisor_runs` through
    // `diagnostics.warnings`, where it is never rendered and is what separates
    // "I1 found nothing" from "I1 refused to answer".
    expect(noisyOutput.warnings.length).toBe(1);
    expect(noisyOutput.warnings[0]).toContain('I1 withheld');

    // The two snapshots differ in exactly one field, so nothing else can be
    // the explanation.
    const cleanAggregate = clean.holdings_aggregate;
    const noisyAggregate = noisy.holdings_aggregate;
    expect(cleanAggregate).toBeDefined();
    expect(noisyAggregate).toBeDefined();
    expect({ ...noisyAggregate, unclassified_pct: cleanAggregate?.unclassified_pct }).toEqual(
      cleanAggregate,
    );
  });

  it('the ceiling is a tenth, and the comparison is strictly greater', async () => {
    expect(UNCLASSIFIED_SUPPRESSION_THRESHOLD).toBe(0.1);

    const clean = await seedSnapshot('drift');
    const aggregate = clean.holdings_aggregate;
    expect(aggregate).toBeDefined();
    if (aggregate === undefined) return;

    // Exactly at the ceiling I1 still speaks: 07 says "greater than", and a
    // rule that withheld at exactly a tenth would be a different rule.
    const atCeiling: AdvisorSnapshot = {
      ...clean,
      holdings_aggregate: { ...aggregate, unclassified_pct: 0.1 },
    };
    expect(run(atCeiling).insights.length).toBeGreaterThan(0);

    const justOver: AdvisorSnapshot = {
      ...clean,
      holdings_aggregate: { ...aggregate, unclassified_pct: 0.100001 },
    };
    expect(run(justOver).insights).toEqual([]);
  });

  it('the withheld insights are real ones, so the suppression costs something', async () => {
    // If I1 had nothing to say on the clean case the first test would pass
    // vacuously. This pins what is actually being withheld: three sleeves
    // outside the 5pp band, and the two inside it that are correctly silent
    // either way.
    const clean = await seedSnapshot('drift');
    const keys = run(clean)
      .insights.map((insight) => insight.key)
      .sort();
    expect(keys).toEqual([
      'investing.drift.CRYPTO',
      'investing.drift.US_BOND',
      'investing.drift.US_EQUITY',
    ]);
  });

  it('reports a weight gap in points and never a dollar figure', async () => {
    const clean = await seedSnapshot('drift');
    for (const insight of run(clean).insights) {
      // 07 §3.3 I1: "risk-adjusted, show Δσ not $".
      expect(insight.impact.annualized, insight.key).toBeNull();
      expect(insight.impact.one_time, insight.key).toBeNull();
      expect(insight.summary_md, insight.key).toContain('pp ');
      expect(insight.summary_md, insight.key).not.toContain('$');
    }
    expect(investingDrift.manifest.capabilities.produces_impact).toBe(false);
  });

  it('withholds entirely when no target has been set, and says nothing about it', async () => {
    // §8 Q9 and the dispatch: "WP 3.10's rules withhold rather than invent a
    // 60/40. An unset target never becomes an implied one." No insight *and*
    // no warning: there is nothing wrong, there is simply nothing to compare.
    const clean = await seedSnapshot('drift');
    const aggregate = clean.holdings_aggregate;
    expect(aggregate).toBeDefined();
    if (aggregate === undefined) return;

    const untargeted: AdvisorSnapshot = {
      ...clean,
      holdings_aggregate: { ...aggregate, target_allocation: [] },
    };
    const output = run(untargeted);
    expect(output.insights).toEqual([]);
    expect(output.warnings).toEqual([]);
  });
});
