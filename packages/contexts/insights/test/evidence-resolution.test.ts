// SPDX-License-Identifier: MIT
/**
 * Step 5: "did we actually send this?"
 *
 * 08 §4.3 calls ref resolution "the single most effective anti-hallucination
 * check available, and it's pure validation, not a model". The two exit tests
 * the plan names are here, plus the one the orchestrator added, plus the
 * sabotage that proves each of them is load-bearing rather than incidental.
 *
 * **Sabotage record.** Both named tests were run once with the check disabled —
 * `resolveEvidence`'s `!resolution.ok` branch made unreachable — and both were
 * red on the first try. Restored. Recorded in
 * docs/evidence/phase-2/wp2.6-insights.md §4.
 */
import { describe, expect, it } from 'vitest';
import { resolveSourceRef } from '../src/validate/evidence.ts';
import { validateResponse } from '../src/validate/pipeline.ts';
import { baseInsight, baseSnapshot, fixture } from './fixtures.ts';

function validate(bundle: ReturnType<typeof fixture>) {
  return validateResponse({
    request: bundle.request,
    manifest: bundle.manifest,
    limits: { timeoutMs: 30_000, maxInsights: 20, maxResponseBytes: 131_072 },
    body: bundle.response,
  });
}

describe('evidence resolution', () => {
  it('accepts the fixture, so a red test below means the sabotage and not the fixture', () => {
    const outcome = validate(fixture());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.accepted).toHaveLength(1);
    expect(outcome.rejected).toEqual([]);
  });

  it('an insight citing a path we did not send is rejected', () => {
    // A *well-formed* path into a block that exists in the contract and not in
    // this snapshot. That is the realistic failure: an advisor that knows the
    // schema and guesses which blocks it was granted.
    const outcome = validate(
      fixture({
        insight: {
          evidence: [
            {
              kind: 'budget_line',
              label: 'Dining budget',
              value: null,
              source_ref: 'snapshot:budgets_status.lines[0].available',
              url: null,
            },
          ],
        },
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.accepted).toEqual([]);
    expect(outcome.rejected[0]?.step).toBe('evidence');
    expect(outcome.rejected[0]?.reason).toBe('source_ref_unresolvable');
  });

  it('an evidence ref that does not resolve is rejected', () => {
    // The same rule, exercised through the three other ways a ref can fail to
    // resolve: past the end of an array, into a key that is not in the block,
    // and through a prototype segment that would otherwise return "something".
    const refs = [
      'snapshot:recurring_list.streams[7].typical_amount',
      'snapshot:recurring_list.streams[0].cancellation_url',
      'snapshot:__proto__.polluted',
    ];
    for (const ref of refs) {
      const outcome = validate(
        fixture({
          insight: {
            evidence: [
              { kind: 'metric', label: 'A figure', value: null, source_ref: ref, url: null },
            ],
          },
        }),
      );
      expect(outcome.ok, ref).toBe(true);
      if (!outcome.ok) continue;
      expect(outcome.accepted, ref).toEqual([]);
      expect(outcome.rejected[0]?.step, ref).toBe('evidence');
    }
  });

  it('an insight with empty evidence is rejected', () => {
    // At the *schema* step, not the evidence step: `evidence` is `.min(1)`, so
    // an insight with nothing behind it is not an insight the type can express.
    // That is why this rejects the whole response rather than one insight —
    // and why an advisor built against the published schema cannot send one.
    const bundle = fixture();
    const outcome = validateResponse({
      request: bundle.request,
      manifest: bundle.manifest,
      limits: { timeoutMs: 30_000, maxInsights: 20, maxResponseBytes: 131_072 },
      body: {
        ...bundle.response,
        insights: [{ ...baseInsight(), evidence: [] }],
      },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.rejection.step).toBe('schema');
    expect(outcome.rejection.detail).toContain('evidence');
  });

  it('an evidence label that disagrees with what it cites is rejected', () => {
    // The failure mode a citation-shaped field invites: a real ref, and a value
    // beside it that is not what the ref holds. Exercised on a *primitive* —
    // money resolves to an object and is governed by the numeral check instead,
    // which `no-fabricated-numbers.test.ts` covers.
    const outcome = validate(
      fixture({
        insight: {
          evidence: [
            {
              kind: 'series',
              label: 'Cadence',
              value: 'WEEKLY',
              source_ref: 'snapshot:recurring_list.streams[0].cadence',
              url: null,
            },
          ],
        },
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.rejected[0]?.reason).toBe('evidence_value_disagrees');
  });

  it("an external link outside the advisor's own allow-list is rejected", () => {
    // A `builtin` ships with an empty allow-list, so it cannot link out at all.
    // `evil-example.com` is here too because a suffix match rather than a label
    // match is the classic way this check is written wrong.
    for (const [allowlist, url] of [
      [[], 'https://example.com/help'],
      [['example.com'], 'https://evil-example.com/help'],
      [['example.com'], 'http://example.com/help'],
      [['example.com'], 'https://user:pass@example.com/help'],
    ] as const) {
      const outcome = validate(
        fixture({
          manifest: { kind: 'external', egress_allowlist: [...allowlist] },
          insight: {
            // An external advisor may not claim determinism, and this suite is
            // not about that rule.
            confidence_basis: 'heuristic',
            evidence: [{ kind: 'external', label: 'Guidance', value: null, source_ref: null, url }],
          },
        }),
      );
      expect(outcome.ok, url).toBe(true);
      if (!outcome.ok) continue;
      expect(outcome.accepted, url).toEqual([]);
      expect(outcome.rejected[0]?.reason, url).toMatch(/^link_/);
    }
  });
});

describe('resolveSourceRef', () => {
  it('refuses a prototype segment before any lookup happens', () => {
    const snapshot = baseSnapshot();
    expect(resolveSourceRef(snapshot, 'snapshot:__proto__')).toEqual({
      ok: false,
      reason: 'forbidden_segment',
    });
    expect(resolveSourceRef(snapshot, 'snapshot:constructor.name')).toEqual({
      ok: false,
      reason: 'forbidden_segment',
    });
  });

  it('resolves a real path to the value we sent', () => {
    const resolution = resolveSourceRef(
      baseSnapshot(),
      'snapshot:recurring_list.streams[0].typical_amount.minor',
    );
    expect(resolution).toEqual({ ok: true, value: '1899' });
  });

  it('treats an undefined tail as a failure, not as a value', () => {
    // An ungranted scope produces no key, so a ref into it must fail rather
    // than resolve to `undefined` and be quietly rendered as "no data".
    expect(resolveSourceRef(baseSnapshot(), 'snapshot:holdings_detail.positions[0]')).toEqual({
      ok: false,
      reason: 'unknown_key',
    });
  });
});
