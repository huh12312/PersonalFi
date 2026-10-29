// SPDX-License-Identifier: MIT
/**
 * `merchant.name`'s own payload preview and approval (the WP 5.1 / 10.1
 * pattern, 03 §8.3: show the exact payload before the first send of a new query
 * type), shown in Advisor management beside the other query types.
 *
 * The shape is `queryShape` over advisor id, version, kind, scopes and a
 * template hash that folds in the adapter's template (prompt, format, options,
 * model) and the consent text (`MERCHANT_NAME_CONSENT_TEXT`, versioned), so a
 * new template, model, consent wording or version is a new shape that needs a
 * new approval. One approval covers every descriptor: the shape does not depend
 * on which merchant is asked about, only on what is sent and how.
 *
 * The preview builds the request through `buildMerchantNameRequest`, the
 * constructor the run uses, over the holder's own first noise merchant when the
 * composition root passes one (else a fixed illustrative descriptor, labelled as
 * such), and renders the prompt through the bound model's pure `render`.
 * Nothing is called.
 */
import { newId } from '@core/kernel';
import { advisorPayloadApprovals } from '../../../schema/index.ts';
import type { InsightsContext, InsightsDatabase, InsightsExecutor } from '../../db.ts';
import { hasLiveApproval, PreviewError } from '../../preview.ts';
import { findAdvisor, lockAdvisor, registerAdvisor } from '../../store.ts';
import {
  MERCHANT_NAME_ADVISOR_ID,
  MERCHANT_NAME_CONSENT_TEXT,
  MERCHANT_NAME_CONSENT_VERSION,
  MERCHANT_NAME_MANIFEST,
  MERCHANT_NAME_SCOPES,
  MERCHANT_NAME_VERSION,
  merchantNameConsentSha256,
  merchantNameShapeTemplateHash,
} from './manifest.ts';
import {
  buildMerchantNameRequest,
  type MerchantNameSubject,
  type MerchantNameWireRequest,
} from './request.ts';
import { merchantNameShape, type MerchantNameRenderer } from './run.ts';

/**
 * The `advisors` row, so approvals and runs have their parent. Registered
 * **on**: nothing is sent without an approved shape and a local model, and
 * level 3's switch in Advisor management still turns it off.
 */
export async function ensureMerchantNameAdvisor(
  database: InsightsExecutor,
  context: InsightsContext,
): Promise<void> {
  if ((await findAdvisor(database, context.userId, MERCHANT_NAME_ADVISOR_ID)) !== null) return;
  await registerAdvisor(database, context, { manifest: MERCHANT_NAME_MANIFEST, enabled: true });
}

/** A fixed descriptor for a preview with no noise merchant yet. Synthetic; no holder data. */
export const MERCHANT_NAME_PREVIEW_EXAMPLE: MerchantNameSubject = Object.freeze({
  descriptor: 'Examplestore 7Q2Z9X4K',
  stripped_prefix: 'SQ *',
});

export interface MerchantNamePreview {
  readonly advisorId: typeof MERCHANT_NAME_ADVISOR_ID;
  readonly advisorVersion: string;
  readonly queryShape: string;
  readonly scopes: readonly string[];
  /** The approvable template hash: the adapter's and the consent text's together. */
  readonly promptTemplateHash: string;
  readonly provider: 'ollama';
  readonly model: string;
  readonly request: MerchantNameWireRequest & {
    readonly snapshot: ReturnType<typeof buildMerchantNameRequest>['payload']['snapshot'];
    readonly granted_scopes: readonly string[];
    readonly consent: { readonly version: string; readonly sha256: string; readonly text: string };
  };
  readonly prompt: { readonly text: string; readonly hash: string };
  /** `true` when the descriptor is the illustrative example, not one of the holder's own. */
  readonly illustrative: boolean;
  readonly approved: boolean;
}

export async function previewMerchantName(
  executor: InsightsExecutor,
  context: InsightsContext,
  input: { readonly renderer: MerchantNameRenderer; readonly subject: MerchantNameSubject | null },
): Promise<MerchantNamePreview> {
  const shape = merchantNameShape(input.renderer.templateHash);
  const subject = input.subject ?? MERCHANT_NAME_PREVIEW_EXAMPLE;
  const built = buildMerchantNameRequest({
    descriptor: subject.descriptor,
    strippedPrefix: subject.stripped_prefix,
    now: context.clock.now(),
    timeoutMs: MERCHANT_NAME_MANIFEST.limits.timeout_ms,
    maxResponseBytes: MERCHANT_NAME_MANIFEST.limits.max_response_bytes,
  });
  return {
    advisorId: MERCHANT_NAME_ADVISOR_ID,
    advisorVersion: MERCHANT_NAME_VERSION,
    queryShape: shape,
    scopes: [...MERCHANT_NAME_SCOPES],
    promptTemplateHash: merchantNameShapeTemplateHash(input.renderer.templateHash),
    provider: 'ollama',
    model: input.renderer.label,
    request: {
      ...built.request,
      snapshot: built.payload.snapshot,
      granted_scopes: built.payload.granted_scopes,
      consent: {
        version: MERCHANT_NAME_CONSENT_VERSION,
        sha256: merchantNameConsentSha256(),
        text: MERCHANT_NAME_CONSENT_TEXT,
      },
    },
    prompt: input.renderer.render(built.request),
    illustrative: input.subject === null,
    approved: await hasLiveApproval(executor, context.userId, MERCHANT_NAME_ADVISOR_ID, shape),
  };
}

/** Approve the shape the preview showed. Refuses `shape_changed` if it moved since. */
export async function approveMerchantName(
  database: InsightsDatabase,
  context: InsightsContext,
  input: { readonly renderer: MerchantNameRenderer; readonly queryShape: string },
): Promise<{ readonly approvalId: string; readonly queryShape: string }> {
  await ensureMerchantNameAdvisor(database, context);
  return database.transaction(async (tx) => {
    await lockAdvisor(tx, context.userId, MERCHANT_NAME_ADVISOR_ID);
    const shape = merchantNameShape(input.renderer.templateHash);
    if (shape !== input.queryShape) {
      throw new PreviewError(
        'shape_changed',
        `the payload shape of ${MERCHANT_NAME_ADVISOR_ID} changed since it was previewed`,
      );
    }
    const now = context.clock.now();
    const id = newId();
    const rows = await tx
      .insert(advisorPayloadApprovals)
      .values({
        id,
        userId: context.userId,
        advisorId: MERCHANT_NAME_ADVISOR_ID,
        queryShape: shape,
        advisorVersion: MERCHANT_NAME_VERSION,
        kind: 'local_model',
        scopes: [...MERCHANT_NAME_SCOPES],
        promptTemplateHash: merchantNameShapeTemplateHash(input.renderer.templateHash),
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
