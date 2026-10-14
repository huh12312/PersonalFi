// SPDX-License-Identifier: MIT
/**
 * WP 10.4: the api and the worker read market-data keys the same way, and the
 * worker actually uses what it reads.
 *
 * `worker.ts`'s `main()` is not callable from a test (it unlocks a KEK, opens a
 * pool and starts a pump), so — as `provider-credentials-wiring.test.ts` does
 * for Plaid — this asserts the composition roots' source. The behaviour behind
 * each line (the stored key resolved, the cache dropped by the event through
 * the real `appModules` and a real pump, the resolver handed the mapper) is in
 * `test/db/market-data-credentials-routes.test.ts`,
 * `test/db/unresolved-positions-routes.test.ts` and `test/market-data-runtime.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoFile = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../${relative}`, import.meta.url)), 'utf8');

describe('stored market-data keys: one reader for both processes (WP 10.4)', () => {
  it('app.ts and worker.ts both read stored keys through createStoredMarketDataKeys', () => {
    for (const file of ['apps/api/src/app.ts', 'apps/api/src/worker.ts']) {
      expect(repoFile(file), `${file} must call createStoredMarketDataKeys(`).toMatch(
        /createStoredMarketDataKeys\(\{/u,
      );
    }
    expect(repoFile('apps/api/src/worker.ts')).toMatch(
      /createMarketDataRuntime\(\{[\s\S]*?storedKeys:\s*createStoredMarketDataKeys\(/u,
    );
  });

  it('the worker primes every budget, file or stored, keyed or anonymous', () => {
    expect(repoFile('apps/api/src/worker.ts')).toMatch(
      /hydrateMarketDataBudgets\(\s*database,\s*userId,\s*marketDataRuntime\.allBudgets,?\s*\)/u,
    );
  });

  it("the worker hands the resolver the holder's OpenFIGI mapper", () => {
    expect(repoFile('apps/api/src/worker.ts')).toMatch(
      /createInvestmentSyncPort\(database, systemClock, \{\s*figiFor: async \(holder\) => \(await marketDataRuntime\.forUser\(holder\)\)\.figi,/u,
    );
  });

  it("the price refresh and the consumer use the holder's view, and a credential change drops it", () => {
    const modules = repoFile('apps/api/src/modules.ts');
    expect(modules).toMatch(/const view = await marketData\.runtime\.forUser\(context\.userId\);/u);
    expect(modules).toMatch(/sources: view\.sources,/u);
    expect(modules).toMatch(
      /if \(provider !== 'plaid'\) options\.marketData\?\.runtime\.invalidate\(\);/u,
    );
  });
});
