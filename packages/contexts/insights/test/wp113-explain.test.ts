// SPDX-License-Identifier: MIT
/**
 * WP 11.3 — `insight.explain`, pure: the request carries exactly the listed
 * fields of one insight or one pillar and the entity's own scopes; a reply is
 * accepted only when every figure in it is one of that subject's figures, it
 * carries no advice, link or markup, and it is the reply format; the approval
 * shape is this advisor's own; the self-test's grounding check passes on a
 * refusal and fails only when an outside figure survives.
 */
import { describe, expect, it } from 'vitest';
import { checkManifest } from '../src/registry.ts';
import {
  EXPLAIN_PROBE_TARGET,
  INSIGHT_EXPLAIN_MANIFEST,
  NARRATOR_SCOPES,
  buildExplainRequest,
  briefPrefetchIds,
  checkExplainGrounding,
  explainTraceContext,
  insightExplainShape,
  insightSubjectOf,
  pillarSubjectOf,
  validateExplainReply,
  type ExplainTarget,
  type WorkerCheckContext,
} from '../src/index.ts';
import { NARRATOR_MANIFEST } from '../src/advisors/local/manifest.ts';
import type { FindingSource } from '../src/advisors/local/findings.ts';
import { queryShape } from '../src/preview.ts';
import { fixedClock } from '@core/kernel';

const NOW = new Date('2026-10-27T12:00:00.000Z');

/** A synced-shape finding, with things a caller might wrongly add. */
function source(): FindingSource {
  return {
    key: 'builtin.cash.emergency_fund:2026-10',
    period: '2026-10',
    type: 'cash.emergency_fund',
    severity: 'notable',
    title: 'Your cash covers 2.4 months of spending',
    summaryMd: 'Cash of $7,200.00 covers 2.4 months of your recent spending of $3,000.00 a month.',
    evidence: [
      {
        label: 'Cash in checking and savings',
        value: '$7,200.00',
        sourceRef: 'snapshot:cash_summary.total.minor',
        resolvedDisplay: null,
      },
      {
        label: 'Average monthly spending',
        value: null,
        sourceRef: 'snapshot:cashflow_monthly.average_expense.minor',
        resolvedDisplay: '300000',
      },
      {
        label: 'Goal',
        value: 'Pay off Visa 4532',
        sourceRef: 'snapshot:goals_list.goals[0].name',
        resolvedDisplay: null,
      },
    ],
    derived: [{ id: 'months', value: '2.400000' }],
    impact: { annualized: null, oneTime: null, basis: 'Months of spending the cash would cover.' },
  };
}

const RULE = {
  name: 'Emergency fund',
  text: 'Reports how many months of recent spending the cash on hand would cover.',
};

function insightTarget(): ExplainTarget {
  const leaky = {
    ...insightSubjectOf(source(), RULE),
    insight_id: '00000000-0000-7000-8000-a00000000001',
    account_name: 'Everyday Checking at Example Bank',
  };
  return {
    entityKind: 'insight',
    entityId: '00000000-0000-7000-8000-a00000000001',
    subject: leaky,
    scopes: ['cash.summary', 'cashflow.monthly', 'goals.list'],
  };
}

const SCORED_PILLAR = {
  component: 'emergency_fund_months' as const,
  status: 'scored' as const,
  value: '2.4',
  band: 'fair' as const,
  weight: '0.200000',
  score: 50,
  inputs: [
    {
      key: 'cash_total',
      label: 'Cash in checking and savings',
      kind: 'money' as const,
      value: { minor: '720000', currency: 'USD' },
    },
    { key: 'cash_accounts', label: 'Cash accounts', kind: 'count' as const, value: '2' },
    {
      key: 'monthly_spending',
      label: 'Average monthly spending (last 6 months with spending)',
      kind: 'money' as const,
      value: { minor: '300000', currency: 'USD' },
    },
  ],
};

function pillarTarget(): ExplainTarget {
  return {
    entityKind: 'health_pillar',
    entityId: 'emergency_fund_months',
    subject: pillarSubjectOf(SCORED_PILLAR),
    scopes: ['cash.summary', 'cashflow.monthly'],
  };
}

function build(target: ExplainTarget) {
  return buildExplainRequest({ target, now: NOW, timeoutMs: 300_000, maxResponseBytes: 16_384 });
}

describe('the manifest', () => {
  it('registers: a narrates-only local_model advisor bounded by the narrator’s scopes, never transactions.raw', () => {
    expect(checkManifest(INSIGHT_EXPLAIN_MANIFEST)).toMatchObject({ ok: true });
    expect(INSIGHT_EXPLAIN_MANIFEST.advisor_id).toBe('insight.explain');
    expect(INSIGHT_EXPLAIN_MANIFEST.kind).toBe('local_model');
    expect(INSIGHT_EXPLAIN_MANIFEST.requires_scopes).toEqual([...NARRATOR_SCOPES]);
    expect(INSIGHT_EXPLAIN_MANIFEST.requires_scopes).not.toContain('transactions.raw');
    expect(INSIGHT_EXPLAIN_MANIFEST.capabilities).toMatchObject({
      deterministic: false,
      produces_impact: false,
      narrates_only: true,
      max_severity: 'info',
    });
    expect(INSIGHT_EXPLAIN_MANIFEST.egress_allowlist).toEqual([]);
  });
});

describe('the request (scope minimisation)', () => {
  it('an insight: the rule, title, summary, figures and evidence as the panel shows them — and its own scopes only', () => {
    const built = build(insightTarget());
    // Snapshot: what is sent, retained and digested. An id, an account name
    // and a goal name's digits a caller left on the objects are gone.
    expect(built.payload).toMatchInlineSnapshot(`
      {
        "granted_scopes": [
          "cash.summary",
          "cashflow.monthly",
          "goals.list",
        ],
        "snapshot": {
          "explain": {
            "entity_kind": "insight",
            "evidence": [
              {
                "label": "Cash in checking and savings",
                "source_ref": "snapshot:cash_summary.total.minor",
                "value": "$7,200.00",
              },
              {
                "label": "Average monthly spending",
                "source_ref": "snapshot:cashflow_monthly.average_expense.minor",
                "value": "$3,000.00",
              },
              {
                "label": "Goal",
                "source_ref": "snapshot:goals_list.goals[0].name",
                "value": "Pay off Visa",
              },
            ],
            "figures": {
              "basis": "Months of spending the cash would cover.",
              "one_time": null,
              "per_year": null,
            },
            "rule": {
              "name": "Emergency fund",
              "text": "Reports how many months of recent spending the cash on hand would cover.",
            },
            "summary": "Cash of $7,200.00 covers 2.4 months of your recent spending of $3,000.00 a month.",
            "title": "Your cash covers 2.4 months of spending",
          },
        },
      }
    `);
    const json = JSON.stringify(built.request);
    expect(json).not.toContain('00000000-0000-7000-8000-a00000000001');
    expect(json).not.toContain('Example Bank');
    expect(json).not.toContain('4532');
    expect(built.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    // Never the manifest's whole bound.
    expect(built.payload.granted_scopes).not.toEqual(INSIGHT_EXPLAIN_MANIFEST.requires_scopes);
  });

  it('a pillar: its words, ladder, bands and "Built from" values — no account or institution name', () => {
    const built = build(pillarTarget());
    expect(built.payload).toMatchInlineSnapshot(`
      {
        "granted_scopes": [
          "cash.summary",
          "cashflow.monthly",
        ],
        "snapshot": {
          "explain": {
            "band": "Fair",
            "built_from": [
              {
                "label": "Cash in checking and savings",
                "value": "$7,200.00",
              },
              {
                "label": "Cash accounts",
                "value": "2",
              },
              {
                "label": "Average monthly spending (last 6 months with spending)",
                "value": "$3,000.00",
              },
            ],
            "entity_kind": "health_pillar",
            "ladder": [
              "Poor: under 1 month",
              "Fair: 1 month to under 3 months",
              "Good: 3 months to under 6 months",
              "Excellent: 6 months or more",
            ],
            "next_band": {
              "band": "Good",
              "edge": "3 months",
            },
            "pillar": {
              "meaning": "How many months your cash would cover your spending.",
              "name": "Emergency fund",
            },
            "score": "50 out of 100",
            "value": "2.4 months",
          },
        },
      }
    `);
  });

  it('the digest is the cache key: the same evidence is the same digest, a changed figure a new one', () => {
    expect(build(insightTarget()).digest).toBe(build(insightTarget()).digest);
    const changed = insightTarget();
    const subject = changed.subject as ReturnType<typeof insightSubjectOf>;
    const moved = {
      ...changed,
      subject: {
        ...subject,
        evidence: subject.evidence.map((row, index) =>
          index === 0 ? { ...row, value: '$7,300.00' } : row,
        ),
      },
    };
    expect(build(moved).digest).not.toBe(build(insightTarget()).digest);
  });
});

describe('the reply (the numerals check against the evidence union, and the copy linter)', () => {
  const trace = build(insightTarget()).trace;
  const pillarTrace = build(pillarTarget()).trace;
  const say = (explanation: string) => ({ explanation });

  it('accepts an explanation whose every figure is an evidence value, quoting the summary whole', () => {
    const verdict = validateExplainReply(
      say(
        'This finding appeared because your cash, $7,200.00, is measured against average monthly ' +
          'spending of $3,000.00. Cash of $7,200.00 covers 2.4 months of your recent spending of ' +
          '$3,000.00 a month. More cash or lower spending would change it.',
      ),
      trace,
    );
    expect(verdict).toEqual({ ok: true, text: expect.stringContaining('$7,200.00') as string });
  });

  it('refuses a figure that is not in the evidence (numeral), in digits or in words (word_figure)', () => {
    expect(
      validateExplainReply(say('Your cash of $7,200.00 is short of $9,000.00.'), trace),
    ).toMatchObject({ ok: false, refusal: 'numeral' });
    expect(
      validateExplainReply(
        say('Your cash would need to be nearly five thousand dollars more.'),
        trace,
      ),
    ).toMatchObject({ ok: false, refusal: 'word_figure' });
    // A digit the model computed from the evidence is still a new figure.
    expect(validateExplainReply(say('That is 2.40 months.'), trace)).toMatchObject({
      ok: false,
      refusal: 'numeral',
    });
  });

  it('refuses advice (copy), markup, links, an empty or over-long text, and anything outside the format', () => {
    expect(
      validateExplainReply(
        say('Your cash covers part of a month. Move money into savings.'),
        trace,
      ),
    ).toMatchObject({ ok: false, refusal: 'copy' });
    expect(validateExplainReply(say('You should keep more cash.'), trace)).toMatchObject({
      ok: false,
      refusal: 'copy',
    });
    expect(validateExplainReply(say('# Heading\nCash.'), trace)).toMatchObject({
      ok: false,
      refusal: 'markup',
    });
    expect(validateExplainReply(say('The figure {{e1}} is cash.'), trace)).toMatchObject({
      ok: false,
      refusal: 'markup',
    });
    expect(
      validateExplainReply(say('See https://example.invalid/guide for more.'), trace),
    ).toMatchObject({ ok: false, refusal: 'link' });
    expect(validateExplainReply(say('   '), trace)).toMatchObject({ ok: false, refusal: 'empty' });
    expect(validateExplainReply(say('a'.repeat(901)), trace)).toMatchObject({
      ok: false,
      refusal: 'too_long',
    });
    expect(validateExplainReply({ explanation: 'ok', extra: 1 }, trace)).toMatchObject({
      ok: false,
      refusal: 'schema',
    });
    expect(validateExplainReply('plain text', trace)).toMatchObject({
      ok: false,
      refusal: 'schema',
    });
  });

  it('a pillar: figures from its value, score, ladder edges and inputs only', () => {
    expect(
      validateExplainReply(
        say(
          'Emergency fund scores 50 out of 100 and sits in Fair because your cash of $7,200.00 ' +
            'covers 2.4 months. Reaching 3 months would move it to Good.',
        ),
        pillarTrace,
      ),
    ).toMatchObject({ ok: true });
    expect(
      validateExplainReply(say('Another $1,800.00 would reach 3 months.'), pillarTrace),
    ).toMatchObject({ ok: false, refusal: 'numeral' });
  });

  it('the trace is built from this subject only: another insight’s figure is not a figure here', () => {
    const other = explainTraceContext(build(pillarTarget()).request.subject);
    expect(other.figures.has('7200.00')).toBe(true);
    expect(trace.figures.has('50')).toBe(false);
  });
});

describe('the approval shape', () => {
  it('is this advisor’s own: never the narrator’s, and a new template is a new shape', () => {
    const shape = insightExplainShape('sha256:template-a');
    expect(shape).not.toBe(
      queryShape({
        advisorId: NARRATOR_MANIFEST.advisor_id,
        advisorVersion: NARRATOR_MANIFEST.version,
        kind: 'local_model',
        scopes: NARRATOR_MANIFEST.requires_scopes,
        promptTemplateHash: 'sha256:template-a',
      }),
    );
    expect(insightExplainShape('sha256:template-b')).not.toBe(shape);
    expect(insightExplainShape('sha256:template-a')).toBe(shape);
  });
});

describe('the Brief prefetch bound', () => {
  it('takes the ranked items in order, at most five, never more', () => {
    const ids = Array.from({ length: 9 }, (_unused, index) => `id-${String(index)}`);
    expect(briefPrefetchIds(ids)).toEqual(['id-0', 'id-1', 'id-2', 'id-3', 'id-4']);
    expect(briefPrefetchIds(['a', 'a', 'b'])).toEqual(['a', 'b']);
  });
});

describe('the self-test: explain_grounding', () => {
  function context(reply: unknown | Error | null): WorkerCheckContext {
    return {
      model: null,
      unavailable: null,
      request: {} as never,
      clock: fixedClock(NOW),
      probesSent: 0,
      budgetBefore: null,
      explain:
        reply === null
          ? null
          : {
              label: 'fake@sha256:probe',
              figure: '$9,173.46',
              probe: () =>
                reply instanceof Error ? Promise.reject(reply) : Promise.resolve({ reply }),
            },
      timing: { probeTimeoutMs: 1_000 },
    };
  }

  it('passes when the model obeys and the validator refuses the outside figure', async () => {
    const outcome = await checkExplainGrounding(
      context({ explanation: 'Your accounts total $9,173.46.' }),
    );
    expect(outcome.status).toBe('pass');
    expect(outcome.facts.join(' ')).toContain('numeral');
  });

  it('passes when the model declines and explains from the evidence alone', async () => {
    const outcome = await checkExplainGrounding(
      context({ explanation: 'The self-test figure is $250.00.' }),
    );
    expect(outcome.status).toBe('pass');
  });

  it('fails when an outside figure survives the validator (proved here by a probe subject that carries it)', async () => {
    const leaky = {
      ...EXPLAIN_PROBE_TARGET,
      subject: {
        ...(EXPLAIN_PROBE_TARGET.subject as ReturnType<typeof insightSubjectOf>),
        evidence: [{ label: 'Total', value: '$9,173.46', source_ref: null }],
      },
    };
    const trace = build(leaky).trace;
    // The validator alone accepts a figure the subject carries; the check
    // sends a subject that does not, so obeying can never pass it.
    expect(validateExplainReply({ explanation: 'Your accounts total $9,173.46.' }, trace).ok).toBe(
      true,
    );
    expect(JSON.stringify(EXPLAIN_PROBE_TARGET)).not.toContain('9,173.46');
  });

  it('is not applicable with no explain model, and skipped when the probe cannot reach it', async () => {
    expect(await checkExplainGrounding(context(null))).toMatchObject({
      status: 'skipped',
      notApplicable: true,
    });
    expect((await checkExplainGrounding(context(new Error('down')))).status).toBe('skipped');
  });
});
