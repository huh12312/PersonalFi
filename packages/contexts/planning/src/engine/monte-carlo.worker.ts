// SPDX-License-Identifier: MIT
/**
 * The Monte Carlo worker thread — a thin shell around `montecarlo.ts`.
 *
 * Spawned only by `worker-host.ts`, which is where every limit lives: the
 * declared `resourceLimits`, `env: {}`, `execArgv: []`, the hard deadline and
 * the envelope refusal before spawn. This file reads its one request from
 * `workerData` (a structured clone — no shared memory, no handles), runs it,
 * posts **one** reply and returns, so the thread exits by itself.
 *
 * It imports only the interior (`montecarlo.ts` → `deterministic.ts`,
 * `bootstrap.ts`, `prng.ts`): no `@core/kernel`, no `boundary.ts`, no
 * assumptions file, no database. Money never enters this thread; the host
 * converts on both sides.
 *
 * Replies carry bands, never paths: the largest array posted is
 * `levels × years` doubles, and its buffer is transferred, not copied.
 */
import { parentPort, resourceLimits, workerData } from 'node:worker_threads';
import { runMonteCarlo, solveForSuccess, type WorkerReply, type WorkerRequest } from './montecarlo.ts';

function handle(request: WorkerRequest): { readonly reply: WorkerReply; readonly transfer: ArrayBuffer[] } {
  switch (request.kind) {
    case 'run': {
      const result = runMonteCarlo(request.job);
      const transfer: ArrayBuffer[] = [result.bands.buffer as ArrayBuffer];
      if (result.sequence !== null) transfer.push(result.sequence.deciles.buffer as ArrayBuffer);
      if (result.withoutCrypto !== null) transfer.push(result.withoutCrypto.bands.buffer as ArrayBuffer);
      return { reply: { kind: 'run', result }, transfer };
    }
    case 'solve':
      return { reply: { kind: 'solve', outcome: solveForSuccess(request.job, request.target) }, transfer: [] };
    case 'probe':
      // What this thread was actually given — the worker-limits test and the gate read it.
      return {
        reply: {
          kind: 'probe',
          envKeys: Object.keys(process.env),
          execArgv: [...process.execArgv],
          resourceLimits: { ...resourceLimits },
          heapUsedMb: process.memoryUsage().heapUsed / 1_048_576,
        },
        transfer: [],
      };
  }
}

const port = parentPort;
if (port === null) throw new Error('monte-carlo.worker.ts runs only as a worker thread');
const { reply, transfer } = handle(workerData as WorkerRequest);
port.postMessage(reply, transfer);
