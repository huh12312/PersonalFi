// SPDX-License-Identifier: MIT
/**
 * Which language model narrates for a holder, and their consents (WP 10.6;
 * decision D30, which revises D22; migration 0044).
 *
 * The rules that are controls, kept here so no route can skip them:
 *
 *   1. **The consent gate.** A hosted provider (`openai`, `openrouter`,
 *      `anthropic`) is made active only over a standing consent for it, given
 *      against the consent text version the caller names. `setActiveProvider`
 *      refuses `consent_required` otherwise. Withdrawing the consent for the
 *      active provider turns the narrator **Off** in the same transaction.
 *   2. **Approval invalidation.** Making a hosted provider active, or changing
 *      the model of the active hosted provider, revokes every standing payload
 *      approval of `local.narrator` in the same transaction, so the holder
 *      re-approves the payload under the provider and model it will go to
 *      (`advisor_payload_approvals.llm_provider/llm_model` then record which).
 *      The query shape changes anyway (the template hash covers both); the
 *      revocation is the second line, and is what a holder reading the
 *      approvals list sees.
 *   3. **One event per change** (`insights.NarratorSettingsChanged`), in the
 *      transaction, so the worker drops its cached narrator.
 *
 * Every function takes the caller's executor: call inside a transaction.
 */
import { appendEvent } from '@core/platform';
import { newId } from '@core/kernel';
import { and, eq, sql } from 'drizzle-orm';
import {
  advisorPayloadApprovals,
  HOSTED_NARRATOR_PROVIDERS,
  narratorProviderConsents,
  narratorSettings,
  type HostedNarratorProvider,
  type NarratorProviderValue,
  type NarratorSettingsRow,
} from '../schema/index.ts';
import { platformOf, type InsightsContext, type InsightsExecutor } from './db.ts';
import { NarratorSettingsChanged } from './events.ts';
import { NARRATOR_ADVISOR_ID } from './holder.ts';
import { lockAdvisor } from './store.ts';

export function isHostedNarratorProvider(value: string): value is HostedNarratorProvider {
  return (HOSTED_NARRATOR_PROVIDERS as readonly string[]).includes(value);
}

export interface NarratorConsentView {
  readonly provider: HostedNarratorProvider;
  readonly consentTextVersion: string;
  readonly consentTextSha256: string;
  readonly consentedAt: Date;
}

export interface NarratorSettingsView {
  /** `null`: no row — the operator's environment decides, as before WP 10.6. */
  readonly row: NarratorSettingsRow | null;
  readonly consents: ReadonlyMap<HostedNarratorProvider, NarratorConsentView>;
}

export class NarratorSettingsError extends Error {
  readonly code: 'consent_required' | 'consent_version_unknown';
  constructor(code: NarratorSettingsError['code'], detail: string) {
    super(detail);
    this.name = 'NarratorSettingsError';
    this.code = code;
  }
}

/** The holder's settings row (or none) and their standing consents. Two reads. */
export async function readNarratorSettings(
  executor: InsightsExecutor,
  userId: string,
): Promise<NarratorSettingsView> {
  const [rows, consentRows] = await Promise.all([
    executor.select().from(narratorSettings).where(eq(narratorSettings.userId, userId)),
    executor
      .select()
      .from(narratorProviderConsents)
      .where(
        and(
          eq(narratorProviderConsents.userId, userId),
          sql`${narratorProviderConsents.withdrawnAt} IS NULL`,
        ),
      ),
  ]);
  const consents = new Map<HostedNarratorProvider, NarratorConsentView>();
  for (const row of consentRows) {
    consents.set(row.provider, {
      provider: row.provider,
      consentTextVersion: row.consentTextVersion,
      consentTextSha256: row.consentTextSha256,
      consentedAt: row.consentedAt,
    });
  }
  return { row: rows[0] ?? null, consents };
}

/** The model id a provider's row column holds (null: the product's default). */
export function storedModelOf(
  row: NarratorSettingsRow | null,
  provider: NarratorProviderValue,
): string | null {
  if (row === null) return null;
  switch (provider) {
    case 'openai':
      return row.openaiModel;
    case 'openrouter':
      return row.openrouterModel;
    case 'anthropic':
      return row.anthropicModel;
    case 'ollama':
      return row.ollamaModel;
    case 'off':
      return null;
  }
}

/** Revoke every standing approval of the narrator. In the caller's transaction, under the advisor lock. */
async function revokeNarratorApprovals(
  executor: InsightsExecutor,
  context: InsightsContext,
): Promise<number> {
  await lockAdvisor(executor, context.userId, NARRATOR_ADVISOR_ID);
  const now = context.clock.now();
  const rows = await executor
    .update(advisorPayloadApprovals)
    .set({ revokedAt: now, updatedAt: now })
    .where(
      and(
        eq(advisorPayloadApprovals.userId, context.userId),
        eq(advisorPayloadApprovals.advisorId, NARRATOR_ADVISOR_ID),
        sql`${advisorPayloadApprovals.revokedAt} IS NULL`,
      ),
    )
    .returning({ id: advisorPayloadApprovals.id });
  return rows.length;
}

async function upsertRow(
  executor: InsightsExecutor,
  context: InsightsContext,
  patch: Partial<Omit<NarratorSettingsRow, 'userId' | 'createdAt' | 'updatedAt'>>,
  current: NarratorSettingsRow | null,
): Promise<NarratorSettingsRow> {
  const now = context.clock.now();
  const [row] = await executor
    .insert(narratorSettings)
    .values({
      userId: context.userId,
      // A first row records the holder's effective choice so far: the local
      // model, which is what no row meant.
      activeProvider: current?.activeProvider ?? 'ollama',
      ...patch,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: narratorSettings.userId,
      set: { ...patch, updatedAt: now },
    })
    .returning();
  if (row === undefined) throw new Error('narrator_settings upsert returned no row');
  return row;
}

export interface NarratorSettingsChange {
  readonly row: NarratorSettingsRow;
  readonly approvalsRevoked: number;
  /** The active provider before the change (`ollama` when there was no row). */
  readonly previousProvider: NarratorProviderValue;
}

/**
 * Make `provider` the active one (or `off`). A hosted provider needs a standing
 * consent whose text version is `currentConsentVersion` — rule 1. Revokes the
 * narrator's approvals when the new provider is hosted and differs — rule 2.
 */
export async function setActiveNarratorProvider(
  executor: InsightsExecutor,
  context: InsightsContext,
  input: {
    readonly provider: NarratorProviderValue;
    readonly currentConsentVersion: string;
    /** The model the provider will use, for the event (the resolved default when none is stored). */
    readonly model: string | null;
  },
): Promise<NarratorSettingsChange> {
  const current = await readNarratorSettings(executor, context.userId);
  if (isHostedNarratorProvider(input.provider)) {
    const consent = current.consents.get(input.provider);
    if (consent === undefined || consent.consentTextVersion !== input.currentConsentVersion) {
      throw new NarratorSettingsError(
        'consent_required',
        `${input.provider} cannot be made active without the holder's consent to the current text`,
      );
    }
  }
  const previousProvider = current.row?.activeProvider ?? 'ollama';
  const row = await upsertRow(executor, context, { activeProvider: input.provider }, current.row);
  const approvalsRevoked =
    isHostedNarratorProvider(input.provider) && input.provider !== previousProvider
      ? await revokeNarratorApprovals(executor, context)
      : 0;
  await announce(executor, context, row, input.model, 'provider', approvalsRevoked);
  return { row, approvalsRevoked, previousProvider };
}

/** Set (or clear, with `null`) a hosted provider's model id. Rule 2 when it is the active one. */
export async function setHostedNarratorModel(
  executor: InsightsExecutor,
  context: InsightsContext,
  input: {
    readonly provider: HostedNarratorProvider;
    readonly model: string | null;
    /** For the event: the model in force afterwards (the default when `model` is null). */
    readonly effectiveModel: string;
  },
): Promise<NarratorSettingsChange> {
  const current = await readNarratorSettings(executor, context.userId);
  const column =
    input.provider === 'openai'
      ? { openaiModel: input.model }
      : input.provider === 'openrouter'
        ? { openrouterModel: input.model }
        : { anthropicModel: input.model };
  const previousProvider = current.row?.activeProvider ?? 'ollama';
  const changed = storedModelOf(current.row, input.provider) !== input.model;
  const row = await upsertRow(executor, context, column, current.row);
  const approvalsRevoked =
    changed && row.activeProvider === input.provider
      ? await revokeNarratorApprovals(executor, context)
      : 0;
  await announce(executor, context, row, input.effectiveModel, 'model', approvalsRevoked);
  return { row, approvalsRevoked, previousProvider };
}

/** The local endpoint, model name and digest set in Settings (all three, or all null). */
export async function setOllamaNarratorEndpoint(
  executor: InsightsExecutor,
  context: InsightsContext,
  input: {
    readonly endpoint: string | null;
    readonly model: string | null;
    readonly digest: string | null;
  },
): Promise<NarratorSettingsChange> {
  const current = await readNarratorSettings(executor, context.userId);
  const previousProvider = current.row?.activeProvider ?? 'ollama';
  const row = await upsertRow(
    executor,
    context,
    { ollamaEndpoint: input.endpoint, ollamaModel: input.model, ollamaDigest: input.digest },
    current.row,
  );
  // A different local model is a different shape (its digest is in the
  // renderer's model); no revocation is needed for the shape to change.
  await announce(executor, context, row, input.model, 'endpoint', 0);
  return { row, approvalsRevoked: 0, previousProvider };
}

/** Record the holder's consent to one hosted provider, replacing a standing one. */
export async function giveNarratorConsent(
  executor: InsightsExecutor,
  context: InsightsContext,
  input: {
    readonly provider: HostedNarratorProvider;
    readonly consentTextVersion: string;
    readonly consentTextSha256: string;
  },
): Promise<NarratorConsentView> {
  const now = context.clock.now();
  await executor
    .update(narratorProviderConsents)
    .set({ withdrawnAt: now })
    .where(
      and(
        eq(narratorProviderConsents.userId, context.userId),
        eq(narratorProviderConsents.provider, input.provider),
        sql`${narratorProviderConsents.withdrawnAt} IS NULL`,
      ),
    );
  await executor.insert(narratorProviderConsents).values({
    id: newId(),
    userId: context.userId,
    provider: input.provider,
    consentTextVersion: input.consentTextVersion,
    consentTextSha256: input.consentTextSha256,
    consentedAt: now,
    withdrawnAt: null,
  });
  const current = await readNarratorSettings(executor, context.userId);
  const row = current.row ?? (await upsertRow(executor, context, {}, null));
  await announce(
    executor,
    context,
    row,
    storedModelOf(row, row.activeProvider),
    'consent_given',
    0,
  );
  return {
    provider: input.provider,
    consentTextVersion: input.consentTextVersion,
    consentTextSha256: input.consentTextSha256,
    consentedAt: now,
  };
}

/**
 * Withdraw the holder's consent to one hosted provider. If it is the active
 * provider the narrator is turned **Off** in the same transaction — a
 * withdrawn consent never leaves a provider active (rule 1).
 */
export async function withdrawNarratorConsent(
  executor: InsightsExecutor,
  context: InsightsContext,
  provider: HostedNarratorProvider,
): Promise<{ readonly withdrawn: boolean; readonly turnedOff: boolean }> {
  const now = context.clock.now();
  const rows = await executor
    .update(narratorProviderConsents)
    .set({ withdrawnAt: now })
    .where(
      and(
        eq(narratorProviderConsents.userId, context.userId),
        eq(narratorProviderConsents.provider, provider),
        sql`${narratorProviderConsents.withdrawnAt} IS NULL`,
      ),
    )
    .returning({ id: narratorProviderConsents.id });
  const current = await readNarratorSettings(executor, context.userId);
  let row = current.row;
  let turnedOff = false;
  if (row !== null && row.activeProvider === provider) {
    row = await upsertRow(executor, context, { activeProvider: 'off' }, row);
    turnedOff = true;
  }
  if (rows.length > 0 && row !== null) {
    await announce(executor, context, row, null, 'consent_withdrawn', 0);
  }
  return { withdrawn: rows.length > 0, turnedOff };
}

async function announce(
  executor: InsightsExecutor,
  context: InsightsContext,
  row: NarratorSettingsRow,
  model: string | null,
  change: 'provider' | 'model' | 'endpoint' | 'consent_given' | 'consent_withdrawn',
  approvalsRevoked: number,
): Promise<void> {
  await appendEvent(
    platformOf(executor),
    NarratorSettingsChanged.create(
      { activeProvider: row.activeProvider, model, change, approvalsRevoked },
      { userId: context.userId, correlationId: context.correlationId, aggregateId: context.userId },
      context.clock,
    ),
  );
}
