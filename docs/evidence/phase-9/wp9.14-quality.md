# WP 9.14 — Quality pass (evidence, written as it happens)

HEAD at start: `8b53116` (clean tree). Host: Ryzen 5 3501U, 4c/8t, 23 GiB. Started 2026-10-07 ~18:00 EDT.
Load is printed beside every number; a number taken with the load shown above 3, a model loaded, an image
building or `pf-stranger-dind` present is marked NOT BELIEVED.

## 0. Log

### 0.1 Verify-first on wp5.14 §8 items 14, 18, 19, 22

| Item                                                                    | Finding at `8b53116`                                                                                                                                                                                      | Verdict                                                                                                                              |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 14 `InsightsScreen.test.tsx` dismiss test                               | `pnpm exec vitest run src/features/insights/InsightsScreen.test.tsx` in `apps/web`: 6/6 passed, including `'dismissing an insight captures a reason and shows the cooldown notice'`                       | closed (fixed in Phase 5/9 by its owners)                                                                                            |
| 18 hand-added `ollama/ollama` paragraph in `THIRD_PARTY.md`             | the paragraph is now emitted by `scripts/check-licenses.ts` (lines 261-263) so `just licenses` regenerates it; `THIRD_PARTY.md` carries it (lines 16-18)                                                  | closed                                                                                                                               |
| 19 `packages/platform/src/index.ts` export block for the local endpoint | still there (lines ~225-247), commented as the adapter's only way through the closed `exports` map; `@advisor/local-model` imports it                                                                     | **decision: keep.** A closed `exports` map makes this block the one door; moving it would only move the door. Recorded, not a defect |
| 22 `advisor-golden.test.ts` (S7B collision, S1 row, S5 control)         | closed by `bee9246` (WP 5.7's finisher): the harness is keyed on `advisorId`, rows exist for S1, S5 (with `controlKeys`) and the fee hunter; `vitest run --project insights advisor-golden.test.ts` 42/42 | closed; the file needed no edit                                                                                                      |

### 0.2 P-1 — the job runner's claim loop slept the full poll when a kind was at its cap

Red first: `packages/platform/test/jobs-completion-wake.test.ts` (new, platform-db). Six instant jobs of a kind
capped at one (and six at a process cap of one), poll interval 2 s. Against the unchanged runner:
`× drains a kind capped at one far faster than one job per poll interval` and
`× drains a process capped at one job in flight the same way` ("timed out waiting for six instant jobs ... inside
one poll interval"); the two guard tests (no busy loop while idle; a failing job's backoff is not re-claimed by the
wake) were green, as they should be before a fix exists. Load 1.2.

Fix: `NotifyListener.nudge()` (packages/platform/src/notify.ts) and the claim loop calls it when a job finishes
(packages/platform/src/jobs/runner.ts). After: 4/4 green, plus `jobs.test.ts`, `pump.test.ts`,
`worker-restart.test.ts` (32/32 across the four files).

Sabotage (guard tests): a `listener?.nudge()` before every wait (a busy loop) -> the run hung (the idle
test's poll count and then `stop()` never returned; killed by hand, the tree restored byte-identical from
`/tmp/wp914/runner.ts.good`, `grep -c SABOTAGE` 0). A hang is a CI timeout, so it is red.

### 0.3 P-6 — `GET /holdings` and `/investments/allocation` ~2 s at 200 positions

Red first: `packages/contexts/investments/test/db/prices-bounded-read.test.ts` (new, investments-db), against the
unchanged store: 4/4 red — `expected 401 to be less than or equal to 4` (the store returned the security's whole
400-day history plus the override), `expected 400 to be less than or equal to 2`, and
`reader.priceMany is not a function` twice (the batched read did not exist).

Fix (`packages/contexts/investments/src/prices.ts`): the ladder only ever uses the rows dated exactly the date asked
for and the rows of the newest date before it (`last_known`), so `observationsOnOrBefore` (every row, no LIMIT) became
`observationsForLadder` and a new `observationsForLadderMany` — one statement for N securities, two index probes per
security through `prices_user_security_date_idx` (the date, and a correlated `max(price_date) < date`), bounded by the
date and not by a row count. `PriceReader` gains `priceMany` (one `ladderFor` per distinct kind plus one observations
read); `price` and `priceMany` share one `walkLadder`, so the batched path cannot answer differently. The in-memory
store applies the same bound. `apps/api/src/routes/investments.ts`: `priceHoldings` (holdings, allocation, the
net-worth seal's portfolio) and the period-returns valuation loop call `priceMany`.

After: `prices-bounded-read.test.ts` 4/4 (bounded to <= 4 rows of 401; the batched answer equals the per-security
answer for 65 securities across exact-date, carry-forward, future-only, wrong-currency and no-row cases; 65
securities priced in <= 2 statements); `pnpm exec vitest run --project investments --project investments-db`: 34
files / 276 tests; `typecheck` clean; `api-db` `investments-perf`, `holdings-reconcile`, `phase3-wiring` 17/17.
`apps/api/test/price-holdings-batched.test.ts` (new, api): `priceHoldings` over 200 holdings / 150 securities calls
`priceMany` once with 150 ids and `price` zero times. Sabotage: the route's sequential loop restored ->
`no per-security ladder walk: expected 150 to be +0` red; restored byte-identical (`grep -c SABOTAGE` 0).
The latency re-measure (`holdings-scale-perf.test.ts`) waits for a quiet host: see section 3.

### 0.4 O-94-1 — a card already owing at a budget's first period dead-letters `budgeting.actuals@v1` (identity II) — and a second, broader defect found through the shipped routes

Red first: `packages/contexts/budgeting/test/db/card-owing-at-first-period.test.ts` (new, budgeting-db): 3 of 4 red
with `identity II failed for card …: owed 350.00 ≠ available 0.00 + unfunded 0.00` (the fourth, a card with no
balance, was green as it should be).

Fix (`packages/contexts/budgeting/src/service.ts`, `startingCardDebt`): a card's FIRST payment line (no earlier period
of the budget has one) opens with the debt the card carried when the period began. It is derived from the ledger,
not from the cascade: `owed at start = −(balance now − every movement on the card since the period began)`, scanned
to the end of time through the port. (Taking `owed − (available + unfunded)` would make identity II true by
construction; the last test pins that it still bites: a $50 charge the holder excluded from totals is a ledger row
the cascade rightly ignores, and the recompute still refuses with `budgeting.card_identity_violation`.) The next
period's line is not "first", so the roll carries the debt once (the roll test: carryover 40,000, identity holds in
period 2). A card overpaid at the start keeps today's behaviour. After: `budgeting` + `budgeting-db` 33/33.
Sabotage: `first` forced to every card (the debt added again on the rolled line) -> the roll test red
(`owed 300.00 ≠ available -100.00 + unfunded 700.00`); restored (`grep -c SABOTAGE` 0).

**The broader defect, found by driving the shipped composition (C5-11):** the first version of the api-level test
(`apps/api/test/db/budgets-card-owing.test.ts`, real routes + manual connector + the registered consumer in the real
pump) still dead-lettered the consumer after the fix above, on a $50 charge in a category the budget had no line for.
Probing with NO prior debt (a scratch copy, deleted) reproduced it: `owed 50.00 ≠ available 0.00 + unfunded 0.00`.
**Any credit-card charge in a category without a budget line, or with no category, stopped the actuals consumer** —
`CCP[card]` was fed only by the category lines that exist. A real budget never lines every category a card is used in,
so this would have stopped the soak install's consumer on the first unbudgeted purchase; O-94-1 was its first-period
face. Red first: `packages/contexts/budgeting/test/db/card-spend-without-envelope.test.ts` (new) 3/3 red
(`owed 50.00 ≠ available 0.00 + unfunded 0.00`, `owed 75.00 ≠ …`). Fix (service.ts step 3b): the card effects of every
bucket with no line (including `null`) are taken from a throwaway zero-opening `runEnvelope` — nothing is earmarked,
so by 07 §1.3 all of it is borrowed; no envelope's `available` and no RTA moves. After: 3/3 green; api-db
`budgets-card-owing` 2/2 (the route answers 200 with the card at `unfunded 35000`; the consumer stays `running`,
`failed_count 0`, through a charge). Sabotage: step 3b disabled -> the api consumer test red
(`budgeting.actuals@v1 failed on event seq 5: identity II failed … owed 400.00 ≠ available 0.00 + unfunded 350.00`);
the starting-debt fix disabled -> both api tests red with the route's 409 `budgeting.card_identity_violation`.
Both restored byte-identical.
Not fixed, recorded (post-v1.0): identity II is asserted against the card's balance NOW for every dirty period, so a
past period recomputed after later activity still compares a stale period to today's balance; the existing 13-roll
test keeps closed periods clean, so it has not bitten. A holder-excluded card charge fails identity II permanently
(the test above pins the refusal as the control working); an operator needs `just consumer-resume` after un-excluding.

### 0.5 P-5 — `just bootstrap-user` in its own one-shot container (and F-13-4, the stranger's measurement of the same defect)

WP 9.13's stranger install hit exactly this: the KEK derivation by `docker compose exec` inside the api container's 1536M
limit was OOM-killed (exit 137, `usage 1572864kB, limit 1572864kB, anon-rss 1395360kB`) on 3 of 5 attempts on a 6 GiB
host, after the user row was written. Fix (`justfile`, `bootstrap-user`): when the stack is up the recipe runs
`docker compose run --rm --no-deps -T --entrypoint node api /app/apps/api/src/bin/bootstrap-user.ts …` — a fresh
container from the api service's own definition (same image, secrets, networks, read-only root, uid 10001, caps
dropped, 1536M, 256 pids) in its OWN cgroup, so the running api is never the process the kernel kills. The derivation
takes the same advisory lock 9.11 added (it is `SecurityRuntime`'s own, not the container's), so it never overlaps the
api's or the worker's. No new compose service was added: a second service definition would be a copy of `api` that the
hardening check has to be kept in step with, and `compose run` of the existing one cannot drift from it.
Red first: `scripts/justfile-recipes.test.ts` (scripts project) pins `not compose exec … api`, `compose run --rm
--no-deps`, `--entrypoint node api`, and the dev-database fallback; the exec form is restored as the sabotage ->
red (`derives the KEK in its own one-shot container, never by exec into the running api`), restored byte-identical.
The measured run on `pf-qa` is in section 4.

### 0.6 F-13-5 — recovery codes were never shown (the stranger's second finding)

The README promised "save the ten recovery codes", the enrolment wizard never showed any, Settings said security
"lands in a later work package" and `just --list` has no recovery recipe, while the sign-in page offers "Use a recovery
code instead". A holder who loses their only passkey had no codes.

Built (`apps/web`): `features/security/RecoveryCodes.tsx` — an explicit button (never an effect: a second call replaces
the set, so a re-run effect would invalidate the codes on screen) calls `POST /auth/recovery-codes` through
`useStepUpRetry`, shows the ten codes once in an ordered list with Copy and Download-as-text, and releases the exit
only after "I have saved these codes somewhere safe" is ticked; the codes live in component state only (never the
query cache or storage). Two placements: the first-run enrolment wizard (`PasskeyRegisterFlow`: after the backup-passkey
step, for an enrolment-token flow only; a "Skip for now — create them later in Settings › Security" stays so a failed
call cannot trap the wizard) and Settings › Security › Recovery codes (shows the unused count from the session view,
"Replace my recovery codes" opens the panel, the generate button is the step-up). Vitest: `SecurityScreen.test.tsx`
and `PasskeyRegisterFlow.test.tsx` (new). Sabotage: the wizard's `codes` step bypassed -> the skip-path test red;
sign-out step-up bypassed -> red; cache clear removed -> red (below).
Not covered by a browser test: the enrolment wizard (it needs `navigator.credentials.create`; the unit test drives it
with the real response shape, the settings path has the e2e).

### 0.7 Sessions / sign-in-methods screen (`GET/DELETE /auth/sessions`, `DELETE /auth/totp`) — built

Settings › Security (`apps/web/src/features/security/SecurityScreen.tsx`, a new tab in `routes/_app.settings.tsx`).
Every call needs a fresh passkey assertion, so the list is NOT loaded on open: "Show my sessions" runs the ceremony
once (refused 403 -> passkey -> retried) and the list lives in component state only (`gcTime: 0`). Each row: method
(Passkey / Authenticator code / Recovery code), "This session", "Trusted device", last active, expiry, a Sign out
button whose accessible name names the session; "Sign out every other session"; signing out THIS session clears the
cache and goes to /login (the server cleared the cookies). Sign-in methods: the authenticator code with a Set up /
Not set up badge from the session view and a destructive confirmation (`ConfirmDialog`) before `DELETE /auth/totp`.
Vitest 11 + 3 (security, wizard); Playwright `e2e/security.spec.ts` 3/3 (mock refuses every gated call with
`step_up_required` until `/auth/step-up/verify`, so the recorded call order proves refused -> ceremony -> retried;
axe in both themes on every state including the destructive dialog; keyboard-only: Enter on buttons, Escape returns focus).
Sabotages: `queryClient.clear()` removed on self sign-out -> red; the sign-out's step-up bypassed -> red.
`apps/web/playwright.config.ts`: `security` added to the chromium `testMatch` (one token).

### 0.8 CI: `nightly-perf.test.ts` 'the night did real work' read 49 of 56 delta rows (run 37695713725, 2-core runner, `CI` mode)

What the CI log shows (`gh run view 37695713725 --log-failed`): `first backfill 11.2 s, load 3.58 (2 cores)`, the chain
completed in 22.97 s, and the scheduled runs read `[7, 6+1, 5+1, 6+1, 6+1, 6+1, 106, 7]` added: ONE connection's
scheduled sync re-read its whole 106-row backfill and so never reached the delta page (the fake Item's last backfill
page has `has_more: false`, so a sync from a null cursor stops there), and its 7 `d-%`/`posted-%` rows never landed.
The only possible cause is that connection having NO stored cursor when the night began; the nightly itself cannot
reset one. The 106-row run is the first `transactions` run that connection ever completed.

Reproduction attempts (all `CI=1`, so 30 days, 250 ms poll): one run pinned to 2 cores with the DB free
(`/tmp/wp914/nightly-ci1.log`: passes, backfill 13.5 s) and four runs pinned to the same 2 cores with two busy loops
on them (`/tmp/wp914/nightly-stress-{1..4}.log`: all pass, backfill ~12 s) — **not reproduced in 6 of 6**. The
mechanism is therefore NOT established; what is established is that nothing in the test proved the precondition,
so the symptom surfaced a minute later as a bare count. Candidates ruled in or out by reading: P-1 (the runner) cannot
be it (CI ran the old runner, and a capped kind only delays); `untilQuiet` cannot return with an initial job pending
(`queueHealth.pending` counts future-dated retries); an exhausted-retry initial job (dead) needs ~15 s of backoff
against an 11 s backfill; a dedupe collision needs an active job after quiet. Left: a transient failure of one initial
sync that the job layer treats as non-retryable (a run row `failed` with the job `succeeded`), which the new diagnostics
will name if it recurs.

Fix to the TEST's determinism, without weakening the assertion (it still requires every one of the 56 delta rows by
provider id): immediately after the first backfill, and before the night is timed, the test now asserts for EVERY
connection that it has a stored `transactions_cursor` and exactly one successful `initial` `transactions` run, and that
no job is `dead` or `failed`; a violation fails there with the connection ordinal, its full run list (trigger,
operation, status, added, error code) and the failed jobs' `last_error`. It also prints every sync run
(`perf nightly all sync runs`). Sabotage: one connection's cursor nulled after the backfill ->
`every connection finished its first sync with a stored cursor, and no job is dead or failed: expected { unsynced: [ { …(4) } ] …`
(red at the new check; the old end-of-test count would have read 49 of 56 a minute later); restored.
`CI=1` run after the change: passes (`Tests 2 passed | 1 skipped`, the skip being the 5-minute budget which is correctly
not asserted in CI mode). **Open for the orchestrator:** rerun CI; if the failure recurs it now stops at the first
backfill and says which connection and why, and the cause is then a product defect to fix, not a test race.

### 0.9 Plaid Production, and the restore drill's plan row

**`PLAID_ALLOW_PRODUCTION`** (wp9.12 §9 item 4): `@core/config` refuses `plaid_env=production` without it, and
`compose.yml` never passed it, so a holder who set both in `.env` could not leave sandbox. `compose.yml`: both `api` and
`worker` now carry `PLAID_ALLOW_PRODUCTION: ${PLAID_ALLOW_PRODUCTION:-false}` (default false: nothing changes for an
install that does not set it; `proxy` and `migrator` never dial Plaid and do not get it). `scripts/compose-env-passthrough.test.ts`
(3 tests; sabotage: the worker's line removed -> `worker receives PLAID_ALLOW_PRODUCTION, defaulting to false` red,
restored byte-identical); `compose-hardening-check.sh` PASS. The three places that said it could not be done were
corrected (`.env.example`, RUNBOOK step 2, `docs/RELEASE-NOTES.md` known limits) so the docs do not contradict the file.

**The restore drill must hold a plan scenario since 0040** (wp9.1's recipe body; F-94-6 was invisible to the drill because the
drill database held no plan). `justfile` `restore-drill`, assertion 2b: it counts `plan_scenarios` on the restored database and
on the live one, FAILS on a mismatch, and when the live database holds none prints and records a WARNING that the drill is blind
to that class (a PASS would otherwise imply it is not). The evidence file gains `plan_scenarios rows, restored / live`.
Red/green and the sabotage are in section 4 (they need the scratch stack).

### 0.10 G-09 — the post-login redirect guard

Red first: `apps/web/src/lib/safe-redirect.test.ts` (new): 6 of 18 red against the unchanged guard — a backslash anywhere but
the second character, and a tab, newline, carriage return, NUL or DEL (`/<TAB>/evil.example`, which a URL parser turns into
`//evil.example`). The guard now refuses a backslash or any C0/DEL control anywhere. `LoginRedirect.test.tsx` (new) drives the
real route tree and the real TOTP sign-in with `?redirect=` set to each hostile value and asserts the holder lands on `/`;
sabotage: `destination = redirect` unconditionally -> 3 of 5 red; restored.

### 0.11 G-14 — header, CSP, TLS and image properties as tests

`scripts/caddy-headers.test.ts` (new, 15 tests, structural against the shipped `docker/Caddyfile`): HSTS at least a year with
subdomains; nosniff, DENY, no-referrer, COOP, CORP exact; COEP follows the Plaid switch; Permissions-Policy denies the powerful
features; `-Server`; the CSP closed (self-only, no eval, no inline script, `frame-ancestors`/`base-uri`/`object-src` none, no
wildcard, no `http:`); no `protocols`/`ciphers`/`browse`/`auto_https off` override; `tls internal`; the only upstream is
`api:8080` under `/api/*`; `admin off`; source maps deleted from the web build with a build-failing check; `.git` outside the
build context. Sabotage: `X-Frame-Options "SAMEORIGIN"` and `'unsafe-eval'` -> 2 red; restored. The live-listener half (every header on
every response class, TLS versions on the wire, TRACE) needs a running stack and stays the gate's walk.

### 0.12 G-15, G-28, G-18 — lint bans, one rule per property

`eslint.config.js` (a shared file; the only edit is additive, with the selectors in shared lists because `no-restricted-syntax` is
ONE rule per file and a later block replaces an earlier block's selectors): in `apps/web/src`, `dangerouslySetInnerHTML`,
`innerHTML`/`outerHTML` assignment, `insertAdjacentHTML`, `createContextualFragment`, `parseFromString` and `document.write`
(G-15); `localStorage`/`sessionStorage` `.setItem` outside `lib/persisted-store.ts` and `app/shell/Sidebar.tsx` (G-28, V14.3.3);
in server code `sql.raw` and `shell: true` (G-28, V1.2.4/V1.2.5); in identity, secretbox and `apps/api/src`, `Math.random` (G-18). `pnpm run lint:eslint`: 0 errors
over the whole tree, i.e. nothing shipped used any of them. `scripts/eslint-html-sinks.test.ts` (13 tests) runs the REAL config
over text that uses each and text that does not, including that the Date rule survives in the files that gained selectors and
that the e2e harness's canary `innerHTML` is out of scope. Sabotage: the web block's rule switched off -> 8 of 9 red; restored.
G-18's nonce half: `secret-box.test.ts` draws 200 seals of one plaintext in one place and requires 200 distinct 24-byte
nonces and 200 distinct ciphertexts (sabotage: a constant nonce -> red, plus the existing 'different ciphertext every time' test).
NOT done: the Interpolated-`query(` rule (legitimate uses exist: `LISTEN ${channel}`, a constant column list), the PATCH
extra-`userId` mass-assignment test, the WebAuthn challenge-length and failure-latency floor tests -> section 6.10.

### 0.13 P-4 — bulk consumer throughput

Measured cause (reading, then the numbers in section 3): the budgeting consumer handled every event by marking every later
period dirty and recomputing ALL dirty periods, so a backlog of N events cost N full recomputes of the same periods — 2,737
`ledger.TransferPaired` events on the 50k corpus, about one per second. A recompute is a deterministic function of current
state, so every recompute but the last of a holder's backlog is discarded. Red first:
`packages/contexts/budgeting/test/db/consumer-backlog.test.ts` (new): twenty events through the real pump -> `expected 20 to be
less than or equal to 2` (recomputes counted through the ledger port, which each recompute reads once). Fix
(`consumer.ts`): every event still marks its periods dirty in its own transaction (a retry, a crash or a replay loses nothing),
but an event with a LATER consumed event waiting for the same holder (`seq >` and `user_id`, one probe through the receipt's
transaction) leaves the recompute to the last one. After: 1 recompute for twenty events, nothing dirty, the envelope holds all
twenty rows; a second holder's later event does not suppress the first holder's recompute (sabotage: the `user_id` predicate
dropped -> that test red; restored). `budgeting` + `budgeting-db` 35/35; the api-db budget routes and the consumer suites 9/9.
The categorisation and recurring consumers were not changed: section 3's 730-day backfill is the measurement of what is left.

## 6. The one open-items list (every `wp9.*` "open items" section, mined)

Owners: **fixed-here** (this package, red first, sections 0.x), **closed** (already closed by its owner, verified), **gate**
(the Phase 9 gate re-verifies or decides), **Chris** (only he can), **post-v1.0** (a decision, with its reason).

### 6.1 wp9.1 (soak)

| Item                                                                                          | Owner     | Disposition                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 `just soak-report`, `COMPOSE_PROJECT_NAME`, OpenAPI regen                                   | closed    | landed in W-A wiring                                                                                                                                                                                                                                                                                                                            |
| 2 the isolation guard gates only what calls it                                                | closed    | `just upgrade` calls it when `COMPOSE_PROJECT_NAME=personalfi-prod` (9.11, G-21)                                                                                                                                                                                                                                                                |
| 3 `BACKUP_MAX_AGE_SECONDS` is not passed to `api`                                             | post-v1.0 | the api's `/ops/backup-status` uses a constant (26 h = 93,600 s) and the backup healthcheck defaults to the same 93,600 s, so the two agree until an operator overrides one. Making the api honour the variable needs a config key and a route change for a knob nobody has turned; recorded here and in the RUNBOOK's wording ("default 26 h") |
| 4 the residual-transfer count is a prompt, not a verdict                                      | Chris     | by design: criterion 2 needs it at zero and he judges a non-zero month                                                                                                                                                                                                                                                                          |
| 5 "met on D" is not carried week to week                                                      | post-v1.0 | each file recomputes; the first file that reads met is the record of the date. Adding memory means the report reading its own earlier files, which was not asked                                                                                                                                                                                |
| 6 the assumptions file reads "Stale" (oldest `as_of` 2025-12-31)                              | Chris     | 05 §2's question (does a year-end constant count?): re-cite the node or accept the line in every weekly report                                                                                                                                                                                                                                  |
| 7 `backup-loop.sh:63` `psql … \| grep -q 1` under pipefail                                    | post-v1.0 | psql prints one line so it cannot SIGPIPE; a comment citing F-94-1 would close the class; not worth a change to a script the soak depends on                                                                                                                                                                                                    |
| 8 a new api process answers 503 `not_bootstrapped` until something calls `/auth/unlock-state` | post-v1.0 | existing behaviour documented in `bootstrap-user.ts`'s header                                                                                                                                                                                                                                                                                   |
| 9 timings taken at load 6-13                                                                  | closed    | superseded by the table in section 3                                                                                                                                                                                                                                                                                                            |

### 6.2 wp9.2 (real data)

| Item                                                                        | Owner     | Disposition                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `role` changes the digest and the screen but does not drive the tax default | post-v1.0 | a decision, not a defect: the holder's tax treatment is explicit (`ROTH`, `TAX_DEFERRED`, …), the role is descriptive, and tying them would let a label silently move a projection (the criterion-5 hazard 06 names). Revisit if Chris finds he mislabels |
| e2e logs `ECONNREFUSED 127.0.0.1:8080` proxy noise for unmocked calls       | post-v1.0 | harness noise, no effect                                                                                                                                                                                                                                  |
| no screenshot of O-2; no real-Plaid account                                 | Chris     | the first real projection is criterion 5                                                                                                                                                                                                                  |

### 6.3 wp9.3 (carry-overs)

| Item                                                                                                                    | Owner     | Disposition                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| C5-7's web half, the evidence panel's minor-unit formatting (G5-9), level 1's screen (G5-14), the consent screen (G5-3) | closed    | 9.6                                                                                                                                        |
| O-11 import re-validation                                                                                               | closed    | 9.11 (and the two parallel fixtures it exposed, `953074a`, `34647d6`)                                                                      |
| adding or removing a contribution plan does not re-evaluate pace                                                        | post-v1.0 | needs `removeContribution` to take a goal id, clock and correlation id plus a route edit; create and update (what G4-14 names) are covered |
| S2 baseline needs nine complete months                                                                                  | Chris     | whether a year is wanted                                                                                                                   |
| `GoalOffTrack.description` wording                                                                                      | post-v1.0 | copy                                                                                                                                       |

### 6.4 wp9.4 (upgrade)

| Item                                                | Owner                        | Disposition                                                                |
| --------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------- |
| F-94-6 (HIGH) plan-scenario backups                 | closed                       | migration 0040; **and the drill now compares the plan rows (section 0.9)** |
| F-94-5 budget persisted before a 409                | closed                       | 9.11 G-23                                                                  |
| O-94-1 a card already owing at the first period     | **fixed-here**               | section 0.4 (and a broader defect behind it)                               |
| (vi) up-to-ready above 20 s                         | **fixed-here** (re-measured) | section 4                                                                  |
| the CI workflow had never run                       | closed                       | green on the runner at three commits                                       |
| the direct jump and the chain at the release commit | Chris + orchestrator         | day 91 (the chain is not re-run here; the direct jump is, section 2)       |
| F-94-8 the apk pin policy                           | closed                       | 9.11 G-22                                                                  |

### 6.5 wp9.5 (narrator)

| Item                                                                                                                        | Owner                        | Disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| steps 1-7 at 92.9 % (a) derived headline figures with no row                                                                | gate / next narrator package | **tried, and it is not cheap:** a row for C1's `0.81%` must resolve to a snapshot path, and the evidence validator requires a row's displayed value to AGREE with the resolved raw value (`evidence_value_disagrees … claimed 0.81%`; the raw value is `0.0081`), so a display-formatted headline cannot be a row. The fix is in the envelope (a figure row with its own ref and its formatter), 9.5's code, and needs a counted run the model being stopped here does not allow. Reverted; nothing left in the tree. #38's `$2,250.00` is a sum of derived values with no snapshot path at all |
| (b) the 600-character cap cutting a slot                                                                                    | gate / next narrator package | a prompt-length rule moves the template hash (every install re-approves the preview again) and invalidates the measured 92.9 %; unmeasurable here. Specified for the next counted run: "at most three sentences" in the prompt, the grammar cap kept as the backstop                                                                                                                                                                                                                                                                                                                            |
| warm-up headroom 120 s; SB10 is a pin not a behaviour; degenerate wording under slots; the model still sees `context.today` | post-v1.0                    | recorded in wp9.5 §6                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `NARRATION_TEXT_SHOWN` stays false                                                                                          | Chris                        | until a counted run reads ≥ 95 % through step 7 or he accepts the wording residual in writing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

### 6.6 wp9.6 (advisory surface)

| Item                                                                                                               | Owner     | Disposition                                                       |
| ------------------------------------------------------------------------------------------------------------------ | --------- | ----------------------------------------------------------------- |
| shared accent `Badge` 4.28:1 in dark                                                                               | closed    | 9.8                                                               |
| `NARRATION_TEXT_SHOWN`                                                                                             | Chris     | as above                                                          |
| `narration-link.test.ts` failures                                                                                  | closed    | green on the re-run (insights 380 passed)                         |
| the kind GET's `configured` is the api's view                                                                      | post-v1.0 | can disagree with the worker only if compose is wired differently |
| grant history bounded to 200, no paging                                                                            | post-v1.0 |                                                                   |
| `InsightsScreen.consent.test.tsx` placement; the narration join's `userId` predicate not sabotaged in its own file | post-v1.0 | the route-level cross-user case is the test                       |

### 6.7 wp9.7 (plan screens)

| Item                                                                                             | Owner               | Disposition                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CF-9 destructive button contrast in dark; the accent Badge; two `h1`s                            | closed              | 9.8                                                                                                                                                                                                                                                                                                                                                                            |
| no `DELETE /plan/scenarios`: a fork cannot be removed                                            | post-v1.0           | a new route, contract change (`just openapi` + web regen) and a data-lifecycle decision (what happens to a scenario a goal or a projection cites); cut line 5.1 in 09 §1 puts 9.7's fork screens first to go. Forks stay                                                                                                                                                       |
| goals show no progress; no goal funding-accounts field in the contract                           | post-v1.0           | contract change; the plan reads funded contributions today                                                                                                                                                                                                                                                                                                                     |
| the questionnaire's `taxBracketBand` is stored but not shown                                     | post-v1.0           | display only                                                                                                                                                                                                                                                                                                                                                                   |
| `GoalSliders` seeds from labelled placeholders when the plan states none                         | closed              | labelled, not sourced, by design (C-8)                                                                                                                                                                                                                                                                                                                                         |
| `Problem.code` is not enumerated in the OpenAPI document (words list read from the api's tables) | post-v1.0, decision | `problem-words.test.ts` is the contract: it reads the typed tables as text and fails on a code with no sentence and a sentence with no code. Publishing an `enum` per operation would put ~400 codes into the document and regenerate the web client's types on every code added; the parity test already costs a failing line, not a drift. `packages/contracts` is unchanged |

### 6.8 wp9.8 (WCAG)

| Item                                                                                      | Owner          | Disposition                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Chris's Orca listening session and voice-control spot check (Q10)                         | Chris          | script in `wcag-checklist.md`; not part of "checks pass"                                                                                                                                                                                         |
| G-09, G-14, G-15                                                                          | **fixed-here** | sections 0.10-0.12                                                                                                                                                                                                                               |
| the tab panel and its `ScrollRegion` are two Tab stops for one chart                      | post-v1.0      | APG-conformant (panel `tabindex=0`); `TabsPanel` is shared by every tabbed screen and `a11y-keyboard.spec.ts` records the stops per journey, so changing it re-baselines the 55-case keyboard suite for a noise reduction, not a conformance fix |
| duplicate visible headings (top bar `h1` plus an `h2` repeat)                             | post-v1.0      | harmless; a design pass                                                                                                                                                                                                                          |
| PageUp/PageDown on sliders                                                                | post-v1.0      | not implemented by this Base UI release; arrows, Home, End and the number field satisfy 2.5.7                                                                                                                                                    |
| `/unlock` shows "Can't reach PersonalFi" in the sweep                                     | post-v1.0      | its other states are covered by Phase 1 tests                                                                                                                                                                                                    |
| O-7: the dashboard hero line still says "live, may still change" beside the new notice    | post-v1.0      | the notice sits directly under it; the sentence is true                                                                                                                                                                                          |
| the add-wallet form lives in `features/crypto` but is reached from `features/connections` | post-v1.0      | a code-organisation call; the form is now scanned and walked by keyboard                                                                                                                                                                         |

### 6.9 wp9.9 (performance)

| Item                                                             | Owner                              | Disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P-1 the job runner wakes late                                    | **fixed-here**                     | section 0.2; chain re-measured in section 3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| P-6 `/holdings`, `/investments/allocation` ~2 s at 200 positions | **fixed-here**                     | section 0.3; re-measured in section 3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| P-4 bulk consumer throughput                                     | **fixed-here** (the obvious cause) | section 0.13; the 250k-in-60 s row is still unmet and is measured, not claimed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| P-2 transfer pairing is in no shipped job                        | **Chris / gate**                   | **decision recorded, not wired.** `pairTransfers` runs in the seed loader and the `POST …/pair` confirm route only. Wiring a nightly job is small code but changes what real data shows (pairing writes `transfer_links`, emits `ledger.TransferPaired`, and moves budget actuals) one week before soak day one, with no real-data pass to judge it on. Until then criterion 2 (zero internal transfers in spend) leans on the provider's own transfer flags and the holder's manual pairing, and the weekly report's residual-transfer count is the instrument that will say whether that is enough. Top item for the gate to rule on |
| P-3 healthcheck `start_interval` on the proxy                    | closed                             | moved to the api (W-C)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| P-5 `bootstrap-user`                                             | **fixed-here**                     | section 0.5                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| cold first request after boot 0.8-1.0 s                          | post-v1.0                          | recorded, no action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `reports-aggregation.test.ts` lacks `[slow]`                     | **fixed-here**                     | marked; `check-perf-skips` now lists 10 files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| the HOST_LOADED gate lags the contention it detects              | **fixed-here**                     | section 0.14                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

### 6.10 wp9.10 / wp9.11 (security)

See section 5 for the full gap-by-gap table. Open after this package: **Chris** — the eleven accepted risks A-01…A-11; **gate / Chris** — G-04 (KEK rotation path), G-07 (`:8080` cleartext listener), G-19 (push on suspicious auth), G-30 (seccomp profile; AppArmor n/a on Arch), G-32 (panic-button dry run); **post-v1.0** — G-20, G-25 remainder, the unwritten halves of G-18 and G-28, G-31.

### 6.11 wp9.12 (docs)

| Item                                                                                                              | Owner          | Disposition                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9.11's pending RUNBOOK text                                                                                       | closed         | folded in at the W-D batch                                                                                                                                                                                                                                                                                                                |
| commands not exercised by 9.12 (database roles split, the `age` line, lockout SQL, README/RUNBOOK `docker` lines) | gate           | the stranger exercised the README path; the gate walks the rest                                                                                                                                                                                                                                                                           |
| release-notes paragraph for 9.8, the stagger and G-21…G-23                                                        | closed         | in the notes                                                                                                                                                                                                                                                                                                                              |
| Plaid Production cannot be enabled from the shipped compose                                                       | **fixed-here** | section 0.9; RUNBOOK, `.env.example` and the release notes now say it can                                                                                                                                                                                                                                                                 |
| `docs/security/crypto-inventory.md` as G-26 literally asks                                                        | decision       | **not written, on purpose.** RUNBOOK "Cryptography inventory" already is that inventory (algorithms, keys, where they live, how each rotates, the crypto-migration plan and its trigger), is the page an operator reads, and a second copy would be the first to drift (`check-docs` checks names, not tables). The ASVS V11 rows cite it |

### 6.12 wp9.13 (stranger) — handed down by the orchestrator

| Item                                                   | Owner                                       | Disposition |
| ------------------------------------------------------ | ------------------------------------------- | ----------- |
| F-13-4 `bootstrap-user` OOM-killed in the api's cgroup | **fixed-here**                              | section 0.5 |
| F-13-5 recovery codes never shown                      | **fixed-here**                              | section 0.6 |
| `nightly-perf.test.ts` red on the 2-core runner        | **fixed-here** (determinism) / open (cause) | section 0.8 |
