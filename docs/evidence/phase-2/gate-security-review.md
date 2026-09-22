<!-- SPDX-License-Identifier: MIT -->

# Phase 2 security gate — independent review

**Reviewer:** Opus `security-engineer`, independent of every Phase 2 work package.
Wrote none of this code; every evidence document under `docs/evidence/phase-2/` was
read as a _claim_, not as a result.
**Tree:** `/home/chris/Projects/PersonalFi`, branch `main`, HEAD `62ad15d`
(`docs: execution log — WP 2.12 committed; Playwright /verify fix`).
**Remote:** `https://github.com/huh12312/PersonalFi` (private). C-1c's blocker is gone.
**Date:** 2026-09-21.

Written incrementally, section by section, so a rate-limit kill loses nothing already
appended. No secret value appears anywhere in this file; every transcript was redacted
at the shell before it was pasted.

---

## 0. Verdict

_(written last — see §7)_

---

## 1. Independent re-verification (Standard A)

The counts below were re-derived by this gate. They were **not** read out of
`wp2.12-quality.md`.

```
$ DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev just verify
...
=== verify: PASS (this is the run that predicts CI) ===
```

| Stage                                                       | Result                                                                                             |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `typecheck` (`tsc -p tsconfig.json`)                        | pass                                                                                               |
| `lint` (prettier + eslint + schema-ownership)               | pass                                                                                               |
| `check-proxy-routes`                                        | pass                                                                                               |
| backend vitest, all 31 projects                             | **Test Files 156 passed \| 1 skipped (157)** / **Tests 1924 passed \| 2 skipped (1926)**, 649.46 s |
| web vitest                                                  | **Test Files 42 passed (42)** / **Tests 242 passed (242)**, 21.49 s                                |
| web build (strip-sourcemaps, sw-precache, CSP static check) | pass                                                                                               |
| Playwright (smoke + csp) on the built SPA                   | **23 passed (46.9 s)**                                                                             |
| gitleaks, full history, CI's pinned digest                  | pass                                                                                               |
| license gate + `THIRD_PARTY.md` drift                       | pass                                                                                               |
| compose hardening (self-test, then the real files)          | pass                                                                                               |
| `.trivyignore` expiry + trivy filesystem scan               | pass, 0 findings                                                                                   |

**1924 backend + 242 web is exactly the number the brief and `wp2.12-quality.md`
claim.** The 1 skipped file / 2 skipped tests are `connector-plaid`'s live-Sandbox
smoke, which skips itself with no `PLAID_CLIENT_ID`/`PLAID_SECRET` in the shell —
the same expected skip Phase 1's gate recorded.

**Verdict — Standard A: PASS.** The tree is green at the landing commit on the
recipe that predicts CI, and no count in the evidence was inflated.

**Hygiene checks done before anything else:**

- `git status --porcelain` — empty. Clean tree at dispatch.
- `ls compose.override.yml` — absent. Phase 1's **N-2** (an active override breaking
  `just verify`) is confirmed closed in this working copy, per dispatch §2.
- `docker ps` — only `personalfi-dev-db-1` (healthy, `127.0.0.1:5433`) and unrelated
  non-PersonalFi containers. No warm PersonalFi stack was inherited; every stack
  observation in §3 starts from `down -v`.

---

## 2. Sabotage log (Standard B)

Every control below was broken by this gate — in the _source_, never in the test —
the targeted suite was run and observed red, and the file was then restored with
`git checkout --`. `git status --porcelain` was re-checked after every restore and
is clean of source edits at the end of this section (§8 shows the final state).

The column that matters is **"red first try"**: a control that only went red after
the gate had to go and write a test for it was, until this gate, unproven.

### 2.1 Notification egress — the SSRF surface

`packages/contexts/notifications/src/egress.ts` is the single choke point; nothing
else in the package opens a socket. Five independent sabotages, five independent
layers.

#### S-N1 — the destination allow-list

```
--- src/egress.ts: `if (!policy.allowedHosts.includes(host))` → `if (false)` ---
     × a channel URL pointing at db:5432 is refused 13ms
     × the refusal matrix holds for every class of destination 2ms
AssertionError: expected 'port_not_allowed' to be 'host_not_allowed'
AssertionError: localhost by name: expected 'dns_resolution_failed' to be 'host_not_allowed'
      Tests  2 failed | 8 passed (10)
```

**Red, first try.** Worth reading the _values_: with the allow-list gone, `db:5432`
was still refused — by the port list, one layer down. The defence is genuinely
layered, and the test is strict enough (it asserts the exact refusal code, not
merely "refused") to see the outer layer die anyway. That strictness is the reason
this sabotage is informative rather than vacuous.

#### S-N2 — literal-IP detection and the link-local classifier

```
--- src/egress.ts: `looksLikeIpLiteral`'s isIP + numeric/hex-last-label clauses → `return false`,
    and `classifyIpv4`'s `if (a === 169 && b === 254)` → `if (false)` ---
     × 169.254.169.254 is refused 12ms
     × the refusal matrix holds for every class of destination 4ms
     × an allow-list entry may not be an IP literal or a wildcard 3ms
AssertionError: expected 'host_not_allowed' to be 'literal_ip'
AssertionError: loopback v4: expected 'host_not_allowed' to be 'literal_ip'
AssertionError: expected [Function] to throw an error
      Tests  3 failed | 7 passed (10)
```

**Red, first try.** The third failure is the one I did not expect and like most:
neutering `looksLikeIpLiteral` also silently opened `createEgressPolicy` to accepting
`127.0.0.1` _as an allow-list entry_. That is the "second door" the file's own comment
claims to have closed, and the claim holds — one function guards both doors, and the
test set notices when it stops.

#### S-N3 — the DNS re-check (rebinding)

```
--- src/egress.ts: guardDestination's `if (klass !== 'public')` → `if (false)` ---
     × a channel URL pointing at db:5432 is refused 15ms
     × 169.254.169.254 is refused 2ms
     × the refusal matrix holds for every class of destination 3ms
AssertionError: a name resolving to loopback: expected true to be false
      Tests  3 failed | 7 passed (10)
```

**Red, first try.** This is the TOCTOU half: an allow-listed _name_ whose resolver
answers `127.0.0.1`, `10.x`, `169.254.169.254` or `::ffff:127.0.0.1`. I separately
read `transport.ts` and confirmed the close is real end to end — `guardDestination`
returns the addresses it validated and `createNodeTransport` installs a `lookup` that
returns one of them and never consults DNS again, with `servername` still the hostname
so TLS validation is unweakened.

#### S-N4 / S-N5 — redirects, both halves independently

```
--- S-N4: src/egress.ts: classifyStatus's 3xx branch deleted ---
     × a 302 to an internal host is not followed 23ms
     × every 3xx is a refusal, and no 2xx is 1ms
AssertionError: expected 'permanent' to be 'refused'
AssertionError: 300: expected 'permanent' to be 'refused'
      Tests  2 failed | 8 passed (10)

--- S-N5: src/transport.ts: a naive `Location`-following second request added ---
     × a 302 to an internal host is not followed 36ms
AssertionError: the redirect target was never contacted: expected 1 to be +0
      Tests  1 failed | 9 passed (10)
```

**Both red, first try.** S-N5 is the strong one: the test stands up two real loopback
HTTP servers, and with the sabotage in place the internal service's own counter went
from 0 to 1. The claim "an allow-listed host cannot launder a request to an internal
one" has now been observed failing.

### 2.2 Sealed channel-config custody

```
--- S-N6: src/service.ts: sealed_config written as plaintext `Buffer.from(JSON.stringify(config))` ---
     × the raw channel config column contains no plaintext SMTP password 294ms
     × re-pointing the clear destination_host at an internal name fails to open 267ms
AssertionError: expected '{"kind":"smtp","scheme":"smtps","host…' not to contain '<REDACTED — the fixture password>'
AssertionError: expected SecretBoxError: unsupported envelope vers… to be an instance of ChannelRefusedError
      Tests  2 failed | 1 passed (3)
```

**Red, first try.** The test reads the raw `bytea` back out of Postgres, which is the
only way this claim is worth anything. The second failure is a bonus finding about the
design: because the AAD binds the sealed copy to the row _and_ the clear
`destination_host`/`port`/`scheme` columns are cross-checked against the sealed copy on
open, an attacker with `UPDATE` on `notification_channels` cannot re-point a verified
channel at an internal host by editing the three unsealed columns. That is a real
control and it is tested.

### 2.3 At-most-once outbox dedupe

```
--- S-N7: src/outbox.ts: `ON CONFLICT (user_id, dedupe_key)` → `ON CONFLICT (user_id, dedupe_key, id)` ---
     × the same dedupeKey inserted twice delivers once 90ms
     × a consumer replay from seq 0 re-derives the same row and sends nothing more 291ms
     × two account holders may derive the same dedupeKey and both are delivered 292ms
AssertionError: both envelopes reached the consumer: expected +0 to be 2
      Tests  3 failed (3)
```

**Red, first try.** I deliberately chose a sabotage that _widens_ the conflict target
rather than deleting the clause, because that is the shape a real regression takes
(somebody "fixes" a constraint). All three tests died, including the one that proves
the dedupe is scoped per user and does **not** silently swallow a second account
holder's identical key.

### 2.4 Quiet-hours hold

```
--- S-N8: src/consumer.ts: `rule.deliveryClass === 'PROMPT' && isQuietAt(now, quiet)` → `false` ---
     × a quiet-hours notification is held, not dropped, across a DST boundary 358ms
AssertionError: expected 'pending' to be 'held'
      Tests  1 failed | 2 passed (3)
```

**Red, first try.** The other two in the file stayed green and should have: `'a
P0_SAFETY rule is not held at all'` is asserting the _absence_ of a hold, and the
autumn-boundary test is over the pure `time.ts` function the sabotage did not touch.

### 2.5 Insights — evidence resolution

```
--- S-I1: src/validate/evidence.ts: every `{ ok: false, reason: … }` branch in
    `resolveSourceRef` → `{ ok: true, value: 0 }` (8 branches) ---
     × an insight citing a path we did not send is rejected 17ms
     × an evidence ref that does not resolve is rejected 4ms
     × refuses a prototype segment before any lookup happens 2ms
     × treats an undefined tail as a failure, not as a value 1ms
AssertionError: expected [ { status: 'pending_review', …(5) } ] to deeply equal []
AssertionError: snapshot:recurring_list.streams[7].typical_amount: expected [ … ] to deeply equal []
      Tests  4 failed | 5 passed (9)
```

**Red, first try.** With the sabotage in, an insight citing a path we never sent
reached `pending_review`. That is the exact failure mode the Phase 5 LLM advisor will
produce, and the control that stops it has now been observed absent.

### 2.6 Insights — numeral tracing

```
--- S-I2: src/validate/numerals.ts: `isTraceable` → `return true` ---
     × an insight whose number is absent from the snapshot is rejected 14ms
     × a fabricated figure in a caveat or an impact basis is caught too 4ms
     × an impact figure that no derivation produced is rejected 3ms
AssertionError: caveats: expected [ { status: 'pending_review', …(5) } ] to deeply equal []
AssertionError: expected undefined to be 'numerals'
      Tests  3 failed | 9 passed (12)
```

**Red, first try.** Note that the caveat and impact-basis fields are covered, not just
the headline body — a fabricated number hiding in the small print is caught.

### 2.7 Insights — the impact ceiling

```
--- S-I3: src/advisors/support.ts: `clampImpact`'s `if (magnitude > CEILING_MINOR)` → `if (false)` ---
     × an impact above the ceiling is clamped and logged 29ms
     × the boundary is the ceiling itself, not one short of it 3ms
     × a negative outlier is withheld on its magnitude 1ms
AssertionError: expected { minor: '141200000', currency: 'USD' } to be null
AssertionError: expected 'kept' to be 'withheld'
      Tests  3 failed | 3 passed (6)
```

**Red, first try**, and `wp2.7-advisor-catalog.md`'s honest confession is confirmed
by this gate independently: with the ceiling off, the poisoned $1,412,000 figure
passes all seven validation steps and is _accepted_, because it is faithfully
traceable to a snapshot value. The validator answers "did this come from our data?";
the ceiling answers "is this plausible?". They are different questions and only one
control answers the second. See the ruling in §5.

### 2.8 Insights — the alert budget

```
--- S-I4: src/policy/alert-budget.ts: the dashboard/list slices → the whole ordered feed,
    and the $50 annual floor → `return false` ---
     × shows five on the dashboard and twenty in the list, and withholds the rest 14ms
     × withholds an insight that claims less than $50 a year 2ms
     × counts a one-time saving at half a recurring one of equal size 1ms
AssertionError: expected [ { key: 'insight-00', …(4) }, …(29) ] to have a length of 5 but got 30
      Tests  3 failed | 14 passed (17)
```

**Red, first try.**

### 2.9 Insights — kill switches 1–3 and quarantine

```
--- S-I5: src/policy/kill-switches.ts: all four guards deleted from `decideRun` ---
     × a quarantined advisor's output never reaches pending_review 1214ms
     × each of the three switches refuses independently 452ms
     × a newly registered advisor is off until somebody turns it on 238ms
     × a validator that refuses most of a run quarantines the advisor 290ms
AssertionError: advisors_disabled: expected 'completed' to be 'refused'
AssertionError: expected null to be 'advisor_disabled'
AssertionError: expected null to be 'advisor_quarantined'
      Tests  4 failed | 6 passed (10)
```

**Red, first try**, and each of the three switches is asserted to refuse
_independently_ — the test set does not settle for "some switch stopped it". I also
confirmed by reading `service.ts` that the switches are evaluated in transaction 1,
**before** the snapshot is built: a quarantined advisor is never handed data at all,
rather than being handed data and having its output dropped.

### 2.10 Step-up on `advisors/{id}/run` and channel create/delete

```
--- S-R1: apps/api/src/auth/guards.ts: `if (!identity.sessions.isFresh(session)) throw stepUpRequired();` deleted ---
     × enabling an advisor needs a step-up assertion 16ms
     × triggering a run needs a step-up assertion 5ms
     × creating a channel needs a step-up assertion 13ms
     × deleting a channel needs a step-up assertion, and is idempotent 24ms
AssertionError: expected 200 to be 403
AssertionError: expected 503 to be 403
AssertionError: expected 422 to be 403
      Tests  4 failed | 14 passed (18)
```

**Red, first try.** Phase 1's gate found that step-up refusals were being asserted on
the status code alone; these four assert `403` _and_ land on a route that visibly
did something else (`200`, `422`, `503`) once the guard was gone, so the refusal is
not being confused with an unrelated rejection.

### 2.11 Cross-user refusal on the four new route families

Four separate sabotages, one per context, each dropping the `user_id` predicate from
the place a second account holder's row would have to leak through.

| #    | Sabotage                                                                                                                   | Result                                                                                                                                                     |
| ---- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S-R2 | `routes/budgets.ts`: `and(eq(budgetLines.id, lineId), eq(budgetLines.userId, userId))` → `and(eq(budgetLines.id, lineId))` | `× a budget line belonging to one user is invisible and unreachable to another` — `expected 'budgeting.budget_not_found' to be 'budgeting.line_not_found'` |
| S-R3 | `@ctx/recurring` `read.ts`: `conditions = [eq(recurringSeries.userId, input.userId)]` → `[]`                               | `× a series belonging to one user is invisible and unreachable to another` — `expected [ { …(17) } ] to deeply equal []`                                   |
| S-R4 | `@ctx/insights` `read.ts`: `conditions = [eq(insights.userId, input.userId)]` → `[]`                                       | `× an insight belonging to one user is invisible and unreachable to another` — `expected 200 to be 404`                                                    |
| S-R5 | `@ctx/notifications` `read.ts`: all three `eq(notificationOutbox.userId, userId)` → a tautology                            | `× a notification queued for one user never appears in another's outbox` — `expected [ 'Theirs', 'Mine' ] to not include 'Theirs'`                         |

**All four red, first try.** S-R2 is the interesting one and is recorded honestly:
dropping the route-level predicate did **not** produce a leak, because the budget-level
scope caught it one layer down — the test still went red because it asserts the exact
error code. That is defence in depth working _and_ a test strict enough to notice the
outer layer dying. S-R5 is the exact RT3 leak `wp2.12-quality.md` §4.5 named, now
observed from the API surface.

### 2.12 Export and import

| #    | Sabotage                                                                            | Result                                                                                                                                             |
| ---- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| S-E1 | `reports/export/bundle.ts`: `redactedColumns` → return every column                 | `× an export never contains a sealed credential or a Plaid access token` — `expected '{"appversion":"test",…' not to contain 'sealed_credentials'` |
| S-E2 | `reports/export/bundle.ts`: `if (digest !== stream.sha256)` → `if (false)`          | `× a tampered stream hash is refused` — `expected function to throw an error, but it didn't`                                                       |
| S-E3 | `reports/export/import.ts`: `if (await instanceHasUserData(client))` → `if (false)` | `× import into a non-empty instance is refused` — `expected error: duplicate key value violates uniqu… to match object { status: 409 }`            |

**All three red, first try.** S-E1 matters most: the redaction is driven by a
`SENSITIVE_NAME_PATTERN` over `information_schema` column names plus a named
per-table list, not a hand-maintained allow-list, so a _new_ sealed column added in
Phase 3 is excluded by default rather than by somebody remembering.

### 2.13 Wiring — a module flag off registers nothing

```
--- S-W1: apps/api/src/platform.ts: resolveModules' `if (!(await platform.flags.isEnabled(...)))
    { disabled.push(...); continue; }` → the call is made and its answer discarded ---
     × a module flag off registers no consumer, no job, and never calls its schedules
       — a flag on registers all three 13ms
AssertionError: expected [ 'wp2.12.module.on', …(1) ] to deeply equal [ 'wp2.12.module.on' ]
      Tests  1 failed (1)
```

**Red, first try.** The sabotage deliberately keeps the `isEnabled` _call_ and
discards its answer, so a test that only asserted "the flag service was consulted"
would have stayed green. This one asserts the consequence — no consumer, no job, no
schedule call — and dies. `wp2.12-quality.md` is right that `resolveModules` is
otherwise exercised only in `worker.ts`'s `main()`; this unit test is the only thing
between that function and production, and it is load-bearing.

### 2.14 `upsertSchedule` refuses an invalid name

```
--- S-W2: packages/platform/src/jobs/scheduler.ts: `if (!SCHEDULE_NAME_PATTERN.test(name))` → `if (false)` ---
     × refuses a name the database would refuse, before the insert 21ms
AssertionError: notifications.deliver:6f1d2c0e-1b2a-4c3d-8e9f-0a1b2c3d4e5f:
               expected [Function] to throw an error
      Tests  1 failed | 8 passed (9)
```

**Red, first try**, and the name in the assertion message is _literally_ the
`notifications.deliver:<uuid>` that crash-looped the worker on WP 2.w's cold boot and
was fixed at `dd8c874`. The regression that caused a production crash-loop is now a
unit-test failure. I confirmed the fix is still present by reading
`packages/contexts/notifications/src/jobs.ts` (schedule names are
`notifications.<kind>.<uuid with hyphens → underscores>`), and §3 confirms the worker
no longer crash-loops on a genuinely cold boot.

**One process note, recorded because it cost me a run:** the test lives in
`packages/platform/test/`, which belongs to the **`platform-db`** project, not
`platform` (whose `include` is `src/**/*.test.ts`). A reviewer who runs
`--project platform` gets `No test files found, exiting with code 1` and could read
that as a pass if they were only grepping for `×`. Not a defect; a trap.

### 2.15 Recurring never creates a merchant (D25)

```
--- S-D1: @ctx/recurring src/service.ts: an INSERT INTO merchants added to runDetection ---
     × a full detection pass leaves merchants row count and ids unchanged 1056ms
AssertionError: row count unchanged: expected 33 to be 32
      Tests  1 failed | 1 passed (2)

--- S-D2: @ctx/recurring src/index.ts: `export function normalizeDescriptor(descriptor: string)` added ---
     × the engine exports no function that takes a descriptor 33ms
     × no identifier under src/ names a descriptor, a payee or a merchant key 7ms
AssertionError: expected [ 'index.ts: descriptor' ] to deeply equal []
      Tests  2 failed | 1 passed (3)
```

**Both red, first try.** Recorded honestly: my _first_ attempt at S-D1 wrote
`INSERT INTO merchants (…, merchant_key, …)` and Postgres answered `column
"merchant_key" of relation "merchants" does not exist`. That was my error, not a
gap in the control — the column is `normalized_key`. The corrected sabotage inserts a
real row and the guard catches it on the count. The persistence-side guard (row count
**and** ids) and the engine-side guard (no exported function may even _name_ a
descriptor) are genuinely independent.

### 2.16 Budgets exclude transfers and net refunds

| #    | Sabotage                                                                                                  | Result                                                                                                                                 |
| ---- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| S-B1 | `@ctx/budgeting` `actuals.ts`: `if (row.transferLinkId !== null \|\| row.isTransfer)` → `if (false)`      | `× a paired transfer contributes zero activity` — `expected +0 to be 1`                                                                |
| S-B2 | `actuals.ts`: `resolveCategory`'s cross-period `categoryOfPurchase.get(row.refundOfId)` fallback → `null` | `× an uncategorised refund still nets into the purchase's own envelope` — `expected -10000n to be -6000n`                              |
| S-B3 | `actuals.ts`: `if (row.refundOfId !== null)` netting branch → `if (false)`                                | `× a netted refund reduces activity by exactly the refund` **and** `× an uncategorised refund still nets…` — `expected 0n to be 4000n` |

**All three red, first try.** S-B2 is the test `wp2.12-quality.md` says it _added_
because the original refund assertion was vacuous (it always posted the refund with
the purchase's own category, so the cross-period fallback was never exercised). This
gate independently confirms the new test is real: it is the only one of the four that
dies to S-B2, and the amounts in the assertion (`-10000n` vs `-6000n`) are the
difference between a $100 purchase netted by a $40 refund and one that was not.

Also checked by reading rather than by sabotage, per dispatch §5's bigint risk row:
`grep -n "number" packages/contexts/budgeting/src/*.ts` at every `*_minor` boundary —
all money is `Money`/`bigint`; the only `number` values in the package are counts
(`transferExcludedCount`, `refundNettedCount`, `transactionCount`) and priorities.

### 2.17 `check-ci-projects` catches a dropped project

```
--- S-Q1: '--project insights' removed from ci.yml's `test` job list ---
check-ci-projects: self-test PASS (5 fixtures + 3 parser checks, correct state clean, every broken shape caught)
check-ci-projects: FAIL — 1 problem(s)
  - 'insights' is declared in vitest.config.ts but appears in neither ci.yml job's
    --project list ('test' or 'migration-test') — it has never run in CI.
exit=1

--- S-Q2: '--project ghost_project' added to ci.yml, with no such vitest project ---
check-ci-projects: FAIL — 1 problem(s)
  - ci.yml names '--project ghost' but vitest.config.ts declares no such project —
    a stale or misspelled name silently runs zero tests.
```

**Both red, first try.** Baseline, for the record:

```
check-ci-projects: PASS — all 31 vitest.config.ts project(s) are covered by ci.yml
                   (19 in 'test', 13 in 'migration-test'), and every name ci.yml lists exists.
```

31 projects, 19 + 13 = 32 because `db` appears in both lists by design. This closes
the failure mode that occurred twice (4 of 13 in Phase 0, 13 of 23 in Phase 1) and
dispatch §5 item 5 called "the single highest-yield check available". **It is now
mechanically enforced and I observed it fail.**

**I also probed the check's own parser**, since a checker with a blind spot is worse
than none. Renaming `kernel` → `kernel_x` in both files (an underscore, which the
parser's `/--project\s+([a-z0-9-]+)/g` cannot read):

```
check-ci-projects: FAIL — 3 problem(s)
  - 'kernel_x' is declared in vitest.config.ts but appears in neither ci.yml job's list
  - ci.yml names '--project kernel' but vitest.config.ts declares no such project
  - vitest.config.ts declares project 'kernel_x', which does not match the
    lowercase-hyphenated naming this check assumes — the parse may be silently wrong for it.
```

**It fails closed and names its own assumption out loud.** That is better than I
expected and is not a finding.

### 2.18 Sabotage scorecard

| #        | Control                                                                    | Red first try? |
| -------- | -------------------------------------------------------------------------- | -------------- |
| S-N1     | egress destination allow-list                                              | yes            |
| S-N2     | literal-IP + link-local refusal (and the allow-list's own IP-literal door) | yes            |
| S-N3     | DNS re-check / rebinding close                                             | yes            |
| S-N4     | `classifyStatus` 3xx → refusal                                             | yes            |
| S-N5     | transport never follows `Location`                                         | yes            |
| S-N6     | sealed channel-config custody (raw bytes)                                  | yes            |
| S-N7     | at-most-once outbox dedupe                                                 | yes            |
| S-N8     | quiet-hours hold                                                           | yes            |
| S-I1     | evidence resolution                                                        | yes            |
| S-I2     | numeral tracing                                                            | yes            |
| S-I3     | impact ceiling                                                             | yes            |
| S-I4     | alert budget (caps + $50 floor)                                            | yes            |
| S-I5     | kill switches 1–3 + quarantine                                             | yes            |
| S-R1     | step-up on advisor run/enable and channel create/delete                    | yes            |
| S-R2..R5 | cross-user refusal on budgets / recurring / insights / notifications       | yes (all four) |
| S-E1     | export excludes sealed credentials                                         | yes            |
| S-E2     | bundle stream-hash tamper refused                                          | yes            |
| S-E3     | import refuses a non-empty instance                                        | yes            |
| S-W1     | module flag off registers nothing                                          | yes            |
| S-W2     | `upsertSchedule` refuses an invalid name                                   | yes            |
| S-D1     | recurring never creates a merchant (persistence)                           | yes*           |
| S-D2     | recurring never names a descriptor (engine)                                | yes            |
| S-B1     | budgets exclude transfers                                                  | yes            |
| S-B2     | cross-period refund category fallback                                      | yes            |
| S-B3     | budgets net refunds                                                        | yes            |
| S-Q1     | `check-ci-projects` catches a dropped project                              | yes*           |
| S-Q2     | `check-ci-projects` catches a phantom project                              | yes            |

**26 of 26 controls went red, and every one on the first _valid_ sabotage.** The two
asterisks are my own errors, recorded so the count is not flattered: S-D1's first
attempt used a column name that does not exist (`merchant_key` vs `normalized_key`)
and errored instead of inserting; S-Q1's first attempt was a Python string replace
that silently matched nothing because `--project insights` ends a line with no
trailing space. Both controls were red on the corrected attempt. **No control
required this gate to write a new test** — a first for this project's three gates.

---
