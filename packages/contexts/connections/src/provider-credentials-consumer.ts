// SPDX-License-Identifier: MIT
/**
 * The worker's half of "a key replaced in the product reaches the next sync
 * without a restart" (WP 10.1).
 *
 * The api that handled the `PUT` drops its own cache directly; the worker is a
 * different process and learns of the change the way every process learns of a
 * fact — from the outbox. This consumer does one thing: when a
 * `connections.ProviderCredentialsChanged` event arrives it calls `onChanged`,
 * which the composition root binds to `registry.invalidate(provider)`. The next
 * sync then re-reads the sealed row and builds a client from what is there now.
 *
 * Idempotent by construction (dropping a cache twice is dropping it once), so a
 * replay, a retry or a restart that re-reads the log from its offset is harmless
 * — which is why it carries a version in its name and no state of its own.
 */
import { registerConsumer, type RegisteredConsumer } from '@core/platform';
import { ProviderCredentialsChanged } from './events.ts';

export const PROVIDER_CREDENTIALS_CONSUMER = 'connections.provider_credentials_cache@v1';

export function createProviderCredentialsConsumer(dependencies: {
  readonly onChanged: (provider: string) => void;
}): RegisteredConsumer {
  return registerConsumer(
    PROVIDER_CREDENTIALS_CONSUMER,
    async (event) => {
      const payload = ProviderCredentialsChanged.schema.safeParse(event.payload);
      if (!payload.success) return;
      dependencies.onChanged(payload.data.provider);
    },
    { filter: [ProviderCredentialsChanged.type] },
  );
}
