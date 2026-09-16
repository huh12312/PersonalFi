# Phase 1 close-out — architecture conditions C-5 (D25) and D-6 (N-3)

_Written 2026-09-16 against the working tree at snapshot `6258bb3` plus this
work package. Two close-out conditions from
[gate-security-review.md](gate-security-review.md): **C-5**, "decide R-4 (broad
`merchantId` resolution) before Phase 2 hangs rules and budgets off merchant
identity", and **D-6**, "route the category taxonomy (N-3) so Phase 1's
categorization is reachable from the app". Both are closed here, and the
decision half of C-5 is recorded in the master plan as **D25**._

---

## 1. C-5 / R-4 — merchant identity (decision D25)

### 1.1 The finding, restated

The gate's §5.1 R-4: "`merchantId` resolves from any non-blank descriptor …
merchant identity is derived from attacker-influenced text, and merchant
identity is a _filter key_ on `GET /transactions` and will become a grouping key
for insights in Phase 2." The re-gate confirmed the behaviour rather than the
decision — a CSV import produced merchant rows named `Regate Test Merchant` and
`City Power AND Light` exactly as described.

The deeper problem was not adversarial. It was that `CHECK 1234`,
`TRANSFER TO SAVINGS`, `INTEREST PAID` and `PAYMENT THANK YOU` each earned a
`merchants` row, and Phase 2 hangs subscriptions, recurring detection, rules and
budget groupings off merchant identity. A merchant that is really a banking
operation becomes a budget line nobody can explain, and the user cannot delete
it because sync recreates it.

### 1.2 The rule, in one paragraph

A `merchants` row means "a payee was involved", and nothing else gets one. Four
tiers, first answer wins: **the user's own merchant name** (never gated —
explicit intent); **a provider `counterparties[].entity_id`** (the provider
asserting a payee on evidence we do not have, so it outranks our text
heuristics); **the provider's cleaned `merchant_name`**, gated; **the raw
descriptor**, gated. The gate refuses identity only for a named, enumerable
reason returned as `abstainReason` — `empty`, `too_few_letters`, `self_transfer`
or `bank_operation` — never on a similarity score. Provider entity ids
accumulate on `merchants.provider_entity_ids` namespaced `provider:entityId` as
corroborating evidence for a later entity-first merge, never as the identity
itself. `pruneNoiseMerchants` repairs databases written before the rule.

Full text, with the rejected alternatives and what Phase 2 may hang off
`merchantId`, is [master plan §1, row D25](../../plan/00-master-implementation-plan.md).
The implementation and its reasoning are in
`packages/contexts/ledger/src/normalise.ts`.

### 1.3 Two keys, and why the fingerprint is _not_ gated

`NormalisedMerchant` carries both:

| Field         | Role        | Gated? | Who reads it                                             |
| ------------- | ----------- | ------ | -------------------------------------------------------- |
| `key`         | fingerprint | no     | `dedupKeyOf`, the fuzzy pending→posted matcher           |
| `merchantKey` | identity    | yes    | `ensureMerchants` → `transactions.effective_merchant_id` |

Gating the fingerprint too would be data loss, not tidiness: if
`TRANSFER TO SAVINGS` and `TRANSFER FROM CHECKING` both collapsed to an empty
key, two unrelated transfers on one date for one amount would fingerprint
identically and one would be marked a cross-provider duplicate and hidden.
Losing a real transaction to a tidier merchant table is not a trade worth
making.

### 1.4 Numbers, from the seed corpus

`packages/contexts/ledger/test/merchant-identity.test.ts`, against a real
Postgres, through the real write path (`applyProviderTransactions`), with no
fakes:

| Quantity                                | Value                                                |
| --------------------------------------- | ---------------------------------------------------- |
| Merchants the **pre-D25** rule produced | **37** — recomputed from the dataset, not hard-coded |
| Merchants **D25** produces              | **32** — exactly `MERCHANT_CATALOG`                  |
| Dropped                                 | **5**, all `self_transfer`                           |
| Catalog payees lost                     | **0** (asserted by name; the failure prints _which_) |

The five dropped keys, written out rather than derived so that a change to
_which_ descriptors get dropped fails loudly:

```
transferfromeverydaychecking   transfertobrokerage
transferfromhighyieldsavings   transfertohighyieldsavings
                               transfertorewardsvisa
```

Each is asserted to abstain for reason `self_transfer` specifically — a gate
that abstained on `too_few_letters` here would be cutting real names short and
would still show 32-is-fewer-than-37.

The "37 before" is recomputed here from the dataset rather than quoted, because
a hard-coded before-number proves nothing once the seed changes: it cannot go
stale in the same direction as the after-number.

### 1.5 The two defects, and their fixes

The test author for D25 found both and pinned today's behaviour deliberately so
that a fix could not land without this file being revisited. Both are now fixed
and the tests assert the correct behaviour.

#### Defect 1 — a counterparty entity id alone created an orphan merchant

`apply.ts`'s `resolveMerchants` called `resolveMerchantIdentity` **with**
counterparties and duly created the `merchants` row; the value written to
`transactions.effective_merchant_id` came from `projectEffective` →
`resolveEffective`, which called it **without** them, because `TransactionFact`
carried none. So for a descriptor whose only evidence of a payee was a provider
entity id — `ONLINE PAYMENT` with a Blue Bottle `entity_id` — the row was created
and nothing pointed at it. The visible damage is a `merchants` row with zero
transactions: exactly the orphan a Phase 2 budget or subscription rule would
attach to and never fire.

**Two candidate fixes, and why the chosen one keeps `resolveEffective` pure in
the way that matters.** Both do, technically — neither adds I/O. The difference
is what `resolveEffective` is a pure function _of_:

- _Thread apply's resolved merchant key/id into the projection._ Rejected.
  `resolveEffective` would become a function of "the fact, the overlay, and an
  answer somebody else already computed", which moves one tier of the resolution
  order out of the single function allowed to know it — the exact drift
  `effective.ts`'s header exists to prevent. Worse, it would make
  `effective-invariant.test.ts` a tautology: that suite walks every row in the
  database and asserts the stored `effective_*` columns equal a **fresh
  resolution of the fact and the overlay**, and a projection handed its own
  precomputed answer cannot fail that check.
- _Carry the evidence on the fact the projection sees._ **Chosen.**
  `TransactionFact` gains `provider` and `counterparties` (optional, so the
  hundreds of hand-built fact literals in tests keep compiling; absent means "no
  provider evidence", which is the honest reading for a hand-built fact),
  `factOf` populates them from the row, and both halves of the write path read
  the same input and therefore compute the same key. The slice stays narrow on
  purpose — `raw`, `location` and `providerCategory` remain out, because nothing
  about what a transaction _is_ may depend on a field only one provider sends.

Test 7 now reads
`links the transaction when a counterparty entity id is the only evidence` and
asserts three things: the merchant row exists with its namespaced entity id, the
transaction's `effective_merchant_id` **is** that row's id, and the user's orphan
count — merchants with no referencing transaction — is **0**. The orphan count is
what actually pins the two halves together; the non-null link alone would still
pass if they diverged again in the other direction. A control asserts the bare
descriptor `ONLINE PAYMENT` is refused (`bank_operation`), so the link is the
entity assertion doing the work rather than a gate that never fired.

#### Defect 2 — `PAYMENT THANK YOU` was not refused

`PAYMENT` was in `OPERATION_VOCABULARY`; `THANK` and `YOU` were not, so
`tokens.every(...)` was false and one of the most common credit-card descriptors
there is earned a merchant called `paymentthankyou`. Being a card payment it is
also a transfer, so it must never reach a spend total.

Fixed in two parts:

1. **Data.** `THANK`, `YOU`, `AUTOPAY` and `STATEMENT` are now vocabulary. This
   is safe to extend precisely because the rule fires only when _every_ surviving
   token is vocabulary: `BANK OF AMERICA` keeps `AMERICA`, `CASH APP` keeps
   `APP`, `DIRECT TV` keeps `TV`, and all three still resolve.
2. **Gate.** `PAYMENT - THANK YOU` still resolved, because the bare `-` is a
   token no vocabulary can contain. `merchantAbstainReasonOf` now maps tokens
   through `stripPunctuation` before testing them and drops the ones with no
   alphanumeric content at all. A token compared by its alphanumeric content that
   _has_ none is not a word; filtering can only ever make the rule refuse **more**
   — a real name survives on the strength of a word the vocabulary lacks, and
   punctuation is never that word.

Test 8 now reads `refuses PAYMENT THANK YOU and the other card-payment
phrasings` and asserts refusal with reason `bank_operation` for ten real
phrasings (`PAYMENT THANK YOU`, `ONLINE PAYMENT THANK YOU`,
`PAYMENT - THANK YOU`, `ELECTRONIC/MOBILE/AUTOPAY/CREDIT CARD/DIRECT DEBIT`
variants, `PAYMENT THANK YOU - WEB`, `STATEMENT CREDIT`), asserts a stated
provider merchant name still overrides the gate, and then drives the descriptor
through the real write path to prove the refusal reaches the table: the
transaction lands with a NULL merchant and `merchants` stays empty.

**The seed golden list is unaffected by both fixes** — the counts above (37 → 32,
five self-transfers, zero catalog payees lost) are from a run _after_ the
vocabulary and gate change, and the "no real payee lost" assertion names the
merchant it would have lost.

### 1.6 Tests

| File                                                      | Tests  | What it proves                                                                |
| --------------------------------------------------------- | ------ | ----------------------------------------------------------------------------- |
| `packages/contexts/ledger/src/normalise.test.ts`          | **64** | The tokeniser and the gate as pure functions, including fast-check properties |
| `packages/contexts/ledger/test/merchant-identity.test.ts` | **8**  | The rule against a real Postgres through the real write path                  |

The eight database tests:

1. writes 32 merchants where the pre-D25 rule wrote 37, and loses no real payee
2. drops exactly the five transfer descriptors, each for the `self_transfer` reason
3. links every labelled merchant transaction and no labelled transfer
4. prunes exactly the noise rows, unlinks their transactions, and repeats as a no-op
5. accumulates namespaced entity ids as a sorted union and writes nothing new when it learns nothing
6. lets the provider's stated merchant name rescue a descriptor the text gate refuses
7. links the transaction when a counterparty entity id is the only evidence _(was: OPEN DEFECT)_
8. refuses `PAYMENT THANK YOU` and the other card-payment phrasings _(was: records that it is not refused)_

Test 4 observes `ON DELETE SET NULL` from migration 0004 firing rather than
assuming it, and uses transfer rows as the victims deliberately: their
`effective_merchant_id` is already NULL, so the only way it can be NULL at the
end is if the delete unlinked them. Test 5 drives `recordEntityIds`'s
`array_cat` + `jsonb_array_elements_text` + `NOT (… @> …)` update — code that had
never run against a real Postgres before this file — through first id, sorted
union, and a re-sighting that must write **nothing**, checked against
`updated_at` with the clock deliberately advanced, because "the array did not
change" is also true of an update that rewrote it identically.

`ledger` + `ledger-db`: **195 tests, 14 files, all passing.**

### 1.7 No migration

D25 ships no `0009_*.sql` backfill, deliberately. The rule is ~200 lines of
tokenisation plus an English operation vocabulary; a SQL transcription would be a
second implementation that drifts the day somebody adds a word. It could not even
be written faithfully — `merchants.normalized_key` is squashed to `[a-z0-9]+`, so
`transfertorewardsvisa` has no token boundaries left for SQL to find. What the
rule _can_ re-run against is `display_name`, which keeps its spacing, and that is
what `pruneNoiseMerchants` reads. It is idempotent, walks `merchants` (tens of
rows) rather than `transactions` (tens of thousands), and nothing the user
authored is lost — a renamed payee lives in the `user_merchant_name` overlay on
the transaction, never in `merchants`.

---

## 2. D-6 / N-3 — the category taxonomy, reachable from the app

### 2.1 The finding, restated

The re-gate could not set a category _through the UI_. Not because the write path
was broken — `PATCH /transactions/{id}` with a `categoryId` was proven, in a real
browser through the real proxy with a real CSRF token, to persist and read back.
There was simply nothing to pick from:

```
$ node -e "…Object.keys(openapi.paths).filter(p => /categor/.test(p))"
[]

$ docker compose exec db psql -U personalfi -d personalfi -c 'select count(*) from categories'
 0
```

`seedSystemTaxonomy` had existed since WP 1.4 and was called **only from tests**.
So on a fresh deployment the taxonomy was empty _and_ unroutable. Both halves had
to be fixed; either alone leaves the same empty picker.

### 2.2 The route

`apps/api/src/routes/categories.ts` — a factory taking `RouteDeps`,
`guards.requireSession`, Zod `.meta({ id: 'Category' })`, `problems(401, 503)`,
tag `categories` added to the swagger tags in `app.ts`. It delegates to
`listCategories` from `@ctx/categorization` and contains no SQL.

`listCategories` reads the **table**, never the `TAXONOMY` constant, and that is
the point of the function: the constant is what we ship, the table is what the
user has, and after a rename or a custom category they differ. Serving the
constant would produce a picker whose entries do not match the ids the write path
accepts — a worse bug than the empty picker it replaces.

The response is **flat, in display order, with `parentId` on each row** rather
than nested. A tree in OpenAPI 3.1 is a self-referencing `$ref` that `openapi-ts`
generates as a recursive type the picker then flattens anyway; the sort order the
user sees is a property of the list and survives flattening but not nesting; and
a user's own custom category is one more row here and a special case there.
`assignable` is computed by the read model from the table's own parent/child
shape (a row with children is a heading, not a destination), so the client never
has to know that rule.

### 2.3 Production seeding — where it goes, and why

**In `apps/api/src/app.ts`, as an `onReady` hook, calling
`ensureTaxonomy(database, { userIds, clock })`.** Five choices, each with its
alternative:

| Choice                           | Rejected alternative                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| At boot                          | **A migration.** `categories` is `user_id`-scoped (D6) and migrations run before any user exists — `just bootstrap-user` creates the first one afterwards — so there is nothing for a migration to seed. An applied migration is immutable while `TAXONOMY` gains categories in later releases, and transcribing ~130 rows into SQL would give the app two copies of its own taxonomy.                                                                                                                               |
| In `app.ts`                      | **`modules.ts`** is the event-consumer registry and this is not a consumer. **`UserService.createPrimary`** would put a categorization concern inside the identity context, and would only ever run for users created _after_ this release — leaving the one user who already exists with the empty picker the re-gate found.                                                                                                                                                                                        |
| Caller supplies the user ids     | **`seedAllUsersTaxonomy` reading `users` itself.** That was the first draft and `check-schema-ownership` refused it: `users` belongs to `@ctx/identity`. "Which users exist?" is a question only the composition root may ask. `app.ts` asks identity's own `UserService` (`security.users()`, deliberately usable before the KEK exists — the same call `worker.ts` already makes) and passes the ids in. `ensureTaxonomy` takes a **list**, so when identity grows a multi-user reader only the call site changes. |
| `onReady`                        | **Inline in `buildApp`.** `buildApp` is called by `emit-openapi` and by the shell tests with no database behind it at all; an inline await would make every one of them pay a failing round trip before a single route was registered.                                                                                                                                                                                                                                                                               |
| Logged and survived, never fatal | **Crash on failure.** Same reasoning `main.ts` already applies to the config snapshot: a database that is up but not yet migrated should get an API that can _say so_ on `/ready`, not a crash loop that tells the operator nothing. Observed in the suite output — `app.test.ts` builds the shell against an unreachable pool and logs `could not seed the category taxonomy; continuing`, then serves `/health` 200.                                                                                               |

Idempotent by construction: `seedSystemTaxonomy` is an
`ON CONFLICT (user_id, key) DO UPDATE` over ~130 rows that reuses the existing
id, so running it every boot re-issues nothing `category_assignments` already
points at, and is how a category added in v0.3 reaches a user created in v0.1.
Cost on the happy path is one pass that writes nothing.

### 2.4 A real bug the tests caught

`archived_at` is a `TIMESTAMPTZ`. Read through Drizzle's **query builder** it
arrives as a `Date`; read through `executor.execute()` with raw SQL — which is
what `listCategories` does — it arrives as the wire string
`2026-09-16 14:28:13.829141+00`. `categories.ts` declared it `Date | null` and
passed it straight to the response serialiser, so **every archived category
turned `GET /categories?includeArchived=true` into a 500** (`toISOString is not a
function`). The row type is now `string | Date | null` and the mapper converts —
which is what `explainAssignment` in the same package already does for
`decided_at`, for the same reason.

### 2.5 The frontend

- `apps/web/src/features/categories/useCategories.ts` — spreads
  `listCategoriesOptions()` with a five-minute `staleTime`. The chart changes on
  a rename or a release, never on a sync or an edit, so every screen rendering a
  picker shares one query key and the list is fetched once per session. Five
  minutes rather than `Infinity` so a long-lived tab eventually picks up a
  category a release added. Exposes `byId` and a `groups` projection
  (parent → children, in the server's order, skipping empty groups), built in the
  hook rather than in the picker so the grouping is shared and testable without
  rendering a `<select>`.
- `apps/web/src/features/transactions/CategoryPicker.tsx` — grouped
  `<optgroup>` options, `kind` on the group label when it is not `expense`
  (repeating "expense" twenty times hides the four labels that matter) and as
  `data-kind` on every option, `"Uncategorized"` as the `value=""` null option.
  A heading is never selectable, enforced by the markup: `<optgroup label>` is
  not a value. A `value` the list does not contain — an archived category, or a
  list that has not arrived — renders as an extra option rather than snapping the
  select to "Uncategorized", where the next change event would silently clear a
  real assignment. The select stays enabled while loading, because disabling it
  makes a slow network look like a read-only field.
- **`TransactionDetailSheet` and `BulkActionBar` are unchanged.** The picker's
  props and its write (`categoryId` on `TransactionOverlayPatchInput`) are
  exactly what they were, which is why the original placeholder's own doc comment
  claimed the wiring "needs no rework once the route ships". It did not.
- `TransactionsFilterBar`'s comment is corrected: filtering _by_ category is
  still absent, now for a different reason — `GET /transactions` has no
  `categoryId` parameter, so a picker there would be a control that narrows
  nothing. Phase 2's reports work adds both halves together.

### 2.6 Tests

| File                                                         | Tests | Scope                                       |
| ------------------------------------------------------------ | ----- | ------------------------------------------- |
| `apps/api/test/db/closeout-categories.test.ts`               | **5** | Real app, real Postgres, `app.inject`       |
| `apps/web/src/features/transactions/CategoryPicker.test.tsx` | **5** | The picker over a stubbed `GET /categories` |
| `apps/web/e2e/app-walkthrough.spec.ts`                       | 1     | Real browser, real client, mocked network   |

The API suite's strongest test is the one with **no arrange step**:
`createApiHarness` creates a scratch database, migrates, inserts one user and
calls `app.ready()` — `main.ts`'s own boot sequence — and the first assertion is
that `GET /categories` returns the whole shipped taxonomy. Nothing in the test
calls `seedSystemTaxonomy` first. If the hook did not exist, seeded the wrong
user, or swallowed an error into an empty table, that assertion goes red against
an empty array, which is the re-gate's finding reproduced from the inside.

1. serves the whole shipped taxonomy on a fresh database, with no seeding step —
   count equals `FLAT_TAXONOMY.length`, key set matches, `sort` is non-decreasing,
   every `parentId` resolves inside the same response, headings are
   `assignable: false` and leaves are `true`
2. is idempotent across boots: a second pass inserts nothing and changes no id
3. refuses an unauthenticated caller with **401**
4. hides an archived category unless it is asked for (and this is the test that
   found §2.4's 500)
5. gives a second user their own chart and never the first user's rows — same
   keys, **disjoint ids**, and a SQL check that every id the route handed the
   second user is owned by the second user in the table

Test 5 also states honestly what the seeding choice costs: a row inserted
straight into `users` (which only a test can do — `createPrimary` refuses a
second user) gets a **200 with an empty list**, not somebody else's categories,
until a pass names it.

The picker suite asserts the grouping, that no option carries a heading's id,
that selecting emits the category **id** rather than a label or a key, that
choosing "Uncategorized" emits `null`, that an unknown current value is preserved
rather than cleared, and that a failed request degrades to the null option with
the field still enabled.

`TransactionsScreen.test.tsx`'s detail-sheet test now makes the category edit as
well as the note edit, and asserts the PATCH body is
`{ categoryId: 'cat_dining_coffee' }`.

`/api/categories` is stubbed in `apps/web/src/test-support/api-test-utils.ts`
(`categoriesRoute()`, shared, plus the `TEST_CATEGORIES` fixture) and added to
all ten `stubFetchRoutes` lists across `TransactionsScreen.test.tsx`,
`AccountsScreen.test.tsx` and `ConnectionsScreen.test.tsx` — `stubFetchRoutes`
throws on an unstubbed path by design, so a screen that starts rendering a picker
breaks every suite that mounts it, which is the behaviour we want.

`apps/web/e2e/support/mock-api.ts` serves `/api/categories`. The re-gate's own
note about this walkthrough was that "the mocked Playwright walkthrough cannot
see that because its mock serves a category list the real API does not have" —
which was true in the sense that it served nothing, so the category step could
only ever _clear_ a category. `app-walkthrough.spec.ts` now selects **by visible
label** ("Coffee Shops"), asserts the real id reaches the PATCH body
(`{ categoryId: 'cat_dining_coffee' }`), asserts the heading "Dining" is not an
option, then still proves clearing works; and `apiRequestPaths` now includes
`/api/categories`, so the list is provably fetched from the API under the `/api`
namespace rather than compiled into the bundle.

---

## 3. Verification

Run on the working tree, against a scratch Postgres (`personalfi_wp_cat2`).
`just verify` was **not** run — the ops close-out agent is exercising compose
concurrently and `just verify`'s image and Caddy steps would collide.

`just check` — typecheck, lint (prettier + eslint + schema-ownership),
check-proxy-routes, test — **passes end to end**:

```
$ just check

$ tsc -p tsconfig.json                                  (clean)

$ prettier --check .
Checking formatting...
All matched files use Prettier code style!

$ eslint .
✖ 1 problem (0 errors, 1 warning)
  (pre-existing: react-hooks/incompatible-library on TransactionsList.tsx's
   useVirtualizer, untouched by this work package)

$ node scripts/check-schema-ownership.ts
schema-ownership: ok — 95 table(s) claimed across 14 package(s), 42 defined.

$ node scripts/check-proxy-routes.ts
check-proxy-routes: PASS — docker/Caddyfile routes exactly '/api/*' to the api,
matching packages/contracts/openapi/openapi.json's servers[0].url ('/api') and
covering all 12 contract prefix(es): /accounts, /auth, /categories, /connections,
/connectors, /health, /imports, /net-worth, /ready, /sync, /transactions, /transfers.

$ vitest run
 Test Files  102 passed | 1 skipped (103)
      Tests  1583 passed | 2 skipped (1585)

$ vitest run            (apps/web)
 Test Files  15 passed (15)
      Tests  85 passed (85)
```

Playwright, run separately:

```
$ pnpm --filter @app/web exec playwright test --project=chromium --project=csp
  7 passed (25.2s)
```

`check-proxy-routes` listing `/categories` among the twelve contract prefixes is
itself part of the D-6 evidence: the new route is reachable through the same
`handle_path /api/*` namespace F-4/C-1a established, and not by accident.

The whole-tree numbers include the concurrent staging and ops close-out agents'
work, which was on disk at the same time; the suites this work package owns are
broken out in §1.6 and §2.6.

The `csp-plaid` Playwright project was **not** run: it starts and stops its own
Caddy containers via `docker`, which would collide with the ops agent's compose
work. It is untouched by this change.

---

## 4. What remains

- **`csp-plaid` and `just verify`** need a re-run once the ops agent releases
  compose. Nothing in this work package touches the proxy, the images or the
  compose files.
- **No `POST /categories`.** The picker is read-only, and 05 §5.2's searchable
  combobox with a "create new category" escape hatch still needs a write route to
  be worth building. Phase 2.
- **No category filter on `GET /transactions`.** Noted in §2.5; the filter bar
  keeps its "Uncategorized only" toggle until the contract grows a `categoryId`
  parameter.
- **Multi-user seeding waits on identity.** `ensureTaxonomy` already takes a list
  of user ids; `apps/api/src/app.ts` supplies `findPrimary()`'s single answer
  because that is identity's only enumeration and `createPrimary` refuses a
  second user outright.
- **D26 (Plaid Link CSP/COEP exception)** is still `PROPOSED` and awaits Chris's
  ratification. Untouched here.
