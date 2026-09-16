// SPDX-License-Identifier: MIT
/**
 * Phase 1 re-gate (C-4), findings N-4 and N-5.
 *
 * Both were found by watching the real `worker` container on the production
 * compose stack, and neither was visible to any existing test, because every
 * test that exercises a connector registry or a job runner **builds its own**
 * — nothing checked what `apps/api/src/worker.ts`'s composition root actually
 * constructs, and nothing checked that the container it runs in can afford the
 * Argon2id parameters it derives the KEK with.
 *
 * N-5 (CRITICAL): `worker.ts` called `createConnectorRegistry()` with no
 * arguments while `app.ts` called it with `{ plaid: config.plaid, … }`. The
 * worker is the only process that runs a queued or scheduled sync, so a Plaid
 * Item could be linked, sealed and stored by the API and then never sync:
 * every `connections.sync` job died with `no connector is registered for
 * provider "plaid"` after five attempts. Observed on the running stack.
 *
 * N-4 (CRITICAL): `compose.yml` capped `worker` at 512M while
 * `KEK_ARGON2_MEMORY_KIB` defaults to 1048576 KiB (1 GiB), so `box.unlock()`
 * was killed with no output — 189 silent restarts, the scheduler never
 * started, the `schedules` table stayed empty.
 *
 * These assertions are deliberately made against the **source and the compose
 * file as committed**, not against a rebuilt runtime: the defect in both cases
 * is what the composition root and the deployment descriptor say, and a test
 * that boots a worker would need a database, a KEK and 1 GiB of RAM to say the
 * same thing.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createConnectorRegistry, PROCESS_LOCAL_PROVIDERS } from '../src/domain.ts';

const repoFile = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../${relative}`, import.meta.url)), 'utf8');

describe('worker composition root (re-gate N-5)', () => {
  it('builds its connector registry from configuration, exactly as the API does', () => {
    const worker = repoFile('apps/api/src/worker.ts');
    const app = repoFile('apps/api/src/app.ts');

    for (const [name, source] of [
      ['apps/api/src/worker.ts', worker],
      ['apps/api/src/app.ts', app],
    ] as const) {
      const calls = [...source.matchAll(/createConnectorRegistry\(([^)]*)/g)].map(
        (m) => m[1] ?? '',
      );
      expect(calls.length, `${name} must build a connector registry`).toBeGreaterThan(0);
      for (const args of calls) {
        expect(
          args.includes('plaid'),
          `${name}: createConnectorRegistry() is called without \`plaid\`, so the Plaid ` +
            `connector is silently unregistered in that process. The worker is the only ` +
            `process that runs a queued or scheduled sync.`,
        ).toBe(true);
      }
    }
  });

  it('registry omits plaid when unconfigured and includes it when configured', () => {
    expect(createConnectorRegistry().has('plaid')).toBe(false);

    const configured = createConnectorRegistry({
      plaid: {
        clientId: { reveal: () => 'client' },
        secret: { reveal: () => 'secret' },
        environment: 'sandbox',
        clientName: 'PersonalFi',
        countryCodes: ['US'],
        language: 'en',
        redirectUri: null,
        webhookUrl: null,
      } as never,
    });
    expect(configured.has('plaid')).toBe(true);
    expect(configured.manifests().map((m) => m.provider)).toContain('plaid');
  });
});

describe('worker memory budget (re-gate N-4)', () => {
  it('gives the worker more memory than the KEK derivation it performs needs', () => {
    const compose = repoFile('compose.yml');

    // `worker:` service block, up to the next top-level service key.
    const block = /\n {2}worker:\n([\s\S]*?)(?=\n {2}[a-z][a-z0-9_-]*:\n)/.exec(compose)?.[1];
    expect(block, 'compose.yml has no `worker:` service').toBeDefined();

    const limit = /memory:\s*(\d+)(M|G)\b/.exec(block ?? '');
    expect(limit, 'the worker declares no memory limit').not.toBeNull();
    const limitMib = Number(limit?.[1]) * (limit?.[2] === 'G' ? 1024 : 1);

    // The default the worker actually runs with; `.env.example` may raise it,
    // and if it does this floor has to move with it.
    const kekMib =
      Number(/KEK_ARGON2_MEMORY_KIB[^0-9]*(\d+)/.exec(repoFile('.env.example'))?.[1] ?? 1_048_576) /
      1024;

    expect(
      limitMib,
      `worker memory limit ${limitMib}MiB is not above the ${kekMib}MiB Argon2id KEK ` +
        `derivation it performs at boot. At or below it, box.unlock() is killed with no ` +
        `output and the worker restart-loops silently: no consumer pump, no job runner, ` +
        `no scheduler, and an empty \`schedules\` table.`,
    ).toBeGreaterThan(kekMib);
  });
});

describe('nightly fan-out (re-gate N-7, closed by decision D-5)', () => {
  /**
   * Originally: `domain.ts` stated the invariant that a `PROCESS_LOCAL_PROVIDERS`
   * connection can only be synced in the process that staged it, and the nightly
   * fan-out did not apply the same rule the sync route did — the WORKER, a
   * different process with an empty `ManualStore`, polled a manual/CSV
   * connection it never staged and flipped it to `reauth_required` with a
   * permanent, false "Needs reconnection". Observed on the real stack.
   *
   * `connection_staged_facts` (migration `0008_connections_staging.sql`) closed
   * the actual gap: `ManualConnector` and `CsvImportConnector` now read and
   * write through a durable `StagingStore` that `apps/api/src/domain.ts`'s
   * `attachDurableStaging` attaches, so any process — including one that never
   * linked the connection — hydrates the rows it needs before it needs them.
   * The fan-out no longer has a reason to exclude these providers, and this
   * case is re-gated to assert exactly that: the filter is gone from the
   * source, and (`apps/api/test/db/closeout-staging.test.ts`) a worker-shaped
   * fan-out actually schedules and completes a Manual sync.
   */
  it('includes process-local providers in the scheduled fan-out — no PROCESS_LOCAL_PROVIDERS filter', () => {
    const modules = repoFile('apps/api/src/modules.ts');
    const fanOut = /async function syncableConnectionIds\(([\s\S]*?)\n}/.exec(modules)?.[1];
    expect(fanOut, 'apps/api/src/modules.ts has no syncableConnectionIds').toBeDefined();
    expect(
      fanOut?.includes('PROCESS_LOCAL_PROVIDERS'),
      'the nightly fan-out still excludes PROCESS_LOCAL_PROVIDERS connections, but decision ' +
        'D-5 made Manual/CSV staging durable (connection_staged_facts) — the worker can now ' +
        'sync a connection it never staged, and excluding it here only makes it stale, not safer.',
    ).toBe(false);
    expect(
      /^import\s*\{[^}]*\bPROCESS_LOCAL_PROVIDERS\b[^}]*\}\s*from\s*'\.\/domain\.ts';$/m.test(
        modules,
      ),
      'apps/api/src/modules.ts imports PROCESS_LOCAL_PROVIDERS from domain.ts but has no live ' +
        'use for it left — the fan-out filter is gone, so this is now a routing (inline vs. ' +
        'queued) concern owned by routes/connections.ts alone. A mention in a doc comment ' +
        'explaining the history is fine; an import is not.',
    ).toBe(false);
  });

  it('keeps the process-local providers named — routes/connections.ts still uses the set for inline-vs-queued sync', () => {
    for (const provider of ['manual', 'file_import', 'seed']) {
      expect(
        PROCESS_LOCAL_PROVIDERS.has(provider),
        `${provider} still stages onto an in-process buffer first; ` +
          `apps/api/src/routes/connections.ts reads PROCESS_LOCAL_PROVIDERS to decide whether ` +
          `a user-triggered sync runs inline or is queued. Durable staging (D-5) made that a ` +
          `latency choice, not a correctness one, but the set itself is still load-bearing there.`,
      ).toBe(true);
    }
  });
});
