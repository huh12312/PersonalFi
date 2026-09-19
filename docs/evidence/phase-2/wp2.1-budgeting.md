<!-- SPDX-License-Identifier: MIT -->

# WP 2.1 — Budgeting: envelope math, periods, rollover, Ready-to-Assign, credit cards

Scope: `@ctx/budgeting` — the envelope math of 07 §1.2–1.8 as pure functions over
`Money`, the period grid (calendar and non-calendar), the rollover policies and
their audit rows, Ready-to-Assign from the balance-sheet identity, credit-card
payment envelopes, the six goal types, auto-assign on roll, the dirty-flag
forward cascade, the actuals consumer, five domain events, the read models, and
migration `0009_budgeting.sql`.

Repo `/home/chris/Projects/PersonalFi`, branch `main`, from snapshot `aa6dbc1`.
Node 26, pnpm, Postgres 18 on `127.0.0.1:5433`. Scratch databases
`personalfi_wp_budget_{rta,dst,actuals,credit}`. Every number below is from a
command run against this working tree.

---

## Summary

| Deliverable                                                     | Where                                       |
| --------------------------------------------------------------- | ------------------------------------------- |
| Envelope math, pure over `Money` (07 §1.2–1.3, §1.8)            | `src/envelope.ts`                           |
| Period grid, half-open, integer `DateOnly` arithmetic (07 §1.7) | `src/periods.ts`                            |
| Ready-to-Assign from the balance-sheet identity (07 §1.2)       | `src/rta.ts`                                |
| `CCP[card]` mechanics and identity II (07 §1.3)                 | `src/credit.ts`                             |
| Auto-assign, non-blocking (07 §1.9)                             | `src/auto-assign.ts`                        |
| `activity(c, p)` with transfers excluded, refunds netted        | `src/actuals.ts`                            |
| `LedgerPort` + in-memory fake                                   | `src/ledger-port.ts`                        |
| Write paths, dirty cascade, alerts, roll                        | `src/service.ts`                            |
| Actuals consumer over five real event types                     | `src/consumer.ts`                           |
| Five emitted events                                             | `src/events.ts`                             |
| Read models                                                     | `src/read.ts`                               |
| Schema (six tables)                                             | `packages/db/migrations/0009_budgeting.sql` |

**Six tables, all claimed in `packages/contexts/budgeting/OWNERSHIP.md`:**
`budgets`, `budget_periods`, `budget_lines`, `budget_line_actuals`, `rollovers`,
`budget_alerts_state`. `node scripts/check-schema-ownership.ts` →
`ok — 95 table(s) claimed across 14 package(s), 53 defined.`

**Mode.** Dispatch §6 question 2's default, unchanged: `ENVELOPE_LITE`, rollover
on, auto-assign from targets, `CALENDAR_MONTH`. Stated once in
`DEFAULT_BUDGET` (`src/budget.ts`) as well as in the column defaults, so a
caller that constructs one explicitly gets the same answer the database would.

---

## 1. The normative math, transcribed with the memo line it came from

All quotes are from `docs/research/07-advisory-domain.md`. Line numbers are that
file's.

### 1.1 The four definitions — §1.2 lines 59–63

```
assigned(c, p)   = Σ budget_entry.amount WHERE category=c AND period=p
activity(c, p)   = Σ txn.amount          WHERE category=c AND budget_date ∈ p # outflows negative
carryover(c, p)  = rollover_fn(available(c, p-1), c.rollover_policy)
available(c, p)  = carryover(c, p) + assigned(c, p) + activity(c, p)
```

Implemented as `available()` in `src/envelope.ts`, and — because 07 §1.3's
funding rule is order-dependent — as `runEnvelope(opening, transactions)`, which
walks the period's rows in `(budgetDate, id)` order rather than summing them.
A pre-summed `activity` yields the right `available` and the **wrong**
cash/credit split, which is the half of §1.3 that decides red versus yellow.

### 1.2 `rollover_fn` — §1.2 lines 67–71

```
ROLLOVER  (default for envelope):  prev >= 0 ? prev : 0     # negative handled by §1.3
RESET     (target-only mode):      0
ROLLOVER_ALLOW_NEGATIVE (advanced): prev                     # debt-like categories only
```

`rolloverOut()`, a total switch over `RolloverPolicy`. Its complement
`absorbedByRta()` is the half the policy discarded; `available = out + absorbed`
is `CONSTRAINT rollovers_nothing_lost`, so the decomposition is a constraint the
database refuses a write without, not a convention.

### 1.3 The funding rule — §1.3 lines 112–116

```
on_categorized_spend(txn) where txn.account.type == CREDIT and txn.category == c:
    fundable = min(|txn.amount|, max(0, available(c, p)))
    available(c, p)            -= |txn.amount|          # always
    available(CCP[card], p)    += fundable              # only the funded part moves
    credit_overspend(c, p)     += |txn.amount| - fundable
```

Implemented verbatim inside `runEnvelope`'s loop. `max(0, …)` is load-bearing
and is sabotage-tested — see §5, S2.

### 1.4 Goals — §1.8 lines 219–224

```
goal_type ∈ {NONE, MONTHLY_TARGET, TARGET_BY_DATE, MINIMUM_BALANCE, PCT_OF_INCOME, REFILL_UP_TO}

needed_this_period(TARGET_BY_DATE) =
    max(0, (target_amount - available(c, p) - scheduled_inflows) / periods_remaining_inclusive)

underfunded(c, p) = max(0, needed_this_period(c,p) - assigned(c,p))
```

**The memo defines one of the six normatively and names the other five.** The
five below are this work package's, chosen so that no two collapse into each
other, and they are flagged as ours rather than as the memo's:

| Goal type         | `needed_this_period`                                                            | Source                             |
| ----------------- | ------------------------------------------------------------------------------- | ---------------------------------- |
| `NONE`            | `0`                                                                             | trivial                            |
| `MONTHLY_TARGET`  | `goalAmount`                                                                    | **ours**                           |
| `TARGET_BY_DATE`  | `⌈max(0, target − (carryover+activity) − scheduled) / periodsRemaining⌉`        | **07 §1.8 line 221–222**, verbatim |
| `MINIMUM_BALANCE` | `max(0, target − (carryover + activity))` — a floor maintained _after_ spending | **ours**                           |
| `REFILL_UP_TO`    | `max(0, target − carryover)` — a ceiling refilled at the _start_ of the period  | **ours**                           |
| `PCT_OF_INCOME`   | `max(0, periodIncome) × goalPercent`, half-even                                 | **ours**                           |

`MINIMUM_BALANCE` and `REFILL_UP_TO` are deliberately different: the first keeps
asking for more as the month's spending lands, the second does not. Collapsing
them would make one of the two goal types unreachable.

The division in `TARGET_BY_DATE` rounds **away from zero** (`divideRoundingUp`),
not with `Money.allocate`. `allocate` splits a known total into shares that sum
back to it, which is a different operation; rounding a per-period requirement
_down_ leaves the envelope one minor unit short on the target date every period
for the life of the goal.

### 1.5 Ready to Assign — §1.2 lines 73–80, and a correction

The memo:

```
RTA(p) = Σ_a balance(a)                       # a ∈ on-budget accounts; credit balances are negative
       − Σ_c available(c, p)                  # includes credit-card payment categories
       − Σ_{p' > p} Σ_c assigned(c, p')       # money pre-assigned to future periods
```

**The two inline annotations contradict each other and cannot both be applied.**
Worked example: $100 in checking, nothing on the card, $80 assigned to Groceries,
$20 unassigned. `Σ balance = 100`, `Σ available = 80`, `RTA = 20` — the identity
holds. Now put $50 of groceries on the credit card. §1.3's funding rule moves $50
out of Groceries and $50 into `CCP[card]`; the card balance becomes −$50. Nothing
about the household changed except which piece of plastic was used, so RTA must
still be $20. With **both** annotations applied:

```
Σ balance   = 100 + (−50) = 50
Σ available = 30 (Groceries) + 50 (CCP) = 80
RTA         = 50 − 80 = −30
```

The $50 is booked twice — once as a debt on the card, once as cash earmarked in
the CCP envelope. Dropping _either_ annotation fixes it, and they are not
equivalent: dropping the credit balance gives a cash-only identity needing an
extra "outstanding credit overspend" term to close, while dropping CCP from the
left keeps the memo's right-hand side exactly as written. **We drop CCP from the
sum:**

```
RTA(p) = Σ_{a ∈ on-budget} balance(a)              # credit balances negative
       − Σ_{c : kind = 'category'} available(c, p) # CCP lines excluded
       − Σ_{p' > p} Σ_c assigned(c, p')
```

The CCP envelopes are not unaccounted for — they are pinned by **identity II**
(§2 below) against the card's own balance.

**What this buys for free.** §1.3 line 99 says `RTA(p+1) -= |cash_overspend(p)|`
at the roll. Under this definition nobody applies it. A cash-overspent envelope
carries 0 forward under `ROLLOVER`, so `Σ available` is _higher_ next period by
exactly the overspend that was discarded, so RTA is _lower_ by exactly that
amount. Applying the subtraction as well would double-count it, which is why
`rollovers.absorbed_by_rta_minor` is recorded and not applied.

---

## 2. The two identities, and which period each is a statement about

**Identity I** (07 §1.2 line 85, as corrected above):

```
Σ_{kind='category'} available(c, p) + RTA(p) + Σ_{p'>p} assigned = Σ_{on-budget} balance(a)
```

**Identity II** (this work package's):

```
owed(card) = available(CCP[card]) + unfundedDebt(CCP[card])      where owed = −balance
```

Every dollar owed on a card is either earmarked to pay it or was borrowed with
no envelope money behind it.

### Identity I is definitionally true; identity II is the one with independent sides

`readyToAssign()` is _defined_ by identity I, so asserting it against freshly
computed terms is a tautology. Two things make the test real:

1. **Every term is read from a different place.** `Σ available` and `RTA` come
   from this context's **persisted** columns (`identityTermsOf`, `src/read.ts`);
   `Σ balance` comes from the **ledger**, through the port, as of right now. The
   thing under test is therefore the _cache_ — 07 §1.4 rule 6's "never as source
   of truth" — and a dirty cascade that failed to fire is exactly what it
   catches. It did: see §5, the first defect.
2. **Identity II has genuinely independent sides.** `owed` is the card's balance
   in the ledger; `available(CCP) + unfundedDebt` comes from this context's
   cascade. It is the one the CCP sabotage turns red.

### `owed = −balance`, unclamped

A clamp (`|min(balance, 0)|`) reads plausibly and is wrong for the one case that
is not a normal card: an **overpaid** card, whose balance is positive because a
payment landed before the charges it covers — ordinary autopay behaviour — or
because a large refund arrived. Under the clamp `owed` reads 0 while
`available(CCP)` is correctly negative, identity II fails, and because the
assertion _throws_, the recompute aborts and every later envelope stops
updating. Found by `actuals-consumer.test.ts` and fixed (§5, defect 3).

### "For all p" is false as written, and the corrected claim

07 §1.2 line 85 says the invariant holds "for all p". Taken literally it is false
the moment a period closes — not because the cascade is wrong, but because the
two sides are dated differently. `Σ_a balance(a)` is the balance **now**;
`Σ_c available(c, p)` for a closed `p` is frozen at the moment `p` closed.
Spending $75 in April moves the right-hand side and cannot move March's
left-hand side, and no arrangement of a forward-only cascade will make it.

Making it literally true would need a balance _as of_ each period's end date — a
quantity neither `LedgerPort` nor 07 §1.10's model carries, and whose only
consumer would be that assertion. **The claim we assert instead** is that the
identity is a statement about the **open** period, which is also the only period
whose RTA a user can act on; `RTA` on a closed period is a historical snapshot.
The suite therefore asserts two things, and both are load-bearing:

1. identity I **and** II on the open period, after every mutation;
2. that a closed period is **never rewritten again** — the forward-only half of
   07 §1.4 rule 6, which a cascade that dirtied too much would break and which
   the identity alone would not notice.

### The identity over 13 consecutive periods including two DST crossings

`test/db/rta-identity.test.ts` →
`'Σ available + RTA + future assignments equals Σ on-budget balances'` asserts
both identities after **every** mutation, per 07 §1.2 line 88 ("assert it after
every mutation in dev"):

| #    | Mutation                                                                     | Identity I | Identity II |
| ---- | ---------------------------------------------------------------------------- | ---------- | ----------- |
| 0    | open March 2026, 3 envelopes                                                 | ✓          | ✓           |
| 1    | assign $1,800 to rent (RTA 5000 → 3200)                                      | ✓          | ✓           |
| 2    | assign $600 to groceries                                                     | ✓          | ✓           |
| 3    | pay rent $1,800 in cash                                                      | ✓          | ✓           |
| 4    | $250 of groceries **on the card**                                            | ✓          | ✓           |
| 5    | a $100 night out, then a $40 refund of it                                    | ✓          | ✓           |
| 6    | pay the card $250 (a paired transfer)                                        | ✓          | ✓           |
| 7    | a $500 credit overspend on `fun`                                             | ✓          | ✓           |
| 8–20 | **13 consecutive rolls**, spending in each period, alternating cash and card | ✓ ×13      | ✓ ×13       |

The 13 rolls run March 2026 → April 2027, crossing **2026-11-01** (fall back,
25 hours) and **2027-03-14** (spring forward, 23 hours) in `America/New_York`.
Thirteen rather than twelve because the thirteenth period is the first whose
predecessor is a year old, which is where a bug that is annual rather than
monthly would hide.

**Conservation** is asserted twice: as a `fast-check` property over 500 runs and
arrays of up to 40 lines drawn from all three policies
(`'conservation: Σ rolloverOut(n) = Σ rolloverIn(n+1)'`), and — separately —
over the rows a _real_ roll writes, because the property proves the function and
not the writer.

---

## 3. Cash versus credit overspend, worked

07 §1.3 opens by saying the distinction most clones get wrong is **which asset
actually moved**. A $500 charge against a $300 envelope leaves the same −$200 in
both cases, and they are not the same fact.

Worked on a $300 groceries envelope and a $300 `fun` envelope, from
`test/db/credit-overspend.test.ts`:

| Quantity                      | cash ($500 from checking)      | credit ($500 on the card)       |
| ----------------------------- | ------------------------------ | ------------------------------- |
| what moved                    | $500 left a depository account | $500 of debt appeared           |
| `available_minor`             | −20 000 (−$200)                | −20 000 (−$200)                 |
| `cash_overspend_minor`        | **20 000**                     | 0                               |
| `credit_overspend_minor`      | 0                              | **20 000**                      |
| `funded_minor` on `CCP[card]` | — (unchanged at 30 000)        | **30 000, not 50 000**          |
| `available_minor` on `CCP`    | — (unchanged)                  | 30 000                          |
| `unfunded_debt_minor`         | —                              | **20 000**                      |
| identity II                   | n/a                            | owed 50 000 = 30 000 + 20 000 ✓ |
| colour (07 §1.3)              | **red**                        | **yellow**                      |
| what the user must do         | find $200                      | fund $200 before the statement  |

Three further steps in the same test:

- **A second charge on an already-negative envelope.** `max(0, available)` is
  zero, so `fundable = 0`: a further $50 charge moves _nothing_ into `CCP` and is
  borrowed whole. `funded_minor` stays at 30 000 and does not go backwards. This
  is the clause a `min` without the `max(0, …)` gets wrong — it would fund a
  _negative_ amount and quietly take money back out of the card's payment pot.
- **Funding the shortfall retires the debt.** Assigning $250 more to groceries
  takes `available` to 0, `credit_overspend` to 0, `funded` to 55 000 and
  `unfunded_debt` to 0 — the move that exists for yellow and has no equivalent
  for red.
- **The split is exhaustive.** `|min(available,0)| = cash + credit` is
  `CONSTRAINT budget_lines_overspend_splits_available`, asserted in the test as
  well as enforced by Postgres.

### Where this extends 07 §1.3 rather than transcribing it

1. **A refund larger than the CCP envelope holds.** §1.3 line 124 stops at
   `available(CCP) -= min(txn.amount, available(CCP))`. The card's balance drops
   by the _whole_ refund, so under that rule alone identity II breaks by the
   difference. The remainder retires unfunded debt — which is also what it means.
2. **A payment larger than the CCP envelope holds.** §1.3 line 119 is
   unconditional and stays so, so `available` goes negative. That is correct and
   identity II survives it: you paid the statement with money another envelope
   was holding. It is also why a CCP line's policy is `ROLLOVER_ALLOW_NEGATIVE` —
   under plain `ROLLOVER` the negative would be zeroed at the roll and identity
   II would break one period later.

---

## 4. Periods, DST, and grids that do not tile months

Phase 2's exit criterion is "a month closes and rolls over correctly across a
timezone and DST boundary". **The way this package passes it is by making it
impossible to fail rather than by handling it.** A period boundary is a calendar
date in the user's zone, stored in a `DATE` column, and every function in
`src/periods.ts` is integer arithmetic on `DateOnly` via `toEpochDay` /
`fromEpochDay`. No value in the grid is an instant. The only place the zone is
consulted is `todayIn(clock, zone)` — "which calendar date is it for this user" —
which is `@core/kernel`'s and is lint-enforced as the only sanctioned way to ask.

`test/db/period-roll-dst.test.ts` picks assertions that **break under an
instant-based implementation**:

| Assertion                                | Value                                                               | Why an instant-based grid fails it                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| March 2026 length, `America/New_York`    | **31 days**                                                         | The wall-clock span is 31 days _minus one hour_ (2026-03-08 is 23 h). `(end−start)/86 400 000` floors to **30**.                                 |
| March bounds                             | `[2026-03-01, 2026-04-01)`                                          | Half-open, and the 1st of the next month rather than "the 31st of this one" — what makes 28-, 29-, 30- and 31-day months the same kind of object |
| 2026-03-08 containment                   | inside March                                                        | —                                                                                                                                                |
| 2026-11-01 (fall back, 25 h) containment | first date of **November**, not last of October                     | The boundary and the transition are the same day                                                                                                 |
| roll March → April                       | `[2026-04-01, 2026-05-01)`, `sequence + 1`, March `closed`          | —                                                                                                                                                |
| carryover across the boundary            | 38 000 minor, conservation `in = out`, `out + absorbed = available` | —                                                                                                                                                |

**The harness's default zone is `America/New_York`**, so DST-safety is exercised
by every suite in the package rather than only by the one named after it.

### The non-calendar grid — `'…across a non-calendar biweekly grid that does not tile months'`

Anchored to a payday of 2026-01-02, per 07 §1.7 ("26 periods/yr and two
'3-paycheck months' — the engine must handle periods that don't tile months"):

| Assertion                                     | Value                                                                                               |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| every period's length                         | exactly 14 days                                                                                     |
| contiguity                                    | `period[n].start == period[n−1].end`, no gap, no overlap                                            |
| 26 periods a year                             | `start(26) − start(0) = 364 days` — the grid drifts a day a year and never realigns with month ends |
| the period containing the spring-forward date | **`[2026-02-27, 2026-03-13)`** — straddles _both_ a month boundary and the DST transition           |
| two spends, 2026-02-28 and 2026-03-08         | both land in that one period although they are in different months                                  |
| the roll                                      | into `[2026-03-13, 2026-03-27)` — the next 14-day block, not the 1st of a month                     |
| half-openness at the shared boundary          | 2026-03-13 is in the **new** period and not in the closed one                                       |

This is the harder case because it is the one where "the month rolled" and "the
period rolled" are different events.

---

## 5. Defects found, and the sabotages

### Defects found and fixed while finishing the package

**1. The dirty cascade was never exercised by the identity suite.** The harness's
`post()` moves the fake ledger; nothing marked the affected periods dirty, so
`recomputeDirty` was a no-op and the suite compared a stale cache against a moved
balance. It was **red on the first honest run** (`expected '5000.00' to be
'3200.00'`). Fixed by adding `settle(state, from)` to the harness, which does
exactly what the consumer does — `markDirtyFrom` then `recomputeDirty` — and
which takes a **required** `from` date rather than defaulting to "dirty
everything", because an over-dirtying default would let a cascade that marks too
narrow a window look correct.

**2. `recomputePeriod` was not idempotent for CCP lines.** It read the opening
unfunded debt from `unfunded_debt_minor` — the column the _previous_ recompute
wrote its **closing** value into — so a second recompute of an unchanged period
added the same borrowing twice and identity II failed by exactly one period's
overspend (`owed 500.00 ≠ available 0.00 + unfunded 1000.00`). Since the dirty
cascade re-runs a period whenever a later transaction arrives, and `rollPeriod`
re-runs it once more before closing, **"recompute twice" is the normal path**.
Fixed by adding `budget_lines.carryover_unfunded_debt_minor` — the opening value,
written only by a roll — exactly as `carryover_minor` is the opening
`available_minor`. Migration `0009` carries the derivation as a column comment.

**3. Identity II was clamped and broke on an overpaid card.** See §2. Fixed to
`owed = −balance`.

**4. `COMMENT ON TABLE budget_lines` tripped the DDL float lint.** The string
contained the word "money", which `packages/db/test/migrate.test.ts` scans for as
a whole word alongside `REAL` / `DOUBLE PRECISION` / `FLOAT`. Reworded to "the
amounts"; the check is right and the comment was a false positive.

### Sabotage S1 — break the `CCP[card]` auto-line

`ensureCreditCardPaymentLines` made an unconditional no-op, so no credit-card
payment line is ever created.

**First run, before hardening — a finding.** Only
`credit-overspend.test.ts` went red (`Error: no CCP line for card …`).
`rta-identity.test.ts` **stayed green**, because identity I is how RTA is defined
and identity II is checked _per CCP line_ — with no lines, the loop has no
iterations and both identities pass **vacuously**. A control that cannot observe
its own absence is not a control.

**Hardening.** `assertIdentity` now pins 07 §1.3 line 130's 1:1 claim directly:
the set of CCP lines in the period must equal the set of on-budget credit
accounts.

**Second run, after hardening — red, as required:**

```
× Σ available + RTA + future assignments equals Σ on-budget balances
  AssertionError: after opening March: one CCP line per on-budget credit account
  (07 §1.3 line 130): expected [] to deeply equal [ Array(1) ]
× credit overspend funds CCP only up to available
  Error: no CCP line for card 01a0b9e2-…
Test Files  2 failed | 3 passed (5)
Tests  2 failed | 23 passed (25)
```

Restored; 25/25 green.

### Sabotage S2 — remove the funding clamp

`fundable = min(magnitude, headroom)` → `fundable = magnitude`, i.e. move the
whole charge into `CCP[card]` regardless of what the envelope held. This is the
specific defect that makes the Credit Card Payment envelope report the statement
is covered when it is not.

**Red, across both projects:**

```
× a credit overspend is yellow: no cash has left the building       (src/envelope.test.ts)
× owed = available(CCP) + unfundedDebt after a partly funded charge (src/envelope.test.ts)
× credit overspend funds CCP only up to available                   (test/db/credit-overspend.test.ts)
AssertionError: expected 50000n to be 30000n
AssertionError: expected 2000n to be 0n
AssertionError: expected 5000n to be 3000n
Test Files  2 failed | 3 passed (5)
Tests  3 failed | 22 passed (25)
```

Restored; 25/25 green. Both sabotages were red on the first try _after_ the S1
hardening; S1 was **not** red on the first try before it, and that is the finding
worth carrying to the gate.

---

## 6. The dirty-flag forward cascade, and its measured cost

07 §1.4 rule 6:

> Store `available` as a _computed, cached_ value with a dirty-flag cascade,
> never as source of truth. … **Late-arriving transactions** for a closed period:
> re-run the period cascade from the affected period forward.

`markDirtyFrom(date)` sets `dirty` on the period containing that date **and every
later period, and on nothing earlier**. The predicate is `end_date > date`, which
is true for the containing period and every later one and false for every earlier
one. (`start_date >= date` would skip the containing period — the one that
actually changed.) `recomputeDirty` then processes them **oldest first and
sequentially**, because period _n_'s closing `available` is period _n+1_'s
`carryover`.

Forward-only is not an optimisation, it is the correctness statement: a carryover
only ever flows forwards, so a February transaction cannot change January.

`test/db/actuals-consumer.test.ts` →
`'a late transaction dirties only the periods from its own forward'` asserts it
from two directions:

1. **The dirty set itself**, read before any recompute clears the flags — the
   only moment it is observable. A row dated 2026-02-14 dirties exactly
   `{February, March}` and not January, and the returned order is ascending by
   `sequence`.
2. **End to end, through the real pump.** The late transaction moves the checking
   balance, so _any_ period recomputed from that point on gets a different RTA.
   January's RTA is therefore a witness: it is unchanged, and its `recomputed_at`
   is unchanged, so January was never recomputed. Repeated for
   `categorization.AssignmentsChanged`, which names ids and **no** window, so the
   consumer asks the port for their dates — and must reach the same answer.

### Measured cost

Measured on a scratch database with **24 monthly periods, 5 lines each (4
envelopes + 1 CCP), 960 transactions** (40 per period), via a temporary probe run
against this working tree and then deleted:

| Late transaction arrives in  | Periods dirtied | Total    | Per period |
| ---------------------------- | --------------- | -------- | ---------- |
| the newest period            | 1               | 28.2 ms  | 28.2 ms    |
| the middle (period 13 of 24) | 12              | 368.3 ms | 30.7 ms    |
| the oldest period            | 24              | 629.6 ms | 26.2 ms    |
| the newest period, again     | 1               | 24.6 ms  | 24.6 ms    |

**The cost is linear in the number of periods from the arrival point forward, at
a flat ≈26–31 ms per period, and is independent of how much history lies behind
it.** The common case — a transaction landing in the open period during a sync —
costs one period's recompute. The worst realistic case — a two-year-old manual
import — costs the whole chain once, and the repeat measurement shows no
accumulated cost from having done it.

---

## 7. `bigint` boundaries — no `number` reaches a `*_minor` column

| Boundary                         | Type                             | Guard                                                                                                                                                                                                                                                                                             |
| -------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `*_minor` columns (all 18)       | `BIGINT`                         | `amountMinorColumn()` = `bigint(name, { mode: 'bigint' })` (`packages/db/src/columns.ts:66`). Drizzle returns a JS `bigint`, never a `number`.                                                                                                                                                    |
| `Money`                          | `{ minor: bigint, currency }`    | `@core/kernel`. Every arithmetic op in the package goes through `Money.*`.                                                                                                                                                                                                                        |
| Event payload amounts            | **decimal string**               | `Money.formatAmount` at `.create(...)`, schema `z.string().regex(/^-?\d+(\.\d+)?$/)`. A JSON number cannot hold a `bigint` safely.                                                                                                                                                                |
| `goal_percent` (`PCT_OF_INCOME`) | `NUMERIC(7,4)`, `mode: 'string'` | `Money.multiplyByDecimal` takes a decimal **string** and refuses a `number` — `0.1 * 3` is the bug that type exists to prevent.                                                                                                                                                                   |
| Alert `ratio`                    | decimal string                   | `ratioString()` — `(spent.minor * 10_000n) / assigned.minor`, integer division, rendered by string slicing. The _comparison_ that decides whether a rung was crossed is done on the integers (`spentTimes100.minor >= assigned.minor * rung`), so no rounding can move a line across a threshold. |
| `TARGET_BY_DATE` division        | `bigint`                         | `divideRoundingUp` — `(magnitude + divisor − 1n) / divisor`, all `bigint`.                                                                                                                                                                                                                        |
| Read models                      | `Money`                          | `src/read.ts` returns `Money`, never minor units and never a `number`, so no caller has to decide.                                                                                                                                                                                                |

**Audit of every non-`bigint` numeric operation in `src/` and `schema/`:**

| Site                 | Operation                                       | Money?               |
| -------------------- | ----------------------------------------------- | -------------------- |
| `consumer.ts:174`    | `Math.floor(occurredAt.getTime() / 86_400_000)` | no — epoch **days**  |
| `periods.ts:72`      | `Math.floor(differenceInDays / stride)`         | no — a period index  |
| `ledger-port.ts:190` | `Number(input.cursor)`                          | no — a paging offset |

There is no other `Number(`, `parseFloat`, `parseInt`, or float multiply/divide
anywhere in the context. `priority`, `sequence` and the `*_count` columns are
`INTEGER` and are not money.

The migration additionally forbids the types outright:
`packages/db/test/migrate.test.ts` fails any migration whose DDL contains
`REAL`, `DOUBLE PRECISION`, `FLOAT` or `MONEY` as a whole word.

---

## 8. The `LedgerPort`

`personalfi/layer-imports` forbids one context importing another, and
`docs/CONVENTIONS.md` gives the remedy in one line — "where a cycle seems
necessary, the answer is a domain event, not an import". Budgeting needs both
halves: it **reacts** to five event types through the pump, and it **reads** the
rows those events named, which an event payload deliberately does not carry
(`@ctx/ledger`'s `events.ts`: "payloads are ids and counts, never rows").

The port is declared in `src/ledger-port.ts` and is **read-only** — unlike
`@ctx/categorization`'s, which has one write path into
`transactions.rule_category_id`, there is no column in `@ctx/ledger` that
budgeting is the producer of.

```ts
export interface LedgerPort {
  listForBudget(input: ListForBudgetInput): Promise<BudgetTransactionPage>;
  listBudgetAccounts(input: { readonly userId: string }): Promise<readonly BudgetAccount[]>;
}

export interface ListForBudgetInput {
  readonly userId: string;
  /** Half-open, to match the period grid: `dateFrom <= budgetDate < dateTo`. */
  readonly dateFrom: DateOnly;
  readonly dateTo: DateOnly;
  readonly accountIds?: readonly string[];
  readonly cursor?: string | null;
  readonly limit?: number;
}

export interface BudgetTransaction {
  readonly id: string;
  readonly accountId: string;
  readonly budgetDate: DateOnly;
  readonly amount: Money; // signed; negative = outflow
  readonly categoryId: string | null; // the *effective* category
  readonly funding: 'CASH' | 'CREDIT';
  readonly transferLinkId: string | null;
  readonly isTransfer: boolean;
  readonly refundOfId: string | null;
  readonly excluded: boolean;
}

export interface BudgetAccount {
  readonly id: string;
  readonly type: string;
  readonly role: 'CASH' | 'CREDIT' | 'OFF_BUDGET';
  readonly workingBalance: Money | null; // null is NOT zero — see below
  readonly closed: boolean;
}
```

**Why each field is load-bearing.** The v0.8 rung is "budgets exclude transfers
and net refunds", and both exclusions are decided from facts only the ledger has:
`transferLinkId` (a paired movement contributes zero — _both legs dropped_, so
the two need not cancel to the cent across an FX rate or a wire fee),
`refundOfId` (a refund is _netted against its original_, a different operation
from being excluded), and `funding` (07 §1.3's whole distinction is "which asset
actually moved", and only the ledger knows the account type).

**`workingBalance: null` is not zero.** 07 §1.4 rule 3 says RTA uses the
_working_ balance — every observation, pending included — not the cleared one.
An account that has never reported one makes `recomputePeriod` throw
`budgeting.balance_unreported` rather than silently treating it as empty: a
budget whose identity treats an unreported account as empty is wrong by the size
of that account and says nothing.

**The fake.** `createFakeLedger()` is exported from the package's **public
surface**, not hidden in `test/`. Three callers want it and all three are better
off with one copy: the pure suites, `test/db/`, and the Phase 2 gate — whose
standard is that an independent reviewer re-runs the load-bearing proofs, and a
fake they must re-implement is a fake that will differ in whichever direction
makes the proof pass. It is a fake, not a mock: it answers from data, has no
expectations, cannot be "verified", and models paging deliberately so
`streamForBudget`'s cursor loop is exercised rather than trivially satisfied.

---

## 9. Events

### Consumed — all five exist today with these exact names

| Event                                  | Why budgeting cares                                                     | Declared at                                         |
| -------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------- |
| `ledger.TransactionsUpserted`          | new or changed spending in a date window                                | `packages/contexts/ledger/src/events.ts:57`         |
| `ledger.TransactionSupersededByPosted` | pending → posted moves the amount _and_ the date (tips, FX, fuel holds) | `…/events.ts:98`                                    |
| `ledger.TransferPaired`                | two rows just became invisible to every budget total                    | `…/events.ts:76`                                    |
| `ledger.BalanceRecorded`               | the right-hand side of identity I moved                                 | `…/events.ts:42`                                    |
| `categorization.AssignmentsChanged`    | money moved between envelopes with no transaction changing              | `packages/contexts/categorization/src/events.ts:17` |

**None is missing and none was added.** The consumer names them as _strings_
rather than importing them, for the reason `@ctx/categorization`'s consumer
gives: importing would be importing another context and the boundary lint
correctly refuses. `test/db/actuals-consumer.test.ts` redeclares them
field-for-field and publishes real envelopes, which is what keeps the two copies
in step — a rename on either side makes the suite go quiet, so every test there
begins by asserting the pump delivered something.

### Emitted — five, all in `BUDGETING_EVENTS`

| Event                              | Carries                                                                                     | Note                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `budgeting.BudgetPeriodOpened`     | bounds (dates, not instants), `sequence`, `lineCount`                                       | a period boundary is when several other contexts want to act; none should infer "a month started" from a clock of its own |
| `budgeting.BudgetPeriodRolled`     | `rolledOut`, `absorbedByRta`, `autoAssigned`, `lineCount`                                   | the conservation pair                                                                                                     |
| `budgeting.BudgetLineAssigned`     | `source ∈ {USER, AUTO, ROLLOVER_FIX}`, `delta` **and** new `assigned`                       | an assignment the system made must be explainable and undoable                                                            |
| `budgeting.BudgetThresholdCrossed` | `PCT_50/80/100`, `OVERSPENT_CASH`, `OVERSPENT_CREDIT`, `RTA_NEGATIVE`, `ratio`, `available` | **edge-triggered**                                                                                                        |
| `budgeting.ReadyToAssignChanged`   | `readyToAssign`, `previous`                                                                 | emitted on the change, not on every recompute                                                                             |

**Edge-triggering is a promise to WP 2.4.** `budget_alerts_state` holds a row
once a threshold has been crossed and the row is **deleted** when a recompute
puts the line back under — delete rather than a `resolved` flag, because the
presence of the row _is_ the state and an `un-resolve` rule would be written once
and tested never. So the event fires on the crossing and not on every sync page
for the rest of the month. WP 2.4 coalesces notifications; it must not be
coalescing away a storm this context should never have emitted.

`OVERSPENT_CASH` and `OVERSPENT_CREDIT` are distinct because 07 §1.3 makes them
different facts.

---

## 10. Wiring — the exact lines to add

**This WP does not own any of these files and has edited none of them.** The
lines below are stated for the orchestrator to apply at the wave boundary, and
were derived by reading the current `@ctx/ledger` surface rather than assumed.

### `apps/api/src/platform.ts` — one `MODULE_FLAGS` entry

Append inside the `Object.freeze([…])` at `platform.ts:63`:

```ts
  Object.freeze({
    key: 'module.budgeting',
    defaultEnabled: false,
    owner: 'budgeting',
    removeWhen:
      'never — this is the kill switch for the envelope cascade, and 07 §1.9 ' +
      'requires the app stay fully usable with the budget off (budget_mode = OFF)',
  }),
```

`defaultEnabled: false` when this WP merges, flipped to `true` at the wave
boundary once the consumer is registered and green, per dispatch §4 item 3.

### `apps/api/src/domain.ts` — the adapter

Add to the imports (note the **name collision**: `LedgerPort` at
`domain.ts:84` is already bound to `@ctx/categorization`'s port, which is a
different type with the same name):

```ts
import type { LedgerPort as BudgetingLedgerPort } from '@ctx/budgeting';
import { DateOnly } from '@core/kernel';
import { listAccounts, listTransactions, type AccountSummary } from '@ctx/ledger';
```

Place the function immediately after `createCategorizationLedgerPort` ends
(`domain.ts:175`) and before the `PROCESS_LOCAL_PROVIDERS` doc comment
(`domain.ts:177`), keeping the two context adapters adjacent:

```ts
/**
 * `@ctx/budgeting`'s read-only view of the ledger.
 *
 * Read-only in the strong sense: unlike the categorization port, there is no
 * column in `@ctx/ledger` that budgeting is the producer of.
 */
export function createBudgetingLedgerPort(database: LedgerDatabase): BudgetingLedgerPort {
  // `AccountType` is not on `@ctx/ledger`'s public surface — only
  // `schema/index.ts` exports it — so the summary's own field type is used.
  const roleOf = (type: AccountSummary['type']): 'CASH' | 'CREDIT' | 'OFF_BUDGET' => {
    if (type === 'credit') return 'CREDIT';
    if (type === 'depository' || type === 'manual') return 'CASH';
    // loan / investment / crypto: in net worth, not in the envelope budget.
    return 'OFF_BUDGET';
  };

  const accountsOf = (userId: string) =>
    // `includeClosed` on purpose: `listAccounts` defaults to `closed_at IS NULL`,
    // so without it a closed account can never be reported as `closed: true`,
    // and a card closed mid-period would silently vanish from identity II.
    listAccounts(database, { userId, includeClosed: true });

  return {
    async listForBudget(input) {
      // `LedgerTransaction` carries no account type, so the map is the only way
      // to answer 07 §1.3's "which asset actually moved".
      const accounts = await accountsOf(input.userId);
      const typeOf = new Map(accounts.map((account) => [account.id, account.type] as const));

      const page = await listTransactions(database, {
        userId: input.userId,
        filters: {
          ...(input.accountIds === undefined ? {} : { accountIds: input.accountIds }),
          dateFrom: input.dateFrom,
          // The budget grid is half-open and `listTransactions` applies `dateTo`
          // inclusively (`read.ts:167`), so the last day is stepped back one.
          dateTo: DateOnly.addDays(input.dateTo, -1),
          // A superseded cross-provider duplicate would otherwise be counted
          // twice in every envelope. `sumTransactions` (`read.ts:576`) sets the
          // same default for its own totals.
          includeDuplicates: false,
          // `excluded` and `transfers` are deliberately left unset. The port
          // contract is that both are *returned with their flags* and
          // `src/actuals.ts` decides — one rule in one place, and the counts of
          // what was dropped stay observable.
        },
        cursor: input.cursor ?? null,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });

      return {
        items: page.items.map((row) => ({
          id: row.id,
          accountId: row.accountId,
          budgetDate: row.effective.date,
          amount: row.effective.amount,
          categoryId: row.effective.categoryId,
          funding: typeOf.get(row.accountId) === 'credit' ? 'CREDIT' : 'CASH',
          transferLinkId: row.transferLinkId,
          isTransfer: row.isTransfer,
          refundOfId: row.refundOfId,
          excluded: row.effective.excluded,
        })),
        nextCursor: page.nextCursor,
      };
    },

    async listBudgetAccounts(input) {
      const accounts = await accountsOf(input.userId);
      return accounts.map((account) => ({
        id: account.id,
        type: account.type,
        role: roleOf(account.type),
        // 07 §1.4 rule 3's `working_balance`, approximated — see the note below.
        workingBalance: account.balance?.current ?? null,
        closed: account.closedAt !== null,
      }));
    },
  };
}
```

### `apps/api/src/modules.ts` — one registration

Add to the imports:

```ts
import { BUDGETING_EVENTS, createBudgetingConsumer, type BudgetingDatabase } from '@ctx/budgeting';
```

widen the shared handle in `ModuleWiringOptions` (`modules.ts:53`):

```ts
  readonly database: ConnectionsDatabase & CategorizationDatabase & BudgetingDatabase;
```

extend the existing `./domain.ts` import to
`import { createBudgetingLedgerPort, createCategorizationLedgerPort } from './domain.ts';`,
and append to the array returned by `appModules` (`modules.ts:105`):

```ts
    {
      flagKey: 'module.budgeting',
      events: BUDGETING_EVENTS,
      // No jobs and no schedules. A period is opened lazily by whoever first
      // needs it, and the roll is driven by the user or by the open-period path
      // — there is no nightly "close the month" job to get wrong in a timezone.
      consumers: [
        createBudgetingConsumer({
          database,
          port: createBudgetingLedgerPort(database),
        }),
      ],
    },
```

### What the adapter compiling is the check for

`test/harness.ts` cannot prove the real ledger satisfies the port: the boundary
lint denies `@ctx/budgeting` → `@ctx/ledger` unconditionally, so the suites run
against `createFakeLedger`. **The orchestrator compiling these lines is the
check**, and the field-by-field mapping above was verified against the current
`@ctx/ledger` source rather than assumed.

Every field the port needs exists on `LedgerTransaction`
(`packages/contexts/ledger/src/types.ts:137`) — including `transferLinkId`
(`:144`), `refundOfId` (`:145`) and `effective.excluded` (`:131`). Two mappings
are approximations and are named as such:

1. **`budgetDate ← effective.date`**, which is
   `COALESCE(authorized_date, posted_date)` (`0004_ledger.sql:272`) — the
   _default_ half of 07 §1.4 rule 1. The user-overridable `budget_date` does not
   exist. Open item 1.
2. **`workingBalance ← balance.current`.** `account_balances`
   (`0004_ledger.sql:144`) has `current_minor` / `available_minor` /
   `limit_minor` and **no working-versus-cleared split** — that distinction
   exists only in 07 §1.4 rule 3. `current` is the provider's latest current
   balance, which for Plaid-style providers already includes pending activity, so
   it is the honest approximation. Open item 6.

A third finding worth recording: **`effective.categoryId` resolves user overlay
then rule, and not the provider tier** — `resolveCategoryId(overlayOf(row),
ruleOf(row))` at `packages/contexts/ledger/src/db.ts:147`. The port's header
comment describes it as "user overlay, then rule, then provider", which
overstates it. Open item 7.

---

## 11. Verification

```
$ pnpm exec tsc -p tsconfig.json --noEmit
# 19 errors at HEAD → 4, none in packages/contexts/budgeting or packages/db

$ pnpm exec eslint packages/contexts/budgeting packages/db
# clean

$ node scripts/check-schema-ownership.ts
schema-ownership: ok — 95 table(s) claimed across 14 package(s), 53 defined.

$ pnpm exec vitest run --project db
Test Files  1 passed (1)
     Tests  10 passed (10)

$ DATABASE_URL=… pnpm exec vitest run --project budgeting --project budgeting-db
Test Files  5 passed (5)
     Tests  25 passed (25)
```

### The plan's exit tests, by name

| File                               | Test                                                                          | Status               |
| ---------------------------------- | ----------------------------------------------------------------------------- | -------------------- |
| `src/envelope.test.ts`             | `available = carryover + assigned + activity for every policy`                | ✓ (16 tests in file) |
| `test/db/rta-identity.test.ts`     | `Σ available + RTA + future assignments equals Σ on-budget balances`          | ✓                    |
| `test/db/rta-identity.test.ts`     | `conservation: Σ rolloverOut(n) = Σ rolloverIn(n+1)` (`fast-check`, 500 runs) | ✓                    |
| `test/db/period-roll-dst.test.ts`  | `a month closes and rolls over across a DST boundary in the user zone`        | ✓                    |
| `test/db/period-roll-dst.test.ts`  | `…across a non-calendar biweekly grid that does not tile months`              | ✓                    |
| `test/db/actuals-consumer.test.ts` | `a paired transfer contributes zero activity`                                 | ✓                    |
| `test/db/actuals-consumer.test.ts` | `a netted refund reduces activity by exactly the refund`                      | ✓                    |
| `test/db/actuals-consumer.test.ts` | `a late transaction dirties only the periods from its own forward`            | ✓                    |
| `test/db/credit-overspend.test.ts` | `credit overspend funds CCP only up to available`                             | ✓                    |

`packages/db/test/migrate.test.ts` lists the six budgeting tables in alphabetical
order with the per-migration attribution comment, alongside the concurrent
recurring agent's `0010` entries.

---

## 12. Open items

1. **`budget_date` does not exist in `@ctx/ledger`.** 07 §1.4 wants three dates,
   the third user-overridable and used for "all budget period assignment".
   `transactions` has no such column and `OverlayPatch`
   (`packages/contexts/ledger/src/overlay.ts`) has no field for one. The port
   declares `budgetDate` as the concept and the adapter maps it to the ledger's
   resolved `effective.date`, which already implements the _default_ half of rule
   1 (authorized, falling back to posted). **What is missing is only the user's
   ability to override it.** Reported rather than worked around: adding a column
   to another context's table from here is the exact thing schema ownership
   exists to prevent.
2. **Identity II assumes the period chain was established by rolls.** Carryover —
   including `carryover_unfunded_debt_minor` — is written by `rollPeriod`. A
   period opened ad hoc _ahead_ of its predecessors (which `openPeriod` will do,
   since the consumer opens a period when a transaction lands in one nobody has
   opened) starts with zero carryover, so recomputing it compares a _cumulative_
   card balance against a _single_ period's CCP and throws
   `budgeting.card_identity_violation`. Observed while measuring §6. It is
   correct behaviour for an incomplete chain — the budget genuinely does not add
   up — but it means **a backfill must roll the chain forward rather than open
   periods out of order**, and that is a constraint the orchestrator and WP 2.9
   need to know about. No production path does this today because `rollPeriod` is
   the only thing that creates a successor.
3. **`openPeriod` reports `lineCount: 0`** in `BudgetPeriodOpened`. CCP lines are
   created lazily on the first recompute (which has the account list) rather than
   at open time (which does not), so the count in the event is always zero.
   Harmless today — no consumer reads it — but it is a field that does not mean
   what it says.
4. **Refunds whose original lies outside the period window** stay in the
   uncategorised envelope. `computeActuals` nets a refund into the _purchase's_
   envelope via `categoryOfPurchase`, which the recompute populates only from
   rows inside the window. The dirty cascade repairs it once the purchase is
   categorised; a cross-period lookup would repair it sooner.
5. **`@core/seed` has no budget fixtures yet**, so the 13-period identity run is
   on the suite's own household rather than on the 50k-transaction seed. WP 2.12
   owns extending the seed generator with budget periods and assignments; the
   identity assertions are written against read models and will transfer without
   change.
6. **There is no `working_balance` / `cleared_balance` split in `@ctx/ledger`.**
   `account_balances` carries `current_minor`, `available_minor` and
   `limit_minor` only. 07 §1.4 rule 3 wants RTA computed on a balance that
   includes pending activity; `balance.current` is the provider's latest current
   figure, which for Plaid-style providers already does. The adapter maps to it
   and this is recorded as an approximation, not an implementation of rule 3. If
   a provider is ever added whose `current` excludes pending, RTA will be wrong
   by the pending float and nothing will say so — the cheapest guard would be a
   `cleared_minor` column on `account_balances`, which is `@ctx/ledger`'s to add.
7. **`effective.categoryId` is user-overlay-then-rule, not three tiers.**
   `packages/contexts/ledger/src/db.ts:147` resolves
   `resolveCategoryId(overlayOf(row), ruleOf(row))`; the provider tier is not
   part of it. `src/ledger-port.ts`'s header comment says "user overlay, then
   rule, then provider", which overstates what the adapter will actually deliver.
   The consequence for budgeting is that a transaction categorised **only** by
   the provider lands in the uncategorised envelope rather than in its category.
   Whether that is right is a categorization question, not a budgeting one —
   flagged for WP 2.5/2.6 rather than papered over here. The comment in
   `ledger-port.ts` should be corrected when the adapter lands.
