// SPDX-License-Identifier: MIT
/**
 * A real worker process, for the killed-and-restarted drill.
 *
 * This is a separate process on purpose, and it is the only test in the package
 * that is. Everything the drill claims turns on a worker dying *without running
 * any code on the way out*: no `finally`, no `stop()`, no `UPDATE jobs SET
 * status`. An in-process fake cannot be killed that way — the moment the test
 * pretends to crash by resolving a promise, it has stopped testing the thing.
 * So: `spawn`, `SIGKILL`, and a second process that has to notice on its own.
 *
 * Both roles run this same file. The only difference is `DRILL_BLOCK_MS`: the
 * victim blocks for an hour inside its handler and never gets there, the
 * survivor finishes immediately. Same binary, same handler, same runner
 * configuration — which is what makes the result a statement about the runner
 * rather than about two bespoke scripts.
 *
 * Progress is reported as one JSON object per line on stdout, so the drill can
 * synchronise on "the victim has actually claimed the job" instead of sleeping
 * and hoping. The runner's own log lines go to the same stream, which is what
 * ends up in the evidence file.
 *
 *   DRILL_DATABASE_URL   required; the scratch database the drill created
 *   DRILL_WORKER_ID      identifies this process in `jobs.locked_by`
 *   DRILL_BLOCK_MS       how long the handler stalls before finishing its work
 *   DRILL_RECLAIM_MS     heartbeat staleness that makes a claim reapable
 */
import { createDatabase, createPool } from '@core/db';
import { systemClock } from '@core/kernel';
import { z } from 'zod';
import { platformExecutor } from '../../src/database.ts';
import type { PlatformLogger } from '../../src/executor.ts';
import { appendEvent } from '../../src/events/outbox.ts';
import { defineEvent } from '../../src/events/registry.ts';
import { createJobRunner, defineJob } from '../../src/jobs/runner.ts';

const databaseUrl = process.env['DRILL_DATABASE_URL'];
const workerId = process.env['DRILL_WORKER_ID'] ?? 'drill-worker';
const blockMs = Number(process.env['DRILL_BLOCK_MS'] ?? '0');
const reclaimAfterMs = Number(process.env['DRILL_RECLAIM_MS'] ?? '2000');

if (databaseUrl === undefined || databaseUrl === '') {
  process.stderr.write('DRILL_DATABASE_URL is required\n');
  process.exit(78);
}

function say(line: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ worker: workerId, ...line })}\n`);
}

const logger: PlatformLogger = {
  debug: () => undefined,
  info: (obj, msg) => say({ level: 'info', msg, ...obj }),
  warn: (obj, msg) => say({ level: 'warn', msg, ...obj }),
  error: (obj, msg) => say({ level: 'error', msg, ...obj }),
};

/**
 * The drill's proof of "exactly once".
 *
 * The job's observable effect is one appended event, written in its own
 * transaction. `job_runs` records that the first attempt was abandoned and the
 * second succeeded, but a run row is bookkeeping the platform writes about
 * itself; an event is the work. One event for a job that two workers held is
 * the property under test.
 */
export const DrillWorkCompleted = defineEvent({
  type: 'drill.WorkCompleted',
  aggregateType: 'drill',
  description: 'The synthetic drill job finished. Written by the worker that completed it.',
  schema: z.object({ jobId: z.uuid(), attempt: z.int(), workerId: z.string() }),
});

const pool = createPool({ databaseUrl, applicationName: `drill-${workerId}`, max: 4 });
const db = platformExecutor(createDatabase(pool));

const longJob = defineJob('drill.long_job', async (_payload, context) => {
  say({ drill: 'claimed', jobId: context.id, attempt: context.attempt });

  if (blockMs > 0) {
    // The victim never comes back from here. It is SIGKILLed mid-await, which
    // leaves `jobs.status = 'running'`, `locked_by` set to this worker, and a
    // heartbeat that simply stops — the exact state a `docker kill` produces.
    await new Promise((resolve) => setTimeout(resolve, blockMs));
  }

  await db.transaction(async (tx) => {
    await appendEvent(
      tx,
      DrillWorkCompleted.create(
        { jobId: context.id, attempt: context.attempt, workerId },
        { userId: context.userId, correlationId: context.correlationId, aggregateId: context.id },
        systemClock,
      ),
    );
  });

  say({ drill: 'completed', jobId: context.id, attempt: context.attempt });
});

const runner = createJobRunner({
  pool,
  db,
  handlers: [longJob],
  workerId,
  logger,
  concurrency: 1,
  // Tight, because a drill that takes ninety seconds does not get run. The
  // ratios are production's: the reaper waits several heartbeats before it
  // decides a worker is gone, so a slow query is never mistaken for a corpse.
  pollIntervalMs: 250,
  heartbeatIntervalMs: Math.max(200, Math.floor(reclaimAfterMs / 4)),
  reclaimAfterMs,
  shutdownGraceMs: 2_000,
});

await runner.start();
say({ drill: 'started' });

let stopping = false;
const shutdown = async (signal: string): Promise<void> => {
  if (stopping) return;
  stopping = true;
  say({ drill: 'stopping', signal });
  await runner.stop();
  await pool.end();
  say({ drill: 'stopped' });
  process.exit(0);
};

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
