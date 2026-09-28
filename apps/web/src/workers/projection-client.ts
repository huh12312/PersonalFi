// SPDX-License-Identifier: MIT
/**
 * The Comlink client wrapper around `./projection.worker.ts` — spun up on
 * **route entry**, not on first drag (dispatch §3 / 05 §5.7), with a
 * `requestIdleCallback` warm-up to prime the JIT before the first real drag
 * needs it. `apps/web/vite.config.ts`'s CSP-relevant build choices apply
 * unchanged here: this is a same-origin bundled worker file
 * (`new Worker(new URL('./projection.worker.ts', import.meta.url), { type:
 * 'module' })`), never a `Blob` URL, so no CSP `worker-src` widening is
 * needed (dispatch §3: "No new CSP directive").
 *
 * `createProjectionClient` never throws: browsers without `Worker` (or a test
 * environment with no `Worker` global) get `available: false` and `run`
 * rejects — `features/plan/sliders/GoalSliders.tsx` reads `available` and
 * renders the server-fallback state instead of calling `run` at all.
 */
import * as Comlink from 'comlink';

import type {
  ProjectionBands,
  ProjectionWorkerApi,
  ProjectionWorkerJob,
} from './projection.worker.ts';

export type { ProjectionBands, ProjectionWorkerJob };

export interface ProjectionClient {
  readonly available: boolean;
  run(job: ProjectionWorkerJob): Promise<ProjectionBands>;
  terminate(): void;
}

function requestIdle(callback: () => void): void {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(callback);
  } else {
    // Safari has no requestIdleCallback (as of this writing) — a macrotask is close enough
    // for a warm-up whose only job is to run once, off the critical path, before first paint settles.
    setTimeout(callback, 0);
  }
}

function unavailableClient(): ProjectionClient {
  return {
    available: false,
    run() {
      return Promise.reject(
        new Error('projection.worker.ts: Worker is not available in this browser'),
      );
    },
    terminate() {},
  };
}

/** One instance per route mount — never re-created per drag or per lever change. */
export function createProjectionClient(): ProjectionClient {
  if (typeof Worker === 'undefined') return unavailableClient();

  let worker: Worker;
  try {
    worker = new Worker(new URL('./projection.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    // A hardened/CSP-restricted environment that has `Worker` but refuses to construct one.
    return unavailableClient();
  }

  const proxy = Comlink.wrap<ProjectionWorkerApi>(worker);
  requestIdle(() => void proxy.warmUp());

  return {
    available: true,
    run: (job) => proxy.run(job),
    terminate: () => {
      worker.terminate();
    },
  };
}
