// SPDX-License-Identifier: MIT
/**
 * The sanity ceiling (07 §3.2).
 *
 * > Cap any single insight's displayed impact at a sanity ceiling and log
 * > outliers — a data bug that claims "$1.4M savings available" is the fastest
 * > way to lose all credibility.
 *
 * What "cap" means here is the interesting part, and it is asserted below:
 * the figure is **withheld**, not rewritten to the ceiling. Rewriting would put
 * `$100,000` on the screen for a computed `$1,412,000`, and that number is in
 * neither the snapshot nor any declared arithmetic — the validator rejects it at
 * step 7, correctly, because a clamped figure is a figure the app invented to
 * avoid admitting a data bug. The last test here proves the withheld form
 * survives the real pipeline, which is the whole reason for the choice.
 */
import { describe, expect, it } from 'vitest';
import { BUILTIN_CATALOGUE } from '../src/advisors/catalogue.ts';
import { IMPACT_CEILING_MAJOR, clampImpact, contextOf } from '../src/advisors/support.ts';
import { resolveLimits } from '../src/contract/manifest.ts';
import type { AdvisorSnapshot } from '../src/contract/snapshot.ts';
import * as decimal from '../src/validate/decimal.ts';
import { validateResponse } from '../src/validate/pipeline.ts';
import { TODAY, USD, requestFor, seedSnapshot } from './advisors/seed.ts';

function parse(text: string): decimal.Decimal {
  const value = decimal.parseDecimal(text);
  if (value === null) throw new Error(`unparsable ${text}`);
  return value;
}

/** The drift snapshot with one poisoned figure: a $1.412M "annual impact". */
async function poisonedSnapshot(): Promise<AdvisorSnapshot> {
  const snapshot: AdvisorSnapshot = structuredClone(await seedSnapshot('drift'));
  const change = snapshot.recurring_list?.streams[0]?.price_changes[0];
  if (change === undefined) throw new Error('the drift case lost its price change');
  // A mutation on a clone, which is what a data bug upstream would look like.
  const poisoned = change as { annual_impact: { minor: string; currency: string } };
  poisoned.annual_impact = { minor: '141200000', currency: USD };
  return snapshot;
}

describe('the impact ceiling', () => {
  it('an impact above the ceiling is clamped and logged', async () => {
    const entry = BUILTIN_CATALOGUE.find((item) => item.ruleId === 'U2');
    expect(entry).toBeDefined();
    if (entry === undefined) return;

    const snapshot = await poisonedSnapshot();
    const output = entry.rule.evaluate({
      snapshot,
      today: TODAY,
      period: '2026-09',
      baseCurrency: USD,
    });

    const insight = output.insights[0];
    expect(insight).toBeDefined();
    if (insight === undefined) return;

    // Clamped: the headline figure is gone, and no substitute took its place.
    expect(insight.impact.annualized).toBeNull();
    expect(insight.impact.one_time).toBeNull();
    expect(insight.summary_md).not.toContain('1,412,000');
    expect(insight.summary_md).not.toContain(String(IMPACT_CEILING_MAJOR));
    // The finding survives: the price rise is real even when its arithmetic is not.
    expect(insight.summary_md).toContain('$15.99');
    expect(insight.caveats.join(' ')).toContain('too large to be plausible');

    // Logged: the real figure, in the channel that is stored and never rendered.
    expect(output.warnings).toHaveLength(1);
    expect(output.warnings[0]).toContain('impact ceiling');
    expect(output.warnings[0]).toContain('141200000');
  });

  it('a figure under the ceiling is kept exactly', () => {
    const verdict = clampImpact(parse('90248.75'), USD, 'test');
    expect(verdict.kind).toBe('kept');
    if (verdict.kind !== 'kept') return;
    // Rendered to whole minor units, half-even: 90248.75 → 90249.
    expect(verdict.money).toEqual({ minor: '90249', currency: USD });
  });

  it('the boundary is the ceiling itself, not one short of it', () => {
    const atCeiling = parse(String(IMPACT_CEILING_MAJOR * 100));
    const overCeiling = parse(`${String(IMPACT_CEILING_MAJOR * 100)}.000001`);
    expect(clampImpact(atCeiling, USD, 'test').kind).toBe('kept');
    expect(clampImpact(overCeiling, USD, 'test').kind).toBe('withheld');
  });

  it('a negative outlier is withheld on its magnitude', () => {
    const verdict = clampImpact(parse(`-${String(IMPACT_CEILING_MAJOR * 200)}`), USD, 'test');
    expect(verdict.kind).toBe('withheld');
  });

  it('an insight whose impact was withheld still passes the pipeline', async () => {
    const entry = BUILTIN_CATALOGUE.find((item) => item.ruleId === 'U2');
    expect(entry).toBeDefined();
    if (entry === undefined) return;

    const snapshot = await poisonedSnapshot();
    const manifest = entry.rule.manifest;
    const request = requestFor(manifest, snapshot);
    const body = await entry.advisor.run(request, new AbortController().signal);
    const outcome = validateResponse({
      request,
      manifest,
      limits: resolveLimits(manifest),
      body,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.rejected).toEqual([]);
    expect(outcome.accepted).toHaveLength(1);
  });

  it('the rule that produced the outlier still emits exactly one insight', async () => {
    const entry = BUILTIN_CATALOGUE.find((item) => item.ruleId === 'U2');
    if (entry === undefined) return;
    const output = entry.rule.evaluate(
      contextOf(requestFor(entry.rule.manifest, await poisonedSnapshot())),
    );
    expect(output.insights).toHaveLength(1);
  });
});
