// SPDX-License-Identifier: MIT
/**
 * `ask.compile`'s and `ask.narrate`'s own payload previews and approvals (the
 * WP 5.1 / 10.1 pattern, 03 §8.3: show the exact payload before the first
 * send of a new query type), shown in Advisor management beside the
 * narrator's, `insight.explain`'s and `brief.narrate`'s (WP 11.5c).
 *
 * Each shape is `queryShape` over the step's advisor id, version, kind, the
 * scope bound and a template hash that covers the adapter's template (prompt,
 * reply format, options, provider, model) **and the step's consent text**
 * (`ASK_CONSENT_TEXTS`, versioned, sha256): a new template, provider, model or
 * consent wording is a new shape that needs a new approval, and one step's
 * approval can never be spent on the other.
 *
 * The compile preview is built over **the holder's own listing** — exactly
 * the functions their grant covers — and an example question; the narrate
 * preview over a fixed, synthetic set of results (labelled illustrative): a
 * real one exists only after a question was compiled and run. Both through the
 * constructors the run uses, rendered through the bound model's pure
 * `render`. Nothing is called.
 */
import { newId, todayIn } from '@core/kernel';
import { advisorPayloadApprovals } from '../../../schema/index.ts';
import type { CatalogueListing } from '../../catalogue/catalogue.ts';
import type { InsightsContext, InsightsDatabase, InsightsExecutor } from '../../db.ts';
import { hasLiveApproval, PreviewError } from '../../preview.ts';
import { findAdvisor, lockAdvisor, registerAdvisor } from '../../store.ts';
import {
  askCompileSubjectOf,
  buildAskCompileRequest,
  type AskCompileWireRequest,
} from './compile.ts';
import {
  ASK_COMPILE_ADVISOR_ID,
  ASK_COMPILE_MANIFEST,
  ASK_CONSENT_TEXTS,
  ASK_CONSENT_VERSION,
  ASK_NARRATE_ADVISOR_ID,
  ASK_NARRATE_MANIFEST,
  ASK_SCOPES,
  askConsentSha256,
  askShapeTemplateHash,
  type AskStep,
} from './manifest.ts';
import { buildAskNarrateRequest, type AskNarrateWireRequest } from './narrate.ts';
import type { AskResultView } from './results.ts';
import { askShape, type AskRenderer } from './run.ts';

const MANIFESTS = { compile: ASK_COMPILE_MANIFEST, narrate: ASK_NARRATE_MANIFEST } as const;
const IDS = { compile: ASK_COMPILE_ADVISOR_ID, narrate: ASK_NARRATE_ADVISOR_ID } as const;

/** Both `advisors` rows, registered on (insert-only on the run path), as `brief.narrate`'s. */
export async function ensureAskAdvisors(
  database: InsightsExecutor,
  context: InsightsContext,
): Promise<void> {
  for (const step of ['compile', 'narrate'] as const) {
    if ((await findAdvisor(database, context.userId, IDS[step])) !== null) continue;
    await registerAdvisor(database, context, { manifest: MANIFESTS[step], enabled: true });
  }
}

/** The question the compile preview shows. Synthetic: no holder data. */
export const ASK_PREVIEW_QUESTION = 'How many months of spending does my cash cover?';

/** The results the narrate preview shows. Synthetic; describes no one. */
export const ASK_NARRATE_PREVIEW_RESULTS: readonly AskResultView[] = Object.freeze([
  {
    function: 'cash.emergency_fund',
    label: 'emergency-fund cover (target 3 months)',
    args: { target_months: 3 },
    status: 'ok',
    as_of: '2026-01-15',
    scopes: ['cash.summary', 'cashflow.monthly'],
    input_digest: `sha256:${'0'.repeat(64)}`,
    result_digest: `sha256:${'1'.repeat(64)}`,
    not_available: null,
    refused: null,
    figures: [
      {
        key: 'cash_held',
        label: 'Cash held',
        text: '$12,000.00',
        kind: 'money',
        raw: null,
        source_refs: ['snapshot:cash_summary.total'],
      },
      {
        key: 'months_covered',
        label: 'Months covered',
        text: '4 months',
        kind: 'decimal',
        raw: '4',
        source_refs: ['snapshot:cash_summary.total', 'snapshot:cashflow_monthly.months[0].expense'],
      },
    ],
    figures_total: 2,
    facts: [],
    parameter_keys: [],
    screen: '/health',
  },
] satisfies AskResultView[]);

export interface AskPreview {
  readonly advisorId: string;
  readonly advisorVersion: string;
  readonly step: AskStep;
  readonly queryShape: string;
  readonly scopes: readonly string[];
  /** The approvable template hash: the adapter's and the consent text's together. */
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

function consentOf(step: AskStep) {
  return {
    version: ASK_CONSENT_VERSION,
    sha256: askConsentSha256(step),
    text: ASK_CONSENT_TEXTS[step],
  };
}

export async function previewAskCompile(
  executor: InsightsExecutor,
  context: InsightsContext,
  input: {
    readonly renderer: AskRenderer<AskCompileWireRequest>;
    readonly listing: Pick<CatalogueListing, 'catalogue_version' | '$defs' | 'functions'>;
    readonly timeZone: string;
  },
): Promise<AskPreview> {
  const shape = askShape('compile', input.renderer.templateHash);
  const built = buildAskCompileRequest({
    subject: askCompileSubjectOf({
      question: ASK_PREVIEW_QUESTION,
      today: todayIn(context.clock, input.timeZone),
      listing: input.listing,
    }),
    now: context.clock.now(),
    timeoutMs: ASK_COMPILE_MANIFEST.limits.timeout_ms,
    maxResponseBytes: ASK_COMPILE_MANIFEST.limits.max_response_bytes,
  });
  return {
    advisorId: ASK_COMPILE_ADVISOR_ID,
    advisorVersion: ASK_COMPILE_MANIFEST.version,
    step: 'compile',
    queryShape: shape,
    scopes: [...ASK_SCOPES],
    promptTemplateHash: askShapeTemplateHash('compile', input.renderer.templateHash),
    provider: input.renderer.provider,
    model: input.renderer.label,
    request: {
      ...built.request,
      subject: built.request.subject as unknown as Record<string, unknown>,
      snapshot: built.payload.snapshot as unknown as Record<string, unknown>,
      granted_scopes: built.payload.granted_scopes,
      consent: consentOf('compile'),
    },
    prompt: input.renderer.render(built.request),
    // The question is the example; the listing is the holder's own.
    illustrative: true,
    approved: await hasLiveApproval(executor, context.userId, ASK_COMPILE_ADVISOR_ID, shape),
  };
}

export async function previewAskNarrate(
  executor: InsightsExecutor,
  context: InsightsContext,
  input: { readonly renderer: AskRenderer<AskNarrateWireRequest> },
): Promise<AskPreview> {
  const shape = askShape('narrate', input.renderer.templateHash);
  const built = buildAskNarrateRequest({
    question: ASK_PREVIEW_QUESTION,
    date: '2026-01-15',
    results: ASK_NARRATE_PREVIEW_RESULTS,
    knowledge: { pages: [], params: [], withheld: [] },
    knowledgeCatalogue: null,
    now: context.clock.now(),
    timeoutMs: ASK_NARRATE_MANIFEST.limits.timeout_ms,
    maxResponseBytes: ASK_NARRATE_MANIFEST.limits.max_response_bytes,
  });
  return {
    advisorId: ASK_NARRATE_ADVISOR_ID,
    advisorVersion: ASK_NARRATE_MANIFEST.version,
    step: 'narrate',
    queryShape: shape,
    scopes: [...ASK_SCOPES],
    promptTemplateHash: askShapeTemplateHash('narrate', input.renderer.templateHash),
    provider: input.renderer.provider,
    model: input.renderer.label,
    request: {
      ...built.request,
      subject: built.request.subject as unknown as Record<string, unknown>,
      snapshot: built.payload.snapshot as unknown as Record<string, unknown>,
      granted_scopes: built.payload.granted_scopes,
      consent: consentOf('narrate'),
    },
    prompt: input.renderer.render(built.request),
    illustrative: true,
    approved: await hasLiveApproval(executor, context.userId, ASK_NARRATE_ADVISOR_ID, shape),
  };
}

/** Approve the shape a preview showed. Refuses `shape_changed` if it moved since. */
export async function approveAsk(
  database: InsightsDatabase,
  context: InsightsContext,
  input: {
    readonly step: AskStep;
    readonly renderer: Pick<AskRenderer<unknown>, 'provider' | 'label' | 'templateHash'>;
    readonly queryShape: string;
  },
): Promise<{ readonly approvalId: string; readonly queryShape: string }> {
  await ensureAskAdvisors(database, context);
  const advisorId = IDS[input.step];
  return database.transaction(async (tx) => {
    await lockAdvisor(tx, context.userId, advisorId);
    const shape = askShape(input.step, input.renderer.templateHash);
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
        advisorVersion: MANIFESTS[input.step].version,
        kind: 'local_model',
        scopes: [...ASK_SCOPES],
        promptTemplateHash: askShapeTemplateHash(input.step, input.renderer.templateHash),
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
