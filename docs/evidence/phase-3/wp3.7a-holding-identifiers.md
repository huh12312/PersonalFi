# WP 3.7a — a holding carries every name its security has

_The port defect WP 3.7 found in its own wiring test, and the three items
[`wp3.7-plaid-investments.md`](./wp3.7-plaid-investments.md) §11 carried: a
holding fact that names its security once, a `securities.type` that degrades to
`other` on the way through, and a `SecurityResolutionFailed` a retry can
double._

Scope: `@connector/port`'s `ProviderHoldingFact`, the adapters that emit one,
`@ctx/connections`' staging of it, and `@ctx/investments`' resolution of it.
Nothing about routes, the snapshot builder or the orchestrator's legs.

---

## 1. The defect, in the words of the work package that found it

WP 3.7 §11 item 1:

> `ProviderSecurityFact.identifiers` carries every name a provider gave and
> `resolver.ts` says in as many words that it "can only [tier] if it sees the
> whole set". But `ProviderHoldingFact` carries a single `SecurityIdentifier`,
> and `map.ts`'s `holdingSecurityOf` picks the **strongest one** — the FIGI, for
> VTI — discarding the ISIN, the CUSIP and the MIC-qualified ticker that
> `securityIdentifiersOf` had already extracted two lines earlier.

Item 2 is the same field, costing a different column:

> With only an identifier and no provider `type`/`name`,
> `securityTypeOf(null, identity, null)` returns `other` for everything that is
> not a `chain_contract`.

Item 3 is unrelated to the shape and is fixed here because it is the same
function's:

> A retried lot-consumer delivery can append a duplicate
> `SecurityResolutionFailed`.

The shape defect is **cross-provider by construction**. Within one provider
nothing breaks: `asResolvable` folds the Plaid `security_id` in as a
`proprietary` identifier, so the second sync of the same position finds the row
the first one made. It breaks the moment two providers — or the same provider
through two paths — name one asset with two different strong names, which is
exactly the §5 exit criterion's shape ("ETH on Coinbase and in a wallet resolves
to one security") and the §5 risk table's "one asset, two securities" row.

---

## 2. The port shape, before and after

`packages/connectors/port/src/facts.ts`:

```diff
 export interface ProviderHoldingFact {
   readonly providerAccountId: string;
-  readonly security: SecurityIdentifier;
-  /** The provider's opaque id for the security. Evidence, never identity. */
-  readonly providerSecurityId: string;
+  readonly security: ProviderSecurityFact;
   readonly quantity: string;
   readonly costBasis: Money | null;
   readonly value: Money;
   readonly asOf: Date;
   readonly raw: unknown;
 }
```

`ProviderSecurityFact` is unchanged and already existed for exactly this job —
`identifiers` (every name, any order), `providerSecurityId`, `name`, `type`,
`subtype`, `currency`, `isCashEquivalent`, `closePrice`, `closePriceAsOf`, `raw`
and `fingerprint`.

Three choices worth stating, because each had a cheaper alternative:

1. **The whole fact, not `identifiers`.** Carrying just the set would have fixed
   item 1 and left item 2 open: `type` and `name` are what keep
   `securities.type` off `other`, and they are on the fact, not in the set.
2. **Replacing the field, not adding one.** A `security: SecurityIdentifier`
   plus an optional `securityFact?: ProviderSecurityFact` would have been a
   smaller diff and a permanent trap — two sources of truth, a reader that has
   to decide which to believe, and an adapter that can satisfy the type by
   filling the weaker one. One shape, no dual path.
3. **Dropping the top-level `providerSecurityId`.** It is on
   `ProviderSecurityFact` already. Keeping both copies would have made
   "which one does the staging key use" a real question with two defensible
   answers, which is how they drift apart.

`ProviderInvestmentTransactionFact.security` is **still a single
`SecurityIdentifier`** — see §7.

---

## 3. Reproduced, then fixed

The reproduction is `apps/api/test/db/phase3-wiring.test.ts`, and it is the same
fixtures WP 3.7 already ran:

- the **first** test in the file resolves `ticker/VTI@XNYS` through the real
  `securityResolverFor`, as provider `manual` (it needs a real `securities` row
  for a foreign key);
- the **Plaid leg** test then syncs the recorded Sandbox fixture, whose VTI
  security carries `figi/BBG000BDTF76`, `isin/US9229087690`, `cusip/922908769`
  **and** `ticker/VTI@XNYS`.

Two sightings of one asset by two providers. The new test asks whether they are
one row:

```sql
SELECT DISTINCT s.id, s.ticker, s.figi, s.isin, s.cusip, s.identity_kind, s.merged_into_id
  FROM securities s
  JOIN security_identifiers i ON i.security_id = s.id
 WHERE s.user_id = $1
   AND s.merged_into_id IS NULL
   AND upper(i.value) IN ('VTI', 'BBG000BDTF76', 'US9229087690', '922908769')
```

### Red — the pre-fix behaviour, restored as a sabotage

`holdingSecurityFactOf` was temporarily replaced with the old
`strongestIdentifier(...)` pick and a null `type`/`name`:

```
SABOTAGE-PROBE securities: [
  {
    "id": "01a0d1b7-3006-753b-8612-01f134b5ec80",
    "ticker": "VTI",
    "figi": null,
    "isin": null,
    "cusip": null,
    "identity_kind": "ticker",
    "merged_into_id": null
  },
  {
    "id": "01a0d1b7-3264-7246-a40c-7c2aa5ef082e",
    "ticker": null,
    "figi": "BBG000BDTF76",
    "isin": null,
    "cusip": null,
    "identity_kind": "figi",
    "merged_into_id": null
  }
]

 × a security seen as a ticker and later as a FIGI is one securities row
   AssertionError: the ticker sighting and the FIGI sighting are one security,
   not two: expected [ { …(7) }, { …(7) } ] to have a length of 1 but got 2

 × securities.type survives the holdings path
   AssertionError: the provider said etf and the row says etf:
   expected 'other' to be 'etf'
```

Two rows, neither knowing the other's name, and `type` stuck on `other`. Both
carried items, reproduced at once.

### Green — the same query, the fix in place

```
SABOTAGE-PROBE securities: [
  {
    "id": "01a0d1b8-0605-778d-b2df-530301fb6f9b",
    "ticker": "VTI",
    "figi": "BBG000BDTF76",
    "isin": "US9229087690",
    "cusip": "922908769",
    "identity_kind": "figi",
    "merged_into_id": null
  }
]
```

One row that knows all four names, `identity_kind` upgraded from `ticker` to
`figi` **in place** — same id, so every holding and lot that pointed at it still
does — and nothing merged (`SELECT count(*) … WHERE merged_into_id IS NOT NULL`
is `0`, asserted). The `merged_into_id IS NULL` predicate is in the query on
purpose: a merge is a legitimate way to end up with one surviving row, and
counting losers would make the test unable to tell "never split" from "split and
healed". Here it never split.

One existing assertion had to change, and the change is itself evidence. The WP
3.7 test asserted "the synced buy opened exactly one lot" with an unscoped count
over `cost_basis_lots` for that security. It now sees **two** — because the first
test's `manual` VTI lot, in a different account, is on the same security at last.
The assertion is now scoped to `t.provider = 'plaid'`, the same way the
`investment_transactions` assertion three lines above it already was.

---

## 4. Per-adapter conformance

The `holdings/` conformance check now asserts the **set**: a non-empty
`identifiers`, every kind in `SECURITY_IDENTIFIER_KINDS`, no empty values, a
`chain_contract` that names its chain, a non-blank `providerSecurityId`, and a
`fingerprint` that really is `securityFingerprintOf(identifiers)`.

| Adapter     | Declares `holdings` | Emits holding facts | Change                                                                                                                                                    | Conformance run by                                       |
| ----------- | ------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `plaid`     | yes                 | yes                 | `holdingSecurityFactOf` — the whole `securityFactOf(security)`, `proprietary` dead end when Plaid referenced a `security_id` it did not return            | `packages/connectors/plaid/test/conformance.test.ts`     |
| `coinbase`  | yes                 | yes                 | `security: securityFactOf(asset, price)` — the same function the balances path already used, so the two can no longer disagree about what ETH is          | `packages/connectors/coinbase/test/conformance.test.ts`  |
| `walletrpc` | yes                 | **no**              | none. `syncHoldings` returns `[]` for a zero balance and otherwise throws `DATA_UNAVAILABLE` (it has no price source yet), so it emits no fact to reshape | `packages/connectors/walletrpc/test/conformance.test.ts` |
| `manual`    | no                  | no                  | none — `syncHoldings` is not implemented                                                                                                                  | `packages/contexts/connections/test/conformance.test.ts` |
| `csv`       | no                  | no                  | none                                                                                                                                                      | —                                                        |

`walletrpc/test/one-security.test.ts` is **untouched and green**: it asserts over
`nativeSecurityIdentifierOf('ethereum')` and a transcription of
`NATIVE_ASSETS`, neither of which this WP goes near. ETH from a wallet and ETH
from Coinbase still canonicalise onto the same `NATIVE_ASSETS` row — and
Coinbase's side of that is now carried by `securityFactOf('ETH', …)`, whose
single `ticker/ETH` identifier is the same one the test names.

### What the check can and cannot catch

`packages/connectors/port/src/conformance.holdings.test.ts` sabotages the check
five ways and watches four of them fail: an empty identifier set, a blank
`providerSecurityId`, a chain contract with no chain, a floated quantity.

The fifth is the honest one, and it has its own test asserting that the check
**passes**: a truncated identifier set is undetectable. One FIGI is a legal set,
and `securityFingerprintOf` hashes the strongest identifier _alone_ — deliberately,
so two providers who agree on an ISIN fingerprint alike even when one is chattier
— which is precisely what makes it blind to a dropped name. So the defence here is
not the suite, it is the **shape**: there is no longer a field an adapter satisfies
by choosing. The per-adapter tests pin the set itself; `plaid/test/map.test.ts`
now asserts all four VTI identifiers in order, plus `type: 'etf'` and the display
name.

---

## 5. Staging, and the migration decision

**No migration change. Not 0018, not 0019.**

`git log origin/main -- packages/db/migrations/0018*` is empty, so editing 0018
would have been permitted. Nothing needed editing:

- `connection_sync_facts.fact` is `JSONB NOT NULL DEFAULT '{}'::jsonb`. The fact
  is stored as `{ security, raw }` before and after; what changed is the shape
  _inside_ the jsonb, which is not a DDL fact.
- `provider_security_id` stays a column, because it is half of the holding's
  natural key and an `ON CONFLICT` target cannot be a jsonb path. It is now read
  from `fact.security.providerSecurityId` instead of the fact's own field —
  same value, one source.
- The `connection_sync_facts_holding_is_a_position` CHECK is unaffected: it
  constrains columns, and every one of them still arrives.

There is a second reason not to touch the file even for its prose. Migrations
are **checksummed** — `packages/db/src/migrate.ts`'s `checksumOf` compares the
recorded sha256 against the file on every run and refuses a mismatch — so
editing a comment in 0018 would brick every dev database that has already
applied it, in exchange for nothing. The header comment in 0018 that says `fact`
carries "the `SecurityIdentifier` the adapter resolved" is therefore now one
sentence out of date; it is corrected here instead, and in the code comment at
the write site in `staging.ts`.

The round trip is safe without a reviver: every field of `ProviderSecurityFact`
is a string, a boolean, a null or an array of those. `closePriceAsOf` is a
`DateOnly`, which is a _branded string_, and `closePrice` is a decimal string
rather than a float, so nothing loses precision through Postgres.

One incidental saving: Plaid's holding `raw` was `{ holding, security }` and is
now `{ holding }`, because the `Security` travels verbatim as `security.raw`.
The staged row carried the provider's security payload twice; now it carries it
once.

---

## 6. The dedupe, and why it is where it is

**There is no outbox idempotency mechanism to reuse.** `appendEvent`
(`packages/platform/src/events/outbox.ts`) takes an `Executor` and an envelope;
its only option is `metrics`. The two dedupe mechanisms this codebase does have
are somebody else's and do not generalise — `notification_outbox.dedupe_key`
(migration 0011) is a notification's, and `ledger_dedup_keys` (migration 0004) is
the ledger's same-transaction-seen-twice table.

So the fix is **a check before the append, inside the same transaction**, in
`runFactsResolverFor` in `apps/api/src/domain.ts` — a `SecurityResolver` built
like `securityResolverFor`'s but with a deduping sink:

```sql
SELECT 1 FROM domain_events
 WHERE user_id = $1
   AND event_type = 'investments.SecurityResolutionFailed'
   AND payload->>'syncRunId' = $2
   AND payload->>'provider' = $3
   AND payload->>'providerSecurityId' IS NOT DISTINCT FROM $4
 LIMIT 1
```

The key needed a run in it, and the event did not carry one, so
`SecurityResolutionFailed` gains `syncRunId: z.uuid().nullable()` fed from a new
optional `ResolveContext.syncRunId`. That field pays for itself twice: the
resolver's own comment at the emit site already said "the thing a reader wants
from this event is _which sync produced it_", and before this the only answer was
a correlation id minted on the spot.

**Scoped to the run, deliberately.** The event's registry description says a
later sync that fails the same way must emit again — "the second failure is a
second observation and suppressing it would make a permanent gap look like a
transient one" — and a key without the run in it would have quietly turned that
into "report it once, ever". A retried delivery of the _same_ run is not a second
observation. That is the line, and the description is updated to state it.

The `SELECT` sees this transaction's own earlier appends as well as committed
ones, so it also collapses the case where one run stages two unresolvable
positions that are the same provider security in two accounts.

What was **not** done: WP 3.7 §11 suggested a per-context port factory in
`modules.ts` so the resolution joins the pump's transaction. That would trade a
duplicated log line for a lost `securities` row on every unrelated mid-derivation
failure, which is the worse half of the trade — securities are master data and
minting one is a statement about an asset, not about a run.

### Proved by sabotage

With the dedupe disabled (`if (already.rows.length > 0 && false) return;`):

```
 × a retried delivery appends one SecurityResolutionFailed
   AssertionError: a retried delivery is the same observation, not a second one:
   expected 2 to be 1
```

Restored, the test calls `factsForRun` on the same run three more times and the
count stays at `1`. The unresolvable position is real, not contrived: the Plaid
fixture's cash sweep (`sec-cash-0002`) carries no ticker, CUSIP, ISIN or FIGI, so
the only name is a `proprietary` dead end the resolver refuses as an identity.

---

## 7. `securities.type`, and the resolver rule it needed

Carrying `type` and `name` is necessary but was not sufficient. The resolver's
existing-row path patched identifiers and, when the new sighting outranked the
old, the identity — and nothing else. A row created from a bare
`ticker/VTI@XNYS` with no provider type held `type = 'other'` and would have held
it forever, even after Plaid's holdings leg arrived saying `etf`.

`descriptionUpgradeOf` in `resolver.ts` closes that, **one-directionally**:

- `name` is filled when the row has none. A provider that disagrees about the
  display name does not overwrite one we already have — otherwise the name
  becomes a function of whichever connector synced last.
- `type` moves off `other` and never back onto it. `other` is what the
  classifier answers when it was told nothing, so replacing it loses no
  information; replacing `etf` with `other` because a quieter provider mentioned
  the same security would.
- The classification columns are recomputed _with_ the type rather than left
  behind, because they are derived from it. The guard means this runs at most
  once per row.

Asserted by `'securities.type survives the holdings path'`: `type = 'etf'`,
`name = 'Vanguard Total Stock Market ETF'`, `asset_class <> 'UNCLASSIFIED'`.

### Carried

**`ProviderInvestmentTransactionFact.security` is still one
`SecurityIdentifier`.** The same argument applies to it, and it is out of this
WP's scope. It is not currently reachable as a defect in the wiring test, and
the reason is order-dependence rather than design: `resolveRunFacts` puts
holdings through `resolveAll` first, so by the time a transaction's lone FIGI is
tiered, the holdings pass has already attached that FIGI to the right row. A run
that produced investment transactions and **no** holdings for the same security
would split it exactly as holdings used to. The fix is the same one-field change
and belongs with whoever next owns `map.ts`'s transaction path.

---

## 8. Checks

| Check                                                                                                                                                                                                | Result                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `pnpm exec tsc -b --noEmit`                                                                                                                                                                          | clean                                                       |
| `pnpm exec vitest run --project connector-{port,plaid,coinbase,walletrpc,manual,csv} --project connections --project connections-db --project investments --project investments-db --project api-db` | 101 files, 1103 tests: **1099 passed, 4 skipped, 0 failed** |
| `pnpm exec eslint packages/connectors packages/contexts/connections packages/contexts/investments`                                                                                                   | clean                                                       |
| `pnpm run lint:schema-ownership`                                                                                                                                                                     | ok — 99 tables claimed across 14 packages, 79 defined       |
| `prettier --check` on every file this WP touched                                                                                                                                                     | all matched files use Prettier code style                   |

The 4 skips are pre-existing and unrelated (credential-gated live-provider
suites, `NO_DATABASE` guards). **No reds were attributed to WP 3.9** — the
`api-db` project was fully green on this run, including the route tests WP 3.9
landed in `e45fa1a` partway through this work. That commit deliberately left
`apps/api/src/domain.ts` and `apps/api/test/db/phase3-wiring.test.ts` out ("they
commit with the port fix that is editing them"), so both files are still
uncommitted and carry WP 3.7's `factsForRun` work plus this WP's on top.

New tests, all sabotage-verified:

| Test                                                                    | File                                                        | Red before      |
| ----------------------------------------------------------------------- | ----------------------------------------------------------- | --------------- |
| `a security seen as a ticker and later as a FIGI is one securities row` | `apps/api/test/db/phase3-wiring.test.ts`                    | 2 rows (§3)     |
| `securities.type survives the holdings path`                            | same                                                        | `'other'` (§3)  |
| `a retried delivery appends one SecurityResolutionFailed`               | same                                                        | 2 events (§6)   |
| 6 holdings-conformance cases (4 must-fail, 1 must-pass, 1 honest-limit) | `packages/connectors/port/src/conformance.holdings.test.ts` | n/a — new check |

Files touched:

- `packages/connectors/port/src/facts.ts`, `conformance.ts`,
  `conformance.holdings.test.ts` _(new)_
- `packages/connectors/plaid/src/map.ts`, `test/map.test.ts`,
  `test/connector.test.ts`
- `packages/connectors/coinbase/src/map.ts`, `test/map.test.ts`
- `packages/contexts/connections/src/staging.ts`
- `packages/contexts/investments/src/resolver.ts`, `src/events.ts`,
  `test/db/consumer.test.ts`
- `apps/api/src/domain.ts` (`createInvestmentSyncPort`, `resolveRunFacts`,
  `runFactsResolverFor` only)
- `apps/api/test/db/phase3-wiring.test.ts`
