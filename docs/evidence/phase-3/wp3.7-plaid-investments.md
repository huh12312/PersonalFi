# WP 3.7 — Plaid investments and liabilities wiring

_The `holdings`, `investment_txns` and `liabilities` legs of the sync orchestrator; the durable per-run
fact store they write; the real `InvestmentSyncPort.factsForRun`; and the sabotages that hold them._

Dispatch: [`docs/plan/03-phase-3-dispatch.md`](../../plan/03-phase-3-dispatch.md) §3 "WP 3.7".
Depends on WP 3.1 (`SecurityResolver`, the widened port), WP 3.2 (the lot engine and its
`InvestmentSyncPort`), WP 3.4 (the `PriceSource` fake used in the reconciliation).

---

## 1. The three legs, and what "isolated" means

`packages/contexts/connections/src/orchestrator.ts` grew invariant 7 — three more applications of
invariant 6, deliberately the _same shape_ as the `balances` leg rather than a new one:

| Leg                     | Capability        | Port member                  | `sync_runs.operation` | Writes                                 |
| ----------------------- | ----------------- | ---------------------------- | --------------------- | -------------------------------------- |
| Holdings                | `holdings`        | `syncHoldings`               | `holdings`            | `connection_sync_facts` kind `holding` |
| Investment transactions | `investment_txns` | `syncInvestmentTransactions` | `investment_txns`     | kind `investment_transaction`          |
| Liabilities             | `liabilities`     | `syncLiabilities`            | `liabilities`         | kind `liability`                       |

Each is a call to `#datasetLeg`, which owns the parts that are genuinely identical (the gate, the
`running` row, the classification, the `INSUFFICIENT_SCOPE` narrowing, the event) and takes three lines of
difference per leg. A fifth dataset is a `DatasetLeg` object and nothing more.

**Isolation is structural, not careful.** Every one of these properties is a consequence of where the code
sits rather than of a `try` somebody remembered to write:

1. **The legs run after `syncConnection`'s settle transaction has already committed.** By the time any of
   them is called, the transactions `sync_runs` row is final and its `connections.SyncRunCompleted` has been
   appended. There is no handle by which a leg could reach either.
2. **Each leg opens and settles its own row**, keyed by its own `syncRunId`. `#datasetLeg` never names
   another run.
3. **`#datasetLeg` never throws for a provider failure.** `asConnectorError(cause)` into a local, then a settle transaction, then a
   `logger.warn`. The three calls are sequential `await`s, so a holdings failure does not stop the
   liabilities leg either.
4. **The connection's status is untouched by a leg.** `#settleStatus` is the transactions leg's alone. A
   brokerage that will not share holdings is not a broken connection, and a banner the user can do nothing
   about is worse than no banner.

Observed, in `apps/api/test/db/investments-sync.test.ts` → `'a holdings leg failure leaves the transactions
delta committed and correctly labeled'`, with the holdings call forced to throw `PROVIDER_DOWN`:

```
SELECT operation, status, error_kind, error_code, added_count, modified_count
  FROM sync_runs WHERE connection_id = … ORDER BY started_at, operation;

operation         status   error_kind             error_code      added  modified
transactions      success  (null)                 (null)              4         2
balances          success  (null)                 (null)              5         0
holdings          failed   provider_unavailable   PROVIDER_DOWN       0         0
investment_txns   success  (null)                 (null)              5         0
liabilities       success  (null)                 (null)              3         0
```

and `SELECT count(*) FROM transactions` is non-zero: the delta is on disk, not merely counted. The other
two legs ran and wrote. `summary.error` — what the job runner reads to decide whether to retry — is `null`,
so a holdings outage does not cause the whole connection to be re-synced five times.

### Sequential, not concurrent

The three legs `await` one another. `Promise.all` would save no latency a user can perceive on a background
sync and would spend a per-Item rate limit three times as fast — Plaid's is 5/min on some endpoints
(01 §1.8), by far the tightest limit in the system.

---

## 2. Where the facts live, and why a migration was needed

### 2.1 The table

`connection_sync_facts`, migration `0018_connection_sync_facts.sql`, owned by `@ctx/connections`.

It is the mirror image of `connection_staged_facts` (0008) and the migration says so in one line:
**staged** facts are _inbound and not yet applied_ — what a process-local connector accumulated during
`connect()` and has not flushed; **sync** facts are _already observed and published_ — what a remote
provider's leg recorded so a consumer in another context and another process can read it. A pending inbox
and a published outbox.

The row is keyed on the **provider's natural key**, not on the run, and `sync_run_id` means "the run that
last observed this fact":

| Kind                     | Partial UNIQUE index                                                   |
| ------------------------ | ---------------------------------------------------------------------- |
| `holding`                | `(connection_id, provider_account_id, provider_security_id)`           |
| `investment_transaction` | `(connection_id, provider_transaction_id)` — 01 §5.5's idempotency key |
| `liability`              | `(connection_id, provider_account_id)`                                 |

The benefit is that the table's size is the size of the portfolio and not the size of the sync history:
there is no `/investments/transactions/sync`, so a nightly run re-fetches the whole 24-month window, and a
per-run log would write ~500 rows a night forever to restate the same 500 facts. The cost is written down
in the migration header: `factsForRun` for an **older** run returns nothing once a newer run has re-observed
the same facts. That is the honest answer — "this run's observations have been superseded" — and the
consumer's contract survives it, because `runLotSync` over no facts touches no holding, opens no lot and
appends no event. The durable record of an investment transaction is `@ctx/investments`'
`investment_transactions`, upserted on `(user_id, account_id, provider, provider_transaction_id)`, which is
what a replay rebuilds lots from.

Types, per D3: `quantity NUMERIC(38,18)`, `price NUMERIC(20,10)`, `apr NUMERIC(9,6)`, every money value a
`BIGINT` minor-unit column paired with its own `CHAR(3)`. No `DOUBLE PRECISION` or `REAL` column exists in
the table and `packages/db/test/migrate.test.ts`'s float ban is what keeps it that way. Money columns are
named for what they hold (`value_minor`, `cost_basis_minor`, `amount_minor`, `fees_minor`,
`statement_balance_minor`, `minimum_payment_minor`) rather than reused across kinds — 0008's own
`available_minor`/`limit_minor` precedent — because a single `amount_minor` meaning three things is three
columns' worth of meaning in one, and the first `SUM()` over it would be wrong in a way no constraint could
catch.

Six CHECKs carry the load-bearing claims; the two that matter most are
`connection_sync_facts_holding_is_a_position` (a holding without a security, a quantity or a value is not a
holding) and `connection_sync_facts_investment_transaction_is_identified` (the idempotency key, the
fingerprint, the quantity, the price and the date, together — 01 §5.5 makes the upsert the _only_
protection against a re-fetched window, so the key is not optional).

### 2.2 The migration, and why it was unavoidable

**Yes, a migration was needed, and it is `0018`.** The dispatch records WP 3.7 as "Migrations. None" and
was right about the two things it was counting — no new context, no new read model. It missed two `CHECK`
constraints, and neither can be worked around from TypeScript:

1. **`sync_runs.operation`** (0005) is CHECKed against `('transactions','balances','holdings','liabilities')`.
   The dispatch asks for an `investment_txns` leg writing "its own `sync_runs` row with an `operation:`",
   and that value is not in the list. Folding investment transactions into `holdings` would defeat the
   reason 0005 split the column in the first place — its own comment reads "Split out so a holdings failure
   does not hide a successful transactions run".
2. **Nowhere durable to put the facts.** `InvestmentSyncPort.factsForRun(userId, syncRunId)` is called by
   the lot consumer inside the _pump's_ transaction, in the worker process, seconds after the sync.
   `connection_staged_facts.kind` is CHECKed against five transaction/account/balance kinds and the table
   has no `sync_run_id`, `quantity` or `price` column. The alternatives were each a JSONB column documented
   for something else with no natural key and no numeric type (`connections.config`,
   `sync_runs.error_detail`) or an event payload, which 08 §3.4 forbids ("payloads are ids, counts and
   enums, never rows").

`0018` was reserved for WP 3.9 with the words "used only if reported necessary". It is reported necessary
here; WP 3.9's dispatch entry says "Migrations. None" unconditionally, so the reservation is spent on the
work package that turned out to need it. **The orchestrator should confirm no concurrent work package also
claimed 0018.**

Files the migration forced outside this work package's nominal ownership, all minimal and all listed here
so the review is not a surprise: `packages/db/migrations/0018_connection_sync_facts.sql` (new),
`packages/db/test/migrate.test.ts` (one line in the alphabetical table list, plus the comment block that
list requires), `packages/contexts/connections/schema/{sync-facts.ts,index.ts,connections.ts}` and this
context's `OWNERSHIP.md`.

### 2.3 No `LedgerWriter` additions were needed

The dispatch allowed for "ledger-writer additions as needed". None were needed and none were made.
Holdings and lots are `@ctx/investments`' tables, reached through the event and the port rather than
through this context's ledger seam; the liability _terms_ block has no ledger column to write to (a
liability account's balance and credit limit already arrive through `recordBalance`, whose input carries
`limit`). Adding a method the ledger does not have would have been an invented port.

---

## 3. `factsForRun`, for real

`apps/api/src/domain.ts`'s `createInvestmentSyncPort(...).factsForRun` now does the three steps
`docs/evidence/phase-3/wp3.w-wiring.md` §5 predicted, and nothing in `modules.ts` or `@ctx/investments`
moved:

1. **Read**, through `@ctx/connections`' published `investmentFactsForRun(executor, userId, syncRunId)`,
   which returns the run's provider, its `started_at`, and every fact **already joined to the ledger
   account it belongs to**. The join lives inside the owning context rather than in the composition root,
   which is `pnpm lint:schema-ownership`'s rule and the reason this function can be about securities
   instead of about a three-table join. `user_id` is in the `WHERE`, so another user's run id returns
   `null` rather than somebody else's portfolio.
2. **Resolve**, in **one** `resolveAll(...)` over every identifier the run mentioned — holdings and
   transactions together, because they name the same securities and splitting them would halve the batched
   OpenFIGI saving `wp3.1-securities.md` and `test/openfigi.test.ts` exist to protect.
3. **Drop what could not be resolved.** A _holding_ the resolver abstained on is absent, and the
   `SecurityResolutionFailed` the resolver appended is the record that the position existed — a fact with a
   null `security_id` is never returned. A _transaction_ that named no security at all is **kept**, with
   `securityId: null`: a cash sweep, a fee and a deposit are real investment transactions,
   `ResolvedTransactionFact` types the field nullable for exactly them, and `lotEffectOf` already returns
   `NONE`. A transaction that named a security nobody can resolve is dropped, because a buy whose security
   has no id cannot open a lot.

Every transaction carries `source: 'BROKER'` — the truthful label for a fact a provider stated exactly, and
the seam the R6 verdict needs so a CSV leg can hand the same engine `IMPORTED` facts without the engine
knowing which it is looking at. Asserted end to end in `phase3-wiring.test.ts`: all five synced
transactions land with `source = 'BROKER'` and `provider = 'plaid'`.

**`isRetirementAccount`** was already implemented from the account subtype (`RETIREMENT_SUBTYPE_MARKERS`
against `accounts.subtype`, best-effort text matching, failing towards `false` so a basis adjustment the
user is entitled to is never silently deleted). WP 3.7 changed nothing about it; it is now reachable,
because the lot consumer finally has facts to run over.

### The transaction seam, stated as a cost

`securityResolverFor` is built per-transaction _for the sync path_, so a rolled-back sync leaves no durable
record of a resolution during work that never happened. Here the caller is the lot consumer and the pump's
transaction is one this port never sees — `createInvestmentSyncPort(database)` is constructed once, over
the pool, in `worker.ts`. So the resolution takes a transaction of its own.

That is defensible: securities are **master data**, minting one is a statement about an asset rather than
about a run, it is idempotent on the identifier, and a derivation that fails for an unrelated reason should
not have to re-mint it on every retry. The cost is real and is carried in §11: a retried delivery re-runs an
abstention and appends a second `SecurityResolutionFailed` for the same unresolvable position. That is
duplicated _reporting_, never a duplicated row — the resolver mints nothing when it abstains.

---

## 4. `cost_basis`: the fill rate, and the decision it drove

Measured on the recorded Sandbox fixture (`packages/connectors/plaid/test/fixtures/investments.json`,
asserted in `investments-sync.test.ts` → `'cost_basis is carried as reported, absent where the institution
did not report one'`):

| `security_id`   | Security                        | `quantity` | `cost_basis` as reported | Stored `cost_basis_minor` |
| --------------- | ------------------------------- | ---------- | ------------------------ | ------------------------- |
| `sec-vti-0001`  | Vanguard Total Stock Market ETF | 62.5       | 14200                    | `1420000`                 |
| `sec-cash-0002` | Northwind Cash Sweep            | 1675.32    | `null`                   | `NULL`                    |
| `sec-btc-0003`  | Bitcoin                         | 0.0000001  | `null`                   | `NULL`                    |

**Fill rate: 1 of 3 positions — 33%.** And the one that _is_ filled is ambiguous in exactly the way 01 §5.5
warns: `14200` for 62.5 units is $227.20 per share against a $268.40 close, which reads as a plausible
_total_ basis for a position bought lower — but `14200 / 62.5 = 227.20` is equally a plausible per-share
figure for a different security. Nothing in the payload says which.

**The decision.** `cost_basis` is carried verbatim into `connection_sync_facts.cost_basis_minor` and is
**never** used to derive a lot. WP 3.2's engine builds basis from `investment_transactions`, where a buy
carries a quantity _and_ a unit price and the arithmetic is unambiguous; the holding's `cost_basis` exists
so a later reconciliation can say "the institution thinks the basis is X and we compute Y" and so a future
`IMPORTED`/`ESTIMATED` path has something to start from. Three consequences, each already enforced:

- **A missing basis is `NULL`, never `0`.** Two of the three rows above prove it. 04 §5.5: an unknown basis
  reports `unavailable`, and a zero here would be a 100% unrealised gain fabricated by a coalesce.
  `connection_sync_facts_cost_basis_is_money` additionally refuses a minor amount with no currency, so a
  half-written basis cannot exist either.
- **The lot the wiring smoke produces is `BROKER`, not `ESTIMATED`**, and it comes from the _buy_, not from
  the holding: 5 VTI at 268.40 opened one lot, the sell of 2 consumed part of it, and 3 units remain.
- **A 67% miss rate is the normal case, not an outage.** Any UI or advisor rule that treats a null basis as
  exceptional will be wrong two thirds of the time on this data.

---

## 5. `institution_value` against our own valuation

`institution_value` is stored (`value_minor`/`value_currency`) and is **reconciliation only**: valuation
comes from WP 3.4's `PriceSource`, so two accounts at two brokerages are comparable rather than each being
whatever its institution happened to think that morning. Reproduced in `investments-sync.test.ts` →
`'institution_value is kept for reconciliation and our own price source is the valuation'`, using WP 3.4's
`createFakePriceSource`. All arithmetic is `Quantity.multiply` into minor units with a single truncation —
no float crosses any of it.

| Position   | Quantity  | Institution price | `institution_value` | Our price (fake `PriceSource`) | Our valuation | Δ           | Explanation                                                                                                                                                                                                                                                                                                                                                                  |
| ---------- | --------- | ----------------- | ------------------- | ------------------------------ | ------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VTI        | 62.5      | 268.40            | `$16,775.00`        | 269.10                         | `$16,818.75`  | **+$43.75** | A genuine price difference, and the point of the whole exercise. The institution used its own 2026-05-29 close; ours is the `PriceSource`'s for the same date. 62.5 × $0.70 = $43.75. **Our number is what goes into net worth**, because it is the number every other account is also valued at.                                                                            |
| Cash sweep | 1675.32   | 1.00              | `$1,675.32`         | — (par)                        | `$1,675.32`   | **$0.00**   | No price source is involved and none should be: `is_cash_equivalent` is what WP 3.1 records and $1.00 is not a quote. Agreement to the cent.                                                                                                                                                                                                                                 |
| BTC        | 0.0000001 | 64100.50          | `$0.01`             | 64100.50                       | `$0.00`       | **−$0.01**  | **Same price, different rounding.** 0.0000001 × 64100.50 = $0.00641005. The brokerage rounds a sub-cent position *up* to a cent; we truncate once, at the minor-unit boundary, to $0.00. The only row in this table whose difference is about rounding rather than about price — and the reason a reconciliation must report the institution's figure rather than assert it. |

Every difference is explained; none is unexplained. The two failure modes this table is the control for:

- **Silently adopting `institution_value` as the valuation** would make the VTI row agree by construction
  and make the portfolio's total depend on which brokerage holds it.
- **Silently discarding it** would leave the $0.01 dust row with nothing to reconcile against, and a
  position that reads `$0.00`in our system and`$0.01` on the statement is exactly the kind of difference
  a user notices and we could not then account for.

---

## 6. Idempotence, with row counts

`investments-sync.test.ts` → `'two syncs of the same window add no investment transactions'`. There is no
cursor (01 §5.5), so this is the _normal_ nightly shape: the whole 24-month window, re-fetched, every night.

|              | `connection_sync_facts` (`investment_transaction`) | `connection_sync_facts` (`holding`) | `investment_txns` run `added_count` | `modified_count` |
| ------------ | -------------------------------------------------- | ----------------------------------- | ----------------------------------- | ---------------- |
| After sync 1 | **5**                                              | 3                                   | 5                                   | 0                |
| After sync 2 | **5**                                              | 3                                   | **0**                               | **5**            |
| After sync 3 | **5**                                              | 3                                   | (not asserted)                      | (not asserted)   |

`added_count` is rows the run _created_; `modified_count` is rows it _restated_. All restated, none created
— readable straight off the connections history view with no row count beside it. The liabilities leg is
the same shape and is asserted separately (`'the liabilities leg records the APR and statement block
liabilities.terms reads'` re-syncs and re-counts).

The 24-month window, on the wire, asserted in `'every dataset leg hit its endpoint exactly once per sync'`:
`end_date − start_date = 730 days` on the last `/investments/transactions/get` request. D16 and 01 §5.1:
accepting Plaid's 90-day default silently loses ~21 months that cannot be recovered without a re-link.

That test also guards against the way this whole file could quietly pass while proving nothing — a leg that
never ran: each endpoint is hit **exactly once** per sync, and investment transactions in one page, because
five rows is well under the 500-row `count` and the adapter stops as soon as
`offset >= total_investment_transactions`.

---

## 7. The capability gate and `INSUFFICIENT_SCOPE`

### 7.1 Skipped, not errored

08 §2.2: the orchestrator "skips what isn't advertised rather than catching `NotImplemented`". The gate is
**two** checks, both before any call is made:

```
if (!supports(capabilities, leg.capability)) return;     // the declaration
if (!implementsLeg(connector, leg.capability)) return;   // the optional port member
```

and `capabilities` is `effectiveCapabilities(connector.capabilities(), row.capabilities)` — the adapter's
declaration **narrowed** by what this connection was granted. That is new: `createConnection` has always
written `connections.capabilities` from the declaration intersected with the provider's
`observedCapabilities`, and the sync path read the declaration, which made that narrowing decorative. It
only ever narrows; a row whose `capabilities` has no usable `supports` (a `{}` default, a hand-built
fixture) falls back to the declaration, because "never written" and "granted nothing" must not look alike.

Observed in `'a connector without the holdings capability is skipped, not errored'` with
`ManualConnector`, which declares none of the three and has none of the three methods:

```
sync_runs for the connection: transactions (success)
                              — no holdings row
                              — no investment_txns row
                              — no liabilities row
every row's error_kind: null
summary.error:          null
```

**No row at all** is the claim, and it is stronger than "a row saying success with zero rows": the latter is
indistinguishable from a brokerage that sold everything, which is precisely the ambiguity
`capabilities.ts`'s header says an honest adapter must never produce.

### 7.2 `INSUFFICIENT_SCOPE` narrows one dataset and leaves the rest

`apps/api/test/db/insufficient-scope.test.ts` → `'INSUFFICIENT_SCOPE clears the capability for this
connection and leaves the others working'`. The scenario is real and the fake reproduces it without being
told to pretend: a Plaid Item whose institution does not carry the `liabilities` product answers
`/liabilities/get` with `PRODUCTS_NOT_SUPPORTED`, which `errors.ts` maps to `INSUFFICIENT_SCOPE` and
`KIND_OF_CONDITION` classifies `permanent`.

```
sync 1
  transactions      success
  balances          success
  holdings          success
  investment_txns   success   added_count = 5
  liabilities       failed    error_kind = permanent   error_code = INSUFFICIENT_SCOPE

connections.capabilities.supports
  before: [accounts, balances, transactions, investment_txns, holdings, liabilities, …]
  after:  [accounts, balances, transactions, investment_txns, holdings, …]        ← liabilities gone
connections.status: active                                                        ← unchanged

sync 2
  /liabilities/get           requests: +0      ← never asked again
  /investments/holdings/get  requests: +1      ← the legs that work are unaffected
  liabilities sync_runs rows: still 1          ← a skipped leg writes nothing
  holdings     sync_runs rows: 2
```

Four things together, and each would be missing on its own: the failure is classified `permanent` so the
job runner does not back off and retry a refusal that will be identical next time; the capability is gone
so the _next_ sync does not ask; the connection stays `active`, because a bank with no cards is not a broken
connection; and every other leg still runs and still writes.

---

## 8. Sabotage

Four, each applied to `src/`, observed red, and reverted. All four were red on the first valid attempt.

### S1 — a leg failure relabels the transactions delta (the dispatch's own sabotage)

In `#datasetLeg`'s settle transaction, on failure, also mark the connection's `transactions` run failed:

```ts
// SABOTAGE: a leg failure relabels the transactions delta it did not touch.
if (failure !== null) {
  await tx
    .update(syncRuns)
    .set({ status: 'failed', errorKind: failure.kind, errorCode: failure.condition })
    .where(
      and(eq(syncRuns.connectionId, input.connectionId), eq(syncRuns.operation, 'transactions')),
    );
}
```

```
× a holdings leg failure leaves the transactions delta committed and correctly labeled
AssertionError: the transactions run stays successful: expected 'failed' to be 'success'
Expected: "success"
Received: "failed"
```

A note on what this sabotage _cannot_ show, stated rather than glossed: the transactions **rows** do not
roll back, because `#commitPages` commits them in its own transaction before any leg is constructed. That
is invariant 1 and it is covered by the existing atomicity test in the `connections-db` suite. What a leg
can still corrupt is the _label_, which is what S1 breaks and what the exit test holds.

An earlier, cruder variant — dropping the `.where(eq(syncRuns.id, syncRunId))` filter so a leg settles every
run on the connection — was also red, on a different assertion (`the holdings leg failed on its own row:
expected 'success' to be 'failed'`, because the later successful legs stomped the row back). Recorded
because it shows the same control from the other side: without a per-run `WHERE`, the legs overwrite each
other.

### S2 — the capability gate removed

Both halves had to be disabled before the test went red, which is the gate being belt and braces rather
than a single point. With `supports(...)` alone disabled the test still passed, because `ManualConnector`
has no `syncHoldings` method and `implementsLeg` caught it. With both disabled:

```
× a connector without the holdings capability is skipped, not errored
AssertionError: no holdings row at all: expected true to be false
```

### S3 — the idempotency key is the run's, not the provider's

In `recordInvestmentTransactionFacts`, `providerTransactionId: \`${target.syncRunId}:${fact.providerTransactionId}\``:

```
× two syncs of the same window add no investment transactions
AssertionError: a re-fetched window restates rows, it does not add them: expected 10 to be 5
```

Five became ten on the second pass of the same window — the exact doubling 01 §5.5 says the upsert is the
only protection against.

### S4 — `INSUFFICIENT_SCOPE` no longer clears the capability

```
× INSUFFICIENT_SCOPE clears the capability for this connection and leaves the others working
AssertionError: cleared for this connection: expected [ 'accounts', 'balances', …(6) ] to not include 'liabilities'
```

---

## 9. Where WP 3.10's `liabilities.terms` reads from

`wp3.10-advisor-catalog-v2.md` §7.1 names the port it needs — `investments.liabilities({ userId, asOf })`,
reading "`@ctx/ledger` liability accounts + Plaid liabilities (WP 3.7)". This is the Plaid half:

> **`liabilityTermsFor(executor, userId)`**, exported from `@ctx/connections`
> (`packages/contexts/connections/src/staging.ts`, re-exported by `src/index.ts`).

It returns one `LiabilityTerms` per liability account — `{ accountId, providerAccountId, provider, apr,
statementBalance, minimumPayment, nextPaymentDue, observedAt }` — with `accountId` already joined through
`connection_accounts` to `@ctx/ledger`'s `accounts.id`. That join is the point: the snapshot builder's
`#liabilitiesTerms` arm pairs the block with the ledger's liability account and then strips the id through
`snapshot/tokens.ts`'s existing tokeniser into a `liability_ref`, so no account id, lender name or mask
leaves. `observedAt` is carried so a reader can call a block stale; it is not a stored staleness flag,
following WP 3.4's rule that staleness is computed at read time.

On the recorded Sandbox fixture it yields three blocks (a fourth credit card is dropped by `map.ts` because
its `account_id` is null — a liability that cannot be attached to an account):

| Account                  | APR         | Statement balance | Minimum payment | Next due   |
| ------------------------ | ----------- | ----------------- | --------------- | ---------- |
| `acct-card-002` (credit) | `19.990000` | $742.18           | $35.00          | 2026-06-22 |
| `acct-mortgage-004`      | `3.125000`  | — (see below)     | $1,850.00       | 2026-07-01 |
| `acct-student-005`       | `4.530000`  | $12,640.00        | $210.00         | 2026-06-15 |

The mortgage's blank statement balance is not a gap in the leg: Plaid's model has none, and the outstanding
principal is the **account's** balance, which arrives through the `balances` leg and `recordBalance`.
`map.ts` says so at the `statementBalance: null` it writes, and a reader of `liabilities.terms` must not
read the blank as "$0 owed".

`apr` is `NUMERIC(9,6)` read back as an exact decimal string, asserted against `/^-?\d+\.\d{6}$/`. A
percentage, not money, not a float: 4.25% is not $4.25. The **credit limit** the scope also wants does not
come from here — it is `ProviderBalanceFact.limit`, which the `balances` leg already writes through
`recordBalance` into `@ctx/ledger`'s `account_balances.limit_minor`, and the composition-root port joins
the two. That split is worth stating because it is not obvious from 08 §4.2's block, which lists them
together.

The card's three APRs (`purchase_apr` 19.99, `cash_apr` 25.24, `balance_transfer_apr` 0.00) collapse to the
purchase rate, which is the one a payoff projection needs; all three survive verbatim in `fact.raw`, so a
later D-rule that wants the cash rate does not need a re-sync.

---

## 10. Tests and checks

### 10.1 Tests added

| File                                          | Tests        | Of which the dispatch names                                                                                                                                                                                                        |
| --------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/test/db/investments-sync.test.ts`   | 8            | `'a holdings leg failure leaves the transactions delta committed and correctly labeled'`, `'two syncs of the same window add no investment transactions'`, `'a connector without the holdings capability is skipped, not errored'` |
| `apps/api/test/db/insufficient-scope.test.ts` | 1            | `'INSUFFICIENT_SCOPE clears the capability for this connection and leaves the others working'`                                                                                                                                     |
| `apps/api/test/db/phase3-wiring.test.ts`      | +1 (7 total) | — (`'a real provider leg, the real port and the real pump put a lot in the database'`)                                                                                                                                             |

The five beyond the plan's four: the `cost_basis` fill rate, the `institution_value` reconciliation, the
liabilities terms block, "every dataset leg hit its endpoint exactly once per sync" (the guard against a leg
that silently never runs, and the 730-day window on the wire), and "the access token never reaches
`connection_sync_facts`" — because every fact carries the provider's verbatim payload in `fact.raw`, which
is exactly the column a credential would hide in.

The wiring smoke is the one that closes the loop. Nothing in its chain is stubbed: the real orchestrator's
legs call the real `PlaidConnector`, which maps the recorded Sandbox fixture through the real `map.ts`; the
legs write real `connection_sync_facts`; the real `createInvestmentSyncPort` reads them back and resolves
each security through WP 3.1's real `SecurityResolver`; the real lot consumer, delivered by the real
`createConsumerPump` that `worker.ts` builds, derives a lot. The only double in the chain is the socket.
It asserts 3 staged holdings, 5 staged investment transactions, one `securities` row for the position, five
`investment_transactions` rows all `source = 'BROKER'` / `provider = 'plaid'`, and **one open
`cost_basis_lots` row with `quantity_remaining = 3` and `basis_source = 'BROKER'`** — the buy of 5 less the
sell of 2.

### 10.2 Checks

All run in the foreground at the close of the work package, after every sabotage was reverted
(`grep -rn SABOTAGE packages/contexts/connections/src apps/api/src` → nothing).

```
$ DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev \
  pnpm exec vitest run --project connections --project connections-db \
    --project connector-plaid --project connector-port --project investments-db --project db
  Test Files  20 passed (20)
       Tests  389 passed | 1 skipped (390)
```

`db` is included beyond the dispatch's list because migration 0018 lands in it:
`packages/db/test/migrate.test.ts` applies the whole forward-only history against a fresh database,
re-checks the alphabetical table list and re-runs the float ban. It is green.

```
$ pnpm exec eslint packages/contexts/connections packages/connectors/plaid apps/api
  (no output)

$ pnpm run lint:schema-ownership
  schema-ownership: ok — 99 table(s) claimed across 14 package(s), 79 defined.

$ pnpm exec prettier --check <every file this WP touched>
  All matched files use Prettier code style!
```

`packages/db/migrations/*.sql` has no Prettier parser and never has — 0018 is in the same position as
0001–0017 and the repo-wide `prettier --check .` does not reach it.

```
$ DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev \
  pnpm exec vitest run --project api-db
  Test Files  34 passed | 1 skipped (35)
       Tests  204 passed | 2 skipped (206)
```

The skip is `plaid-sandbox.test.ts`, which is the live Sandbox smoke and skips because no Plaid credential
file exists on this host — unchanged by this WP, and the reason §11 item 6 carries "nothing here has been
observed against live Plaid".

**A note on timing, because an intermediate run of this suite was red and a reviewer may find it in the
log.** WP 3.9 was in flight in the same tree throughout. An earlier full `api-db` sweep failed four tests:
three in `investments-routes.test.ts` (WP 3.9's own file, mid-edit, and repaired by that agent before the
final run) and **one that was this work package's**, described next. The intermediate is recorded so the
discrepancy with the green run above is not read as a flake.

**`pnpm exec tsc -b --noEmit` is still red, and every error belongs to WP 3.9.** At the close of this work
package it reports seven, all in two files that agent owns and is mid-edit on — two in
`apps/api/test/db/investments-routes.test.ts` (a stale `@ts-expect-error` and a `never` assignment) and five
`TS4111` index-signature accesses in `apps/api/test/db/net-worth-routes.test.ts`. Filtering those two paths
out leaves a clean build, and nothing this WP owns has appeared in the error list at any point:

```
$ pnpm exec tsc -b --noEmit 2>&1 | grep -E '^[a-z].*\([0-9]+,[0-9]+\)' \
    | grep -v -E 'routes/|-routes\.test\.ts'
  (no output)
```

This is the one check the orchestrator must re-run at the landing commit rather than take from here: it is
a whole-repo build and it cannot be green for this WP alone while another agent's files are open.

The one that was ours:

**this WP broke `export-import.test.ts` and fixed it.** Its
`'every user-scoped table appears in the manifest'` test discovers user-scoped tables from the live schema,
so `connection_sync_facts` failed it the moment 0018 landed — which is the mechanism working, not a
nuisance. One `EXEMPT_TABLES` entry in `apps/api/src/reports/export/registry.ts`, with the same reasoning
`connection_staged_facts` carries: every row is a restatement of the provider's last statement and the next
sync rewrites all of them, while what must survive a round trip is what the lot engine computed _from_
them (`investment_transactions`, `cost_basis_lots`), both already listed there. A bundle carrying both
would restore two copies of one truth, one of which is stale on the next sync.

---

## 11. Carried, and asks for the orchestrator

1. **`ProviderHoldingFact.security` is one identifier where the resolver needs the set — a port defect,
   found by this WP's own test.** `ProviderSecurityFact.identifiers` carries every name a provider gave and
   `resolver.ts` says in as many words that it "can only [tier] if it sees the whole set". But
   `ProviderHoldingFact` carries a single `SecurityIdentifier`, and `map.ts`'s `holdingSecurityOf` picks the
   **strongest one** — the FIGI, for VTI — discarding the ISIN, the CUSIP and the MIC-qualified ticker that
   `securityIdentifiersOf` had already extracted two lines earlier. Reproduced: in
   `phase3-wiring.test.ts` an earlier test resolves `ticker/VTI@XNYS` and this leg resolves
   `figi/BBG000BDTF76`, and the two produce **two `securities` rows** that never merge, because no provider
   ever stated both at once. Within a single provider nothing breaks (the `proprietary` Plaid
   `security_id` folded in by `asResolvable` keeps the same row on every re-sync), so this is a
   cross-provider defect — which is exactly the §5 exit criterion's shape ("ETH on Coinbase and in a wallet
   resolves to one security"), and the §5 risk table's "One asset, two securities" row. The fix is one
   field — `ProviderHoldingFact` should carry the `ProviderSecurityFact` (or at least its `identifiers`),
   which `holdingFactOf` already has in scope and currently only puts in `raw`. It touches
   `packages/connectors/port/src/facts.ts` and `packages/connectors/plaid/src/map.ts`, **neither of which
   this work package owns**, plus the Coinbase and walletrpc adapters. Recommend a small follow-up WP
   before the gate.
2. **The same gap costs `securities.type`.** With only an identifier and no provider `type`/`name`,
   `securityTypeOf(null, identity, null)` returns `other` for everything that is not a `chain_contract`. The
   Sandbox fixture's `etf` / `cash` / `cryptocurrency` never reach the resolver from the holdings leg. WP
   3.1's classification waterfall and the seed table still supply asset class, so allocation is not wrong —
   but `securities.type` from this path is weaker than it needs to be, and item 1 fixes both at once.
3. **A retried lot-consumer delivery can append a duplicate `SecurityResolutionFailed`.** §3 explains why
   the resolution runs in its own transaction and why that is the right trade. If the noise ever matters,
   the fix is a per-context port factory in `apps/api/src/modules.ts` — `port: (context) => …` instead of
   `port: options.investmentSyncPort` — which is that file's change, not this function's.
4. **`0018` was reserved for WP 3.9 and is spent here.** §2.2 says why. Please confirm no concurrent work
   package also claimed it.
5. **The `balances` leg still does not emit `connections.SyncRunCompleted`; the three new legs do.** The
   asymmetry is deliberate and narrow — nothing consumes a balances run, and `@ctx/investments`' lot
   consumer consumes these — but it is an asymmetry, and the honest place to resolve it is WP 3.8's or a
   later reader of balances runs. Changing it here would have altered the event counts several Phase 1 and
   Phase 2 suites assert on, for no consumer that exists.
6. **Nothing in this WP exercises live Plaid Sandbox.** The fixtures are recorded Sandbox shapes and
   `plaid-sandbox.test.ts` skips without credentials, unchanged. The gate's cold walk is where a live
   holdings sync gets observed for the first time.
