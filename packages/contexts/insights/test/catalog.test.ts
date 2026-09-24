// SPDX-License-Identifier: MIT
/**
 * The catalogue as a whole: does every rule fire, cite, and survive the
 * pipeline it will be judged by in production?
 *
 * The §5 exit criterion — "every built-in advisor produces resolvable evidence
 * refs" — is the first test in this file, and it is asserted against a snapshot
 * `SnapshotBuilder` produced rather than a literal, because a ref resolves
 * against what we *sent* and nothing else.
 */
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_CATALOGUE,
  CATALOGUE_GAPS,
  CATALOGUE_SCOPE,
  createBuiltinRegistry,
} from '../src/advisors/catalogue.ts';
import { resolveLimits } from '../src/contract/manifest.ts';
import { severityRank, type Insight } from '../src/contract/response.ts';
import type { AdvisorSnapshot } from '../src/contract/snapshot.ts';
import type { AdvisorScope } from '../src/contract/scopes.ts';
import { resolveSourceRef } from '../src/validate/evidence.ts';
import { validateResponse } from '../src/validate/pipeline.ts';
import { contextOf } from '../src/advisors/support.ts';
import {
  EMPTY_SNAPSHOT,
  TODAY,
  USD,
  requestFor,
  seedSnapshot,
  type SeedCase,
} from './advisors/seed.ts';

const CASES: readonly SeedCase[] = ['drift', 'tight', 'control'];

function evaluate(
  entry: (typeof BUILTIN_CATALOGUE)[number],
  snapshot: AdvisorSnapshot,
): readonly Insight[] {
  return entry.rule.evaluate(contextOf(requestFor(entry.rule.manifest, snapshot))).insights;
}

describe('the built-in catalogue', () => {
  it('every rule produces at least one resolvable evidence ref on the seed', async () => {
    const snapshots = await Promise.all(CASES.map((name) => seedSnapshot(name)));

    for (const entry of BUILTIN_CATALOGUE) {
      const produced = snapshots.flatMap((snapshot, index) =>
        evaluate(entry, snapshot).map((insight) => ({ insight, snapshot: snapshots[index] })),
      );
      expect(produced.length, `${entry.ruleId} never fired on any seed case`).toBeGreaterThan(0);

      for (const { insight, snapshot } of produced) {
        expect(insight.evidence.length, `${entry.ruleId} ${insight.key}`).toBeGreaterThan(0);
        for (const row of insight.evidence) {
          expect(row.source_ref, `${entry.ruleId} ${insight.key}`).not.toBeNull();
          const ref = row.source_ref ?? '';
          const resolution = resolveSourceRef(snapshot as AdvisorSnapshot, ref);
          expect(resolution.ok, `${entry.ruleId} ${ref}`).toBe(true);
        }
      }
    }
  });

  it('every rule returns zero insights when its inputs are absent', () => {
    for (const entry of BUILTIN_CATALOGUE) {
      const output = entry.rule.evaluate({
        snapshot: EMPTY_SNAPSHOT,
        today: TODAY,
        period: '2026-09',
        baseCurrency: USD,
      });
      expect(output.insights, entry.ruleId).toEqual([]);
      expect(output.warnings, entry.ruleId).toEqual([]);
    }
  });

  it('every built-in insight passes the WP 2.6 pipeline unchanged', async () => {
    const signal = new AbortController().signal;
    let accepted = 0;

    for (const name of CASES) {
      const snapshot = await seedSnapshot(name);
      for (const entry of BUILTIN_CATALOGUE) {
        const manifest = entry.rule.manifest;
        const request = requestFor(manifest, snapshot);
        const body = await entry.advisor.run(request, signal);
        const outcome = validateResponse({
          request,
          manifest,
          limits: resolveLimits(manifest),
          body,
        });

        expect(outcome.ok, `${name}/${entry.ruleId} response rejected`).toBe(true);
        if (!outcome.ok) continue;
        expect(
          outcome.rejected,
          `${name}/${entry.ruleId} rejected ${JSON.stringify(outcome.rejected)}`,
        ).toEqual([]);
        expect(outcome.accepted.length).toBe(outcome.response.insights.length);
        for (const row of outcome.accepted) {
          // The only status there is, and the pipeline is its only constructor.
          expect(row.status).toBe('pending_review');
          // A built-in that got clamped would mean its manifest ceiling and its
          // own copy disagree, which is a bug in this package, not degradation.
          expect(row.severityClamped, `${entry.ruleId} ${row.insight.key}`).toBe(false);
        }
        accepted += outcome.accepted.length;
      }
    }

    expect(accepted).toBeGreaterThan(0);
  });

  it('every rule reads only the scopes its manifest declares', async () => {
    for (const name of ['drift', 'tight'] as const) {
      const full = await seedSnapshot(name);
      for (const entry of BUILTIN_CATALOGUE) {
        const narrow = await seedSnapshot(
          name,
          entry.rule.manifest.requires_scopes as readonly AdvisorScope[],
        );
        expect(evaluate(entry, narrow), `${name}/${entry.ruleId}`).toEqual(evaluate(entry, full));
      }
    }
  });

  it('every rule in scope is either implemented or has a stated reason', () => {
    const implemented = new Set(BUILTIN_CATALOGUE.map((entry) => entry.ruleId));
    const gaps = new Map(CATALOGUE_GAPS.map((gap) => [gap.ruleId, gap]));

    for (const ruleId of CATALOGUE_SCOPE) {
      const inCatalogue = implemented.has(ruleId);
      const gap = gaps.get(ruleId);
      expect(inCatalogue || gap !== undefined, `${ruleId} is in neither list`).toBe(true);
      expect(inCatalogue && gap !== undefined, `${ruleId} is in both lists`).toBe(false);
      if (gap !== undefined) {
        // A reason that names a missing field is actionable; "not done yet" is not.
        expect(gap.reason.length, ruleId).toBeGreaterThan(40);
      }
    }

    expect([...implemented].every((id) => CATALOGUE_SCOPE.includes(id))).toBe(true);
    expect(CATALOGUE_GAPS.every((gap) => CATALOGUE_SCOPE.includes(gap.ruleId))).toBe(true);
  });

  it('the whole catalogue registers, with one advisor per rule', () => {
    const registry = createBuiltinRegistry();
    expect(registry.list().length).toBe(BUILTIN_CATALOGUE.length);
    expect(new Set(BUILTIN_CATALOGUE.map((entry) => entry.advisorId)).size).toBe(
      BUILTIN_CATALOGUE.length,
    );
    for (const registered of registry.list()) {
      expect(registered.manifest.kind).toBe('builtin');
      expect(registered.manifest.capabilities.deterministic).toBe(true);
      expect(registered.manifest.capabilities.narrates_only).toBe(false);
      expect(registered.manifest.egress_allowlist).toEqual([]);
    }
    // Every rule wants the nightly schedule and nothing else, so the consumer's
    // derived event filter stays empty and a backfill wakes no advisor twice.
    expect(registry.scheduled().length).toBe(BUILTIN_CATALOGUE.length);
    expect(registry.eventTypes()).toEqual([]);
  });

  it('no rule emits a severity above its own manifest ceiling', async () => {
    for (const name of CASES) {
      const snapshot = await seedSnapshot(name);
      for (const entry of BUILTIN_CATALOGUE) {
        const ceiling = severityRank(entry.rule.manifest.capabilities.max_severity);
        for (const insight of evaluate(entry, snapshot)) {
          expect(
            severityRank(insight.severity),
            `${entry.ruleId} ${insight.key}`,
          ).toBeLessThanOrEqual(ceiling);
        }
      }
    }
  });

  /**
   * WP 3.10a moved the line. It used to sit between wave one and everything
   * else; it now sits between **spending** and everything else, because the
   * only wave still off is the one held back for pacing rather than for a
   * missing reader.
   */
  it('ships every wave with a reader enabled, leaving only spending off', () => {
    for (const entry of BUILTIN_CATALOGUE) {
      if (entry.wave === 'spending') {
        expect(entry.defaultEnabled, entry.ruleId).toBe(false);
        expect(entry.disabledReason, entry.ruleId).not.toBeNull();
      } else {
        expect(entry.defaultEnabled, entry.ruleId).toBe(true);
        expect(entry.disabledReason, entry.ruleId).toBeNull();
      }
    }
    // Twenty-five enabled: Phase 2's eight cash-and-subscriptions rules plus WP
    // 3.10's seventeen, switched on by WP 3.10a once `holdings.aggregate`,
    // `holdings.detail`, `liabilities.terms` and `market.rates` gained readers.
    // Six off: WP 2.7's spending rules, held by 07 §7.4's wave two alone — every
    // scope they read has been sourced since Phase 2.
    expect(BUILTIN_CATALOGUE.filter((entry) => entry.defaultEnabled).length).toBe(25);
    expect(BUILTIN_CATALOGUE.filter((entry) => !entry.defaultEnabled).length).toBe(6);
  });

  it('claims impact only where the manifest says it does', async () => {
    for (const name of CASES) {
      const snapshot = await seedSnapshot(name);
      for (const entry of BUILTIN_CATALOGUE) {
        const claims = entry.rule.manifest.capabilities.produces_impact;
        for (const insight of evaluate(entry, snapshot)) {
          const hasImpact = insight.impact.annualized !== null || insight.impact.one_time !== null;
          if (!claims) expect(hasImpact, `${entry.ruleId} ${insight.key}`).toBe(false);
        }
      }
    }
  });
});
