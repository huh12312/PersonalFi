// SPDX-License-Identifier: MIT
/**
 * The advisor's six payload previews and approvals (WP 11.5d; the WP 5.1 /
 * 10.1 pattern, 03 §8.3: show the exact payload before the first send of a
 * new query type), shown in Advisor management beside Ask PersonalFi's.
 *
 * Each shape is `queryShape` over the step's advisor id, version, kind, the
 * scope bound and a template hash covering the adapter's template (prompt,
 * reply format, options, provider, model) **and the advisor's consent text**
 * (`advisor-consent/1`, sha256): a new template, provider, model or consent
 * wording is a new shape that needs a new approval, and one step's approval
 * can never be spent on another.
 *
 * The clarify and gather previews are built over **the holder's own
 * listing** and an example question; the others over a fixed, synthetic
 * context (a car loan and an extra $400 a month — 12 §3's first worked
 * example), labelled illustrative. Built through the constructors the run
 * uses, rendered through the bound model's pure `render`. Nothing is called.
 */
import { newId, todayIn } from '@core/kernel';
import { advisorPayloadApprovals } from '../../../schema/index.ts';
import type { AdvisorStep } from '../../../schema/index.ts';
import type { CatalogueListing } from '../../catalogue/catalogue.ts';
import type { InsightsContext, InsightsDatabase, InsightsExecutor } from '../../db.ts';
import { hasLiveApproval, PreviewError } from '../../preview.ts';
import { findAdvisor, lockAdvisor, registerAdvisor } from '../../store.ts';
import { askCompileSubjectOf, buildAskCompileRequest } from '../ask/compile.ts';
import type { AskResultView } from '../ask/results.ts';
import { buildClarifyRequest } from './clarify.ts';
import { buildAdvisorContext } from './context.ts';
import { advisorGatherQuestion } from './gather.ts';
import { buildJudgeRequest } from './judge.ts';
import {
  ADVISOR_CONSENT_TEXT,
  ADVISOR_CONSENT_VERSION,
  ADVISOR_SCOPES,
  ADVISOR_STEP_IDS,
  ADVISOR_STEP_MANIFESTS,
  ADVISOR_STEP_VERSION,
  advisorConsentSha256,
  advisorShapeTemplateHash,
} from './manifest.ts';
import { buildOptionsRequest } from './options.ts';
import { buildPlanRequest } from './plan.ts';
import { advisorStepShape } from './run.ts';
import { advisorRubricFor } from './topics.ts';
import { buildTradeoffsRequest } from './tradeoffs.ts';

/** Every advisor row (on), insert-only on the run path, as Ask PersonalFi's. */
export async function ensureAdvisorStepAdvisors(
  database: InsightsExecutor,
  context: InsightsContext,
): Promise<void> {
  for (const step of Object.keys(ADVISOR_STEP_IDS) as AdvisorStep[]) {
    if ((await findAdvisor(database, context.userId, ADVISOR_STEP_IDS[step])) !== null) continue;
    await registerAdvisor(database, context, {
      manifest: ADVISOR_STEP_MANIFESTS[step],
      enabled: true,
    });
  }
}

/** The question the previews show. 12 §3's first worked example; no holder data. */
export const ADVISOR_PREVIEW_QUESTION =
  'Should I pay off my car loan or invest the extra $400 a month?';

/** The synthetic result the context-carrying previews show. Describes no one. */
export const ADVISOR_PREVIEW_RESULTS: readonly AskResultView[] = Object.freeze([
  {
    function: 'debt.payoff_plan',
    label: 'debt payoff plan (avalanche, $400.00 extra a month)',
    args: { order: 'avalanche', extra_monthly: { minor: '40000', currency: 'USD' } },
    status: 'ok',
    as_of: '2026-01-15',
    scopes: ['liabilities.terms'],
    input_digest: `sha256:${'0'.repeat(64)}`,
    result_digest: `sha256:${'1'.repeat(64)}`,
    not_available: null,
    refused: null,
    figures: [
      {
        key: 'plans[0].months',
        label: 'Plans · avalanche · months',
        text: '19 months',
        kind: 'decimal',
        raw: '19',
        source_refs: ['snapshot:liabilities_terms.liabilities[0].current_balance'],
      },
      {
        key: 'plans[0].total_interest',
        label: 'Plans · avalanche · total interest',
        text: '$1,140.00',
        kind: 'money',
        raw: null,
        source_refs: ['snapshot:liabilities_terms.liabilities[0].apr'],
      },
    ],
    figures_total: 2,
    facts: [],
    parameter_keys: [],
    screen: '/accounts',
  },
] satisfies AskResultView[]);

export interface AdvisorPreviewRenderer {
  readonly provider: string;
  readonly label: string;
  readonly templateHash: string;
  render(request: never): { readonly text: string; readonly hash: string };
}

export interface AdvisorPreview {
  readonly advisorId: string;
  readonly advisorVersion: string;
  readonly step: AdvisorStep;
  readonly queryShape: string;
  readonly scopes: readonly string[];
  readonly promptTemplateHash: string;
  readonly provider: string;
  readonly model: string;
  readonly request: {
    readonly request_id: string;
    readonly subject: Record<string, unknown>;
    readonly deadline: string;
    readonly max_response_bytes: number;
    readonly snapshot: Record<string, unknown>;
    readonly granted_scopes: readonly string[];
    readonly consent: { readonly version: string; readonly sha256: string; readonly text: string };
  };
  readonly prompt: { readonly text: string; readonly hash: string };
  readonly illustrative: boolean;
  readonly approved: boolean;
}

interface BuiltPreview {
  readonly request: {
    readonly request_id: string;
    readonly subject: unknown;
    readonly deadline: string;
    readonly max_response_bytes: number;
  };
  readonly payload: { readonly snapshot: unknown; readonly granted_scopes: readonly string[] };
}

/** The request a preview of one step shows: the constructors the run uses, over example data. */
export function advisorPreviewRequest(
  step: AdvisorStep,
  input: {
    readonly listing: Pick<CatalogueListing, 'catalogue_version' | '$defs' | 'functions'>;
    readonly today: string;
    readonly now: Date;
  },
): BuiltPreview {
  const limits = ADVISOR_STEP_MANIFESTS[step].limits;
  const common = {
    now: input.now,
    timeoutMs: limits.timeout_ms,
    maxResponseBytes: limits.max_response_bytes,
  };
  const restatement =
    'Whether to put an extra $400 a month toward the car loan or into investing instead.';
  const answers = [
    { question: 'Is there an employer match on your workplace plan?', answer: 'No match.' },
  ];
  const context = buildAdvisorContext({
    restatement,
    answers,
    date: '2026-01-15',
    results: ADVISOR_PREVIEW_RESULTS,
    knowledge: { pages: [], params: [], withheld: [] },
    knowledgeCatalogue: null,
  }).context;
  const option = {
    id: 'o1',
    label: 'Extra to the loan',
    summary: 'The loan is paid off in 19 months.',
    backed_by: [
      context.results[0]?.figures[0] ?? {
        ref: 'r1:plans[0].months',
        label: 'Months',
        text: '19 months',
      },
    ],
  };
  switch (step) {
    case 'clarify':
      return buildClarifyRequest({
        question: ADVISOR_PREVIEW_QUESTION,
        listing: input.listing.functions,
        defaults: {
          retirementAge: 67,
          goals: [{ goal_ref: 'GOAL_000000000000', name: 'House deposit' }],
        },
        grantedScopes: [],
        ...common,
      });
    case 'gather':
      return buildAskCompileRequest({
        subject: askCompileSubjectOf({
          question: advisorGatherQuestion({ restatement, answers }),
          today: input.today,
          listing: input.listing,
        }),
        ...common,
      });
    case 'options':
      return buildOptionsRequest({ context, grantedScopes: ['liabilities.terms'], ...common });
    case 'tradeoffs':
      return buildTradeoffsRequest({
        context,
        options: [option],
        grantedScopes: ['liabilities.terms'],
        ...common,
      });
    case 'plan':
      return buildPlanRequest({
        context,
        option,
        tradeoff: {
          option: 'o1',
          benefit: option.backed_by,
          cost: [context.results[0]?.figures[1] ?? option.backed_by[0]].filter(
            (entry) => entry !== undefined,
          ),
          note: 'Paid off in 19 months, at $1,140.00 of interest.',
        },
        grantedScopes: ['liabilities.terms'],
        ...common,
      });
    case 'judge':
      return buildJudgeRequest({
        narration: [
          { part: 'restatement', text: restatement },
          { part: 'option', text: 'Extra to the loan. The loan is paid off in 19 months.' },
          { part: 'tradeoff', text: 'Paid off in 19 months, at $1,140.00 of interest.' },
        ],
        rubric: advisorRubricFor(['debt-order']),
        ...common,
      });
  }
}

export async function previewAdvisorStep(
  executor: InsightsExecutor,
  context: InsightsContext,
  input: {
    readonly step: AdvisorStep;
    readonly renderer: AdvisorPreviewRenderer;
    readonly listing: Pick<CatalogueListing, 'catalogue_version' | '$defs' | 'functions'>;
    readonly timeZone: string;
  },
): Promise<AdvisorPreview> {
  const { step } = input;
  const shape = advisorStepShape(step, input.renderer.templateHash);
  const built = advisorPreviewRequest(step, {
    listing: input.listing,
    today: todayIn(context.clock, input.timeZone),
    now: context.clock.now(),
  });
  return {
    advisorId: ADVISOR_STEP_IDS[step],
    advisorVersion: ADVISOR_STEP_VERSION,
    step,
    queryShape: shape,
    scopes: [...ADVISOR_SCOPES],
    promptTemplateHash: advisorShapeTemplateHash(step, input.renderer.templateHash),
    provider: input.renderer.provider,
    model: input.renderer.label,
    request: {
      request_id: built.request.request_id,
      subject: built.request.subject as Record<string, unknown>,
      deadline: built.request.deadline,
      max_response_bytes: built.request.max_response_bytes,
      snapshot: built.payload.snapshot as Record<string, unknown>,
      granted_scopes: built.payload.granted_scopes,
      consent: {
        version: ADVISOR_CONSENT_VERSION,
        sha256: advisorConsentSha256(),
        text: ADVISOR_CONSENT_TEXT,
      },
    },
    prompt: input.renderer.render(built.request as never),
    illustrative: true,
    approved: await hasLiveApproval(executor, context.userId, ADVISOR_STEP_IDS[step], shape),
  };
}

/** Approve the shape a preview showed. Refuses `shape_changed` if it moved since. */
export async function approveAdvisorStep(
  database: InsightsDatabase,
  context: InsightsContext,
  input: {
    readonly step: AdvisorStep;
    readonly renderer: Pick<AdvisorPreviewRenderer, 'provider' | 'label' | 'templateHash'>;
    readonly queryShape: string;
  },
): Promise<{ readonly approvalId: string; readonly queryShape: string }> {
  await ensureAdvisorStepAdvisors(database, context);
  const advisorId = ADVISOR_STEP_IDS[input.step];
  return database.transaction(async (tx) => {
    await lockAdvisor(tx, context.userId, advisorId);
    const shape = advisorStepShape(input.step, input.renderer.templateHash);
    if (shape !== input.queryShape) {
      throw new PreviewError(
        'shape_changed',
        `the payload shape of ${advisorId} changed since it was previewed`,
      );
    }
    const now = context.clock.now();
    const id = newId();
    const rows = await tx
      .insert(advisorPayloadApprovals)
      .values({
        id,
        userId: context.userId,
        advisorId,
        queryShape: shape,
        advisorVersion: ADVISOR_STEP_VERSION,
        kind: 'local_model',
        scopes: [...ADVISOR_SCOPES],
        promptTemplateHash: advisorShapeTemplateHash(input.step, input.renderer.templateHash),
        llmProvider: input.renderer.provider,
        llmModel: input.renderer.label,
        approvedAt: now,
        revokedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          advisorPayloadApprovals.userId,
          advisorPayloadApprovals.advisorId,
          advisorPayloadApprovals.queryShape,
        ],
        set: {
          approvedAt: now,
          revokedAt: null,
          updatedAt: now,
          llmProvider: input.renderer.provider,
          llmModel: input.renderer.label,
        },
      })
      .returning({ id: advisorPayloadApprovals.id });
    return { approvalId: rows[0]?.id ?? id, queryShape: shape };
  });
}
