# WP 4.12a — Phase 3 gate conditions, backend half (first pass)

_The Sonnet agent carrying this package was killed by the account's session limit at its final re-run, after the code and tests were complete but before it wrote this file. The orchestrator wrote it from the diff and an independent re-run of every affected suite. Nothing below is claimed that was not re-observed. Conditions are numbered as in [`../phase-3/gate-security-review.md`](../phase-3/gate-security-review.md) §6._

---

## 1. What landed

| Condition                  | Severity     | Status                                                                                                                                                                     |
| -------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C-2**                    | **HIGH**     | **Closed.** A funded watch-only wallet now produces a holding (quantity + resolved `security_id`) valued by WP 3.4's price ladder. Reproduced red first (see §2).          |
| **C-14**                   | LOW          | **Closed.** Migration 0025 adds composite FKs `(user_id, security_id) → securities(user_id, id)` on `holdings`, `cost_basis_lots`, `investment_transactions`, `prices`.    |
| **C-16**                   | LOW          | **Part closed:** O-5 — `packages/connectors/walletrpc/test/index.ts` now exists and is the barrel `package.json` has exported since WP 3.6. The rest of C-16 is left (§4). |
| C-7, C-4, C-13, C-12, C-11 | MEDIUM / LOW | **Not reached.** Left for WP 4.12b (§4).                                                                                                                                   |

## 2. C-2 — a funded wallet becomes a holding (G3-14)

### The defect

`WalletRpcConnector` has no price source, and both `syncBalances` and `syncHoldings` raised `DATA_UNAVAILABLE` for any non-zero balance, so a funded wallet could never become a holding. WP 3.6 deferred valuation "downstream to WP 3.4's price ladder" but emitted no fact for the ladder to join against.

### The change

- **Port** (`packages/connectors/port/src/facts.ts`): `ProviderHoldingFact.value` is `Money | null` — `null` states "this provider has no fiat quote", a different claim from a fabricated `$0.00` and from the position not existing. The conformance suite (`conformance.ts`) accepts `null` or a `(bigint minor, ISO currency)` pair.
- **Connector** (`packages/connectors/walletrpc/src/{connector,provider}.ts`): `syncHoldings` reports the real on-chain quantity with `value: null`, `costBasis: null`, and the chain's native-asset `chain_contract` identifier so the resolver merges it onto the same `security_id` a Coinbase sighting uses. **`syncBalances` is unchanged and still raises `DATA_UNAVAILABLE`** for a non-zero balance: `ProviderBalanceFact.current` is `Money` (a ledger balance, no downstream ladder), and Planning's `INTERPOLATION_POLICY` values an `investment`-kind account from `quantity × price` over its holdings, never from `accounts.balance`. A documented residual, recorded in the connector's header.
- **Staging** (`packages/contexts/connections/src/staging.ts`): the staged holding carries a nullable value.
- **Investments** (`schema/holdings.ts`, `src/holdings.ts`, `src/lots-store.ts`, `src/reconcile.ts`): `Holding.institutionValue` is `Money | null`; `holdings.institution_value_minor` and `holdings_snapshots.institution_value_minor` are nullable (migration 0025 part 2; `currency` defaults to `DEFAULT_HOLDING_CURRENCY = USD` when the provider gave none); `reconcileHolding` gains a fourth state, `no_institution_value`, which reports the computed value when a price exists and never claims a reconciliation. Market value and allocation were already read from `PriceReader`, never from `institutionValue`, so valuation needed no change once the holding row existed.
- **Migration 0025 part 3**: `connection_sync_facts` gains a CHECK that a holding fact is a position (quantity present) even when its value is null.

### Reproduced red, then green

`apps/api/test/db/wallet-holdings-valuation.test.ts` drives the real `WalletRpcConnector` over the hermetic Etherscan fake, builds a Coinbase-shaped `ProviderSecurityFact` for the same asset with `@connector/coinbase`'s production `securityFactOf`, resolves both through the real `securityResolverFor` on a scratch database, writes the holding with the real `drizzleLotStore`, and values it with the real `valueHoldings`/`priceReaderFor` — the three steps `resolveRunFacts` performs inside a sync, assembled without the job runner. Asserts one `securities` row shared by both sightings and a non-zero valued holding. Before the connector change, step 1 threw `DATA_UNAVAILABLE` and every later assertion was unreachable (the agent's reproduction; the file header records it). This is the permanent regression the gate's temporary `gate3-eth-one-row.test.ts` stood in for.

## 3. C-14 — cross-user security reference is structurally impossible

`securities` gains `UNIQUE (user_id, id)`; the four child tables gain composite FKs (`*_security_belongs_to_user`, `ON DELETE CASCADE`). WP 3.14a's route test was rewritten: `'a holding whose security belongs to another user is refused by the database (holdings_security_belongs_to_user), not merely by the read-path predicates'` asserts SQLSTATE `23503` naming that constraint on the raw-SQL plant, and that neither user's `GET /holdings` changed. The read-path predicates stay; the data shape they guarded against can no longer exist.

## 4. Left for WP 4.12b

C-7 (export bundle covers the Phase 3 tables + round-trip test; migrate.test.ts's Phase 3 exemptions to delete), C-4 (CDP key raw-column custody test), C-13 (seal `wallet_addresses.descriptor`), C-12 (`checkUrl` passes the scheme to `checkDestination`), C-11 (planning `toMinorUnits` half-even), and the rest of C-16 (`compose.override.example.yml` dev-sinks block; Playwright specs rewriting committed screenshots; the 04 §2 row strike). Plus 4.12b's own list from the dispatch: C-1, C-3, C-5, C-6, C-8, C-10.

Also owed by the C-2 port change: `RUNBOOK.md` should say a funded wallet's **balance** still cannot sync (only its holdings can) until `ProviderBalanceFact.current` is widened or the account-balance path values from holdings.

## 5. Checks (orchestrator's independent run, 2026-09-26 16:05 EDT)

| Command                                                                                                                                                                                                                  | Result                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| `pnpm exec tsc -b --noEmit`                                                                                                                                                                                              | clean (whole tree, with WP 4.1 and 4.2 present) |
| `vitest run --project connector-walletrpc --project connector-port --project connector-plaid --project connector-coinbase --project connections --project connections-db --project investments --project investments-db` | **62 files, 776 passed, 2 skipped**             |
| `vitest run --project api-db test/db/{wallet-holdings-valuation,investments-routes,phase3-wiring}.test.ts`                                                                                                               | **3 files, 27 passed**                          |
| `vitest run --project planning --project planning-db --project db` (migration 0025 applied alongside 0020/0021)                                                                                                          | 17 files, 89 passed                             |

Sabotage records are the agent's and were lost with its session; the gate's Phase 4 Standard B must sabotage C-2 (restore `DATA_UNAVAILABLE` in `syncHoldings`) and C-14 (drop one composite FK) itself.
