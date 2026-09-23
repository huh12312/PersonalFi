// SPDX-License-Identifier: MIT
/**
 * `lintInsightCopy` over every template WP 3.10 added, unchanged.
 *
 * 07 §7.2's banned list *"bites hardest here"* (the dispatch's words) because
 * this is the wave that talks about holdings: `\bbuy\b`, `\bsell\b` and
 * `\bbest (stock|fund|investment)\b` are one careless sentence away in every
 * investing rule. The linter is not re-implemented and not extended — the
 * proof is that the existing one, run over the new copy, is silent.
 *
 * The deliberate-violation test is the half that proves the linter is awake.
 * A suite that only asserted "our copy passes" would pass just as happily
 * against a linter that returned `[]` unconditionally.
 */
import { describe, expect, it } from 'vitest';
import { wp310Catalogue } from '../src/advisors/catalogue.ts';
import { lintAdviceCopy, lintInsightCopy } from '../src/advisors/copy-lint.ts';
import { contextOf } from '../src/advisors/support.ts';
import { parseDecimal } from '../src/validate/decimal.ts';
import { traceContext } from '../src/validate/numerals.ts';
import { requestFor, seedSnapshot } from './advisors/seed.ts';

describe('the copy linter over WP 3.10', () => {
  it('"the best fund" fails the linter', () => {
    // 07 §7.2's `\bbest (stock|fund|investment)\b`, verbatim from the list.
    const violations = lintAdviceCopy('This is the best fund in your portfolio.', 'summary_md');
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.map((violation) => violation.rule)).toContain('banned_phrase');
    expect(violations.map((violation) => violation.detail)).toContain('best stock/fund/investment');

    // The neighbouring forms the same list bans, each one a sentence an
    // investing rule could plausibly have written.
    const shouldFail: readonly (readonly [string, string])[] = [
      ['You should sell VTI and buy VXUS.', 'sell'],
      ['We recommend the best stock you hold.', 'we recommend'],
      ['This is a risk-free way to earn more.', 'risk-free'],
      ['Extra principal here has guaranteed returns.', 'guaranteed returns'],
      ['Over ten years this will grow substantially.', 'will grow/earn/return'],
      ['You should invest in an index fund.', 'should invest in'],
      ["With this position you can't lose.", "can't lose"],
    ];
    for (const [text, name] of shouldFail) {
      const found = lintAdviceCopy(text, 'summary_md');
      expect(
        found.map((violation) => violation.detail),
        text,
      ).toContain(name);
    }
  });

  it('every template WP 3.10 added passes the linter on the seed', async () => {
    const snapshot = await seedSnapshot('drift');
    let linted = 0;

    for (const entry of wp310Catalogue()) {
      const output = entry.rule.evaluate(contextOf(requestFor(entry.rule.manifest, snapshot)));
      expect(output.insights.length, `${entry.ruleId} produced nothing to lint`).toBeGreaterThan(0);

      for (const insight of output.insights) {
        // With a trace context, so the fourth rule — untraced numerals — is
        // live too. Every figure a human reads has to come back to a snapshot
        // value or to a derivation the validator re-computed.
        // `derived` carries the values of the derivations this insight
        // declared, exactly as the pipeline does — a derivation another
        // insight declared is not a number this one may use, which is what
        // stops two insights laundering a figure between them. The claimed
        // values are safe to use here because `catalog-v2.test.ts` has already
        // put every one of them through `validateResponse`, which re-computes
        // the arithmetic rather than trusting it.
        const context = traceContext({
          snapshot,
          derived: insight.derivations
            .map((derivation) => parseDecimal(derivation.value))
            .filter((value): value is bigint => value !== null),
        });
        const violations = lintInsightCopy(insight, context);
        expect(violations, `${entry.ruleId} ${insight.key}: ${JSON.stringify(violations)}`).toEqual(
          [],
        );
        linted += 1;
      }
    }

    expect(linted).toBeGreaterThan(0);
  });

  it('every manifest purpose and display name is sayable too', () => {
    // The manifest is what the grant screen shows. It is copy a human reads,
    // it is not linted anywhere else, and "we recommend the best fund" in a
    // purpose line would be just as wrong there as in a summary.
    for (const entry of wp310Catalogue()) {
      const manifest = entry.rule.manifest;
      expect(lintAdviceCopy(manifest.purpose, 'summary_md'), entry.ruleId).toEqual([]);
      expect(lintAdviceCopy(manifest.display_name, 'title'), entry.ruleId).toEqual([]);
    }
  });

  it('no new insight puts a raw identifier in a sentence', async () => {
    const snapshot = await seedSnapshot('drift');
    for (const entry of wp310Catalogue()) {
      for (const insight of entry.rule.evaluate(
        contextOf(requestFor(entry.rule.manifest, snapshot)),
      ).insights) {
        const prose = [insight.title, insight.summary_md, insight.impact.basis, ...insight.caveats];
        for (const text of prose) {
          // `liability_ref` is an opaque token and belongs in a `source_ref`,
          // where the app resolves it — never in a sentence a human reads.
          expect(text, `${entry.ruleId} ${insight.key}`).not.toMatch(/LIAB_[0-9a-f]{6,}/);
          expect(text, `${entry.ruleId} ${insight.key}`).not.toMatch(/MERCHANT_[0-9a-f]{6,}/);
        }
      }
    }
  });
});
