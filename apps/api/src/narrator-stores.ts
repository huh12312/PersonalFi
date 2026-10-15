// SPDX-License-Identifier: MIT
/**
 * The database half of the narrator runtime (WP 10.6): a holder's settings
 * and consents from `@ctx/insights`, their stored keys from `@ctx/connections`.
 * The one reader both `app.ts` (preview, approval, Settings) and `worker.ts`
 * (the run) bind, so the two processes cannot read the settings two ways.
 */
import type { HostedModelKey, HostedProvider } from '@advisor/local-model';
import {
  listLanguageModelKeyStatuses,
  openLanguageModelKey,
  type ConnectionsDatabase,
} from '@ctx/connections';
import { readNarratorSettings, type InsightsDatabase } from '@ctx/insights';
import type { SecretBox } from '@core/secretbox';
import { narratorConsentSha256, NARRATOR_CONSENT_VERSION } from './narrator-consent.ts';
import type { NarratorSettingsSnapshot, NarratorStores } from './narrator-wiring.ts';

export function createNarratorStores(input: {
  readonly database: InsightsDatabase & ConnectionsDatabase;
  /** `undefined` while the KEK is locked: a stored key is then unopenable. */
  readonly secretBox: () => SecretBox | undefined;
}): NarratorStores {
  return {
    async settings(userId: string): Promise<NarratorSettingsSnapshot> {
      const view = await readNarratorSettings(input.database, userId);
      const row = view.row;
      const consented = new Set<HostedProvider>();
      for (const [provider, consent] of view.consents) {
        // Only a consent to the text shown today counts — and to its exact bytes.
        if (
          consent.consentTextVersion === NARRATOR_CONSENT_VERSION &&
          consent.consentTextSha256 === narratorConsentSha256(provider)
        ) {
          consented.add(provider);
        }
      }
      return {
        activeProvider: row?.activeProvider ?? 'ollama',
        hasRow: row !== null,
        models: {
          openai: row?.openaiModel ?? null,
          openrouter: row?.openrouterModel ?? null,
          anthropic: row?.anthropicModel ?? null,
        },
        ollama:
          row?.ollamaEndpoint == null || row.ollamaModel == null || row.ollamaDigest == null
            ? null
            : { endpoint: row.ollamaEndpoint, name: row.ollamaModel, digest: row.ollamaDigest },
        consented,
      };
    },
    async storedKey(
      userId: string,
      provider: HostedProvider | 'ollama',
    ): Promise<HostedModelKey | 'unopenable' | null> {
      const box = input.secretBox();
      if (box === undefined) {
        // A locked box cannot open anything: a stored key is unopenable, not absent.
        const stored = await listLanguageModelKeyStatuses(input.database, userId);
        return stored.has(provider) ? 'unopenable' : null;
      }
      const opened = await openLanguageModelKey(input.database, box, userId, provider);
      if (opened === null || opened === 'unopenable') return opened;
      return { reveal: () => opened.key() };
    },
  };
}
