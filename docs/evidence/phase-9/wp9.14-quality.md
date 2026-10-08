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

### 0.14 The finisher: green at `ab40a72`, and what the kill left half-done

Finisher start 2026-10-07 22:22 EDT, load 0.5. Established at `ab40a72` before any edit: `just typecheck` clean; `pnpm exec
vitest run --project scripts --project budgeting --project budgeting-db --project platform --project investments-db --project
secretbox --project api` 59 files / 386 tests green; `platform-db` + the named `api-db` files (`budgets-card-owing`,
`holdings-reconcile`, `host-load-rule`, `soak-canary-coverage`, `soak-report`, `reports-aggregation`, `investments-perf`,
`phase3-wiring`, the budget and consumer suites, `jobs`, `pump`, `worker-restart`) 15 files / 82 passed, 1 skipped (named); web
`src/features/auth src/features/security src/lib` 7 files / 56 tests; `e2e/security.spec.ts` 3/3 (`--workers=1`). **`just lint`
was RED**: `check-schema-ownership` (inside `lint`) refused P-4's consumer fix, which read `domain_events` — the platform's
table — with raw SQL from `packages/contexts/budgeting/src/consumer.ts`. The first agent never ran the lint recipe after P-4.
Fix: the read moved to its owner as `hasLaterEvent(executor, { afterSeq, userId, eventTypes })`
(`packages/platform/src/events/backlog.ts`, exported from `@core/platform`), and the consumer calls it. Same SQL, same
transaction. After: `schema-ownership: ok`, `just lint` green (0 eslint errors; the one `useVirtualizer` warning pre-dates
this package), `consumer-backlog.test.ts` and the budgeting suites green again (the run in §0.13's numbers is unchanged
because the statement is the same).

A second half-done thing, found only by the final `just check` (the web unit run; the snapshot had run only `features/auth`,
`features/security` and `lib`): `apps/web/src/app/router.test.tsx` 'navigates to a placeholder route through the real route tree'
red, because the snapshot changed the Settings page's footer copy ("Profile, security &amp; passkeys, connections, ..." became
"Profile, passkey management, connections, ...") and the test pins that sentence. The copy is right (security is no longer
"later"); the test's regex now reads the new sentence (`apps/web/src/app/router.test.tsx`, one line). 5/5, and the whole web run
92 files / 560 tests green.

### 0.15 G-18's remainder — three tests, each sabotaged

- **WebAuthn challenge length and uniqueness** (`packages/contexts/identity/test/webauthn.test.ts`, 'draws a fresh challenge of at
  least 128 bits for every registration and every login'): 20 rounds of registration, usernameless login and step-up options,
  every challenge decodes to >= 16 bytes and all 60 are distinct. It was green first (the property held by reading, which is
  what 9.10 said). Sabotage 1, a 4-byte challenge: the WHOLE suite went red, because the table's own CHECK
  (`length(challenge) >= 16` characters, migration 0002) refuses it — a second layer 9.10 did not list. Sabotage 2, a 12-byte
  challenge (16 characters, which the CHECK admits): only the new test red, `expected 12 to be greater than or equal to 16`.
  Restored byte-identical (`grep -c SABOTAGE` 0).
- **Failure body and failure latency at the route** (`apps/api/test/db/auth-failure-uniform.test.ts`, 4 tests, the real `buildApp`,
  the production 250 ms default): a passkey assertion for a login nobody started (inside the context a `challenge_expired`), a
  wrong authenticator code and a wrong recovery code each answer 401 with the same problem body (`invalid_credential`, the
  same detail, nothing else differing but request-identifying fields), and each holds for >= 235 ms. Sabotage: the delay
  disabled -> the passkey and TOTP latency tests red (the recovery-code path stays above the floor on its own: the Argon2id
  verify is slower than 250 ms, so that case would catch only a regression that sped it up; recorded as such); a route case that
  maps `challenge_expired` to its own 401 -> the body test red. Both restored byte-identical.
- **PATCH mass assignment** (`apps/api/test/db/patch-mass-assignment.test.ts`, 4 tests: categories, accounts, goals, rules —
  the PATCH routes whose fixture is a single POST): a real change plus `userId`, `user_id`, `ownerId` (and `id`, on categories)
  naming a second holder; asserts on the ROW (`user_id` unchanged, one row), and that the second holder's list never shows it.
  Green first (every body is a stripping Zod object). Sabotage: the accounts body made `.loose()` and the handler made to
  write the body's `userId` -> `expected [ 200, 400 ] to include 404` red; restored byte-identical. NOT covered: the other six
  PATCH routes (transactions overlay, securities, budget lines, two notification routes, plan life events) — each needs a
  heavier fixture; they share the stripping-Zod mechanism, and `check-routes`-style enumeration is not worth a new script
  (-> section 6.10, post-v1.0). Interpolated-`query(` lint rule: still not written (legitimate uses exist).

### 0.16 The HOST_LOADED gate lagged the contention it detects (the Wave D verify's 248 ms)

The orchestrator's finding: `just verify` read the 50k first page at p95 248 ms at a 1-minute load of 1.29 because two samples ran
at 400 ms beside sibling test workers; alone the page reads 35.7 ms. A 1-minute average cannot see a 5-second burst, so the
over-budget reading was believed and failed a correct build. Fix (`apps/api/test/db/perf-support.ts`, shared by every perf test
through `settleLoad`): a 250 ms CPU sampler records how many cores were busy with anything but the test's own process
(`os.cpus()` busy time less `process.cpuUsage()`), and an over-budget reading inside `BURST_WINDOW_MS` (20 s) of a slot at or
above `BURST_OTHER_CORES` (3) becomes the named `HOST_LOADED` skip with the burst in its note. It can turn a failing reading into a
skip and never a passing one; on a 2-core runner the database is the only other process, so it cannot fire. Tests:
`apps/api/test/db/host-load-rule.test.ts` (11, a synthetic host: in budget passes at any load; over budget on a quiet host fails;
at or above the ceiling or inside a burst it skips by name; the window forgets). The first agent's red-first record for this
test was not written down before the kill; what I could do at the finish is the sabotage: `BURST_OTHER_CORES` made 99 (the
witness can never fire) -> `reports the worst slot inside the window` red (`expected undefined to be 6.1`); restored
byte-identical. The wiring evidence is section 3: every perf stage of the final measure passed at a load of 1.1-2.1 with no
`HOST_LOADED` skip in any of the nine logs.

### 0.17 G-29 — the soak canary reaches every text column the report can read

WP 9.1's own record (S1a/S1b) is that the canary stayed green until the seed gained a pending row: a leak through a column the seed
never filled is invisible to it. `apps/api/test/db/soak-canary-coverage.test.ts` (4 tests) parses every table the report's SQL
reads, lists their text-like columns from `information_schema` and requires each to be classified in
`soak-canary-columns.ts` as SEEDED (the soak seed in `soak-report.test.ts` puts a `CANARY-...` value there and proves it is there)
or NOT_FREE_TEXT (with a reason of at least 12 characters), and that nothing is classified that does not exist or twice.
Sabotage at the finish: `transactions.user_note` removed from SEEDED -> `every text-like column of every table the report reads is
classified` red (`expected [ 'transactions.user_note' ] to deeply equal []`), the run's other 8 tests green; restored byte-identical.

## 1. The v0.9 and v1.0 audit (09 section 1's six clauses, each with its instrument re-run at this tree)

"This tree" is `ab40a72` plus this package's uncommitted changes (section 2 lists them; none touches a shipped control except the
consumer layering move of section 0.14). Status words: **proven** (an instrument an independent run can repeat, re-run here and
passing), **needs Chris** (only he can supply it), **carried** (an agent's step the orchestrator owns and has not yet taken).

| #   | Clause                                       | Status                                                                                                            | Instrument, re-run here                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | v0.9: performance targets met                | **proven** on this host (the only named target hardware, 09 section 6 Q1)                                         | section 3: every section 3.4 budget re-measured with its load: 50k list p95 42.5 / 153.1* / 10.4 / 34.7 / 64.7 ms (200 ms; *a first-run outlier, repeats 12.4 and 10.7), Monte Carlo 552.5 ms engine / 525.6 ms HTTP (800), nightly chain **47.2 s** (300 s), RTO 26 s (1 h), RPO cited, RAM idle 310 MiB / chain 345 MiB / **boot 1.49 GiB** (2 GB). No `HOST_LOADED` skip in any log; `just check-perf-skips`: 10 perf files, 25 skip sites, every one named. Unmet and recorded, not claimed: the 250k-events-in-60-s consumer row (P-4), the cold start through Caddy (21.4-23.1 s vs 20 s) and one api-side boot at 20.71 s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 2   | v0.9: WCAG 2.2 AA checks pass                | **proven** for the automated and scripted-manual half; the listening session is **needs Chris**                   | `apps/web/src/styles/contrast.test.ts` 13/13 (sabotage: `--text-secondary` lightened -> 3 red); the a11y lane (`PW_SUITE=a11y`, sweep + keyboard + the structural checks): **164 of 165 on the first run, 165 of 165 on the repeat** (110 sweep tests: axe in both themes on every route, dialogs and tabs open, 320 px, reflow, reduced motion, plus the structural checks; 55 keyboard tests). `PW_SUITE=a11y pnpm exec playwright test --project=chromium --workers=1`, detached, 31.5 min, load 0.8-2.6. The one first-run failure was `a11y-keyboard.spec.ts:156` ('transactions: filter, open a row, split it, and make a rule') timing out at 3 minutes in the harness's landing step (`#app-content *` never became visible at `/transactions`), in the same minutes the scratch stack was being taken down; alone it passes in 9.3 s, and the whole keyboard spec re-run passes 55/55 in 5.4 min. A flaky landing, not a finding, but a recorded one. Sabotage: an `exclude:` key added to `goals.spec.ts` -> 'no axe run in the suite excludes an element' red; restored; `docs/evidence/phase-9/wcag-checklist.md` (29 met / 15 fixed / 3 manual / 8 N/A); Chris's Orca listening session and voice-control spot check (09 section 6 Q10) are a script in that file and are not part of "checks pass" |
| 3   | v0.9: security review closed                 | **the fixes are proven; the remainder is recorded and the eleven risks are needs Chris**                          | 33 gaps (1 High, 10 Medium, 19 Low, 3 process): the High and **all ten Mediums fixed** red-then-green (wp9.11 section 2; G-21's `v0.9.0` tag is Chris's); **9 Lows fully fixed**, **5 fixed with a recorded remainder** (G-14, G-15, G-18, G-25, G-28), **5 Lows recorded with a residual** (G-04, G-07, G-19, G-20, G-30); process: G-26 closed by 9.12, G-31 and G-32 recorded. The 11 proposed accepted risks A-01...A-11 are **needs Chris, in writing** (09 section 5 item 9). Re-run here: `just lint` (eslint 0 errors, schema ownership ok) and the new controls sabotaged (sections 0.10-0.17)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 4   | v0.9: a stranger can install from the README | **carried**: run 1 reached all five goals with eight findings; run 2 (zero findings is the exit test) has not run | `docs/evidence/phase-9/wp9.13-stranger.md`: run 1 in a `docker:29-dind` throwaway (build 183 s, up-to-ready 41-45 s, backup < 1 s, restore drill PASS in 38 s, `git pull && just upgrade` in 199 s). F-13-1, 2, 3, 6, 7, 8 were README text (fixed by the orchestrator); **F-13-4 and F-13-5 were product defects and are fixed here** (sections 0.5, 0.6, 4.1). Run 2 is the orchestrator's, on the final candidate, after the README sentences in section 5 are applied                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 5   | v1.0: unattended upgrade from v0.1 works     | **proven** at `ab40a72` (the direct jump); the chain and the release-commit re-run are **carried** to day 91      | `bash scripts/upgrade-test/run.sh --path direct --ci --work /tmp/wp914/upgrade` detached, 8 min: **RESULT: PASS** — W0 (`d04669e`) cold-installed and loaded through its own API (passkey, TOTP, ten recovery codes), `just upgrade` to HEAD: (i) 38 applied == 38 on disk, checksums equal (max 0040); (ii) the W0 holder, time zone, passkey (same id), TOTP and 10 recovery codes read back; (iii) master key unlocks at KEK generation 1, W0's passkey and a TOTP code log in, a W0 recovery code is accepted (`remainingCodes 9`); (iv) the W0 pre-migration backup and a HEAD backup restore into fresh projects, 101 tables == 101; (v) api and worker restart counts 0 (the W0 worker's 1 is that era's own, not counted); this run is with P-5's one-shot and the role split in the tree. `git archive` takes the COMMIT, so this tests `ab40a72`, not the uncommitted `hasLaterEvent` move; CI's upgrade-test on the orchestrator's candidate commit covers it                                                                                                                                                                                                                                                                                                                                         |
| 6   | v1.0: 90 days as Chris's only finance tool   | **needs Chris**; **not started**                                                                                  | `docs/evidence/phase-9/soak/clock.md` has no attestation row and no `day_one`; the newest weekly file is `week-00-dry-run.md` (2026-W46, "DRY RUN from seed -- NOT REAL DATA", day 29 of an assumed 2026-10-12 anchor). Day one is 2026-10-12 by default and is Chris's act (production installed, two institutions linked, other tools retired); the earliest v1.0 date is **2027-01-10**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

Cited, not re-run (the local model is stopped, and a number taken with it loaded is not a performance number): the narrator's counted
runs, `docs/evidence/phase-9/wp9.5-narrator.md` — option A steps 1-5 / 1-7 **91.1 % / 85.7 %**, option B (figure slots, contract 1.6.0)
**100 % / 92.9 %**, live red-team pass **0 of 32 payloads survived**; `NARRATION_TEXT_SHOWN` stays `false` (92.9 < 95).

### 1.1 Security review closed — every 9.10 gap, one line each

Fixed = a commit with red-first evidence in the named section; recorded = not fixed, with the residual stated; accepted-pending-Chris =
09 section 5 item 9 requires his written acceptance and none exists yet. (The 9.10 sabotage log and ASVS map are unchanged by this package.)

| Gap                                                | Sev     | Disposition                                                                                                                                                                                           | Where                                                                                                                                                                                                                                                   |
| -------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G-27 outbound TLS verification untested            | High    | **fixed**                                                                                                                                                                                             | wp9.11 section 2 (self-signed loopback server per client)                                                                                                                                                                                               |
| G-01 / CF-18 app role is the cluster superuser     | Medium  | **fixed**                                                                                                                                                                                             | wp9.11: migration 0039 `personalfi_app`; `app-role.test.ts`; split exercised on a scratch stack; the upgrade harness above ran with it                                                                                                                  |
| G-02 no session list / revoke                      | Medium  | **fixed** (api 9.11, screen here)                                                                                                                                                                     | wp9.11 section 2; section 0.7 (screen, 11 unit + 3 e2e)                                                                                                                                                                                                 |
| G-03 UV not enforced in a test                     | Medium  | **fixed**                                                                                                                                                                                             | wp9.11 section 2 (`user-verification.test.ts`)                                                                                                                                                                                                          |
| G-10 export / import stale-session                 | Medium  | **fixed**                                                                                                                                                                                             | wp9.11; `auth-security-routes.test.ts`                                                                                                                                                                                                                  |
| G-11 auth-factor step-up at the route              | Medium  | **fixed**                                                                                                                                                                                             | same                                                                                                                                                                                                                                                    |
| G-12 TOTP seed cannot be revoked                   | Medium  | **fixed** (api 9.11, screen here)                                                                                                                                                                     | wp9.11; section 0.7 (`DELETE /auth/totp` behind a confirmation)                                                                                                                                                                                         |
| G-13 logout's server-side revoke                   | Medium  | **fixed**                                                                                                                                                                                             | same                                                                                                                                                                                                                                                    |
| G-21 / CF-19 release.yml never run                 | Medium  | **fixed** for pull-and-verify; **the `v0.9.0` tag is Chris's** (09 Q8)                                                                                                                                | wp9.11 (`scripts/verify-release.sh`, `just upgrade`)                                                                                                                                                                                                    |
| G-22 / F-94-8 apk pin policy                       | Medium  | **fixed**                                                                                                                                                                                             | wp9.11 (digest pins; weekly no-cache build + trivy)                                                                                                                                                                                                     |
| G-23 / F-94-5 half-created budget, dead consumer   | Medium  | **fixed**, plus **O-94-1 and a broader defect behind it fixed here**                                                                                                                                  | wp9.11; section 0.4 (red first, 3 sabotages); `just consumer-resume`                                                                                                                                                                                    |
| G-04 KEK rotation has no operator path             | Low     | **recorded; needs Chris** (a stop/rotate/swap/start sequence on a scratch stack, then RUNBOOK)                                                                                                        | wp9.11 section 7; release notes "Known limits"; residual: a leaked master key cannot be rotated by procedure                                                                                                                                            |
| G-05 `Cache-Control: no-store`                     | Low     | **fixed**                                                                                                                                                                                             | wp9.11                                                                                                                                                                                                                                                  |
| G-06 Caddy error pages without headers             | Low     | **fixed**                                                                                                                                                                                             | wp9.11; `caddy-error-headers.test.ts`                                                                                                                                                                                                                   |
| G-07 `:8080` cleartext listener on `BIND_ADDRESS`  | Low     | **recorded; needs Chris** (the remote-access topology)                                                                                                                                                | wp9.11 section 7; residual: cleartext on whatever `BIND_ADDRESS` is (loopback by default)                                                                                                                                                               |
| G-08 PIDs caps                                     | Low     | **fixed**                                                                                                                                                                                             | wp9.11; `compose-hardening-check.sh`                                                                                                                                                                                                                    |
| G-09 post-login redirect guard                     | Low     | **fixed here**                                                                                                                                                                                        | section 0.10 (6 of 18 red first)                                                                                                                                                                                                                        |
| G-14 header / TLS / image properties by probe only | Low     | **fixed in part here** (the structural half); the live-listener half is the gate's walk                                                                                                               | section 0.11 (15 tests, 2 sabotages)                                                                                                                                                                                                                    |
| G-15 raw-HTML sinks                                | Low     | **fixed here** (lint ban); Trusted Types **recorded** (needs a report-only period)                                                                                                                    | section 0.12                                                                                                                                                                                                                                            |
| G-16 header CR/LF refusal untested                 | Low     | **fixed**                                                                                                                                                                                             | wp9.11                                                                                                                                                                                                                                                  |
| G-17 body limits untested                          | Low     | **fixed**                                                                                                                                                                                             | wp9.11                                                                                                                                                                                                                                                  |
| G-18 properties that hold with no failing test     | Low     | **fixed here** except three recorded halves                                                                                                                                                           | sections 0.12, 0.15: `Math.random` ban, nonce uniqueness, challenge length, uniform body + latency floor. Recorded: a CSPRNG-source spy for session tokens, a constant-time-compare observation (unobservable in CI), a TOTP server-clock negative test |
| G-19 no push on suspicious authentication          | Low     | **recorded; needs Chris** (whether notifications are on by default)                                                                                                                                   | wp9.11 section 7                                                                                                                                                                                                                                        |
| G-20 step-up does not rotate the access token      | Low     | **recorded** (post-v1.0): a 5-minute window in which a copied pre-step-up token is privileged                                                                                                         | wp9.11 section 7; needs a session-model change with its own red-first package                                                                                                                                                                           |
| G-24 duplicated egress dialer                      | Low     | **fixed**                                                                                                                                                                                             | wp9.11                                                                                                                                                                                                                                                  |
| G-25 security event log incomplete                 | Low     | **fixed in part** (export, import, step-up refusals, append-only); remainder (link / unlink, payload approvals) **recorded**                                                                          | wp9.11                                                                                                                                                                                                                                                  |
| G-28 properties that hold by reading               | Low     | **fixed in part here** (`sql.raw`, `shell: true`, browser storage lint; PATCH owner test on 4 of 10 routes); the interpolated-`query(` rule and the other six PATCH routes **recorded**               | sections 0.12, 0.15                                                                                                                                                                                                                                     |
| G-29 soak canary reaches only the seed's rows      | Low     | **fixed here**                                                                                                                                                                                        | section 0.17                                                                                                                                                                                                                                            |
| G-30 seccomp / AppArmor                            | Low     | **recorded; needs Chris** (a vendored profile and a cold-start walk; AppArmor is n/a on this Arch host)                                                                                               | wp9.11 section 7                                                                                                                                                                                                                                        |
| G-33 generic 500 body                              | Low     | **fixed**                                                                                                                                                                                             | wp9.11                                                                                                                                                                                                                                                  |
| G-26 documentation gaps                            | process | **closed** by 9.12 (RUNBOOK inventories, lockout section); `docs/security/crypto-inventory.md` as literally asked is **not written, on purpose** (the RUNBOOK section is the inventory, section 6.11) | wp9.12                                                                                                                                                                                                                                                  |
| G-31 no automated dependency budget                | process | **recorded** (post-v1.0): 1,026 packages, +3.3 % since the Phase 0 gate, inside the 10 % budget by hand count                                                                                         | wp9.10                                                                                                                                                                                                                                                  |
| G-32 panic button never dry-run                    | process | **recorded; needs Chris and the gate** (its session half now has the sessions screen)                                                                                                                 | wp9.10, section 0.7                                                                                                                                                                                                                                     |

Accepted risks A-01 ... A-11 (rootful Docker; TOTP / recovery-code logins are single-factor; no general API rate limit; HTTP framing
and key exchange are the platforms'; WebAuthn public keys are writable rows; no memory encryption or `mlock`; Caddy's internal CA;
no TLS on internal hops; no vault, secrets 0444 in a 0700 directory until `sudo just harden-secrets`; transaction free text not
encrypted at the application layer; logs stay on the host) are **eleven written acceptances only Chris can give**; each has its residual stated in wp9.10
section 5. Until he does, "security review closed" is proven for every Medium-and-above fix and honest about the rest, not complete.

## 2. What this package fixed or built, red first (cross-reference to section 0)

| Item                                                                          | Red first (before the fix)                                                                     | Sabotage of the control                                                            | Section  |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------- |
| P-1 the job runner slept the whole poll when a kind was at its cap            | `jobs-completion-wake.test.ts` 2 of 4 red on the unchanged runner                              | a nudge before every wait (a busy loop) -> hang                                    | 0.2      |
| P-6 `GET /holdings` and `/investments/allocation` ~2 s at 200 positions       | `prices-bounded-read.test.ts` 4/4 red (401 rows read; `priceMany` missing)                     | the route's sequential loop restored -> `price-holdings-batched.test.ts` red       | 0.3      |
| O-94-1 a card owing at a budget's first period dead-letters the consumer      | `card-owing-at-first-period.test.ts` 3 of 4 red (`identity II failed`)                         | `first` forced on every card -> the roll test red                                  | 0.4      |
| the broader defect: ANY card charge in a category with no budget line         | `card-spend-without-envelope.test.ts` 3/3 red (`owed 50.00 != available 0.00 + unfunded 0.00`) | step 3b disabled -> the api consumer test red (found by the shipped routes, C5-11) | 0.4      |
| P-4 a budgeting backlog recomputed N times                                    | `consumer-backlog.test.ts` red (`expected 20 to be <= 2`)                                      | the `user_id` predicate dropped -> the second-holder test red                      | 0.13     |
| P-4's layering: raw SQL on the platform's `domain_events` in a context        | `just lint` red (`check-schema-ownership`), found at the finish                                | `hasLaterEvent` is the platform's; `schema-ownership: ok`                          | 0.14     |
| P-5 / F-13-4 `bootstrap-user` OOM-killed inside the api's cgroup              | `justfile-recipes.test.ts` (pins `compose run --rm --no-deps`, never `exec ... api`)           | the exec form restored -> red                                                      | 0.5, 4.1 |
| F-13-5 recovery codes never shown; the sessions / sign-in-methods screen      | `SecurityScreen.test.tsx` (11), `PasskeyRegisterFlow.test.tsx` (3), `e2e/security.spec.ts` (3) | wizard step bypassed, sign-out step-up bypassed, cache clear removed -> red        | 0.6, 0.7 |
| `nightly-perf.test.ts` 49 of 56 on the 2-core runner                          | not reproduced in 6 of 6; the test now asserts its own preconditions                           | one connection's cursor nulled -> red at the new check                             | 0.8      |
| `PLAID_ALLOW_PRODUCTION` not passed by compose; the drill blind to plans      | `compose-env-passthrough.test.ts` (3); drill 3 vs 4 (section 4.2)                              | the worker's line removed -> red; old recipe PASS where the new one FAILs          | 0.9, 4.2 |
| G-09 redirect guard                                                           | `safe-redirect.test.ts` 6 of 18 red                                                            | `destination = redirect` -> 3 of 5 red in `LoginRedirect.test.tsx`                 | 0.10     |
| G-14 header / CSP / TLS properties                                            | `caddy-headers.test.ts` (15 tests, structural against the shipped Caddyfile)                   | `X-Frame-Options "SAMEORIGIN"`, `'unsafe-eval'` -> 2 red                           | 0.11     |
| G-15, G-28, G-18 lint bans                                                    | `eslint-html-sinks.test.ts` (13) runs the real config                                          | the web block switched off -> 8 of 9 red                                           | 0.12     |
| G-18 remainder: challenge length, uniform failure body + latency, PATCH owner | green first (held by reading); all three sabotaged                                             | 12-byte challenge; delay disabled; a route case; `.loose()` + hostile write        | 0.15     |
| HOST_LOADED lags the contention it detects                                    | the Wave D verify's 248 ms at a load of 1.29                                                   | `BURST_OTHER_CORES` = 99 -> red                                                    | 0.16     |
| G-29 soak canary coverage                                                     | `soak-canary-coverage.test.ts` (4)                                                             | a SEEDED entry removed -> red                                                      | 0.17     |

Files touched since `ab40a72` (this finisher): `packages/platform/src/events/backlog.ts` (new), `packages/platform/src/index.ts`
(one export), `packages/contexts/budgeting/src/consumer.ts`, `packages/contexts/identity/test/webauthn.test.ts`,
`apps/api/test/db/auth-failure-uniform.test.ts` (new), `apps/api/test/db/patch-mass-assignment.test.ts` (new),
`apps/web/src/app/router.test.tsx` (one regex), `docs/TESTING.md`, `docs/RELEASE-NOTES.md`, `docs/evidence/phase-9/wp9.14-quality.md`. No dependency, lockfile, contract, compose,
vitest-config or CI change.

## 3. The final RAM and perf re-measure (after 9.11, P-1, P-4, P-6 and the other fixes)

Host: AMD Ryzen 5 3501U, 4 cores / 8 threads, 23 GiB, Linux 7.2.6-arch2-1, Docker 29.8.1, Node 26.9.0 (the host 9.9 measured).
**Conditions, each checked by `/tmp/wp914/measure.sh` before every stage:** the 1-minute load below 3, no image build running,
no `pf-stranger-dind` and no model container (the local model is stopped; `pgrep` for it finds nothing), and nothing of this
package's other work run beside it (the image build ended at 22:39, before the first stage; the finisher edited documents only
while a stage ran). Stack: compose project `pf-qa` (127.0.0.1:8491/8492), images `pf-qa/*:wp914-ab40a72-fin` built from the
working tree on `ab40a72` plus this package's uncommitted fixes (`hasLaterEvent` and the three G-18 tests; the production code
that differs from `ab40a72` is the consumer layering fix of section 0.14 and nothing else), the 9.9 dataset (50,040 transactions,
`scripts/perf/load-scale.ts --months 1264`), a bootstrapped holder, one baseline plan, `advisor_token_secret` set so the insights
module and its nightly schedule are on, and 35 of the 40 builtin advisors granted their requested scopes through the real routes
(the other five refused with 422, exactly as in 9.9). The stack scripts are 9.9's `scripts/perf/*.sh` with the project name and
scratch directory substituted (a mechanical `sed`, diffed: nothing else differs). Raw output: `/tmp/wp914/fin2/`.

### 3.1 The scratch stack (RAM, boot, RTO, through Caddy)

| Row                                                                                       | 9.9 (`535b40a`)                                                     | Now                                                                                                                                                                                | Load at measurement                                     | Instrument                                              |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------- |
| **RAM, idle ten minutes** (cgroup `anon`, 2 s, 285 samples; insights on)                  | mean 316.7, max 331.4 MiB                                           | **mean 310.0, max 319.7 MiB** (api 139.0, worker 118.5, db 41.0, proxy 11.4); charged mean 433.5, max 444.3 MiB                                                                    | 0.27 0.78 0.85 -> 0.26 0.34 0.58                        | `scripts/perf/sample-rss.sh --seconds 600 --interval 2` |
| **RAM, boot peak** (api + worker Argon2id m = 1 GiB, t = 4, p = 4), 3 boots               | 2,366.8 / 2,426.3 / 2,359.8 MiB                                     | **1,488.9 / 1,401.2 / 1,410.2 MiB** whole-project RSS; charged 1,607.2 / 1,526.5 / 1,534.1 MiB; per-container peak api 1,202 / 1,190 / 1,197, worker 1,177 / 1,174 / 1,181 MiB RSS | 0.13 0.35 0.72, 1.22 0.65 0.80, 1.27 0.88 0.87 (before) | `scripts/perf/boot-breakdown.sh` x3                     |
| **RAM through one nightly chain** (the real worker)                                       | mean 328.6, max 351.3 MiB (worker 134.5, api 158.6, db 56.9)        | **mean 321.6, max 344.5 MiB** (worker 140.4, api 147.6, db 50.7); charged mean 446.9, max 472.5 MiB; 433 samples                                                                   | 0.26 0.34 0.58 -> 0.22 0.28 0.52                        | `scripts/perf/nightly-on-stack.sh`                      |
| **Nightly chain on the real worker**, per stage (each includes <= 30 s of scheduler tick) | 34.4 / 34.4 / **229.3** / 34.4 s = 332.5 s                          | 34.4 / 34.4 / **34.3** / 56.0 s = **159.2 s**; the insights stage (`insights.run_all` -> 40 x `insights.run`) is the P-1 stage; handler work in the whole chain 1.9 s              | as above                                                | same                                                    |
| **Cold start**, `up -d` to the api's own `/ready` / through Caddy                         | 19.45, 19.78, 19.67 s / 24.78, 24.99, 25.40 s                       | **19.73, 19.78, 20.71 s** / **21.36, 22.08, 23.10 s**; up -d returned after 22.0 s on the third                                                                                    | 0.13, 1.22, 1.27                                        | `scripts/perf/boot-breakdown.sh` x3                     |
| **RTO 1 h**: backup, then `just restore-drill` to `/ready`                                | `rto_seconds` 36 (47.8 s wall; backup 3.5 s)                        | **`rto_seconds` 26**; restore-drill wall 34.4 s; backup 3.6 s (122 MB database, 12,028,649 encrypted bytes); `ops_restore_drills` row `pass                                        | 26                                                      | 101                                                     | 101 | 0040` | 1.12 0.53 0.54 -> 1.51 0.68 0.59 | `scripts/perf/rto-drill.sh` |
| **List through Caddy** (curl, TLS, a fresh process per call), p95                         | first 53.4, deep 18.2, filter 14.7, `coffee` 53.6, `planet` 81.8 ms | first **51.7**, deep **17.2**, filter **14.8**, `coffee` **58.6**, `planet` **82.8** ms (p50 36.0 / 12.7 / 11.3 / 43.3 / 59.0)                                                     | 0.47 -> 0.70                                            | `scripts/perf/curl-pass.sh --port 8491`                 |
| **Dashboard aggregate** (4 requests, concurrent, through Caddy)                           | p50 24.5, p95 27.9 ms                                               | p50 26.9, **p95 34.1** ms; the first call of the run 70.5 ms                                                                                                                       | 1.12                                                    | same                                                    |

Reading the rows. **The boot peak is 1.4-1.5 GiB, not 2.4:** 9.11's advisory lock holds (`worker ... kekDerivationLock waitedMs 4733`
in boot 3's log; the worker is ready 5-9 s after the api), and the peak is one 1.2 GiB derivation plus Postgres and Caddy; the
whole-stack figure never crosses 2 GiB, so the RAM clause (under 2 GB without the LLM profile) is met at every phase, with the
boot peak the largest at 1.49 GiB. **The cold start meets 20 s at the api in two boots of three and misses by 0.7 s in the third**
(20.71 s at a load of 1.27 before the boot and 1.78 after); through Caddy it is 21.4-23.1 s, so the budget as 9.9 read it
("including migrations", at the container) is within noise of 20 s and the probe-cadence through-Caddy figure is above it, as 9.9
found. The stagger did not move the api's readiness (the api derives first); it moved the worker's. I did not tune further (the
measured composition of a boot: 7 s Postgres start with a 122 MB database, 1 s pre-migrate and migrator, 5.9 s KEK derivation,
~1.1 s listen). **The nightly chain on the real worker lost 173 s**: the insights stage is no longer 229 s of waiting for 2 s of work
(P-1 closed on the real worker, not only in the vitest harness). The 56.0 s of the last stage carries 0.03 s of handler work;
the scripts wait on the 30 s scheduler tick and I did not find why that stage waited a second tick (one sample; not a budget row).
**Idle RSS is unchanged (310 vs 317 MiB),** so nothing added in Phase 9 (the security screen, the role split, the stagger) costs
resident memory.

### 3.2 The vitest budgets (each stage started by `measure.sh` after its own wait for a 1-minute load below 3)

Each reading prints its own load; the table repeats it. Commands are 9.9's, unchanged. "9.9" is `wp9.9-perf.md` section 1.

| §3.4 budget / row                                                                           | 9.9 p50 / p95                        | Now p50 / p95                                                                                                                                                     | Load at measurement                       | Verdict             |
| ------------------------------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------- |
| **50k list, first page** (over real HTTP, 40 samples)                                       | 24.5 / 37.6 ms                       | 25.5 / 42.5 ms; rerun 1: 26.0 / 45.3; rerun 2: 24.3 / 41.8                                                                                                        | 1.61 (reruns 1.21, 1.23)                  | pass                |
| 50k list, deep keyset page                                                                  | 7.8 / 15.2 ms                        | 8.4 / **153.1** ms (first run: six slow samples of 37-261 ms; **rerun 1: 7.5 / 12.4; rerun 2: 8.6 / 10.7**)                                                       | 1.61 (reruns 1.21, 1.23)                  | pass                |
| 50k list, account + year filter                                                             | 8.9 / 14.0 ms                        | 7.3 / 10.4; rerun 9.5 / 15.6; 10.6 / 14.7 ms                                                                                                                      | same                                      | pass                |
| 50k list, search `coffee`                                                                   | 29.4 / 35.5 ms                       | 30.8 / 34.7; rerun 31.6 / 47.8; 31.1 / 37.1 ms                                                                                                                    | same                                      | pass                |
| 50k list, search `planet fitness` (rare)                                                    | 50.4 / 58.0 ms                       | 52.8 / 64.7; rerun 51.3 / 73.3 (max 340); 51.8 / 75.8 (max 362) ms                                                                                                | 1.64; reruns 1.36, 1.21                   | pass                |
| 50k list in-process (`listTransactions`)                                                    | p95 2.2 / 2.3 / 2.3 / 4.3 / 2.7 ms   | p95 2.3 / 3.1 / 2.3 / 3.9 / 2.4 ms (first / deep / filter / trigram / pending)                                                                                    | 1.64                                      | pass                |
| **Monte Carlo 10k paths x 40 y, engine alone** (25 samples)                                 | 530.9 / 543.1 ms (cpu 524.9 / 537.4) | wall 529.2 / **552.5** ms; thread cpu 524.2 / 546.8; budget 800                                                                                                   | 1.62 -> 1.63                              | pass                |
| Monte Carlo, whole path over HTTP (fresh fork per sample, n = 12)                           | 511.8 / 532.0 ms                     | 506.0 / **525.6** ms                                                                                                                                              | 1.82                                      | pass                |
| **Identical seed => identical bytes** (REP1)                                                | pass                                 | 5/5 pass                                                                                                                                                          | 2.09                                      | pass                |
| **Nightly chain**, first sync start -> last job end (8 connections, 730 d)                  | **243.4 s**                          | **47.17 s** (03:15 sync + consumers 29.59, pairing 6.91, 04:00 net worth 0.82, 04:15 insights 6.68); 20,752 backfilled rows, delta 56, pairing 832 of 20,801 legs | 1.41 -> 1.25 (stage start / backfill end) | pass (< 300 s)      |
| First 730-day backfill (**recorded, not budgeted**)                                         | 584.1 s                              | 616.9 s (33.6 rows/s)                                                                                                                                             | 1.25                                      | recorded            |
| **RTO 1 h**, **RPO 24 h**                                                                   | 36 s; cited                          | 26 s (section 3.1); RPO cited from WP 9.1 (nightly cadence + the 26 h staleness check)                                                                            | 1.12                                      | pass                |
| **RAM** under 2 GB without the LLM profile                                                  | idle 317, chain 351, boot 2.4 GiB    | idle 310, chain 345 MiB, **boot 1.49 GiB** (section 3.1)                                                                                                          | 0.27 / 0.26 / 0.13-1.27                   | pass                |
| _(informational)_ `GET /holdings`, Phase 3 seed (WP 3.14's 200 ms)                          | 18.9 / 34.5 ms                       | 13.8 / 20.4 ms                                                                                                                                                    | 1.93                                      | pass                |
| _(informational)_ `GET /investments/allocation`, same                                       | 18.0 / 31.5 ms                       | 18.4 / 23.4 ms                                                                                                                                                    | 1.93                                      | pass                |
| _(informational)_ `GET /net-worth/series` 180 days                                          | 9.1 / 15.1 ms                        | 7.8 / 14.6 ms                                                                                                                                                     | 1.93                                      | pass                |
| _(informational)_ **`GET /holdings` on the scale seed** (200 positions, 365,000 price rows) | 1,995.7 / **2,050.9** ms             | 45.5 / **62.4** ms (30 samples; the profile: read holdings 7 ms, pricing 14 ms for 200 securities)                                                                | 1.69                                      | **P-6 closed: 33x** |
| _(informational)_ **`GET /investments/allocation` on the scale seed**                       | 1,896.0 / **2,012.4** ms             | 30.7 / **46.8** ms                                                                                                                                                | 1.69                                      | **P-6 closed: 43x** |
| _(informational)_ `GET /net-worth/series` 1,825 points (budget 150 ms)                      | 41.0 / 50.2 ms                       | 39.4 / 54.6 ms                                                                                                                                                    | 1.82                                      | pass                |
| _(informational)_ `GET /reports/spending` 50k                                               | 31.1 / 39.9 ms                       | 28.1 / 43.9 ms                                                                                                                                                    | 1.41                                      | pass                |

Not re-run, and said so: the 250k-row list (9.9 informational; its heaviest cost is a corpus load of about 5 minutes and the
number is not a gate), `GET /net-worth/series`'s other sizes, and the narrator's live numbers (cited in section 1).

Reading the table. **No budget fails.** Every stage ran at a 1-minute load between 1.2 and 2.1 (the load average includes the
test's own corpus load, which is why a "quiet" host reads above 1 here); no stage was skipped as `HOST_LOADED`. **One reading
needs its caveat, not its excuse:** the first 50k run's deep keyset p95 of 153.1 ms is six slow samples out of forty (37, 37, 50,
80, 153 and 261 ms against a p50 of 8.4 ms) taken right after the 78 s corpus load, and it still passes the 200 ms gate; two
repeats at a load of 0.7-0.8 before they started read 12.4 and 10.7 ms. The occasional single slow sample (a 261 ms first page,
a 340 and a 362 ms rare-word search in the repeats, once per run) is in the maximum, not in p95, and was in 9.9's maxima too. I
did not find its source and do not claim one (candidates: a Postgres checkpoint or autovacuum after the corpus load, the idle
`pf-qa` stack's scheduler tick on the same cores). **The two regressions 9.9 reported are fixed and measured: the nightly chain
went from 243.4 s to 47.2 s (P-1) and the 200-position holdings read from 2.05 s to 62 ms (P-6).** P-4's row, 250k events in 60 s
(09 section 5.3), is **still unmet and is not claimed**: the 20,752-row backfill takes 617 s, as in 9.9 (584 s), because that
test's holder has no budget, so it never exercises the budgeting consumer; the cost left in a first sync of years of history is
the categorisation and recurring consumers' per-page re-reads, as the release notes now say (section 6.9).

## 4. Proofs that need the scratch stack (P-5, F-13-4 and the restore drill's plan row), and `docs/TESTING.md`

### 4.1 `just bootstrap-user` in its own one-shot container (P-5, F-13-4)

On `pf-qa` (images `wp914-ab40a72-fin`, the stack up and healthy, the api having served for an hour). First install
(the first agent's run, 20:00 EDT, `/tmp/wp914/qa/`): the recipe printed `bootstrap-user: running in its own one-shot container
(the stack is up)`, created the holder, seeded 153 categories, 40 advisor manifests and the schedules, derived the key
(`argon2id m=1048576 KiB t=4 p=4, 5714 ms`), printed the enrolment link and exited 0; the api's cgroup `memory.current` was sampled
every 200 ms around it (74 samples, **max 175.1 MiB**, unchanged from its idle). Finisher's re-run, `reissue=true` on the same
stack with the api's cgroup AND the one-shot's own cgroup sampled every 100 ms (`/tmp/wp914/bootstrap-measure.sh`, load 1.10 before):
**rc 0 in 10 s; the one-shot container peaked at 1,200 MiB (`memory.peak`; `memory.current` max 1,190 MiB) in its own cgroup, whose
limit is the api service's 1536M; the api cgroup read 175.7 MiB at its maximum, `OOMKilled false`, restart count 0, and its
`memory.peak` (1,268,846,592 bytes) is the boot's and did not move**; key custody `argon2id ... 5658 ms`; no one-shot left behind
(`--rm`). So F-13-4's mechanism (the derivation in the api's cgroup, where the api's ~140 MiB working set plus a 1.4 GiB
derivation crossed 1.5 GiB) cannot recur from this recipe: the kernel's victim is now the one-shot, never the api. The one-shot's
own margin is 336 MiB (78 % of 1536M), the same as a boot derivation, and `scripts/justfile-recipes.test.ts` is the red-first
control (section 0.5). Not measured: the stranger's 6 GiB dind host (run 2 is the orchestrator's, on the final candidate).

### 4.2 The restore drill holds a plan row (the F-94-6 class)

Four drills on `pf-qa` (`/tmp/wp914/qa/drill-*.out`, the first agent, 20:00 EDT; loads 1.4-2.0), the recipe being the working tree's
`justfile` (assertion 2b) unless noted:

| #   | State of the live database and the backup                                                                         | Result                                                                                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | live holds no plan; a backup taken                                                                                | PASS, with `WARNING: the live database holds no plan scenario, so this drill cannot see a backup that fails to restore one (F-94-6)`; `plan_scenarios rows, restored / live: 0 / 0` |
| 2   | a baseline plan saved through the real route (201); a backup taken after it                                       | PASS; `plan_scenarios rows, restored / live: 1 / 1`; `/ready` 200 from the restored database                                                                                        |
| 3   | the plan deleted from live after that backup; the PREVIOUS recipe (`git show HEAD:justfile`, before this package) | **PASS** — the old drill cannot see the difference                                                                                                                                  |
| 4   | the same state, the new recipe                                                                                    | **FAIL**: `ASSERTION FAILED: restored plan_scenarios row count (1) != live (0)`, `just restore-drill exited non-zero`                                                               |

Row 3 against row 4 is the sabotage read both ways: the assertion is what turns the state red, and a recipe without it passes it.
The comparison is symmetric (it fails on any mismatch, in either direction); I did not reproduce the other direction at the finish (a backup that restores fewer plan rows than live holds needs a deliberately broken backup). The RTO row of section 3.1 (26 s) is the same recipe on the 50k database, with a plan in it: `pass|26|101|101|0040`.

### 4.3 `docs/TESTING.md`

The Phase 9 section (written by the first agent, completed here) has: the instruments clause by clause with their commands,
`PW_SUITE` and the lanes CI runs (`functional` in `web`, `a11y` in `web-a11y`, unset runs all), the lint bans and the rule that
selectors live in the shared lists, the standing checks and the order that does not make one disturb another, the
second witness of the load rule, how to re-measure on a scratch stack (copy `scripts/perf/*.sh`, substitute the project, build
first, wait for a quiet host), the stranger harness (`scripts/stranger/run2.sh`), the upgrade harness, and a table of what this
package changed and where each change is tested.

## 5. Wiring for the orchestrator (files this package does not own, and shared files)

**1. `README.md`, step 9 ("Create your account")** — replace the paragraph that begins "This derives an encryption key inside the running
`api` container" with:

> This starts a short-lived container of its own for the key derivation (about 1.2 GiB of memory for about six seconds, under the
> same 1536M limit as the `api` service), so the running `api` is never the process the kernel can kill. Run it once the stack is
> up. If it ever ends with `exit code 137`, the host did not have that memory free: stop other memory users (the local model
> first) and run the same command again with `reissue=true` added, which issues a fresh link.

and replace "Enrol a passkey on this device and, when the wizard offers it, a backup passkey on a second device (a phone or a
security key). This release does not show recovery codes at enrolment; the backup passkey is your second way in." with:

> Enrol a passkey on this device and, when the wizard offers it, a backup passkey on a second device (a phone or a security key).
> The wizard then shows your ten recovery codes, once: save them somewhere that is not this computer and tick "I have saved these
> codes somewhere safe" to continue. You can skip that step and create them later in Settings › Security › Recovery codes; a
> new set replaces the old one.

**2. `RUNBOOK.md`**

- Step 7 ("Create the account holder"), the sentence "enrol at least two authenticators (D21), and save the ten recovery codes somewhere
  that is not this host": keep, and append "The wizard shows the codes once after the backup-passkey step; if you skipped it,
  Settings › Security › Recovery codes creates a set (each new set replaces the last)."
- "Resource envelope", the paragraph beginning "`just bootstrap-user` (first install, or `reissue=true`) derives a third key **inside the api
  container**": replace with "`just bootstrap-user` (first install, or `reissue=true`) derives its key in a one-shot container
  (`docker compose run --rm --no-deps`) made from the api service's own definition: the same image, secrets, read-only root and
  1536M limit, in its own cgroup. WP 9.14 measured it at 1.2 GiB for about six seconds while the running api stayed at 176 MiB. It
  takes the same derivation lock as the api's and worker's own, so it never overlaps them."
- The same section's sentence "200 held positions make `GET /holdings` take about 2 s (WP 9.9 finding P-6, not yet fixed)": replace
  with "200 held positions make `GET /holdings` take about 60 ms (2 s before WP 9.14's bounded, batched price read)".
- Troubleshooting, the entry "`just bootstrap-user` ends with `exit code 137` after "deriving the key-encryption key"": replace with
  "**`just bootstrap-user` ends with `exit code 137` after "deriving the key-encryption key".** The recipe runs the derivation in its
  own one-shot container with a 1536M limit; the kernel OOM-killed that container because the host had less than about 1.5 GiB
  free. The running `api` is not affected. The user row was already written, so the next plain run says `A user already exists`:
  free memory (stop `ollama` first) and run the same command with `reissue=true`, which issues a fresh one-time link."

**3. `docs/RELEASE-NOTES.md`** — applied by this package (the file is in neither of the lists): the "Known: a card already owing ..."
sentence replaced; two bullets added under "What changed" (recovery codes and sessions in the app; `bootstrap-user` in its own
container). The P-1, P-6 and Plaid lines were already there and the measurements above agree with them (243 s -> 47.2 s; 2.05 s ->
62 ms; 616.9 s and 33.6 rows/s). One line to change if the orchestrator wants it exact: the boot-memory bullet says the worker is
ready "~6 s after the api"; measured 5-9 s (boots 1-3).

**4. `.github/workflows/ci.yml` (jointly; proposals only, none required).** (a) No new vitest project: every test this package added is
in `scripts`, `api`, `api-db`, `identity-db`, `platform-db`, `budgeting-db`, `investments-db`, `secretbox` or the web unit and
Playwright lanes, and `check-ci-projects` reads 42/42. (b) `e2e/security.spec.ts` is in the `chromium` `testMatch`, so the `web`
job (`PW_SUITE=functional`) runs it. (c) The `lint` job already runs `lint:schema-ownership`, which is the control that caught
section 0.14. (d) Optional: print `nightly-perf`'s new `perf nightly all sync runs` line into the job summary so the next 49-of-56 shows
its connection ordinal without opening the log. (e) The upgrade-test job should run on the candidate commit (this package's direct
jump tested `ab40a72`, because `git archive` takes the commit, not the working tree).

**5. `just openapi`: not needed.** No route, schema or problem code changed in this package: the security screen uses the generated
operations that 9.11 added (`GET/DELETE /auth/sessions`, `DELETE /auth/totp`, `POST /auth/recovery-codes`), and `packages/contracts`
is untouched.

**6. Stranger run 2.** Apply items 1 and 2 first, commit, then run `scripts/stranger/run2.sh` on that candidate; F-13-4 and F-13-5
are the two findings whose fixes are in the product (not the README) and the run is what proves them from a stranger's host.

**7. Scratch state.** `docs/TESTING.md`'s Phase 9 section is complete. `/tmp/wp914/` holds the raw logs (measure, rerun, bootstrap,
upgrade report, a11y) and may be deleted after the gate. The scratch stack `pf-qa` was taken down at 23:55 with
`docker compose -p pf-qa down -v` (its own project only): no `pf-qa` container, volume or network remains; its images `pf-qa/*` are
kept (no prune). The upgrade harness tore down its own `pf-upgrade-direct*` projects.

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

| Item                                                | Owner                                            | Disposition                                                                                                                                                                                                                                           |
| --------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-94-6 (HIGH) plan-scenario backups                 | closed                                           | migration 0040; **and the drill now compares the plan rows (section 0.9)**                                                                                                                                                                            |
| F-94-5 budget persisted before a 409                | closed                                           | 9.11 G-23                                                                                                                                                                                                                                             |
| O-94-1 a card already owing at the first period     | **fixed-here**                                   | section 0.4 (and a broader defect behind it)                                                                                                                                                                                                          |
| (vi) up-to-ready above 20 s                         | **re-measured; one boot of three over by 0.7 s** | section 3.1: the api's `/ready` 19.7 / 19.8 / 20.7 s at a quiet host, through Caddy 21.4-23.1 s; the harness's upgrade path (38 migrations, just after a build, load 2.4-4.5) 30.6 s is not believed as a performance number. For the gate to rule on |
| the CI workflow had never run                       | closed                                           | green on the runner at three commits                                                                                                                                                                                                                  |
| the direct jump and the chain at the release commit | Chris + orchestrator                             | day 91 (the chain is not re-run here; the direct jump is, section 2)                                                                                                                                                                                  |
| F-94-8 the apk pin policy                           | closed                                           | 9.11 G-22                                                                                                                                                                                                                                             |

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

| Item                                                             | Owner                                | Disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P-1 the job runner wakes late                                    | **fixed-here**                       | section 0.2; chain re-measured in section 3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| P-6 `/holdings`, `/investments/allocation` ~2 s at 200 positions | **fixed-here**                       | section 0.3; re-measured in section 3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| P-4 bulk consumer throughput                                     | **fixed-here** (the budgeting cause) | section 0.13 (and 0.14); the 250k-in-60 s row is **still unmet and is measured, not claimed** (section 3.2: a 20,752-row first backfill takes 617 s; the cost left is the categorisation and recurring consumers' per-page re-reads, 33.6 rows/s)                                                                                                                                                                                                                                                                                                                                                                                      |
| P-2 transfer pairing is in no shipped job                        | **Chris / gate**                     | **decision recorded, not wired.** `pairTransfers` runs in the seed loader and the `POST …/pair` confirm route only. Wiring a nightly job is small code but changes what real data shows (pairing writes `transfer_links`, emits `ledger.TransferPaired`, and moves budget actuals) one week before soak day one, with no real-data pass to judge it on. Until then criterion 2 (zero internal transfers in spend) leans on the provider's own transfer flags and the holder's manual pairing, and the weekly report's residual-transfer count is the instrument that will say whether that is enough. Top item for the gate to rule on |
| P-3 healthcheck `start_interval` on the proxy                    | closed                               | moved to the api (W-C)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| P-5 `bootstrap-user`                                             | **fixed-here**                       | section 0.5                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| cold first request after boot 0.8-1.0 s                          | post-v1.0                            | recorded, no action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `reports-aggregation.test.ts` lacks `[slow]`                     | **fixed-here**                       | marked; `check-perf-skips` now lists 10 files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| the HOST_LOADED gate lags the contention it detects              | **fixed-here**                       | section 0.16                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

### 6.10 wp9.10 / wp9.11 (security)

Section 1.1 is the gap-by-gap table. Open after this package: **Chris** — the eleven accepted risks A-01...A-11, and the first
release tag (G-21's last step); **gate / Chris** — G-04 (KEK rotation path), G-07 (`:8080` cleartext listener), G-19 (push on
suspicious auth), G-30 (seccomp profile; AppArmor n/a on Arch), G-32 (panic-button dry run); **post-v1.0** — G-20 (step-up does
not rotate the access token), G-25 remainder (link / unlink and payload-approval events), G-31, and the unwritten remainders of
G-18 (a CSPRNG-source spy for session tokens, a TOTP server-clock negative test; the constant-time compare is unobservable in
CI) and G-28 (the interpolated-`query(` lint rule, which has legitimate uses — `LISTEN ${channel}`, a constant column list —
and wants an allow-list; the PATCH owner test on the other six PATCH routes: transactions overlay, securities, budget lines, two
notification routes, plan life events). Trusted Types (G-15) needs a report-only period first.

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

## 7. Open items

### 7.1 For the Phase 9 gate (the independent Opus reviewer; it may not validate its own fixes)

1. **Re-run the load-bearing proofs on the candidate commit, not on this tree:** the upgrade direct jump (this package's ran at
   `ab40a72`), every section 3.4 budget (section 3 gives the method and the scripts; copy `scripts/perf/*.sh` with a project name of its
   own), the a11y lane and the contrast test, and the stranger run 2.
2. **Walk what no unit test reaches:** every header on every response class, TLS versions and suites on the wire, TRACE, and a kitchen-sink
   route (the live-listener half of G-14; `caddy-headers.test.ts` is the structural half). The Security screen in a real browser through Caddy
   (sessions list after a passkey assertion, sign out another session, recovery codes shown once). The cold-install walk with one
   nightly chain and one shortened weekly Brief fired.
3. **Rule on the cold start.** The api's `/ready` is 19.7 / 19.8 / 20.7 s on a quiet host and 21.4-23.1 s through Caddy against a 20 s
   budget that 09 section 5.3 words as "including migrations"; the third api reading is 0.7 s over. Either the budget is read at the
   container and met within noise, or it is a miss to carry.
4. **Rule on P-2 (transfer pairing is in no shipped job).** Recorded, not wired (wp9.9 section 9; section 6.9 here): wiring a nightly pairing job changes
   what real data shows one week before soak day one. Criterion 2 leans on the provider's own transfer flags and the holder's manual
   pairing until then; the weekly report's residual-transfer count is the instrument that will say whether that is enough.
5. **The 49-of-56 cause is open.** `nightly-perf.test.ts` now asserts every connection's first sync, stored cursor and absence of dead jobs
   before the night, and prints every sync run; if CI shows it again it stops at that check and names the connection. Not reproduced in
   6 of 6 attempts here (section 0.8). A real recurrence is a product defect to fix, not a race to retry.
6. **Sabotage the new controls that this package added and observe red** (its own record is sections 0.2-0.17 and 4): the job runner's
   completion wake, the bounded price read, identity II's first-period debt and the no-envelope step, the backlog recompute, the bootstrap
   one-shot (the recipe test), the restore drill's plan row, `PLAID_ALLOW_PRODUCTION` passthrough, the redirect guard, the Caddy header
   test, the four lint bans, the three G-18 tests, the soak canary coverage, the second load witness.
7. **Two known budgeting limits, post-v1.0, for the gate to accept or escalate.** Identity II is asserted against the card's balance NOW
   for every dirty period, so a past period recomputed after later activity compares a stale period with today's balance (the 13-roll
   test keeps closed periods clean, so it has not bitten). A card charge the holder excluded from totals fails identity II permanently
   (the refusal is pinned as the control working); an operator needs `just consumer-resume` after un-excluding.
8. **An intermittent 0.5-1.1 s stall, in the host or the test process, that the second load witness cannot see.** The 50k list showed one
   261-362 ms sample per run in three runs (once in p95 position at 153 ms, still passing 200 ms). The final `just check` then failed
   once, `holdings-scale-perf.test.ts` 'GET /holdings and GET /investments/allocation over the scale seed stay inside 200 ms (P-6)',
   with `GET /investments/allocation` at p95 **905 ms** (p50 normally 30 ms) at a 1-minute load of 1.43, in the 37-minute parallel
   run (408 files); that is the Wave D class (a correct build failed under sibling workers) and the burst witness did not fire
   (it needs three other busy cores in one 250 ms slot). Re-run alone: 8 runs, **7 pass** (holdings p95 64-82 ms, allocation p95
   44-65 ms) and **1 fail** (`GET /holdings` p95 736.8 ms, max 1,144.9 ms, p50 49 ms, load 1.4-1.9), so the stall also happens with
   nothing else of mine running. Two probes did not find the cause: `PGOPTIONS='-c jit=off'` (3 of 3 passed, but one run still had a
   481 ms maximum, so JIT is not it), and a GC trace (`--trace-gc` is refused in `NODE_OPTIONS`; vitest 5 has no `--poolOptions`
   flag; I did not pursue it, and the dev cluster's own settings are off limits to read). The reading is not the P-6 fix regressing
   (the other readings of the same two reads sit at 44-82 ms), and it is not claimed to be anything else. For the gate: treat a perf
   red whose p50 is normal and whose maximum is 10x the p50 as this class, **re-run alone** (the orchestration rule), and if it
   recurs on a quiet host in p95 position, trace it; a cheap hardening that does not weaken a budget is a confirm pass (a red
   reading is taken once more before it counts), which would change `assertWithinBudget`'s contract for nine files and was not
   done here.

### 7.2 For Chris

1. **Written acceptance (or a demand to fix) for the eleven residual risks A-01 ... A-11** (wp9.10 section 5), and for the Low gaps recorded with a
   residual: G-04 (no operator procedure for rotating the master key), G-07 (the `:8080` cleartext listener follows `BIND_ADDRESS`; set
   it to loopback, or accept the LAN exposure), G-19 (whether a lockout or a factor change should push a notification by default), G-20
   (a copied pre-step-up token is privileged for the five minutes after a step-up), G-30 (seccomp is the daemon default; AppArmor n/a on
   Arch), G-32 (the panic button has never been dry-run; its session half now has the Security screen).
2. **The first release tag `v0.9.0`** (09 section 6 Q8): until it is pushed, `release.yml` has never run and the pull-and-verify path is
   proven only against the not-yet-published release (refused) and the self-test's known-good and known-bad images.
3. **Soak day one is yours: 2026-10-12 by default.** Production installed, two institutions linked, other tools retired, then one
   `day_one` row in `docs/evidence/phase-9/soak/clock.md` and one `attest` row a week. The newest weekly file is the week-00 dry run, built from a seed:
   **the soak has not started and no real data has been seen by any instrument in this package.**
4. **Hand items on the host:** `sudo just harden-secrets` on the production install (A-09 / C-16); swap off or encrypted and core dumps
   off (A-06); the Orca listening session and the voice-control spot check (`wcag-checklist.md`, Q10).
5. **Decisions with defaults the work proceeded on:** `NARRATION_TEXT_SHOWN` stays `false` until a counted run reads at least 95 % through step 7
   (B measured 92.9 %; its two defects are specified in section 6.5), or you accept the wording residual in writing; the assumptions
   file reads "Stale" (a year-end constant counts or it does not: wp9.1); P-2 above.
6. **Run `just upgrade` in `~/personalfi-prod` at the candidate commit only when the orchestrator posts "CI green"**; this package's
   migrations: none.

## 8. Final report and final check

**Posted to the orchestrator before the check (the substance; the orchestrator's message has the file list):** every clause of the v0.9 and
v1.0 audit has its instrument re-run at this tree (section 1) — performance proven (section 3), WCAG's automated half proven (164/165, then
165/165), security fixes proven with the remainder recorded and the eleven risks waiting on Chris, the stranger carried to run 2, the direct
jump PASS, the soak not started. The kill left one defect half-done (P-4's raw SQL on the platform's table, red under `just lint`), fixed
by moving the read to its owner (section 0.14). G-18's three remaining tests were written and sabotaged (0.15). The P-1 and P-6
regressions of 9.9 are closed on the quiet host (243 s -> 47 s; 2.05 s -> 62 ms); the boot peak is 1.49 GiB; three things are not
claimed: the 250k-in-60 s consumer row, the cold start through Caddy under 20 s, and the unreproduced 49-of-56 cause.

The final `just check` (typecheck, lint, check-proxy-routes, the whole vitest run and the web tests, check-ci-projects), run last on
this tree with the scratch stack down:

1. **Run 1 (`/tmp/wp914/check.log`)**: typecheck and lint green; the root vitest 408 files, 3,650 passed, **1 failed** — `holdings-scale-perf.test.ts`
   (P-6) `GET /investments/allocation` p95 905 ms at load 1.43 in the 37-minute parallel run; re-run alone 7 of 8 pass (section 7.1 item 8).
2. **Run 2 (`/tmp/wp914/check2.log`, 02:10)**: typecheck, lint (eslint 0 errors, schema ownership ok), check-proxy-routes green; the root vitest
   **407 passed | 1 skipped (408 files), 3,651 passed | 12 skipped (3,663 tests), 2,247 s**; the web unit run **1 failed**,
   `router.test.tsx` (section 0.14's second half-done thing), fixed.
3. **Run 3 (`/tmp/wp914/check3.log`, after the fix)**: `just typecheck`, `just lint`, `just check-proxy-routes`, `pnpm --filter @app/web test`
   (**92 files, 560 tests passed**) and `node scripts/check-ci-projects.ts` (**42/42**) — every stage of `just check` except the 37-minute
   root vitest, which was green on the same code in run 2 (the only changes since are a one-line web test and this document). I did not
   spend a third 37 minutes re-running it; the orchestrator's `just verify` will.

```text
$ just typecheck           -> tsc -p tsconfig.json: clean
$ just lint                -> prettier --check, eslint . (0 errors, 1 pre-existing react-hooks warning), schema-ownership: ok, check-numeric-boundaries PASS
$ just check-proxy-routes  -> PASS, 31 contract prefixes
$ pnpm --filter @app/web test -> Test Files 92 passed (92), Tests 560 passed (560)
$ node scripts/check-ci-projects.ts -> PASS, all 42 vitest.config.ts projects covered by ci.yml
```
