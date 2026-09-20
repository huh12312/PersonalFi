// SPDX-License-Identifier: MIT
/**
 * `lint_advice_copy` (07 §7.2), and the catalogue's own copy under it.
 *
 * The plan names this file `scripts/lint-advice-copy.test.ts`. It lives here
 * instead, with the test names unchanged, for a mechanical reason: the `insights`
 * vitest project collects test files under `src/` and directly under `test/`, and a
 * suite under `scripts/` would be in no project at all — which is precisely the
 * failure mode 02 §5.5 exists to stop (4 of 13 suites uncollected in Phase 0, 13
 * of 23 in Phase 1). The linter is a module in `@ctx/insights` rather than a
 * standalone script for the same reason it is not a review checklist: it runs in
 * the same suite as the rules it lints, against the same snapshot, so a rule and
 * its copy can never be checked against different data.
 */
import { describe, expect, it } from 'vitest';
import { BUILTIN_CATALOGUE } from '../src/advisors/catalogue.ts';
import { BANNED_PHRASES, lintAdviceCopy, lintInsightCopy } from '../src/advisors/copy-lint.ts';
import { evaluateDerivation } from '../src/validate/derivations.ts';
import { traceContext } from '../src/validate/numerals.ts';
import { TODAY, USD, seedSnapshot, type SeedCase } from './advisors/seed.ts';

const CASES: readonly SeedCase[] = ['drift', 'tight', 'control'];

describe('the advice-copy linter', () => {
  it('"you should" fails the linter', () => {
    const violations = lintAdviceCopy('You should move this to a savings account.', 'summary_md');
    expect(violations.map((violation) => violation.rule)).toContain('banned_phrase');
    expect(violations.some((violation) => violation.detail === 'you should')).toBe(true);
    // And the preferred form of the same advice passes.
    expect(
      lintAdviceCopy(
        'One account holds more than a cushion needs, at a lower rate than another of your own.',
        'summary_md',
      ),
    ).toEqual([]);
  });

  it('copy lint rejects an untraced numeral', async () => {
    const snapshot = await seedSnapshot('drift');
    const context = traceContext({ snapshot, derived: [] });

    // $18.99 is in the snapshot as 1899 minor units; $999.99 is nowhere.
    expect(
      lintAdviceCopy('This subscription costs $18.99 a month.', 'summary_md', context),
    ).toEqual([]);

    const violations = lintAdviceCopy(
      'This subscription costs $999.99 a month.',
      'summary_md',
      context,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe('untraced_numeral');
    expect(violations[0]?.detail).toContain('999.99');
  });

  it('catches every phrase on 07 §7.2 banned list', () => {
    const samples: readonly (readonly [string, string])[] = [
      ['you should', 'You should look at this.'],
      ['buy', 'Time to buy more of it.'],
      ['sell', 'Consider a sell order here.'],
      ['we recommend', 'We recommend the other account.'],
      ['best stock/fund/investment', 'This is the best fund available.'],
      ['guaranteed returns', 'Guaranteed returns of four percent.'],
      ['will grow/earn/return', 'This balance will earn more there.'],
      ['risk-free', 'A risk-free way to hold it.'],
      ["can't lose", "You can't lose with this one."],
      ['should invest in', 'You should invest in the index.'],
    ];
    expect(samples.map((sample) => sample[0]).sort()).toEqual(
      BANNED_PHRASES.map((phrase) => phrase.name).sort(),
    );
    for (const [name, text] of samples) {
      const violations = lintAdviceCopy(text, 'impact_basis');
      expect(
        violations.some(
          (violation) => violation.rule === 'banned_phrase' && violation.detail === name,
        ),
        `${name} was not caught in "${text}"`,
      ).toBe(true);
    }
    // 07's own exception: "buy-and-hold" names a strategy, not an instruction.
    expect(lintAdviceCopy('A buy-and-hold position.', 'impact_basis')).toEqual([]);
  });

  it('refuses an imperative in prose and allows one on a button', () => {
    const prose = lintAdviceCopy('Cancel one of these services.', 'summary_md');
    expect(prose.map((violation) => violation.rule)).toContain('imperative_advice');

    // The same words as an action label are a button caption, which is what a
    // button is for. 07's preferred-forms table replaces the *sentence*, not the
    // affordance.
    expect(lintAdviceCopy('Cancel one of these services', 'action_label')).toEqual([]);

    // A verb that is not an instruction at the user is untouched.
    expect(lintAdviceCopy('The payment moves on the first of the month.', 'summary_md')).toEqual(
      [],
    );
  });

  it('refuses a merchant pseudonym in prose and allows it as a cited value', () => {
    const prose = lintAdviceCopy('MERCHANT_6fbb93c8e9d3 charged more this month.', 'title');
    expect(prose.map((violation) => violation.rule)).toContain('merchant_token_in_prose');
    // An evidence row citing `merchant_ref` must quote what it resolved to.
    expect(lintAdviceCopy('MERCHANT_6fbb93c8e9d3', 'evidence_value')).toEqual([]);
  });

  it('every insight the catalogue produces on the seed passes the linter', async () => {
    let linted = 0;
    for (const name of CASES) {
      const snapshot = await seedSnapshot(name);
      for (const entry of BUILTIN_CATALOGUE) {
        const output = entry.rule.evaluate({
          snapshot,
          today: TODAY,
          period: '2026-09',
          baseCurrency: USD,
        });
        for (const insight of output.insights) {
          // The candidate set is built the way the pipeline builds it: the
          // snapshot, plus the values *we* recomputed from the insight's own
          // declared arithmetic. A derivation another insight declared is not
          // offered, so two insights cannot launder a number between them.
          const derived = insight.derivations.map((derivation) => {
            const outcome = evaluateDerivation(snapshot, derivation);
            expect(outcome.ok, `${entry.ruleId} ${derivation.id}`).toBe(true);
            return outcome.ok ? outcome.value : 0n;
          });
          const violations = lintInsightCopy(insight, traceContext({ snapshot, derived }));
          expect(violations, `${entry.ruleId} ${insight.key}`).toEqual([]);
          linted += 1;
        }
      }
    }
    expect(linted).toBeGreaterThan(10);
  });
});
