// SPDX-License-Identifier: MIT
/**
 * `insight.explain`'s own payload preview and approval (the WP 5.1 / 10.1
 * pattern, 03 §8.3: show the exact payload before the first send of a new
 * query type), shown in Advisor management beside the narrator's.
 *
 * The shape is `queryShape` over advisor id, version, kind, the scope bound
 * and the explain template hash — the narrator's recipe with this advisor's
 * inputs — so a new template, a new format, a new sampling option, a new
 * provider or model (a hosted template hash names both) or a new version is
 * a new shape that needs a new approval, and the narrator's approval can never
 * be spent here (a different advisor id is a different shape). One approval
 * covers every insight and pillar: the shape does not depend on which entity
 * is explained, only on what kind of payload is sent and how.
 *
 * The preview builds the request through `buildExplainRequest`, the
 * constructor the run uses, over the holder's own top explainable insight
 * when there is one (else a fixed illustrative subject, labelled as such),
 * and renders the prompt through the bound model's pure `render`. Nothing is
 * called.
 */
import { newId } from '@core/kernel';
import { and, eq, sql } from 'drizzle-orm';
import { advisorPayloadApprovals } from '../../../schema/index.ts';
import type { InsightsContext, InsightsDatabase, InsightsExecutor } from '../../db.ts';
import { hasLiveApproval, PreviewError } from '../../preview.ts';
import { findAdvisor, lockAdvisor, registerAdvisor } from '../../store.ts';
import {
  INSIGHT_EXPLAIN_ADVISOR_ID,
  INSIGHT_EXPLAIN_MANIFEST,
  INSIGHT_EXPLAIN_SCOPES,
  INSIGHT_EXPLAIN_VERSION,
} from './manifest.ts';
import { buildExplainRequest, type ExplainTarget, type ExplainWireRequest } from './request.ts';
import { insightExplainShape, type ExplainRenderer } from './run.ts';

/**
 * The `advisors` row, so approvals and runs have their parent. Registered
 * **on**: nothing runs without the holder's tap (or the Brief's prefetch)
 * and an approved shape, and level 3's switch in Advisor management still
 * turns it off. `registerAdvisor` never touches `enabled` on an existing row.
 */
export async function ensureInsightExplainAdvisor(
  database: InsightsExecutor,
  context: InsightsContext,
): Promise<void> {
  // Insert-only on the run path: a run never rewrites the advisors row (the
  // boot pass, `registerBuiltinAdvisors`, keeps the manifest current).
  if ((await findAdvisor(database, context.userId, INSIGHT_EXPLAIN_ADVISOR_ID)) !== null) return;
  await registerAdvisor(database, context, { manifest: INSIGHT_EXPLAIN_MANIFEST, enabled: true });
}

/** A fixed subject for a preview with nothing to explain yet. Synthetic; no holder data. */
export const EXPLAIN_PREVIEW_EXAMPLE: ExplainTarget = Object.freeze<ExplainTarget>({
  entityKind: 'insight' as const,
  entityId: 'example',
  scopes: ['cash.summary', 'cashflow.monthly'],
  subject: {
    entity_kind: 'insight' as const,
    rule: {
      name: 'Example rule',
      text: 'An illustrative finding, shown until you have one of your own to explain.',
    },
    title: 'Example: cash held beyond your recent spending',
    summary: 'An example summary of a finding, written by a built-in rule.',
    figures: { per_year: null, one_time: null, basis: 'An example basis.' },
    evidence: [
      {
        label: 'Example figure',
        value: '$1,000.00',
        source_ref: 'snapshot:cash_summary.total.minor',
      },
    ],
  },
});

export interface InsightExplainPreview {
  readonly advisorId: typeof INSIGHT_EXPLAIN_ADVISOR_ID;
  readonly advisorVersion: string;
  readonly queryShape: string;
  readonly scopes: readonly string[];
  readonly promptTemplateHash: string;
  readonly provider: string;
  readonly model: string;
  /** The request a run would send now for the subject shown (its payload, plus the per-run fields). */
  readonly request: ExplainWireRequest & {
    readonly snapshot: ReturnType<typeof buildExplainRequest>['payload']['snapshot'];
    readonly granted_scopes: readonly string[];
  };
  /** The exact prompt bytes. */
  readonly prompt: { readonly text: string; readonly hash: string };
  /** `true` when the subject is the illustrative example, not one of the holder's own. */
  readonly illustrative: boolean;
  readonly approved: boolean;
}

export async function previewInsightExplain(
  executor: InsightsExecutor,
  context: InsightsContext,
  input: { readonly renderer: ExplainRenderer; readonly target: ExplainTarget | null },
): Promise<InsightExplainPreview> {
  const shape = insightExplainShape(input.renderer.templateHash);
  const target = input.target ?? EXPLAIN_PREVIEW_EXAMPLE;
  const built = buildExplainRequest({
    target,
    now: context.clock.now(),
    timeoutMs: INSIGHT_EXPLAIN_MANIFEST.limits.timeout_ms,
    maxResponseBytes: INSIGHT_EXPLAIN_MANIFEST.limits.max_response_bytes,
  });
  return {
    advisorId: INSIGHT_EXPLAIN_ADVISOR_ID,
    advisorVersion: INSIGHT_EXPLAIN_VERSION,
    queryShape: shape,
    scopes: [...INSIGHT_EXPLAIN_SCOPES],
    promptTemplateHash: input.renderer.templateHash,
    provider: input.renderer.provider,
    model: input.renderer.label,
    request: {
      ...built.request,
      snapshot: built.payload.snapshot,
      granted_scopes: built.payload.granted_scopes,
    },
    prompt: input.renderer.render(built.request),
    illustrative: input.target === null,
    approved: await hasLiveApproval(executor, context.userId, INSIGHT_EXPLAIN_ADVISOR_ID, shape),
  };
}

/** Approve the shape the preview showed. Refuses `shape_changed` if it moved since. */
export async function approveInsightExplain(
  database: InsightsDatabase,
  context: InsightsContext,
  input: { readonly renderer: ExplainRenderer; readonly queryShape: string },
): Promise<{ readonly approvalId: string; readonly queryShape: string }> {
  await ensureInsightExplainAdvisor(database, context);
  return database.transaction(async (tx) => {
    await lockAdvisor(tx, context.userId, INSIGHT_EXPLAIN_ADVISOR_ID);
    const shape = insightExplainShape(input.renderer.templateHash);
    if (shape !== input.queryShape) {
      throw new PreviewError(
        'shape_changed',
        `the payload shape of ${INSIGHT_EXPLAIN_ADVISOR_ID} changed since it was previewed`,
      );
    }
    const now = context.clock.now();
    const id = newId();
    const rows = await tx
      .insert(advisorPayloadApprovals)
      .values({
        id,
        userId: context.userId,
        advisorId: INSIGHT_EXPLAIN_ADVISOR_ID,
        queryShape: shape,
        advisorVersion: INSIGHT_EXPLAIN_VERSION,
        kind: 'local_model',
        scopes: [...INSIGHT_EXPLAIN_SCOPES],
        promptTemplateHash: input.renderer.templateHash,
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

/** Live approvals of `insight.explain` for this holder (the tests and the evidence). */
export async function liveInsightExplainApprovals(
  executor: InsightsExecutor,
  userId: string,
): Promise<number> {
  const rows = await executor
    .select({ id: advisorPayloadApprovals.id })
    .from(advisorPayloadApprovals)
    .where(
      and(
        eq(advisorPayloadApprovals.userId, userId),
        eq(advisorPayloadApprovals.advisorId, INSIGHT_EXPLAIN_ADVISOR_ID),
        sql`${advisorPayloadApprovals.revokedAt} IS NULL`,
      ),
    );
  return rows.length;
}
