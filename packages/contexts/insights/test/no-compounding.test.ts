// SPDX-License-Identifier: MIT
/**
 * 07 §3.2: *"Never compound speculative returns into the headline number."*
 * The dispatch, for WP 4.9: *"no rule may compound a speculative return into a
 * headline dollar figure (§3.2). R2 reports probability points, not dollars."*
 *
 * A projection is the one input in the app that *is* a compounded speculative
 * return — the terminal band is today's balances carried forward thirty years
 * at an assumed rate — and `plan.projection` carries it. So the property is
 * checked three ways, over every insight the retirement family emits on every
 * seed case:
 *
 *   1. **No R-family derivation reads the projected band.** A derivation whose
 *      inputs reach `plan_projection.terminal` is a headline built on a
 *      forecast, whatever its expression.
 *   2. **No derivation compounds.** The grammar has no exponent, so a
 *      compounded return would have to be written as a `(1 + r)` factor or as
 *      one rate multiplied in more than once; both shapes are refused.
 *   3. **Only R6 claims a figure at all, and its inputs are two of today's
 *      monthly amounts.** Every other rule's `impact` is `null` with a basis
 *      that says why in words.
 *
 * And the checker is shown to be awake: a hand-built compounding derivation,
 * and one that reads the band, are both caught by the same predicate the real
 * insights pass.
 */
import { describe, expect, it } from 'vitest';
import { wp49Catalogue } from '../src/advisors/catalogue.ts';
import { contextOf } from '../src/advisors/support.ts';
import type { Derivation, Insight } from '../src/contract/response.ts';
import { requestFor, seedSnapshot } from './advisors/seed.ts';

const PROJECTED_BAND = /plan_projection\.terminal\b/u;
const ONE_PLUS = /\(\s*1\s*\+/u;

/** Why a derivation would compound, or `null` if it does not. */
function compounds(derivation: Derivation): string | null {
  if (derivation.inputs.some((ref) => PROJECTED_BAND.test(ref))) {
    return 'reads the projected band';
  }
  if (ONE_PLUS.test(derivation.expression)) return 'has a (1 + r) growth factor';
  // One input used twice — by index, or the same ref at two indices — in a
  // product is a power in disguise. None of the family's builders reuses one.
  const uses = [...derivation.expression.matchAll(/\$(\d+)/gu)].map((match) => match[1]);
  if (new Set(uses).size < uses.length) return 'uses one input twice';
  if (
    /\*/u.test(derivation.expression) &&
    new Set(derivation.inputs).size < derivation.inputs.length
  ) {
    return 'multiplies one ref in twice';
  }
  return null;
}

async function retirementInsights(): Promise<readonly { ruleId: string; insight: Insight }[]> {
  const rows: { ruleId: string; insight: Insight }[] = [];
  for (const seedCase of ['drift', 'tight', 'control'] as const) {
    const snapshot = await seedSnapshot(seedCase);
    for (const entry of wp49Catalogue()) {
      for (const insight of entry.rule.evaluate(
        contextOf(requestFor(entry.rule.manifest, snapshot)),
      ).insights) {
        rows.push({ ruleId: entry.ruleId, insight });
      }
    }
  }
  return rows;
}

describe('no compounding in the retirement family', () => {
  it("no R rule's headline impact is a compounded speculative return", async () => {
    const rows = await retirementInsights();
    expect(rows.length).toBeGreaterThanOrEqual(6);

    for (const { ruleId, insight } of rows) {
      // (1) and (2), over every derivation, not only the one behind the impact:
      // a figure in the summary is a headline as much as the impact is.
      for (const derivation of insight.derivations) {
        expect(compounds(derivation), `${ruleId} ${derivation.id}`).toBeNull();
      }

      // (3) Only R6 claims money, and it claims it from today's two plans.
      const claims = insight.impact.annualized !== null || insight.impact.one_time !== null;
      if (ruleId !== 'R6') {
        expect(claims, `${ruleId} claims a figure`).toBe(false);
        expect(insight.impact.basis, ruleId).toMatch(/^(No dollar figure|Probability points)/u);
        continue;
      }
      expect(insight.impact.derivation_id, ruleId).not.toBeNull();
      const behind = insight.derivations.find((row) => row.id === insight.impact.derivation_id);
      expect(behind?.expression).toBe('($0 - $1) * 12');
      expect(
        behind?.inputs.every((ref) => /\.pace\.(required|planned)_monthly\.minor$/u.test(ref)),
      ).toBe(true);
    }

    // R2 in particular: probability points, never dollars.
    const r2 = rows.filter((row) => row.ruleId === 'R2');
    expect(r2.length).toBeGreaterThan(0);
    for (const { insight } of r2) {
      expect(insight.impact.annualized).toBeNull();
      expect(insight.summary_md).not.toMatch(/\$\d/u);
    }
  });

  it('no R rule prints a figure from the projected band', async () => {
    // The band is in the snapshot, so the numeral tracer would *accept* a
    // rule quoting it. This is the check that it never does.
    for (const seedCase of ['drift', 'tight', 'control'] as const) {
      const snapshot = await seedSnapshot(seedCase);
      const terminal = snapshot.plan_projection?.terminal;
      if (terminal === undefined) continue;
      const bandFigures = [terminal.p5, terminal.p50, terminal.p95]
        .filter((band) => band !== null && band.minor !== '0')
        .map((band) => (BigInt(band?.minor ?? '0') / 100n).toLocaleString('en-US'));
      for (const entry of wp49Catalogue()) {
        for (const insight of entry.rule.evaluate(
          contextOf(requestFor(entry.rule.manifest, snapshot)),
        ).insights) {
          for (const figure of bandFigures) {
            expect(insight.summary_md, `${entry.ruleId} quotes ${figure}`).not.toContain(figure);
          }
          for (const row of insight.evidence) {
            expect(row.source_ref ?? '', entry.ruleId).not.toMatch(PROJECTED_BAND);
          }
        }
      }
    }
  });

  it('the checker catches a compounded return and a read of the band', () => {
    const base = { id: 'x', value: '0', note: null };
    expect(
      compounds({ ...base, expression: '$0 * (1 + $1) * (1 + $1)', inputs: ['a', 'b'] }),
    ).not.toBeNull();
    expect(compounds({ ...base, expression: '$0 * $1 * $1', inputs: ['a', 'b'] })).not.toBeNull();
    expect(
      compounds({ ...base, expression: '$0 * $1 * $2', inputs: ['a', 'b', 'b'] }),
    ).not.toBeNull();
    expect(
      compounds({
        ...base,
        expression: '$0 * 0.5',
        inputs: ['snapshot:plan_projection.terminal.p50.minor'],
      }),
    ).not.toBeNull();
    expect(compounds({ ...base, expression: '($0 - $1) * 12', inputs: ['a', 'b'] })).toBeNull();
  });
});
