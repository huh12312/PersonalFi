// SPDX-License-Identifier: MIT
/**
 * WP 10.1: the api and the worker build Plaid the same way.
 *
 * Re-gate N-5 was a worker that built its connector registry from different
 * configuration than the api did, so a connection linked through the api never
 * synced. WP 10.1 adds a second source for Plaid (the holder's stored
 * credentials), and the same failure is available again: if only one process
 * registered it, a holder could store keys, see Plaid in the Add connection
 * menu, link a bank, and have every sync die in the worker.
 *
 * `worker.ts`'s `main()` is not callable from a test (it unlocks a KEK, opens a
 * pool and starts a pump), so — as `regate-worker-boot.test.ts` does for N-5 —
 * this asserts the composition roots' source: both build the registry through
 * `withStoredPlaid`, and the worker hands that same registry to `appModules`, so
 * the consumer that drops its cache on a credential change is attached to the
 * registry the orchestrator syncs through. The behaviour behind it (the cache
 * dropped by the event, through the real `appModules` and a real pump) is
 * `test/db/provider-credentials-routes.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoFile = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../${relative}`, import.meta.url)), 'utf8');

describe('stored Plaid credentials: one composition for both processes (WP 10.1)', () => {
  it('app.ts and worker.ts both build their registry through withStoredPlaid', () => {
    for (const file of ['apps/api/src/app.ts', 'apps/api/src/worker.ts']) {
      const source = repoFile(file);
      expect(source, `${file} must call withStoredPlaid(`).toMatch(/withStoredPlaid\(/u);
      expect(source, `${file} must call createStoredPlaid(`).toMatch(/createStoredPlaid\(/u);
    }
  });

  it('the worker hands the registry it syncs through to appModules, so the consumer invalidates that registry', () => {
    const worker = repoFile('apps/api/src/worker.ts');
    expect(worker).toMatch(/registry:\s*connectorRegistry\b/u);
    const modulesCall = /appModules\(\{[\s\S]*?\n\s+connectorRegistry,\n/u.exec(worker);
    expect(modulesCall, 'appModules() must receive connectorRegistry').not.toBeNull();

    const modules = repoFile('apps/api/src/modules.ts');
    expect(modules).toMatch(/createProviderCredentialsConsumer\(\{/u);
    expect(modules).toMatch(/options\.connectorRegistry\?\.invalidate\(provider\)/u);
  });

  it('the api route drops its own cache on every write', () => {
    const route = repoFile('apps/api/src/routes/provider-credentials.ts');
    expect(route.match(/registry\.invalidate\(PLAID_PROVIDER\)/gu)?.length).toBeGreaterThanOrEqual(
      2,
    );
  });
});
