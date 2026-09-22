# WP 3.1 — securities master, `SecurityResolver`, the `@connector/port` promotion

_Phase 3, Wave A. Written as the work landed, not reconstructed afterwards._

Plan of record: [`docs/plan/03-phase-3-dispatch.md`](../../plan/03-phase-3-dispatch.md) §3 "WP 3.1",
§4 (migration **0013** is this package's, assigned before dispatch and not negotiable in flight),
§5 (the gate standard). Research: 08 §1.3 #7 and §2.5, 01 §5.5 and §4.1, 04 §3.1–§3.2, 07 §4.3.
Decisions: **D3** (no float anywhere), **D8** (no cross-context foreign key), **D25** (a provider's
own identifier is evidence, never identity).

---

## 0. What was already on disk

This work package was started by an agent that was killed by a session limit mid-flight. The snapshot
commit `95d1c64` carried a finished `@connector/port` promotion and a finished Plaid type migration,
and nothing else: `packages/contexts/investments` held only its scaffold (`CONTEXT_ID`, an empty
`schema/index.ts`, an OWNERSHIP.md of claims) and `0013_securities.sql` did not exist.

`pnpm exec tsc -p tsconfig.json --noEmit` at that commit reported exactly two errors, both the same
dangling name left by the promotion:

```
packages/connectors/plaid/src/connector.ts(448,23): error TS2304: Cannot find name 'PlaidInvestmentTransactionFact'.
packages/connectors/plaid/src/connector.ts(458,18): error TS2304: Cannot find name 'PlaidInvestmentTransactionFact'.
```

Both are fixed by importing `ProviderInvestmentTransactionFact` from `@connector/port` — the type the
promotion moved — and the method's doc comment, which still said "Not a port method", now says what is
true: it _is_ an optional port method, and it deliberately does not have `syncTransactions`'s shape.

One stale test came with them. `packages/connectors/plaid/test/map.test.ts` asserted that the VTI
fixture's holding filed under its **CUSIP**; the fixture carries a FIGI (`BBG000BDTF76`, the field
01 §5.5 records Plaid adding on 2026-06-18) and `IDENTIFIER_RANK` correctly picks it. The expectation
was updated to the FIGI rather than the rank being weakened — that is the whole point of the rank.

```
$ pnpm exec tsc -p tsconfig.json --noEmit        # clean
$ pnpm exec vitest run --project connector-port --project connector-plaid
 Test Files  9 passed (9)
      Tests  243 passed | 1 skipped (244)
```

---

## 1. The `@connector/port` changes, and why the investment-transaction fact became one

`ProviderInvestmentTransactionFact` used to be `PlaidInvestmentTransactionFact`, declared in
`packages/connectors/plaid/src/map.ts` with a comment naming its own promotion as the gap. Two things
forced it up into the port rather than leaving it Plaid-local, and both are in the type's doc comment
so the next reader does not have to find this file:

1. **It is not Plaid-shaped.** Coinbase fills (WP 3.5) and a brokerage CSV produce the same four facts
   — a security, a signed quantity, a unit price and a fee. A second adapter is the moment a
   "local type" becomes a de-facto contract that nobody wrote down and nothing checks.
2. **It cannot be smuggled through `ProviderTransactionFact`.** An investment transaction carries a
   quantity, a price and a fee; flattening it into a bank transaction loses all three, and cost basis
   cannot be rebuilt from what is left. 04 §5.5 requires an unknown basis to report `unavailable`
   rather than gain-from-zero, and a lossy fact is exactly how it silently becomes the latter instead.

What the port gained, all in `packages/connectors/port/src/`:

| Addition                                                                                                                           | File             | Note                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SecurityIdentifier`, `SECURITY_IDENTIFIER_KINDS`, `securityIdentifierOf`                                                          | `facts.ts`       | 08 §2.5's union **plus `figi` and `mic`**; `sedol` deliberately absent (01 §5.5: removed in 2026)                                                                                                                                                  |
| `ProviderSecurityFact`                                                                                                             | `facts.ts`       | every name a provider gave, at once — the resolver can only walk tiers if it sees the whole set                                                                                                                                                    |
| `ProviderInvestmentTransactionFact`                                                                                                | `facts.ts`       | the promotion                                                                                                                                                                                                                                      |
| `ProviderHoldingFact.security`                                                                                                     | `facts.ts`       | was `securityId: string` + `symbol: string \| null`, which cannot express "ETH on Ethereum" and cannot tell `BHP` on XASX from `BHP` on XNYS                                                                                                       |
| `Connector.syncInvestmentTransactions?`                                                                                            | `connector.ts`   | optional + capability-gated; returns an **array, not a `TransactionPage`**, because 01 §5.5 records there is no `/investments/transactions/sync` and a paging shape with no cursor behind it hands the caller a `nextCursor` it must never persist |
| `IDENTIFIER_RANK`, `strongestIdentifier`, `securityIdentifierKeyOf`, `securityFingerprintOf`, `investmentTransactionFingerprintOf` | `fingerprint.ts` | the fingerprint has to pick **one** identifier out of a set and two providers must pick the same one, which makes the order part of the canonical model                                                                                            |
| holdings / investment-transaction conformance cases                                                                                | `conformance.ts` | run against any connector that advertises the capability                                                                                                                                                                                           |

`securityFingerprintOf` hashes the **strongest** identifier only, not the whole set: hashing the set
would make the key a function of how chatty a provider is, which is the opposite of a cross-provider
dedupe key. A fact with no identifiers at all throws rather than hashing the empty string, because
every unnamed security would otherwise share one fingerprint.

---

## 2. Migration 0013 and the three tables

`packages/db/migrations/0013_securities.sql`. Three tables, and the split between them is the design.

| Table                  | What it holds                                                                         | Why it is separate                                                              |
| ---------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `securities`           | one asset — the thing a holding, a lot, a price and an allocation weight all point at | the entity                                                                      |
| `security_identifiers` | every name anybody has called it, with who said so and how much that is worth         | the **evidence**, append-mostly                                                 |
| `security_overlay`     | what the user says when the provider's metadata is junk                               | 04 §2.2's immutable-facts + mutable-overlay split (04 §3.2 asks for it by name) |

Two constraints carry the load-bearing claims, and both are single-row CHECKs or unique indexes rather
than application logic:

- **`securities.identity_kind` is CHECKed against a list with no `proprietary` member.** A row whose
  only name is a provider's own opaque id cannot be inserted _at all_. This is D25's shape applied to
  securities: a `securities` row must mean "an asset the outside world has a name for", never "a
  provider mentioned something". It is also why an unresolvable identifier has to fail loudly — there
  is no row the resolver could write even if it wanted to.
- **`security_identifiers` has `UNIQUE (user_id, identifier_key)`.** One name points at exactly one
  security. Two providers that agree on an ISIN therefore cannot become two rows even if the
  resolver's lookup were wrong: the second insert is a `23505`.

Plus `security_identifiers_proprietary_names_its_issuer` (a proprietary identifier must carry the
`provider` whose vocabulary it belongs to — an unattributed opaque string is not evidence of
anything), `securities_crypto_names_its_chain`, `securities_contract_needs_a_chain`, and
`securities_flagged_has_a_residual`.

No column in this migration is money or a quantity — a security has no amount; those arrive in 0014
and 0015. The two numeric columns are an expense ratio (`NUMERIC(9,6)`) and an identifier confidence
(`NUMERIC(5,4)`), both exact, neither a float (D3, and `migrate.test.ts` bans every float type across
the schema). No foreign key crosses into another context's schema in either direction (D8).

Registration:

```
$ node scripts/check-schema-ownership.ts
schema-ownership: ok — 96 table(s) claimed across 14 package(s), 68 defined.

$ DATABASE_URL=… pnpm exec vitest run --project db
 Test Files  1 passed (1)
      Tests  10 passed (10)
```

`packages/db/test/migrate.test.ts` carries the three new names in its alphabetical list and a
`0013_securities` attribution block above it stating both constraints. `OWNERSHIP.md` now claims
`security_overlay` alongside the two tables it already claimed, and says plainly which claims are
built and which are still only claims.

One thing worth recording because it cost a run: `migrate.test.ts`'s float ban strips `--` comments
but **not** SQL string literals, so a `COMMENT ON TABLE` containing the words "real-world" fails the
`\bREAL\b` check. The comment was reworded. The check is right and the false positive is cheap;
loosening the regex to allow "real" inside a string is how `REAL` eventually lands in a column.

---

## 3. The merge rules, with an abstain reason per tier

`packages/contexts/investments/src/identifiers.ts` and `.../src/resolver.ts`. Tiers strongest-first,
**first answer wins**, and every tier that does not answer returns a named reason rather than
silence.

| #   | Tier                 | Resolves when                                                | Abstains with                                                                  | Why it ranks here                                                                   |
| --- | -------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| 1   | `figi`               | the shape is valid (`^[BCDFGHJKLMNPQRSTVWXYZ]{2}G[…]{8}\d$`) | `absent`, `malformed`                                                          | globally unique, permanent, exchange-level, open standard. Nothing is stronger.     |
| 2   | `isin`               | the check digit verifies                                     | `absent`, `malformed`                                                          | unique at the _issue_ level, so it cannot separate a dual listing                   |
| 3   | `cusip`              | the check digit verifies                                     | `absent`, `malformed`                                                          | North America only, and licensed rather than open                                   |
| 4   | `ticker` + MIC       | the MIC is a well-formed ISO-10383 code                      | `absent`, `malformed`, **`unqualified_ticker`**                                | `BHP` is three companies on XNYS/XASX/XLON, and tickers are reused after delistings |
| 5   | `chain` + `contract` | the chain is named                                           | `absent`, `malformed`                                                          | exact for the token; ranked below `ticker` only for fingerprint selection           |
| 6   | `proprietary`        | **never**                                                    | always `proprietary_is_not_an_identity` (or `malformed` if it names no issuer) | stable inside one provider, meaningless across two                                  |

Three refusals are worth naming because each is a thing the resolver could have done and does not:

- **An unqualified ticker never establishes a security.** It is still stored, as evidence, at
  confidence `0.3000`. The exception is not an exception to the rule but to its premise: a _crypto_
  ticker cannot carry a MIC, because ISO-10383 registers venues and a chain is not one.
- **A malformed identifier abstains as `malformed`, not as `absent`.** A CUSIP truncated to eight
  characters is a different failure from a CUSIP nobody sent, and the `SecurityResolutionFailed`
  payload carries the offending value so it is fixable.
- **An ambiguous OpenFIGI answer is refused.** Two mappings for one ticker is a dual listing; picking
  the first would be inventing an identity.

**Native assets.** The §5 exit criterion is only reachable because the three sightings of ETH share
no identifier kind at all. `NATIVE_ASSETS` (ten coins) canonicalises every spelling onto one
`chain_contract` whose contract is the sentinel `native`: the aliases (`ETH`, `ETHER`, `ETHEREUM`;
`POL`/`MATIC`; `BTC`/`XBT`) and the addresses wallets and aggregators conventionally use for a
chain's own coin (`0xEeee…eEEeE`, the zero address). **WETH is deliberately not folded in** — an
ERC-20 with its own custody assumption and its own depeg risk, which a user can hold _at the same
time_ as ETH and in a different amount. Merging them would make one of the two balances vanish into
the other. `'WETH and ETH are two securities, because a user can hold both at once'` is what stops
somebody adding the convenience later.

**Merging two rows into one asset.** Deterministic, three keys: strongest identity tier, then
earliest `created_at`, then lexicographically smallest id. The loser keeps its row and gains
`merged_into_id`, so an id handed out before the merge is followed forward rather than broken;
every identifier it held is re-pointed at the winner. `'picks the same winner whichever provider
synced first'` runs both orders and asserts the same survivor, because a resolver whose answer
depends on sync order produces a different history on a replay.

### The one-security proof, all three identifiers shown

`test/db/securities.test.ts` → `'ETH from Coinbase, a wallet contract address and Plaid ETHEREUM
resolve to one security_id'`, against Postgres. Afterwards, `securities` holds **one** row and
`security_identifiers` holds five names pointing at it:

| Provider  | What it said                  | Kind after normalisation                                        | Identity? |
| --------- | ----------------------------- | --------------------------------------------------------------- | --------- |
| coinbase  | `ETH`                         | `chain_contract ethereum/native` (canonicalised) + `ticker ETH` | yes / no  |
| coinbase  | `ETH-USD` (its own id)        | `proprietary`, `provider='coinbase'`                            | **no**    |
| walletrpc | `0xEeee…eEEeE` on chain `ETH` | `chain_contract ethereum/native`                                | yes       |
| plaid     | `ETHEREUM`                    | `chain_contract ethereum/native` + `ticker ETHEREUM`            | yes / no  |
| plaid     | `sec-eth-0009`                | `proprietary`, `provider='plaid'`                               | **no**    |

```
securities: 1 row — identity_kind=chain_contract, chain=ethereum, contract=native,
                    asset_class=CRYPTO, classification_source=PROVIDER
security_identifiers ORDER BY kind, value:
  chain_contract:native · proprietary:ETH-USD · proprietary:sec-eth-0009 · ticker:ETH · ticker:ETHEREUM
```

The equivalent unit proof, `src/resolver.test.ts` → `'ETH as a Coinbase ticker, a chain+contract and
a brokerage CUSIP resolve to one securityId'`, adds the plan's third sighting: a brokerage that
custodies the coin and files the _line_ under CUSIP `922908769`. A CUSIP outranks a contract address,
so the row's `identity_kind` is **upgraded** in place — its id, which is the only thing a holding or
a lot ever points at, does not move.

### Classification

07 §4.3's waterfall, `classification_source` on every answer. Rungs **3 (SEC EDGAR)** and
**4 (ISSUER_HOLDINGS)** are injected lookups and are **not implemented in this work package** — both
are network calls and belong behind WP 2.4's allow-list module, which WP 3.4 owns. They are wired as
parameters and tested with fakes, so the rung is reachable the day an adapter exists.

Measured hit rate. `data/asset-classes.json` ships **48 funds** (16 US equity, 7 US bond, 4 cash,
4 intl developed, 3 TIPS, 3 REIT, 3 commodity, 2 EM, 1 intl bond, 5 multi-asset with component
weights). Against the Plaid investments fixture, which is the only holdings corpus that exists
before WP 3.2:

```
VTI                   LOCAL_SEED_TABLE   US_EQUITY   US
Northwind Cash Sweep  PROVIDER           CASH        UNKNOWN
BTC                   PROVIDER           CRYPTO      GLOBAL
→ 0 of 3 UNCLASSIFIED (0%)
```

Stated plainly, because the number flatters us and should not be trusted: **three securities is not
a hit rate.** 07 §4.3 imagines a ~600-row seed and this is 48, chosen as the funds most likely to
appear in a US personal portfolio; a real portfolio containing individual equities will fall through
to `SIC_SECTOR_MAP` (which we have no SIC source for yet, so: `UNCLASSIFIED`) far more often than
this suggests. The honest measurement belongs to WP 3.14's seed extension, over a portfolio with
individual names in it. What this work package can promise is that the number will be _visible_:
`UNCLASSIFIED` is a recorded classification rather than a null, so `% unclassified` is a count and
not an inference — which is what I1's self-suppression above 10% (07 §4.3, normative) needs.

---

## 4. `FigiMapper`: the shape, and what WP 3.4 must implement

```ts
export interface FigiMapper {
  readonly source: string;
  map(jobs: readonly FigiMapJob[]): Promise<readonly FigiMapOutcome[]>;
}

export interface FigiMapJob {
  readonly idType: 'ID_ISIN' | 'ID_CUSIP' | 'TICKER' | 'ID_BB_GLOBAL';
  readonly idValue: string;
  readonly micCode: string | null;
}

export type FigiMapOutcome =
  | { readonly status: 'matched'; readonly mappings: readonly FigiMapping[] }
  | { readonly status: 'no_match' }
  | { readonly status: 'error'; readonly message: string };
```

Four things the shape encodes, each of which would otherwise be a convention somebody had to
remember:

1. **It takes an array.** A mapper that took one job could not batch, and an interface that cannot
   express the only thing making the provider usable is the wrong interface.
2. **One outcome per job, positionally.** OpenFIGI's response array is positional; re-deriving the
   association by matching values back is wrong for exactly the case the `micCode` exists for — two
   jobs with the same `idValue` and different venues.
3. **`no_match` and `error` are different states.** The first is a fact about the identifier and can
   be recorded; the second is a fact about the call and must not be, or a five-second outage becomes
   a permanent "unmappable".
4. **Limits are numbers in the code** (dispatch §4): `OPENFIGI_MAX_JOBS_PER_REQUEST = 100`,
   `OPENFIGI_ANONYMOUS_MAX_JOBS_PER_REQUEST = 10`, `OPENFIGI_MAX_JOBS_PER_MINUTE = 25_000`.

WP 3.4 writes `map()` over `https://api.openfigi.com/v3/mapping` behind the notifications
allow-list module (`api.openfigi.com` joins `MARKET_DATA_ALLOWED_HOSTS`) and nothing else; the
batching, the job construction and the ambiguity refusal are already here and already tested.

**A plan-versus-reality note, recorded rather than resolved.** The plan's test name is
`'120 symbols are one batched request, not 120'`. OpenFIGI's documented ceiling is 100 jobs per
request with a key, so 120 symbols are **two** requests and cannot be one. The test keeps the plan's
name verbatim and asserts the true number, with the reason in the test body:

```
test/openfigi.test.ts → '120 symbols are one batched request, not 120'
  requests      = 2          (not 120)
  jobs total    = 120
  max per batch ≤ 100        (OPENFIGI_MAX_JOBS_PER_REQUEST)
```

The alternative — raising the cap to 120 so the sentence came true — would have put a fabricated
rate limit in the code, which is the failure mode dispatch §4 is guarding against when it asks for
documented numbers.

One more thing the resolver does for the batch's sake: `resolveAll` asks **once per security, not
once per name**. A fact carrying both a CUSIP and a ticker is one job, because the CUSIP already
answers better; `'asks once per security, not once per name it was given'` pins it.

---

## 5. Tests, and the sabotages

61 tests across the two investments projects, plus the 243 in `connector-port` / `connector-plaid`
and 10 in `db`.

| File                         | Project          | Tests | The plan's names it carries                                                                                                                                                                                                                                                                   |
| ---------------------------- | ---------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/identifiers.test.ts`    | `investments`    | 17    | `'a provider identifier never becomes the identity'`                                                                                                                                                                                                                                          |
| `src/resolver.test.ts`       | `investments`    | 11    | `'ETH as a Coinbase ticker, a chain+contract and a brokerage CUSIP resolve to one securityId'`, `'an unresolvable identifier fails loudly and emits SecurityResolutionFailed rather than minting a row'`, `'two identifiers for one security never create two rows'` (`fast-check`, 200 runs) |
| `src/classify.test.ts`       | `investments`    | 11    | `'every classified row records its classification_source'`, `'a fund whose component weights miss 1.0 by more than 5% is flagged'`, `'fund-of-funds recursion stops at depth 3 and detects a cycle'`                                                                                          |
| `test/openfigi.test.ts`      | `investments`    | 12    | `'120 symbols are one batched request, not 120'`                                                                                                                                                                                                                                              |
| `test/db/securities.test.ts` | `investments-db` | 6     | `'ETH from Coinbase, a wallet contract address and Plaid ETHEREUM resolve to one security_id'`, `'two identifiers for one security never create two rows'`, `'quantities round-trip 0.00000001 BTC'`                                                                                          |
| `test/db/overlay.test.ts`    | `investments-db` | 4     | `'a user asset-class override survives a provider re-sync'`                                                                                                                                                                                                                                   |

Two notes on scope, so a reviewer is not surprised:

- **`'quantities round-trip 0.00000001 BTC'`** runs here even though `securities` holds no quantity —
  a security has no amount, and `holdings.quantity NUMERIC(38,18)` arrives in 0014. What it proves is
  the chain that column will depend on: `Quantity` → the driver → a real `NUMERIC(38,18)` → the type
  parser → `Quantity`, satoshi intact (`'0.000000010000000000'`), and the 18-decimal wei end of the
  range too. It uses a temp table rather than a cast, because the storage leg is the one a cast-only
  test would skip.
- The **`fast-check` property** has one precondition, and it is the claim's real precondition rather
  than a weakening: _something has to link the names_. A provider reporting only a CUSIP and another
  reporting only an ISIN have said nothing that makes those one security, and inventing the link
  would be the guess this resolver refuses everywhere else. So one sighting — at a position the
  property chooses, **including last, after two disjoint rows already exist** — names the security
  fully, and every id ever handed out is then followed through `merged_into_id` to the single live
  row.

### Sabotage 1 — the merge rule: FIGI no longer wins

`RESOLUTION_TIERS` reordered to `['isin', 'cusip', 'figi', …]`, everything else untouched:

```
× src/identifiers.test.ts  › is the port’s identifier rank, stated here rather than imported
    expected [ 'isin', 'cusip', 'figi', …(3) ] to deeply equal [ 'figi', 'isin', 'cusip', …(3) ]
× src/identifiers.test.ts  › excludes proprietary from the identity kinds, and nothing else
× src/resolver.test.ts     › merges two rows deterministically when a later name proves they are one asset
× src/resolver.test.ts     › picks the same winner whichever provider synced first
    expected [ 'cusip', 'cusip' ] to deeply equal [ 'figi', 'figi' ]
× test/db/securities.test.ts › a merge re-points every identifier and leaves the loser followable
  Tests  5 failed | 56 passed (61)
```

Red on the first attempt, in both the unit and the database projects. Restored; `61 passed (61)`.

### Sabotage 2 — D25: a provider identifier becomes the identity

`proprietary` added to `IDENTITY_KINDS`:

```
× src/identifiers.test.ts › excludes proprietary from the identity kinds, and nothing else
× src/identifiers.test.ts › a provider identifier never becomes the identity
    expected true to be false
  Tests  2 failed | 59 passed (61)
```

Restored; green. The database half of this control is asserted directly rather than by sabotage,
because the constraint cannot be disabled from TypeScript: `test/db/securities.test.ts` inserts a
row with `identity_kind = 'proprietary'` and reads the refusal back by name —

```
{ code: '23514', constraint: 'securities_identity_kind_check' }
{ code: '23514', constraint: 'security_identifiers_proprietary_names_its_issuer' }
{ code: '23505', constraint: 'security_identifiers_user_key_idx' }
{ code: '23505', constraint: 'security_overlay_user_security_idx' }
{ code: '23514', constraint: 'security_overlay_locked_fields_are_known' }
```

Asserting the **constraint's name** and not just the SQLSTATE is deliberate: a bare
`rejects.toMatchObject({ code: '23514' })` passes for any check on the table, and — as this suite
found on its first run — Drizzle wraps the driver error so that `code` is on `.cause`, which means
the naive assertion fails while the constraint is working perfectly. `pgFailureOf` in the harness
unwraps it.

---

## 6. Registration lines for the composition root

None of these are this work package's to apply — §4's shared files are the orchestrator's — so they
are written out here rather than half-done.

**`apps/api/src/modules.ts`** — the events:

```ts
import { INVESTMENTS_EVENTS } from '@ctx/investments';
// …
events: [...LEDGER_EVENTS, …, ...INVESTMENTS_EVENTS],
```

**`apps/api/src/domain.ts`** — the resolver, with the production sink and (once WP 3.4 lands) the
real mapper:

```ts
import { createSecurityResolver, drizzleSecurityStore, outboxOf } from '@ctx/investments';
import { appendEvent } from '@core/platform';

export function securityResolverFor(tx: Database, clock: Clock) {
  return createSecurityResolver({
    store: drizzleSecurityStore(tx, clock),
    clock,
    events: { append: async (event) => void (await appendEvent(outboxOf(tx), event)) },
    // WP 3.4: the HTTP adapter, behind MARKET_DATA_ALLOWED_HOSTS.
    // figi: openFigiMapper({ apiKey, egress }),
  });
}
```

The resolver must be built **per transaction**, not per process: the event and the rows have to land
in the same one, or a `SecurityResolutionFailed` survives a rolled-back sync.

**`apps/api/src/platform.ts`** — `MODULE_FLAGS` gains `module.investments`, `defaultEnabled: false`
until a consumer is registered and green.

**`vitest.config.ts`** already carries `investments` and `investments-db`; `scripts/check-ci-projects.ts`
will want both in the two `--project` lists in `.github/workflows/ci.yml`.

**`scripts/eslint-boundaries.js`** — the `investments` layer of §4 item 2 is **not yet applied**, and
this package is currently green without it by not importing `@core/testkit` at all:
`test/db/harness.ts` builds its own scratch database out of `@core/db` and `drizzle-orm`. When the
layer lands, that file collapses to an import of `@core/testkit`; its header says so.

---

## 7. What is open

- **Rungs 3 and 4 of the waterfall** (SEC EDGAR, issuer holdings CSVs) are ports with fakes, not
  adapters. WP 3.4 owns the egress.
- **The seed table is 48 rows, not ~600.** Growing it is a data edit, and `classify.test.ts` walks
  every row on every run so a typo in an addition fails immediately.
- **`classification_residual` is only populated for a fund with components.** An individual equity
  has nothing to decompose, and `securities_flagged_has_a_residual` keeps the pair honest.
- **The `investments` boundary-lint layer** and the `ci.yml` project lists are the orchestrator's
  shared-file edits, listed in §6 above.
- **`sector` is `UNKNOWN` for every seed fund.** A fund's sector breakdown needs the look-through
  data rungs 3 and 4 supply; claiming one from the fund's name would be the kind of confident
  nonsense 07 §4.3's `UNCLASSIFIED` bucket exists to avoid.
