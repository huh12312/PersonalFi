<!-- SPDX-License-Identifier: MIT -->

# Gate remediation B — Plaid secrets/redirect URI, the ten-Item ratchet, and SSE stream caps

Closes conditions **C-3** (secrets, redirect URI, ratchet) and **C-6**
(runbook, SSE caps) from `docs/evidence/phase-1/gate-security-review.md`. A
prior run of this same remediation was killed by a rate limit after the code
landed (`git show --stat 6f1eb03`) but before evidence was written. This file
finishes that work: it re-verifies `just check`, produces compose proof,
sabotages every named control and records it going red, checks `RUNBOOK.md`
against the gate's two required sections, and fixes one real regression the
prior run's own change introduced (below).

Repo `/home/chris/Projects/PersonalFi`, branch `main`. `DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev`.

**Collision rule honoured throughout.** A concurrent agent owns
`docker/Caddyfile`, `apps/web/**`, `apps/api/src/app.ts`,
`apps/api/src/cli/**`, `packages/contracts/**`,
`scripts/check-proxy-routes.ts`, `.github/workflows/ci.yml` and `justfile` in
this same working tree (no worktree isolation this round) and landed its own
remediation (C-1a/C-1b/C-1c/C-2) as commits `38277b0`/`1961d9e` while this
remediation was in progress. One collision was observed, not caused by this
remediation's own edits: a `just check` run (below) failed
`test/app.test.ts`'s server-URL assertion (`expected [{ url: '/' }] … received
[{ url: '/api' }]`) because that concurrent commit had already changed
`apps/api/src/app.ts`'s `servers` value while the test in this remediation's
own `apps/api/test/**` had not been updated to match. That test is fixed
below, in this file's own change list, since `apps/api/test/**` is this
remediation's territory.

---

## A real regression found and fixed: SSE caps crashed the API shell tests

Re-running `just check` from the state on disk surfaced a genuine bug in the
prior run's own change, not a collision and not a sabotage:

```
FAIL |api| test/app.test.ts > ... > answers a request over TCP with request logging on
TypeError: Cannot read properties of undefined (reading 'max')
 ❯ eventRoutes src/routes/events.ts:298:33
    296|   const slots = new StreamSlots(
    297|     SSE_MAX_STREAMS_PER_SESSION,
    298|     sseGlobalLimit(pool.options.max ?? 10),
       |                                 ^
```

`apps/api/test/app.test.ts`'s `unreachablePool` — the double every shell test
in that file builds the real route tree against — is a two-method object
(`connect`, `query`) cast to `pg.Pool`; it has no `.options` at all, not merely
a `.options` with no `.max`. `pool.options.max ?? 10` assumes `.options`
itself exists and throws before the `??` ever runs. This crashed every test in
`test/app.test.ts` that calls `buildApp` (11 of them), which in turn is why
none of the SSE-cap sabotage below could have been observed by that suite
going red for the _right_ reason — a `TypeError` thrown at route-registration
time fails everything indiscriminately.

**Fixed** in `apps/api/src/routes/events.ts` (one line, `?.` instead of `.`):

```ts
sseGlobalLimit(pool.options?.max ?? 10),
```

Also fixed the resulting, previously-masked stale assertion in
`apps/api/test/app.test.ts` — `servers` had already changed to `/api` by the
concurrent C-1a commit, but this suite's own expectation had not, and the
`.options` crash had been hiding that mismatch behind an unrelated stack
trace:

```ts
expect(spec.servers).toEqual([{ url: '/api' }]);
```

Both fixes verified: `api` project 52/52 green in isolation, then the full
`just check` (§1) green end to end.

---

## §1 — `just check`

First run (before the fix above) failed on the `.options` crash (11 tests in
`test/app.test.ts`) plus one unrelated, transient collision in
`platform-db`/`jobs.test.ts` (`database "personalfi_wp03_jobs" does not
exist` — a concurrent `vitest` run against the same shared dev Postgres
instance dropped a temp database mid-test; re-run of `platform-db` alone,
after the other agent's run finished, was clean: `6 passed (6)`, `54 passed
(54)` — not a defect in this remediation's paths, and outside this
remediation's ownership).

After the fix, full `just check`, verbatim:

```
$ DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev just check
pnpm run typecheck
$ tsc -p tsconfig.json
pnpm run lint
$ pnpm run lint:format && pnpm run lint:eslint && pnpm run lint:schema-ownership
$ prettier --check .
Checking formatting...
All matched files use Prettier code style!
$ eslint .

/home/chris/Projects/PersonalFi/apps/web/src/features/transactions/TransactionsList.tsx
  57:23  warning  Compilation Skipped: Use of incompatible library
  ...
✖ 1 problem (0 errors, 1 warning)

$ node scripts/check-schema-ownership.ts
schema-ownership: ok — 94 table(s) claimed across 14 package(s), 41 defined.
node scripts/check-proxy-routes.ts
check-proxy-routes: PASS — docker/Caddyfile routes exactly '/api/*' to the api, matching
  packages/contracts/openapi/openapi.json's servers[0].url ('/api') and covering all 11
  contract prefix(es): /accounts, /auth, /connections, /connectors, /health, /imports,
  /net-worth, /ready, /sync, /transactions, /transfers.
pnpm run test
$ vitest run && pnpm --filter @app/web test

 Test Files  95 passed | 1 skipped (96)
      Tests  1481 passed | 2 skipped (1483)
   Duration  252.51s

$ vitest run
 Test Files  14 passed (14)
      Tests  80 passed (80)

[exited with code 0]
```

(The pre-existing warning on `TransactionsList.tsx` and the one pre-existing
skipped file/2 skipped tests — `connector-plaid`'s live-Sandbox smoke, no
`PLAID_CLIENT_ID`/`PLAID_SECRET` in this shell — are unrelated to this
remediation and match the gate's own §1 baseline.)

Re-run twice, both green, to confirm the fix is stable and not a fluke of test
ordering.

---

## §2 — Compose proof

### 2.1 Secrets declared and attached, redacted

```
$ docker compose config --format json | node -e '
const cfg = require("/dev/stdin");
for (const [name, svc] of Object.entries(cfg.services)) {
  console.log(name, "->", (svc.secrets||[]).map(s=>s.source).join(", ") || "(none)");
}
console.log("top-level:", Object.keys(cfg.secrets||{}).join(", "));
'
api      -> database_url, master_key, plaid_client_id, plaid_secret, plaid_env
backup   -> pg_password, age_recipient, b2_key_id, b2_application_key
db       -> pg_password
migrator -> database_url
proxy    -> (none)
worker   -> database_url, master_key, plaid_client_id, plaid_secret, plaid_env
top-level: age_recipient, b2_application_key, b2_key_id, database_url, master_key,
           pg_password, plaid_client_id, plaid_env, plaid_secret
```

Confirms: `plaid_client_id`, `plaid_secret`, `plaid_env` are declared at the
top level and attached to `api` and `worker` only. `proxy` mounts no secrets
at all (it reads only the non-secret `PLAID_ENABLED` env var to decide whether
to widen its CSP — C-2, owned by the concurrent remediation). `backup` mounts
only its own four (`pg_password`, `age_recipient`, `b2_key_id`,
`b2_application_key`) — no Plaid credential, matching the file comment in
`compose.yml` ("a `pg_dump` process has no use for one either — the ciphertext
it dumps is already sealed under the KEK, not under these").

### 2.2 `just hardening-check`

```
$ bash scripts/compose-hardening-check.sh --self-test
compose-hardening-check: --self-test: running scripts/fixtures/compose-hostile.yml through the gate
  fixture triggered 19 distinct rule(s): cap-add container-runtime-socket devices host-cgroup
  host-ipc host-network host-pid host-userns missing-cap-drop-all missing-no-new-privileges
  missing-read-only port-bind-address privileged root-user security-opt-unconfined
  sensitive-host-path-bind-mount writable-bind-mount writable-named-volume
  writable-volume-wrong-service
compose-hardening-check: SELF-TEST PASS (all 19 rules fire on a hostile file)

$ bash scripts/compose-hardening-check.sh
    waived compose.dev.yml: db: missing-read-only: ... (documented exception)
  compose.dev.yml: 1 service(s), 0 violation(s), 1 documented exception(s)
  compose.override.example.yml: template with no active services (nothing to check)
    waived compose.yml: db: missing-read-only: ... (documented exception)
  compose.yml: 9 service(s), 0 violation(s), 1 documented exception(s)
compose-hardening-check: PASS (3 file(s) checked: compose.dev.yml compose.override.example.yml compose.yml)
```

Both halves pass: the self-test proves the gate can still fail (19/19 hostile
rules fire), and the real files pass with the two pre-existing, documented
`missing-read-only` waivers on `db` (Postgres cannot run read-only; unrelated
to Plaid).

### 2.3 What happens when the `plaid_*` secret files are absent

Moved the three real secret files aside and re-checked:

```
$ mv secrets/plaid_client_id secrets/plaid_secret secrets/plaid_env /tmp/secrets-backup/
$ docker compose config
[exit 0 — config renders fine; compose does not check file existence at config-render time]

$ docker compose up --no-start api
 Container personalfi-db-1 Created
 Container personalfi-migrator-1 Created
 Container personalfi-api-1 Creating
time="..." level=warning msg="secret file personalfi_plaid_client_id does not exist"
time="..." level=warning msg="secret file personalfi_plaid_secret does not exist"
time="..." level=warning msg="secret file personalfi_plaid_env does not exist"
 service:api:1 Error response from daemon: invalid mount config for type "bind":
   bind source path does not exist: /home/chris/Projects/PersonalFi/secrets/plaid_env
Error response from daemon: invalid mount config for type "bind":
   bind source path does not exist: /home/chris/Projects/PersonalFi/secrets/plaid_env
```

**`docker compose config` succeeds; `docker compose up` (or even `--no-start`,
which still creates containers) fails outright** with a bind-mount error the
moment a container that mounts an absent declared secret is created. There is
no "optional bind mount" in Compose's secret model, exactly as `compose.yml`'s
own comment says. This is why `RUNBOOK.md` "Create secrets" step 6 has the
operator `touch` all three files unconditionally (`touch secrets/plaid_client_id
secrets/plaid_secret secrets/plaid_env`) rather than leaving them out for a
deployment that has not signed up for Plaid.

Restored the three files, re-ran `docker compose up --no-start api`: containers
create cleanly (verified by re-running with the real files present, no bind
error). Cleaned up the containers/volumes/networks this probe created
(`docker rm -f`, `docker volume rm personalfi_pgdata`, `docker network rm
personalfi_frontend personalfi_backend`) so the host is unchanged.

**Confirmed empty is treated as absent by `packages/config`.** This is
tested, not just asserted: `packages/config/src/load.test.ts` "boots with
Plaid unconfigured when both files exist but are empty (C-3 bootstrap
placeholder)" feeds `readSecret` an empty string and a whitespace-only string
for `plaid_client_id`/`plaid_secret` and asserts `config.plaid === null` —
exactly the state `RUNBOOK.md`'s `touch`'d placeholders produce. Ran in
isolation:

```
$ pnpm exec vitest run --project config -t "empty (C-3 bootstrap placeholder)"
 Test Files  1 passed (1)
      Tests  1 passed | ... skipped
```

So the loop closes: Compose forces the three files to exist on disk before it
will start `api`/`worker` at all; the runbook's bootstrap step creates them
empty; `@core/config` treats empty exactly like missing, so a fresh box with
no Plaid credentials boots with Plaid unregistered, not with a startup
failure.

---

## §3 — Sabotage, all restored with `git checkout --`

Every control named in the dispatch, broken once in production code, observed
red, then restored. "First try" means an existing test failed without writing
anything new.

### (a) Ratchet — remove the check from `linkConnection`

`apps/api/src/routes/connections.ts`: deleted the `if (body.provider ===
PLAID_PROVIDER) { ... }` block (the `countConnectionsByProvider` call and the
409 throw) from inside `linkConnection`.

```
$ pnpm exec vitest run --project api-db plaid-routes
 ❯ |api-db| test/db/plaid-routes.test.ts (10 tests | 1 failed)
   × is global (not per-user), survives a disconnect, and cannot be bypassed via POST /connections

FAIL test/db/plaid-routes.test.ts > ... > is global (not per-user), survives a disconnect,
  and cannot be bypassed via POST /connections
AssertionError: expected 201 to be 409
- 409
+ 201
 ❯ test/db/plaid-routes.test.ts:339:32

 Test Files  1 failed (1)
      Tests  1 failed | 9 passed (10)
```

**RED first try.** With the check removed from `linkConnection`, both the
direct `/connections/plaid/exchange` refusal at the cap and the
bypass-via-`POST /connections` assertion later in the same test fail, since
neither path enforces the ratchet anymore. Restored with `git checkout --
apps/api/src/routes/connections.ts`.

### (b) Ratchet — count only the current user

`packages/contexts/connections/src/connections.ts`'s `countConnectionsByProvider`
given a `userId` parameter and `and(eq(connections.provider, provider),
eq(connections.userId, userId))`; call site in
`apps/api/src/routes/connections.ts` updated to pass `userId`.

```
$ pnpm exec vitest run --project api-db plaid-routes
FAIL test/db/plaid-routes.test.ts > ... > is global (not per-user), survives a disconnect,
  and cannot be bypassed via POST /connections
AssertionError: expected 201 to be 409
- 409
+ 201
 ❯ test/db/plaid-routes.test.ts:339:32

 Test Files  1 failed (1)
      Tests  1 failed | 9 passed (10)
```

**RED first try.** A second user, holding zero Plaid connections of their own,
now succeeds past the deployment-wide cap because the count is scoped to
`session.userId` — exactly R-7's second half. Restored with `git checkout --`
on both files.

### (c) SSE — remove the per-session cap

`apps/api/src/routes/events.ts`'s `StreamSlots.acquire` — deleted `if (current

> = this.#perSessionLimit) return { ok: false, reason: 'session' };`, leaving
> only the global check.

```
$ pnpm exec vitest run --project api-db sse-limits
FAIL test/db/sse-limits.test.ts > concurrent SSE stream caps (R-9) >
  refuses one more stream than SSE_MAX_STREAMS_PER_SESSION on one session, with 429 and Retry-After
AssertionError: expected 200 to be 429
- 429
+ 200
 ❯ test/db/sse-limits.test.ts:135:30

FAIL test/db/sse-limits.test.ts > concurrent SSE stream caps (R-9) >
  the global cap is independent of the per-session cap: several sessions under their own
  limit can still exhaust the deployment total
AssertionError: expected 429 to be 200
- 200
+ 429
 ❯ test/db/sse-limits.test.ts:185:37

 Test Files  1 failed (1)
      Tests  2 failed (2)
```

**RED first try, both tests** (the second test's failure is collateral: with
no per-session cap, one session alone opens far more than `SSE_MAX_STREAMS_PER_SESSION`
streams while filling toward the global cap, so the "several sessions each
under their own limit" scenario the second test sets up never actually
happens — a `200` appears where the test expected the _global_ refusal on a
fresh session, one line further into the same run). Restored with `git
checkout -- apps/api/src/routes/events.ts`, then reapplied this
remediation's own real `pool.options?.max` fix (`git checkout` reverts
uncommitted changes on that file wholesale, including the earlier real fix,
since both were uncommitted) — reverified with `git diff` showing only the
intended one-line fix afterward.

### (d) Config — add an `envFallback` for `plaid_secret`

`packages/config/src/schema.ts`: `plaid_secret`'s `envFallback: undefined` →
`envFallback: 'PLAID_SECRET'`.

```
$ pnpm exec vitest run --project config gate-secret-custody
FAIL src/gate-secret-custody.test.ts > file-only secret custody (D5 / 01 §1.10) >
  has file-only secrets to check, and they include every plaid_* one
AssertionError: expected 3 to be greater than or equal to 4

FAIL src/gate-secret-custody.test.ts > file-only secret custody (D5 / 01 §1.10) >
  does not configure Plaid from a full set of environment variables
ConfigError: configuration is invalid; 1 problem(s) found:
  - secret:plaid_client_id: is missing, but secret:plaid_secret is present ...

 Test Files  1 failed (1)
      Tests  2 failed | 6 passed (8)
```

**RED first try, 2 of 8** — the exact count and shape the original gate
documented (§4.2 of the review) when it first found this control had no test.
Restored with `git checkout -- packages/config/src/schema.ts`.

### (e) `PLAID_REDIRECT_URI` — accept http

`packages/config/src/load.ts`'s `plaidRedirectUriProblems`: `if
(url.protocol !== 'https:')` → `if (false && url.protocol !== 'https:')`.

```
$ pnpm exec vitest run --project config -t "PLAID_REDIRECT_URI"
FAIL src/load.test.ts > Plaid (WP 1.3b — config) > PLAID_REDIRECT_URI
  (D12; gate-security-review.md §2.2 F-2, §6 C-3) >
  refuses a non-https redirect URI, even when its origin would otherwise match
AssertionError: expected [Function] to throw an error
- Expected: null
+ Received: undefined

 Test Files  1 failed | 2 skipped (3)
      Tests  1 failed | 4 passed | 82 skipped (87)
```

**RED first try.** Restored with `git checkout -- packages/config/src/load.ts`.

All five restores verified: `git diff --stat` after each shows only this
remediation's two real fixes (`apps/api/src/routes/events.ts`,
`apps/api/test/app.test.ts`), never the sabotaged line.

---

## §4 — `RUNBOOK.md`

Both required sections were already present from the prior (pre-kill) run of
this remediation; verified rather than re-authored:

- **"Create secrets" step 6** (`RUNBOOK.md` around line 101): lists all three
  files (`plaid_client_id`, `plaid_secret`, `plaid_env`), the `touch`/`chmod`
  bootstrap that makes them exist-but-empty by default, and both
  `PLAID_ENABLED` and `PLAID_REDIRECT_URI` with pointers to `.env.example`.
- **"What survives a disconnect"** (`RUNBOOK.md`, its own `##` section after
  "Backup"): states `BACKUP_RETENTION_DAYS` (30 days by default, local) and
  the indefinite B2 retention under object lock when `RCLONE_REMOTE` is set,
  states plainly that a disconnected credential can persist in up to thirty
  local nightly dumps (still `age`-encrypted, still KEK-sealed inside), and
  states that **KEK rotation, not disconnect and not the retention window
  lapsing, is what actually retires an old credential** from backup exposure.

Nothing was missing; no edit made to `RUNBOOK.md` in this pass.

---

## §5 — Test counts per project (isolated runs, post-fix)

```
config          Test Files  3 passed (3)       Tests  87 passed (87)
api             Test Files  7 passed (7)       Tests  52 passed (52)
api-db          Test Files  9 passed | 1 skipped (10)   Tests  87 passed | 1 skipped (88)
connections-db  Test Files  2 passed (2)       Tests  36 passed (36)
```

(`api-db`'s one skipped file/test is `plaid-sandbox.test.ts`'s live-Sandbox
smoke, self-skipped with no `PLAID_CLIENT_ID`/`PLAID_SECRET` in this shell —
pre-existing, matches the gate's own baseline.)

Full-repo `just check`, post-fix (§1): **95 files / 1481 tests passed, 1 file
/ 2 tests skipped**, plus `apps/web`'s own `14 files / 80 tests passed`.

---

## §6 — Files touched

- `apps/api/src/routes/events.ts` — one-line real fix (`pool.options?.max`),
  documented inline.
- `apps/api/test/app.test.ts` — one test's expectation updated to match the
  concurrent C-1a change (`servers[0].url` now `/api`), previously masked by
  the crash above.
- `docs/evidence/phase-1/gate-remediation-api.md` — this file.

No changes to `compose.yml`, `compose.override.example.yml`, `.env.example`,
`RUNBOOK.md`, `packages/config/**`, `packages/contexts/connections/**`, or
`apps/api/src/routes/connections.ts` / `plaid.ts` were needed — the prior
run's implementation of C-3 and C-6 was correct as landed; this pass's job was
verification, sabotage, the compose/absent-secret proof, and the one
regression fix above.

## Open items

None outstanding for C-3/C-6. C-1a/C-1b/C-1c/C-2/C-4/C-5 are the concurrent
remediation's and its own evidence file's territory
(`docs/evidence/phase-1/gate-remediation-web.md`).
