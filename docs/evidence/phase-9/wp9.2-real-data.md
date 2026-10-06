# WP 9.2 — Real-data readiness: tax treatment, account role, valuation

Status: closed by the finisher (2026-10-06); sabotages recorded as they happened, SABOTAGE count 0 after each.
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

### 2.5 Web sabotages (finisher; `apps/web/src/features/accounts`, `e2e/accounts-overrides.spec.ts`)

Each: a one-line edit tagged `/* SABOTAGE */`, `vitest run src/features/accounts` and the e2e spec against it, restored
from a copy taken first, `grep -c SABOTAGE` printed.

| #   | File                            | Sabotage                                       | Unit red                                                                                                                                                 | e2e red                                                       |
| --- | ------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| W1  | `ProjectionOverridesNotice.tsx` | the stale notice never renders                 | `notices.test.tsx > ProjectionOverridesNotice > says the projection is out of date, names the change, and recomputes only when asked`                    | `waiting for getByTestId('projection-stale-notice')`          |
| W2  | `UnvaluedAccountsNotice.tsx`    | the unvalued notice never renders              | `notices.test.tsx > UnvaluedAccountsNotice > names every account left out, as not counted rather than zero, and every one counted by typed balance`      | `Expected substring: "Not counted:"` (notice not found)       |
| W3  | `overlay-labels.ts`             | a holder-set value is worded as the provider's | `overlay-labels.test.ts > says the holder set it, and a fallback is an assumption, not a fact`; `AccountOverridesPanel.test.tsx > resets through DELETE` | `getByText(/Now: Roth \(tax-free\) — set by you/u)` not found |

Each run: `restored; SABOTAGE count: 0`.

## 3. The resolver (`ledger/src/overrides/resolve.ts`, `planning/src/account-overlay.ts`, subtype map `planning/src/ports.ts`)

`resolveOverlayFor(kind, subtype, override)` computes the provider default from planning's subtype map
(`defaultTaxBucketWithBasis`) and hands it to the ledger's one pure `resolveAccountOverlay`. The accounts
screen, the projection's tax bucket and the valuation basis are all that one answer.

**Provider default (the subtype map, unchanged; the override wins over it)**

| Account kind / provider subtype (lower-cased, trimmed)                                                                                                                                                  | Default      | Basis      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ---------- |
| not `investment` (cash, credit, loan, property …)                                                                                                                                                       | none         | `none`     |
| investment, `529`, `education savings account`, `ugma`, `utma`                                                                                                                                          | none         | `none`     |
| investment, `roth`, `roth 401k`, `roth 403b`, `roth ira`, `tfsa`                                                                                                                                        | ROTH         | `subtype`  |
| investment, `hsa`, `health savings account`                                                                                                                                                             | HSA          | `subtype`  |
| investment, `401a`, `401k`, `403b`, `457b`, `ira`, `keogh`, `lira`, `pension`, `profit sharing plan`, `retirement`, `rrsp`, `sarsep`, `sep ira`, `simple ira`, `thrift savings plan`, `traditional ira` | TAX_DEFERRED | `subtype`  |
| investment, anything else (including a null subtype) — crypto maps to `investment`                                                                                                                      | TAXABLE      | `fallback` |

**Override to effective, and the label the accounts screen shows** (`overlay-labels.ts`; the server resolves, the client only words it)

| Holder set          | Provider default | Effective value | `source`            | Screen text                                                                                   |
| ------------------- | ---------------- | --------------- | ------------------- | --------------------------------------------------------------------------------------------- |
| unset               | from a subtype   | the default     | `provider_subtype`  | "… — from Plaid: 401k"                                                                        |
| unset               | TAXABLE fallback | TAXABLE         | `provider_fallback` | "assumed — Plaid calls this “brokerage”, which is not a tax-advantaged type; set it if it is" |
| unset               | none             | none            | `none`              | "No tax bucket — not applicable to this kind of account"                                      |
| any of 4            | anything         | the override    | `holder`            | "… — set by you"                                                                              |
| role unset          | n/a              | none            | `none`              | "Not set — you have not classified it"                                                        |
| role set            | n/a              | the role        | `holder`            | "… — set by you"                                                                              |
| valuation unset     | n/a              | `holdings`      | `default`           | "Holdings — default"                                                                          |
| valuation `balance` | n/a              | `balance`       | `holder`            | "My typed balance — set by you"                                                               |

A fallback is an assumption and is labelled as one: a mis-typed IRA that falls back to TAXABLE must not look
like a fact the provider stated (CF-16). Clearing every field deletes the row (`account_overrides_not_empty`
forbids an all-NULL row), so "no override" has one representation.

## 4. O-2 before and after, on screen

**Before (HEAD d44af39).** A manual investment account the holder keeps by typing its balance has no priced
holdings. `computeNetWorth` leaves it out of every total (correctly: never zero) but nothing on the plan or
net-worth screen said so: the typed balance counted nowhere and the screen was silent about it.

**After.** `GET /accounts/valuation` is computed live by the snapshot's own `valueAccount` (no FX, no write)
and the plan and net-worth screens render `UnvaluedAccountsNotice`:
"**Not counted:** Typed brokerage (no priced holdings). These are left out of the total, not counted as zero.
If you track one by hand, open it and value it by your typed balance." When the holder sets
`valuation: balance` on that account, it moves from that sentence to "**Counted at your typed balance:**
Rollover. Not from holdings." and its breakdown entry carries `valuedBy: 'balance_override'`. Holdings are tried
first and win whenever they price, so a typed balance can never override priced holdings (P6). Asserted on a
real browser by the e2e (`unvalued-accounts-notice` contains `Not counted:`, `Typed brokerage (no priced
holdings)` and `not counted as zero`, axe-clean in both themes) and at the API by the route test of the same
name as the planning exit test. No screenshot was taken: the e2e's text assertions are the stronger record.

## 5. Exit tests and where each is asserted (C5-11)

| Exit test (09 §3 "WP 9.2")                                                                                                               | Where it runs                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `a holder-set tax treatment wins over the provider subtype, and clearing it returns to the subtype's`                                    | `ledger/test/db/account-overrides.test.ts`; again through the real `app.ts`/`domain.ts` in `apps/api/test/db/account-overrides-routes.test.ts`                        |
| `another user's account can never be overridden`                                                                                         | `ledger/test/db/account-overrides.test.ts` (matrix §2.2); route-level `a second holder's account 404s, never 403-with-existence, …` (§2.4)                            |
| `after a tax-treatment change the stored baseline reads stale and names why`                                                             | `planning/test/db/tax-override.test.ts` (planning's own `withOverlay`); again through the real routes in `account-overrides-routes.test.ts`                           |
| `an account valued by balance counts at that balance and is labelled so; one valued by holdings with none is named unvalued, never zero` | `planning/test/db/tax-override.test.ts`; again through the real routes (`GET /accounts/valuation`) in `account-overrides-routes.test.ts`                              |
| `the holder sets an account's tax treatment by keyboard and the plan says its projection is stale`                                       | `apps/web/e2e/accounts-overrides.spec.ts`, axe-clean in light and dark on the account settings and on the plan with a stale projection. Passed locally, 1 test, 9.3 s |

Cross-user coverage of the new read paths (09 §5 item 8): `GET /accounts`'s overlay block, the planning
roster's overlay join (`createPlanningBalancesReader`, `planningCashflowReaderFor`), `PUT`/`DELETE` and
`GET /accounts/valuation` add **no scoping predicate of their own**; each reads overrides through
`listAccountOverrides({ userId })` (matrix row L1, red alone) and accounts through `listAccounts({ userId })`
(unchanged, its own matrix since Phase 1), and each route takes `userId` from the guard (R1–R4). The
matrix is therefore complete for every predicate of every query this package added.

## 6. Decisions, with reasons

1. **The role list** is AC-7's closed list: `spending | savings | taxable | tax_deferred | tax_free | liability`
   (`docs/research/09-requirements-prd.md` l.118 and l.147). The dispatch says "closed list from 07 §5"; 07
   carries no such list (grep: no `tax_free` role there), so the PRD's AC-7 is the source. Held as a CHECK in
   0035 and a constant in `schema/account-overrides.ts`, and a test asserts the two are the same list.
2. **No step-up on `PUT`/`DELETE /accounts/{id}/overrides`: session only.** A step-up is the policy for a write
   that moves money or net worth (`recordManualBalance`, connections). This writes a holder-side label; it
   cannot move a balance, reach a provider or change a ledger fact, and its one downstream effect (a projection
   reads stale) is visible and reversible. The route test asserts a session is required and a step-up is not.
3. **A changed overlay makes the stored baseline read stale and names the change; it is never silently
   recomputed.** The overlay is part of the projection's input document, so its digest changes
   (`account_overrides_changed`, with each `accountId`/`field`/`from`/`to`); `prepareProjection` refuses to
   recompute without `acceptAccountChanges: true`, which the plan screen's "Recompute with my current
   settings" sends. A holder with no overrides digests the exact bytes they always did (`overrideFingerprint`
   is `null` for nothing set; test `a holder with no overrides digests, caches and reads back exactly as
before`). Role and valuation changes also read stale although they move no bucket.
4. **`PUT` is a full replacement** (omitted or `null` clears a field; none left deletes the row), so the screen
   sends exactly what it shows and there is no merge to get wrong. `DELETE` is idempotent.
5. **Fields an account cannot take are a 422 by name** (valuation on a non-investment/crypto account, a tax
   treatment on a liability); a value outside the closed lists is a 400.
6. **Holdings first, balance only as the fallback.** `valuation: balance` never overrides priced holdings
   (P6); an account valued by balance that has no balance is `no_balance`, not `no_priced_holding`.
7. **Event payload carries the account and the field names, never the values**
   (`ledger.AccountOverrideChanged`; test `every change is announced … never the values`).
8. **Exported** (`account_overrides` in the export registry after `accounts`): a tax treatment the holder set is
   a fact about their own accounts the provider cannot restore.
9. **The e2e spec carries its own mocks** (`page.route` layered over `mock-plan.ts`), so it runs before any
   edit to `support/mock-api.ts`; the shapes are under §7 for the shared mock if the orchestrator wants them
   there.

## 7. Wiring for the orchestrator

**Already applied in the tree (mine):** the `apps/api/src/domain.ts` planning-port binding (imports
`listAccountOverrides`, `overrideFingerprint`, `resolveOverlayFor`, `withOverlay`; `createPlanningBalancesReader`
carries `valuation` when the holder set it; `planningCashflowReaderFor` resolves the bucket through
`withOverlay` instead of `defaultTaxBucketFor`; exports `resolveAccountOverlayFor` and
`accountOverrideFingerprintFor`; `createInsightsPlanningPort`'s `readProjection` passes `accountOverrides`); the
one block in `routes/plan.ts` (the `account_overrides_changed` arm of `ProjectionStaleness`, the
`acceptAccountChanges` body field, `accountOverrides` into `readProjection`); the `account_overrides` row in
`reports/export/registry.ts`; the `accounts-overrides` entry in `apps/web/playwright.config.ts`'s `testMatch`.

**To apply (not mine):**

1. `packages/db/test/migrate.test.ts`, in the 0036 comment block's style, add before the 0036 paragraph (the
   file's blocks run in landing order 0034, 0036, 0040; 0035 is a wave-B migration applied after 0036 on a
   live install, so its place is numeric):

   ```
         // 0035_account_overrides: one @ctx/ledger table — account_overrides (the
         //   holder's overlay on an account: tax_treatment TAXABLE | TAX_DEFERRED |
         //   ROTH | HSA, role spending | savings | taxable | tax_deferred | tax_free |
         //   liability, valuation holdings | balance; one row per (user, account),
         //   present exactly when at least one field is set —
         //   account_overrides_not_empty). Composite FK (user_id, account_id) →
         //   accounts (user_id, id), which needs the one additive UNIQUE
         //   accounts_user_id_id_uniq it adds on accounts (0025/0026 convention, C-14).
         //   CF-16, O-2. WP 9.2; expand-only; references only 0001/0004 objects (09 §4).
   ```

   and in the expected table list insert `'account_overrides',` between `'account_balances',` and
   `'accounts',` (underscore sorts before `s` in both C and en_US collations).

2. `just openapi` then regenerate the web client (`pnpm --filter @app/web gen`): the new operations are
   `setAccountOverrides`, `clearAccountOverrides`, `getAccountValuation`; the changed schemas are `Account`
   (new required `overlay`), `ProjectionStaleness` (new `account_overrides_changed` arm) and the
   `runPlanProjection` body (`acceptAccountChanges`). The committed `packages/contracts/openapi/openapi.json`
   already contains them (the snapshot carried it); `contracts/**` is not mine, so I did not regenerate it:
   `just openapi && git diff --stat packages/contracts` should be empty apart from 9.5's 1.6.0 edits.
3. `mock-api.ts` (shared mock; **optional**, the 9.2 spec does not need it). If other specs render the accounts
   or plan screens against it, they need `overlay` on each account and `GET /api/accounts/valuation`:

   ```ts
   // on every account object
   overlay: {
     taxTreatment: { effective: null, source: 'none', override: null, providerDefault: null },
     role: { effective: null, source: 'none' },
     valuation: { effective: 'holdings', source: 'default' },
   },
   // route
   if (path === '/api/accounts/valuation' && method === 'GET')
     return route.fulfill(json({ asOfDate: '2026-10-06', unvalued: [], byBalance: [] }));
   ```

4. No `.env`/config changes. No new dependency.

## 8. Open items

- **Red-first is shown by sabotage, not by a pre-change tree** (note in §2): the package had no table to run
  against before it existed; every behaviour each exit test claims was broken in turn and the named test
  went red (§2.1–§2.5).
- `role` changes the digest (stale) and the screen, but moves nothing in the projection: AC-7's "balance modelled
  with pre-tax treatment when classified tax_deferred" is served by the tax treatment override, and the two are
  deliberately not tied (no conflict check between role and tax treatment). A later package can make the role
  drive the default.
- The e2e logs `ECONNREFUSED 127.0.0.1:8080` proxy noise for `/auth/unlock-state`, `/insights`, `/ops/backup-status`
  (calls no spec mock answers); it is the same for any spec that does not mock them and does not affect the result.
- Not exercised here: a screenshot of O-2 (the e2e text assertions stand in), and a real-Plaid account; the first
  real projection is Chris's (criterion 5).

## 9. Final check (finisher, 2026-10-06)

- `just typecheck`: green.
- `pnpm exec vitest run --project ledger --project ledger-db --project planning --project planning-db`: 60 files, 433 tests passed.
- `pnpm exec vitest run --project api-db apps/api/test/db/account-overrides-routes.test.ts`: 8 passed.
- `cd apps/web && pnpm exec vitest run src/features/accounts src/features/plan src/features/networth`: 14 files, 75 tests passed.
- `pnpm exec playwright test e2e/accounts-overrides.spec.ts --project=chromium`: 1 passed (axe-clean, both themes).
- `eslint` over every file this package owns: clean. `prettier --check` over the same: clean (the finisher's fix: `resolve.ts` and `account-overrides.test.ts` were unformatted at the snapshot).
- `just lint` / `just check`: red only on other packages' files, none mine — prettier on `docs/evidence/phase-9/wp9.5-narrator.md`, `packages/contexts/insights/{src/advisors/local/narrator.ts,src/validate/pipeline.ts,test/narrator.test.ts}`, `packages/advisors/local-model/src/prompt.ts` (9.5), and eslint `no-unused-vars` in `apps/api/test/db/advisor-preview-api.test.ts` (9.6). `just check`'s `test` step is behind `lint`, so it did not run; the projects above were run directly.
- `grep -c SABOTAGE` over every file touched: 0.
