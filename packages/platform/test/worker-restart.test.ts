// SPDX-License-Identifier: MIT
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { once } from 'node:events';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { newId } from '@core/kernel';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enqueueJob } from '../src/jobs/queue.ts';
import { ADMIN_URL, createTestDatabase, waitFor, type TestDatabase } from './harness.ts';

/**
 * Phase 0 exit criterion: kill a worker mid-job and prove the restart resumes it.
 *
 * The claim under test is the one that decides whether unattended operation is
 * real. A queue claimed with `FOR UPDATE SKIP LOCKED` and no heartbeat survives a
 * clean `SIGTERM` perfectly and fails the only case that matters: the OOM killer,
 * a yanked power cord, `docker kill`. There the row stays `running`, `locked_by`
 * points at a process that no longer exists, and the nightly sync never happens
 * again — silently, because nothing is in a failed state to report.
 *
 * So this drill uses a real second process and a real `SIGKILL`. Nothing in the
 * victim gets to run on the way out: no `finally`, no `stop()`, no status update.
 * What has to happen next is entirely the survivor's problem, and it has to
 * happen with no coordination beyond the `jobs` table and an advisory lock:
 *
 *   1. the survivor notices the stale heartbeat and returns the job to `pending`,
 *      recording the lost attempt as `abandoned` rather than erasing it;
 *   2. it claims the job as attempt 2 and runs it to completion;
 *   3. the work happens **exactly once** — one `drill.WorkCompleted` event for a
 *      job that two workers held, because the victim died before its effect.
 *
 * The transcript goes to stdout so `just drill-worker-restart` produces the
 * evidence file rather than a bare "ok".
 */

const describeWithDb = ADMIN_URL === undefined ? describe.skip : describe;

const FIXTURE = fileURLToPath(new URL('./fixtures/drill-worker.ts', import.meta.url));
const RECLAIM_AFTER_MS = 2_000;

interface DrillWorker {
  readonly name: string;
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly lines: Record<string, unknown>[];
  saw(predicate: (line: Record<string, unknown>) => boolean): boolean;
  await(what: string, predicate: (line: Record<string, unknown>) => boolean): Promise<void>;
  exited(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const transcript: string[] = [];

function record(text: string): void {
  transcript.push(text);
  console.log(text);
}

function startWorker(name: string, databaseUrl: string, blockMs: number): DrillWorker {
  const child = spawn(process.execPath, [FIXTURE], {
    env: {
      ...process.env,
      DRILL_DATABASE_URL: databaseUrl,
      DRILL_WORKER_ID: name,
      DRILL_BLOCK_MS: String(blockMs),
      DRILL_RECLAIM_MS: String(RECLAIM_AFTER_MS),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const lines: Record<string, unknown>[] = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const text = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
      if (text === '') continue;
      record(`  ${text}`);
      try {
        lines.push(JSON.parse(text) as Record<string, unknown>);
      } catch {
        // Not every line is ours; a Node warning on stdout is not a failure.
      }
    }
  });
  // Node's type-stripping notice and any stack trace land here. Keep them in the
  // transcript: a drill that fails is far easier to read with them than without.
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    for (const text of chunk.split('\n')) if (text.trim() !== '') record(`  [${name}] ${text}`);
  });

  const saw = (predicate: (line: Record<string, unknown>) => boolean): boolean =>
    lines.some(predicate);

  return {
    name,
    child,
    lines,
    saw,
    async await(what, predicate) {
      await waitFor(() => saw(predicate), { timeoutMs: 30_000, intervalMs: 25, what });
    },
    async exited() {
      if (child.exitCode !== null || child.signalCode !== null) {
        return { code: child.exitCode, signal: child.signalCode };
      }
      const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
      return { code, signal };
    },
  };
}

const isClaim = (line: Record<string, unknown>): boolean => line['drill'] === 'claimed';

describeWithDb('worker restart drill', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase('personalfi_wp03_drill');
  }, 60_000);

  afterAll(async () => {
    await database.drop();
  }, 30_000);

  it('reaps a SIGKILLed worker’s claim and completes the job exactly once', async () => {
    record('--- worker restart drill ---');

    // The victim starts alone and the job is enqueued only once it is
    // listening, so which worker takes it is decided rather than raced. Two
    // workers started together is a coin toss, and a drill whose premise is a
    // coin toss reports a green tick roughly half the time it should not.
    const victim = startWorker('drill-victim', database.url, 3_600_000);
    let survivor: DrillWorker | undefined;

    try {
      await victim.await('the victim to start', (line) => line['drill'] === 'started');

      const { id: jobId } = await enqueueJob(database.db, {
        userId: database.userId,
        kind: 'drill.long_job',
        payload: { note: 'synthetic long-running work' },
        maxAttempts: 3,
        correlationId: newId(),
      });
      record(`enqueued job ${jobId}`);

      await victim.await('the victim to claim the job', isClaim);
      survivor = startWorker('drill-survivor', database.url, 0);
      await survivor.await('the survivor to start', (line) => line['drill'] === 'started');

      // Both workers are up and only one holds the job: SKIP LOCKED plus the
      // `running` status is what keeps the survivor's claim query empty while
      // the victim is alive. Without this the rest of the drill would prove
      // nothing, because the job could simply have been run twice in parallel.
      const beforeKill = await database.db.execute<{ status: string; locked_by: string }>(
        sql`SELECT status, locked_by FROM jobs WHERE id = ${jobId}::uuid`,
      );
      expect(beforeKill.rows[0]?.status).toBe('running');
      expect(beforeKill.rows[0]?.locked_by).toBe('drill-victim');
      expect(survivor.saw(isClaim)).toBe(false);

      record('SIGKILL -> drill-victim');
      victim.child.kill('SIGKILL');
      const died = await victim.exited();
      expect(died.signal).toBe('SIGKILL');
      record(`victim exited signal=${String(died.signal)} code=${String(died.code)}`);

      await survivor.await('the survivor to reclaim and finish the job', (line) => {
        return line['drill'] === 'completed';
      });

      await waitFor(
        async () => {
          const row = await database.db.execute<{ status: string }>(
            sql`SELECT status FROM jobs WHERE id = ${jobId}::uuid`,
          );
          return row.rows[0]?.status === 'succeeded';
        },
        { timeoutMs: 15_000, what: 'the job row to reach succeeded' },
      );

      const job = await database.db.execute<{
        status: string;
        attempts: number;
        locked_by: string | null;
        heartbeat_at: unknown;
      }>(sql`SELECT status, attempts, locked_by, heartbeat_at FROM jobs WHERE id = ${jobId}::uuid`);
      expect(job.rows[0]?.status).toBe('succeeded');
      expect(job.rows[0]?.attempts).toBe(2);
      // The lock is surrendered, not merely stale: nothing has to time out
      // before this row is claimable again.
      expect(job.rows[0]?.locked_by).toBeNull();
      expect(job.rows[0]?.heartbeat_at).toBeNull();

      // The lost attempt is recorded rather than erased. "This job has been
      // killed four nights running" is the single most useful thing the job
      // history can tell an operator, and it is only knowable from here.
      const runs = await database.db.execute<{
        attempt: number;
        worker_id: string;
        outcome: string;
      }>(sql`
          SELECT attempt, worker_id, outcome FROM job_runs
          WHERE job_id = ${jobId}::uuid ORDER BY attempt
        `);
      expect(runs.rows.map((row) => [row.attempt, row.worker_id, row.outcome])).toEqual([
        [1, 'drill-victim', 'abandoned'],
        [2, 'drill-survivor', 'succeeded'],
      ]);

      // Exactly once. Two workers held this job; its effect happened one time.
      const events = await database.db.execute<{ payload: { workerId: string } }>(sql`
          SELECT payload FROM domain_events WHERE event_type = 'drill.WorkCompleted'
        `);
      expect(events.rows).toHaveLength(1);
      expect(events.rows[0]?.payload.workerId).toBe('drill-survivor');

      record(
        `job ${jobId}: attempt 1 abandoned (drill-victim), attempt 2 succeeded (drill-survivor), ` +
          '1 drill.WorkCompleted event',
      );

      // And the other half of the story: the survivor still shuts down cleanly.
      record('SIGTERM -> drill-survivor');
      survivor.child.kill('SIGTERM');
      const stopped = await survivor.exited();
      expect(stopped.code).toBe(0);
      expect(survivor.saw((line) => line['drill'] === 'stopped')).toBe(true);
      record('--- drill complete ---');
    } finally {
      for (const worker of [victim, survivor]) {
        if (worker === undefined) continue;
        if (worker.child.exitCode === null && worker.child.signalCode === null) {
          worker.child.kill('SIGKILL');
        }
      }
    }
  }, 120_000);
});
