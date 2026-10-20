// SPDX-License-Identifier: MIT
/**
 * The api's control checks, bound to the database (WP 10.16).
 *
 * Two of them change state to prove a refusal — the approval gate withdraws
 * the narrator's approval, the consent check withdraws a consent — and both
 * do it **inside a transaction that is always rolled back** (`rolledBack`),
 * through the same functions the product uses (`runAdvisor`,
 * `revokePayloadApprovals`, `withdrawNarratorConsent`,
 * `setActiveNarratorProvider`, `giveNarratorConsent`). The events those
 * functions append are rolled back with them, so nothing announces a change
 * that never happened. Each check reads the state before and after and fails
 * if it differs (`catalogue.ts`).
 */
import { and, asc, desc, eq, gt, isNotNull } from 'drizzle-orm';
import {
  advisorPayloadApprovals,
  advisorRunPayloads,
  advisorRuns,
  insights,
  narratorProviderConsents,
  narratorSettings,
} from '../../schema/index.ts';
import { NARRATOR_MANIFEST } from '../advisors/local/manifest.ts';
import type { NarratorModelPort } from '../advisors/local/narrator.ts';
import type { InsightsContext, InsightsDatabase, InsightsExecutor } from '../db.ts';
import { NARRATOR_ADVISOR_ID, type HolderNarrator } from '../holder.ts';
import {
  giveNarratorConsent,
  NarratorSettingsError,
  readNarratorSettings,
  setActiveNarratorProvider,
  withdrawNarratorConsent,
} from '../narrator-settings.ts';
import type { RunSwitches } from '../policy/kill-switches.ts';
import type { PromptRenderer } from '../ports.ts';
import {
  effectiveRunScopes,
  hasLiveApproval,
  inspectRunPayload,
  revokePayloadApprovals,
  shapeFor,
} from '../preview.ts';
import { runAdvisor, type InsightsDependencies } from '../service.ts';
import {
  clearQuarantine,
  findAdvisor,
  listGrants,
  registerAdvisor,
  setAdvisorEnabled,
} from '../store.ts';
import type {
  ApprovalGatePort,
  ConsentWithdrawalPort,
  HostedProviderName,
  InspectorPort,
  NarrationBadgePort,
  NarratorProviderName,
} from './catalogue.ts';

/** Thrown at the end of every `rolledBack` body: the transaction never commits. */
class ControlCheckRollback extends Error {
  constructor() {
    super('control check: rolled back by design');
    this.name = 'ControlCheckRollback';
  }
}

/**
 * Run `body` in a transaction and roll it back, always, returning what the
 * body returned. The only way the self-test changes state.
 */
export async function rolledBack<T>(
  database: InsightsDatabase,
  body: (tx: InsightsDatabase) => Promise<T>,
): Promise<T> {
  let result: { readonly value: T } | null = null;
  try {
    await database.transaction(async (tx) => {
      // A transaction handle opens savepoints for the nested transactions the
      // product's own functions open; at runtime it is the database's shape.
      result = { value: await body(tx as unknown as InsightsDatabase) };
      throw new ControlCheckRollback();
    });
  } catch (error) {
    if (!(error instanceof ControlCheckRollback)) throw error;
  }
  if (result === null) throw new Error('control check: the rolled-back body returned nothing');
  return (result as { readonly value: T }).value;
}

/** A renderer for a holder with no narrator: a shape that never had an approval. */
const SYNTHETIC_RENDERER: PromptRenderer = Object.freeze({
  templateHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000c0c',
  model: 'control-check:synthetic',
  provider: 'ollama',
  render: () => ({
    messages: [],
    text: '',
    bytes: 0,
    hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    templateHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000c0c',
    flags: [],
  }),
}) as unknown as PromptRenderer;

/** Every level of the ladder on: the approval gate is what decides, and only it. */
const ALL_ON: RunSwitches = Object.freeze({
  advisorsEnabled: () => Promise.resolve(true),
  moduleEnabled: () => Promise.resolve(true),
  kindEnabled: () => Promise.resolve(true),
});

async function narratorApprovals(executor: InsightsExecutor, userId: string) {
  return executor
    .select({ id: advisorPayloadApprovals.id, revokedAt: advisorPayloadApprovals.revokedAt })
    .from(advisorPayloadApprovals)
    .where(
      and(
        eq(advisorPayloadApprovals.userId, userId),
        eq(advisorPayloadApprovals.advisorId, NARRATOR_ADVISOR_ID),
      ),
    )
    .orderBy(asc(advisorPayloadApprovals.id));
}

function stateOf(value: unknown): string {
  return JSON.stringify(value, (_key, field: unknown) =>
    field instanceof Date ? field.toISOString() : field,
  );
}

export interface HolderCheckPortsOptions {
  readonly database: InsightsDatabase;
  readonly context: InsightsContext;
  /** The api's insights dependencies (registry, snapshot ports, settings). */
  readonly dependencies: InsightsDependencies;
  /** The holder's narrator as the api resolves it (preview mode: it renders, it never calls). */
  readonly narrator: HolderNarrator | null;
  /** The consent text version and digest the Settings screen records. */
  readonly consent: {
    readonly version: string;
    sha256(provider: HostedProviderName): string;
  };
  /** The Brief's own reading of `advisor_runs.llm_model` (`narratedByOf`). */
  badgeOf(llmModel: string | null): { readonly provider: string; readonly model: string } | null;
}

export interface HolderCheckPorts {
  readonly approvalGate: ApprovalGatePort;
  readonly consent: ConsentWithdrawalPort;
  readonly inspector: InspectorPort;
  readonly badge: NarrationBadgePort;
}

export function holderCheckPorts(options: HolderCheckPortsOptions): HolderCheckPorts {
  const { database, context } = options;
  const userId = context.userId;

  const approvalGate: ApprovalGatePort = {
    async approvalState() {
      const rows = await narratorApprovals(database, userId);
      return {
        live: rows.filter((row) => row.revokedAt === null).length,
        digest: stateOf(rows),
      };
    },
    attemptWithoutApproval: () =>
      rolledBack(database, async (tx) => {
        const manifest = NARRATOR_MANIFEST;
        const renderer = options.narrator?.renderer ?? SYNTHETIC_RENDERER;
        // Levels 1-3 held on, in this transaction only, so the gate decides.
        if ((await findAdvisor(tx, userId, manifest.advisor_id)) === null) {
          await registerAdvisor(tx, context, { manifest, enabled: true });
        } else {
          await setAdvisorEnabled(tx, context, manifest.advisor_id, true);
          await clearQuarantine(tx, context, manifest.advisor_id);
        }
        const grants = await listGrants(tx, userId, manifest.advisor_id);
        const shape = shapeFor(manifest, effectiveRunScopes(manifest, grants), {
          promptRenderer: renderer,
        });
        const hadApproval = await hasLiveApproval(tx, userId, manifest.advisor_id, shape);
        await revokePayloadApprovals(tx, context, manifest.advisor_id);
        let modelReached = false;
        const sentinel: NarratorModelPort = {
          run: () => {
            modelReached = true;
            return Promise.reject(new Error('control check sentinel: nothing is sent'));
          },
        };
        const result = await runAdvisor(
          tx,
          context,
          {
            ...options.dependencies,
            switches: ALL_ON,
            narratorFor: () => Promise.resolve({ renderer, model: sentinel }),
          },
          { advisorId: manifest.advisor_id, trigger: 'manual', lane: 'local' },
        );
        return {
          shape: options.narrator === null ? ('synthetic' as const) : ('current' as const),
          hadApproval,
          status: result.status,
          refusal: result.refusal,
          modelReached,
        };
      }),
  };

  async function consentState(executor: InsightsExecutor): Promise<string> {
    const [settings, consents, approvals] = await Promise.all([
      executor.select().from(narratorSettings).where(eq(narratorSettings.userId, userId)),
      executor
        .select({
          id: narratorProviderConsents.id,
          withdrawnAt: narratorProviderConsents.withdrawnAt,
        })
        .from(narratorProviderConsents)
        .where(eq(narratorProviderConsents.userId, userId))
        .orderBy(asc(narratorProviderConsents.id)),
      narratorApprovals(executor, userId),
    ]);
    return stateOf({ settings, consents, approvals });
  }

  const consent: ConsentWithdrawalPort = {
    async activeProvider() {
      const view = await readNarratorSettings(database, userId);
      return (view.row?.activeProvider ?? 'ollama') as NarratorProviderName;
    },
    state: () => consentState(database),
    simulateWithdrawal: (provider) =>
      rolledBack(database, async (tx) => {
        const live = (await narratorApprovals(tx, userId)).filter(
          (row) => row.revokedAt === null,
        ).length;
        await withdrawNarratorConsent(tx, context, provider);
        const activeAfter = ((await readNarratorSettings(tx, userId)).row?.activeProvider ??
          'ollama') as NarratorProviderName;
        let reactivationRefused = false;
        let revokedOnReturn = 0;
        try {
          revokedOnReturn = (
            await setActiveNarratorProvider(tx, context, {
              provider,
              currentConsentVersion: options.consent.version,
              model: null,
            })
          ).approvalsRevoked;
        } catch (error) {
          if (!(error instanceof NarratorSettingsError)) throw error;
          reactivationRefused = true;
        }
        if (reactivationRefused) {
          await giveNarratorConsent(tx, context, {
            provider,
            consentTextVersion: options.consent.version,
            consentTextSha256: options.consent.sha256(provider),
          });
          revokedOnReturn = (
            await setActiveNarratorProvider(tx, context, {
              provider,
              currentConsentVersion: options.consent.version,
              model: null,
            })
          ).approvalsRevoked;
        }
        return { activeAfter, reactivationRefused, liveApprovals: live, revokedOnReturn };
      }),
  };

  const inspector: InspectorPort = {
    async latestNarratorRun() {
      const [row] = await database
        .select({ runId: advisorRuns.id, startedAt: advisorRuns.startedAt })
        .from(advisorRuns)
        .innerJoin(advisorRunPayloads, eq(advisorRunPayloads.runId, advisorRuns.id))
        .where(
          and(
            eq(advisorRuns.userId, userId),
            eq(advisorRuns.advisorId, NARRATOR_ADVISOR_ID),
            gt(advisorRunPayloads.expiresAt, context.clock.now()),
          ),
        )
        .orderBy(desc(advisorRuns.startedAt))
        .limit(1);
      return row ?? null;
    },
    async inspect(runId) {
      const inspection = await inspectRunPayload(database, userId, runId, context.clock.now());
      return inspection === null
        ? null
        : {
            verified: inspection.verified,
            recordedDigest: inspection.recordedDigest,
            recomputedDigest: inspection.recomputedDigest,
          };
    },
  };

  const badge: NarrationBadgePort = {
    async latestNarration() {
      const [narration] = await database
        .select({ at: insights.lastProposedAt, runId: insights.runId })
        .from(insights)
        .where(and(eq(insights.userId, userId), isNotNull(insights.narratesInsightId)))
        .orderBy(desc(insights.lastProposedAt))
        .limit(1);
      if (narration === undefined) return null;
      const runId = narration.runId;
      const [run] =
        runId === null
          ? []
          : await database
              .select({ llmModel: advisorRuns.llmModel })
              .from(advisorRuns)
              .where(and(eq(advisorRuns.userId, userId), eq(advisorRuns.id, runId)))
              .limit(1);
      const [payload] =
        runId === null
          ? []
          : await database
              .select({ queryShape: advisorRunPayloads.queryShape })
              .from(advisorRunPayloads)
              .where(
                and(eq(advisorRunPayloads.userId, userId), eq(advisorRunPayloads.runId, runId)),
              )
              .limit(1);
      const [approval] =
        payload === undefined
          ? []
          : await database
              .select({
                provider: advisorPayloadApprovals.llmProvider,
                model: advisorPayloadApprovals.llmModel,
              })
              .from(advisorPayloadApprovals)
              .where(
                and(
                  eq(advisorPayloadApprovals.userId, userId),
                  eq(advisorPayloadApprovals.advisorId, NARRATOR_ADVISOR_ID),
                  eq(advisorPayloadApprovals.queryShape, payload.queryShape),
                ),
              )
              .orderBy(desc(advisorPayloadApprovals.approvedAt))
              .limit(1);
      const runModel = run?.llmModel ?? null;
      return {
        at: narration.at,
        runModel,
        approvalFound: approval !== undefined,
        approvedProvider: approval?.provider ?? null,
        approvedModel: approval?.model ?? null,
        badge: options.badgeOf(runModel),
      };
    },
  };

  return { approvalGate, consent, inspector, badge };
}
