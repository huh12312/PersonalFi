// SPDX-License-Identifier: MIT
/**
 * WP 10.6: wakes the worker when a holder changes their narrator settings, so
 * the composition root's cached narrator (30 s) is dropped at once and the
 * next run uses the change — the `connections.ProviderCredentialsChanged`
 * consumer's shape (WP 10.1). The settings are re-read from the table, never
 * from the payload.
 */
import { registerConsumer, type RegisteredConsumer } from '@core/platform';
import { NarratorSettingsChanged } from './events.ts';

export const NARRATOR_SETTINGS_CONSUMER = 'insights.narrator_settings_cache@v1';

export function createNarratorSettingsConsumer(dependencies: {
  readonly onChanged: (userId: string) => void;
}): RegisteredConsumer {
  return registerConsumer(
    NARRATOR_SETTINGS_CONSUMER,
    async (event) => {
      const payload = NarratorSettingsChanged.schema.safeParse(event.payload);
      if (!payload.success) return;
      dependencies.onChanged(event.userId);
    },
    { filter: [NarratorSettingsChanged.type] },
  );
}
