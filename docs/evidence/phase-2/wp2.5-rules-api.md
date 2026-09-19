<!-- SPDX-License-Identifier: MIT -->

# WP 2.5 — Carry-over REST surface: rules, categories, manual entry, D2-1/D2-2

Scope: `apps/api/src/routes/{rules,categories,accounts,connections,transactions,domain-errors}.ts`,
`apps/api/src/app.ts` (route registration + swagger tags), `apps/api/src/bin/bootstrap-user.ts`,
`packages/contexts/categorization/src/**`, `packages/contracts/openapi/openapi.json`,
`apps/web/src/api/**` (regenerated only), one stale line in
`docs/evidence/phase-1/closeout-architecture.md`.

Repo `/home/chris/Projects/PersonalFi`, branch `main`, snapshot `aa6dbc1` plus this
work package. Two prior Sonnet agents had landed `POST/PATCH/DELETE /categories`,
the whole `/rules` surface except registration, `IMPLEMENTED_ACTIONS`
(`link_recurring`/`notify`), the retrain schedule (`schedule.ts`), and the D2-1
lazy repair in `routes/categories.ts` before this session started; this session
finished registration, the manual-entry routes, the rule-from-transaction route,
D2-2, the `bootstrap-user.ts` half of D2-1, the closeout-architecture.md
correction, and every exit test.

---

## 1. Corrected carry-over list

The Phase 2 dispatch (§2) inherited two claims from `closeout-architecture.md §4`
that needed correcting on contact with the actual code:

| Dispatch claim                                                                                  | Correction                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `categoryId` filter on `GET /transactions` is missing                                           | **Stale.** `GET /transactions` already accepts `categoryIds` (plural), `apps/api/src/routes/transactions.ts:183/187`, and it was in `openapi.json` before this WP touched anything. What was actually missing is the UI control (WP 2.11). The stale bullet is deleted from `closeout-architecture.md §4` in this WP, per instruction — **not** replaced with a `categoryId` parameter.                                                                        |
| `POST /imports/csv` reports `staged: 0` on the first upload                                     | **Confirmed real (D2-2).** The route lives in `apps/api/src/routes/connections.ts`, not `apps/api/src/routes/imports.ts` — that file has never existed. `CsvImportConnector.connect()` calls its own `addFile` once per file and discards each call's `{staged, skipped}`. Fixed by `stagedCountsOf()` (`connections.ts`), which recomputes the identical count with the identical pure parse (`importFile`) after `connect()` has already succeeded — see §4. |
| `PROCESS_LOCAL_PROVIDERS` header comment at `connections.ts:25–31` is stale (pre-D-5 rationale) | **Already correct on arrival.** The header found at session start already states the post-D-5 rationale ("PROCESS_LOCAL_PROVIDERS … no longer gates correctness anywhere … only latency"), matching `domain.ts:44`'s own comment. No edit was needed; recorded here so the correction is not silently dropped from the record.                                                                                                                                 |
| No REST surface for rules                                                                       | Landed: `GET/POST/PATCH/DELETE /rules`, `POST /rules/preview`, `POST /rules/{id}/apply` (see §2.4 below for why `/apply` exists beyond the dispatch's literal wording), `POST /transactions/{id}/rule`.                                                                                                                                                                                                                                                        |
| No `POST /categories`                                                                           | Landed: `POST` (create), `PATCH` (rename/re-describe), `DELETE` (archive, cascades to non-archived children).                                                                                                                                                                                                                                                                                                                                                  |
| Manual balance/transaction entry has no route                                                   | Landed: `POST /accounts/{id}/balance`, `POST /accounts/{id}/transactions`.                                                                                                                                                                                                                                                                                                                                                                                     |
| `link_to_recurring`/`notify` beyond `set_category`                                              | Landed as `link_recurring`/`notify` in `IMPLEMENTED_ACTIONS` (`rules/schema.ts`) — validated, recorded on `categorization.RuleApplied`, inert until WP 2.3/2.4 give them a target. See §5.                                                                                                                                                                                                                                                                     |
| Retrain schedule                                                                                | Landed: `registerRetrainSchedule`/`retrainJobHandler`/`RETRAIN_CRON` (weekly, Sunday 04:00, 30-minute jitter) in `packages/contexts/categorization/src/schedule.ts`, exported from the context's `index.ts`. **Not yet wired into `apps/api/src/modules.ts`** — that file is explicitly out of this WP's ownership. The exact addition for the orchestrator to apply: see §7.                                                                                  |

---

## 2. Routes and auth policy

Every route below is `apps/api`'s real Fastify app, over a real Postgres, driven
by `app.inject` (`apps/api/test/helpers/api-harness.ts`) — no route double.

| Route                               | Auth                                | Why                                                                                                                                                                                                                                                                                                          |
| ----------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /rules`                        | session                             | Read.                                                                                                                                                                                                                                                                                                        |
| `POST /rules`                       | session                             | Same shape of write as `PATCH /transactions/{id}`'s overlay: user data, not a credential.                                                                                                                                                                                                                    |
| `PATCH /rules/{id}`                 | session                             | ″                                                                                                                                                                                                                                                                                                            |
| `DELETE /rules/{id}`                | session                             | Idempotent delete, scoped by `user_id` in the `WHERE` clause — a rule that is not yours returns `{deleted: false}`, 200, not 404 (mirrors `archiveCategory`'s `changed: boolean`).                                                                                                                           |
| `POST /rules/preview`               | session                             | Writes nothing; the safety net for `/apply` is the preview, not step-up.                                                                                                                                                                                                                                     |
| `POST /rules/{id}/apply`            | session                             | Retroactive, can touch thousands of rows, but the risk is "I did not mean to do this to my own data" (answered by preview), not "someone else is acting as me" (answered by step-up). Added in this WP beyond the dispatch's literal "`POST /rules/preview` over `applyRule({preview})`" wording — see §2.4. |
| `POST /transactions/{id}/rule`      | session                             | Same policy as the rest of `/rules`; tagged `rules` in OpenAPI, lives in `transactions.ts` because it needs the transaction lookup that file already has.                                                                                                                                                    |
| `GET /categories`                   | session                             | Read, plus the D2-1 lazy repair (§3).                                                                                                                                                                                                                                                                        |
| `POST /categories`                  | session                             | Same reasoning as `POST /rules`.                                                                                                                                                                                                                                                                             |
| `PATCH /categories/{id}`            | session                             | ″                                                                                                                                                                                                                                                                                                            |
| `DELETE /categories/{id}` (archive) | session                             | Idempotent (`changed: false` on a second archive), scoped by `user_id`.                                                                                                                                                                                                                                      |
| `POST /accounts/{id}/balance`       | **step-up** (`requireFreshSession`) | Matches `connections.ts`'s policy: a manual balance changes net worth exactly the way linking a connection does. A stolen session cookie must not be enough to inflate a balance that net worth and (later) budgeting treat as ground truth.                                                                 |
| `POST /accounts/{id}/transactions`  | **step-up**                         | Same reasoning — a fabricated transaction is the same class of harm as a fabricated connection.                                                                                                                                                                                                              |
| `POST /imports/csv`                 | session                             | Unchanged from Phase 1; a file upload is not a credential attachment. Its behavior fix is D2-2 (§4), not its auth policy.                                                                                                                                                                                    |

Every route above was asserted, in this session, for:

- **401 with no real session** (a syntactically valid but bogus session token,
  carrying a same-origin CSRF pair so the assertion is about the route's own
  guard and not about the root CSRF hook — `connections-routes.test.ts`'s own
  "rejects an anonymous import at the CSRF gate" pins the CSRF-first ordering
  separately).
- **403 `step_up_required`** on the two manual-entry routes with a stale
  (non-fresh) session.
- **Cross-user refusal**: a second user's `GET /rules` never sees the first
  user's rows; `PATCH`/`DELETE /rules/{id}` on someone else's rule is a 404 (or,
  for delete, a 200 with `deleted: false`); `PATCH`/`DELETE /categories/{id}` on
  someone else's category is a 404; `POST /accounts/{id}/balance` and
  `POST /accounts/{id}/transactions` on someone else's account are 404.

---

## 3. D2-1 — a fresh install never seeded the taxonomy

**Two new call sites**, both proven with sabotage:

1. `GET /categories` (`routes/categories.ts`) — an idempotent lazy repair: when
   `listCategories` returns zero rows for this session's user, `ensureTaxonomy`
   runs once, inline, and the read repeats only if it actually inserted
   something. Covers every user-creation path, present or future, with no api
   restart. **Landed before this session** (confirmed present, read, and left
   unchanged).
2. `apps/api/src/bin/bootstrap-user.ts` — calls `ensureTaxonomy` immediately
   after `createPrimary`, in the branch that creates a brand-new user (not the
   `reissue` branch, which runs against a user that already has one). Belt and
   braces with (1): the specific, common case of the very first account holder,
   proven from the script's own source. **Landed this session.**

The `app.ts` `onReady` pass is unchanged and stays as the idempotent repair for
an existing install when a release adds categories to `TAXONOMY`.

**Sabotage, both call sites, both observed red:**

```
$ (temporarily removed the lazy-repair block in routes/categories.ts)
✗ a user created after boot has a taxonomy without an api restart
  AssertionError: expected [] to have a length of 153 but got +0

$ (restored; temporarily removed the ensureTaxonomy call in bootstrap-user.ts)
✗ calls ensureTaxonomy right after createPrimary, not only through the api onReady pass
  AssertionError: … expected false to be true

$ (restored both; full re-run)
✓ apps/api/test/db/taxonomy-bootstrap.test.ts (2 tests) 2/2 passed
```

Both sabotages were caught on the first attempt, restored, and re-verified
green — `git diff` against the tree at the end of this session shows neither
call site missing.

**Cold-boot proof.** Not executed this session (time budget): the DB-harness
test above and the source-text assertion against `bootstrap-user.ts` are the
proofs of record for now. The exit criterion the gate should still run
independently: `docker compose build && docker compose down -v && docker compose
up -d`, `just bootstrap-user`, `GET /api/categories` non-empty with **no**
restart anywhere in between. Recorded as owed to the gate, not skipped
silently.

---

## 4. D2-2 — `POST /imports/csv` reported `staged: 0` on the first upload

**Correction on the file location:** the dispatch text says
`apps/api/src/routes/imports.ts`; the route has always lived in
`apps/api/src/routes/connections.ts`, alongside every other provider-linking
route. That file is where the fix and the test both live.

**The bug.** For a brand-new connection, the route delegates entirely to
`connector.connect()`, which calls its own `addFile` once per file and discards
the `{staged, skipped}` each call returns. The response hard-coded
`staged: 0, skipped: 0`. The rows landed correctly (D-5's durable staging is
unrelated and unaffected) — this was a reporting bug, not a data-loss bug,
exactly as the dispatch text says.

**The fix, and why it is a second parse rather than a connector change.**
`stagedCountsOf()` (`connections.ts`) recomputes the count with the identical
pure function `CsvImportConnector.addFile` itself calls (`importFile` from
`@connector/csv`, cumulative content-hash dedup by `providerTransactionId`),
run _after_ `connect()` has already succeeded — so if any file had failed to
parse, `connect()` would already have thrown and this never runs. This was a
deliberate choice over changing `CsvImportConnector`/`ConnectResult`: the
connector's in-memory state is not this file's to reach into without expanding
this WP's ownership into `packages/connectors/csv`, and a CSV upload is already
bounded (1 MiB body limit, 20 files), so paying the parse twice costs
milliseconds, not correctness.

**Sabotage:**

```
$ (temporarily reverted the new-connection branch to `staged: 0, skipped: 0`)
✗ a first cold upload reports staged equal to the row count
  AssertionError: expected +0 to be 3
✗ a second upload onto the same connection reports only the new rows
  AssertionError: expected +0 to be 1

$ (restored; full re-run)
✓ apps/api/test/db/imports-staged-count.test.ts (3 tests) 3/3 passed
```

---

## 5. Action blast radius: what `link_recurring` and `notify` can and cannot reach

Both moved from the schema's "inert" bucket into `IMPLEMENTED_ACTIONS`
(`packages/contexts/categorization/src/rules/schema.ts`) in a prior session
within this WP. "Implemented" here means **validated and recorded, not
executed**:

- A rule carrying `link_recurring` (`seriesKey: string`) or `notify`
  (`message: string`) is accepted by `POST`/`PATCH /rules` and by
  `createRuleFromTransaction`.
- `applyRule` matches it exactly like any other rule and, on a real (non-preview)
  apply, computes `actionsRecorded` — the subset of the rule's non-`set_category`
  actions that are in `IMPLEMENTED_ACTIONS` — and carries it on the
  `categorization.RuleApplied` event and in the HTTP response.
- **Neither action does anything else.** There is no `recurring_series` row for
  `link_recurring` to point at (WP 2.3's table), and no channel for `notify` to
  send through (WP 2.4's `NotificationChannel`). No code path in this WP reads
  `seriesKey` or `message` for any purpose beyond validating its shape and
  echoing that it fired. Concretely:
  - `notify` cannot send an email, a push, or an ntfy message — no transport
    exists yet that this rule engine can reach.
  - `link_recurring` cannot create, modify, or delete a `recurring_series` row
    — no such table exists yet.
  - Both are ordinary JSON stored in `rules.actions` (jsonb) and read back
    verbatim; there is no interpolation, no template rendering, and no
    outbound network call anywhere in this WP's code.
- The blast radius today is therefore: **zero.** A user can author a rule that
  _says_ it will notify them or link a subscription, and the UI (WP 2.11, not
  yet built) would need to say so honestly — "recorded, not yet acted on" is
  the wording used in the route's own OpenAPI description
  (`RuleApplyResult.actionsRecorded`) for exactly this reason.

---

## 6. Manual entry: bigint minor units, mandatory fingerprint, provider `manual`

`POST /accounts/{id}/balance` calls `@ctx/ledger`'s `recordBalance` directly —
the same writer every provider's sync uses, `source: 'manual'`. It validates
that the account belongs to the caller, is `provider: 'manual'` (422
`ledger.account_not_manual` otherwise), and that the posted currency matches the
account's own (409 `ledger.currency_mismatch` otherwise, via `recordBalance`
itself).

`POST /accounts/{id}/transactions` calls `@ctx/ledger`'s
`applyProviderTransactions` directly — the same writer a sync's page uses — with
`provider: 'manual'`. Each entered row is built through
`@connector/manual`'s `manualTransaction()`, which computes the **mandatory**
`fingerprint` (08 §2.5) and a content-hash `providerTransactionId`, so entering
the same row twice is an upsert (`addedTransactionIds` empty on the repeat),
not a duplicate. Every amount travels as `{minor: string, currency}` on the
wire and is converted through `Money.fromJSON` before it reaches either ledger
writer — no `number` touches a `*_minor` column anywhere in this path.

Both routes deliberately **bypass** `ManualConnector`/`ManualStore`: that pair
exists to give a _new_ manual account its `connect()` and a sync history, but
`recordBalance`/`applyProviderTransactions` are the actual ledger writers
underneath every adapter's sync, already scoped to `(userId, accountId)` and
already the one place `TransactionsUpserted`/`BalanceRecorded` are emitted. A
second path through the connector would be a second way to reach the same
table — see `routes/accounts.ts`'s module comment for the full reasoning.

Exit test (`manual-entry.test.ts`, `'a manual balance appears in GET /accounts
and in net worth'`): records a balance, confirms it is the `balance` field on a
fresh `GET /accounts`, confirms it appears in `GET /net-worth`'s `inputs` with
`included: true`, and confirms the USD total is at least that balance. 6/6
tests in the file pass, including the currency-mismatch, non-manual-account,
step-up, and cross-user cases.

---

## 7. The one line owed to `apps/api/src/modules.ts`

`apps/api/src/modules.ts` and `apps/api/src/platform.ts` are explicitly out of
this WP's ownership (the orchestrator applies shared files between waves). The
retrain schedule (`packages/contexts/categorization/src/schedule.ts`,
`registerRetrainSchedule`/`retrainJobHandler`/`RETRAIN_CRON`, both exported from
the context's `index.ts`) is built and tested but **not wired in**. The exact
addition, in the shape `schedule.ts`'s own doc comment already specifies:

```ts
// modules.ts imports: add `registerRetrainSchedule, retrainJobHandler` to the
// existing `from '@ctx/categorization'` import.

{
  flagKey: 'module.categorization',
  events: CATEGORIZATION_EVENTS,
  consumers: [
    createCategorizationConsumer({
      database,
      port: createCategorizationLedgerPort(database, clock),
    }),
  ],
  jobs: [retrainJobHandler(database)],
  schedules: async (userId: string): Promise<void> => {
    await registerRetrainSchedule(database, { userId, timezone: options.timezone }, clock);
  },
},
```

This replaces the current `module.categorization` entry (which today has no
`jobs`/`schedules` keys) in `appModules()`.

---

## 8. Verification

```
$ pnpm exec tsc -p tsconfig.json --noEmit
(clean — this WP's files; see caveat below)

$ pnpm exec eslint <every touched file>
(clean)

$ just openapi
wrote /home/chris/Projects/PersonalFi/packages/contracts/openapi/openapi.json

$ just check-proxy-routes
check-proxy-routes: PASS — docker/Caddyfile routes exactly '/api/*' to the api,
matching packages/contracts/openapi/openapi.json's servers[0].url ('/api') and
covering all 13 contract prefix(es): /accounts, /auth, /categories,
/connections, /connectors, /health, /imports, /net-worth, /ready, /rules,
/sync, /transactions, /transfers.

$ pnpm --filter @app/web gen && pnpm --filter @app/web run typecheck
(clean — sdk.gen.ts carries recordManualBalance, createManualTransactions,
createRuleFromTransaction, listRules, createRule and every other new
operation)

$ DATABASE_URL=… pnpm exec vitest run --project api --project api-db \
    --project categorization --project categorization-db
 Test Files  34 passed | 1 skipped (35)
      Tests  481 passed | 1 skipped (482)
```

**`just check` does not pass right now**, and the failure is entirely outside
this WP's ownership: `pnpm run typecheck` fails on
`packages/contexts/notifications/src/adapters/ntfy.ts` (`EgressDecision` has no
`code`/`detail` on its `ok: true` branch — WP 2.4, in flight concurrently), and
`pnpm run lint`'s format check additionally flags
`packages/contexts/insights/src/contract/version.ts` and three more
`packages/contexts/notifications/**` files (WP 2.6/2.4, also in flight). None of
these paths are in this WP's owned-files list, and a `tsc -p tsconfig.json
--noEmit` run earlier in this session — before those concurrent edits landed —
was clean project-wide. Every file this WP owns individually typechecks,
lints, and passes its tests; `just check`'s dependency chain does not run far
enough to prove `test`/`check-proxy-routes` on the current tree because it
stops at the first failing recipe (`typecheck`), which is not this WP's.

---

## 9. Files touched

- `apps/api/src/routes/rules.ts` — exported `ruleRecordSchema`/`serialiseRule`
  for reuse by `transactions.ts`; fixed a readonly→mutable array mismatch in
  the two apply-result handlers (`serialiseApplyResult`).
- `apps/api/src/routes/transactions.ts` — added `POST /transactions/{id}/rule`;
  removed a duplicate `mapDomainErrors` import and unused
  `actionsSchema`/`conditionsSchema`/`Rule` imports left over from a prior
  session's partial edit.
- `apps/api/src/routes/accounts.ts` — added `POST /accounts/{id}/balance` and
  `POST /accounts/{id}/transactions`, plus the `requireManualAccount` guard.
- `apps/api/src/routes/connections.ts` — D2-2 fix (`stagedCountsOf`,
  `resolveImportProfile`); confirmed the `PROCESS_LOCAL_PROVIDERS` header
  comment already matches post-D-5 reality.
- `apps/api/src/app.ts` — registered `ruleRoutes`; added the `rules` swagger
  tag.
- `apps/api/src/bin/bootstrap-user.ts` — D2-1 call site 2.
- `apps/api/test/db/{rules-routes,categories-write,taxonomy-bootstrap,
imports-staged-count,manual-entry}.test.ts` — new.
- `apps/api/test/db/closeout-categories.test.ts` — updated one assertion in
  `'gives a second user their own chart…'` that assumed the pre-D2-1 empty
  state; the lazy repair this WP's predecessor landed made that assumption
  false, and the test now asserts the corrected, intended behavior instead of
  reverting the fix.
- `packages/contracts/openapi/openapi.json`, `apps/web/src/api/generated/**` —
  regenerated.
- `docs/evidence/phase-1/closeout-architecture.md` — deleted the stale
  "No category filter on `GET /transactions`" bullet from §4.
- `docs/evidence/phase-2/wp2.5-rules-api.md` — this file.

No package.json, lockfile, `domain.ts`, `modules.ts`, or `platform.ts` edits.
No commits made; the orchestrator commits after `just verify`.

---

## 10. Open

- The `modules.ts` wiring in §7 — one edit, for the orchestrator to apply.
- The cold-boot proof in §3 — owed to the gate, not executed this session.
- `just check` / `just verify` will not be fully green until the concurrent
  WP 2.4/2.6 work in `packages/contexts/{notifications,insights}` lands and
  typechecks; nothing in that gap is this WP's.
