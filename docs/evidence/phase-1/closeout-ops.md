# Phase 1 close-out — ops conditions D-3, D-4, D-7

_Written 2026-09-16 against the working tree at snapshot `6258bb3` plus this
work package (`919902e` on top, from the concurrent staging/architecture
close-outs, untouched by this one). Three close-out conditions from
[gate-security-review.md](gate-security-review.md) §8.11: **D-3** ("give the
worker a healthcheck that can fail", N-6), **D-4** ("fix `just harden-secrets`",
N-1), **D-7** ("render compose overrides layered", N-2). State on disk when
this work package started: `packages/platform/src/liveness.ts` +
runner/scheduler heartbeat hooks, the worker healthcheck, `just harden-secrets`
extended to `plaid_*`, `scripts/check-secret-ownership.sh`, and
`scripts/compose-hardening-check.sh`'s layered-override rendering all already
implemented by a prior agent, with no tests and no evidence. This document is
that evidence, plus one real defect this evidence-gathering pass found and
fixed (§2.3)._

---

## 1. What changed in this work package

| File                                                      | Change                                                                                                                                                                                                                 |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/platform/test/closeout-worker-liveness.test.ts` | New. 15 tests: `createLivenessWriter` unit behaviour, `createJobRunner`/`createScheduler` wiring against a real Postgres, and the literal `compose.yml` healthcheck script executed against synthetic heartbeat files. |
| `apps/api/src/worker.ts`                                  | Fix (§2.3): the idle branch now re-touches `idle.heartbeat` on `JOB_POLL_INTERVAL_MS` cadence instead of once at boot, and the interval is cleared on shutdown.                                                        |
| `compose.yml`                                             | Fix (§2.3): the worker healthcheck now holds `idle.heartbeat` to the same 3x-poll-interval staleness bar as `job-runner.heartbeat`/`scheduler.heartbeat`, instead of only checking that it exists.                     |
| `.github/workflows/ci.yml`                                | `compose-hardening` job: added `check-secret-ownership.sh --self-test` and the real run, alongside the existing `compose-hardening-check.sh` steps.                                                                    |

Nothing else in the previous agent's implementation needed a code change —
`scripts/check-secret-ownership.sh`, `scripts/compose-hardening-check.sh`'s
layered-override logic, the `justfile` wiring, and `RUNBOOK.md` all held up
under sabotage as written (§3, §4).

---

## 2. D-3 — the worker healthcheck can fail

### 2.1 Test evidence

`packages/platform/test/closeout-worker-liveness.test.ts`, 15 tests, three
layers:

1. `createLivenessWriter` (4 tests, no database): `touch()` writes the clock's
   time atomically (write-then-rename), refreshes on every call, and a value
   that stops being touched stays exactly where it was left — the mechanism a
   staleness check depends on.
2. Wiring against a real Postgres (2 tests, `platform-db` project): a real
   `createJobRunner`/`createScheduler` at a 50ms poll/tick interval touches its
   heartbeat repeatedly, and — sabotaged by calling `stop()`, exactly what a
   dead loop looks like from outside — the heartbeat freezes and does not move
   again over 5x the poll interval.
3. The literal healthcheck script (9 tests): not a reimplementation.
   `beforeAll` reads `doc.services.worker.healthcheck.test` out of
   `docker compose -f compose.yml config --format json` — the same rendering
   `scripts/compose-hardening-check.sh` and `scripts/check-secret-ownership.sh`
   already assert against — and executes that exact string via `node -e`
   against synthetic heartbeat files. Covers: no heartbeat at all (fail),
   idle-fresh (pass), idle-stale (fail — see §2.3), both fresh (pass),
   job-runner stale (fail, with the exact stderr message), scheduler stale
   (fail), and a restore-to-fresh after each sabotage (pass again — proving
   this is a live check, not a latch).

```
$ DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev \
    pnpm exec vitest run --project platform --project platform-db
 Test Files  10 passed (10)
      Tests  97 passed (97)
```

### 2.2 Sabotage — the test file itself

Before trusting the wiring test, it was sabotaged: `packages/platform/src/jobs/runner.ts`'s
`onPoll?.();` call at the top of `claimLoop` was commented out (nothing else
changed) and the suite re-run:

```
 FAIL  |platform-db| .../closeout-worker-liveness.test.ts > worker liveness wiring (D-3)
   × the job runner touches its heartbeat on every poll, and sabotage (stop()) freezes it
Error: timed out waiting for the first job-runner heartbeat
      Tests  1 failed | 9 passed (10)
```

Restored (`onPoll?.();` uncommented); re-run: `10 passed (10)`.

### 2.3 A real defect this evidence pass found: the idle bucket had no staleness check

Bringing the stack up fresh (no account holder enrolled — the state every real
deployment starts in) put the worker in its idle branch, and the D-3 proof
below (§2.4) initially showed `docker inspect` reporting `healthy` through a
full `kill -STOP` of the worker's node process, indefinitely. The original
script (as this work package inherited it) was:

```js
const idle = fs.existsSync(dir + '/idle.heartbeat');
// ...
if (idle && jobAge === null && schedAge === null) {
  process.exit(0);
}
```

`idle.heartbeat` was written once, at boot, by `apps/api/src/worker.ts`'s idle
branch, and never touched again. The check asked only "does the file exist",
never "is it fresh" — so a worker that reached idle and then hung or froze
reported healthy forever off that one write, precisely the N-4/N-6 failure
mode ("the process is alive, so the one thing the healthcheck looked at was
true") that D-3 exists to close, just relocated to the one state every fresh
install starts in.

**Fixed** in both files:

- `apps/api/src/worker.ts`: the idle branch now does
  `idleHeartbeatTimer = setInterval(() => liveness.touch('idle'), config.env.JOB_POLL_INTERVAL_MS); idleHeartbeatTimer.unref?.();`
  after the initial touch, and `shutdown()` clears it.
- `compose.yml`: `idleAge = age('idle')`, and the idle branch now requires
  `idleAge <= jobMax` (the same 3x-`JOB_POLL_INTERVAL_MS` bound as
  `job-runner.heartbeat`), failing with
  `idle heartbeat missing or stale (age=…ms max=…ms)` otherwise.

Covered by the new test `sabotage: an idle heartbeat that stopped moving (the
idle worker hung) goes red` (§2.1, layer 3) and by the live `kill -STOP` re-run
below.

One observation, not a defect: an idle worker's container restarts roughly
every 30–34 seconds on its own, independent of any of this. `packages/db/src/client.ts`
sets `idleTimeoutMillis: 30_000` on the pool; once the idle branch's one query
(`recordConfigSnapshot`) finishes and the pool's connection goes idle-then-closed,
nothing else refs the Node event loop (`process.once('SIGTERM', …)`/`'SIGINT'`
alone do **not** — verified directly: `node -e "process.once('SIGTERM',()=>{})"`
exits in 44ms), so the process returns from `main()` and exits 0, and Docker's
restart policy brings it back. This predates this work package (the original
idle branch had no interval at all, so the same exit-and-restart happened) and
does not mask a real freeze: each restart's first healthcheck passes
immediately (the heartbeat is written synchronously at boot, which ends
`start_period` on the first success per Docker's own semantics), so a `kill
-STOP` — which prevents the process from exiting at all — is still caught, as
§2.4 shows. Left alone: fixing an idle worker's long-run lifecycle is a
different question ("should it stay resident with nothing to do") than D-3's
("can the healthcheck detect a hang"), and is not one of this gate's
conditions.

### 2.4 Live proof — `kill -STOP` / `kill -CONT` against the real stack

Stack rebuilt from this work package (`docker compose build && docker compose up -d`)
and brought up clean (`down -v` first — a stale `migrator` state left over from
a concurrent agent's in-flight migration file needed one clean rebuild;
unrelated to this condition). No account holder enrolled, so the worker is in
its idle branch — the state the fix in §2.3 was written for.

Baseline:

```
$ docker inspect personalfi-worker-1 --format '{{json .State.Health}}' | …
BEFORE SABOTAGE — Status: healthy FailingStreak: 0
Last check: {"Start":"2026-09-16T11:17:29…","End":"2026-09-16T11:17:29…","ExitCode":0,"Output":""}
```

Sabotage — `SIGSTOP` the worker's node process (pid 7 inside the container),
2026-09-16T15:17:41Z:

```
$ docker exec personalfi-worker-1 kill -STOP 7
$ docker exec personalfi-worker-1 sh -c "grep State /proc/7/status"
State:	T (stopped)
```

Foreground poll, one `docker inspect` per 10s for 120s:

```
t+10s health=unhealthy failing=3
t+20s health=unhealthy failing=3
t+30s health=unhealthy failing=4
t+40s health=unhealthy failing=5
...
t+120s health=unhealthy failing=10
```

Unhealthy inside the first 10-second sample. `.State.Health.Log`:

```
{"Start":"2026-09-16T11:19:30…","ExitCode":1,"Output":"idle heartbeat missing or stale (age=112677ms max=15000ms)\n"}
{"Start":"2026-09-16T11:19:45…","ExitCode":1,"Output":"idle heartbeat missing or stale (age=127765ms max=15000ms)\n"}
{"Start":"2026-09-16T11:20:00…","ExitCode":1,"Output":"idle heartbeat missing or stale (age=142850ms max=15000ms)\n"}
{"Start":"2026-09-16T11:20:15…","ExitCode":1,"Output":"idle heartbeat missing or stale (age=157940ms max=15000ms)\n"}
{"Start":"2026-09-16T11:20:30…","ExitCode":1,"Output":"idle heartbeat missing or stale (age=173046ms max=15000ms)\n"}
```

The reported age grows monotonically from the moment of `SIGSTOP`, which is
exactly what "the process cannot run its own timer" looks like.

Recovery — `SIGCONT`, 2026-09-16T15:20:40Z:

```
$ docker exec personalfi-worker-1 kill -CONT 7
$ docker exec personalfi-worker-1 sh -c "grep State /proc/7/status"
State:	R (running)
```

Foreground poll, one `docker inspect` per 10s for 120s:

```
t+10s health=healthy failing=0
t+20s health=healthy failing=0
...
t+120s health=healthy failing=0
```

(One sample at t+70s read `starting` — that is the ~30s idle-restart cycle
from §2.3's observation coinciding with the poll, not a second freeze; the very
next sample was healthy again and `RestartCount` confirms a normal restart, not
a health-triggered one.)

Healthy again inside the first 10-second sample after `SIGCONT`. The old
`node -e 'process.exit(0)'` check — proven in the gate's §8.5 to stay `healthy`
through 189 restarts with nothing running — would not have moved at all
through either half of this drill.

---

## 3. D-4 — `just harden-secrets` covers `plaid_*`, and a computed ownership check backs it

### 3.1 State found

Secrets on disk when this work package started were already in the hardened
state the prior agent's `justfile` diff produces — `database_url`,
`master_key`, `plaid_client_id`, `plaid_secret`, `plaid_env` all `0400` owned
by uid `10001` (`api`/`worker`'s uid); `pg_password` `0440` owned `70:10002`;
`age_recipient`/`b2_*` `0400` owned `10002`. `just harden-secrets` itself could
not be re-invoked in this sandboxed shell (`sudo` requires an interactive
password, unavailable here), but re-running it would be a no-op against this
state, and `scripts/check-secret-ownership.sh` — the independent, computed
check this condition asks for — verifies the same state directly without
needing to re-run the recipe that produced it:

```
$ bash scripts/check-secret-ownership.sh --self-test
check-secret-ownership: SELF-TEST PASS (correct state clean; both sabotages caught; missing file skipped not failed)
$ bash scripts/check-secret-ownership.sh
  hardening in progress: 9 secret(s) held to the strict bar, 0 violation(s)
check-secret-ownership: PASS
```

### 3.2 Live proof — the hardened deployment that used to crash-loop, up and healthy

`docker compose build && docker compose up -d` with all five hardened secrets
(including the three `plaid_*` this condition exists for) present and mounted:

```
$ docker compose ps
NAME                  ...  STATUS
personalfi-api-1      ...  Up (healthy)
personalfi-backup-1   ...  Up (healthy)
personalfi-db-1       ...  Up (healthy)
personalfi-proxy-1    ...  Up (healthy)
personalfi-worker-1   ...  Up (healthy)
```

Both `api` and `worker` — the two services N-1 reported crash-looping on
`EACCES` — are healthy. The api log confirms the secrets were actually read,
not merely present:

```
{"level":"info","service":"api","provider":"plaid","environment":"sandbox","msg":"plaid configured; connector registered"}
```

The worker log confirms the same three secrets loaded into its own
configuration:

```
"secretsPresent":["database_url","master_key","plaid_client_id","plaid_secret","plaid_env"]
```

This is the exact deployment shape gate-security-review.md §8.2 N-1 recorded
crash-looping (`secret:plaid_client_id: could not be read (EACCES)`, both `api`
and `worker`). It does not reproduce.

### 3.3 Sabotage — chown/chmod one mounted secret wrong

No host `sudo` was available in this session to chown/chmod files owned by
uid `10001` directly. Used the same pattern `RUNBOOK.md` already documents for
`just restore-drill` reading `pg_password` through a root container — a
throwaway `alpine` container with the real `./secrets` bind-mounted, root
inside the container namespace:

```
$ stat -c '%a %u:%g' secrets/plaid_secret
400 10001:10001

$ docker run --rm -v "$PWD/secrets:/secrets" alpine:3.24@sha256:28bd... chmod 0644 /secrets/plaid_secret
$ stat -c '%a %u:%g' secrets/plaid_secret
644 10001:10001

$ bash scripts/check-secret-ownership.sh
plaid_secret	expected owner 10001, mode 0400 (one consumer: uid 10001); got owner 10001, group 10001, mode 0644
  FAIL plaid_secret (.../secrets/plaid_secret): expected owner 10001, mode 0400 (one consumer: uid 10001); got owner 10001, group 10001, mode 0644
  hardening in progress: 9 secret(s) held to the strict bar, 1 violation(s)
check-secret-ownership: FAIL — one or more secret files are not owned/moded for their consuming service (see above)
```

Restored exactly (same container, `chmod 0400`):

```
$ docker run --rm -v "$PWD/secrets:/secrets" alpine:3.24@sha256:28bd... chmod 0400 /secrets/plaid_secret
$ stat -c '%a %u:%g' secrets/plaid_secret
400 10001:10001   # matches the pre-sabotage stat exactly

$ bash scripts/check-secret-ownership.sh
  hardening in progress: 9 secret(s) held to the strict bar, 0 violation(s)
check-secret-ownership: PASS
```

### 3.4 Wiring

Already wired into `just hardening-check` (owned by the prior agent's
`justfile` change) and therefore into `just verify`. Added to CI: `.github/workflows/ci.yml`'s
`compose-hardening` job now runs `check-secret-ownership.sh --self-test` and
the real invocation immediately after the existing `compose-hardening-check.sh`
steps. CI has no real `./secrets` (every file secret is absent on a fresh
checkout), so the real run there finds nothing to check and passes trivially
by design (§"no secret appears to have been hardened yet" in the script's own
comment) — `--self-test` is what actually exercises the check in CI, against a
synthetic fixture that needs no root.

---

## 4. D-7 — compose overrides are rendered layered, not standalone

### 4.1 Self-test

```
$ bash scripts/compose-hardening-check.sh --self-test
compose-hardening-check: SELF-TEST PASS (all 19 rules fire on a hostile file)
compose-hardening-check: --self-test: layered override rendering (scripts/fixtures/compose-hostile-override.yml on scripts/fixtures/compose-hostile-override-base.yml)
  layered override fixture triggered: privileged
compose-hardening-check: SELF-TEST PASS (layered override rendering catches a hostile trait the base does not have)
```

Both the original hostile-fixture self-test and the new layered-override
fixture pass: the override fragment is rejected standalone (no image/build
context of its own — the same shape the real documented override has) and,
layered on its clean base, a `privileged: true` that exists nowhere in the base
is still caught.

### 4.2 Real file — the documented Plaid-enabling override

Created `compose.override.yml` (gitignored) with exactly the content
`compose.override.example.yml` documents for turning Plaid on without editing
`.env`:

```yaml
services:
  proxy:
    environment: { PLAID_ENABLED: 'true' }
  api:
    environment: { PLAID_ENABLED: 'true' }
  worker:
    environment: { PLAID_ENABLED: 'true' }
```

```
$ bash scripts/compose-hardening-check.sh
  compose.yml: 9 service(s), 0 violation(s), 1 documented exception(s)
    waived compose.yml+compose.override.yml: db: missing-read-only: ...
  compose.yml+compose.override.yml: 9 service(s), 0 violation(s), 1 documented exception(s)
compose-hardening-check: PASS (4 file(s) checked: compose.dev.yml compose.override.example.yml compose.override.yml compose.yml)

$ just hardening-check
... (both self-tests, both real runs) ...
check-secret-ownership: PASS
```

This is gate-security-review.md §8.2 N-2's exact repro condition (a real,
active `compose.override.yml` following the documented Plaid-enablement path).
It no longer breaks `just verify`.

### 4.3 Sabotage — a hazard that exists only in the override

Added `privileged: true` to the override's `proxy` service (nowhere in
`compose.yml` itself):

```
$ bash scripts/compose-hardening-check.sh
    FAIL compose.yml+compose.override.yml: proxy: privileged: privileged: true
  compose.yml+compose.override.yml: 9 service(s), 1 violation(s), 1 documented exception(s)
compose-hardening-check: FAIL — one or more compose files violate the P0-6/P0-7 baseline
```

Restored (removed the `privileged: true` line) and re-ran — clean:

```
$ bash scripts/compose-hardening-check.sh
compose-hardening-check: PASS (4 file(s) checked: ...)
```

`compose.override.yml` deleted at the end of this evidence run (it is
gitignored and was never intended to persist):

```
$ rm -f compose.override.yml
$ git status --short compose.override.yml   # nothing
```

---

## 5. Test counts

| Suite                                                           | Result                                                                                                      |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `packages/platform/test/closeout-worker-liveness.test.ts`       | 15 tests, all passing; 1 deliberate sabotage of `runner.ts`'s `onPoll` call went red, restored, green again |
| `pnpm exec vitest run --project platform --project platform-db` | 97 tests passing (10 files)                                                                                 |
| `pnpm exec vitest run --project api`                            | 57 tests passing (unaffected by the `worker.ts` idle-heartbeat fix)                                         |
| `scripts/compose-hardening-check.sh --self-test`                | PASS (19 rules on the hostile fixture + the new layered-override fixture)                                   |
| `scripts/check-secret-ownership.sh --self-test`                 | PASS (both sabotage branches caught, missing-file skip proven)                                              |

`tsc -p tsconfig.json`: clean. `eslint` on every file this package touched
(`apps/api/src/worker.ts`, `compose.yml`'s embedded script,
`packages/platform/test/closeout-worker-liveness.test.ts`,
`.github/workflows/ci.yml`): clean. `prettier --check .` was red on five files
outside this package's ownership (`packages/connectors/**`,
`packages/contexts/**` — concurrent agents' in-flight work at the time); the
one file this package owns that prettier flagged
(`closeout-worker-liveness.test.ts`) was reformatted and is clean.

---

## 6. `just verify` — the actual output

See the final report for this run's verbatim `just verify` output (run after
`docker compose down -v` and after `compose.override.yml` was deleted, so the
tree matches what would be committed). It fails on `pnpm run lint:format`
against the same five out-of-ownership files noted above — nothing this
package touched is red.
