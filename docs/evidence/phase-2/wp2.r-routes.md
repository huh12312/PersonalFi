<!-- SPDX-License-Identifier: MIT -->

# WP 2.r — Budgets, recurring, insights and notifications routes

Scope: `apps/api/src/routes/{budgets,recurring,insights,notifications}.ts`, the
registration/tag lines in `apps/api/src/app.ts`, `apps/api/src/routes/deps.ts`
(additive `config` field), `apps/api/test/db/{budgets,recurring,insights,
notifications}-routes.test.ts`, `packages/contracts/openapi/openapi.json`,
`apps/web/src/api/**` (regenerated), `apps/web/src/features/notifications/
api-pending.ts` (+ its import sites), this file.

Repo `/home/chris/Projects/PersonalFi`, branch `main`. Started at `242f5a4`;
the repo moved forward under concurrent agents during this session (worker
crash-loop fix `dd8c874`, wiring evidence `225c616`) — `git log` at the end of
this WP shows HEAD `1b7c05e`, none of it touched by this WP's own diff.

None of the four dispatch plans (`WP 2.1/2.3/2.4/2.6`) built this REST
surface; `WP 2.6`'s own evidence names it explicitly as carried
("`apps/api/src/routes/insights.ts` ... is not built here"), and
`wp2.11-inbox-ui.md` §2/§5 found the same gap for notifications from the UI
side. This WP closes all four.

---

## 1. Route table

Every route is registered under `/api` (Caddy strips the prefix — unchanged).
"Session" = `guards.requireSession`; "Fresh" = `guards.requireFreshSession`
(decision D21's step-up gate).

### `/budgets/*` (session-only — see `routes/budgets.ts`'s module comment:

every write here edits the user's own plan, never a credential)

| Method & path                | Auth    | Context call                                                                          |
| ---------------------------- | ------- | ------------------------------------------------------------------------------------- |
| `GET /budgets/current`       | Session | `listBudgets`/`createBudget`, `openPeriod`, `recomputeDirty`, `getPeriod`             |
| `GET /budgets/periods`       | Session | `listPeriods`                                                                         |
| `POST /budgets/lines`        | Session | direct `budget_lines` insert/update (see §4) + `recomputeDirty`                       |
| `PATCH /budgets/lines/{id}`  | Session | `assign` (money) and/or direct `budget_lines` update (goal/policy) + `recomputeDirty` |
| `POST /budgets/periods/roll` | Session | `rollPeriod`                                                                          |

### `/recurring/*` (session-only — confirming/rejecting/merging is the user

answering a question about their own history, the `rules.ts` shape)

| Method & path                             | Auth    | Context call                                                                          |
| ----------------------------------------- | ------- | ------------------------------------------------------------------------------------- |
| `GET /recurring/series`                   | Session | `listSeries`                                                                          |
| `GET /recurring/candidates`               | Session | `listCandidates`                                                                      |
| `POST /recurring/candidates/{id}/confirm` | Session | `confirmCandidate`                                                                    |
| `POST /recurring/candidates/{id}/reject`  | Session | `rejectCandidate`                                                                     |
| `POST /recurring/series/{id}/merge`       | Session | `mergeSeries`                                                                         |
| `GET /recurring/upcoming`                 | Session | `upcomingCalendar`                                                                    |
| `GET /recurring/forecast`                 | Session | `forwardCashFlow`                                                                     |
| `GET /recurring/safe-to-spend`            | Session | `safeToSpend` (+ `@ctx/budgeting`'s `listBudgetAccounts` for the default cash figure) |

### `/insights/*` and `/advisors/*` (session for reads/review; fresh for

anything that changes what the system does unattended)

| Method & path                 | Auth    | Context call                                                                                                                                 |
| ----------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /insights`               | Session | `insightFeed`                                                                                                                                |
| `GET /insights/{id}`          | Session | `listInsights` (filtered to the id)                                                                                                          |
| `POST /insights/{id}/review`  | Session | `findInsight` (404 check) + `reviewInsight`                                                                                                  |
| `GET /advisors`               | Session | `advisorHealth`                                                                                                                              |
| `POST /advisors/{id}/enabled` | Fresh   | `findAdvisor` (404 check) + `setAdvisorEnabled` (+ `clearQuarantine`)                                                                        |
| `POST /advisors/run`          | Fresh   | `runAdvisor`/`runAdvisors`, `InsightsDependencies` built inline (feature-detected on `config.secrets.advisor_token_secret`, 503 when absent) |

### `/notifications/*` (session for reads/verify; fresh for creating or

destroying a channel — the same posture as a connection's credential)

| Method & path                              | Auth    | Context call                                                          |
| ------------------------------------------ | ------- | --------------------------------------------------------------------- |
| `GET /notifications/channels`              | Session | `listChannels`                                                        |
| `POST /notifications/channels`             | Fresh   | `createChannel` (simple `{kind,destination}` or full `{config}` body) |
| `POST /notifications/channels/{id}/verify` | Session | `findChannel` (404 check) + `verifyChannel`                           |
| `PATCH /notifications/channels/{id}`       | Fresh   | `setChannelEnabled` and/or direct `notification_channels` update      |
| `DELETE /notifications/channels/{id}`      | Fresh   | direct `notification_channels` delete (cascades rules/outbox)         |
| `GET /notifications/rules`                 | Session | direct `notification_rules` select                                    |
| `PUT /notifications/rules`                 | Session | direct `notification_rules` insert-or-update by id                    |
| `PATCH /notifications/rules/{id}`          | Session | direct `notification_rules` update                                    |
| `GET /notifications/outbox`                | Session | `listOutbox` + `listDeadLetters`                                      |
| `GET /notifications/outbox/{id}/attempts`  | Session | `listAttempts`                                                        |
| `POST /notifications/outbox/{id}/retry`    | Session | `retryNotification`                                                   |

`GET /budgets/periods`, `GET /notifications/rules`, `PUT`/`PATCH
/notifications/rules`, `PATCH /notifications/channels/{id}` and `GET
/notifications/outbox/{id}/attempts` are additions beyond the dispatch's
literal list — the first because `/budgets/current` alone cannot enumerate
history, the rest because `apps/web/src/features/notifications/
api-pending.ts`'s already-built UI stub needed them (§5).

---

## 2. `apps/api/src/{app,routes/deps}.ts` — the two shared-file touches

`deps.ts` gained one field: `config: AppConfig`, threaded from `buildApp`'s
own `options.config`. Every new route needs it — the notification egress
policy (`createNotificationEgressPolicy(deps.config)`) and the advisor token
secret (`deps.config.secrets.advisor_token_secret`) are both configuration no
route needed before. `app.ts` gained four registrations
(`budgetRoutes`/`recurringRoutes`/`insightRoutes`/`notificationRoutes`), four
swagger tags, and `config` in the `deps` object literal — nothing else in
either file changed, and `apps/api/src/{domain,modules,platform}.ts` were not
touched at all (their exported adapters — `createBudgetingLedgerPort`,
`createInsightsLedgerPort`/`Budget`/`RecurringPort`,
`createNotificationChannels`/`EgressPolicy` — were already public and are
only imported).

---

## 3. Gaps in the four contexts' public surfaces, and what this WP did instead

Recorded here rather than fixed — `packages/contexts/**` is out of this WP's
ownership.

| Gap                                                                                                              | Context              | What this WP did                                                                                                                                                                                                                                                                                                                                                                     | Recommended context change                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `upsertLine`/`UpsertLineInput` exist in `src/budget.ts` but are not exported from `src/index.ts`                 | `@ctx/budgeting`     | `routes/budgets.ts` reads/writes `budget_lines` directly via the published `./schema` subpath, mirroring `upsertLine`'s exact column layout, then calls the exported `recomputeDirty` so the cached columns never go stale. `apps/` is exempted from `scripts/check-schema-ownership.ts`'s table-ownership check by design (`reports/budget-vs-actual.ts`'s own header explains why) | Export `upsertLine`/`UpsertLineInput`                                                                                              |
| No `deleteChannel`, no per-field channel update, no `listRules`/`updateRule` keyed on anything but an event type | `@ctx/notifications` | Same `./schema`-subpath pattern: direct `notification_channels`/`notification_rules` reads and writes for `DELETE`/`PATCH /notifications/channels/{id}` and `GET`/`PUT`/`PATCH /notifications/rules`. The channel delete relies on `ON DELETE CASCADE` (migration `0011_notifications.sql`) rather than reproducing the fan-out                                                      | Export `deleteChannel`, `renameChannel`, `listRules`, an `upsertRule` keyed on `(userId, name)`                                    |
| No single-insight getter (only `listInsights`/`insightFeed`, which return everything matching a filter)          | `@ctx/insights`      | `GET /insights/{id}` calls `listInsights` unfiltered by id and finds the row in memory — fine at this scale (a few hundred rows a user will ever see), wasteful at more                                                                                                                                                                                                              | Export a `findInsightView`/`getInsight` reader parallel to `findInsight` (which returns the raw row, not the evidence-joined view) |

None of these gaps blocked a route from shipping; all three are "the
context's public surface is narrower than a REST CRUD layer wants," not "the
context is missing a capability."

---

## 4. `PATCH /budgets/lines/{id}` — assign vs. goal/policy

The dispatch's own line, "assign / goal / policy," is two different write
paths under one HTTP verb: `assigned` in the body calls the exported `assign`
(dirty cascade + `BudgetLineAssigned` event, unchanged); any of
`rolloverPolicy`/`goalType`/`goalAmount`/`goalTargetDate`/`goalPercent`/
`priority`/`class` triggers a direct `budget_lines` update (§3's gap). Both
halves, and `POST /budgets/lines`, end with `recomputeDirty` so the response
always carries fresh `available`/`activity`, never a value from before the
edit.

---

## 5. The WP 2.11 stub swap

`apps/web/src/features/notifications/api-pending.ts` was built (`242f5a4`)
against a guessed shape before this route existed
(`docs/evidence/phase-2/wp2.11-inbox-ui.md` §2). Per this WP's own
instructions ("if the shapes differ, change the ROUTE to match the stub, not
the UI"), the route bent to the stub in three places:

1. **`POST /notifications/channels` accepts the stub's `{kind, displayName,
destination}`** as well as the richer `{displayName, config}` shape
   (`z.union`). The simple form fills in per-kind defaults
   (`configFromDestination` in `routes/notifications.ts`): `ntfy` → the
   public `ntfy.sh` relay over HTTPS with no access token; `smtp` → a
   placeholder relay derived from the address's own domain, with no
   credential (one cannot be collected from a bare email address). Good
   enough to prove the wire end to end; a real "advanced" SMTP form (host,
   port, username, password) is follow-up UI work this WP does not do.
2. **`destination` and `lastTestResult` are synthesised, never the sealed
   config.** A channel's ntfy topic or SMTP `to` lives inside
   `sealed_config` (decision D5) and is never returned by any read;
   `destination` on the wire is `${destinationHost}:${destinationPort}` —
   real, non-secret addressing, not literally what the create form typed in.
   `lastTestResult` is `{ok: true, message: 'Verified', testedAt:
verifiedAt}` when `verifiedAt` is set and `null` otherwise — the redacted
   view carries no timestamp for _when_ a past verification failed, and
   `NotificationSettingsScreen.tsx` never reads this field from the list
   anyway (its own `testResultByChannel` state comes straight off each
   `verify` response).
3. **Two routes were added purely because the stub's hooks needed them**:
   `PATCH /notifications/channels/{id}` (`useUpdateNotificationChannelMutation`)
   and `PATCH /notifications/rules/{id}` (`useUpdateNotificationRuleMutation`)
   — neither is in the dispatch's literal list.

One export could not be preserved honestly: **`useDeleteNotificationRuleMutation`
is gone.** There is no `DELETE /notifications/rules/{id}` route (`@ctx/
notifications` exports no delete-by-id for a rule either), and grepping every
import of `api-pending.ts` before removing it confirmed nothing in this
codebase called it.

`api-pending.ts` now calls the generated client (`Sdk.__registry.get()...`,
the same seam `useExportTransactions.ts` uses) instead of `pending-contracts.
ts`'s raw `fetch`. `NotificationSettingsScreen.tsx` was not touched.
`api-pending.test.tsx` was rewritten to pin the real request/response shapes
instead of a guessed 404 (its own header explains why); `NotificationSettingsScreen.test.tsx`
needed two mechanical fixes unrelated to the component itself — `ensureApiClient()`
in `beforeEach` (the generated client's `Sdk.__registry` needs `new Sdk()` once
per test file; the old raw-`fetch` stub needed no such registration) and the
mocked path `/test` → `/verify`.

```
$ pnpm --filter @app/web typecheck   # tsc -b --noEmit (via pnpm run gen first) — clean
$ pnpm --filter @app/web test        # vitest run — 29 files, 146 tests, all passing
```

`just openapi` and `pnpm --filter @app/web gen` were re-run after every route
change (three times total, once per shape fix); `just check-proxy-routes`
passed on the first try and every run after:

```
check-proxy-routes: PASS — docker/Caddyfile routes exactly '/api/*' to the
api, matching packages/contracts/openapi/openapi.json's servers[0].url
('/api') and covering all 21 contract prefix(es): /accounts, /advisors,
/auth, /budgets, /categories, /connections, /connectors, /export, /health,
/import, /imports, /insights, /net-worth, /notifications, /ready, /recurring,
/reports, /rules, /sync, /transactions, /transfers.
```

No finding here: the new prefixes were already covered by the existing
`/api/*` proxy rule, as expected.

---

## 6. Tests

`api-db` project, `DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev`
(harness derives its own scratch database name per suite, e.g.
`personalfi_api_wp-budgets_<random>`).

### `apps/api/test/db/budgets-routes.test.ts` — 3 tests

- `'refuses every budgets route without a session, with 401'`
- `'opens the current period, creates a line, assigns to it, and rolls the period'` (happy path: `GET /budgets/current` lazily creates the default budget+period, `POST /budgets/lines` creates an envelope, `PATCH .../lines/{id}` assigns $25 and Ready-to-Assign moves to exactly −$25 with no on-budget cash account, `GET /budgets/periods` lists it, `POST .../periods/roll` rolls forward)
- `'a budget line belonging to one user is invisible and unreachable to another'`

### `apps/api/test/db/recurring-routes.test.ts` — 5 tests

Scene: two perfectly regular monthly Netflix charges, synced through
`linkManual`, drained through the real `createRecurringConsumer` (not a raw
insert) — `EARLY_DETECTION` confidence (0.70) lands above
`CANDIDATE_CONFIDENCE` (0.55) and below `AUTO_CONFIRM_CONFIDENCE` (0.8), so
detection proposes a candidate rather than auto-confirming.

- `'refuses every recurring route without a session, with 401'`
- `'lists the candidate the real detector proposed'`
- **`'confirming a candidate pins the series'`** — confirms the real candidate, asserts `userConfirmed: true` and `state: 'ACTIVE'` on the series, and that confirming the same (now-decided) candidate again 404s
- `'projects the confirmed series into upcoming/forecast/safe-to-spend'`
- `'a series belonging to one user is invisible and unreachable to another'`

### `apps/api/test/db/insights-routes.test.ts` — 7 tests

Scene: a manual checking account at $120 and a $60 grocery charge, the same
minimal setup `phase2-wiring.test.ts` uses for `builtin.cash.
emergency_fund_short`; scopes granted directly (no consent route exists —
`wp2.6-insights.md` §6's carried item) and `runAdvisor` called directly to
produce a real `pending_review` row.

- `'refuses every insights/advisors route without a session, with 401'`
- `'lists the registered built-in advisors, seeded at boot'`
- `'the feed carries the real insight the advisor proposed, with its evidence panel'`
- **`'reviewing an insight starts its cooldown'`** — `dismiss` returns `dismissCount: 1`, `permanent: false`, `suppressedUntil` non-null, and the insight's status flips to `'dismissed'` in the (unfiltered) feed
- `'enabling an advisor needs a step-up assertion'`
- `'triggering a run without an advisor_token_secret configured fails closed with 503, not a 500'`
- `'an insight belonging to one user is invisible and unreachable to another'`

### `apps/api/test/db/notifications-routes.test.ts` — 9 tests

Scene: one channel seeded directly against `@ctx/notifications` with a
_permissive_ policy (`allowedHosts: ['notify.example.com']`) and verified
with a fake adapter — the same seam `phase2-wiring.test.ts` uses — because
the harness's real deployment policy is deny-all and a channel that fails its
own door check can never be listed, updated or deleted through the route.

- `'refuses every notifications route without a session, with 401'`
- `'lists the seeded channel'`
- `'creating a channel under the default deny-all allow-list refuses with host_not_allowed, not a 500'` — `POST /notifications/channels` under deny-all, asserts `422` + `notifications.host_not_allowed`, never a 500
- **`'a channel verify against a non-allowed host returns host_not_allowed'`** — `POST .../verify` on the seeded channel (permitted at creation, not on _this_ deployment's allow-list) returns `200 {result: {ok: false, message: 'host_not_allowed: …'}}`, proving the guard re-checks on every send rather than trusting the row
- `'creating a channel needs a step-up assertion'`
- `'creates, lists, updates and deletes a rule'`
- `'lists the outbox (empty is a valid, structurally correct answer)'`
- `'deleting a channel needs a step-up assertion, and is idempotent'`
- `'a channel and a rule belonging to one user are invisible and unreachable to another'`

**Totals: 4 files, 24 tests, all passing.** Full `api-db` project (24 pre-existing files + these 4): **23 files passed, 1 skipped (`plaid-sandbox`, needs live credentials — pre-existing skip, unrelated to this WP), 151 passed + 1 skipped, 0 failed.**

---

## 7. Sabotage record

One route per file, the guard removed, the test re-run to confirm red, then
restored (`grep -n SABOTAGE` over all four files after restoring returns
nothing).

| File                      | Sabotaged                                              | How                                                                                                                                         | Result before restore                                                                                                                                                                                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `routes/budgets.ts`       | `requireOwnLine`'s `WHERE` clause                      | Dropped `eq(budgetLines.userId, userId)`, leaving only the id match                                                                         | `'a budget line belonging to one user is invisible and unreachable to another'` failed: `expected 'budgeting.budget_not_found' to be 'budgeting.line_not_found'` — the second user's `PATCH` reached the line and fell through to a _different_, wrong-owner error instead of the clean 404 the guard is supposed to produce              |
| `routes/notifications.ts` | `DELETE /notifications/channels/{id}`'s `WHERE` clause | Dropped `eq(notificationChannels.userId, session.userId)`                                                                                   | `'a channel and a rule belonging to one user are invisible and unreachable to another'` failed: `expected true to be false` — the second user's `DELETE` actually deleted the first user's channel                                                                                                                                        |
| `routes/recurring.ts`     | `GET /recurring/series`'s `userId`                     | Replaced `session.userId` with a live `SELECT id FROM users ORDER BY created_at LIMIT 1` (i.e. "always answer as the first account holder") | `'a series belonging to one user is invisible and unreachable to another'` failed: `expected [ {…} ] to deeply equal []` — the second user's `GET` returned the first user's real series row                                                                                                                                              |
| `routes/insights.ts`      | `POST /insights/{id}/review`'s existence check         | `findInsight` looked up the first account holder instead of `session.userId`                                                                | `'an insight belonging to one user is invisible and unreachable to another'` failed: `expected 500 to be 404` — the sabotaged existence check let the request past the route's own guard, and it was `reviewInsight`'s _internal_ re-check (a different code path, using the real `session.userId`) that caught it, with the wrong status |

Each sabotage was reverted immediately after the failing run was observed;
`pnpm run typecheck` and the full `api-db` project were re-run clean
afterward (§6's totals are the post-restore numbers).

---

## 8. `just check`

Run in the foreground after everything above, verbatim below.
