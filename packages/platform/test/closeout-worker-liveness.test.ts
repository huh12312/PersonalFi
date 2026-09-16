// SPDX-License-Identifier: MIT
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mutableClock } from '@core/kernel';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLivenessWriter } from '../src/liveness.ts';
import { createJobRunner, defineJob } from '../src/jobs/runner.ts';
import { createScheduler } from '../src/jobs/scheduler.ts';
import { ADMIN_URL, createTestDatabase, waitFor, type TestDatabase } from './harness.ts';

/**
 * Closeout evidence for D-3 (gate-security-review.md §8.5 N-4/N-6, §8.11
 * D-3): "give the worker a healthcheck that can fail."
 *
 * Three layers, each proven separately:
 *
 *   1. `createLivenessWriter` itself: `touch()` writes the clock's current
 *      time, atomically, and a fresh read reflects the latest touch.
 *   2. The wiring: `createJobRunner`'s `onPoll` and `createScheduler`'s
 *      `onTick` actually call back into a `LivenessWriter`, on every pass,
 *      against a real Postgres — and, sabotaged the way N-4 sabotaged the
 *      real worker (the loop stops), the heartbeat stops moving. A
 *      healthcheck reading that file's age would go unhealthy exactly where
 *      the old `node -e 'process.exit(0)'` check kept reporting `healthy`
 *      through 189 restarts.
 *   3. The healthcheck script committed in `compose.yml` itself — not a
 *      reimplementation of it, the literal string `docker compose config`
 *      renders for the `worker` service — evaluated directly against
 *      synthetic heartbeat files: fresh -> 0, stale -> 1, missing -> 1, the
 *      documented idle exception -> 0.
 */

const describeWithDb = ADMIN_URL === undefined ? describe.skip : describe;

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

function hasDocker(): boolean {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const describeWithDocker = hasDocker() ? describe : describe.skip;

describe('createLivenessWriter', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'liveness-writer-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the clock time to <dir>/<component>.heartbeat', () => {
    const clock = mutableClock('2026-01-01T00:00:00Z');
    const liveness = createLivenessWriter({ dir, clock });

    liveness.touch('job-runner');

    const content = readFileSync(join(dir, 'job-runner.heartbeat'), 'utf8');
    expect(Number(content)).toBe(clock.nowMs());
  });

  it('refreshes on every touch, and a stopped clock leaves the last value in place', () => {
    const clock = mutableClock('2026-01-01T00:00:00Z');
    const liveness = createLivenessWriter({ dir, clock });

    liveness.touch('scheduler');
    const first = readFileSync(join(dir, 'scheduler.heartbeat'), 'utf8');

    clock.setTo('2026-01-01T00:00:05Z');
    liveness.touch('scheduler');
    const second = readFileSync(join(dir, 'scheduler.heartbeat'), 'utf8');
    expect(second).not.toBe(first);
    expect(Number(second)).toBe(clock.nowMs());

    // Sabotage: nothing calls touch() again — this is what "the runner
    // stopped" looks like from the healthcheck's side. The file does not
    // move, which is the entire mechanism a staleness check relies on.
    const stillSecond = readFileSync(join(dir, 'scheduler.heartbeat'), 'utf8');
    expect(stillSecond).toBe(second);
  });

  it('creates the directory itself, and different components get independent files', () => {
    const nested = join(dir, 'nested');
    const liveness = createLivenessWriter({ dir: nested });

    liveness.touch('job-runner');
    liveness.touch('scheduler');
    liveness.touch('idle');

    expect(existsSync(join(nested, 'job-runner.heartbeat'))).toBe(true);
    expect(existsSync(join(nested, 'scheduler.heartbeat'))).toBe(true);
    expect(existsSync(join(nested, 'idle.heartbeat'))).toBe(true);
  });
});

describeWithDb('worker liveness wiring (D-3)', () => {
  let database: TestDatabase;
  let dir: string;

  beforeAll(async () => {
    database = await createTestDatabase('personalfi_closeout_liveness');
  }, 60_000);

  afterAll(async () => {
    await database.drop();
  }, 30_000);

  beforeEach(async () => {
    await database.truncate();
    dir = mkdtempSync(join(tmpdir(), 'closeout-liveness-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('the job runner touches its heartbeat on every poll, and sabotage (stop()) freezes it', async () => {
    const liveness = createLivenessWriter({ dir });
    const runner = createJobRunner({
      pool: database.pool,
      db: database.db,
      handlers: [defineJob('closeout.noop', () => undefined)],
      pollIntervalMs: 50,
      onPoll: () => liveness.touch('job-runner'),
    });

    const heartbeatPath = join(dir, 'job-runner.heartbeat');
    await runner.start();
    try {
      await waitFor(() => existsSync(heartbeatPath), { what: 'the first job-runner heartbeat' });
      const first = readFileSync(heartbeatPath, 'utf8');
      // Two more polls happen well within 500ms at a 50ms interval; this is
      // the "refreshed on each poll" half of the condition, proven against
      // the real runner rather than a mock of it.
      await waitFor(() => readFileSync(heartbeatPath, 'utf8') !== first, {
        what: 'a later job-runner heartbeat',
        timeoutMs: 2_000,
      });
    } finally {
      await runner.stop();
    }

    // Sabotage: the runner has stopped, exactly as N-4's dead loop did. The
    // heartbeat must not keep moving on its own — if it did, a healthcheck
    // reading it would still report healthy through a dead runner, which is
    // the precise defect D-3 exists to close.
    const atStop = readFileSync(heartbeatPath, 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 250)); // 5x the poll interval
    const afterWaiting = readFileSync(heartbeatPath, 'utf8');
    expect(afterWaiting).toBe(atStop);
  }, 15_000);

  it('the scheduler touches its heartbeat on every tick, and sabotage (stop()) freezes it', async () => {
    const liveness = createLivenessWriter({ dir });
    const scheduler = createScheduler({
      pool: database.pool,
      db: database.db,
      tickIntervalMs: 50,
      onTick: () => liveness.touch('scheduler'),
    });

    const heartbeatPath = join(dir, 'scheduler.heartbeat');
    await scheduler.start();
    try {
      await waitFor(() => existsSync(heartbeatPath), { what: 'the first scheduler heartbeat' });
      const first = readFileSync(heartbeatPath, 'utf8');
      await waitFor(() => readFileSync(heartbeatPath, 'utf8') !== first, {
        what: 'a later scheduler heartbeat',
        timeoutMs: 2_000,
      });
    } finally {
      await scheduler.stop();
    }

    const atStop = readFileSync(heartbeatPath, 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 250));
    const afterWaiting = readFileSync(heartbeatPath, 'utf8');
    expect(afterWaiting).toBe(atStop);
  }, 15_000);
});

describeWithDocker('worker healthcheck script, as compose.yml actually renders it', () => {
  let script: string;
  const dir = '/tmp/liveness';

  beforeAll(() => {
    // Not a reimplementation: this is the literal `test` array `docker
    // compose config` produces for the `worker` service, the same rendering
    // scripts/compose-hardening-check.sh and scripts/check-secret-ownership.sh
    // already assert against. If compose.yml's script drifts from what this
    // test exercises, this test is exercising the wrong thing on its own —
    // there is no second copy of the logic to fall out of step with it.
    const json: { services: Record<string, { healthcheck?: { test?: string[] } }> } = JSON.parse(
      execFileSync('docker', ['compose', '-f', 'compose.yml', 'config', '--format', 'json'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      }),
    );
    const test = json.services['worker']?.healthcheck?.test;
    expect(test?.[0]).toBe('CMD');
    expect(test?.[1]).toBe('node');
    expect(test?.[2]).toBe('-e');
    const candidate = test?.[3];
    if (candidate === undefined)
      throw new Error('worker healthcheck has no node -e script to test');
    script = candidate;
  });

  beforeEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function run(env: Record<string, string> = {}): { status: number; stderr: string } {
    try {
      execFileSync('node', ['-e', script], {
        env: { ...process.env, ...env },
        stdio: ['ignore', 'ignore', 'pipe'],
        encoding: 'utf8',
      });
      return { status: 0, stderr: '' };
    } catch (error) {
      const failure = error as { status?: number | null; stderr?: string };
      return { status: failure.status ?? 1, stderr: failure.stderr ?? '' };
    }
  }

  it('fails (non-zero) when no heartbeat file exists at all', () => {
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/job-runner heartbeat missing or stale/);
  });

  it('passes when the documented idle exception applies (fresh install, nobody enrolled yet)', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'idle.heartbeat'), String(Date.now()));
    expect(run().status).toBe(0);
  });

  /**
   * This is the case a real re-gate walk found missing (see
   * docs/evidence/phase-1/closeout-ops.md): the first cut of this script
   * asked only "does idle.heartbeat exist", so a worker that reached idle
   * (a freshly migrated database, before the first passkey is enrolled — the
   * state every real deployment starts in) and then hung or was frozen
   * (`kill -STOP`) reported `healthy` forever off the single heartbeat
   * `apps/api/src/worker.ts` wrote at boot. `worker.ts` now re-touches
   * `idle.heartbeat` on the job runner's own poll cadence for as long as it
   * stays idle; this holds that heartbeat to the same staleness bar as the
   * other two.
   */
  it('sabotage: an idle heartbeat that stopped moving (the idle worker hung) goes red', () => {
    mkdirSync(dir, { recursive: true });
    const stale = String(Date.now() - 100_000);
    writeFileSync(join(dir, 'idle.heartbeat'), stale);

    const sabotaged = run({ JOB_POLL_INTERVAL_MS: '5000', SCHEDULER_INTERVAL_MS: '30000' });
    expect(sabotaged.status).not.toBe(0);
    expect(sabotaged.stderr).toMatch(/idle heartbeat missing or stale/);

    // Restore: the idle loop resumes touching it, and the same check goes
    // green again with no other state change.
    writeFileSync(join(dir, 'idle.heartbeat'), String(Date.now()));
    const restored = run({ JOB_POLL_INTERVAL_MS: '5000', SCHEDULER_INTERVAL_MS: '30000' });
    expect(restored.status).toBe(0);
  });

  it('passes when both heartbeats are fresh', () => {
    mkdirSync(dir, { recursive: true });
    const now = String(Date.now());
    writeFileSync(join(dir, 'job-runner.heartbeat'), now);
    writeFileSync(join(dir, 'scheduler.heartbeat'), now);
    expect(run({ JOB_POLL_INTERVAL_MS: '5000', SCHEDULER_INTERVAL_MS: '30000' }).status).toBe(0);
  });

  it('sabotage: a job-runner heartbeat stopped 100s ago (poll interval 5s) goes red', () => {
    mkdirSync(dir, { recursive: true });
    const stale = String(Date.now() - 100_000);
    writeFileSync(join(dir, 'job-runner.heartbeat'), stale);
    writeFileSync(join(dir, 'scheduler.heartbeat'), String(Date.now()));

    const sabotaged = run({ JOB_POLL_INTERVAL_MS: '5000', SCHEDULER_INTERVAL_MS: '30000' });
    expect(sabotaged.status).not.toBe(0);
    expect(sabotaged.stderr).toMatch(/job-runner heartbeat missing or stale/);

    // Restore: the runner resumes touching it, and the same check goes green
    // again with no other state change — proving this is a live freshness
    // check, not a latch that stays tripped.
    writeFileSync(join(dir, 'job-runner.heartbeat'), String(Date.now()));
    const restored = run({ JOB_POLL_INTERVAL_MS: '5000', SCHEDULER_INTERVAL_MS: '30000' });
    expect(restored.status).toBe(0);
  });

  it('sabotage: a scheduler heartbeat stopped ticking (tick interval 30s, 10 minutes stale) goes red', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'job-runner.heartbeat'), String(Date.now()));
    writeFileSync(join(dir, 'scheduler.heartbeat'), String(Date.now() - 600_000));

    const sabotaged = run({ JOB_POLL_INTERVAL_MS: '5000', SCHEDULER_INTERVAL_MS: '30000' });
    expect(sabotaged.status).not.toBe(0);
    expect(sabotaged.stderr).toMatch(/scheduler heartbeat missing or stale/);

    writeFileSync(join(dir, 'scheduler.heartbeat'), String(Date.now()));
    const restored = run({ JOB_POLL_INTERVAL_MS: '5000', SCHEDULER_INTERVAL_MS: '30000' });
    expect(restored.status).toBe(0);
  });
});
