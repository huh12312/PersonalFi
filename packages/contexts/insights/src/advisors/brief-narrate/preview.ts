// SPDX-License-Identifier: MIT
/**
 * `brief.narrate`'s own payload preview and approval (the WP 5.1 / 10.1
 * pattern, 03 §8.3: show the exact payload before the first send of a new
 * query type), shown in Advisor management beside the narrator's and
 * `insight.explain`'s — `insight.explain`'s `preview.ts` with this advisor's
 * inputs. The shape is `queryShape` over advisor id, version, kind, the scope
 * bound and the brief-narrate template hash, so the narrator's approval and
 * explain's can never be spent here, and a new template, format, provider or
 * model is a new shape that needs a new approval. One approval covers every
 * week's Brief: the shape does not depend on the week.
 *
 * The preview builds the request through `buildBriefNarrateRequest`, the
 * constructor the run uses, over the holder's latest published Brief when the
 * composition root can build one, else a fixed illustrative Brief (labelled),
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
  BRIEF_NARRATE_ADVISOR_ID,
  BRIEF_NARRATE_MANIFEST,
  BRIEF_NARRATE_SCOPES,
  BRIEF_NARRATE_VERSION,
} from './manifest.ts';
import {
  buildBriefNarrateRequest,
  type BriefNarrateTarget,
  type BriefNarrateWireRequest,
} from './request.ts';
import { briefNarrateShape, type BriefNarrateRenderer } from './run.ts';

/** The `advisors` row, registered on (insert-only on the run path), as `insight.explain`'s. */
export async function ensureBriefNarrateAdvisor(
  database: InsightsExecutor,
  context: InsightsContext,
): Promise<void> {
  if ((await findAdvisor(database, context.userId, BRIEF_NARRATE_ADVISOR_ID)) !== null) return;
  await registerAdvisor(database, context, { manifest: BRIEF_NARRATE_MANIFEST, enabled: true });
}

/** A fixed Brief for a preview with no Brief of the holder's own yet. Synthetic; no holder data. */
export const BRIEF_NARRATE_PREVIEW_EXAMPLE: BriefNarrateTarget = Object.freeze<BriefNarrateTarget>({
  briefId: 'example',
  isoWeek: '2026-W01',
  scopes: ['cash.summary', 'recurring.list'],
  foreignTitles: [],
  omitted: 0,
  subject: {
    week: '2026-W01',
    ranked_count: '2',
    attention_count: '0',
    health_score: '70 / 100',
    milestones: [],
    items: [
      {
        title: 'Example: a subscription price went up',
        wording: 'An example summary of a finding, written by a built-in rule.',
        figure: '$120.00 a year',
        carried: false,
      },
      {
        title: 'Example: cash held beyond your recent spending',
        wording: 'Another example summary, written by a built-in rule.',
        figure: '$40.00 a year',
        carried: true,
      },
    ],
    last_week: { accepted: '1', dismissed: '0', carried: '1' },
  },
});

export interface BriefNarratePreview {
  readonly advisorId: typeof BRIEF_NARRATE_ADVISOR_ID;
  readonly advisorVersion: string;
  readonly queryShape: string;
  readonly scopes: readonly string[];
  readonly promptTemplateHash: string;
  readonly provider: string;
  readonly model: string;
  readonly request: BriefNarrateWireRequest & {
    readonly snapshot: ReturnType<typeof buildBriefNarrateRequest>['payload']['snapshot'];
    readonly granted_scopes: readonly string[];
  };
  readonly prompt: { readonly text: string; readonly hash: string };
  /** `true` when the Brief shown is the illustrative example, not the holder's own. */
  readonly illustrative: boolean;
  readonly approved: boolean;
}

export async function previewBriefNarrate(
  executor: InsightsExecutor,
  context: InsightsContext,
  input: { readonly renderer: BriefNarrateRenderer; readonly target: BriefNarrateTarget | null },
): Promise<BriefNarratePreview> {
  const shape = briefNarrateShape(input.renderer.templateHash);
  const target =
    input.target === null || input.target.subject.items.length === 0
      ? BRIEF_NARRATE_PREVIEW_EXAMPLE
      : input.target;
  const built = buildBriefNarrateRequest({
    target,
    now: context.clock.now(),
    timeoutMs: BRIEF_NARRATE_MANIFEST.limits.timeout_ms,
    maxResponseBytes: BRIEF_NARRATE_MANIFEST.limits.max_response_bytes,
  });
  return {
    advisorId: BRIEF_NARRATE_ADVISOR_ID,
    advisorVersion: BRIEF_NARRATE_VERSION,
    queryShape: shape,
    scopes: [...BRIEF_NARRATE_SCOPES],
    promptTemplateHash: input.renderer.templateHash,
    provider: input.renderer.provider,
    model: input.renderer.label,
    request: {
      ...built.request,
      snapshot: built.payload.snapshot,
      granted_scopes: built.payload.granted_scopes,
    },
    prompt: input.renderer.render(built.request),
    illustrative: target === BRIEF_NARRATE_PREVIEW_EXAMPLE,
    approved: await hasLiveApproval(executor, context.userId, BRIEF_NARRATE_ADVISOR_ID, shape),
  };
}

/** Approve the shape the preview showed. Refuses `shape_changed` if it moved since. */
export async function approveBriefNarrate(
  database: InsightsDatabase,
  context: InsightsContext,
  input: { readonly renderer: BriefNarrateRenderer; readonly queryShape: string },
): Promise<{ readonly approvalId: string; readonly queryShape: string }> {
  await ensureBriefNarrateAdvisor(database, context);
  return database.transaction(async (tx) => {
    await lockAdvisor(tx, context.userId, BRIEF_NARRATE_ADVISOR_ID);
    const shape = briefNarrateShape(input.renderer.templateHash);
    if (shape !== input.queryShape) {
      throw new PreviewError(
        'shape_changed',
        `the payload shape of ${BRIEF_NARRATE_ADVISOR_ID} changed since it was previewed`,
      );
    }
    const now = context.clock.now();
    const id = newId();
    const rows = await tx
      .insert(advisorPayloadApprovals)
      .values({
        id,
        userId: context.userId,
        advisorId: BRIEF_NARRATE_ADVISOR_ID,
        queryShape: shape,
        advisorVersion: BRIEF_NARRATE_VERSION,
        kind: 'local_model',
        scopes: [...BRIEF_NARRATE_SCOPES],
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

/** Live approvals of `brief.narrate` for this holder (the tests and the evidence). */
export async function liveBriefNarrateApprovals(
  executor: InsightsExecutor,
  userId: string,
): Promise<number> {
  const rows = await executor
    .select({ id: advisorPayloadApprovals.id })
    .from(advisorPayloadApprovals)
    .where(
      and(
        eq(advisorPayloadApprovals.userId, userId),
        eq(advisorPayloadApprovals.advisorId, BRIEF_NARRATE_ADVISOR_ID),
        sql`${advisorPayloadApprovals.revokedAt} IS NULL`,
      ),
    );
  return rows.length;
}
