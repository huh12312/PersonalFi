# WP 3.14a — port single identifier and the S1 join-scope finding

_Close-out of two items WP 3.14 inherited: the defect [`wp3.7a-holding-identifiers.md`](./wp3.7a-holding-identifiers.md) §7 carried (`ProviderInvestmentTransactionFact.security` was still one `SecurityIdentifier`), and [`wp3.9-routes.md`](./wp3.9-routes.md) §4's finding S1 (a single-predicate sabotage of `readHoldings` stayed green because the securities join also scopes). Implemented by a Sonnet backend agent on 2026-09-24; the agent was stopped by the host before it could write this file, so the orchestrator wrote it from the agent's report, the diff, and an independent re-run of the suites. Nothing below is claimed that was not re-observed._

---

## 1. `ProviderInvestmentTransactionFact.security` carries the whole `ProviderSecurityFact`

### The defect, as carried

WP 3.7a fixed holdings: `ProviderHoldingFact.security` became the whole `ProviderSecurityFact` (every identifier the provider gave, plus type and name), so the resolver tiers over the set instead of over whichever single identifier the adapter happened to pick. It left `ProviderInvestmentTransactionFact.security` as one `SecurityIdentifier` plus a sibling `providerSecurityId`, and recorded why that was latent rather than reachable: `resolveRunFacts` runs holdings through `resolveAll` first, so a transaction's lone identifier usually lands on a row the holdings pass already upgraded. A run that produced investment transactions and **no** holding for the same security would split it exactly as holdings used to.

### The change (one field, every adapter)

| File                                              | Change                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/connectors/port/src/facts.ts`           | `security: ProviderSecurityFact \| null`; the sibling `providerSecurityId` is gone (it lives inside the fact, as it does for holdings).                                                                                                                                                                                          |
| `packages/connectors/port/src/conformance.ts`     | The transaction-fact check now asserts the same things the holding-fact check asserts: a non-empty `providerSecurityId`, a non-empty identifier set, every kind in `SECURITY_IDENTIFIER_KINDS`, non-empty values, `chain_contract` carries a chain, and `fingerprint === securityFingerprintOf(identifiers)`.                    |
| `packages/connectors/plaid/src/map.ts`            | `holdingSecurityOf` (strongest-identifier pick) deleted; the transaction path calls the same `holdingSecurityFactOf` the holdings path calls. The legacy single-identifier field the ledger-side transaction still carries is derived from the set (`strongestIdentifier(securityFact.identifiers)`), never the other way round. |
| `packages/connectors/coinbase/src/map.ts`         | `securityFactOf(base, price)` on the transaction fact, the same builder the holding uses.                                                                                                                                                                                                                                        |
| `packages/contexts/connections/src/staging.ts`    | The staged row carries the whole fact.                                                                                                                                                                                                                                                                                           |
| `apps/api/src/domain.ts` (`resolveRunFacts` only) | `...observed.transactions.flatMap((t) => t.fact.security === null ? [] : [t.fact.security])` — the transaction leg feeds the resolver the identical shape the holdings leg does, which is what makes the two legs merge.                                                                                                         |
| Tests updated for the shape                       | `packages/connectors/plaid/test/map.test.ts`, `packages/connectors/coinbase/test/{map,onramp}.test.ts`, `packages/contexts/investments/test/db/consumer.test.ts`.                                                                                                                                                                |

### Reproduced red, then green

`apps/api/test/db/phase3-wiring.test.ts` → `'an investment transaction with no holding for its security still merges with an earlier ticker-only sighting'`: run 1 syncs a holding known only by ticker; run 2 syncs an investment transaction for the same security, no holding, named by FIGI (and ticker). Asserts exactly one `securities` row, with the identity upgraded in place.

- Before the fix (agent's hand-revert of `investmentTransactionFactOf`'s security pick in `plaid/src/map.ts`): **RED** — two `securities` rows.
- After: green. The restore was checked byte-for-byte against the fixed file.

## 2. WP 3.9 S1: the single-predicate sabotage is now red

### The finding

S1 dropped `WHERE h.user_id` from `readHoldings` and every route test stayed green, because `JOIN securities s ON … s.user_id` still scoped the result. Correct behaviour, insufficient evidence: no test could tell one predicate from two.

### The test

`apps/api/test/db/investments-routes.test.ts` → `'a holding whose security belongs to another user is visible to neither'`. No FK or CHECK forbids a `holdings` row for user B that references a `securities` row owned by user A (confirmed by planting one with raw SQL, bypassing the app), so the test plants exactly that and asserts neither user's `GET /holdings` returns it.

- Sabotage (drop `WHERE h.user_id` from `readHoldings` in `apps/api/src/routes/investments.ts`): **RED on the first valid attempt** — only this test failed (`accountCount` 2 → 3); the other 14 tests in the file stayed green, which reproduces the original S1 observation exactly. Reverted; file diffed clean; suite green again.

### Other join-scoped routes

From wp3.9 §4's table: `/accounts/{id}/holdings`, `/investments/allocation` and `/investments/drift` share the identical `readHoldings` call, so this one test covers all four. `/securities/{id}` uses a `LEFT JOIN` (nothing to mask; already S4-red). `/prices/{id}` and `/net-worth/series` are sequential reads, not one doubled query. No other route needed a same-shaped test.

## 3. Checks

Agent's run (foreground, its tree): `tsc -b --noEmit` clean; eslint clean on every touched directory; prettier no-op; `check-numeric-boundaries.ts` PASS; `lint:schema-ownership` ok; `vitest run` over connector-port/plaid/coinbase/walletrpc, connections, connections-db, investments, investments-db, api-db → **100 files, 1003 tests: 997 passed, 6 skipped (pre-existing, credential-gated), 0 failed**.

Orchestrator's independent re-run at commit time (2026-09-25 00:20 EDT, same tree):

| Command                                                                                                                                                                                            | Result                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `pnpm exec tsc -b --noEmit`                                                                                                                                                                        | clean                               |
| `vitest run --project connector-port --project connector-plaid --project connector-coinbase --project connector-walletrpc --project connections --project connections-db --project investments-db` | **39 files, 571 passed, 2 skipped** |
| `vitest run --project api-db test/db/phase3-wiring.test.ts test/db/investments-routes.test.ts`                                                                                                     | **2 files, 26 passed**              |

`git diff --cached --name-only` was empty throughout (memory: staged-rename-leak). The agent made no `git add`/`commit`/`stash`.

## 4. For the gate

- The Task 1 reproduction is order-dependent by construction (holding first, transaction second). The gate may want the mirror image (transaction-only run first, holding second) as a second sabotage input; the fix is symmetric so it should be green, but it has not been observed.
- The S1 test proves the `holdings.user_id` predicate is load-bearing. It does not, by itself, prove `securities.user_id` is (S2 in wp3.9 does, by dropping both).
