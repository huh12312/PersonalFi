<!-- SPDX-License-Identifier: MIT -->

# WP 1.1 — Ledger bounded context

Scope: `@ctx/ledger` — the system of record. Immutable provider facts, a stable
user-facing row that survives pending → posted, the one pure resolver every read
path goes through, transfer pairing, refund hints, cross-provider duplicate
detection, the read models, and the demo-seed loader that grades the heuristics
against ground truth.

Repo `/home/chris/Projects/PersonalFi`, branch `main`. Node v26, pnpm 12.4.1,
Postgres 18 on `127.0.0.1:5433`. Every number below is the output of a command
run against this working tree.

---

## Summary

| Deliverable                                                  | State | Evidence |
| ------------------------------------------------------------ | ----- | -------- |
| `applyProviderTransactions` — idempotent upsert of facts     | Done  | §3, §8   |
| Pending → posted identity migration (provider link + fuzzy)  | Done  | §4       |
| `resolveEffective` as the one resolver, projection refreshed | Done  | §2, §8   |
| Cross-provider dedup keys                                    | Done  | §5       |
| Transfer pairing + confidence + `how_matched` + rejections   | Done  | §6, §9   |
| Refund netting hints (flag only)                             | Done  | §6, §9   |
| Account close/reopen, balance recording, net-worth inputs    | Done  | §5, §8   |
| Five domain events, appended in the write transaction        | Done  | §7       |
| Read models + keyset pagination + pg_trgm search             | Done  | §5, §10  |
| Seed loader with precision/recall against the labels         | Done  | §9       |
| Property, golden, idempotency, keyset and perf tests         | Done  | §8, §10  |
| `vitest.config.ts` projects, boundary entry, OWNERSHIP.md    | Done  | §11      |

105 tests pass (54 unit + 51 database). Transfer pairing scores **P = 1.0000,
R = 1.0000** on the demo seed and holds it under deliberate degradation; the list
page's worst p95 at 50,000 rows is **4.4 ms** against a 200 ms budget. Seven items
are deferred and are listed in §13.

---

## 1. Schema (migration `0004_ledger.sql`, nine tables)

| Table                     | What it is                                                                                                                              |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `merchants`               | Normalised payee. `(user_id, normalized_key)` unique; GIN trigram on `display_name`.                                                    |
| `accounts`                | Provider-backed or manual. `(user_id, provider, provider_account_id)` unique. No FK to `connections` — that is another context's table. |
| `account_balances`        | Append-only observations. `(account_id, as_of, source)` unique, so a replayed page is a no-op.                                          |
| `transactions_provider`   | Provider facts. `(account_id, provider, provider_transaction_id)` unique; `content_hash`, `revision`, `removed_at`, `superseded_by_id`. |
| `transactions`            | The stable user-facing row: `current_fact_id` + four `user_*` overlay columns + six `effective_*` projection columns.                   |
| `transaction_splits`      | User-authored division across categories. Sync never writes here.                                                                       |
| `transfer_links`          | One paired internal movement, with the evidence for the match. Unique on each leg.                                                      |
| `rejected_transfer_pairs` | Persisted negative decisions, in canonical `(low, high)` id order.                                                                      |
| `ledger_dedup_keys`       | Provider-agnostic fingerprint for cross-provider duplicates.                                                                            |

Three changes to the snapshot this work package inherited:

- **`refund_confidence` and `transfer_links.confidence` are `NUMERIC(5,4)`, not
  `DOUBLE PRECISION`.** `packages/db/test/migrate.test.ts` bans `REAL`/`DOUBLE
PRECISION`/`FLOAT`/`MONEY` across the whole schema rather than adjudicating
  per column. A confidence score is not money and a float would have been
  arithmetically fine, but a ban with an exception list stops catching the case
  it was written for. The Drizzle side is `confidenceColumn()`
  (`schema/confidence.ts`, `mode: 'number'`).
- **`src/normalise.ts` was a binary file.** It carried a literal NUL byte as the
  field separator in `dedupKeyOf`'s hash preimage, so git classified the source
  as binary and produced `Bin 6743 bytes` instead of a diff — for a file holding
  a heuristic that will be argued over in review. The separator is now the
  escape `'\u0000'`: byte-identical preimage, same keys, plain-text file. NUL is
  the right delimiter here and stays, because it cannot occur in any component,
  so `12|34` and `1|234` cannot collide on one preimage.
- **`OWNERSHIP.md` now claims all nine tables.** Two sketched names are gone
  because the built schema answers the same need with fewer tables:
  `transaction_facts` → `transactions_provider`, and `transaction_overlays` →
  four sparse columns on `transactions` (every read path needs the overlay, so a
  separate table would put a join on the app's hottest query to save some NULLs;
  `resolveEffective()` is the seam a real overlay table would have provided, and
  it is a function rather than a join).

## 2. The one resolver

```
effective(field) = overlay[field]   when the user has spoken
                 | fact[field]      otherwise
effective.date   = COALESCE(authorized_date, posted_date)     -- 04 §2.4
```

`resolveEffective(fact, overlay)` (`src/effective.ts`) is pure — no clock, no
database — and is the **only** function that writes an `effective_*` column. Two
write paths call it: `applyProviderTransactions` (sync) and
`setTransactionOverlay` (user edit), both through `projectEffective()`. 04 §2.2
specifies a three-tier order with a rule result between overlay and fact; WP 1.4
owns rules and there is no producer for that tier yet, so it is deliberately not
pre-built — a resolution tier nobody writes to is a tier nobody can test.

It returns a merchant **key**, never a merchant id: a resolver that can do I/O is
one that will eventually do I/O on the read path for fifty thousand rows. The
writer maps key → id once (`src/merchant-store.ts`); every reader uses the stored
id.

## 3. Idempotency, three layers (04 §4.4)

1. **Natural key.** `(account_id, provider, provider_transaction_id)` unique, and
   one user-facing row per fact (`transactions_current_fact_idx`), so re-pointing
   is an `UPDATE` and never a second `INSERT`.
2. **Content hash.** `contentHashOf()` canonicalises every modelled provider
   field (`canonicalJson` → SHA-256) and deliberately **excludes `raw`**: a
   provider adding a field we do not model must not manufacture a revision on
   every row it has ever sent. A matching hash bumps `last_seen_at` and writes
   nothing else.
3. **Silence.** A run that touched nothing appends **no event at all**. Consumers
   recompute a deterministic function of current state, so waking four of them to
   recompute an unchanged answer is pure cost — and it is what makes "apply
   twice" assertable as an equality on the outbox length.

## 4. Pending → posted, in five lines

1. Process the page pending-first, so a page carrying both halves settles in one
   pass whatever order the provider used.
2. For an `added` fact, find its predecessor: the fact named by
   `pending_transaction_id`, or — when the institution supplies none — a fuzzy
   match (same account, same currency, same sign, candidate still pending, within
   3 days, **and** identical amount **or** identical normalised payee, **and**
   exactly one candidate survives).
3. Re-point the existing `transactions` row: `current_fact_id` advances,
   `removed_at` clears, **the id and all four `user_*` columns are untouched**,
   and the projection is refreshed from the new fact through `resolveEffective`.
4. Stamp the old fact `superseded_by_id` and emit
   `ledger.TransactionSupersededByPosted` with `amountChanged` / `dateChanged`.
5. A `removed` id whose fact already has a successor is a no-op on `transactions`
   (the charge settled); one with no successor sets `removed_at` on both fact and
   row — hidden, never deleted, so a later `added` can reclaim it with the
   overlay intact. Both arrival orders converge on the same state.

Two candidates in step 2 means the match is refused outright. 01 §5.2:
under-merging is a UI annoyance, over-merging is data loss.

## 5. Everything else that writes

- **`upsertAccount`** refreshes provider metadata and deliberately leaves
  `closed_at` and `include_in_net_worth` alone — those are the user's, and a
  nightly sync that silently reopened a closed account is a bug noticed three
  weeks later as "the numbers are wrong". `changedFields` carries names, not
  values.
- **`recordBalance`** is idempotent on `(account_id, as_of, source)`, refuses a
  currency the account does not hold, and refuses a negative credit limit.
- **`netWorthNow`** is built from `listAccounts` so that "what does net worth
  include?" and "what does the accounts page show?" cannot drift apart. It
  reports **one total per currency** rather than one number: converting CAD into
  USD needs an FX rate as of a date, `fx_rates` is not this context's table, and
  silently adding dollars to euros is worse than two rows. Every account appears
  in `inputs` with an `excludedReason` of `closed`, `opted_out` or `no_balance`.
- **Cross-provider dedup** marks (`superseded_by_id`, reason `duplicate`) and
  never merges. Two rows from the **same** provider sharing a fingerprint are
  left alone on purpose: two identical coffees on the same day are a real and
  common event, and no provider reports one purchase twice under two ids.

## 6. Heuristics

Both are split into a pure proposer and an I/O wrapper, which is what makes the
invariants property-testable rather than example-testable.

**Transfers** (`proposeTransferPairs`): opposite sign, different accounts, same
currency, magnitudes equal within tolerance (default exact), within `windowDays`
(default 5), neither leg already paired, not in `rejected_transfer_pairs`.
Competing candidates are resolved by a greedy pass over proposals sorted by
confidence, then day gap, then id — deterministic and biased towards certainty.
Confidence: 0.98 same-day exact, 0.95 − 0.05·gap for a near-date exact, 0.78 −
0.05·gap − a proportional penalty within tolerance, +0.02 when either descriptor
looks like a movement. `how_matched` and `day_gap` are persisted beside the link
because "why did you decide these two rows were one movement?" is a product
requirement.

**Refunds** (`proposeRefundHints`): same account, same resolved merchant, refund
is the inflow, magnitude at or below the purchase, after it, within 90 days, one
purchase backs at most one refund. It **flags** and never nets.

## 7. Events (`LEDGER_EVENTS`, all five appended in the caller's transaction)

| Event                                  | Aggregate       | Payload                                                                             |
| -------------------------------------- | --------------- | ----------------------------------------------------------------------------------- |
| `ledger.AccountUpserted`               | `account`       | `accountId, connectionId, provider, created, changedFields[]`                       |
| `ledger.BalanceRecorded`               | `account`       | `accountId, balanceId, asOf, source`                                                |
| `ledger.TransactionsUpserted`          | `account`       | `accountId, addedIds[], updatedIds[], removedIds[], dateFrom, dateTo, count`        |
| `ledger.TransferPaired`                | `transfer_link` | `transferLinkId, outflowTransactionId, inflowTransactionId, confidence, howMatched` |
| `ledger.TransactionSupersededByPosted` | `transaction`   | `transactionId, accountId, pendingFactId, postedFactId, amountChanged, dateChanged` |

Ids and counts only, never rows. `appendEvent` takes the caller's transaction
handle by construction, so an event cannot exist for data that was rolled back.
Ledger appends and stops; it calls nobody.

## 8. Tests

```
$ pnpm exec vitest run --project ledger
 Test Files  4 passed (4)
      Tests  54 passed (54)

$ DATABASE_URL=… pnpm exec vitest run --project ledger-db
 Test Files  6 passed (6)
      Tests  51 passed (51)
```

| File                     | Tests | What it holds                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/effective.test.ts`  | 17    | `resolveEffective` properties: purity; the overlay can never change money or the pending flag; effective date is the swipe; a blank overlay string means "not spoken"; the merchant key is always `[a-z0-9]+`; normalisation is idempotent on its own output (a user accepting the name we showed them must not split their history). Plus descriptor normalisation and dedup-key cases.                                                               |
| `src/transfers.test.ts`  | 13    | Pairing invariants over generated ledgers with planted pairs: opposite signs across two accounts; window and tolerance respected; one leg → at most one pair; a rejected pair is never re-proposed; **the answer does not depend on input order**; confidence inside the database's `> 0 AND <= 1`. Plus `grade()`, including "a do-nothing algorithm scores 0 precision, not 1".                                                                      |
| `src/refunds.test.ts`    | 7     | Never points a refund at a larger, later, other-account or other-payee charge; one purchase backs one refund; partial scores below full.                                                                                                                                                                                                                                                                                                               |
| `src/read.test.ts`       | 3     | Cursor round-trip; six malformed cursors refused as `ledger.cursor_invalid` (including a SQL fragment and an impossible date).                                                                                                                                                                                                                                                                                                                         |
| `test/apply.test.ts`     | 12    | The golden pending → posted test (id, note, category, exclusion and rename all survive a settlement that moved both amount and date); apply-twice equality including outbox length; content-hash no-op vs. real revision; both `removed`/`added` orders; the gas-hold fuzzy match; the **ambiguous** fuzzy match refused; removed-without-successor hidden then reclaimed; the projection invariant walked over every row; a cross-user write refused. |
| `test/read.test.ts`      | 8     | Filters, trigram search, `%` treated as text not a wildcard, **keyset stability** (four rows inserted above a live cursor: no row skipped, none repeated), cross-user isolation.                                                                                                                                                                                                                                                                       |
| `test/accounts.test.ts`  | 11    | Upsert reports only real changes; balance idempotency; provider and manual figures coexist at one instant; latest-balance-per-account; net worth by classification, by currency, with exclusion reasons; a provider re-sync cannot reopen a closed account.                                                                                                                                                                                            |
| `test/transfers.test.ts` | 9     | Pairing writes links, flags and events; a second run pairs nothing; a rejection unlinks and is honoured on re-run; user confirmation beats the heuristic; refunds flagged not netted; cross-provider duplicate marked while both rows stay visible; same-provider twins left alone.                                                                                                                                                                    |
| `test/seed.test.ts`      | 9     | §9.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `test/perf.test.ts`      | 2     | §10.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## 9. Precision and recall against the seed's ground truth

`loadSeedDataset` maps `generateDemoData(1)` through the **real** write path
(`provider = 'seed'`, the seed's own ids as natural keys), then grades against
`dataset.labels`. Grading is over unordered pairs.

```
  seed(1): 982 transactions, 6 accounts, loaded and graded in 1489 ms
  transfers: P=1.0000 R=1.0000 (50/50 found, 0 false)
  refunds:   P=1.0000 R=1.0000 (10/10 found, 0 false)

  degraded seed(1): transfers P=1.0000 R=1.0000 (50/50 found, 0 false)

  control (defaults, no tolerance): transfers R=0.6600 (33/50 found, 17 legs short a fee)
```

**The third line is what makes the first two evidence.** The seed's transfer
pairs are same-day and exactly equal, which is the easiest case there is; a
perfect score against it proves only that the dataset's decoys — payroll
deposits, mortgage payments, same-account refunds — do not trip the heuristic.
So `degraded seed` pushes the receiving leg of every labelled transfer one to
three days later and shaves a 25-cent fee off every third one, and the **control**
runs that same damaged dataset through the shipped defaults. Recall collapses to
0.66 — exactly the 17 fee-shortened pairs — and precision stays at 1.0000, which
is the designed behaviour: the heuristic declines rather than guesses. A gate
that has never been observed failing something is not evidence, and this one has
now been observed failing something on purpose.

Fidelity choices in the loader, stated so they can be argued with: `merchant_name`
is supplied only for transactions that have a merchant (mirroring Plaid's ~97%
fill rate), so transfers arrive with nothing but a raw descriptor and exercise
`normaliseMerchantName()` for real; and because the seed generates no balances,
one `derived` balance per account is reconstructed from the transactions —
`derived` being a first-class `BALANCE_SOURCES` value precisely so a
reconstruction says that it is one.

The seed suite also asserts the Phase 1 exit criterion directly: a spend total
with transfers excluded equals one with them included, because both legs of every
pair net to zero — which is exactly why double-counting them stays invisible
until someone opens a category breakdown and finds "Transfers: $84,000".

## 10. Performance at 50,000 rows

Budget: **p95 < 200 ms** for one page of 50. 60 samples per scenario after a warm-up.

```
  50000 rows, page size 50:
    first page               p50    2.1 ms   p95    2.5 ms
    page ~4,000 rows deep    p50    2.1 ms   p95    3.5 ms
    account + date filter    p50    2.3 ms   p95    4.4 ms
    trigram search           p50    2.2 ms   p95    4.1 ms
    pending only             p50    1.9 ms   p95    2.7 ms
```

Worst p95 **4.4 ms**, ~45× inside budget. The suite also asserts the **plan**,
not only the timing: `EXPLAIN` on the deep-page query must name
`transactions_feed_idx` and must not contain `Seq Scan on transactions`. A timing
test on a warm 50k-row table can stay green through a sequential scan on a laptop
with a fast disk and then fall off a cliff at 500k rows on a NUC; the plan
assertion fails on the day the mistake is made instead.

Pagination is keyset — `(effective_date, id) < (cursor)` matching
`transactions_feed_idx`'s `(user_id, effective_date DESC, id DESC) WHERE
removed_at IS NULL` — never `OFFSET`. `OFFSET` is not only slower at depth, it is
_wrong_ while data is arriving: a row inserted above the current page shifts
every subsequent offset by one and the user sees a transaction twice or never.

## 11. Configuration entries (applied, not just proposed)

The two `vitest.config.ts` projects, added after the quality agent's work landed:

```ts
{
  root: './packages/contexts/ledger',
  test: { name: 'ledger', include: ['src/**/*.test.ts'], environment: 'node' },
},
{
  root: './packages/contexts/ledger',
  test: {
    name: 'ledger-db',
    include: ['test/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 300_000,
  },
},
```

The `scripts/eslint-boundaries.js` layer entry, placed **before** the generic
`context` entry (`layerFor` takes the first matching prefix):

```js
{
  name: 'ledger',
  prefix: 'packages/contexts/ledger/',
  allow: [
    '@core/kernel', '@core/config', '@core/db', '@core/contracts',
    '@core/platform', '@core/secretbox', '@core/testkit', '@core/seed',
    'drizzle-orm', 'pg', ...UNIVERSAL,
  ],
  allowNodeBuiltins: true,
  why: 'Ledger is the system of record: it depends on the kernel and on infrastructure, ' +
       'and on no other context. Everything it needs from one arrives as a domain event, ' +
       'and everything another context needs from it leaves as one.',
},
```

Two honest notes on that list. `@core/secretbox` is there because
`normalise.ts`'s `dedupKeyOf` routes through the repo's single sanctioned hash
rather than hand-rolling one. `@core/testkit` and `@core/seed` are **dev-only**
(declared as `devDependencies`), and the layer rule cannot express "test files
only" for a `test/` directory — the alternative was an `eslint-disable` in the
harness, which buys the same looseness while hiding it in a comment instead of in
the policy. Nothing under `src/` imports either: `loadSeedDataset` declares the
dataset shape structurally (`SeedDatasetLike`) so the shipped context does not
depend on a fixture generator, and if that ever changes, this paragraph is what a
reviewer should object to.

The entry was sabotage-tested rather than assumed. A probe file under `src/`
importing `@ctx/identity` and `express`:

```
4:27  error  '@ctx/identity' is another bounded context. @ctx/ledger must talk to it
             through a domain event or its published port, never a direct import (decision D8)
5:21  error  @ctx/ledger may not import 'express'. Ledger is the system of record: …
✖ 2 problems (2 errors, 0 warnings)
```

## 12. Verification

```
$ pnpm exec tsc -p tsconfig.json                      # clean, whole repo
$ pnpm exec eslint .                                  # clean, whole repo
$ pnpm exec prettier --check packages/contexts/ledger # All matched files use Prettier code style!
$ node scripts/check-schema-ownership.ts
schema-ownership: ok — 96 table(s) claimed across 14 package(s), 29 defined.
$ DATABASE_URL=… pnpm exec vitest run --project db    # fresh-apply + idempotent runner
 Test Files  1 passed (1)
      Tests  10 passed (10)
```

The `db` project is what proves the migration: it creates a scratch database,
applies all four migrations, asserts the **exact** alphabetical table list
(now including the nine ledger tables), asserts the runner records a SHA-256 per
migration, and then asserts a second run applies nothing. `packages/db/test/migrate.test.ts`
was edited for the table list only, with the coordinator's agreement.

## 13. Deferred

| #   | Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Why, and where it lands                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Per-revision fact history.** 04 §2.2 describes `transaction_fact` as append-only with one row per provider revision. Migration 0004's unique index is `(account_id, provider, provider_transaction_id)` with no `revision` component, so a revision advances the row in place: `revision` counts distinct payloads seen and `raw` holds the latest. The pending → posted audit trail — the part that affects correctness — is fully preserved in `superseded_by_id`. | Needs a new table and a new migration; an already-merged migration is immutable. WP 1.2, alongside the connector that will actually generate revisions. |
| 2   | **The rule tier in `resolveEffective`.** 04 §2.2's middle tier (overlay → rule → fact) and `locked_fields`.                                                                                                                                                                                                                                                                                                                                                            | WP 1.4 owns rules. A tier with no producer is a tier nobody can test.                                                                                   |
| 3   | **Split writes.** `transaction_splits` exists, is read by `getTransaction`, and has its "splits must sum to the parent" rule stated — but nothing writes one yet.                                                                                                                                                                                                                                                                                                      | WP 1.5 (the API), where `Money.allocate` gets a caller.                                                                                                 |
| 4   | **`purgeRemovedTransactions()`.** Tombstoned rows are hidden and never physically deleted. Migration 0004's comment promises an eventual purge after a grace window.                                                                                                                                                                                                                                                                                                   | WP 1.2, as a scheduled job — it needs the job runner and a configured grace window.                                                                     |
| 5   | **Overlay-edit events.** `setTransactionOverlay` emits nothing; the five events cover sync facts only. No consumer needs a user edit yet, and inventing a sixth event now would be a payload with no reader.                                                                                                                                                                                                                                                           | WP 1.5, when budgeting reacts to a re-categorisation.                                                                                                   |
| 6   | **FX for multi-currency net worth.** `netWorthNow` returns one total per currency.                                                                                                                                                                                                                                                                                                                                                                                     | Phase 3, with `fx_rates`.                                                                                                                               |
| 7   | **`provider_entity_ids` enrichment.** The column exists and the counterparty payload is persisted verbatim in `raw`, but nothing populates the array yet; merchant convergence currently runs on normalised text alone.                                                                                                                                                                                                                                                | WP 1.4, where the merchant pipeline lives.                                                                                                              |
