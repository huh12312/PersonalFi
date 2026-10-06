# WP 9.2 — Real-data readiness: tax treatment, account role, valuation

Status: in progress (written incrementally; every sabotage is recorded as it happens).
Migration **0035** `account_overrides`. Emits `ledger.AccountOverrideChanged`.

## 1. What the package does, in one paragraph

A holder overlay in the D11 sense. `accounts` stays the provider's: a sync refreshes it and nothing here
writes it. `account_overrides` holds what the holder says an account is (a tax treatment, a role, a
valuation basis), one row per account, present exactly when at least one field is set. One pure resolver
(`resolveAccountOverlay`, `packages/contexts/ledger/src/overrides/resolve.ts`) decides which of the
provider's default and the holder's say is effective, and says which one spoke.

## 2. Sabotage log (recorded as it happens)

Method: `/tmp/wp92/sab.py` copies the file, applies line-scoped edits each tagged `/* SABOTAGE */`, runs the
named test file, prints the red tests, and **always** restores the file (the copy is taken first). After every
run the count of `SABOTAGE` in the file was printed: **0** each time. The runs below were made against
`packages/contexts/ledger/test/db/account-overrides.test.ts` (21 tests, all green unsabotaged).

Honest note on "red before the fix": the implementation and the tests were written in one session, the
implementation first. The package's pre-change tree has no `account_overrides` table, so there is nothing for
the tests to run red against short of the implementation not existing. What each test _can_ fail on is shown
below: every behaviour the test claims was broken in turn and the named test went red.

### 2.1 Behaviour sabotages (the first exit test)

| #   | File                                 | Sabotage                                                                                    | Red                                                                                                   |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| B1  | `ledger/src/overrides/resolve.ts:74` | provider default wins: `value: provider.value ?? set`                                       | `a holder-set tax treatment wins over the provider subtype, and clearing it returns to the subtype's` |
| B2  | `ledger/src/overrides/store.ts:229`  | the clear's delete targets the wrong key (`account_id = user_id`), so clearing never clears | the same test, plus the two `clearAccountOverrides: the delete is scoped …` tests                     |

### 2.2 Cross-user matrix: every scoping predicate, individually and together (09 §5 item 8)

Every statement in the one writer is scoped by the holder and by the account, and the composite FK
`account_overrides_account_belongs_to_user (user_id, account_id) → accounts (user_id, id)` is a second layer
under them. A dropped predicate therefore stays green _unless the other layer is taken away_ — which is what
the second `describe` does (the FK is dropped in its own scratch database, and a row the FK would make
impossible is planted). With both layers present the default-mode exit test
`another user's account can never be overridden` is the guard; with the FK removed each predicate has its own
named test. Both are recorded.

| ID  | Predicate dropped (store.ts line at the time)               | Red tests (this predicate alone)                                                                                                               |
| --- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | `listAccountOverrides` `user_id` (l.79)                     | `another user's account can never be overridden`; `listAccountOverrides: the read is scoped to the holder …`; `all of them dropped together …` |
| G1  | `getAccountOverride` `user_id` (l.94)                       | `another user's account can never be overridden`; `getAccountOverride: the read is scoped to the holder …`; `all … together`                   |
| G2  | `getAccountOverride` `account_id` (l.95)                    | `getAccountOverride: the read is scoped to the account …`                                                                                      |
| S1  | `setAccountOverrides` lookup `accounts.id` (l.153)          | `setAccountOverrides: the account lookup is scoped to the account (accounts.id)`; `an override the account cannot take …`                      |
| S2  | `setAccountOverrides` lookup `accounts.user_id` (l.153)     | `another user's account can never be overridden`; `setAccountOverrides: the account lookup is scoped to the holder …`; `all … together`        |
| D1  | `setAccountOverrides` empty-row delete `user_id` (l.179)    | `setAccountOverrides emptying a row: the delete is scoped to the holder …`                                                                     |
| D2  | `setAccountOverrides` empty-row delete `account_id` (l.180) | `setAccountOverrides emptying a row: the delete is scoped to the account …`                                                                    |
| C1  | `clearAccountOverrides` lookup `accounts.id` (l.219)        | `clearAccountOverrides: the account lookup is scoped to the account (accounts.id)`                                                             |
| C2  | `clearAccountOverrides` lookup `accounts.user_id` (l.219)   | `another user's account can never be overridden`; `clearAccountOverrides: the account lookup is scoped to the holder …`; `all … together`      |
| C3  | `clearAccountOverrides` delete `user_id` (l.228)            | `clearAccountOverrides: the delete is scoped to the holder …`                                                                                  |
| C4  | `clearAccountOverrides` delete `account_id` (l.229)         | `clearAccountOverrides: the delete is scoped to the account …`                                                                                 |
| ALL | all eleven at once                                          | 14 of 21 red, including `another user's account can never be overridden` and `all of them dropped together …`                                  |

Every row: `restored; SABOTAGE count: 0` printed by the runner. Raw logs: `/tmp/wp92/ledger-matrix.log`,
`/tmp/wp92/ledger-together.log` (scratch; the table above is the record).

The route layer adds no predicate of its own: `PUT`/`DELETE` pass `session.userId` to these two functions, and
the re-read goes through `listAccounts` (scoped by `userId`, unchanged) — see the route tests in §6.

### 2.3 Planning sabotages (`packages/contexts/planning/test/db/tax-override.test.ts`, 5 tests, all green unsabotaged)

| #   | File and line at the time                         | Sabotage                                                                           | Red                                                                                                                                         |
| --- | ------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | `planning/src/projection-service.ts:1180`         | `readProjection`'s overlay comparison never fires (`changes.length > 0` → `false`) | `after a tax-treatment change the stored baseline reads stale and names why`; `a role or a valuation change makes the baseline stale too …` |
| P2  | `planning/src/projection-service.ts:912`          | `prepareProjection`'s gate off (a changed overlay silently recomputes)             | the same two                                                                                                                                |
| P3  | `planning/src/projection-service.ts:309`          | the input document omits the overlay (the digest no longer covers it)              | the same two                                                                                                                                |
| P4  | `planning/src/account-overlay.ts:62`              | the holder's tax treatment does not reach the bucket (default only)                | `after a tax-treatment change the stored baseline reads stale and names why`                                                                |
| P5  | `planning/src/net-worth.ts:260`                   | the valuation basis is ignored (always holdings)                                   | `an account valued by balance counts at that balance and is labelled so; one valued by holdings with none is named unvalued, never zero`    |
| P6  | `planning/src/net-worth.ts:260`                   | balance beats holdings (typed $999,000 would count over priced holdings)           | the same                                                                                                                                    |
| P7  | `planning/src/net-worth.ts:356`                   | an account with no holdings counts as zero instead of unvalued                     | the same, and `a day with no override stores the bytes it always did`                                                                       |
| P8  | `planning/src/net-worth.ts` (the `valuedBy` line) | a balance-valued account is not labelled                                           | the same                                                                                                                                    |

Each run: `restored; SABOTAGE count: 0`.

### 2.4 Route sabotages (`apps/api/test/db/account-overrides-routes.test.ts`, 8 tests, all green unsabotaged)

The routes add no scoping predicate of their own: they pass `session.userId` into the two ledger functions
(matrix §2.2) and re-read through `listAccounts`/`listAccountOverrides` (both scoped by the holder). What a
route _can_ get wrong is the guard and which holder it acts for, so the sabotage replaces
`await guards.requireSession(request)` with an object naming the install's **first holder**, as if the guard
and the scoping were both gone (`SELECT id FROM users ORDER BY created_at, id LIMIT 1`). Run through the
real `app.ts` composition.

| #   | File:line at the time    | Route                                 | Red                                                                                                                                                                                     |
| --- | ------------------------ | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | `routes/accounts.ts:455` | `PUT /accounts/{id}/overrides`        | `a second holder's account 404s, never 403-with-existence, and nothing is written or announced`; `a session is required for PUT, DELETE and GET /accounts/valuation, and no step-up is` |
| R2  | `routes/accounts.ts:508` | `DELETE /accounts/{id}/overrides`     | the same two                                                                                                                                                                            |
| R3  | `routes/accounts.ts:555` | `GET /accounts/valuation`             | the same two (Bob is served Alice's unvalued list)                                                                                                                                      |
| R4  | `routes/accounts.ts:342` | `GET /accounts` (the `overlay` block) | `a second holder's account 404s …` (Bob is served Alice's accounts)                                                                                                                     |

Each run: `restored; SABOTAGE count: 0`.
