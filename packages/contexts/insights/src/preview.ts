// SPDX-License-Identifier: MIT
/**
 * The payload preview gate (03 §8.3: "show Chris the exact payload before the
 * first send of any new query type").
 *
 * ## A query shape
 *
 * `sha256` over the canonical JSON of
 *
 * ```
 * { advisor_id, advisor_version, kind, scopes: <sorted effective scopes>, prompt_template_hash }
 * ```
 *
 * — everything that decides *what kind of thing* is sent, and nothing that
 * decides its values. A new balance is the same shape; a newly granted scope,
 * a new advisor version or an edited prompt template is a new one. A
 * `local_model` or `external` run refuses `payload_not_approved` until a live
 * `advisor_payload_approvals` row exists for the shape it would send
 * (`decideRun`'s last input), and the approval carries the shape its preview
 * returned, so an approval for yesterday's shape cannot be spent on today's.
 *
 * ## The preview builds the exact request and invokes nothing
 *
 * `previewRequest` and `runAdvisor` build the request through the same
 * function below (`buildAdvisorRequest`) from the same effective scopes, so
 * "what you approved" and "what is sent" cannot drift apart by being two
 * implementations. The preview reads the holder's data through the snapshot
 * ports — it has to, to show the payload — and calls no advisor, no model and
 * no network: the prompt bytes come from the `PromptRenderer` port, which is
 * pure by contract (`ports.ts`).
 *
 * For a local model the data never leaves the host, so the gate is consent and
 * transparency rather than egress control. It is built now because Phase 6's
 * `external` advisor inherits it unchanged.
 */
import { newId, todayIn } from '@core/kernel';
import { and, eq, sql } from 'drizzle-orm';
import { advisorPayloadApprovals } from '../schema/index.ts';
import type { AdvisorManifest } from './contract/manifest.ts';
import type { AdvisorRequest } from './contract/request.ts';
import { scopeDefinition, type AdvisorKind, type AdvisorScope } from './contract/scopes.ts';
import { ADVISOR_CONTRACT_MAJOR } from './contract/version.ts';
import type { InsightsContext, InsightsDatabase, InsightsExecutor } from './db.ts';
import type { RenderedPrompt } from './ports.ts';
import type { RegisteredAdvisor } from './registry.ts';
import type { InsightsDependencies } from './service.ts';
import { SnapshotBuilder, type BuiltSnapshot } from './snapshot/builder.ts';
import { deriveTokenKey, inputDigest } from './snapshot/tokens.ts';
import { findRun, findRunPayload, listGrants, lockAdvisor } from './store.ts';

/** Does a run of this kind need an approved shape? Only the kinds that send a payload somewhere. */
export function requiresPayloadApproval(kind: AdvisorKind): boolean {
  return kind !== 'builtin';
}

/**
 * The scopes a run will actually carry: what the holder granted, narrowed to
 * what the manifest asked for, to what the kind may hold, and — Phase 4 gate
 * G4-22 — never a `requiresPerRunConsent` scope without a consent for *this*
 * run. A standing grant of such a scope is not enough; the run path drops it.
 *
 * Catalogue order, like `SnapshotBuilder.effectiveScopes`, which it calls.
 */
export function effectiveRunScopes(
  manifest: AdvisorManifest,
  grants: readonly AdvisorScope[],
  perRunConsent: readonly AdvisorScope[] = [],
): readonly AdvisorScope[] {
  const consented = new Set(perRunConsent);
  const requested = grants.filter(
    (scope) =>
      manifest.requires_scopes.includes(scope) &&
      (!scopeDefinition(scope).requiresPerRunConsent || consented.has(scope)),
  );
  return SnapshotBuilder.effectiveScopes(manifest.kind, requested);
}

export interface QueryShapeInput {
  readonly advisorId: string;
  readonly advisorVersion: string;
  readonly kind: AdvisorKind;
  readonly scopes: readonly AdvisorScope[];
  readonly promptTemplateHash: string | null;
}

/** `sha256:` over the canonical shape. Scope order never matters: they are sorted here. */
export function queryShape(input: QueryShapeInput): string {
  return inputDigest({
    advisor_id: input.advisorId,
    advisor_version: input.advisorVersion,
    kind: input.kind,
    scopes: [...input.scopes].sort(),
    prompt_template_hash: input.promptTemplateHash,
  });
}

/** The shape a run of this advisor would send, from its effective scopes. */
export function shapeFor(
  manifest: AdvisorManifest,
  scopes: readonly AdvisorScope[],
  dependencies: Pick<InsightsDependencies, 'promptRenderer'>,
): string {
  return queryShape({
    advisorId: manifest.advisor_id,
    advisorVersion: manifest.version,
    kind: manifest.kind,
    scopes,
    promptTemplateHash:
      manifest.kind === 'local_model' ? (dependencies.promptRenderer?.templateHash ?? null) : null,
  });
}

// ---------------------------------------------------------------------------
// The request both the preview and the run send
// ---------------------------------------------------------------------------

export interface BuiltRequest {
  readonly request: AdvisorRequest;
  readonly built: BuiltSnapshot;
}

/**
 * Build the snapshot and wrap it in the request. The one constructor of an
 * `AdvisorRequest` on the run path — `runAdvisor` and `previewRequest` both
 * call it.
 */
export async function buildAdvisorRequest(
  dependencies: InsightsDependencies,
  context: InsightsContext,
  registered: RegisteredAdvisor,
  scopes: readonly AdvisorScope[],
): Promise<BuiltRequest> {
  const { manifest, limits } = registered;
  const { clock } = context;
  const today = todayIn(clock, dependencies.settings.timeZone);
  const built = await new SnapshotBuilder(dependencies.ports).build({
    userId: context.userId,
    kind: manifest.kind,
    grantedScopes: scopes,
    today,
    baseCurrency: dependencies.settings.baseCurrency,
    tokenKey: deriveTokenKey(dependencies.settings.tokenSecret, context.userId),
  });
  const request: AdvisorRequest = {
    contract_version: ADVISOR_CONTRACT_MAJOR,
    request_id: newId(),
    advisor_id: manifest.advisor_id,
    advisor_version: manifest.version,
    kind: manifest.kind,
    generated_at: clock.now().toISOString(),
    base_currency: dependencies.settings.baseCurrency,
    time_zone: dependencies.settings.timeZone,
    today,
    granted_scopes: [...built.grantedScopes],
    input_digest: built.inputDigest,
    limits: {
      max_insights: limits.maxInsights,
      max_response_bytes: limits.maxResponseBytes,
      deadline: new Date(clock.now().getTime() + limits.timeoutMs).toISOString(),
    },
    snapshot: built.snapshot,
  };
  return { request, built };
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

/** Is there a live (unrevoked) approval for exactly this shape? */
export async function hasLiveApproval(
  executor: InsightsExecutor,
  userId: string,
  advisorId: string,
  shape: string,
): Promise<boolean> {
  const rows = await executor
    .select({ id: advisorPayloadApprovals.id })
    .from(advisorPayloadApprovals)
    .where(
      and(
        eq(advisorPayloadApprovals.userId, userId),
        eq(advisorPayloadApprovals.advisorId, advisorId),
        eq(advisorPayloadApprovals.queryShape, shape),
        sql`${advisorPayloadApprovals.revokedAt} IS NULL`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export interface PayloadPreview {
  readonly advisorId: string;
  readonly kind: AdvisorKind;
  /** The shape an approval must carry. */
  readonly queryShape: string;
  readonly scopes: readonly AdvisorScope[];
  readonly promptTemplateHash: string | null;
  /** The exact request a run would send now, snapshot included. */
  readonly request: AdvisorRequest;
  /** The exact prompt bytes, for a `local_model` advisor with a renderer bound. */
  readonly prompt: RenderedPrompt | null;
  readonly approvalRequired: boolean;
  readonly approved: boolean;
}

export class PreviewError extends Error {
  readonly code: 'advisor_not_registered' | 'renderer_unavailable' | 'shape_changed';
  constructor(code: PreviewError['code'], message: string) {
    super(message);
    this.name = 'PreviewError';
    this.code = code;
  }
}

function registeredOrThrow(
  dependencies: InsightsDependencies,
  advisorId: string,
): RegisteredAdvisor {
  const registered = dependencies.registry.get(advisorId);
  if (registered === undefined) {
    throw new PreviewError('advisor_not_registered', `advisor ${advisorId} is not registered`);
  }
  return registered;
}

async function currentShape(
  executor: InsightsExecutor,
  dependencies: InsightsDependencies,
  userId: string,
  registered: RegisteredAdvisor,
  perRunConsent: readonly AdvisorScope[],
): Promise<{ readonly scopes: readonly AdvisorScope[]; readonly shape: string }> {
  const grants = await listGrants(executor, userId, registered.manifest.advisor_id);
  const scopes = effectiveRunScopes(registered.manifest, grants, perRunConsent);
  return { scopes, shape: shapeFor(registered.manifest, scopes, dependencies) };
}

/**
 * Build the exact request — and, for a local model, the exact prompt — a run
 * of this advisor would send now, without invoking anything.
 */
export async function previewRequest(
  database: InsightsDatabase,
  context: InsightsContext,
  dependencies: InsightsDependencies,
  advisorId: string,
  options: { readonly perRunConsent?: readonly AdvisorScope[] } = {},
): Promise<PayloadPreview> {
  const registered = registeredOrThrow(dependencies, advisorId);
  const { manifest } = registered;
  if (manifest.kind === 'local_model' && dependencies.promptRenderer === undefined) {
    throw new PreviewError(
      'renderer_unavailable',
      `no PromptRenderer is bound, so ${advisorId}'s prompt cannot be shown`,
    );
  }
  const { scopes, shape } = await currentShape(
    database,
    dependencies,
    context.userId,
    registered,
    options.perRunConsent ?? [],
  );
  const { request } = await buildAdvisorRequest(dependencies, context, registered, scopes);
  const prompt =
    manifest.kind === 'local_model' && dependencies.promptRenderer !== undefined
      ? dependencies.promptRenderer.render(request)
      : null;
  const approvalRequired = requiresPayloadApproval(manifest.kind);
  return {
    advisorId,
    kind: manifest.kind,
    queryShape: shape,
    scopes,
    promptTemplateHash:
      manifest.kind === 'local_model' ? (dependencies.promptRenderer?.templateHash ?? null) : null,
    request,
    prompt,
    approvalRequired,
    approved:
      !approvalRequired || (await hasLiveApproval(database, context.userId, advisorId, shape)),
  };
}

/**
 * Approve the shape a preview returned.
 *
 * Refuses (`shape_changed`) when the advisor's current shape is not the one
 * the holder was shown — a scope granted, a version bumped or a template
 * edited since the preview. Takes the `advisors` row lock, so an approval and
 * a run's write barrier are serialised like every other switch.
 */
export async function approvePayload(
  database: InsightsDatabase,
  context: InsightsContext,
  dependencies: InsightsDependencies,
  input: {
    readonly advisorId: string;
    readonly queryShape: string;
    readonly perRunConsent?: readonly AdvisorScope[];
  },
): Promise<{ readonly approvalId: string; readonly queryShape: string }> {
  const registered = registeredOrThrow(dependencies, input.advisorId);
  const { manifest } = registered;
  return database.transaction(async (tx) => {
    await lockAdvisor(tx, context.userId, manifest.advisor_id);
    const { scopes, shape } = await currentShape(
      tx,
      dependencies,
      context.userId,
      registered,
      input.perRunConsent ?? [],
    );
    if (shape !== input.queryShape) {
      throw new PreviewError(
        'shape_changed',
        `the payload shape of ${manifest.advisor_id} changed since it was previewed`,
      );
    }
    if (!requiresPayloadApproval(manifest.kind)) {
      throw new PreviewError(
        'advisor_not_registered',
        `${manifest.advisor_id} is a builtin advisor; it sends no payload to approve`,
      );
    }
    const now = context.clock.now();
    const id = newId();
    const rows = await tx
      .insert(advisorPayloadApprovals)
      .values({
        id,
        userId: context.userId,
        advisorId: manifest.advisor_id,
        queryShape: shape,
        advisorVersion: manifest.version,
        kind: manifest.kind as 'local_model' | 'external',
        scopes: [...scopes].sort(),
        promptTemplateHash:
          manifest.kind === 'local_model'
            ? (dependencies.promptRenderer?.templateHash ?? null)
            : null,
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
        set: { approvedAt: now, revokedAt: null, updatedAt: now },
      })
      .returning({ id: advisorPayloadApprovals.id });
    return { approvalId: rows[0]?.id ?? id, queryShape: shape };
  });
}

/** Withdraw every live approval for this advisor. A run in flight stops within a second. */
export async function revokePayloadApprovals(
  database: InsightsDatabase,
  context: InsightsContext,
  advisorId: string,
): Promise<number> {
  return database.transaction(async (tx) => {
    await lockAdvisor(tx, context.userId, advisorId);
    const now = context.clock.now();
    const rows = await tx
      .update(advisorPayloadApprovals)
      .set({ revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(advisorPayloadApprovals.userId, context.userId),
          eq(advisorPayloadApprovals.advisorId, advisorId),
          sql`${advisorPayloadApprovals.revokedAt} IS NULL`,
        ),
      )
      .returning({ id: advisorPayloadApprovals.id });
    return rows.length;
  });
}

// ---------------------------------------------------------------------------
// The run inspector's half: what was sent, verified rather than trusted
// ---------------------------------------------------------------------------

export interface RetainedPayloadInspection {
  readonly runId: string;
  readonly advisorId: string;
  readonly queryShape: string;
  /** `advisor_runs.input_digest` — computed before the call; the authority. */
  readonly recordedDigest: string | null;
  /** `inputDigest(payload.snapshot)`, recomputed now from the stored bytes. */
  readonly recomputedDigest: string;
  /** The two agree. A retained payload that does not verify is shown as such, never as evidence. */
  readonly verified: boolean;
  readonly payload: Record<string, unknown>;
  readonly expiresAt: Date;
}

/**
 * Read a retained payload and re-digest it against the run's own
 * `input_digest`. `null` when the run retained nothing (a builtin) or the
 * payload has passed its 30-day bound.
 */
export async function inspectRunPayload(
  executor: InsightsExecutor,
  userId: string,
  runId: string,
  now: Date,
): Promise<RetainedPayloadInspection | null> {
  const stored = await findRunPayload(executor, userId, runId, now);
  if (stored === null) return null;
  const run = await findRun(executor, userId, runId);
  const recomputed = inputDigest((stored.payload as { snapshot?: unknown }).snapshot ?? null);
  const recorded = run?.inputDigest ?? null;
  return {
    runId,
    advisorId: stored.advisorId,
    queryShape: stored.queryShape,
    recordedDigest: recorded,
    recomputedDigest: recomputed,
    verified: recorded !== null && recorded === recomputed,
    payload: stored.payload,
    expiresAt: stored.expiresAt,
  };
}
