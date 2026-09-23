// SPDX-License-Identifier: MIT
/**
 * 08 §4.3: *"there is no value an advisor can return that causes an action."*
 *
 * `pending-review.test.ts` proves that at the **contract** level — the enum has
 * four members and a fifth is a schema violation. This file proves it at the
 * **catalogue** level for WP 3.10's seventeen rules, which is a different
 * claim: the contract says an execute kind cannot be expressed, and this says
 * none of the new rules went near the edge of what can.
 *
 * It matters most in this wave. The I, D and X families are the first rules in
 * this app whose subject matter is *trades and payments* — the exact place
 * where a "just do it for me" affordance would feel natural and would be the
 * end of the app's safety story.
 */
import { describe, expect, it } from 'vitest';
import { wp310Catalogue } from '../src/advisors/catalogue.ts';
import { contextOf } from '../src/advisors/support.ts';
import { PROPOSED_ACTION_KINDS } from '../src/contract/response.ts';
import { requestFor, seedSnapshot } from './advisors/seed.ts';

const NON_ACTING = new Set<string>(PROPOSED_ACTION_KINDS);

describe('no rule in WP 3.10 can act', () => {
  it('no rule proposes an action outside the four non-acting kinds', async () => {
    const snapshot = await seedSnapshot('drift');
    expect([...PROPOSED_ACTION_KINDS]).toEqual([
      'suggest_only',
      'open_url',
      'create_goal_draft',
      'create_rule_draft',
    ]);

    let actions = 0;
    for (const entry of wp310Catalogue()) {
      const output = entry.rule.evaluate(contextOf(requestFor(entry.rule.manifest, snapshot)));
      expect(output.insights.length, `${entry.ruleId} produced nothing`).toBeGreaterThan(0);

      for (const insight of output.insights) {
        for (const action of insight.proposed_actions) {
          expect(
            NON_ACTING.has(action.kind),
            `${entry.ruleId} ${insight.key} proposed '${action.kind}'`,
          ).toBe(true);
          // Named explicitly as well as by set membership, because these three
          // are the ones somebody would add and the failure message should say
          // so rather than "not in set".
          expect(action.kind, `${entry.ruleId} ${insight.key}`).not.toBe('execute');
          expect(action.kind, `${entry.ruleId} ${insight.key}`).not.toBe('transfer');
          expect(action.kind, `${entry.ruleId} ${insight.key}`).not.toBe('trade');
          actions += 1;
        }
        // And the review flag is not a field a rule gets to set.
        expect(insight.requires_review, `${entry.ruleId} ${insight.key}`).toBe(true);
      }
    }

    expect(actions, 'no action was checked, so this proved nothing').toBeGreaterThan(0);
  });

  it('every action this wave proposes is suggest_only, and none carries a url', async () => {
    const snapshot = await seedSnapshot('drift');
    for (const entry of wp310Catalogue()) {
      for (const insight of entry.rule.evaluate(
        contextOf(requestFor(entry.rule.manifest, snapshot)),
      ).insights) {
        for (const action of insight.proposed_actions) {
          // A built-in has an empty `egress_allowlist`, so an `open_url` could
          // only point somewhere nobody vetted. None of these rules emits one,
          // and `checkManifest` would refuse a non-empty list for this kind.
          expect(action.kind, `${entry.ruleId} ${insight.key}`).toBe('suggest_only');
          expect(action.url, `${entry.ruleId} ${insight.key}`).toBeNull();
        }
      }
      expect(entry.rule.manifest.egress_allowlist, entry.ruleId).toEqual([]);
    }
  });

  it('no rule claims an impact its manifest did not declare', async () => {
    const snapshot = await seedSnapshot('drift');
    for (const entry of wp310Catalogue()) {
      const claims = entry.rule.manifest.capabilities.produces_impact;
      for (const insight of entry.rule.evaluate(
        contextOf(requestFor(entry.rule.manifest, snapshot)),
      ).insights) {
        const hasImpact = insight.impact.annualized !== null || insight.impact.one_time !== null;
        if (!claims) {
          expect(hasImpact, `${entry.ruleId} ${insight.key} claimed an undeclared impact`).toBe(
            false,
          );
        }
      }
    }

    // The risk rules in particular. I1, I4, I5 and X1 all describe exposure,
    // and an exposure is not a saving: nobody gets $50,000 by diversifying.
    for (const ruleId of ['I1', 'I3', 'I4', 'I5', 'X1', 'X2', 'X5', 'X6']) {
      const entry = wp310Catalogue().find((item) => item.ruleId === ruleId);
      expect(entry?.rule.manifest.capabilities.produces_impact, ruleId).toBe(false);
    }
  });
});
