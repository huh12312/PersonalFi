// SPDX-License-Identifier: MIT
/**
 * The advisor's own hosted consent (WP 11.5d; D31), in the pattern
 * `categorize.suggest` uses (WP 11.2): a tick-box separate from the
 * narrator's, stored as the sha256 of the exact consent text ticked. No row,
 * or a hash of any other text, is **unticked**: the advisor runs on the local
 * model. Withdrawing clears both columns.
 */
import { eq } from 'drizzle-orm';
import { advisorSettings } from '../../../schema/index.ts';
import type { InsightsContext, InsightsExecutor } from '../../db.ts';
import { advisorConsentSha256 } from './manifest.ts';

export type AdvisorHostedProvider = 'openai' | 'openrouter' | 'anthropic';

export interface AdvisorSettings {
  /** The hosted provider the advisor uses when ticked; `null` = the narrator's own. */
  readonly hostedProvider: AdvisorHostedProvider | null;
  readonly hostedConsentedAt: Date | null;
  readonly hostedConsentTextHash: string | null;
}

/** No row: unticked, the local model (D31's default). */
export const DEFAULT_ADVISOR_SETTINGS: AdvisorSettings = Object.freeze({
  hostedProvider: null,
  hostedConsentedAt: null,
  hostedConsentTextHash: null,
});

export async function readAdvisorSettings(
  executor: InsightsExecutor,
  userId: string,
): Promise<AdvisorSettings> {
  const rows = await executor
    .select()
    .from(advisorSettings)
    .where(eq(advisorSettings.userId, userId));
  const row = rows[0];
  if (row === undefined) return DEFAULT_ADVISOR_SETTINGS;
  return {
    hostedProvider: row.hostedProvider ?? null,
    hostedConsentedAt: row.hostedConsentedAt ?? null,
    hostedConsentTextHash: row.hostedConsentTextHash ?? null,
  };
}

/** Whether the stored consent covers today's text, byte for byte. */
export function advisorHostedConsented(settings: AdvisorSettings): boolean {
  return (
    settings.hostedConsentedAt !== null && settings.hostedConsentTextHash === advisorConsentSha256()
  );
}

export class AdvisorConsentMismatch extends Error {
  readonly code = 'advisor_consent_changed' as const;
  constructor() {
    super('the consent text ticked is not the current one');
    this.name = 'AdvisorConsentMismatch';
  }
}

/**
 * Tick (a hash equal to today's text's), untick (`null`), or choose the
 * provider. A hash of any other text is refused: a holder consents to the
 * words on the screen or to nothing.
 */
export async function writeAdvisorSettings(
  executor: InsightsExecutor,
  context: Pick<InsightsContext, 'userId' | 'clock'>,
  patch: {
    readonly hostedConsentTextHash?: string | null;
    readonly hostedProvider?: AdvisorHostedProvider | null;
  },
): Promise<AdvisorSettings> {
  const current = await readAdvisorSettings(executor, context.userId);
  const now = context.clock.now();
  if (
    patch.hostedConsentTextHash !== undefined &&
    patch.hostedConsentTextHash !== null &&
    patch.hostedConsentTextHash !== advisorConsentSha256()
  ) {
    throw new AdvisorConsentMismatch();
  }
  const hash =
    patch.hostedConsentTextHash === undefined
      ? current.hostedConsentTextHash
      : patch.hostedConsentTextHash;
  const consentedAt =
    patch.hostedConsentTextHash === undefined
      ? current.hostedConsentedAt
      : patch.hostedConsentTextHash === null
        ? null
        : now;
  const provider =
    patch.hostedProvider === undefined ? current.hostedProvider : patch.hostedProvider;
  await executor
    .insert(advisorSettings)
    .values({
      userId: context.userId,
      hostedProvider: provider,
      hostedConsentedAt: consentedAt,
      hostedConsentTextHash: hash,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: advisorSettings.userId,
      set: {
        hostedProvider: provider,
        hostedConsentedAt: consentedAt,
        hostedConsentTextHash: hash,
        updatedAt: now,
      },
    });
  return { hostedProvider: provider, hostedConsentedAt: consentedAt, hostedConsentTextHash: hash };
}
