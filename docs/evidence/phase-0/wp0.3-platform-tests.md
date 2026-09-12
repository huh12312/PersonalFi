# WP 0.3 evidence — platform test run, worker boot, and `/ready`

`@core/platform` is the substrate for decision **D7** (the `domain_events`
transactional outbox, from Phase 0, before any consumer exists). This file
records the final state of its suites and the two manual checks that a test
cannot make for itself: that the worker process actually boots and stops, and
that `/ready` reports what the pump and the queue are doing.

Environment: node v26.8.1, Postgres 18.6 on 127.0.0.1:5433, vitest 5.0.0.

## Test counts

```
DATABASE_URL='postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_wp03' \
  pnpm exec vitest run --project platform --project platform-db

 Test Files  9 passed (9)
      Tests  86 passed (86)
   Duration  19.20s
```

| Project       | File                          | Tests |
| ------------- | ----------------------------- | ----- |
| `platform`    | `src/backoff.test.ts`         | 9     |
| `platform`    | `src/events/registry.test.ts` | 10    |
| `platform`    | `src/units.test.ts`           | 13    |
| `platform-db` | `test/outbox.test.ts`         | 8     |
| `platform-db` | `test/pump.test.ts`           | 12    |
| `platform-db` | `test/jobs.test.ts`           | 15    |
| `platform-db` | `test/scheduler.test.ts`      | 8     |
| `platform-db` | `test/flags-config.test.ts`   | 10    |
| `platform-db` | `test/worker-restart.test.ts` | 1     |

With `DATABASE_URL` unset the same command is `3 passed | 6 skipped (9)` files,
`32 passed | 54 skipped (86)` tests — `pnpm test` still works on a laptop with
nothing running, which is the property `vitest.config.ts` promises.

`test/worker-restart.test.ts` is the Phase 0 exit-criterion drill; it has its own
file, [wp0.3-worker-restart-drill.md](wp0.3-worker-restart-drill.md).

## What was wrong, and why 28 of these used to fail

Three root causes, all of them silent rather than loud, which is the reason they
are written down here.

**1. Drizzle hands back `TIMESTAMPTZ` as a string.** `@core/db` deliberately
leaves node-postgres's `timestamptz` parser alone — a genuine instant should
arrive as a `Date` — and that holds for every query issued through the driver. It
does not hold for a query issued through Drizzle: `drizzle-orm/node-postgres`
builds its query config with its own type map, which returns the raw string for
`TIMESTAMPTZ`, `TIMESTAMP`, `DATE` and `INTERVAL`, because the ORM layer maps
those columns itself. A hand-written raw-SQL `execute()` has no column metadata
to map with, so `row.next_run_at` came back as the string
`'2026-03-02 08:15:00+00'`.

The failure mode was the instructive part. `firedFor.toISOString()` threw a
`TypeError` inside the scheduler's per-row `try`, which logged "schedule failed
to fire; the others are unaffected" and moved on — so the symptom was _nothing
happening_, not an error. In the pump the same call was inside the handler's
transaction, so every event rolled back after its handler had run and the pump
re-delivered forever, masked by the `processed_events` receipts.

Fixed at the row boundary in `packages/platform/src/instants.ts` (`toInstant`,
`toInstantOrNull`), which reuses the driver's own parser rather than a
hand-rolled one.

**2. The consumer offset row was not guaranteed to exist.** `ensureOffsetRow`
was called from the pump's loop and from `runConsumerOnce`, but not from
`drain()`. Advancing the offset and counting a failure are both
`UPDATE … WHERE consumer_name = $1`; against a missing row they match nothing and
report success. The consumer then re-read the same events forever and a poison
event never reached `maxAttempts`, so it never dead-lettered either. `readOffset`
now creates the row on a miss — one indexed `SELECT` on the hot path, and every
write downstream has its precondition.

**3. Loop sleeps were not interruptible, so `stop()` inherited the longest
interval as a floor.** At the shipped defaults that is 22.5 s for the job
reaper and 30 s for the scheduler tick; measured worker shutdown was 17.5 s
against Docker's ten-second `docker stop` grace. `packages/platform/src/sleep.ts`
registers pending sleeps so `stop()` can resolve them all at once. Shutdown is
now 6 ms, and the two graceful-shutdown tests in `test/jobs.test.ts` dropped from
22.5 s each to under a second, which is why the whole suite went from 56 s to
19 s.

Two smaller fixes: the reaper loop now catches its own errors including the lease
acquisition, so a pool closing underneath a still-`running` loop cannot become an
unhandled rejection during shutdown; and `test/harness.ts` bounds `pool.end()`,
so a test that failed before releasing an advisory lease reports its assertion
instead of a hook timeout.

## The worker boots, runs all three loops, and stops on SIGTERM

`ROLE=worker node apps/api/src/worker.ts` against `personalfi_wp03`, SIGTERM
after ~5 s. `MODULES` is empty in Phase 0 — there are no contexts yet — so this
transcript was taken with one synthetic module registered temporarily (a
no-op consumer, a no-op job handler, and one schedule) to exercise the wiring
that Phase 1 will use. The `configuration loaded` line is elided for width.

```
{"level":"info","service":"worker","enabled":["module.drill"],"disabled":[],"msg":"modules resolved"}
{"level":"info","service":"worker","consumers":["drill.smoke@v1"],"msg":"consumer pump started"}
{"level":"info","service":"worker","workerId":"01a095af-a3c1-7234-8517-5abf9dee2c74","kinds":["drill.smoke"],"concurrency":4,"msg":"job runner started"}
{"level":"info","service":"worker","tickIntervalMs":30000,"msg":"scheduler started"}
{"level":"info","service":"worker","msg":"scheduler leadership acquired"}
{"level":"info","service":"worker","outboxLag":0,"queuePending":0,"queueDead":0,"msg":"worker ready"}
{"level":"info","service":"worker","time":"...15.916Z","signal":"SIGTERM","msg":"shutting down"}
{"level":"info","service":"worker","time":"...15.917Z","msg":"scheduler stopped"}
{"level":"info","service":"worker","time":"...15.919Z","msg":"consumer pump stopped"}
{"level":"info","service":"worker","time":"...15.921Z","workerId":"01a095af-...","msg":"job runner stopped"}
{"level":"info","service":"worker","time":"...15.922Z","msg":"shutdown complete"}
exit code 0
```

Note the shutdown order — scheduler, then pump, then runner — and that it is not
arbitrary: stop _creating_ work, then stop _taking_ work, then wait for the one
component with work in its hands. Six milliseconds end to end, at the default
30 s scheduler tick and 45 s reclaim window.

With `MODULES` empty, as it ships today, the same run logs:

```
{"level":"info","service":"worker","enabled":[],"disabled":[],"msg":"modules resolved"}
{"level":"info","service":"worker","msg":"no enabled module registered a consumer; the event pump is not running"}
{"level":"info","service":"worker","msg":"no enabled module registered a job handler; the job runner is not running"}
{"level":"info","service":"worker","tickIntervalMs":30000,"msg":"scheduler started"}
```

Those two lines were added in this work package. "The pump is not running" is a
five-second diagnosis from a log line and a very long one from an outbox that is
quietly not draining.

## `/ready` reports outbox and queue health

`GET /ready` against the same database, with one stalled job (a `running` row
whose heartbeat is ten minutes old) and one dead-lettered consumer seeded by
hand:

```json
{
  "status": "degraded",
  "database": "reachable",
  "migrations": "current",
  "outbox": {
    "maxSeq": "0",
    "maxLagEvents": 0,
    "oldestUnprocessedAgeSeconds": null,
    "failedConsumers": ["drill.smoke@v1"]
  },
  "queue": {
    "pending": 0,
    "running": 1,
    "dead": 0,
    "stalled": 1,
    "oldestPendingAgeSeconds": null
  },
  "degradedReasons": [
    "consumer(s) stopped at an event they cannot handle: drill.smoke@v1",
    "1 job(s) have a stale heartbeat; is a worker running?"
  ]
}
HTTP 200
```

and once both are cleared:

```json
{
  "status": "ready",
  "database": "reachable",
  "migrations": "current",
  "outbox": { "maxSeq": "0", "maxLagEvents": 0, "oldestUnprocessedAgeSeconds": null, "failedConsumers": [] },
  "queue": { "pending": 0, "running": 0, "dead": 0, "stalled": 0, "oldestPendingAgeSeconds": null }
}
HTTP 200
```

**`degraded` is HTTP 200 on purpose.** A stuck consumer or a dead job is a
_worker_ problem, and the API is how the operator finds out about it. An API that
takes itself out of rotation because the pump is behind hides the maintenance
page behind the very failure it exists to report. The hard 503 stays reserved for
the two conditions under which serving would be wrong — the database is
unreachable, or the schema does not match the code.
`READINESS_FAIL_ON_DEGRADED=true` is there for a deployment that would rather
hold a rollout than serve degraded.

## Checks

```
pnpm typecheck                                     clean for packages/platform and apps/api/src/{worker,platform,routes/health}.ts
pnpm exec eslint packages/platform apps/api/src/worker.ts \
  apps/api/src/platform.ts apps/api/src/routes/health.ts   clean
pnpm exec prettier --check packages/platform       clean
node scripts/check-schema-ownership.ts             ok — 95 tables claimed across 14 packages, 20 defined
```
