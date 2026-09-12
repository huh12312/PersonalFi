# WP 0.3 evidence — the killed-and-restarted worker drill

**Phase 0 exit criterion** (master plan §5): _"a worker killed mid-job is
restarted and the job completes exactly once."_

Run it with `just db-up && just drill-worker-restart`. The drill lives at
`packages/platform/test/worker-restart.test.ts`; the worker it spawns is
`packages/platform/test/fixtures/drill-worker.ts`.

## What is actually being tested, and why it needs two processes

A queue claimed with `FOR UPDATE SKIP LOCKED` survives `SIGTERM` perfectly and
fails the only case that matters. The OOM killer, a yanked power cord and
`docker kill` all leave the row `running`, `locked_by` pointing at a process that
no longer exists, and no error anywhere — so the nightly sync stops happening and
nothing says so. The heartbeat and the reaper exist for exactly that case, and
they can only be exercised by killing something for real.

So the drill spawns two real Node processes against a scratch database and sends
one of them `SIGKILL`. Nothing in the victim runs on the way out: no `finally`,
no `stop()`, no status update. Everything after the kill is the survivor's
unaided work, coordinated through nothing but the `jobs` table and an advisory
lock.

Both processes run the same fixture with the same handler and the same runner
settings. The only difference is `DRILL_BLOCK_MS`: the victim stalls for an hour
inside the handler and never reaches its effect; the survivor finishes at once.
The order is decided rather than raced — the victim starts alone and the job is
enqueued only once it is listening — because a drill whose premise is a coin toss
reports a green tick about half the time it should not.

Timings are tightened to keep the drill under ten seconds (`reclaimAfterMs` 2 s,
heartbeat 500 ms), but the _ratios_ are production's: the reaper still waits
several heartbeats before deciding a worker is dead, so a slow query is never
mistaken for a corpse.

## Transcript

`just drill-worker-restart`, 2026-09-12, node v26.8.1, Postgres 18 on
127.0.0.1:5433:

```
pnpm exec vitest run worker-restart --project platform-db --reporter=verbose --disable-console-intercept=true

 RUN  v5.0.0 /home/chris/Projects/PersonalFi

--- worker restart drill ---
  {"worker":"drill-victim","level":"info","msg":"job runner started","workerId":"drill-victim","kinds":["drill.long_job"],"concurrency":1}
  {"worker":"drill-victim","drill":"started"}
enqueued job 01a095b5-8ff9-7562-a31e-3f5aa65586f4
  {"worker":"drill-victim","drill":"claimed","jobId":"01a095b5-8ff9-7562-a31e-3f5aa65586f4","attempt":1}
  {"worker":"drill-survivor","level":"info","msg":"job runner started","workerId":"drill-survivor","kinds":["drill.long_job"],"concurrency":1}
  {"worker":"drill-survivor","drill":"started"}
SIGKILL -> drill-victim
victim exited signal=SIGKILL code=null
  {"worker":"drill-survivor","level":"warn","msg":"reclaimed jobs abandoned by a dead worker","count":1}
  {"worker":"drill-survivor","drill":"claimed","jobId":"01a095b5-8ff9-7562-a31e-3f5aa65586f4","attempt":2}
  {"worker":"drill-survivor","drill":"completed","jobId":"01a095b5-8ff9-7562-a31e-3f5aa65586f4","attempt":2}
job 01a095b5-8ff9-7562-a31e-3f5aa65586f4: attempt 1 abandoned (drill-victim), attempt 2 succeeded (drill-survivor), 1 drill.WorkCompleted event
SIGTERM -> drill-survivor
  {"worker":"drill-survivor","drill":"stopping","signal":"SIGTERM"}
  {"worker":"drill-survivor","level":"info","msg":"job runner stopped","workerId":"drill-survivor"}
  {"worker":"drill-survivor","drill":"stopped"}
--- drill complete ---
 ✓ |platform-db| test/worker-restart.test.ts > worker restart drill > reaps a SIGKILLed worker’s claim and completes the job exactly once 4585ms

 Test Files  1 passed (1)
      Tests  1 passed (1)
   Duration  6.27s
```

## The assertions behind those lines

| Claim                                     | How it is checked                                                                                                       |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Only one worker holds the job             | Before the kill: `jobs.status = 'running'`, `locked_by = 'drill-victim'`, and the survivor has logged no `claimed` line |
| The victim really died                    | `child.kill('SIGKILL')`, then the exit event reports `signal = SIGKILL`                                                 |
| The stale claim is reaped, not waited out | `jobs.status` returns to `succeeded` via attempt 2; `locked_by` and `heartbeat_at` are both `NULL` at the end           |
| The lost attempt is recorded, not erased  | `job_runs` is exactly `[(1, drill-victim, abandoned), (2, drill-survivor, succeeded)]`                                  |
| **Exactly once**                          | One `drill.WorkCompleted` row in `domain_events`, written by `drill-survivor`                                           |
| The survivor still stops cleanly          | `SIGTERM` → `job runner stopped` → exit code 0                                                                          |

"Exactly once" is asserted against the event rather than against `job_runs`,
because a run row is bookkeeping the platform writes about itself and an event is
the work. The victim died before its effect, so the effect happened once for a
job that two workers held.

The abandoned attempt is kept on purpose. "This job has been killed by the OOM
killer four nights running" is the single most useful thing the job history can
tell an operator, and it is only knowable from `job_runs`.

## Shutdown latency, measured

The drill also covers the _other_ half of the story, and finding it is why
`packages/platform/src/sleep.ts` exists. Before that change, `runner.stop()`
inherited the reaper's sleep as a floor: at the shipped defaults
(`JOB_HEARTBEAT_INTERVAL_MS=15000`, so `reclaimAfterMs = 45 s`, so a 22.5 s
reaper interval) a worker took **17.5 s** to answer SIGTERM. Docker's default
`docker stop` grace is ten seconds, so every deploy would have ended in SIGKILL —
i.e. this drill's scenario would have described every restart, not just a crash.

Measured on the worker process, same machine, default intervals:

|                               | before | after |
| ----------------------------- | ------ | ----- |
| SIGTERM → `shutdown complete` | 17.5 s | 6 ms  |

See `wp0.3-platform-tests.md` for the worker boot/shutdown transcript.
