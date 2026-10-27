// SPDX-License-Identifier: MIT
/**
 * `categorize.suggest`'s own payload preview and approval (the WP 5.1 / 10.1
 * pattern, 03 §8.3: show the exact payload before the first send of a new
 * query type).
 *
 * The shape is `queryShape` over advisor id, version, kind, the scope and the
 * suggestion template hash — the narrator's recipe with this advisor's inputs —
 * so a new template, a new format, a new sampling option or a new version is
 * a new shape that needs a new approval, and the narrator's approval can never
 * be spent here (a different advisor id is a different shape). The preview
 * builds the request through `buildSuggestRequest`, the constructor the run
 * uses, over the rows a run would send now, and renders the prompt through the
 * bound model's pure `render`. Nothing is called.
 */
import { newId } from '@core/kernel';
import { and, eq, sql } from 'drizzle-orm';
import { advisorPayloadApprovals } from '../../../schema/index.ts';
import type { InsightsContext, InsightsDatabase, InsightsExecutor } from '../../db.ts';
import { hasLiveApproval, PreviewError } from '../../preview.ts';
import {
  grantScopes,
  lockAdvisor,
  registerAdvisor,
  revokeScopes,
  setAdvisorEnabled,
} from '../../store.ts';
import {
  CATEGORY_SUGGEST_ADVISOR_ID,
  CATEGORY_SUGGEST_MANIFEST,
  CATEGORY_SUGGEST_SCOPES,
  CATEGORY_SUGGEST_VERSION,
} from './manifest.ts';
import {
  buildSuggestRequest,
  type ResidueRowInput,
  type SuggestTaxonomyEntry,
  type SuggestWireRequest,
} from './request.ts';
import { categorySuggestShape } from './run.ts';

/** The renderer half of a suggestion model: what the api binds (it never calls a model). */
export interface SuggestionRenderer {
  readonly provider: string;
  readonly label: string;
  readonly templateHash: string;
  render(request: SuggestWireRequest): { readonly text: string; readonly hash: string };
}

/**
 * The `advisors` row (default off), so approvals, grants and runs have their
 * parent. Registration is bookkeeping: `registerAdvisor` never touches
 * `enabled` on an existing row.
 */
export async function ensureCategorySuggestAdvisor(
  database: InsightsDatabase,
  context: InsightsContext,
): Promise<void> {
  await registerAdvisor(database, context, { manifest: CATEGORY_SUGGEST_MANIFEST, enabled: false });
}

export interface CategorySuggestPreview {
  readonly advisorId: typeof CATEGORY_SUGGEST_ADVISOR_ID;
  readonly advisorVersion: string;
  readonly queryShape: string;
  readonly scopes: readonly string[];
  readonly promptTemplateHash: string;
  readonly provider: string;
  readonly model: string;
  /** The rows and taxonomy a run would send now (at most one batch). */
  readonly payload: ReturnType<typeof buildSuggestRequest>['payload'];
  /** The exact prompt bytes. */
  readonly prompt: { readonly text: string; readonly hash: string };
  readonly approved: boolean;
}

export async function previewCategorySuggest(
  executor: InsightsExecutor,
  context: InsightsContext,
  input: {
    readonly renderer: SuggestionRenderer;
    readonly taxonomy: readonly SuggestTaxonomyEntry[];
    readonly rows: readonly ResidueRowInput[];
  },
): Promise<CategorySuggestPreview> {
  const shape = categorySuggestShape(input.renderer.templateHash);
  // A preview with no residue yet still shows the shape and the template: one
  // illustrative row, labelled as such by its tokens, so the holder sees what
  // a row looks like before any exists.
  const rows: readonly ResidueRowInput[] =
    input.rows.length > 0
      ? input.rows
      : [
          {
            payee_tokens: ['example', 'merchant'],
            mcc_family: null,
            pfc_primary: null,
            amount_bucket: '3',
            account_kind: 'credit',
            direction: 'out',
            day_bucket: 'mid',
          },
        ];
  const built = buildSuggestRequest({
    taxonomy: input.taxonomy,
    rows,
    now: context.clock.now(),
    timeoutMs: CATEGORY_SUGGEST_MANIFEST.limits.timeout_ms,
    maxResponseBytes: CATEGORY_SUGGEST_MANIFEST.limits.max_response_bytes,
  });
  return {
    advisorId: CATEGORY_SUGGEST_ADVISOR_ID,
    advisorVersion: CATEGORY_SUGGEST_VERSION,
    queryShape: shape,
    scopes: [...CATEGORY_SUGGEST_SCOPES],
    promptTemplateHash: input.renderer.templateHash,
    provider: input.renderer.provider,
    model: input.renderer.label,
    payload: built.payload,
    prompt: input.renderer.render(built.request),
    approved: await hasLiveApproval(executor, context.userId, CATEGORY_SUGGEST_ADVISOR_ID, shape),
  };
}

/** Approve the shape the preview showed. Refuses `shape_changed` if it moved since. */
export async function approveCategorySuggest(
  database: InsightsDatabase,
  context: InsightsContext,
  input: { readonly renderer: SuggestionRenderer; readonly queryShape: string },
): Promise<{ readonly approvalId: string; readonly queryShape: string }> {
  await ensureCategorySuggestAdvisor(database, context);
  return database.transaction(async (tx) => {
    await lockAdvisor(tx, context.userId, CATEGORY_SUGGEST_ADVISOR_ID);
    const shape = categorySuggestShape(input.renderer.templateHash);
    if (shape !== input.queryShape) {
      throw new PreviewError(
        'shape_changed',
        `the payload shape of ${CATEGORY_SUGGEST_ADVISOR_ID} changed since it was previewed`,
      );
    }
    const now = context.clock.now();
    const id = newId();
    const rows = await tx
      .insert(advisorPayloadApprovals)
      .values({
        id,
        userId: context.userId,
        advisorId: CATEGORY_SUGGEST_ADVISOR_ID,
        queryShape: shape,
        advisorVersion: CATEGORY_SUGGEST_VERSION,
        kind: 'local_model',
        scopes: [...CATEGORY_SUGGEST_SCOPES],
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

/** Live approvals of `categorize.suggest` for this holder (the Settings card and the tests). */
export async function liveCategorySuggestApprovals(
  executor: InsightsExecutor,
  userId: string,
): Promise<number> {
  const rows = await executor
    .select({ id: advisorPayloadApprovals.id })
    .from(advisorPayloadApprovals)
    .where(
      and(
        eq(advisorPayloadApprovals.userId, userId),
        eq(advisorPayloadApprovals.advisorId, CATEGORY_SUGGEST_ADVISOR_ID),
        sql`${advisorPayloadApprovals.revokedAt} IS NULL`,
      ),
    );
  return rows.length;
}

/**
 * The Settings card's Enable switch: kill level 3 for `categorize.suggest`,
 * with its one scope granted beside it (and revoked with it). The precision
 * gate is the caller's to check first — `@ctx/categorization` owns the
 * measurements — and the run checks it again on every batch, so a row
 * switched on by any other path still sends nothing below 85 %.
 */
export async function setCategorySuggestEnabled(
  database: InsightsDatabase,
  context: InsightsContext,
  enabled: boolean,
  options: { readonly stepUpSessionId?: string | null } = {},
): Promise<void> {
  await ensureCategorySuggestAdvisor(database, context);
  await database.transaction(async (tx) => {
    await lockAdvisor(tx, context.userId, CATEGORY_SUGGEST_ADVISOR_ID);
    if (enabled) {
      await grantScopes(
        tx,
        context,
        CATEGORY_SUGGEST_ADVISOR_ID,
        CATEGORY_SUGGEST_SCOPES,
        false,
        options,
      );
    } else {
      await revokeScopes(
        tx,
        context,
        CATEGORY_SUGGEST_ADVISOR_ID,
        CATEGORY_SUGGEST_SCOPES,
        options,
      );
    }
    await setAdvisorEnabled(tx, context, CATEGORY_SUGGEST_ADVISOR_ID, enabled);
  });
}
