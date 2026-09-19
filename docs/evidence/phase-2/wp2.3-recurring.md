<!-- SPDX-License-Identifier: MIT -->

# WP 2.3 — Recurring persistence, lifecycle and forecast

Scope: `@ctx/recurring` `src/{store,service,consumer,read,events,ledger-port,index}.ts`,
`schema/**`, migration `packages/db/migrations/0010_recurring.sql`, and
`test/db/**`. The candidate pipeline with human confirmation, the permanent
`merchantKey → NOT_RECURRING` override, the upcoming calendar, the 30-day
forward cash flow with an uncertainty band, safe-to-spend, and a consumer that
re-runs WP 2.2's pure engine for touched payees only, idempotently.

Repo `/home/chris/Projects/PersonalFi`, branch `main`, tree at `aa6dbc1` plus
this work package. Node v26.8.1, pnpm, vitest 5, Postgres on `127.0.0.1:5433`.
Every number below came from a command run against this tree; the seeded runs
use `@core/seed` with seed `20260615`, `startMonth 2025-01-01`, `monthCount 24`,
zone `America/New_York`.

**WP 2.2 is unchanged.** No engine file was edited. `service.ts` and `read.ts`
import `detectRecurring`, `specOf`/`slotOf`/`periodDaysOf`,
`AUTO_CONFIRM_CONFIDENCE`/`CANDIDATE_CONFIDENCE` and `RECURRING_TYPES` as they
are. No engine diffs are needed.

---

## Summary

| Deliverable                                                 | Where                                       |
| ----------------------------------------------------------- | ------------------------------------------- |
| Five tables, constraints, indexes                           | `packages/db/migrations/0010_recurring.sql` |
| Query surface for those tables                              | `schema/{series,candidates,metadata}.ts`    |
| Rows in, rows out; no policy                                | `src/store.ts`                              |
| Policy: authority, transitions, events                      | `src/service.ts`                            |
| Read-only port over `@ctx/ledger` (no write method at all)  | `src/ledger-port.ts`                        |
| Calendar, 30-day cash flow with band, safe-to-spend         | `src/read.ts`                               |
| Scoped, idempotent reaction to ledger/categorization events | `src/consumer.ts`                           |
| Five events, edge-triggered                                 | `src/events.ts`                             |
| The pin and the veto                                        | `test/db/lifecycle.test.ts`                 |
| D25 guard, sabotage-tested                                  | `test/db/no-merchant-creation.test.ts`      |
| Forecast against the generator's ground truth               | `test/db/forecast.test.ts`                  |
| Replay safety on whole rows                                 | `test/db/idempotence.test.ts`               |

### Test results

```
$ DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev \
  pnpm exec vitest run --project recurring --project recurring-db --project db

 Test Files  11 passed (11)
      Tests  58 passed (58)
```

`recurring-db` is 4 files / 12 tests; the four names the dispatch plan fixes are
all present verbatim.

---

## 1. Tables

Five, all claimed by `@ctx/recurring` in `OWNERSHIP.md`, all listed
alphabetically in `packages/db/test/migrate.test.ts`, none carrying a foreign
key into another context's tables.

| Table                   | What one row is                                                       | Natural key                              |
| ----------------------- | --------------------------------------------------------------------- | ---------------------------------------- |
| `recurring_series`      | One detected stream, plus our relationship with it                    | `(user_id, stream_key)`                  |
| `recurring_occurrences` | One matched hit on a stream's schedule                                | `(user_id, transaction_id)`              |
| `recurring_candidates`  | One question asked of the user, and their answer — including the veto | `(user_id, stream_key)`                  |
| `subscription_metadata` | What we know about a series' payee, read back into the next pass      | `(series_id)`                            |
| `price_change_events`   | One two-sided changepoint (07 §2.6)                                   | `(series_id, effective_date, direction)` |

The naming and the split are the previous agent's and they are kept: the five
names match the dispatch plan exactly, `state` (our relationship: `CANDIDATE` /
`ACTIVE` / `ARCHIVED`) is correctly separated from `status` (the stream's own
dormancy ladder), and the occurrences key is the engine's partition property
stated in the schema — every usable transaction ends in exactly one stream.
Nothing needed renaming.

Two constraints do real work and are relied on by name below:

```sql
CONSTRAINT recurring_series_confirmed_not_archived CHECK (
  user_confirmed = false OR state <> 'ARCHIVED'
),
CONSTRAINT recurring_candidates_override_on_reject CHECK (
  (override IS NULL AND override_scope IS NULL)
  OR (state = 'REJECTED' AND override = 'NOT_RECURRING' AND override_scope IS NOT NULL)
)
```

The first makes "a detection pass archived something the user confirmed"
unrepresentable rather than merely discouraged. The second makes "rejected" and
"suppressed" unable to drift apart.

`merchant_id` is `UUID NOT NULL` with **no** `REFERENCES merchants (id)`. That
is decision D25, not an oversight: a foreign key would be a write-shaped
relationship with a table this context may not write to, and §3 asserts the
outcome the foreign key would have been standing in for.

---

## 2. The state machine

```mermaid
stateDiagram-v2
    [*] --> Undetected

    Undetected --> Candidate: detected, 0.55 <= confidence < 0.80<br/>CandidateProposed (once)
    Undetected --> Active: detected, confidence >= 0.80<br/>SeriesConfirmed(source=auto)

    Candidate --> Pinned: user confirms<br/>SeriesConfirmed(source=user)
    Candidate --> Rejected: user rejects<br/>override NOT_RECURRING
    Candidate --> Active: later pass clears 0.80<br/>SeriesConfirmed(source=auto)
    Candidate --> Archived: detector withdraws it

    Active --> Pinned: user confirms<br/>SeriesConfirmed(source=user)
    Active --> Rejected: user rejects<br/>override NOT_RECURRING
    Active --> Archived: detector withdraws it
    Active --> Merged: user merges into a survivor<br/>SeriesConfirmed(source=merge)

    Pinned --> Pinned: every future detection pass<br/>(state and user_confirmed never lowered)
    Pinned --> Rejected: user changes their mind<br/>(pin withdrawn, then archived)

    Merged --> [*]
    Archived --> Active: detector proposes it again
    Rejected --> [*]: terminal — the payee is never read again

    note right of Pinned
      user_confirmed = true.
      The archive sweep skips it,
      upsertSeries refuses to lower it,
      and the schema refuses
      (confirmed AND archived).
    end note

    note right of Rejected
      recurring_candidates keeps the row
      forever. loadOverrides() reads it
      BEFORE any transaction is fetched,
      so the merchant's rows never reach
      the engine at all.
    end note
```

Orthogonal to `state` is the stream's own `status` — 07 §2.8's ladder,
`EARLY_DETECTION → ACTIVE → AT_RISK → LIKELY_CANCELED → CANCELED` (plus
`MIGRATED`) — which the engine computes and `SeriesLapsed` announces **on the
transition only**, never on an insert. A stream met for the first time that
already looks dead was never alive as far as this system is concerned, and "you
may have cancelled X" about something never previously mentioned is noise.

---

## 3. Merchants unchanged (D25), with the sabotage

Decision D25: a `merchants` row means "a payee was involved", `@ctx/ledger`
decides it behind a named gate, and the answer is a `merchantId`. Three layers
keep detection out:

1. **No vocabulary** — the engine's `RecurringInput` has a `merchantId` and no
   descriptor (WP 2.2's `no-merchant-writes.test.ts` runs a pass behind a
   `Proxy` that throws on any key outside the contract).
2. **No capability** — `LedgerPort` has _no write method at all_. Compare
   `@ctx/categorization`'s port, which has one (`writeRuleCategory`). A port
   with a write is a port somebody can be tempted to widen.
3. **No permission** — `scripts/check-schema-ownership.ts` refuses any non-test
   file in this package that names `merchants` in SQL.

### The proof

`test/db/no-merchant-creation.test.ts` → `'a full detection pass leaves
merchants row count and ids unchanged'`. 32 merchants are inserted by raw SQL in
the harness (a populated table — "zero before, zero after" would prove nothing),
then 741 seed rows go through the **real consumer**.

| Measurement                            | Before                                                                                                                 | After                  |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `SELECT count(*) FROM merchants`       | 32                                                                                                                     | 32                     |
| `SELECT id FROM merchants ORDER BY id` | identical, element by element                                                                                          | ✓                      |
| first three ids                        | `08f50eb0-7a76-4fc8-891d-e4659572bc18`, `0c9d9445-774f-46f5-b836-a3cc1a7189bd`, `111603bc-f590-4f87-921c-c04023653589` | same three, same order |

The ids matter as much as the count: a count-only check passes a pipeline that
deletes one row and invents another, which is the failure hardest to see.

The same pass is asserted to have done real work — 21 series, 218 occurrences —
so "unchanged" is not satisfied by a consumer that threw or returned early. A
second test closes the other direction: every `recurring_series.merchant_id`
was already in `merchants`, which a count-and-ids check cannot see and which the
deliberately absent foreign key would otherwise hide.

### Sabotage

A raw-SQL merchant insert was added to `src/consumer.ts`, immediately before
`runDetection`:

```ts
await dependencies.database.execute(sql`
  INSERT INTO merchants (id, user_id, normalized_key, display_name)
  VALUES (${newId()}::uuid, ${event.userId}::uuid, 'sabotage'::text, 'Sabotage'::text)
`);
```

Both halves of the assertion went red, independently, and so did the ownership
check:

```
AssertionError: row count unchanged: expected 33 to be 32 // Object.is equality

# with the count assertion temporarily disabled, to show the ids half also fires:
AssertionError: and the ids themselves, not merely how many:
  expected [ …(33) ] to deeply equal [ …(32) ]

$ node scripts/check-schema-ownership.ts
schema-ownership: 1 problem(s)
  packages/contexts/recurring/src/consumer.ts
    raw SQL references 'merchants', which is owned by @ctx/ledger.
    Go through that context's reader or consume its events instead.
```

The sabotage was reverted; `check-schema-ownership.ts` is back to
`ok — 95 table(s) claimed across 14 package(s), 53 defined.` and the suite is
green.

---

## 4. What a rejection permanently changes

`rejectCandidate` / `rejectSeries`, in one transaction:

1. **A decision row.** The `recurring_candidates` row reaches `REJECTED` and
   carries `override = 'NOT_RECURRING'` with a scope. If the series was
   auto-confirmed and therefore never queued a question, `recordRejection`
   _creates_ the row — the override lives on this table, so the alternative is
   dropping the rejection silently. Nothing is deleted: `decided_reason` and the
   frozen `proposed_*` columns are what the user was shown when they said no,
   which is the only way to answer "why is this not in my subscriptions?" a year
   later.
2. **The series stops existing for every reader.** `unpinAndArchiveSeries`
   clears `user_confirmed` and sets `ARCHIVED` in one statement — the schema
   refuses the two together — and nulls the next-due triple, so no calendar, no
   cash-flow number and no safe-to-spend figure includes it.
3. **The payee is never read again.** This is the load-bearing one.
   `loadOverrides` is the **first** query a detection pass makes, before one
   transaction is fetched:

   ```
   loadOverrides  →  scope minus rejected merchants  →  collectForRecurring
                  →  drop rows whose merchantId is overridden  →  detectRecurring
   ```

   Filtering the engine's _output_ would work until the second caller forgot to.
   Filtering its _input_ makes the property structural.

Scope: `MERCHANT` is the default and is the dispatch plan's
`merchantKey → NOT_RECURRING`. `STREAM` exists because one payee can host two
genuinely different streams — 07 §2.12's `ANNUAL_TO_MONTHLY` — and a user who
rejects one plan should not be silenced about the other forever. Both are
asserted.

Measured (`test/db/lifecycle.test.ts` → `'a rejected merchant never returns as a
candidate'`), with two n=2 streams at two payees, one rejected:

| After the rejection                              | Value                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| Transactions reaching the engine on re-run 1 & 2 | 2 (the innocent payee's only; was 4)                               |
| `candidatesProposed` on re-runs                  | 0                                                                  |
| Open queue (`listCandidates`)                    | `[MERCHANT_INNOCENT]`                                              |
| Candidate row for the rejected payee             | `REJECTED` / `NOT_RECURRING` / `MERCHANT`                          |
| Series row for the rejected payee                | `ARCHIVED`                                                         |
| A scoped pass over the rejected payee            | `merchantsSkippedByOverride: 1`, `merchantsScoped: 0`, `inputs: 0` |
| `recurring_candidates` rows after three re-runs  | 2 (a rejection settles history, it does not accumulate it)         |

And the pin, from the same file (`'a confirmed series survives a re-run that
would have rejected it'`): two identical six-occurrence streams, one confirmed
by the user, then a pass where the ledger has nothing to say about either.
Confirmed → still `ACTIVE`, `user_confirmed = true`, `archived_at IS NULL`.
Unconfirmed control → `ARCHIVED`. The control is what proves the sweep actually
ran, so the first assertion is about the pin and not about a pass that did
nothing.

---

## 5. Forecast accuracy against the seed's ground truth

Every other test of a projection is circular: predict from the history, check
against the history. `@core/seed` breaks the circle — it generates a household
from a fixed PRNG for a window that extends _past_ the date the detector is told
is "today", and it labels the series it generated
(`SeedLabels.recurringSeries[].transactionIds`).

Protocol: the detector sees 741 rows up to `TODAY = 2026-06-14` (which is
`todayIn(fixedClock('2026-06-15T02:00Z'), 'America/New_York')` — 02:00 UTC is
the _previous_ day in that zone, and the fixture is shaped to catch a UTC-date
assumption rather than to hide one). The projection is computed for the next 30
days. Ground truth is the charges the generator will actually produce in those
30 days, restricted to transactions it labelled as belonging to a recurring
series.

That restriction is the point, not a convenience: a forecast claims "this payee
will bill you again"; it has never claimed to know when somebody will next buy
groceries. Several seed merchants host both a labelled monthly series _and_
discretionary purchases, so grading on merchant alone would mark the forecast
down for shopping trips it never predicted.

### Result

| Measurement                                             | Value         |
| ------------------------------------------------------- | ------------- |
| Scheduled charges the generator will produce            | 10            |
| Of those, inside the projected date **and** amount band | **10 (100%)** |
| Charges projected in the window                         | 12            |
| Distinct payees projected                               | 11            |
| Median next-due date window (± days)                    | **1**         |
| Series detected / occurrences persisted                 | 21 / 218      |

The pass state, for context: 13 `ACTIVE` (auto-confirmed above 0.80), 8
`CANDIDATE` (asked), typed 9 `SUBSCRIPTION` / 11 `RECURRING_BILL` /
1 `RECURRING_INCOME`, 1 price change and 1 duplicate-service group found, 23
events appended.

A band can contain anything by being wide enough, so two counter-assertions run
beside the containment one: the **median next-due window is 1 day** (not a
fortnight), and a `FIXED` stream's amount band is a single number, not a range.
Samples:

| Expected date | Window                  | Amount band         | Type / cadence                    |
| ------------- | ----------------------- | ------------------- | --------------------------------- |
| 2026-06-17    | 2026-06-16 … 2026-06-18 | 3100.00 … 3100.00   | RECURRING_INCOME BIWEEKLY         |
| 2026-06-18    | 2026-06-17 … 2026-06-19 | −79.99 … −79.99     | SUBSCRIPTION MONTHLY              |
| 2026-07-01    | 2026-06-30 … 2026-07-02 | −2200.00 … −2200.00 | RECURRING_BILL MONTHLY            |
| 2026-06-15    | 2026-06-14 … 2026-06-16 | −280.50 … −104.50   | RECURRING_BILL MONTHLY (variable) |

30-day forward cash flow for the same window: outflow −2778.56, inflow 6200.00,
net 3421.44, band [3365.95, 3558.54]. Safe-to-spend against 2500.00 of cash:
committed −2778.56 (worst case −2834.05), so **−334.05** — correctly negative,
because rent is due inside the window and the cash is not there yet. Expected
income of 6200.00 is reported and **excluded** from `safe` by default: counting
a paycheque the employer has not sent is how an app tells somebody they can
afford something they cannot.

### Two bugs this test found, and what changed

- **A `VARIABLE` stream's band was a hard floor.** The empirical
  `[observed_min, observed_max]` excluded a real future charge $11 _below_ a
  two-year observed minimum. The observed minimum is itself only a sample — a
  mild winter really does produce a smaller gas bill than anything on record —
  so `bandOf` now widens the observed extremes by the stream's MAD for
  non-`FIXED` amount models. A `FIXED` stream is untouched and still forecasts an
  exact price.
- **JSONB key order made every pass a write.** `merge_proposal` was written as
  `{reason, fromAccountId, toAccountId, …}` and read back in Postgres's
  normalised key order, so a raw `JSON.stringify` comparison said "changed" on
  every single pass. Caught by the idempotence suite; `store.ts` now compares
  canonicalised JSON. Without it, every replay rewrote every series.

---

## 6. The `LedgerPort`, and the exact composition-root lines

### Shape

`@ctx/recurring` never imports `@ctx/ledger` — the boundary lint denies it
unconditionally, tests included. It reacts to events and _reads_ through a port
`apps/api/src/domain.ts` adapts.

```ts
/** Everything detection is allowed to see about a transaction. */
export interface RecurringTransaction {
  readonly id: string;
  readonly accountId: string;
  readonly merchantId: string | null; // D25 identity, or null when the gate refused it
  readonly amount: Money; // negative = outflow
  readonly date: DateOnly; // the ledger's budget date
  readonly pending: boolean;
  readonly isTransfer: boolean;
}

export interface LedgerPort {
  listForRecurring(input: ListForRecurringInput): Promise<RecurringTransactionPage>;
  merchantsOf(input: {
    readonly userId: string;
    readonly transactionIds: readonly string[];
  }): Promise<readonly string[]>;
}
```

`ListForRecurringInput` is `{ userId, merchantIds?, accountIds?, dateFrom?,
dateTo?, cursor?, limit? }`; the page is `{ items, nextCursor }`.

Two properties are deliberate. **There is no write method** — not "no write we
use", none to call, which is the mechanism behind D25 rather than a convention.
And **no field carries payee text**: no descriptor, no payee, no merchant name.
WP 2.2's `no-merchant-writes.test.ts` already fails on any engine read outside
the contract, so a field added here that carried descriptor text would break a
test that exists today.

`merchantsOf` exists so the consumer can scope a pass. An event names
transactions; a stream is every transaction with one payee, so "re-detect the
transactions in this page" is meaningless and "re-detect everything" is a
full-history scan per sync page.

### `apps/api/src/platform.ts` — add to `MODULE_FLAGS`

```ts
  Object.freeze({
    key: 'module.recurring',
    defaultEnabled: false,
    owner: 'recurring',
    removeWhen: 'never — this is the kill switch for subscription detection',
  }),
```

`false`, per the existing comment on that constant ("the half-finished contexts
Phase 2 will add, which ship `false`"): the REST surface is WP 2.5's and the
detector should not start writing series before there is a screen to confirm
them on.

### `apps/api/src/domain.ts` — the adapter

```ts
import { listForCategorization, listTransactions, type LedgerDatabase } from '@ctx/ledger';
import type { LedgerPort as RecurringLedgerPort } from '@ctx/recurring';

export function createRecurringLedgerPort(database: LedgerDatabase): RecurringLedgerPort {
  return {
    async listForRecurring(input) {
      const page = await listTransactions(database, {
        userId: input.userId,
        filters: {
          ...(input.merchantIds === undefined ? {} : { merchantIds: input.merchantIds }),
          ...(input.accountIds === undefined ? {} : { accountIds: input.accountIds }),
          ...(input.dateFrom === undefined ? {} : { dateFrom: input.dateFrom }),
          ...(input.dateTo === undefined ? {} : { dateTo: input.dateTo }),
          // A tombstoned row is not an occurrence. A row the user excluded is
          // not spending, so it is not a stream either. Transfers come through
          // and the engine drops them itself, because `isTransfer` is one of
          // the facts it reports having used.
          includeRemoved: false,
          excluded: false,
        },
        cursor: input.cursor ?? null,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
      return {
        items: page.items.map((row) => ({
          id: row.id,
          accountId: row.accountId,
          merchantId: row.merchantId,
          amount: row.effective.amount,
          date: row.effective.date,
          pending: row.effective.pending,
          isTransfer: row.isTransfer,
        })),
        nextCursor: page.nextCursor,
      };
    },

    async merchantsOf(input) {
      // `listForCategorization` is the ledger reader that filters on
      // transaction ids (`listTransactions`'s `TransactionFilters` has no such
      // filter). Only `merchantId` is read from the rows it returns; the payee
      // text it also carries never crosses into `@ctx/recurring`.
      const merchants = new Set<string>();
      let cursor: string | null = null;
      do {
        const page = await listForCategorization(database, {
          userId: input.userId,
          filters: { transactionIds: input.transactionIds },
          cursor,
          limit: 500,
        });
        for (const row of page.items) {
          if (row.merchantId !== null) merchants.add(row.merchantId);
        }
        cursor = page.nextCursor;
      } while (cursor !== null);
      return [...merchants].sort();
    },
  };
}
```

### `apps/api/src/modules.ts` — the registration

```ts
import { RECURRING_EVENTS, createRecurringConsumer, type RecurringDatabase } from '@ctx/recurring';
import { createRecurringLedgerPort } from './domain.ts';
```

`ModuleWiringOptions.database` widens to
`ConnectionsDatabase & CategorizationDatabase & RecurringDatabase` (all three
are `@core/db`'s `Database`; this is one pool, not three), and the returned
array gains:

```ts
    {
      flagKey: 'module.recurring',
      events: RECURRING_EVENTS,
      // Consumes ledger.TransactionsUpserted,
      // ledger.TransactionSupersededByPosted and
      // categorization.AssignmentsChanged. Scoped to the payees the event
      // touched: a stream is every transaction with one merchant, so the unit
      // of work is a merchant and never a page of transactions.
      consumers: [
        createRecurringConsumer({
          database,
          port: createRecurringLedgerPort(database),
          options: { timeZone: options.timezone },
        }),
      ],
    },
```

The module table in that file's header gains a row:

```
 * | `module.recurring`      | 5      | `recurring.detection@v1`           | —                                | —        |
```

**This work package does not edit `apps/api`.** The lines above are for the
orchestrator; compiling them is the check that `@ctx/ledger`'s signatures still
satisfy `LedgerPort`, which these suites deliberately do not prove (they run
against `inMemoryLedgerPort`, so a failure means _this_ context broke and not
the ledger's query planner).

---

## 7. Events

All five are emitted from a **transition** computed against what was already in
the database, never from "the detector mentioned it again". That is what makes
`'replaying the consumer twice produces identical rows'` assert a `domain_events`
count as well as rows.

| Event                                | Emitted when                                                                |
| ------------------------------------ | --------------------------------------------------------------------------- |
| `recurring.CandidateProposed`        | a `recurring_candidates` row **inserted** (never re-asked)                  |
| `recurring.SeriesConfirmed`          | a series entered `ACTIVE` (`auto`), or a human said so (`user`, `merge`)    |
| `recurring.SeriesLapsed`             | `status` **moved** onto a lower rung; never on an insert                    |
| `recurring.PriceChangeDetected`      | a `price_change_events` row inserted, or a provisional one became confirmed |
| `recurring.DuplicateServiceDetected` | the **membership** of a taxonomy group changed                              |

Payload discipline is the house rule — ids and counts, never rows — with one
deliberate exception: `PriceChangeDetected` and `DuplicateServiceDetected` carry
`annualImpactMinor` (minor units, as a string) because `@ctx/notifications`
decides whether to wake somebody by comparing that figure against a threshold,
and a rule that had to re-read the series to learn whether $0.30 or $180 was at
stake would re-read on every event.

---

## 8. Idempotence

`test/db/idempotence.test.ts` → `'replaying the consumer twice produces identical
rows'`. The same envelope (same id, same payload — a redelivery, not a second
sync) is handed to the consumer three times. After each, **every column of every
row** of all five tables is compared, plus the `domain_events` count.

Timestamps are included, and they are the interesting part: `updated_at` and
`last_detected_at` would be bumped by a naive `ON CONFLICT DO UPDATE` and are
invisible to any assertion that skips them. `store.ts` reads before it writes
and skips when nothing differs, precisely so the comparison can be total — a
column added later is covered the day it is added rather than the day somebody
remembers to add it here.

A second case re-runs the service directly on a **later clock within the same
local day**: `seriesInserted 0`, `seriesChanged 0`, `candidatesProposed 0`,
`eventsAppended 0`, all five tables byte-identical. Moving the clock must not by
itself make an unchanged pass look like a change.

This suite is what found the JSONB key-order bug in §5.

---

## 9. Concurrency

`runDetection` takes `pg_advisory_xact_lock` on class `0x52454355` (`'RECU'`),
keyed by user, for the whole transaction. Two passes for one user — the sync
consumer and a person pressing "re-detect" — would otherwise interleave their
read-then-write upserts and both try to insert the same `stream_key`, which
`recurring_series_user_key_uniq` would reject with a 23505 rather than merge.
Blocking rather than `try_`: a pass that gave up would silently skip work for a
_different_ merchant scope, and the failure would present as "detection
sometimes does not run".

---

## 10. Carried / open

- **`module.recurring` ships disabled.** WP 2.5 turns it on with the REST
  surface; until then the consumer contributes nothing at runtime.
- **The composition root is unwired.** §6 gives the exact lines; this package
  does not edit `apps/api`.
- **The port adapter is unproven against the real ledger.** Deliberate — see
  §6. The check is the orchestrator compiling those lines.
- **Free-trial conversion (07 §2.7)** still needs the seeded standard-price
  table that does not exist; `subscription_metadata.standard_price_*` is the
  column it will land in. WP 2.7.
- **`price_change_events.notified_at`** is written by `@ctx/notifications`
  (WP 2.4), never by this context.
- **Open question 5 (recurring gold set)** is unchanged by this work package.
  The default stands: the synthetic and adversarial corpora are the CI gate and
  the real hand-labeled set is gitignored and run locally. §5's forecast proof
  is against the seed generator's ground truth, which is a different and weaker
  claim than a real 24-month gold set, and is recorded as such.
