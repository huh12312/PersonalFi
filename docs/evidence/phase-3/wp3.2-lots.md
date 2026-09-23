# WP 3.2 — holdings, lots, cost basis, corporate actions

Migration **0014_lots.sql**. Package `@ctx/investments`, on WP 3.1's securities master.

> **Note on names.** The dispatch §3 names the migration `0014_holdings.sql` and the evidence
> `wp3.2-holdings.md`; the dispatch brief that was actually issued to the agents names
> `0014_lots.sql` and `wp3.2-lots.md`, and the first agent had already written both under those
> names before the session limit. Kept as `lots`, because renaming a migration that other agents'
> `migrate.test.ts` entries and this wave's working trees already reference is a collision for no
> gain. The _content_ is the dispatch's, table for table.

---

## 1. Tables

Five tables, all claimed in `packages/contexts/investments/OWNERSHIP.md` and all verified by
`pnpm lint:schema-ownership` (`98 table(s) claimed across 14 package(s), 77 defined`).

| Table                     | What it is                                               | Key columns                                                                                                                                                                                               | Identity                                                          |
| ------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `holdings`                | What the institution **asserts** is held now             | `quantity NUMERIC(38,18)`, `institution_value_minor BIGINT`, `cost_basis_minor BIGINT NULL`, `cost_basis_per_unit NUMERIC(20,10)`, `cost_basis_is_user_supplied`, `as_of_date`                            | UNIQUE `(user_id, account_id, security_id)`                       |
| `holdings_snapshots`      | The same, once per calendar day                          | as above, plus `as_of_date` in the key                                                                                                                                                                    | UNIQUE `(user_id, account_id, security_id, as_of_date)`           |
| `investment_transactions` | The provider's transaction ledger                        | `type` (16-value CHECK), `subtype`, `quantity NUMERIC(38,18)`, `price NUMERIC(20,10)`, `amount_minor`, `fees_minor`, `trade_date`, `settle_date`, `source BROKER\|IMPORTED\|USER`                         | UNIQUE `(user_id, account_id, provider, provider_transaction_id)` |
| `cost_basis_lots`         | What **we computed**, per Rev. Proc. 2024-28 basis scope | `open_date`, `holding_period_start_date`, `quantity`, `quantity_remaining`, `basis_minor NULL`, `basis_consumed_minor`, `basis_source`, `acquisition_type`, `basis_warning`, `wash_sale_adjustment_minor` | `id` (derived from the opening transaction)                       |
| `basis_method_elections`  | Which lot a sale consumes                                | `method`, `elected_on`                                                                                                                                                                                    | UNIQUE `(user_id, account_id, security_id)`                       |

`holdings` and `cost_basis_lots` are deliberately separate: one is an assertion with an `as_of`
date, the other is a derivation from `investment_transactions`. Collapsing them would make a
provider's wrong cost basis indistinguishable from our own arithmetic.

**`holding_period_start_date` is a separate column from `open_date`** because a wash sale tacks the
replaced lot's period on: the lot still _opened_ when it opened, and only the period moves. The
CHECK below enforces the direction.

### Constraints, each asserted by name in `test/db/lots.test.ts`

| Constraint                                                 | Refuses                                                    | SQLSTATE |
| ---------------------------------------------------------- | ---------------------------------------------------------- | -------- |
| `cost_basis_lots_quantity_remaining_check`                 | a negative remainder                                       | 23514    |
| `cost_basis_lots_remaining_within_quantity`                | a remainder above the original quantity                    | 23514    |
| `cost_basis_lots_unknown_basis_is_declared_estimated`      | a NULL basis on a source that claims to _know_             | 23514    |
| `cost_basis_lots_estimated_basis_carries_a_warning`        | an `ESTIMATED` lot with no warning text                    | 23514    |
| `cost_basis_lots_basis_minor_check`                        | a negative basis                                           | 23514    |
| `cost_basis_lots_consumed_within_basis`                    | consuming more basis than the lot has                      | 23514    |
| `cost_basis_lots_holding_period_starts_no_later_than_open` | a period starting _after_ the lot opened                   | 23514    |
| `cost_basis_lots_wash_sale_adjustment_minor_check`         | a negative wash-sale adjustment                            | 23514    |
| `cost_basis_lots_wash_adjustment_needs_a_basis`            | an adjustment on a lot with no basis to adjust             | 23514    |
| `basis_method_elections_average_cost_is_sticky`            | switching away from `AVERAGE_COST` (BEFORE UPDATE trigger) | P0001    |

The last one is a trigger rather than a CHECK because stickiness is a statement about the
_transition_, not about the row.

---

## 2. The method matrix

Only the **order** differs between the five methods; `orderLotsFor` is the whole vocabulary and
`matchDisposal` is one function rather than five.

| Method         | Queue order                                    | Notes                                                |
| -------------- | ---------------------------------------------- | ---------------------------------------------------- |
| `FIFO`         | `open_date` asc, then `id` asc                 | default, and the IRS default when nothing is elected |
| `LIFO`         | `open_date` desc, then `id` desc               |                                                      |
| `HIFO`         | basis per unit desc, then `open_date` asc      | **unknown-basis lots sort last**, never first        |
| `SPECIFIC_ID`  | exactly the ids the caller named, in order     | a missing id is a warning, not a throw               |
| `AVERAGE_COST` | `open_date` asc over a _pooled_ per-unit basis | mutual funds only; sticky per account × security     |

`id` breaks every tie, and that is the point rather than a detail: without it the order is whatever
Postgres returned, so the same sale would select a different lot after a VACUUM and produce a
different tax number on a second run.

### Worked example — one sale, four answers

Three lots, then a 15-share sale on 2025-06-01 for $4,500.

| lot     | opened     | qty | basis  | per unit |
| ------- | ---------- | --- | ------ | -------- |
| `lot-a` | 2024-01-10 | 10  | $1,000 | $100     |
| `lot-b` | 2024-06-10 | 10  | $3,000 | $300     |
| `lot-c` | 2025-02-10 | 10  | $2,000 | $200     |

| Method                       | Lots consumed          | Basis taken              |
| ---------------------------- | ---------------------- | ------------------------ |
| FIFO                         | `lot-a` 10 + `lot-b` 5 | $1,000 + $1,500 = $2,500 |
| LIFO                         | `lot-c` 10 + `lot-b` 5 | $2,000 + $1,500 = $3,500 |
| HIFO                         | `lot-b` 10 + `lot-c` 5 | $3,000 + $1,000 = $4,000 |
| SPECIFIC_ID `[lot-c, lot-a]` | `lot-c` 10 + `lot-a` 5 | $2,000 + $500 = $2,500   |

Four distinct selections, asserted distinct (`new Set(...).size === 4`) and each re-run and compared
against itself. `'FIFO, LIFO, HIFO and specific-ID select different lots for the same sale and each
is reproducible'`.

### HIFO and the unknown basis

"Highest in" cannot rank a lot whose basis nobody knows, and treating the unknown as a zero would
rank it _lowest_ — gain-from-zero arriving through a comparator instead of through a subtraction.
`byBasisPerUnitDescending` puts every unknown-basis lot at the back.

### The 4:1 split

|        | quantity | per-unit basis | **total basis** |
| ------ | -------- | -------------- | --------------- |
| before | 10       | $100.00        | **$1,000.00**   |
| after  | 40       | $25.00         | **$1,000.00**   |

Total basis is invariant _by construction_, not by arithmetic: `applySplit` copies `basis` and
`basis_consumed` and changes only `quantity` and `quantity_remaining`. Per-unit basis is derived on
demand and never stored, so there is no rounding step to drift. `openDate`,
`holdingPeriodStartDate`, `basisSource`, `acquisitionType` and `washSaleAdjustment` all survive — a
split is not an acquisition, and if it restarted the clock every long-term holding in a company that
split would silently become short-term.

Ratios are two `bigint`s (`4n/1n`, `1n/10n`) rather than a decimal, because a 3:2 split is 1.5 and
1.5 is exactly the number that arrives as a float and leaves as `1.4999999999999998`.

---

## 3. The 61-day wash-sale window

```
        day -31       day -30            day 0           day +30      day +31
          │             │                  │                │            │
    outside │◄──────────┤   30 before      │   30 after     ├──────────►│ outside
            │           └──────── the sale date itself ─────┘           │
                        └──────────── 61 days total ────────────────────┘
```

`WASH_SALE_WINDOW_DAYS = 30`, `WASH_SALE_WINDOW_SPAN_DAYS = 61`. **Both** boundaries are tested, in
**both** directions: day ±30 inside, day ±31 outside, and the sale date itself inside — the half of
§1091 that a "30 days either side" reading quietly drops.

The label is **`POSSIBLE_WASH_SALE`**, never `WASH_SALE`. The app does not see the user's other
brokerages, their spouse's accounts or an IRA at another custodian, so it cannot assert §1091 — only
that the pattern is there. The test asserts the value and asserts it is not the bare form.

The scan runs **across every account, including IRAs** (07 §4.4's "trap most software misses"),
which is what catches a loss taken in a taxable account and replaced inside an IRA.

### Worked wash-sale example

Sold 100 shares on **2026-03-15** at a **$1,000 loss**, held since **2024-01-10**. Bought 100 back
on **2026-03-25** for **$9,000**.

|                              | before     | after                               |
| ---------------------------- | ---------- | ----------------------------------- |
| replacement basis            | $9,000.00  | **$10,000.00** (+$1,000 disallowed) |
| `wash_sale_adjustment_minor` | 0          | **100000**                          |
| `holding_period_start_date`  | 2026-03-25 | **2024-01-10** (tacked)             |
| `open_date`                  | 2026-03-25 | 2026-03-25 (unmoved)                |
| term of a 2026-04-30 sale    | SHORT_TERM | **LONG_TERM**                       |

Both halves, always together. Software that adds the basis and forgets the tacking reports a
long-term gain as short-term for up to a year — the more expensive error, and the one nobody
notices.

Two cases are deliberately left **unadjusted**: a lot with an unknown basis (there is no number to
add $1,000 to, and inventing one is the laundering 04 §5.5 forbids —
`cost_basis_lots_wash_adjustment_needs_a_basis` says the same in SQL), and a Rev. Rul. 2008-5
replacement inside an IRA, where the loss is permanently lost rather than deferred and
`basisAdjustmentIsPermanentlyLost` on the flag is what tells the user.

A partial repurchase prorates: 40 shares bought back against 100 sold defers $400 of the $1,000 and
leaves $600 deductible, split exactly by `Money.allocate`.

### The digital-asset exclusion is a dated value, not a branch

```ts
export const DEFAULT_WASH_SALE_CONFIG: WashSaleConfig = Object.freeze({
  appliesToDigitalAssets: false,
  asOf: '2026-09',
});
```

`asOf` is part of the value rather than a comment, so a stale policy is visible in an API response
and a config snapshot rather than only in this file's history. `'the digital-asset exclusion is read
from config, not hardcoded'` proves it is a value by flipping _only_ the config and watching the
same BTC history go from zero flags to one — a hardcoded `if (isCrypto) return` leaves it empty.

---

## 4. The never-zero-basis rule

04 §5.5: "Where basis is unknown, report unrealized gain as _unavailable_ rather than computing it
from a zero basis." The failure being prevented is not an error message — it is a number. A $40,000
position with no basis reported as a $40,000 gain looks exactly like a real $40,000 gain and flows
into allocation, into the tax estimate and onto the screen.

`UnrealizedGain` is a **discriminated union**, not `{ gain, known: boolean }`: there is no `Money` to
read at all when the answer is unavailable, so the only way to display something is to handle the
case. It carries `lotIds` and a `reason`, so the UI names the two positions that need a basis
instead of declaring the portfolio unknowable — and it still reports `marketValue`, because what a
position is _worth_ is knowable even when what it _cost_ is not.

The rule holds at five levels, each with its own test:

1. `openLot` refuses a NULL basis on `BROKER`/`IMPORTED`/`USER` — only `ESTIMATED` may say "unknown";
2. `costBasisOf` returns `unavailable` if **any** open lot lacks a basis — not the knowable subtotal,
   which is smaller than the truth and indistinguishable from a correct total;
3. `matchDisposal` propagates `basis: null → gain: null`, and an **unmatched remainder poisons both
   terms** because nothing is known about when the missing lot opened;
4. `realizedGainOf` reports a term as `unavailable` rather than summing the knowable half;
5. the database refuses it too (`cost_basis_lots_unknown_basis_is_declared_estimated`).

**One behaviour change made while finishing this WP.** `basisForAcquisition` previously fell through
to `quantity × price` whenever a price was present, including `price = 0`. Providers report `0` for a
movement they have no price for at least as often as for one that was genuinely free, so that path
handed back a confident **$0.00 basis** — the same fabrication, arriving through a multiplication
instead of a coalesce. A zero price is now treated as no price, producing an `ESTIMATED` lot with a
visible warning. A genuinely worthless airdrop can still be pinned at $0 by a `USER` basis, by the
one person entitled to assert it.

---

## 5. R6 — how the Coinbase verdict is handled

`docs/evidence/phase-3/wp3.5-coinbase.md` §1 measured it: v3 gives **exact fills only**; deposits,
withdrawals, staking rewards and transfers come from the CSV export or not at all. So a Coinbase
wallet routinely holds one `BROKER` lot with an exact basis beside three lots with none.

The seam is `ResolvedTransactionFact.source: 'BROKER' | 'IMPORTED' | 'USER'`, carried on the port
rather than inferred. The engine takes both legs through the same path and never has to know which
it is looking at; `basisSourceFor(source, basis)` maps an absent basis to `ESTIMATED` with a warning
regardless of which leg it arrived on. `'accepts an exact BROKER fill and an IMPORTED leg in one run
without inventing a basis'` drives a real sync with one of each and asserts one exact `BROKER` lot
and one `ESTIMATED` lot with non-empty warning text — and no `0` standing in for the unknown.

The engine also never averages the two: `AVERAGE_COST` over a pool containing an unknown basis is
`unavailable`, not the known part relabelled as all of it.

Per-wallet basis (Rev. Proc. 2024-28) is enforced in `matchDisposal` itself, not in the caller: lots
are filtered to `accountId` **and** `securityId` before ordering, so an older cheaper lot in another
wallet is ineligible however well it would have sorted.

Self-transfers carry lots: `carryLotsOnTransfer` is deliberately _not_ `matchDisposal` + `openLot`,
which would compute a gain against a transfer's notional proceeds and restart the holding period —
the wrong answer twice, and 07 §6.2's "single most common source of wrong crypto tax numbers". The
destination lot keeps `openDate`, `holdingPeriodStartDate`, `basis`, `basisSource` and
`washSaleAdjustment`; only the account and the id change.

---

## 6. Idempotence, and two bugs found while proving it

01 §5.5: there is no `/investments/transactions/sync`, so the connector re-fetches a **date window**
and the same fills arrive on every run, forever. Idempotence is therefore not a nicety here.

`test/db/consumer.test.ts` syncs the same run twice and compares **whole rows** of
`cost_basis_lots`, `investment_transactions` and `holdings` plus the `domain_events` count. Writing
that test found two real defects in the snapshot code:

1. **Wash-sale adjustments accumulated.** `applyWashSales` did `basis = basis + disallowedLoss`.
   Because the scan is a pure function of the stored history, a re-delivered run regenerates the
   same flags and added the same $1,000 again — every night, forever, with no error and no symptom
   except a capital gain that shrank a little each time. Fixed by **setting rather than adding**:
   `basis_minor` already includes the adjustment and `wash_sale_adjustment_minor` records how much
   of it is adjustment, so the unadjusted base is recoverable and the result is idempotent by
   construction. Flags are now also applied **all at once per security** — applying them one at a
   time under set semantics would let the last flag win. Three tests cover it, including
   `'applying the same flag twice adjusts the basis once, not twice'`.
2. **Every re-delivery re-announced.** `LotsUpdated`, `RealizedGainRecorded` and `HoldingsUpdated`
   were emitted unconditionally, so a nightly re-sync of an unchanged window woke every downstream
   consumer every night. Each emit site now compares computed state against stored state:
   `lotsAreUnchanged` for lots, and for holdings an `IS DISTINCT FROM` guard on the upsert's
   `DO UPDATE ... WHERE` with an empty `RETURNING` meaning "nothing moved" — one round trip, no
   race.

One deliberate exception, documented at the emit site: a Rev. Rul. 2008-5 wash sale adjusts no lot
and so leaves no state to remember it by, and is re-announced. The outbox is at-least-once and every
consumer is obliged to be idempotent; the alternative is never telling the user about the one wash
sale that costs them the entire deduction.

Lot ids are derived from the opening transaction rather than minted, so re-processing a transaction
updates its lot instead of opening a second one.

---

## 7. Properties (`fast-check`)

In `src/lots.test.ts`, 300 runs each over arbitrary portfolios (1–8 lots, arbitrary open dates,
quantities to 1e-2, basis in whole cents, a random share with **no** basis) and arbitrary chains of
1–6 sales under FIFO/LIFO/HIFO.

| Property                                                 | What it rules out                                                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `quantity_remaining is never negative`                   | an over-sale driving a lot below zero instead of reporting `unmatchedQuantity`; also asserts `remaining ≤ quantity` |
| quantity is conserved: matched + remaining = opened      | a matcher that loses or duplicates shares across a chain                                                            |
| basis is conserved across a chain of partial disposals   | the cent-per-disposal drift of "recompute per-unit basis and multiply"                                              |
| a basis is never negative, on a lot or on a match        |                                                                                                                     |
| FIFO and LIFO agree on total proceeds and total quantity | a method that moves money rather than deferring it                                                                  |
| an unknown basis never becomes a number                  | gain-from-zero surviving any length of chain                                                                        |

Plus `src/quantity.test.ts`: 500 runs round-tripping any 18-decimal quantity through
`quantityWeight` and back.

---

## 8. Numeric boundaries

| Column                                                                                                                                                       | Type             | Carried in TypeScript as       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- | ------------------------------ |
| `holdings.quantity`, `holdings_snapshots.quantity`, `investment_transactions.quantity`, `cost_basis_lots.quantity`, `cost_basis_lots.quantity_remaining`     | `NUMERIC(38,18)` | `Quantity` — a decimal string  |
| `investment_transactions.price`, `holdings.cost_basis_per_unit`                                                                                              | `NUMERIC(20,10)` | `Quantity` — a decimal string  |
| `*_minor` (`institution_value_minor`, `cost_basis_minor`, `amount_minor`, `fees_minor`, `basis_minor`, `basis_consumed_minor`, `wash_sale_adjustment_minor`) | `BIGINT`         | `Money` — `bigint` minor units |

**The grep**, over every file this WP owns
(`src/{lots,basis,wash-sale,corporate-actions,holdings,consumer,lots-store}.ts`,
`schema/{holdings,lots,investment-transactions}.ts`):

```
$ grep -nE "toFixed\(|parseFloat|Number\(" <wp3.2 files>
(none)
$ grep -n "toNumberApproximate" <wp3.2 files>
(none)
```

No `number` appears in any signature of the pure engine. The single rounding step in the whole
package is `roundHalfEven` in `src/basis.ts`, which converts a decimal _string_ to a `bigint` of
minor units — half-even, once, at the boundary, with the currency's scale passed in rather than
assumed to be 2 (the JPY bug 04 §2.3 names). `marketValueOf` is asserted against exact decimal
arithmetic: `3.33333333 × 63214.5678901234 = 210715.226089696107032922` → `$210,715.23`.

`test/db/quantity.test.ts` carries `'0.00000001 BTC survives a database round trip'` and checks the
raw column is still a **string** after the driver, so nothing helpfully parsed it into a double. It
also round-trips both ends of `NUMERIC(38,18)`: `0.000000000000000001` and
`99999999999999999999.999999999999999999`.

> **Path note.** The dispatch names this test `src/quantity.test.ts`. The exit-test _name_ is
> verbatim, but a database round trip belongs in the `investments-db` project — the root
> `vitest.config.ts` says "unit projects must not need Postgres" — so it lives in
> `test/db/quantity.test.ts`, and `src/quantity.test.ts` holds the pure half of the same boundary
> (satoshi through the engine, `quantityWeight` exactness, the cent-conservation split).

---

## 9. Sabotage

Two required sabotages, each applied, run, and reverted.

### 9.1 The short-term / long-term boundary

`src/lots.ts`, `termOf`: `heldDays > LONG_TERM_HOLDING_DAYS` → `heldDays >= LONG_TERM_HOLDING_DAYS`.
IRC §1222 says long-term is held _more than_ one year; the whole rule is one character, and getting
it wrong moves a gain between a 37% bracket and a 15% one with nothing in the output looking
different.

```
× a lot held exactly 365 days is short-term and one held 366 days is long-term  22ms
 Test Files  1 failed | 11 passed (12)
      Tests  1 failed | 144 passed (145)
```

Reverted; 145 passed.

### 9.2 The never-zero-basis rule

`src/basis.ts`, `costBasisOf`: disable the `unavailable` return and coalesce the unknown lot's basis
to `Money.zero(currency)` — the exact gain-from-zero fabrication, in one line.

```
× an unknown basis yields unavailable, not zero                                  30ms
× a lot with unknown basis reports unrealized gain as unavailable, never zero    10ms
 Test Files  1 failed | 11 passed (12)
      Tests  2 failed | 143 passed (145)
```

Both named exit tests caught it, from both directions (the single-lot case and the mixed
known/unknown case). Reverted; 145 passed.

---

## 10. Tests

| File                            | Project          | Tests  |
| ------------------------------- | ---------------- | ------ |
| `src/lots.test.ts`              | `investments`    | 21     |
| `src/basis.test.ts`             | `investments`    | 9      |
| `src/corporate-actions.test.ts` | `investments`    | 10     |
| `src/quantity.test.ts`          | `investments`    | 7      |
| `test/wash-sale.test.ts`        | `investments`    | 16     |
| `test/db/lots.test.ts`          | `investments-db` | 17     |
| `test/db/consumer.test.ts`      | `investments-db` | 6      |
| `test/db/quantity.test.ts`      | `investments-db` | 4      |
|                                 |                  | **90** |

Exit tests from the dispatch, all present verbatim:

- `'FIFO, LIFO, HIFO and specific-ID select different lots for the same sale and each is reproducible'`
- `'quantity_remaining is never negative'` (property, and again as a Postgres CHECK)
- `'an unknown basis yields unavailable, not zero'`
- `'a 4:1 split quadruples quantity, quarters per-unit basis and leaves total basis unchanged to the cent'`
- `'0.00000001 BTC survives a database round trip'`
- `'a repurchase on day 30 after a loss is flagged POSSIBLE_WASH_SALE and one on day 31 is not'`
- `'the digital-asset exclusion is read from config, not hardcoded'`

Plus the four the brief added:

- `'a lot with unknown basis reports unrealized gain as unavailable, never zero'`
- `'a self-transfer between wallets carries its lots and realizes nothing'`
- `'AVERAGE_COST once elected cannot be switched for that security'` (fake **and** Postgres trigger)
- `'a wash sale is labelled POSSIBLE_WASH_SALE and adjusts the replacement lot'`

---

## 11. Registration lines for the orchestrator

`packages/db/test/migrate.test.ts` already lists the five tables (done in this WP).

**`apps/api/src/modules.ts`** — add to the module list:

```ts
import { INVESTMENTS_EVENTS, createLotConsumer } from '@ctx/investments';

{
  flagKey: 'module.investments',
  events: INVESTMENTS_EVENTS,
  // Consumes connections.SyncRunCompleted. Lots are rebuilt from the full
  // transaction history for each touched (account, security) pair and written
  // with onConflictDoUpdate, so a re-delivered run writes the same rows and
  // emits nothing (wp3.2-lots.md §6). No jobs and no schedules: nothing here
  // is time-driven.
  consumers: [
    createLotConsumer({
      storeFor: (context) => drizzleLotStore(context.executor, clock),
      outboxFor: (context) => outboxOf(context.executor),
      port: createInvestmentSyncPort(database),
      clock,
    }),
  ],
},
```

`storeFor`/`outboxFor` are factories rather than instances **deliberately**: both must be built over
the pump's _transaction_, or a `LotsUpdated` survives a rolled-back derivation. Same shape as
`securityResolverFor` in `domain.ts`.

**`apps/api/src/domain.ts`** — the port implementation is the orchestrator's to write, because it
reads `@ctx/connections`' tables and `personalfi/layer-imports` forbids this context importing them:

```ts
export function createInvestmentSyncPort(database: Database): InvestmentSyncPort;
```

It must satisfy three methods (`packages/contexts/investments/src/consumer.ts`):

- `factsForRun(userId, syncRunId)` → `{ provider, asOfDate, holdings, transactions }`, where each
  fact is already resolved to a `security_id` by WP 3.1's resolver and each transaction carries
  `source: 'BROKER' | 'IMPORTED' | 'USER'`. A position the resolver abstained on must be **absent**,
  not present with a null security — `SecurityResolutionFailed` is the record that it existed.
- `isRetirementAccount(accountId)` → the Rev. Rul. 2008-5 case.
- `isDigitalAsset(securityId)` → read from `securities.type`, for the dated wash-sale flag.

**`apps/api/src/platform.ts`** — no change required by this WP. Nothing here is time-driven, so there
is no job handler and no schedule to register.

---

## 12. Open items

1. **`0014_lots.sql` vs the dispatch's `0014_holdings.sql`** — named as the issued brief said; see
   the note at the top.
2. **`src/quantity.test.ts` split across two projects** — §8's path note. The exit-test name is
   verbatim; only the file it lives in differs, and it differs to respect the "unit projects must
   not need Postgres" rule.
3. **A stale wash-sale adjustment is not cleared.** `applyWashSales` only touches lots a flag names,
   so a partial flag set cannot erase unrelated history — but if a correction to the underlying
   transactions makes a previously-flagged lot _stop_ being flagged, its adjustment stays. Bounded
   (the flags are a deterministic function of the history, so this needs the history itself to
   change) and worth a rebuild path when WP 3.7 wires the Plaid re-sync.
4. **`test/db/harness.ts` is not `@core/testkit`** — inherited from WP 3.1, and its header explains
   why: `scripts/eslint-boundaries.js` has no `investments` layer yet. Delete it and switch to
   `createTestDatabase` when the orchestrator adds that layer at a wave boundary.
5. **`AVERAGE_COST` mutual-fund-only is advisory in the engine.** `AVERAGE_COST_ELIGIBLE_TYPES` is
   exported and the election is sticky and enforced, but nothing rejects an `AVERAGE_COST` election
   on an ETF — the engine does not know a security's type, by design. The check belongs at the REST
   surface in WP 3.9, which does.
