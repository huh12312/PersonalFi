// SPDX-License-Identifier: MIT
/**
 * WP 3.10's catalogue, held to the same two properties WP 2.7's was.
 *
 * `catalog.test.ts` already runs these assertions over the *whole* catalogue,
 * and now covers the seventeen new rules because `seedSnapshot('drift')` carries
 * the portfolio blocks. This file exists anyway, with the dispatch's exact test
 * names, because the two suites fail differently and a reviewer looking for
 * *'every new rule produces at least one resolvable evidence ref on the seed'*
 * should find it rather than infer it from a test about everything.
 *
 * The wave table is asserted here too. A rule that ships enabled while the
 * scope it reads has no reader behind it is a rule that returns nothing every
 * night, and nothing is what a broken rule also returns.
 */
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_CATALOGUE,
  CATALOGUE_GAPS,
  WP_3_10_P0_RULE_IDS,
  WP_3_10_SCOPE,
  wp310Catalogue,
} from '../src/advisors/catalogue.ts';
import { contextOf } from '../src/advisors/support.ts';
import type { AdvisorScope } from '../src/contract/scopes.ts';
import type { AdvisorSnapshot } from '../src/contract/snapshot.ts';
import { resolveLimits } from '../src/contract/manifest.ts';
import { resolveSourceRef } from '../src/validate/evidence.ts';
import { validateResponse } from '../src/validate/pipeline.ts';
import { EMPTY_SNAPSHOT, TODAY, USD, requestFor, seedSnapshot } from './advisors/seed.ts';

const NEW_RULES = wp310Catalogue();

function evaluate(entry: (typeof BUILTIN_CATALOGUE)[number], snapshot: AdvisorSnapshot) {
  return entry.rule.evaluate(contextOf(requestFor(entry.rule.manifest, snapshot))).insights;
}

describe('the WP 3.10 catalogue', () => {
  it('every new rule produces at least one resolvable evidence ref on the seed', async () => {
    const snapshot = await seedSnapshot('drift');
    expect(NEW_RULES.length).toBe(17);

    for (const entry of NEW_RULES) {
      const produced = evaluate(entry, snapshot);
      expect(produced.length, `${entry.ruleId} never fired on the seed`).toBeGreaterThan(0);

      for (const insight of produced) {
        expect(insight.evidence.length, `${entry.ruleId} ${insight.key}`).toBeGreaterThan(0);
        let resolvable = 0;
        for (const row of insight.evidence) {
          expect(row.source_ref, `${entry.ruleId} ${insight.key}`).not.toBeNull();
          const resolution = resolveSourceRef(snapshot, row.source_ref ?? '');
          expect(resolution.ok, `${entry.ruleId} ${String(row.source_ref)}`).toBe(true);
          if (resolution.ok) resolvable += 1;
        }
        expect(resolvable, `${entry.ruleId} ${insight.key}`).toBeGreaterThan(0);
      }
    }
  });

  it('every new rule returns zero insights when its inputs are absent', () => {
    for (const entry of NEW_RULES) {
      const output = entry.rule.evaluate({
        snapshot: EMPTY_SNAPSHOT,
        today: TODAY,
        period: '2026-09',
        baseCurrency: USD,
      });
      expect(output.insights, entry.ruleId).toEqual([]);
      // A warning on an empty snapshot would mean the rule reached a decision
      // it had no data for. Silence is the only correct output here, and I1's
      // suppression warning in particular must not fire on "no portfolio".
      expect(output.warnings, entry.ruleId).toEqual([]);
    }
  });

  it('every new insight passes the WP 2.6 pipeline unchanged', async () => {
    const snapshot = await seedSnapshot('drift');
    const signal = new AbortController().signal;
    let accepted = 0;

    for (const entry of NEW_RULES) {
      const manifest = entry.rule.manifest;
      const request = requestFor(manifest, snapshot);
      const body = await entry.advisor.run(request, signal);
      const outcome = validateResponse({
        request,
        manifest,
        limits: resolveLimits(manifest),
        body,
      });

      expect(outcome.ok, `${entry.ruleId} response rejected`).toBe(true);
      if (!outcome.ok) continue;
      expect(
        outcome.rejected,
        `${entry.ruleId} rejected ${JSON.stringify(outcome.rejected)}`,
      ).toEqual([]);
      for (const row of outcome.accepted) {
        expect(row.status).toBe('pending_review');
        expect(row.severityClamped, `${entry.ruleId} ${row.insight.key}`).toBe(false);
      }
      accepted += outcome.accepted.length;
    }

    expect(accepted).toBeGreaterThanOrEqual(NEW_RULES.length);
  });

  it('every new rule reads only the scopes its manifest declares', async () => {
    const full = await seedSnapshot('drift');
    for (const entry of NEW_RULES) {
      const narrow = await seedSnapshot(
        'drift',
        entry.rule.manifest.requires_scopes as readonly AdvisorScope[],
      );
      expect(evaluate(entry, narrow), entry.ruleId).toEqual(evaluate(entry, full));
    }
  });

  it('I4, I5 and X1 are the P0s, and every P0 emits at urgent', async () => {
    const snapshot = await seedSnapshot('drift');
    expect([...WP_3_10_P0_RULE_IDS]).toEqual(['I4', 'I5', 'X1']);

    for (const ruleId of WP_3_10_P0_RULE_IDS) {
      const entry = NEW_RULES.find((item) => item.ruleId === ruleId);
      expect(entry, ruleId).toBeDefined();
      if (entry === undefined) continue;
      expect(entry.rule.manifest.capabilities.max_severity, ruleId).toBe('urgent');
      const produced = evaluate(entry, snapshot);
      expect(produced.length, ruleId).toBeGreaterThan(0);
      for (const insight of produced) expect(insight.severity, ruleId).toBe('urgent');
    }

    // And nothing else in this wave claims the ceiling. The dispatch named four
    // P0s and 07 §7.4 is explicit that eighteen would be a wall of red.
    const urgent = NEW_RULES.filter(
      (entry) => entry.rule.manifest.capabilities.max_severity === 'urgent',
    ).map((entry) => entry.ruleId);
    expect(urgent.sort()).toEqual(['I4', 'I5', 'X1']);
  });

  it('every rule in the WP 3.10 brief is implemented or has a stated reason', () => {
    const implemented = new Set(BUILTIN_CATALOGUE.map((entry) => entry.ruleId));
    const gaps = new Map(CATALOGUE_GAPS.map((gap) => [gap.ruleId, gap]));

    for (const ruleId of WP_3_10_SCOPE) {
      const inCatalogue = implemented.has(ruleId);
      const gap = gaps.get(ruleId);
      expect(inCatalogue || gap !== undefined, `${ruleId} is in neither list`).toBe(true);
      expect(inCatalogue && gap !== undefined, `${ruleId} is in both lists`).toBe(false);
      // A reason that names a missing field is actionable; "not done yet" is not.
      if (gap !== undefined) expect(gap.reason.length, ruleId).toBeGreaterThan(40);
    }

    // The five gaps this work package is honest about, and no sixth.
    const missing = WP_3_10_SCOPE.filter((ruleId) => !implemented.has(ruleId));
    expect(missing).toEqual(['I7', 'I8', 'I9', 'I10', 'X4']);
  });

  /**
   * WP 3.10 shipped these seventeen off because four of their scopes had no
   * reader. WP 3.10a landed the readers, so the assertion inverts: each ships
   * **on**, with no reason, because there is no longer one to give. The
   * manifest properties beside it are unchanged and still checked — enabling a
   * rule must not have quietly changed what it is allowed to do.
   */
  it('ships every new rule enabled, its reader having landed', () => {
    for (const entry of NEW_RULES) {
      expect(entry.defaultEnabled, entry.ruleId).toBe(true);
      expect(entry.disabledReason, entry.ruleId).toBeNull();
      expect(entry.rule.manifest.kind, entry.ruleId).toBe('builtin');
      expect(entry.rule.manifest.capabilities.deterministic, entry.ruleId).toBe(true);
      // A built-in has no network path, so an `open_url` could never reach a
      // host nobody put there deliberately.
      expect(entry.rule.manifest.egress_allowlist, entry.ruleId).toEqual([]);
    }
    expect(NEW_RULES.filter((entry) => entry.wave === 'debt').length).toBe(6);
    expect(NEW_RULES.filter((entry) => entry.wave === 'investing').length).toBe(6);
    expect(NEW_RULES.filter((entry) => entry.wave === 'crypto').length).toBe(5);
  });

  it('every new insight declares confidence_basis deterministic and requires review', async () => {
    const snapshot = await seedSnapshot('drift');
    for (const entry of NEW_RULES) {
      for (const insight of evaluate(entry, snapshot)) {
        expect(insight.confidence_basis, entry.ruleId).toBe('deterministic');
        expect(insight.requires_review, entry.ruleId).toBe(true);
      }
    }
  });
});
