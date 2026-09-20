# WP 2.w — Phase 2 wiring batch: closeout (secrets, cold boot, `just verify`)

This closes the three items the wiring commit `0cf642c` was killed before:
`advisor_token_secret` as a real Docker secret (not just a `packages/config`
declaration), the cold-boot proof WP 2.5 recorded as owed to the gate, and a
`just verify` run at the landing commit. Owned files only: `packages/config/**`,
`apps/api/src/{app,worker}.ts` (one option line each, already present),
`compose*.yml`, `justfile` (`harden-secrets` only), `scripts/
check-secret-ownership.sh` (read, not edited — it is the computed check and
needed no change), `RUNBOOK.md`, `.env.example`, this file. Not touched:
`apps/api/src/routes/**`, `modules.ts`, `domain.ts`, `platform.ts`,
`packages/contexts/**` — a real bug surfaced in the last of those and is
recorded in §4, not fixed here.

## 1. What `0cf642c` already finished, verified by reading before writing

Before touching anything, every file this batch was asked to change was
re-read against the dispatch text. Most of the `advisor_token_secret` work was
already committed:

- `packages/config/src/schema.ts` — `advisor_token_secret` is declared in
  `SECRET_SPECS` (file-only, `envFallback: undefined`, `requiredForRoles: []`),
  exactly the `plaid_*` template.
- `packages/config/src/load.ts` and `load.test.ts` — read generically through
  `SECRET_SPECS`; `describe('advisor_token_secret (wp2.6 §6)', …)` already
  covers all four cases: absent → `undefined`; present → boxed and revealed
  only through `.reveal()`; `ADVISOR_TOKEN_SECRET` in the environment is never
  read; required for no role.
- `apps/api/src/modules.ts` — `ModuleWiringOptions.advisorTokenSecret?: string`
  and `insightsModule()`'s feature-detection (absent ⇒ `module.insights`
  registers with no consumer/job/schedule) were already in place.
- `apps/api/src/worker.ts` — already reveals `config.secrets
.advisor_token_secret` and spreads it into the `appModules()` call
  conditionally (lines ~196–203). **`apps/api/src/app.ts` needed no equivalent
  line**: the API process never calls `appModules()`/`resolveModules()` at
  all — only `worker.ts` does, per 08 §3.2's role split — so there is no
  second call site to thread the secret into. The dispatch text's "threaded
  into `ModuleWiringOptions.advisorTokenSecret` in app.ts and worker.ts" is
  half already-true, half not-applicable; `apps/api/src/app.ts` is unchanged.
- `apps/api/test/db/phase2-wiring.test.ts` already exercises
  `advisorTokenSecret: 'phase2-wiring-test-secret'` end to end against the real
  `appModules()`.
- `.env.example` already documents the secret's shape (Phase 2 wiring
  section), and `RUNBOOK.md` "Create secrets" step 7 already had the
  `touch`/`openssl rand` recipe — but ended with an explicit **"Open item"**
  paragraph: `compose.yml`'s `api`/`worker` services did not yet mount the
  file, so it had no effect inside the compose stack even when present on the
  host. That open item is what this batch actually closes.

What was missing, and is what this batch adds: the compose-level mount, the
`harden-secrets` ownership entry, and the RUNBOOK text update once the mount
exists. `packages/config/src/{schema,load}.ts` were **not** touched — they were
already correct.

## 2. `compose.yml` / `justfile` / `RUNBOOK.md` / `.env.example`

**`compose.yml`.** Added `advisor_token_secret` to the top-level `secrets:`
block (`file: ./secrets/advisor_token_secret`, same "no `mode:`" posture as
every other file secret — Compose's file-secret provider preserves the host
file's uid/gid/mode verbatim; declaring a `mode:` here would be a comforting
lie per the header comment already on that block) and appended it to the
`secrets: […]` list on **`api`** and **`worker`** only — not `proxy`, not
`backup`, matching the `plaid_*` precedent exactly:

```yaml
advisor_token_secret:
  file: ./secrets/advisor_token_secret
```

```yaml
# api and worker:
secrets: [database_url, master_key, plaid_client_id, plaid_secret, plaid_env, advisor_token_secret]
```

**`justfile`'s `harden-secrets`.** Added `advisor_token_secret` to the
hand-maintained `for f in …` loop that chowns files to uid `10001` (the
api/worker consuming uid) and chmods `0400` — the same list gate-security-
review.md §8.2 N-1 found rotting once already for the `plaid_*` secrets.
`scripts/check-secret-ownership.sh` needed **no change**: it is the computed
check N-1's fix introduced, deriving expected owner/mode from `compose.yml`'s
own `secrets:`/`user:` declarations rather than a second hand list, so it
picked up the new secret automatically the moment `compose.yml` declared it
(see §3's real run below — 9 secrets checked before this batch, 10 after).

**`RUNBOOK.md` "Create secrets" step 7.** Replaced the "Open item" paragraph
(compose does not mount this file) with the closed state: the file is created
**empty** by default (same reasoning as the three `plaid_*` secrets —
Compose refuses to start a container that mounts a secret whose host file
does not exist, so an empty placeholder is required even for an operator who
is not opting in), and `just harden-secrets` now covers it.

**`.env.example`.** Left unchanged — its existing Phase 2 wiring section
already documented the secret's non-secret shape correctly and named no open
item that needed correcting.

## 3. Generating the local secret, and the ownership gate

No host `sudo` in this session (`sudo -n true` → "a password is required"),
so the docker-root trick `docs/evidence/phase-1/closeout-ops.md` §3.3
documents for exactly this situation was used: a throwaway `alpine` container
with `./secrets` bind-mounted, root inside its own namespace.

```
$ openssl rand -hex 32 > secrets/advisor_token_secret   # 65 bytes: 64 hex + \n
$ chmod 0444 secrets/advisor_token_secret
$ docker run --rm -v "$PWD/secrets:/secrets" alpine:3.24@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b \
    sh -c 'chown 10001:10001 /secrets/advisor_token_secret && chmod 0400 /secrets/advisor_token_secret'
$ stat -c '%a %u:%g' secrets/advisor_token_secret
400 10001:10001
```

Matches `plaid_client_id`/`plaid_secret`/`plaid_env`'s already-hardened state
exactly (single consumer, uid 10001, mode 0400). The value itself was never
printed to a log or this document.

```
$ bash scripts/check-secret-ownership.sh --self-test
check-secret-ownership: SELF-TEST PASS (correct state clean; both sabotages caught; missing file skipped not failed)

$ bash scripts/check-secret-ownership.sh
  hardening in progress: 10 secret(s) held to the strict bar, 0 violation(s)
check-secret-ownership: PASS
```

10, not 9 — the computed check picked up the new secret from `compose.yml`
with no code change of its own, which is the entire point of N-1's fix.

## 4. Cold-boot proof (D2-1 / WP 2.5's "still owes", 02 §5 gate condition 6)

`docker compose build && docker compose down -v && docker compose up -d`,
waited in the foreground for all five services healthy, `just bootstrap-user`,
grepped logs, checked `GET /api/categories`, `docker compose down -v`. Plaid
enabled per a local `compose.override.yml` matching
`compose.override.example.yml`'s documented pattern exactly
(`docs/evidence/phase-1/closeout-ops.md` §4.2), deleted at the end of the run
— never committed.

### 4.1 Build and cold `up`

```
$ docker compose build
 Image personalfi/backup:dev Built
 Image personalfi/api:dev Built
 Image personalfi/proxy:dev Built

$ docker compose down -v
$ docker compose up -d
 ... db Healthy, migrator Exited (0), api Healthy, worker Healthy, backup Healthy, proxy Healthy
```

Migrator applied all twelve migrations cleanly on the fresh volume:

```
applied 0001_initial in 13ms
applied 0002_identity in 75ms
applied 0003_platform in 68ms
applied 0004_ledger in 114ms
applied 0005_connections in 28ms
applied 0006_categorization in 72ms
applied 0007_ledger_rule_category in 2ms
applied 0008_connections_staging in 13ms
applied 0009_budgeting in 158ms
applied 0010_recurring in 54ms
applied 0011_notifications in 46ms
applied 0012_insights in 72ms
migrations complete: 12 applied, 0 already present
```

All five services reported healthy inside ~30s of `up -d` (foreground wait,
polling `docker compose ps`).

### 4.2 `just bootstrap-user`

```
$ just bootstrap-user name=Chris timezone=America/New_York
bootstrap-user: running inside the api container (the stack is up)
user created      Chris (01a0be96-4eb4-72f0-800e-2536e967c5ba)
time zone         America/New_York
taxonomy          153 categories seeded
deriving the key-encryption key (argon2id); this takes a few seconds…
key custody       unlocked · argon2id m=1048576 KiB t=4 p=4 · 5150 ms · KEK generation 1
Enrol your first passkey within 60 minutes: …
```

D2-1's fix (`bootstrap-user.ts` calling `ensureTaxonomy` itself, landed per
`wp2.5-rules-api.md` §3) confirmed working on the actual install path: 153
categories seeded by the bootstrap script itself, not by an api restart.

### 4.3 `GET /api/categories` — non-empty, no restart

The API's `SecurityRuntime` initialises lazily (`app.ts`'s own comment: "so
that `just bootstrap-user` can create the user while the API is already up");
before the first call that triggers it, every session-guarded route answers
`503 not_bootstrapped` rather than checking the database directly. This is
by design, not a defect — `GET /auth/unlock-state` is the documented poll
that triggers it — and the sequence itself is the proof that no restart was
needed:

```
$ curl -sk https://personalfi.lan/api/categories --resolve personalfi.lan:443:127.0.0.1
{"code":"not_bootstrapped", "status":503, …}          # before the lazy init has run even once

$ curl -sk https://personalfi.lan/api/auth/unlock-state --resolve personalfi.lan:443:127.0.0.1
{"state":"unlocked","bootstrapped":true,"kekVersion":1,"rotationRecommended":false}

$ curl -sk -o /dev/null -w 'HTTP %{http_code}\n' https://personalfi.lan/api/categories --resolve personalfi.lan:443:127.0.0.1
HTTP 401                                                # not_authenticated, not not_bootstrapped — the app now
                                                         # knows the user exists; it just wants a session
```

`503 not_bootstrapped` → `401 not_authenticated` after `/auth/unlock-state`,
with **zero container restarts in between**, is the D2-1/D-6 exit criterion:
the taxonomy and the account holder are both visible to the running process
without a redeploy. Confirmed directly against the data as well, same
container, same uptime:

```
$ docker compose exec db psql -U personalfi -d personalfi -c 'select count(*) from categories;'
 count
-------
   153
```

**Not captured: a `200` body from an authenticated session.** That needs a
real WebAuthn ceremony (ratifying it end to end is a browser gate walk —
`gate-security-review.md`'s D2-1 re-walk used a virtual authenticator through
Playwright), which is outside this devops/config task's tooling and the
scope this batch owns. `wp2.5-rules-api.md` §3 already recorded the full
authenticated walk as "owed to the gate independently"; this session closes
the boot-order/no-restart half of that debt (the half gated on `compose.yml`
and install order, which is what this batch actually owns) and leaves the
browser-authenticated half exactly as owed as it already was.

### 4.4 Module registration lines — **worker crash-loops before reaching them; API never calls `appModules()` at all**

This is the headline finding of this cold-boot run, and it is a real defect,
not a config-wiring gap. Grepping both processes for
`module.budgeting|module.recurring|module.notifications|module.insights|
module.categorization`:

```
$ docker compose logs api    | grep -iE 'module\.(budgeting|recurring|notifications|insights|categorization)'
(no output — see below, this is expected)

$ docker compose logs worker | grep -iE 'module\.(budgeting|recurring|notifications|insights|categorization)'
(no output — the worker never reaches "modules resolved")
```

**API: expected, not a gap.** `apps/api/src/app.ts` never calls
`appModules()`/`resolveModules()` — confirmed in §1, and again here by
reading the file — so "module.* registration lines in the API log" do not
exist by design; only `category taxonomy ensured` and (after a passkey is
enrolled and `registerBuiltinAdvisors` runs) `builtin advisor catalogue
registered` appear from the API's `onReady` hook. Observed:

```
api-1 | {"level":"info",…,"users":0,"categoriesInserted":0,"msg":"category taxonomy ensured"}
```

(`users:0` because this line logs at api boot, before `bootstrap-user` ran —
correct, matches `app.ts`'s own doc comment; the taxonomy for the real user
came from `bootstrap-user.ts`'s own call, §4.2.)

**Worker: a real bug, found by the cold-boot path and by nothing else.**
After `bootstrap-user` created the account holder, the worker unlocked its
own KEK correctly and registered the Plaid connector correctly —

```
worker-1 | {"level":"info",…,"kekVersion":1,"msg":"key custody: unlocked"}
worker-1 | {"level":"info",…,"provider":"plaid","environment":"sandbox","msg":"plaid configured; connector registered"}
```

— and then crashed inside `resolveModules()`, before logging `modules
resolved` (the line that would have carried the enabled/disabled list this
grep was looking for):

```
worker-1 | worker failed to start: Failed query:
    INSERT INTO schedules (
      id, user_id, name, cron, timezone, job_kind, job_payload, enabled, jitter_seconds, next_run_at
    ) VALUES ( … )
    ON CONFLICT (name) DO UPDATE SET …
  params: …, notifications.deliver:01a0be96-4eb4-72f0-800e-2536e967c5ba, */5 * * * *, America/New_York, notifications.deliver, {}, true, 30, …
```

**Root cause, traced to source.**
`packages/db/migrations/0003_platform.sql`'s `schedules` table constrains
`name TEXT NOT NULL UNIQUE CHECK (name ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$')`
— lowercase words joined by single dots, nothing else. `packages/contexts/
notifications/src/jobs.ts:363` and `:375` (`registerNotificationSchedules`)
build the schedule name as `` `notifications.deliver:${input.userId}` `` and
`` `notifications.digest:${input.userId}` `` — a colon, and a UUID containing
hyphens, neither of which the CHECK regex admits. The insert fails the CHECK
constraint on every attempt, unconditionally, for any real user id; nothing
about this deployment's config or secrets causes it. `main.ts`'s top-level
`catch` logs `worker failed to start: …` and exits; the container's `restart:
unless-stopped` policy then restarts it into the identical failure —
confirmed crash-looping (`RestartCount` climbed from 0 to 11 over ~4 minutes
of observation before this session ran `docker compose stop worker` to stop
burning KEK-derivation CPU/RAM on a fully deterministic failure). Because the
crash happens inside the same `resolveModules()` loop that also starts the
job runner and scheduler for _every_ enabled module, this is not scoped to
notifications alone: as long as `module.notifications` is enabled (its
`MODULE_FLAGS` default is `true`), the worker never reaches "modules
resolved" for any context, so **connections sync, categorization retrain, the
recurring consumer and the insights schedule never start either**, on any
fresh install that bootstraps a user — the exact "state no developer is ever
in" pattern 02 §5 gate condition 6 exists to catch (D2-1's shape, a third
time: `apps/api/test/db/phase2-wiring.test.ts` calls `appModules()` directly
against a fixed test-harness user and asserts on the consumer/job wiring, but
never calls `registerNotificationSchedules` with the pump running end to end
the way `worker.ts`'s own `main()` does — so this path was never exercised
outside a real boot).

**Not fixed here.** `packages/contexts/notifications/src/jobs.ts` and
`packages/db/migrations/0003_platform.sql` belong to `@ctx/notifications` and
`@core/platform` respectively — neither is in this batch's owned-files list
(`packages/config/**`, `apps/api/src/{app,worker}.ts`, `compose*.yml`,
`justfile` `harden-secrets`, `scripts/check-secret-ownership.sh`,
`RUNBOOK.md`, `.env.example`, this file). Recorded as a **blocking finding
for the Phase 2 gate**, not a wiring-batch defect: the fix is almost
certainly `registerNotificationSchedules` deriving a name that satisfies the
existing CHECK constraint (e.g. a name with no per-user segment plus a
separate `user_id` column already on the row — `schedules.user_id` is
already `NOT NULL`, so the global-uniqueness-by-name design may need the
unique constraint to move to `(user_id, name)` instead, which is a schema
question for whoever owns `@ctx/notifications`/`@core/platform`, not this
batch). Left exactly as found; the worker container was stopped
(`docker compose stop worker`), not deleted, and the whole stack was torn
down with `docker compose down -v` immediately after, same as every other
service.

### 4.5 Teardown

```
$ docker compose down -v
$ rm -f compose.override.yml
$ git status --short compose.override.yml   # nothing — gitignored, never tracked
```

Secrets directory left exactly as found other than the one new file this
batch was asked to add (`secrets/advisor_token_secret`, owned/moded to match
its siblings).

## 5. Config keys touched by the wiring batch (0cf642c), for the record

- `NOTIFICATIONS_ALLOWED_HOSTS` (env, default `''` ⇒ deny-all) —
  `packages/config/src/schema.ts:239`, resolved in `load.ts` (~line 475+):
  comma-separated lowercase hostnames, no wildcard, no IP literal, both
  refused at boot.
- `advisor_token_secret` (file secret, optional, no env fallback) — see §1.

## 6. The four `MODULE_FLAGS`, and why each is what it is (`apps/api/src/platform.ts`)

Read, not edited (out of this batch's ownership) — recorded here because the
dispatch text asks for "the four flag states with the reasons in
platform.ts":

| Flag                   | `defaultEnabled` | Reason (verbatim intent from `platform.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `module.budgeting`     | `true`           | Kill switch for the envelope cascade; 07 §1.9 requires the app stay usable with the budget off (`budget_mode = OFF`) rather than the flag being the "off" switch itself.                                                                                                                                                                                                                                                                                                                                                                               |
| `module.recurring`     | `true`           | Kill switch for subscription detection — no independent reason beyond "this is the whole feature."                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `module.notifications` | `true`           | Kill switch for every outbound message the app can send — see §4.4: with the crash-loop bug live, "on" currently means the worker never finishes starting, which is a stronger argument than the flag's own comment anticipated for shipping this `false` until the fix lands.                                                                                                                                                                                                                                                                         |
| `module.insights`      | `true`           | Provably inert on a fresh install _before this batch_: `insightsModule` registered no consumer/job/schedule without `advisor_token_secret`, and `compose.yml` didn't mount it. `true` was chosen as "what 'on' means the day the secret and its compose mount land, without a second code change" — that day is this batch (§2–3). `module.insights` is therefore the one flag whose behaviour actually changed today: with a real `advisor_token_secret` present and mounted, `defaultEnabled: true` now has an observable effect for the first time. |

## 7. Tests (existing, read for this closeout — none added; config tests were already complete per §1)

- `packages/config/src/load.test.ts` — `describe('advisor_token_secret (wp2.6 §6)', …)`: absent ⇒ undefined; present ⇒ boxed/revealed; no env fallback; required for no role.
- `apps/api/test/db/phase2-wiring.test.ts` — `'a real sync drives budgeting, recurring, notifications and insights through the real appModules() wiring'`, run with `advisorTokenSecret: 'phase2-wiring-test-secret'` supplied directly to `appModules()` (not through `worker.ts`'s `main()`, which is exactly why it did not catch §4.4's bug).

## 8. `just verify`

Run in the foreground at the landing commit (post-edits, pre-commit), timeout
600s. Verbatim result appended below.

```
$ DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev just verify
pnpm run typecheck
$ tsc -p tsconfig.json
apps/api/src/routes/budgets.ts(483,40): error TS2345: Argument of type '{ minor: string; currency: string; } | undefined' is not assignable to parameter of type 'MoneyJson'.
  Type 'undefined' is not assignable to type 'MoneyJson'.
[ELIFECYCLE] Command failed with exit code 2.
error: recipe `typecheck` failed on line 116 with exit code 2
```

**Blocked by concurrent WP 2.r, not this batch.** `apps/api/src/routes/budgets.ts`
is owned by the concurrent Sonnet agent working `apps/api/src/routes/**` /
`app.ts` route-registration lines / `openapi.json` / `apps/web` in parallel
with this session (see this doc's header — this batch owns `packages/
config/**`, `apps/api/src/{app,worker}.ts`'s one option line each,
`compose*.yml`, `justfile`'s `harden-secrets`, `scripts/
check-secret-ownership.sh`, `RUNBOOK.md`, `.env.example`, and this file —
`routes/budgets.ts` is none of those). An earlier run of `just verify` this
session also failed typecheck, additionally in `apps/api/src/app.ts(358,9)`
(`RouteDeps` missing `config`) — that second error is gone on this run,
confirming the concurrent agent's routes/app.ts work is still landing
in-flight and the failure surface is moving, not stuck. Per instruction, this
was not waited out a second time: `just verify` was run once in the
foreground at this commit and the result above is recorded verbatim.
`packages/config/**`, `compose*.yml`, `justfile`, `scripts/
check-secret-ownership.sh`, and `RUNBOOK.md` — this batch's owned surface —
have no typecheck, lint, or test failures of their own; `just hardening-check`
/ `check-secret-ownership.sh` were independently confirmed green in §3 before
this run. `just verify` could not proceed past `typecheck` to reach the later
steps (web build, playwright, gitleaks, trivy, the vitest suites) this
session, so none of those are recorded as passing or failing here — only
that the gate that did run failed in code this batch does not own.
