// SPDX-License-Identifier: MIT
/**
 * "There is no value an advisor can return that causes an action" (08 §4.3).
 *
 * The claim has three independent mechanisms behind it and each one is
 * sabotaged here. That redundancy is the point: a claim with one mechanism is a
 * claim with one place to forget it.
 *
 *   1. **`requires_review` is `z.literal(true)`.** `false` is a schema
 *      violation and the whole response is refused.
 *   2. **There is no `status` property and the object is strict.** An advisor
 *      that sends one is *rejected*, not ignored — which matters, because
 *      "ignored" is indistinguishable from "we forgot to read it".
 *   3. **`ValidatedInsight.status` is the literal `'pending_review'` and this
 *      module is its only constructor.** `store.ts`'s insert reads the literal
 *      and never the payload, so there is no assignment to delete.
 *
 * The database half — that a row really does land `pending_review` whatever the
 * advisor sent — is `test/db/persistence.test.ts`, because it is a claim about
 * Postgres.
 *
 * **Sabotage record.** `'no advisor return value produces status other than
 * pending_review'` was run twice, once per mechanism — `z.literal(true)` →
 * `z.boolean()`, and `InsightSchema`'s `strictObject` → `object` — and was red
 * on the first try each time. `'a response that does not echo request_id is
 * dropped'` was run once with the envelope check bypassed, also red. All
 * restored. Recorded in docs/evidence/phase-2/wp2.6-insights.md §4.
 */
import { describe, expect, it } from 'vitest';
import {
  AdvisorResponseSchema,
  InsightSchema,
  PROPOSED_ACTION_KINDS,
} from '../src/contract/response.ts';
import { validateResponse } from '../src/validate/pipeline.ts';
import { baseInsight, fixture } from './fixtures.ts';

const LIMITS = { timeoutMs: 30_000, maxInsights: 20, maxResponseBytes: 131_072 };

function validateBody(body: unknown, bundle = fixture()) {
  return validateResponse({
    request: bundle.request,
    manifest: bundle.manifest,
    limits: LIMITS,
    body,
  });
}

describe('pending review', () => {
  it('no advisor return value produces status other than pending_review', () => {
    const bundle = fixture();

    // The honest case: it is `pending_review`.
    const clean = validateBody(bundle.response, bundle);
    expect(clean.ok).toBe(true);
    if (clean.ok) {
      expect(clean.accepted[0]?.status).toBe('pending_review');
    }

    // Every way an advisor might try to say otherwise. Each is refused at the
    // schema step, so none of them produces an insight at all — let alone one
    // with a different status.
    const attempts: readonly [string, unknown][] = [
      ['a status property', { ...baseInsight(), status: 'accepted' }],
      ['requires_review: false', { ...baseInsight(), requires_review: false }],
      ['requires_review omitted', omit(baseInsight(), 'requires_review')],
      ['an auto_apply flag', { ...baseInsight(), auto_apply: true }],
      ['a reviewed_at timestamp', { ...baseInsight(), reviewed_at: '2026-09-19T09:00:00.000Z' }],
    ];

    for (const [name, insight] of attempts) {
      const outcome = validateBody({ ...bundle.response, insights: [insight] }, bundle);
      expect(outcome.ok, name).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.rejection.step, name).toBe('schema');
    }
  });

  it('proposed_actions[].kind has four non-acting members and no fifth', () => {
    // Not "excluded by policy": absent from the enum, so the type cannot hold
    // one. The membership is asserted rather than the exclusion, because a test
    // that only checks `execute` is rejected passes for a fifth member nobody
    // thought of.
    expect([...PROPOSED_ACTION_KINDS]).toEqual([
      'suggest_only',
      'open_url',
      'create_goal_draft',
      'create_rule_draft',
    ]);

    for (const kind of ['execute', 'transfer', 'trade', 'cancel_subscription']) {
      const parsed = InsightSchema.safeParse({
        ...baseInsight(),
        proposed_actions: [{ kind, label: 'Do it', rationale_md: '', url: null }],
      });
      expect(parsed.success, kind).toBe(false);
    }
  });

  it('the response object is strict, so an unknown field is refused and not ignored', () => {
    const bundle = fixture();
    const parsed = AdvisorResponseSchema.safeParse({
      ...bundle.response,
      execute_immediately: true,
    });
    expect(parsed.success).toBe(false);
  });

  it('a response that does not echo request_id is dropped', () => {
    // 08 §4.4 step 4. Without it, a response from the previous nightly run,
    // arriving late, lands in this run's review queue against this run's
    // digest — an insight attributed to a snapshot it never saw.
    const bundle = fixture();
    const outcome = validateBody(
      { ...bundle.response, request_id: '01930000-0000-7000-8000-0000000000ff' },
      bundle,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.rejection.step).toBe('envelope');
    expect(outcome.rejection.reason).toBe('request_id_mismatch');
  });

  it('a non-builtin advisor cannot claim deterministic confidence', () => {
    // 08 §4.3 reserves the basis, and reserves it twice: the manifest must
    // claim it *and* the kind must be `builtin`. A registration row edited to
    // `deterministic: true` on a sidecar buys nothing.
    const bundle = fixture({ manifest: { kind: 'external' } });
    const outcome = validateBody(bundle.response, bundle);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.rejected[0]?.step).toBe('capability');
    expect(outcome.rejected[0]?.reason).toBe('deterministic_reserved_for_builtin');
  });

  it('severity above the manifest ceiling is clamped, recorded, and not refused', () => {
    // Degradation is a first-class requirement (08 §4.4): dropping a real
    // finding because it shouted is worse than showing it quietly. The clamp is
    // recorded so "this advisor keeps trying to shout" stays answerable.
    const bundle = fixture({
      manifest: { capabilities: { ...fixture().manifest.capabilities, max_severity: 'info' } },
      insight: { severity: 'urgent' },
    });
    const outcome = validateBody(bundle.response, bundle);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.accepted[0]?.severity).toBe('info');
    expect(outcome.accepted[0]?.severityClamped).toBe(true);
    expect(outcome.accepted[0]?.insight.severity).toBe('urgent');
  });

  it('an advisor that did not claim produces_impact may not send one', () => {
    const bundle = fixture({
      manifest: {
        capabilities: { ...fixture().manifest.capabilities, produces_impact: false },
      },
    });
    const outcome = validateBody(bundle.response, bundle);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.rejected[0]?.reason).toBe('impact_not_claimed');
  });

  it('a narrator may restate a known finding and may not introduce one', () => {
    const manifest = {
      kind: 'local_model' as const,
      capabilities: {
        deterministic: false,
        produces_impact: true,
        narrates_only: true,
        max_severity: 'warning' as const,
      },
    };
    const bundle = fixture({ manifest, insight: { confidence_basis: 'model' } });

    const introduced = validateResponse({
      request: bundle.request,
      manifest: bundle.manifest,
      limits: LIMITS,
      body: bundle.response,
      knownFindingTypes: new Set<string>(),
    });
    expect(introduced.ok).toBe(true);
    if (introduced.ok) {
      expect(introduced.rejected[0]?.reason).toBe('narrator_introduced_finding');
    }

    // WP 5.3 made "restate" mean something checkable: a known type is the
    // coarse half, and the fine half is 1:1 — the request's `findings`
    // envelope (contract 1.5.0) carries the finding, and the narration names
    // it by key, type and period, cites only its refs, and carries no action,
    // derivation or impact of its own (`test/narrator.test.ts` holds each).
    // Before 5.3 this case passed on `knownFindingTypes` alone, with the
    // built-in's actions and derivation attached — the gap 5.3 closes.
    const finding = {
      key: 'subscription.annual_cost.MERCHANT_a7f31c9d0e42',
      period: '2026-09',
      type: 'subscription.annual_cost',
      severity: 'notable' as const,
      title: 'A monthly subscription adds up',
      summary_md: 'At $18.99 a month, this subscription costs $227.88 a year.',
      evidence: [
        {
          label: 'Monthly charge',
          value: '$18.99',
          source_ref: 'snapshot:recurring_list.streams[0].typical_amount',
        },
      ],
      derived: ['22788'],
      impact: { annualized: '$227.88', one_time: null, basis: 'The monthly charge, annualised.' },
    };
    const narration = baseInsight({
      confidence_basis: 'model',
      confidence: 0.6,
      summary_md: 'This subscription is $18.99 a month, or $227.88 over a year.',
      impact: { annualized: null, one_time: null, basis: '', derivation_id: null },
      derivations: [],
      proposed_actions: [],
    });
    const restated = validateResponse({
      request: { ...bundle.request, findings: [finding] },
      manifest: bundle.manifest,
      limits: LIMITS,
      body: { ...bundle.response, insights: [narration] },
      knownFindingTypes: new Set(['subscription.annual_cost']),
    });
    expect(restated.ok).toBe(true);
    if (restated.ok) {
      expect(restated.accepted).toHaveLength(1);
    }
  });

  it('two insights sharing an upsert key in one response are refused', () => {
    // `(advisor_id, key, period)` is the upsert key, so the second would
    // silently overwrite the first — a lost row, not a duplicate one.
    const bundle = fixture();
    const outcome = validateBody(
      { ...bundle.response, insights: [baseInsight(), baseInsight()] },
      bundle,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.rejection.reason).toBe('duplicate_insight_key');
  });

  it('a response over the byte limit is refused before it is parsed', () => {
    const bundle = fixture();
    const outcome = validateResponse({
      request: bundle.request,
      manifest: bundle.manifest,
      limits: { ...LIMITS, maxResponseBytes: 1024 },
      body: JSON.stringify(bundle.response),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.rejection.step).toBe('transport');
    expect(outcome.rejection.reason).toBe('response_too_large');
  });
});

/** `{ ...x }` minus one key, without mutating the original. */
function omit<T extends Record<string, unknown>>(value: T, key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...value };
  delete copy[key];
  return copy;
}
