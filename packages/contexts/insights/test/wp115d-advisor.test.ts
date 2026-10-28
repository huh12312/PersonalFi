// SPDX-License-Identifier: MIT
/**
 * WP 11.5d — Ask PersonalFi, advisor mode: the pure halves, with no database
 * and no model. The protocol's tables (topic → page, the action screens, the
 * rubric), every step's request (each payload pinned) and validator with its
 * refusal classes, the context object built from **real** catalogue
 * envelopes (11.5b's fixture), the knowledge base with zero reviewed pages and
 * with them, the judge's masking, the watcher, the follow-up's Brief item
 * through the seven-step validator, the consent text, and the sixteenth
 * control check.
 *
 * The run (gates, the step claims, the kill ladder, the api's no-model rule,
 * D31's provider rule) is proven over a real database in
 * `apps/api/test/db/wp115d-advisor.test.ts`; the red team in
 * `apps/api/test/redteam-advisor.test.ts`.
 */
import { configHash } from '@core/platform';
import { describe, expect, it } from 'vitest';
import { PLAYBOOK_PAGES } from '../data/playbook.ts';
import {
  ADVISOR_ACTION_SCREEN_PATHS,
  ADVISOR_CONSENT_TEXT,
  ADVISOR_CONSENT_VERSION,
  ADVISOR_FOLLOW_UP_MANIFEST,
  ADVISOR_RUBRIC_PAGES,
  ADVISOR_STEP_IDS,
  advisorConsentSha256,
  advisorGatherQuestion,
  advisorKnowledgeFor,
  advisorPagesFor,
  advisorRubricFor,
  advisorShapeTemplateHash,
  advisorStepShape,
  advisorWatcherFor,
  buildAdvisorContext,
  buildClarifyRequest,
  buildJudgeRequest,
  buildOptionsRequest,
  buildPlanRequest,
  buildTradeoffsRequest,
  followUpInsightOf,
  gatherRefusalOf,
  maskNarration,
  scoreText,
  validateClarifyReply,
  validateJudgeReply,
  validateOptionsReply,
  validatePlanReply,
  validateTradeoffsReply,
  type AdvisorOption,
  type AdvisorTradeoff,
  type BuiltAdvisorContext,
} from '../src/advisors/advisor/index.ts';
import { askResultViewOf, type AskResultView } from '../src/advisors/ask/index.ts';
import {
  CATALOGUE,
  catalogueDescription,
  type CatalogueFunctionName,
} from '../src/catalogue/catalogue.ts';
import { checkAdvisorCostPairing, CONTROL_CHECKS } from '../src/control-checks/catalogue.ts';
import { resolveLimits } from '../src/contract/manifest.ts';
import { ADVISOR_CONTRACT_MAJOR } from '../src/contract/version.ts';
import { knowledgeCatalogueOf } from '../src/knowledge/citations.ts';
import type { PlaybookPageData } from '../src/knowledge/page.ts';
import type { ParameterCitation, ParameterPort } from '../src/knowledge/params.ts';
import { createKnowledgeBase, type KnowledgeBase } from '../src/knowledge/playbook.ts';
import { validateResponse } from '../src/validate/pipeline.ts';
import { ARGS, call, fixtureSnapshot, GOAL_ID, TOKEN_KEY } from './fixtures/catalogue-context.ts';
import { goalRef } from '../src/snapshot/builder.ts';

const NOW = new Date('2026-10-28T15:00:00.000Z');
const LIMITS = { now: NOW, timeoutMs: 300_000, maxResponseBytes: 16_384 };

async function view(
  name: CatalogueFunctionName,
  args?: Record<string, unknown>,
): Promise<AskResultView> {
  const raw = args ?? (ARGS[name] as Record<string, unknown> | undefined) ?? {};
  const envelope = await call(name, raw);
  return askResultViewOf(
    name,
    CATALOGUE[name].args.parse(raw) as Record<string, unknown>,
    envelope,
  );
}

const VERSION = `sha256:${'c'.repeat(64)}`;
const fakePort = (citations: readonly ParameterCitation[]): ParameterPort => {
  const byKey = new Map(citations.map((citation) => [citation.key, citation]));
  return {
    get(key) {
      const citation = byKey.get(key);
      return citation === undefined
        ? { found: false, reason: 'unknown', detail: 'no such key' }
        : { found: true, citation };
    },
  };
};
const PARAMS: readonly ParameterCitation[] = [
  {
    key: 'tax.us.2026.retirement.ira_contribution', // gitleaks:allow — a parameter key, not a secret
    kind: 'money',
    value: { minor: '750000', currency: 'USD' },
    source: 'fixture',
    asOf: '2026-01-01',
    parametersVersion: VERSION,
  },
  {
    key: 'assumptions.market_reference.treasury_bill_3_month',
    kind: 'rate',
    value: '0.0393',
    source: 'fixture',
    asOf: '2026-01-01',
    parametersVersion: VERSION,
  },
  {
    key: 'assumptions.market_reference.fdic_insurance_limit',
    kind: 'money',
    value: { minor: '25000000', currency: 'USD' },
    source: 'fixture',
    asOf: '2026-01-01',
    parametersVersion: VERSION,
  },
];
/** Every page a draft, as the tree ships: the advisor must work with zero reviewed pages. */
const DRAFTS: KnowledgeBase = createKnowledgeBase({ params: fakePort(PARAMS) });
function reviewed(page: PlaybookPageData): PlaybookPageData {
  return { ...page, status: 'reviewed', reviewedBy: 'test reviewer', reviewedOn: '2026-10-28' };
}
/** Tests only: the pages as they will be once Chris reviews them. */
const REVIEWED: KnowledgeBase = createKnowledgeBase({
  params: fakePort(PARAMS),
  pages: PLAYBOOK_PAGES.map(reviewed),
});

const RESTATEMENT = 'Whether to pay down the cards faster or put the money toward the IRA.';
const ANSWERS = [{ question: 'Is there an employer match?', answer: 'No match.' }];

async function contextOf(knowledge: KnowledgeBase | null): Promise<{
  readonly built: BuiltAdvisorContext;
  readonly results: readonly AskResultView[];
  readonly sent: ReturnType<typeof advisorKnowledgeFor>;
}> {
  const results = [await view('debt.payoff_plan'), await view('limits.contribution_room')];
  const sent = advisorKnowledgeFor(knowledge, {
    text: advisorGatherQuestion({ restatement: RESTATEMENT, answers: ANSWERS }),
    results,
  });
  const built = buildAdvisorContext({
    restatement: RESTATEMENT,
    answers: ANSWERS,
    date: '2026-10-28',
    results,
    knowledge: sent,
    knowledgeCatalogue: knowledge === null ? null : knowledgeCatalogueOf(knowledge),
  });
  return { built, results, sent };
}

const OPTIONS_REPLY = {
  options: [
    {
      label: 'Cards first, avalanche order',
      backed_by: ['r1:plans[0].total_interest', 'r1:plans[0].months'],
      summary: 'The cards are paid off in 5 months with $18.03 of interest.',
    },
    {
      label: 'IRA room first',
      backed_by: ['r2:remaining'],
      summary: 'The IRA has $4,000.00 of room left this year.',
    },
  ],
};
const TRADEOFFS_REPLY = {
  tradeoffs: [
    {
      option: 'o1',
      benefit: ['r1:plans[0].months'],
      cost: ['r1:plans[0].total_interest', 'r2:remaining'],
      note: 'Clears the cards in 5 months, leaving $4,000.00 of IRA room unused this year.',
    },
    {
      option: 'o2',
      benefit: ['r2:remaining'],
      cost: ['r1:plans[1].total_interest'],
      note: 'Uses the IRA room; a slower payoff costs $19.92 of interest.',
    },
  ],
};

// ---------------------------------------------------------------------------

describe('the protocol’s closed tables', () => {
  it('picks playbook pages by topic keyword, deterministically and in table order', () => {
    expect(
      advisorPagesFor('Should I pay off my car loan or invest the extra $400 a month?'),
    ).toEqual(['debt-order']);
    expect(advisorPagesFor('Where should I put $15,000 that’s sitting in checking?')).toEqual([
      'emergency-fund',
    ]);
    expect(advisorPagesFor('Can I retire at 60?')).toEqual(['guardrail-withdrawal']);
    expect(advisorPagesFor('How should I fill my IRA and 401(k) this year?')).toEqual([
      'tax-advantaged-order',
    ]);
    expect(advisorPagesFor('When should I claim Social Security?')).toEqual(['claiming-age']);
    expect(advisorPagesFor('What is the weather?')).toEqual([]);
  });

  it('lists only real in-app routes as action screens — 11.5c’s plus the goal, rule, connection and plan screens', () => {
    for (const path of ['/goals', '/settings', '/accounts/connections', '/plan', '/accounts']) {
      expect(ADVISOR_ACTION_SCREEN_PATHS).toContain(path);
    }
    for (const path of ADVISOR_ACTION_SCREEN_PATHS) {
      expect(path).toMatch(/^\/[a-z/-]*$/u);
    }
  });

  it('has a rubric for every playbook page (cost, non-applicability, scope) and a general one; none carries a figure', () => {
    expect([...ADVISOR_RUBRIC_PAGES].sort()).toEqual(PLAYBOOK_PAGES.map((page) => page.key).sort());
    for (const page of [...ADVISOR_RUBRIC_PAGES, 'nothing-matched']) {
      const rubric = advisorRubricFor([page]);
      expect(rubric.criteria.map((criterion) => criterion.id)).toEqual([
        'cost_surfaced',
        'non_applicability',
        'scope_kept',
      ]);
      expect(JSON.stringify(rubric)).not.toMatch(/\d/u);
    }
    expect(advisorRubricFor([]).page).toBe('general');
  });
});

describe('the consent (D31): versioned text, sha256 folded into every step’s shape', () => {
  it('says exactly what leaves: the question, the minimised results, the playbook text — never a row, an account number or an institution name', () => {
    expect(ADVISOR_CONSENT_VERSION).toBe('advisor-consent/1');
    expect(ADVISOR_CONSENT_TEXT).toContain('the question you typed');
    expect(ADVISOR_CONSENT_TEXT).toContain('merchants as pseudonyms');
    expect(ADVISOR_CONSENT_TEXT).toContain('playbook pages');
    expect(ADVISOR_CONSENT_TEXT).toContain(
      'Never a transaction row, an account number or an institution name',
    );
    expect(ADVISOR_CONSENT_TEXT).toContain('Unticked, the advisor runs on the local model only');
    expect(advisorConsentSha256()).toBe(
      `sha256:${configHash({ version: ADVISOR_CONSENT_VERSION, text: ADVISOR_CONSENT_TEXT })}`,
    );
  });

  it('keys each step’s approval to its own advisor id and to the consent text', () => {
    const template = `sha256:${'d'.repeat(64)}`;
    const shapes = new Set(
      (Object.keys(ADVISOR_STEP_IDS) as (keyof typeof ADVISOR_STEP_IDS)[]).map((step) =>
        advisorStepShape(step, template),
      ),
    );
    expect(shapes.size).toBe(6);
    expect(advisorShapeTemplateHash('options', template)).toBe(
      `sha256:${configHash({
        step: 'options',
        template,
        consent_version: 'advisor-consent/1',
        consent: advisorConsentSha256(),
      })}`,
    );
  });
});

// ---------------------------------------------------------------------------

describe('advisor.clarify', () => {
  const goal = goalRef(TOKEN_KEY, GOAL_ID);
  const built = buildClarifyRequest({
    question: 'Should I pay off my car loan or invest the extra $400 a month?',
    listing: catalogueDescription().functions.filter((entry) =>
      ['debt.payoff_plan', 'goal.required_savings'].includes(entry.name),
    ),
    defaults: { retirementAge: 67, goals: [{ goal_ref: goal, name: 'House deposit' }] },
    grantedScopes: ['goals.list', 'plan.projection'],
    ...LIMITS,
  });

  it('sends the question, the listing’s summaries (never a schema) and the defaults by ref — pinned', () => {
    expect(built.payload).toMatchInlineSnapshot(`
      {
        "granted_scopes": [
          "goals.list",
          "plan.projection",
        ],
        "snapshot": {
          "advisor_clarify": {
            "defaults": {
              "refs": [
                {
                  "about": "the retirement age in your plan",
                  "ref": "plan:retirement_age",
                  "value": "age 67",
                },
                {
                  "about": "a goal",
                  "ref": "goal:GOAL_df4b349dc937",
                  "value": "House deposit",
                },
              ],
            },
            "functions": [
              {
                "name": "debt.payoff_plan",
                "summary": "Payoff date and total interest for paying debts in avalanche, snowball or your own order, side by side, and the difference in dollars.",
              },
              {
                "name": "goal.required_savings",
                "summary": "The additional monthly contribution that reaches a goal’s target by its date.",
              },
            ],
            "max_questions": 2,
            "question": "Should I pay off my car loan or invest the extra $400 a month?",
          },
        },
      }
    `);
    expect(built.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(JSON.stringify(built.payload)).not.toMatch(/"parameters"|"\$defs"|01900000/u);
  });

  const ok = {
    restatement: 'Whether an extra $400 a month goes further on the car loan or invested.',
    questions: ['Is there an employer match on your workplace plan?'],
    assumed: [{ about: 'retirement age', value_ref: 'plan:retirement_age' }],
  };

  it('accepts a restatement with only the question’s figures, a real question and sent refs', () => {
    const verdict = validateClarifyReply(ok, built.check);
    expect(verdict).toMatchObject({ ok: true });
    if (verdict.ok) expect(verdict.clarification.questions).toHaveLength(1);
  });

  it('refuses by class: three questions, a statement, a ref never sent, a figure not in the question, advice', () => {
    const cases: [unknown, string][] = [
      [
        { ...ok, questions: ['Which goal?', 'By when?', 'How much a month?'] },
        'clarify.too_many_questions',
      ],
      [{ ...ok, questions: ['Tell me about the loan.'] }, 'clarify.not_a_question'],
      [{ ...ok, questions: ['Which loan? And which rate?'] }, 'clarify.not_a_question'],
      [
        { ...ok, assumed: [{ about: 'a goal', value_ref: 'goal:GOAL_ffffffffffff' }] },
        'clarify.ref_not_sent',
      ],
      [
        { ...ok, restatement: 'Whether GOAL_ffffffffffff should get the $400.' },
        'clarify.ref_not_sent',
      ],
      [
        { ...ok, restatement: 'Whether $500 a month goes to the loan.' },
        'clarify.restatement.numeral',
      ],
      [
        { ...ok, restatement: 'You should pay off the loan with the $400.' },
        'clarify.restatement.copy',
      ],
      [{ ...ok, extra: 1 }, 'clarify.schema'],
      ['not json', 'clarify.schema'],
    ];
    for (const [reply, refusal] of cases) {
      expect(validateClarifyReply(reply, built.check), refusal).toMatchObject({
        ok: false,
        refusal,
      });
    }
    expect(
      validateClarifyReply(
        { ...ok, assumed: [{ about: 'the house goal', value_ref: `goal:${goal}` }] },
        built.check,
      ),
    ).toMatchObject({ ok: true });
  });
});

describe('advisor.gather (11.5c’s compile step, reused) and the knowledge it reads', () => {
  it('compiles the restatement and the answers as the question text', () => {
    expect(advisorGatherQuestion({ restatement: RESTATEMENT, answers: ANSWERS })).toBe(
      `${RESTATEMENT} Is there an employer match? No match.`,
    );
    expect(gatherRefusalOf('compile.unknown_function')).toBe('gather.unknown_function');
  });

  it('with zero reviewed pages, sends none and records every page the topic and the results touch as withheld', async () => {
    const { sent } = await contextOf(DRAFTS);
    expect(sent.pages).toEqual([]);
    expect(sent.topicPages).toEqual(['debt-order', 'tax-advantaged-order']);
    expect(sent.withheld).toEqual([
      { key: 'debt-order', code: 'playbook.unreviewed' },
      { key: 'tax-advantaged-order', code: 'playbook.unreviewed' },
    ]);
  });

  it('with the pages reviewed, sends them whole (and only then)', async () => {
    const { sent, built } = await contextOf(REVIEWED);
    // debt-order renders whole; tax-advantaged-order cites parameters this fake store does not
    // hold, so the knowledge base serves it whole or not at all — not at all.
    expect(sent.pages.map((page) => page.key)).toEqual(['debt-order']);
    expect(sent.withheld).toEqual([
      { key: 'tax-advantaged-order', code: 'playbook.param_unavailable' },
    ]);
    expect(built.context.knowledge.pages.map((page) => page.key)).toEqual(['debt-order']);
  });
});

describe('the context object (07 §7.3)', () => {
  it('carries the figures with the app’s refs, and its digest is stable', async () => {
    const one = await contextOf(DRAFTS);
    const two = await contextOf(DRAFTS);
    expect(one.built.digest).toBe(two.built.digest);
    expect(one.built.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(one.built.check.refs.get('r2:remaining')).toEqual({
      ref: 'r2:remaining',
      label: 'Remaining',
      text: '$4,000.00',
    });
    expect(one.built.context.results.map((result) => result.id)).toEqual(['r1', 'r2']);
    expect(JSON.stringify(one.built.context)).not.toMatch(/"inputs"|01900000|institution/u);
  });
});

// ---------------------------------------------------------------------------

describe('advisor.options', () => {
  it('sends the context object and the bounds — pinned', async () => {
    const { built } = await contextOf(DRAFTS);
    const request = buildOptionsRequest({
      context: built.context,
      grantedScopes: ['cashflow.monthly', 'liabilities.terms'],
      ...LIMITS,
    });
    expect(request.payload).toMatchInlineSnapshot(`
      {
        "granted_scopes": [
          "cashflow.monthly",
          "liabilities.terms",
        ],
        "snapshot": {
          "advisor_options": {
            "context": {
              "answers": [
                {
                  "answer": "No match.",
                  "question": "Is there an employer match?",
                },
              ],
              "date": "2026-10-28",
              "knowledge": {
                "pages": [],
                "params": [
                  {
                    "key": "tax.us.2026.retirement.ira_contribution",
                    "rendered": "$7,500 (tax year 2026)",
                  },
                ],
              },
              "question": "Whether to pay down the cards faster or put the money toward the IRA.",
              "results": [
                {
                  "as_of": "2026-10-28",
                  "facts": [
                    "avalanche",
                    "LIABILITY_a",
                    "credit_card",
                    "LIABILITY_b",
                    "LIABILITY_c",
                    "no_apr",
                    "paid_off",
                    "snowball",
                  ],
                  "figures": [
                    {
                      "label": "Monthly budget",
                      "ref": "r1:monthly_budget",
                      "text": "$100.00",
                    },
                    {
                      "label": "Included · credit card 1 · balance",
                      "ref": "r1:included[0].balance",
                      "text": "$300.00",
                    },
                    {
                      "label": "Included · credit card 1 · APR",
                      "ref": "r1:included[0].apr",
                      "text": "24%",
                    },
                    {
                      "label": "Included · credit card 1 · minimum payment",
                      "ref": "r1:included[0].minimum_payment",
                      "text": "$20.00",
                    },
                    {
                      "label": "Included · credit card 2 · balance",
                      "ref": "r1:included[1].balance",
                      "text": "$100.00",
                    },
                    {
                      "label": "Included · credit card 2 · APR",
                      "ref": "r1:included[1].apr",
                      "text": "12%",
                    },
                    {
                      "label": "Included · credit card 2 · minimum payment",
                      "ref": "r1:included[1].minimum_payment",
                      "text": "$20.00",
                    },
                    {
                      "label": "Plans · avalanche · months",
                      "ref": "r1:plans[0].months",
                      "text": "5 months",
                    },
                    {
                      "label": "Plans · avalanche · payoff month",
                      "ref": "r1:plans[0].payoff_month",
                      "text": "2027-03",
                    },
                    {
                      "label": "Plans · avalanche · total interest",
                      "ref": "r1:plans[0].total_interest",
                      "text": "$18.03",
                    },
                    {
                      "label": "Plans · avalanche · total paid",
                      "ref": "r1:plans[0].total_paid",
                      "text": "$418.03",
                    },
                    {
                      "label": "Plans · snowball · months",
                      "ref": "r1:plans[1].months",
                      "text": "5 months",
                    },
                    {
                      "label": "Plans · snowball · payoff month",
                      "ref": "r1:plans[1].payoff_month",
                      "text": "2027-03",
                    },
                    {
                      "label": "Plans · snowball · total interest",
                      "ref": "r1:plans[1].total_interest",
                      "text": "$19.92",
                    },
                    {
                      "label": "Plans · snowball · total paid",
                      "ref": "r1:plans[1].total_paid",
                      "text": "$419.92",
                    },
                    {
                      "label": "Differences · 1 · interest",
                      "ref": "r1:differences[0].interest",
                      "text": "-$1.89",
                    },
                    {
                      "label": "Differences · 1 · months",
                      "ref": "r1:differences[0].months",
                      "text": "0 months",
                    },
                    {
                      "label": "Plans · avalanche · debts · 1 · payoff month",
                      "ref": "r1:plans[0].debts[0].payoff_month",
                      "text": "2027-02",
                    },
                    {
                      "label": "Plans · avalanche · debts · 1 · interest",
                      "ref": "r1:plans[0].debts[0].interest",
                      "text": "$15.00",
                    },
                    {
                      "label": "Plans · avalanche · debts · 2 · payoff month",
                      "ref": "r1:plans[0].debts[1].payoff_month",
                      "text": "2027-03",
                    },
                    {
                      "label": "Plans · avalanche · debts · 2 · interest",
                      "ref": "r1:plans[0].debts[1].interest",
                      "text": "$3.03",
                    },
                    {
                      "label": "Plans · snowball · debts · 1 · payoff month",
                      "ref": "r1:plans[1].debts[0].payoff_month",
                      "text": "2027-03",
                    },
                    {
                      "label": "Plans · snowball · debts · 1 · interest",
                      "ref": "r1:plans[1].debts[0].interest",
                      "text": "$18.71",
                    },
                    {
                      "label": "Plans · snowball · debts · 2 · payoff month",
                      "ref": "r1:plans[1].debts[1].payoff_month",
                      "text": "2026-12",
                    },
                  ],
                  "function": "debt.payoff_plan",
                  "id": "r1",
                  "label": "debt payoff plan (avalanche, $60.00 extra a month)",
                  "more_figures": 1,
                  "not_available": null,
                  "status": "ok",
                },
                {
                  "as_of": "2026-10-28",
                  "facts": [
                    "ira",
                    "from age fifty",
                    "One limit is shared across traditional and Roth IRAs, and a year’s contributions can be made until the filing deadline the following April.",
                    "Catch-up amounts apply only at the ages shown and are not added to the limit here.",
                  ],
                  "figures": [
                    {
                      "label": "Year",
                      "ref": "r2:year",
                      "text": "2026",
                    },
                    {
                      "label": "Limit",
                      "ref": "r2:limit",
                      "text": "$7,500.00",
                    },
                    {
                      "label": "Contributed",
                      "ref": "r2:contributed",
                      "text": "$3,500.00",
                    },
                    {
                      "label": "Remaining",
                      "ref": "r2:remaining",
                      "text": "$4,000.00",
                    },
                    {
                      "label": "Over limit",
                      "ref": "r2:over_limit",
                      "text": "$0.00",
                    },
                    {
                      "label": "Days left",
                      "ref": "r2:days_left",
                      "text": "64 days",
                    },
                    {
                      "label": "Catch ups · 1 · amount",
                      "ref": "r2:catch_ups[0].amount",
                      "text": "$1,100.00",
                    },
                  ],
                  "function": "limits.contribution_room",
                  "id": "r2",
                  "label": "contribution room (2026, IRA)",
                  "more_figures": 0,
                  "not_available": null,
                  "status": "ok",
                },
              ],
            },
            "max_options": 4,
            "min_options": 2,
          },
        },
      }
    `);
  });

  it('accepts backed options, each with the figures its refs resolve to', async () => {
    const { built } = await contextOf(DRAFTS);
    const verdict = validateOptionsReply(OPTIONS_REPLY, built.check);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.options.map((option) => option.id)).toEqual(['o1', 'o2']);
    expect(verdict.options[1]?.backed_by).toEqual([
      { ref: 'r2:remaining', label: 'Remaining', text: '$4,000.00' },
    ]);
    expect(verdict.dropped).toBe(0);
  });

  it('drops an option with no backing before narration; fewer than two left refuses the step', async () => {
    const { built } = await contextOf(DRAFTS);
    const third = {
      label: 'Something else',
      backed_by: ['r9:nothing'],
      summary: 'No figure behind it.',
    };
    const dropped = validateOptionsReply(
      { options: [...OPTIONS_REPLY.options, third] },
      built.check,
    );
    expect(dropped).toMatchObject({ ok: true, dropped: 1 });
    if (dropped.ok)
      expect(dropped.options.map((option) => option.label)).not.toContain('Something else');
    const unbacked = validateOptionsReply(
      { options: [OPTIONS_REPLY.options[0], { ...third }, { ...third, label: 'Another' }] },
      built.check,
    );
    expect(unbacked).toMatchObject({ ok: false, refusal: 'options.unbacked' });
  });

  it('refuses by class: a count outside two to four, a figure outside the context, a draft page cited, advice', async () => {
    const { built } = await contextOf(DRAFTS);
    const first = OPTIONS_REPLY.options[0] as (typeof OPTIONS_REPLY.options)[number];
    const second = OPTIONS_REPLY.options[1] as (typeof OPTIONS_REPLY.options)[number];
    const cases: [unknown, string][] = [
      [{ options: [first] }, 'options.count'],
      [{ options: [first, second, first, second, first] }, 'options.count'],
      [
        { options: [first, { ...second, summary: 'The IRA has $9,999.00 of room.' }] },
        'options.summary.numeral',
      ],
      [
        {
          options: [
            first,
            { ...second, summary: 'The IRA comes first [playbook:tax-advantaged-order].' },
          ],
        },
        'options.summary.citation.page_not_sent',
      ],
      [
        { options: [first, { ...second, summary: 'You should fill the IRA.' }] },
        'options.summary.copy',
      ],
      [{ options: [first, { ...second, label: 'Visit example.com' }] }, 'options.label.link'],
      [{ options: [first, { ...second, backed_by: 'r2:remaining' }] }, 'options.schema'],
    ];
    for (const [reply, refusal] of cases) {
      expect(validateOptionsReply(reply, built.check), refusal).toMatchObject({
        ok: false,
        refusal,
      });
    }
  });

  it('cites a page only when it was reviewed and sent', async () => {
    const { built } = await contextOf(REVIEWED);
    const verdict = validateOptionsReply(
      {
        options: [
          OPTIONS_REPLY.options[0],
          {
            ...OPTIONS_REPLY.options[1],
            summary: 'The cards come first in avalanche order [playbook:debt-order].',
          },
        ],
      },
      built.check,
    );
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.record?.cited.pages).toEqual(['debt-order']);
  });
});

describe('advisor.tradeoffs — every option paired with its cost', () => {
  async function options(): Promise<{
    built: BuiltAdvisorContext;
    options: readonly AdvisorOption[];
  }> {
    const { built } = await contextOf(DRAFTS);
    const verdict = validateOptionsReply(OPTIONS_REPLY, built.check);
    if (!verdict.ok) throw new Error('fixture options refused');
    return { built, options: verdict.options };
  }

  it('sends the context object and the surviving options — pinned', async () => {
    const { built, options: opts } = await options();
    const request = buildTradeoffsRequest({
      context: built.context,
      options: opts,
      grantedScopes: ['cashflow.monthly', 'liabilities.terms'],
      ...LIMITS,
    });
    expect(request.payload.snapshot.advisor_tradeoffs.options).toMatchInlineSnapshot(`
      [
        {
          "backed_by": [
            {
              "label": "Plans · avalanche · total interest",
              "ref": "r1:plans[0].total_interest",
              "text": "$18.03",
            },
            {
              "label": "Plans · avalanche · months",
              "ref": "r1:plans[0].months",
              "text": "5 months",
            },
          ],
          "id": "o1",
          "label": "Cards first, avalanche order",
          "summary": "The cards are paid off in 5 months with $18.03 of interest.",
        },
        {
          "backed_by": [
            {
              "label": "Remaining",
              "ref": "r2:remaining",
              "text": "$4,000.00",
            },
          ],
          "id": "o2",
          "label": "IRA room first",
          "summary": "The IRA has $4,000.00 of room left this year.",
        },
      ]
    `);
    expect(request.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it('accepts a cost and a benefit for each option, resolved to the context’s figures', async () => {
    const { built, options: opts } = await options();
    const verdict = validateTradeoffsReply(TRADEOFFS_REPLY, {
      ...built.check,
      options: opts.map((option) => option.id),
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.tradeoffs[1]?.cost).toEqual([
        {
          ref: 'r1:plans[1].total_interest',
          label: 'Plans · snowball · total interest',
          text: '$19.92',
        },
      ]);
    }
  });

  it('refuses an option without a cost (tradeoffs.cost_missing), a cost citing a figure not in the context, a missing benefit, a gap in coverage', async () => {
    const { built, options: opts } = await options();
    const check = { ...built.check, options: opts.map((option) => option.id) };
    const [one, two] = TRADEOFFS_REPLY.tradeoffs as [
      (typeof TRADEOFFS_REPLY.tradeoffs)[number],
      (typeof TRADEOFFS_REPLY.tradeoffs)[number],
    ];
    const cases: [unknown, string][] = [
      [{ tradeoffs: [one, { ...two, cost: [] }] }, 'tradeoffs.cost_missing'],
      [{ tradeoffs: [one, { ...two, cost: ['r1:plans[0].penalty'] }] }, 'tradeoffs.ref_unresolved'],
      [{ tradeoffs: [one, { ...two, cost: ['$500.00'] }] }, 'tradeoffs.ref_unresolved'],
      [{ tradeoffs: [one, { ...two, benefit: [] }] }, 'tradeoffs.benefit_missing'],
      [{ tradeoffs: [one] }, 'tradeoffs.coverage'],
      [{ tradeoffs: [one, { ...two, option: 'o9' }] }, 'tradeoffs.coverage'],
      [
        { tradeoffs: [one, { ...two, note: 'A slower payoff costs $250.00 more.' }] },
        'tradeoffs.note.numeral',
      ],
      [{ tradeoffs: [one, { ...two, note: 'You should take the IRA.' }] }, 'tradeoffs.note.copy'],
      [{ tradeoffs: [one, { ...two, cost: 'r2:remaining' }] }, 'tradeoffs.schema'],
    ];
    for (const [reply, refusal] of cases) {
      expect(validateTradeoffsReply(reply, check), refusal).toMatchObject({ ok: false, refusal });
    }
  });
});

describe('advisor.plan — links to screens of this app, never an execution', () => {
  async function picked(): Promise<{
    built: BuiltAdvisorContext;
    option: AdvisorOption;
    tradeoff: AdvisorTradeoff;
    results: readonly AskResultView[];
  }> {
    const { built, results } = await contextOf(DRAFTS);
    const options = validateOptionsReply(OPTIONS_REPLY, built.check);
    if (!options.ok) throw new Error('options');
    const trades = validateTradeoffsReply(TRADEOFFS_REPLY, {
      ...built.check,
      options: ['o1', 'o2'],
    });
    if (!trades.ok) throw new Error('tradeoffs');
    return {
      built,
      option: options.options[0] as AdvisorOption,
      tradeoff: trades.tradeoffs[0] as AdvisorTradeoff,
      results,
    };
  }

  it('sends the picked option, its figures and the closed list of action screens — pinned', async () => {
    const { built, option, tradeoff } = await picked();
    const request = buildPlanRequest({
      context: built.context,
      option,
      tradeoff,
      grantedScopes: ['liabilities.terms'],
      ...LIMITS,
    });
    const subject = request.payload.snapshot.advisor_plan;
    expect({
      picked: subject.picked,
      action_screens: subject.action_screens,
      max_steps: subject.max_steps,
    }).toMatchInlineSnapshot(`
      {
        "action_screens": [
          {
            "label": "Dashboard",
            "path": "/",
          },
          {
            "label": "Reports",
            "path": "/reports",
          },
          {
            "label": "Cash flow",
            "path": "/cash-flow",
          },
          {
            "label": "Budget",
            "path": "/budget",
          },
          {
            "label": "Transactions",
            "path": "/transactions",
          },
          {
            "label": "Recurring",
            "path": "/recurring",
          },
          {
            "label": "Accounts",
            "path": "/accounts",
          },
          {
            "label": "Investments",
            "path": "/investments",
          },
          {
            "label": "Plan",
            "path": "/plan",
          },
          {
            "label": "Goals",
            "path": "/goals",
          },
          {
            "label": "Financial health",
            "path": "/health",
          },
          {
            "label": "Brief",
            "path": "/brief",
          },
          {
            "label": "Insights",
            "path": "/insights",
          },
          {
            "label": "Connections",
            "path": "/accounts/connections",
          },
          {
            "label": "Settings (rules)",
            "path": "/settings",
          },
          {
            "label": "Inbox",
            "path": "/inbox",
          },
        ],
        "max_steps": 6,
        "picked": {
          "benefit": [
            {
              "label": "Plans · avalanche · months",
              "ref": "r1:plans[0].months",
              "text": "5 months",
            },
          ],
          "cost": [
            {
              "label": "Plans · avalanche · total interest",
              "ref": "r1:plans[0].total_interest",
              "text": "$18.03",
            },
            {
              "label": "Remaining",
              "ref": "r2:remaining",
              "text": "$4,000.00",
            },
          ],
          "id": "o1",
          "label": "Cards first, avalanche order",
          "note": "Clears the cards in 5 months, leaving $4,000.00 of IRA room unused this year.",
          "summary": "The cards are paid off in 5 months with $18.03 of interest.",
        },
      }
    `);
  });

  it('accepts steps that each link to a listed screen, with the app’s label', async () => {
    const { built } = await picked();
    const verdict = validatePlanReply(
      {
        steps: [
          {
            text: 'The Accounts screen shows each card’s balance and its rate.',
            action_href: '/accounts',
          },
          {
            text: 'Rules in Settings can tag the extra payment each month.',
            action_href: '/settings',
          },
        ],
      },
      built.check,
    );
    expect(verdict).toMatchObject({ ok: true });
    if (verdict.ok)
      expect(verdict.steps.map((step) => step.action_label)).toEqual([
        'Accounts',
        'Settings (rules)',
      ]);
  });

  it('refuses by class: an href outside the list, an external address, an execution, a figure outside the context, too many steps', async () => {
    const { built } = await picked();
    const step = { text: 'The Accounts screen shows each card.', action_href: '/accounts' };
    const cases: [unknown, string][] = [
      [{ steps: [{ ...step, action_href: '/transfer' }] }, 'plan.href_unlisted'],
      [
        { steps: [{ ...step, action_href: '/accounts/move-money?amount=400' }] },
        'plan.href_unlisted',
      ],
      [{ steps: [{ ...step, action_href: 'https://bank.example/pay' }] }, 'plan.external_url'],
      [{ steps: [{ ...step, action_href: '//bank.example/pay' }] }, 'plan.external_url'],
      [
        { steps: [{ ...step, text: 'The app will move the money to the loan now.' }] },
        'plan.execution',
      ],
      [{ steps: [{ ...step, text: 'Pay $250.00 extra on the card.' }] }, 'plan.text.numeral'],
      [
        { steps: [{ ...step, text: 'The lender’s page at www.bank.example takes payments.' }] },
        'plan.text.link',
      ],
      [{ steps: Array.from({ length: 7 }, () => step) }, 'plan.count'],
      [{ steps: [] }, 'plan.count'],
      [{ steps: [{ text: 'x' }] }, 'plan.schema'],
    ];
    for (const [reply, refusal] of cases) {
      expect(validatePlanReply(reply, built.check), refusal).toMatchObject({ ok: false, refusal });
    }
  });
});

describe('advisor.judge — the rubric, never the holder’s data', () => {
  const rubric = advisorRubricFor(['debt-order']);
  const built = buildJudgeRequest({
    narration: [
      { part: 'restatement', text: RESTATEMENT },
      {
        part: 'option',
        text: 'Cards first. The cards are paid off in 5 months with $18.03 of interest.',
      },
      {
        part: 'tradeoff',
        text: 'Clears the cards in five months, leaving $4,000.00 of IRA room unused; MERCHANT_a1b2c3d4e5f6.',
      },
    ],
    rubric,
    ...LIMITS,
  });

  it('masks every figure, number word and pseudonym before it is sent; no data category crosses — pinned', () => {
    expect(built.payload.granted_scopes).toEqual([]);
    expect(JSON.stringify(built.payload)).not.toMatch(/\d|\$|MERCHANT_/u);
    expect(built.payload).toMatchInlineSnapshot(`
      {
        "granted_scopes": [],
        "snapshot": {
          "advisor_judge": {
            "narration": [
              {
                "part": "restatement",
                "text": "Whether to pay down the cards faster or put the money toward the IRA.",
              },
              {
                "part": "option",
                "text": "Cards first. The cards are paid off in [figure] months with [figure] of interest.",
              },
              {
                "part": "tradeoff",
                "text": "Clears the cards in [figure] months, leaving [figure] of IRA room unused; [ref].",
              },
            ],
            "rubric": {
              "criteria": [
                {
                  "id": "cost_surfaced",
                  "question": "Does every option the wording names say what it costs, next to what it gains?",
                },
                {
                  "id": "non_applicability",
                  "question": "Does the wording mention when the approach does not apply — for example a promotional rate ending, no cushion at all, low-rate debt weighed against investing, or loans with special terms?",
                },
                {
                  "id": "scope_kept",
                  "question": "Does the wording stay inside scope: no security, fund or coin named, no market timing, no tax filing, insurance or estate advice, and nothing saying the app will move money?",
                },
              ],
              "page": "debt-order",
            },
          },
        },
      }
    `);
    expect(maskNarration('Paid off in 19 months, $1,140 saved, 2.5% and twelve more')).toBe(
      'Paid off in [figure] months, [figure] saved, [figure] and [figure] more',
    );
  });

  it('scores met over criteria, to three places, by integer arithmetic', () => {
    const verdict = validateJudgeReply(
      {
        scores: [
          { criterion: 'cost_surfaced', met: true, reason: 'Each option names what it costs.' },
          {
            criterion: 'non_applicability',
            met: false,
            reason: 'It never says when the order does not apply.',
          },
          { criterion: 'scope_kept', met: true, reason: 'No security or timing.' },
        ],
      },
      rubric,
    );
    expect(verdict).toMatchObject({ ok: true, score: { score: '0.667', page: 'debt-order' } });
    expect(scoreText(3, 3)).toBe('1.000');
    expect(scoreText(0, 3)).toBe('0.000');
  });

  it('refuses a reply carrying holder data, or one missing a criterion', () => {
    const base = [
      { criterion: 'cost_surfaced', met: true, reason: 'Each option names what it costs.' },
      { criterion: 'non_applicability', met: true, reason: 'Yes.' },
      { criterion: 'scope_kept', met: true, reason: 'Yes.' },
    ];
    expect(
      validateJudgeReply(
        { scores: [{ ...base[0], reason: 'The holder pays $18.03 a month.' }, base[1], base[2]] },
        rubric,
      ),
    ).toMatchObject({ ok: false, refusal: 'judge.holder_data' });
    expect(
      validateJudgeReply(
        {
          scores: [{ ...base[0], reason: 'They shop at MERCHANT_a1b2c3d4e5f6.' }, base[1], base[2]],
        },
        rubric,
      ),
    ).toMatchObject({ ok: false, refusal: 'judge.holder_data' });
    expect(validateJudgeReply({ scores: [base[0], base[1]] }, rubric)).toMatchObject({
      ok: false,
      refusal: 'judge.coverage',
    });
    expect(
      validateJudgeReply({ scores: [{ ...base[0], met: 'yes' }, base[1], base[2]] }, rubric),
    ).toMatchObject({ ok: false, refusal: 'judge.schema' });
  });
});

// ---------------------------------------------------------------------------

describe('advisor.follow_up — no model: the watcher and the Brief item', () => {
  it('watches the figure the picked option was about: a debt plan’s balances, a goal’s pace, contribution room', async () => {
    const debt = await view('debt.payoff_plan');
    const room = await view('limits.contribution_room');
    const goal = await view('goal.required_savings');
    const results = [debt, room, goal];
    const fig = (ref: string, label = 'x', text = 'y') => ({ ref, label, text });
    const option = (refs: string[]): AdvisorOption => ({
      id: 'o1',
      label: 'L',
      summary: 'S',
      backed_by: refs.map((ref) => fig(ref)),
    });
    const trade = (cost: string[]): AdvisorTradeoff => ({
      option: 'o1',
      benefit: [],
      cost: cost.map((ref) => fig(ref)),
      note: 'n',
    });
    const debtWatch = advisorWatcherFor({
      option: option(['r1:plans[0].months']),
      tradeoff: trade(['r1:plans[0].total_interest']),
      results,
      watcherKey: 'advisor.follow_up.w1', // gitleaks:allow — a watcher key, not a secret
    });
    expect(debtWatch).toMatchObject({
      kind: 'debt_balance',
      function: 'debt.payoff_plan',
      liability_refs: ['LIABILITY_a', 'LIABILITY_b'],
      baseline: { text: '$400.00', value: '40000' },
      brief: { key: 'advisor.follow_up.w1', outcome: 'pending' }, // gitleaks:allow — a watcher key, not a secret
    });
    const roomWatch = advisorWatcherFor({
      option: option(['r2:remaining']),
      tradeoff: trade(['r2:remaining']),
      results,
      watcherKey: 'k',
    });
    expect(roomWatch).toMatchObject({
      kind: 'contribution_room',
      baseline: { text: '$4,000.00', value: '400000' },
      brief: { outcome: 'not_in_snapshot' },
    });
    const goalWatch = advisorWatcherFor({
      option: option(['r3:monthly']),
      tradeoff: trade(['r2:remaining', 'r3:monthly']),
      results,
      watcherKey: 'k',
    });
    expect(goalWatch).toMatchObject({
      kind: 'goal_pace',
      args: { goal_ref: goalRef(TOKEN_KEY, GOAL_ID) },
      baseline: { text: '$1,312.00', value: '131200' },
    });
  });

  it('writes a fixed-template item that passes the seven-step validator against the builtin snapshot — no model, no narration', async () => {
    const snapshot = fixtureSnapshot();
    const manifest = ADVISOR_FOLLOW_UP_MANIFEST;
    for (const watcher of [
      { kind: 'goal_pace' as const, args: { goal_ref: goalRef(TOKEN_KEY, GOAL_ID) } },
      { kind: 'debt_balance' as const, args: {}, liability_refs: ['LIABILITY_a', 'LIABILITY_b'] },
    ]) {
      const insight = followUpInsightOf({
        watcher: {
          ...watcher,
          function: 'x',
          figure_key: 'k',
          figure_label: 'l',
          baseline: { text: '', value: null, as_of: null },
          latest: null,
          direction: null,
          status: 'watching',
          checked_at: null,
          brief: { key: `advisor.follow_up.${watcher.kind}`, outcome: 'pending', detail: null },
        },
        snapshot,
        period: '2026-10',
      });
      expect(insight, watcher.kind).not.toBeNull();
      const request = {
        contract_version: ADVISOR_CONTRACT_MAJOR,
        request_id: '01900000-0000-7000-8000-0000000000ff',
        advisor_id: manifest.advisor_id,
        advisor_version: manifest.version,
        kind: 'builtin' as const,
        generated_at: NOW.toISOString(),
        base_currency: 'USD',
        time_zone: 'UTC',
        today: '2026-10-28',
        granted_scopes: ['goals.list', 'liabilities.terms'] as never,
        input_digest: `sha256:${'e'.repeat(64)}`,
        limits: { max_insights: 1, max_response_bytes: 131_072, deadline: NOW.toISOString() },
        snapshot,
      };
      const outcome = validateResponse({
        request,
        manifest,
        limits: resolveLimits(manifest),
        body: {
          contract_version: ADVISOR_CONTRACT_MAJOR,
          request_id: request.request_id,
          advisor_id: manifest.advisor_id,
          advisor_version: manifest.version,
          produced_at: NOW.toISOString(),
          diagnostics: { runtime_ms: 0, model: null, warnings: [] },
          insights: [insight],
        },
      });
      expect(
        outcome.ok && outcome.accepted.length,
        `${watcher.kind}: ${JSON.stringify(outcome.ok ? outcome.rejected : outcome.rejection)}`,
      ).toBe(1);
    }
    const goal = followUpInsightOf({
      watcher: {
        kind: 'goal_pace',
        function: 'goal.required_savings',
        args: { goal_ref: goalRef(TOKEN_KEY, GOAL_ID) },
        figure_key: 'monthly',
        figure_label: 'Needed per month',
        baseline: { text: '', value: null, as_of: null },
        latest: null,
        direction: null,
        status: 'watching',
        checked_at: null,
        brief: { key: 'advisor.follow_up.w', outcome: 'pending', detail: null },
      },
      snapshot,
      period: '2026-10',
    });
    // The wording is the template's, word for word: no model wrote it.
    expect(goal?.summary_md).toBe(
      'You picked a plan for this in an advisor session. The goal “House deposit” needs about $1,250.00 a month to reach $60,000.00; the contributions planned for it come to $1,000.00 a month.',
    );
    expect(goal?.confidence_basis).toBe('deterministic');
  });
});

describe('the sixteenth control check, advisor_cost_pairing', () => {
  it('is in the catalogue (api side) and passes against the shipped validator', async () => {
    expect(CONTROL_CHECKS).toHaveLength(16);
    expect(CONTROL_CHECKS.find((check) => check.id === 'advisor_cost_pairing')).toMatchObject({
      side: 'api',
    });
    const outcome = await checkAdvisorCostPairing();
    expect(outcome.status, outcome.reason ?? '').toBe('pass');
    expect(outcome.facts.join(' ')).toContain('tradeoffs.cost_missing');
  });
});
