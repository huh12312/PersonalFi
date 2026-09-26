<!-- SPDX-License-Identifier: MIT -->

# Phase 3 security gate — independent review

**Reviewer:** Opus `security-engineer`, independent of every Phase 3 work package.
Wrote none of this code; every evidence document under `docs/evidence/phase-3/` was
read as a _claim_, not as a result.
**Tree:** `/home/chris/Projects/PersonalFi`, branch `main`, HEAD `dba6270`
(`docs: execution log — CI 13/13 green on b38c586; gate told to cite it`). The code
under review is `9fb4191` (WP 3.14a); `dba6270` and `b38c586` differ from it only by
execution-log lines.
**CI:** 13/13 green on the real GitHub runner at `b38c586` — the same code
(execution log 2026-09-25 00:50).
**Date:** 2026-09-26.

Written incrementally, section by section, so a session kill loses nothing already
appended. No secret value appears anywhere in this file; every transcript was redacted
at the shell before it was pasted.

**Resume note for a fresh reviewer:** each section below says whether it is COMPLETE
or IN PROGRESS. Start at the first section not marked COMPLETE. The compose stack is
this gate's alone; if §3 is IN PROGRESS, assume the stack may be up and run
`docker compose down -v` (and remove any `compose.override.yml`) before anything else.

---

## 0. Verdict

**GO-WITH-CONDITIONS.**

- **Standard A: PASS** (§1). This is the first complete local `just verify` of the Phase 3
  tree, and every stage is green: 2,710 backend tests, 295 web tests (297 after F-1), 41
  Playwright tests, gitleaks, license, hardening and trivy. CI is 13/13 green on the real
  runner at `b38c586`, the same code.
- **Standard B: 45 controls sabotaged, 41 red on the first valid attempt** (§2). The four
  that stayed green are findings: the on-ramp's categorisation hop, the `age`-absent
  export branch, and both halves of the worker pool guard. In each case the code is right
  at HEAD and no test notices when it is removed.
- **Standard C: the cold walk reached the code Phase 3 added** (§3), in a real browser
  through Caddy:
  - passkey login;
  - holdings with prices and a STALE badge;
  - allocation equal to the committed spreadsheet on 37 of 37 rows;
  - a triggered `integrations.price_refresh` and net-worth snapshot on the real scheduler,
    degrading correctly with zero keys;
  - a watch-only wallet link, with a private key refused;
  - key presence only, plus the FRED and CoinGecko attribution;
  - the Plaid Sandbox leg: all five sync legs, and a disconnect that purged the
    credential;
  - a missing FX rate refused on three surfaces;
  - a sealed day byte-identical across re-runs on the production snapshotter;
  - WP 3.4's egress refusals and a successful notification delivery, both from inside the
    worker.

  Not reached: the Coinbase on-ramp (no seam), the encrypted export (G3-4), and a
  zero-restart cold install (G3-1).

- **Standard D** (§4): the five named surfaces hold. Egress is re-proven with the real
  resolver, the credential controls go red when removed, and a real snapshot leaks no
  identifier.
- **Two HIGH findings:**
  - **G3-2**, the dashboard's hard-coded net worth. Fixed in place as F-1, independently
    re-verified by the orchestrator, committed as `c4ccf7c`, and observed on the stack.
  - **G3-14**, a funded watch-only wallet can never become a holding. This is open, and it
    is why exit criterion (c) is proven only at the resolver.
- **No CRITICAL finding.** Nothing found here is a security control that fails open.

**Exit criteria after this gate:**

- **(a)** Net worth reconciles to a hand computation: proven by the tests; not re-walked.
- **(b)** A past date is immutable across a re-run: proven on the production path (§3.14).
- **(c)** ETH resolves to one security: proven at the resolver on real adapter output.
  **Not met end to end (G3-14).**
- **(d)** A missing FX rate surfaces rather than defaulting: "never defaults" is proven
  live. **"Surfaces on screen" is not met (G3-12).**
- **(e)** Allocation matches a spreadsheet check: proven live, 37/37.

**The v0.5 rung:**

- Holdings reconcile to balances: proven.
- Allocation matches a spreadsheet: proven.
- On-ramps are transfers: proven at the connector only (G3-3).

Conditions C-1 to C-16 are in §6: C-2 is HIGH, nine are MEDIUM and six are LOW. Rulings
on the eight inputs are in §5.

**Why GO rather than NO-GO.** Phase 4 (projections, goals, consent) does not build on the
two open gaps: the funded wallet (G3-14) and the missing-FX surface (G3-12). No open
finding weakens a security boundary. The one finding that misrepresented the user's
money on the front page is fixed. **Why WITH-CONDITIONS rather than GO.** One exit
criterion and one rung clause are not met end to end, and the Phase 1 lesson recurs four
times in §2.9 (a control that exists but is never observed failing). C-2, C-3 and C-5
should close in WP 4.12 before Phase 4's own gate walks.

---

## 1. Independent re-verification (Standard A)

_COMPLETE._

The counts below were re-derived by this gate, not read out of any WP evidence doc.
Because the full backend vitest run exceeds the 600 s foreground ceiling, `just check`
was run as its component recipes, and the vitest step as explicit `--project` chunks
that together name all 40 projects (the same set `check-ci-projects` reports).

**Hygiene before anything else:**

- `git status --porcelain` — only this file untracked. Clean tree at dispatch.
- `ls compose.override.yml` — absent.
- `docker ps` — only `personalfi-dev-db-1` (healthy, `127.0.0.1:5433`) plus unrelated
  non-PersonalFi containers. No warm PersonalFi stack was inherited.

| Stage                                                                      | Result                                                                                                                                                                     |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `just typecheck` (`tsc -p tsconfig.json`)                                  | pass (18 s)                                                                                                                                                                |
| `just lint` — prettier + eslint                                            | pass; 0 errors, 1 pre-existing warning (`react-hooks/incompatible-library` on TanStack `useVirtualizer`)                                                                   |
| `just lint` — schema ownership                                             | pass — `99 table(s) claimed across 14 package(s), 79 defined`                                                                                                              |
| `just lint` — `check-numeric-boundaries` (WP 3.14, new)                    | self-test PASS (8 bad declarations caught, good fixture clean); **PASS — 689 files scanned, 0 violations, 70 exempt identifiers** (exemptions ruled on below)              |
| `just check-proxy-routes`                                                  | PASS — Caddyfile routes `/api/*`, covering all **26** contract prefixes (Phase 3 adds `/holdings`, `/investments`, `/market-data`, `/net-worth`, `/prices`, `/securities`) |
| `node scripts/check-ci-projects.ts`                                        | self-test PASS; **PASS — all 40 projects covered (25 in `test`, 16 in `migration-test`)**                                                                                  |
| vitest, 25 non-db projects (every project without `db` in its name)        | **Test Files 152 passed (152)** / **Tests 1974 passed \| 6 skipped (1980)**, 49.3 s                                                                                        |
| vitest, 14 db projects (all `*-db` + `db`, except `api-db`)                | **Test Files 59 passed (59)** / **Tests 514 passed (514)**, 518.0 s                                                                                                        |
| vitest `api-db`, files 1–20 of 39 (alphabetical)                           | **Test Files 20 passed (20)** / **Tests 115 passed (115)**, 114.3 s                                                                                                        |
| vitest `api-db`, files 21–39                                               | **Test Files 18 passed \| 1 skipped (19)** / **Tests 107 passed \| 4 skipped (111)**, 177.5 s                                                                              |
| web vitest (`pnpm --filter @app/web test`)                                 | **Test Files 51 passed (51)** / **Tests 295 passed (295)**, 29.5 s                                                                                                         |
| `pnpm --filter @app/web build` (strip-sourcemaps, sw-precache, CSP static) | pass — 93 source maps removed, precache excludes the kitchen-sink chunk, 1 HTML file with no inline `<script>`/`style=`                                                    |
| `just playwright-check`                                                    | **41 passed, 2 skipped (1.4 m)** — the 2 skips are `cold-start.spec.ts`, which self-skips without a live stack (it is run against the live stack in §3)                    |
| gitleaks, full history, CI's pinned digest                                 | pass — 227 commits, no leaks                                                                                                                                               |
| `check-history-rewrite-before-push.sh`                                     | PASS                                                                                                                                                                       |
| license gate + `THIRD_PARTY.md` drift                                      | PASS, no drift                                                                                                                                                             |
| `just hardening-check` (self-test, then the real files)                    | pass — 10 secrets held to the strict bar, 0 violations; `check-secret-ownership` PASS                                                                                      |
| `.trivyignore` expiry + trivy filesystem scan                              | pass — 0 vulnerabilities in `pnpm-lock.yaml`, 0 misconfigurations in the three Dockerfiles                                                                                 |

**Totals.** Backend: **249 files / 2710 tests passed, 10 skipped** (152 + 59 + 38
files; 1974 + 514 + 222 tests). Web: **51 files / 295 tests**. Playwright: **41 + 2
skipped**. Every stage `just verify` runs, run, and green.

**The 10 skipped backend tests, named** (all are live-credential or live-sink gates,
each a visible skip rather than a silent pass):

| Project              | Test                                                                                           | Skips because                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `connector-coinbase` | `live Coinbase (read-only) > asserts scope, reads five endpoints, and re-runs the R6 probe…`   | no CDP key on this host                                                                   |
| `connector-plaid`    | `live Plaid Sandbox > links, syncs, breaks, reconnects and revokes a real Sandbox Item`        | no `PLAID_CLIENT_ID`/`PLAID_SECRET` in the shell                                          |
| `integrations`       | `live provider smokes >` tiingo / coingecko / fred / openfigi (4 tests)                        | no market-data key in the shell                                                           |
| `api-db`             | `plaid-sandbox.test.ts > links a real Sandbox Item through /connections/plaid/exchange…`       | no Plaid creds in the shell                                                               |
| `api-db`             | `market-data-routes.test.ts > a live test fetch reaches the provider through the egress guard` | `it.runIf(LIVE)`                                                                          |
| `api-db`             | `notifications-delivery.test.ts >` real ntfy push / real SMTP send (2 tests)                   | dev-sinks not up (`127.0.0.1:2586`/`:1025` refused) — **gate input (4), exercised in §3** |

**The 70 numeric-boundary exemptions — ruling: accepted.** `--explain` lists every one
with its reason. By class: Argon2id `timeCost` (14), generic `value`/`values`
**parameter** bindings (17 — the same name as a _property_ stays a violation), counts
and cardinalities (`…Unvalued`, `…Rows`, `…Calls`, `priceRowsWritten`,
`unvaluedTransfers`, `seedPriceSourcePriority`'s return, …), dimensionless statistics
(`amountCv`, `amountMape`, `priceChangeRecall`, …), provider rate-limit credits
(`cost` ×4), a CUSIP check-digit `charValue`, a CSV column index, a sign, a month index,
`QUANTITY_SCALE`/`QUANTITY_PRECISION`. I read the four the evidence flags hardest
(`plaid/src/amount.ts:value`/`plaidAmount`, `plaid/src/map.ts:value`,
`insights/src/validate/decimal.ts:value`) — each is the one float→decimal seam for a
provider wire format that _is_ a JSON number, which is where such a seam must live.
**One residual blind spot, recorded as observation O-1 (Info):** the `value`-as-parameter
class is exempt by name shape, so a future `function f(value: number)` that really is a
price would pass. The check is syntax-only by design (wp3.14-quality §7); the class is
defensible and the gate does not ask for it to change.

**Comparison with the evidence.** No Phase 3 evidence doc claims a whole-tree count:
wp3.14-quality §10.4 records that the last local `just verify` (at `e03fdb8`) stopped at
Playwright under load and that gitleaks/license/hardening/trivy ran only on CI. **This
gate's run is therefore the first complete local `just verify` of the Phase 3 tree**, and
it is green end to end. The partial counts the evidence does claim are consistent with
it: 40 projects / 25 `test` / 16 `migration-test` (wp3.14-quality §9 and here);
numeric-boundaries 689 files / 0 violations / 70 exempt (§10.4 and here, identical). The
6 credential-gated skips wp3.14a names are the same six named above. CI on the real
GitHub runner is **13/13 green at `b38c586`**, the same code (execution log 2026-09-25
00:50). wp3.14-quality §8 item 2 (the three Phase 3 Playwright specs invisible to CI) is
**closed at HEAD**: `apps/web/playwright.config.ts:78`'s chromium `testMatch` names
`investments|networth|market-data`, and they ran in the 41 above.

**Verdict — Standard A: PASS.** Section COMPLETE.

---

## 2. Sabotage log (Standard B)

_COMPLETE._

**Method.** Every control below was broken by this gate in the _source_ (or, where the
control lives in a migration, in the migration file a scratch database is built from),
never in the test. A small harness outside the repo (`/tmp/gate3/sab.py`) reads each
file's bytes, applies the edit only if the old text matches exactly once, runs the
targeted suite, then writes the original bytes back, asserts byte equality and runs
`git diff --quiet` on the file. Every row's restore printed `git diff clean: True`. No
`git checkout`/`stash` was used. **"Red first try"** = red on the first _valid_
attempt; an attempt that did not apply (text not found) is not a valid attempt and is
recorded where it happened.

### 2.1 The §5 item 4 "never" list

| #       | Never                                   | Sabotage (source, not test)                                                                                                                                       | Observed                                                                                                                                                                                                                                                                                                                                                                  | Red first try |
| ------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| S-Q1    | a quantity never becomes a float        | `investments/src/lots-store.ts`: `Quantity.fromDatabaseString(row.quantity)` → `Quantity.of(String(Number(row.quantity)))`                                        | `investments-db` `× 0.00000001 BTC survives a database round trip`, `× every NUMERIC(38,18) boundary value round-trips exactly` — 2 failed / 242                                                                                                                                                                                                                          | yes           |
| S-Q2    | (same, the engine's weight)             | `investments/src/lots.ts` `quantityWeight`: `BigInt(…replace('.', ''))` → `BigInt(Math.round(Number(…) * 1e18))`                                                  | `investments` `× round-trips any 18-decimal quantity through the weight and back` — `expected 159718324709781696n to be 159718324709781697n` (the float lost the last unit)                                                                                                                                                                                               | yes           |
| S-FX1   | a missing FX rate never defaults to 1.0 | `investments/src/fx.ts`: the terminal `throw new FxRateUnavailable(…)` → `return { rate: '1', source: 'fred', … }` (a par rate dressed as a provider observation) | `investments` 4 red (`× a missing FX rate is an explicit error, never 1.0`, `× never returns 1 for a pair it has no observation for`, `× does not cross via USD…`, `× SABOTAGE: a reader that fell back to 1.0…`); **and over HTTP**: `api-db` `× POST /net-worth/corrections surfaces planning.fx_rate_missing rather than defaulting to 1.0` — `expected 200 to be 409` | yes           |
| S-FX2   | (same, planning's provenance guard)     | `planning/src/fx.ts` `assertRateIsAnObservation`: `if (quote.source === 'identity')` → `if (false)`                                                               | `planning` `× refuses a reader that answers the identity for a genuine cross pair` — `promise resolved … instead of rejecting`; `× allows the identity only when the two codes are literally equal`                                                                                                                                                                       | yes           |
| S-SEAL1 | a sealed net-worth day never changes    | `planning/src/store.ts` `markDirty`: `AND sealed_at IS NULL` deleted (the "simplified WHERE" a late balance would take)                                           | `planning-db` `× marks the open day dirty and leaves a sealed day alone` — the database refused: `23514`, constraint `net_worth_daily_sealed_rows_are_immutable`                                                                                                                                                                                                          | yes           |
| S-SEAL2 | (same, the database guard alone)        | `0017_net_worth_daily.sql` trigger: `IF OLD.sealed_at IS NOT NULL THEN RAISE` → `IF false THEN RAISE`                                                             | `planning-db` `× SABOTAGE: lets the writer update a sealed row, and the database refuses by name` — `expected 'net_worth_daily_net_is_assets_minus_l…' to be 'net_worth_daily_sealed_rows_are_immut…'` (the row was still refused, by a _different_ CHECK; the test names the constraint, so it saw the trigger die)                                                      | yes           |

S-SEAL1/S-SEAL2 are the unit half; the stack half the dispatch asks for (snapshotter run
twice over live data, sealed range diffed byte for byte) is in §3.

### 2.2 Gate input (2) — WP 3.4's `allowedSchemes` "honest gap"

Three sabotages, run to decide whether this is a doubled control or a missing test:

| #       | Sabotage                                                                                           | Observed                                                                                                                                                                                                                    |
| ------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S-SCH-a | `integrations/src/egress.ts`: `allowedSchemes: ['https']` → `['https', 'http']` (WP 3.4's own B)   | `integrations` egress suite **17/17 green** — reproduced WP 3.4's observation exactly                                                                                                                                       |
| S-SCH-b | `platform/src/egress/policy.ts` `checkUrl`: `if (scheme !== 'https')` → `if (false)`, nothing else | **red in both consumers**: `integrations` `× one host per adapter > only https, only 443` **and** `notifications` `× the refusal matrix holds for every class of destination` — `cleartext http: expected true to be false` |
| S-SCH-c | both at once                                                                                       | `integrations` `× only https, only 443`                                                                                                                                                                                     |

**What S-SCH-b shows that WP 3.4 could not see from inside its package:** `checkUrl`
calls `checkDestination({ scheme: 'https', … })` with a **literal** `'https'`, so on the
`guardUrl` path — the only path `@ctx/integrations/src/http.ts` uses — `allowedSchemes`
is never consulted with the URL's real scheme at all. It is not a second layer that
masks the first; it is inert on this path, and `checkUrl`'s pin is the single control.
That single control **does** have a red test in the market-data suite itself (S-SCH-b).
Ruling in §5.

### 2.3 Gate input (6) — WP 3.14a's merge, in the mirror order

WP 3.14a reproduced the transaction-fact merge in one order only (a ticker sighting
first, a FIGI+ticker transaction-only sighting second). This gate added a **temporary**
`it` block to `apps/api/test/db/phase3-wiring.test.ts` (same describe, same harness,
fresh ids `G3MIR` / `BBG000G3M101`; the text is kept at `/tmp/gate3/mirror-block.ts`
during the run, and the test file was restored byte-for-byte afterwards, `git diff`
clean), in the **mirror** order: a Plaid Item with no holdings whose only sighting of
the security is one investment transaction naming it by FIGI **and** ticker, synced and
resolved **first**; then a later, weaker, ticker-only sighting from a different provider
(`manual`). Asserts one `securities` row, identity `figi`, ticker and FIGI both on it,
and zero merged rows ("never split", not "split and healed").

| Run                                                                                                                                                                | Result                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mirror, fix in place                                                                                                                                               | **green** (and 3.14a's own test green beside it) — `Tests 2 passed`                                                                                                                                                   |
| Mirror, with 3.14a reverted (`plaid/src/map.ts`: `security: securityFact` → the fact narrowed to `[strongestIdentifier(…)]`, i.e. the pre-3.14a single identifier) | **both red**: 3.14a's `× …still merges with an earlier ticker-only sighting` — `expected [ {…}, {…} ] to have a length of 1 but got 2`; the mirror `× GATE3 mirror…` — `mirror order: one security, not two: … got 2` |

The fix is symmetric, as WP 3.14a predicted, and the mirror test discriminates: it is
red exactly when the defect is present. Ruling in §5.

### 2.4 Securities identity, Coinbase, watch-only wallets

| #      | Control                                                                                 | Sabotage                                                                                                                                                                                                                         | Observed                                                                                                                                                                                                                                                                                                                                                  | Red first try  |
| ------ | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| S-R1   | an unmapped security never becomes two rows                                             | `investments/src/resolver.ts`: look up existing rows by the **strongest** identity key only, not the whole identifier set                                                                                                        | 5 red incl. `× ETH as a Coinbase ticker, a chain+contract and a brokerage CUSIP resolve to one securityId` and `× two identifiers for one security never create two rows`                                                                                                                                                                                 | yes            |
| S-R2   | a provider id is evidence, never the identity (D25)                                     | `investments/src/identifiers.ts`: a `proprietary` id canonicalised with `identity = true`, its abstention dropped                                                                                                                | `× a provider identifier never becomes the identity`; `× an unresolvable identifier fails loudly and emits SecurityResolutionFailed rather than minting a row`                                                                                                                                                                                            | yes            |
| S-CB1  | a trade-capable CDP key never reaches the API                                           | `coinbase/src/connector.ts` `#assertViewOnly`: `if (forbidden.length > 0)` → `if (false)` — i.e. the connector is handed a key claiming `can_trade`/`can_transfer` and no longer refuses it                                      | 5 red: `× a key claiming can_trade is refused at startup`, `× …and again before a sync, not only at boot` (`listAccounts did not re-check the key`), `× a key with can_trade is refused before any data call` (`['key_permissions', …(13)]` — thirteen data calls were made), `× refuses can_transfer…`, `× health reports the scope refusal by throwing` | yes            |
| S-CB2  | no trading endpoint is reachable                                                        | `coinbase/src/client.ts` `assertReadOnlyPath`: `if (isReadOnlyPath(path)) return;` → `return;`                                                                                                                                   | 6 red: `× refuses to build a request that would place an order` / cancel a batch / edit an order / move funds between portfolios / preview an order / close a position                                                                                                                                                                                    | yes            |
| S-CB3  | an on-ramp deposit is a transfer                                                        | _invalid attempt — my error_: I sabotaged the **withdrawal** branch of the `providerCategory` ternary, not the deposit. It was still caught (`× reports a genuine withdrawal as a transfer out`) but it is not the control named | —                                                                                                                                                                                                                                                                                                                                                         | (not counted)  |
| S-CB3b | (same, the deposit branch)                                                              | `coinbase/src/ledger.ts`: inflow `providerCategory` → `GENERAL_MERCHANDISE`                                                                                                                                                      | `× a USD deposit followed by a BTC buy yields one transfer, one trade and zero spending`, `× a fiat deposit is a transfer, never income`                                                                                                                                                                                                                  | yes            |
| S-CB4  | the CDP JWT is EdDSA, not ES256                                                         | `coinbase/src/provider.ts`: `CDP_JWT_ALGORITHM = 'ES256'`                                                                                                                                                                        | `× a JWT is EdDSA, expires in 120 s and is bound to one method and path` — `expected 'ES256' to be 'EdDSA'`                                                                                                                                                                                                                                               | yes            |
| S-CB5  | the on-ramp's second hop: `TRANSFER_IN_ACCOUNT_TRANSFER` → `transfers.between_accounts` | _invalid attempt — my error_: mapped it to `shopping.general`, which is not a real leaf; red only on "every code maps to an assignable leaf"                                                                                     | —                                                                                                                                                                                                                                                                                                                                                         | (not counted)  |
| S-CB5b | (same, a real spending leaf)                                                            | `categorization/src/pfc-map.ts`: `TRANSFER_IN_ACCOUNT_TRANSFER` → `shopping.other_shopping`                                                                                                                                      | **GREEN.** `categorization`, `categorization-db`, `connector-coinbase`, `budgeting`, `api` — 532 passed; `api-db` reports-aggregation + categorization-wiring — 5 passed. **No test in the tree fails when a Coinbase on-ramp deposit is categorised as shopping.** → finding **G3-3**                                                                    | **no — green** |
| S-W1   | a watch-only connector never accepts private material                                   | `walletrpc/src/guard.ts` `assertNoPrivateMaterial`: `if (kind === null) return;` → `if (kind === null \|\| true) return;`                                                                                                        | 7 red: WIF, xprv, yprv, zprv, 12-word seed, raw 32-byte hex, `0x`-prefixed hex                                                                                                                                                                                                                                                                            | yes            |

### 2.5 Routes: scope, step-up, key presence

| #     | Control                                   | Sabotage                                                                               | Observed                                                                                                                                                                                                                                         | Red first try |
| ----- | ----------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| S-S1  | the WP 3.14a S1 test (`holdings.user_id`) | `routes/investments.ts` `readHoldings`: `WHERE h.user_id = …` → `WHERE true`           | `× a holding whose security belongs to another user is visible to neither` — `expected 3 to be 2`; the other 14 route tests green — WP 3.14a's observation reproduced exactly                                                                    | yes           |
| S-S1m | the mirror: `securities.user_id` alone    | `readHoldings`: `AND s.user_id = …` dropped from the join, `h.user_id` kept            | **red** — `× …visible to neither` — `the planted row is not the planter's to see either: … got 1`. WP 3.14a §4 said its test "does not, by itself, prove `securities.user_id` is" load-bearing; it does — the planted row covers both predicates | yes           |
| S-SU1 | step-up on `PUT /market-data/priority`    | `routes/market-data.ts`: `requireFreshSession` → `requireSession`                      | `× reordering the ladder needs a step-up assertion…`, `× the settings response contains no API key value` (it drives the 403 case too) — `expected 200 to be 403`                                                                                | yes           |
| S-K1  | key presence, never a key value           | settings response gains an **undeclared** `keyHint` field carrying a 6-char key prefix | green — see note                                                                                                                                                                                                                                 | (probe)       |
| S-K2  | (same, into a **declared** string field)  | the prefix appended to the `provider` field                                            | red — but because renaming the provider broke the test's provider lookup, not because it matched the prefix. **Not counted as evidence either way.**                                                                                             | (probe)       |

S-K1/S-K2 are probes of the test's _strength_, not of the control, and are not in the
count. S-K1 stayed green because the route's Zod response schema **stripped** the
undeclared field before serialisation — a third layer beside "no field can hold a key"
and `ApiKey`'s `[redacted]` rendering. Whether the exit test would catch a _partial_
key smuggled into a declared string field was not established (S-K2 went red for an
incidental reason). Recorded as observation O-2 (Info).

### 2.6 WP 3.13's seven controls (gate input 3 — `wp3.13-carryovers.md` §4)

No surviving sabotage record existed for any of these. All eight rows below (item 1 was
split into its root fix and its wiring) were run by this gate.

| #      | 3.13 item                                    | Sabotage                                                                                                | Observed                                                                                                                                                                                                               | Red first try                                                                                                                                    |
| ------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| T13-1  | 1 — C-1 root fix (`seedUserState`)           | `bootstrap-seed.ts`: `ensureTaxonomy(…, { userIds: [options.userId] })` → `userIds: []`                 | `× a user created after boot has taxonomy, advisors and schedules with no restart and no lazy repair` — `expected +0 to be 153`                                                                                        | yes                                                                                                                                              |
| T13-1b | 1 — C-1 wiring (`bootstrap-user` calls it)   | `bin/bootstrap-user.ts`: the `seedUserState(…)` call replaced by a stub returning zeros                 | `× calls seedUserState right after createPrimary, not only through the api onReady pass`                                                                                                                               | yes                                                                                                                                              |
| T13-2  | 2 — both lazy repairs are gone               | the old `ensureTaxonomy`-on-GET lazy repair **re-added** to `routes/categories.ts`                      | `× a user inserted straight into users after boot reads an empty chart, not a lazily-repaired one` — `… got 153`. The repair cannot be re-introduced silently                                                          | yes                                                                                                                                              |
| T13-3  | 3 — C-5 dirty-on-create                      | `routes/budgets.ts`: the `markDirtyFrom(…)` call before `recomputeDirty` removed                        | `× a line created mid-period, after its category was already spent in, comes back dirty-recomputed with no extra call` — `expected { minor: '0' } to deeply equal { minor: '-5000' }`                                  | yes                                                                                                                                              |
| T13-4  | 4 — `?statuses=pending_review`               | `routes/insights.ts` `statusList`: the `z.union([enum, array])` → bare `z.array(enum)`                  | `× the pending_review filter returns exactly the queue the inbox needs`                                                                                                                                                | yes                                                                                                                                              |
| T13-5  | 5 — `?encrypt=true` never downgrades         | `bundle.ts`: **both** refusal branches → return plaintext (recipients file absent; `age` binary absent) | `× AgeUnavailableError names the recipients file, not a bare ENOENT` — `promise resolved "Buffer[…]" instead of rejecting`. The whole file was run (3 tests), incl. the wrong-identity test WP 3.13 never ran — green  | yes                                                                                                                                              |
| T13-5b | 5 — isolated: the `age`-not-on-`PATH` branch | `bundle.ts`: only `ENOENT` → `resolve(Buffer.from(plaintext))`, recipients file present                 | **GREEN — 3 passed.** Nothing tests that a missing `age` binary refuses rather than returning plaintext, and the production api image **has no `age` binary** (§3), so this is the branch production takes. → **G3-4** | **no — green**                                                                                                                                   |
| T13-6  | 6 — module-flag defaults pinned              | `platform.ts`: `module.notifications` `defaultEnabled: true` → `false`                                  | `× every documented module flag exists with its documented default…` — `module.notifications default changed from the documented value`                                                                                | yes                                                                                                                                              |
| T13-7  | 7 — merchant-token construction pinned       | `snapshot/tokens.ts` `deriveTokenKey`: label `personalfi/v1                                             | advisor-tokens`→`v2`                                                                                                                                                                                                   | 3 red: `× deriveTokenKey is pinned…`, `× a merchant token is pinned…` (`MERCHANT_eb4f916afb51` vs `MERCHANT_f17df14b9b54`), `× ref() is a uuid…` | yes |

### 2.7 Wiring guards and the two CI checks

| #     | Control                                                  | Sabotage                                                                                                                                                                                      | Observed                                                                                                                                                                                                                                                 | Red first try  |
| ----- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| S-MF1 | a module flag off registers nothing (Phase 3 modules)    | `platform.ts` `resolveModules`: the `isEnabled` answer is recorded but the `continue` is removed (the Phase 2 S-W1 shape)                                                                     | 3 red: Phase 2's `× a module flag off registers no consumer, no job…`, and Phase 3's `× registers every event @ctx/investments and @ctx/integrations define`, `× a flag that is off contributes no event, no consumer, no job and no schedule` — `got 6` | yes            |
| S-SN1 | schedule names match the DB CHECK (the crash-loop shape) | `modules.ts`: `PRICE_REFRESH_SCHEDULE_NAME = 'integrations.price-refresh'` (hyphen)                                                                                                           | 3 red incl. `× every schedule and job name matches the CHECK constraint the database itself carries`                                                                                                                                                     | yes            |
| S-P1  | `assertPoolCoversLeases`                                 | `worker.ts`: `if (poolMax > pinned) return;` → `if (poolMax > pinned \|\| true) return;` (the check never speaks)                                                                             | **GREEN — `api` 75/75.** The only test (`regate-worker-boot.test.ts`) asserts that the **string** `assertPoolCoversLeases` appears in `worker.ts`. → **G3-5**                                                                                            | **no — green** |
| S-P2  | the pinned-connection reservation itself                 | `worker.ts`: `WORKER_PINNED_CONNECTIONS` per-consumer term `MODULE_FLAGS.length` → `0 * MODULE_FLAGS.length` (reintroduces the wiring-batch deadlock arithmetic: 5 reserved for 5 + 7 pinned) | **GREEN — 75/75.** The regex test matches the text `DATABASE_POOL_MAX + WORKER_PINNED_CONNECTIONS` and never evaluates the constant. → **G3-5**                                                                                                          | **no — green** |
| S-M19 | 0019 scope-check registration test                       | `0019_snapshot_grant_scopes_v1_1.sql`: `'market.rates'` dropped from the widened CHECK                                                                                                        | `× every advisor scope can actually be granted, or is a recorded migration gap` — `expected [ 'market.rates' ] to deeply equal []`                                                                                                                       | yes            |
| S-QC1 | `check-ci-projects` catches a dropped project            | `ci.yml`: `--project investments-db` removed                                                                                                                                                  | `FAIL — 'investments-db' is declared in vitest.config.ts but appears in neither ci.yml job's --project list`, exit 1                                                                                                                                     | yes            |
| S-QC2 | `check-numeric-boundaries` catches a float price         | `integrations/src/market-data.ts`: `export const lastClosePrice: number = 232.35;`                                                                                                            | `FAIL — 1 violation(s) in 689 file(s)`, exit 1                                                                                                                                                                                                           | yes            |
| S-QC3 | (same, `toFixed` on a quantity)                          | `investments/src/lots.ts`: a `formatQuantity(quantity) { return quantity.toFixed(2) }` added                                                                                                  | `FAIL — 1 violation(s)`, exit 1                                                                                                                                                                                                                          | yes            |

### 2.8 Domain controls, one or more per remaining work package

| #     | WP        | Control                                                  | Sabotage                                                                                                                                                                                                         | Observed                                                                                                                                                                                        | Red first try |
| ----- | --------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| S-L1  | 3.2       | wash-sale window is 61 days, day 31 outside              | `wash-sale.ts`: `<= WASH_SALE_WINDOW_DAYS` → `<= WASH_SALE_WINDOW_DAYS + 1`                                                                                                                                      | `× a repurchase on day 30 after a loss is flagged POSSIBLE_WASH_SALE and one on day 31 is not`                                                                                                  | yes           |
| S-L2  | 3.2       | unknown basis is `unavailable`, never zero               | _invalid attempt_: I broke `costBasisOf`'s **second** null check (line 160), which is unreachable because line 156 already returns `unavailable` for every null-basis lot — a dead guard, green, not the control | —                                                                                                                                                                                               | (not counted) |
| S-L2b | 3.2       | (same, the live guard)                                   | `basis.ts` `costBasisOf`: both null checks removed                                                                                                                                                               | `× an unknown basis yields unavailable, not zero`, `× a lot with unknown basis reports unrealized gain as unavailable, never zero`                                                              | yes           |
| S-A1  | 3.3       | the allocation denominator includes cash                 | `analytics/allocation.ts`: the total skips cash-equivalent holdings                                                                                                                                              | 13 red incl. **`× allocation matches the committed spreadsheet fixture to the cent`** and the seed's `× …rebuilt from seed shapes`                                                              | yes           |
| S-A2  | 3.3       | drift band is an absolute 5 points                       | `analytics/drift.ts`: `points('5')` → `points('4')`                                                                                                                                                              | `× a 4.9-point gap proposes nothing and a 5.1-point gap proposes a trade`                                                                                                                       | yes           |
| S-NW1 | 3.10      | `networth.summary` rounded to $100                       | `snapshot/builder.ts`: `net_worth` rounded to 1 minor unit                                                                                                                                                       | `× networth.summary rounds to $100…` — `expected '262350' to be '260000'`                                                                                                                       | yes           |
| S-I1  | 3.10      | I1 withholds above 10% unclassified                      | `investing/allocation.ts`: the `unclassified_pct > threshold` guard → `false &&`                                                                                                                                 | `× I1 withholds when unclassified exceeds 10 percent`, `× the ceiling is a tenth, and the comparison is strictly greater`                                                                       | yes           |
| S-M1  | 3.10a     | `holdings.aggregate` minimisation                        | `snapshot/builder.ts` `#holdingsAggregate`: `quantity: '12.5'` added to each top position                                                                                                                        | `× emits no securityId, no account id, no quantity and no cost basis` — `not to contain 'quantity'`; and the published schema refuses it (`unrecognized_keys: ["quantity"]`)                    | yes           |
| S-NW2 | 3.8       | an investment account is never backfilled by subtraction | `interpolate.ts`: `investment: 'quantity_times_price'` → `'transaction_subtraction'`                                                                                                                             | 7 red incl. `× an investment account is never backfilled by the transaction-subtraction path` and the hand-computation reconcile                                                                | yes           |
| S-UI1 | 3.12/3.14 | CoinGecko attribution where a crypto price is            | `HoldingsTable.tsx`: the attribution block gated `false &&`                                                                                                                                                      | web `× renders the CoinGecko attribution on the holdings tab because BTC is coingecko-priced`. (My Playwright half of this row failed to launch under the harness's command line; not claimed.) | yes           |

Gate input (1) was also probed here, as a sabotage in the opposite direction:
**INPUT-1** gave `createInsightsInvestmentsPort` the source it lacks
(`domain.ts`: `targets: []` → a real two-class target set). Result:
`× the investing rules with no field behind them are silent, and it is these three` —
`builtin.investing.drift unexpectedly fired: expected 2 to be +0`. Given a target, I1
proposes two drift insights over the real synced portfolio; its silence at HEAD is the
missing source, not a broken rule. Ruling in §5.

### 2.9 Scorecard

| Group                              | Valid sabotages | Red first valid attempt | Green (no test existed) |
| ---------------------------------- | --------------- | ----------------------- | ----------------------- |
| §2.1 the "never" list              | 6               | 6                       | —                       |
| §2.2 scheme (the load-bearing pin) | 1               | 1                       | —                       |
| §2.3 mirror-order merge            | 1               | 1                       | —                       |
| §2.4 identity / Coinbase / wallet  | 8               | 7                       | S-CB5b                  |
| §2.5 routes                        | 3               | 3                       | —                       |
| §2.6 WP 3.13's seven               | 9               | 8                       | T13-5b                  |
| §2.7 wiring guards + CI checks     | 8               | 6                       | S-P1, S-P2              |
| §2.8 per-WP domain controls        | 9               | 9                       | —                       |
| **Total**                          | **45**          | **41**                  | **4**                   |

**41 of 45 controls went red on the first valid attempt. Four did not, and each is a
finding, not a pass** (G3-3, G3-4, G3-5 in §4): the on-ramp's categorisation hop, the
`age`-absent branch of the encrypted export, and both halves of the worker pool guard.
In each case the control's _code_ is present and correct at HEAD — what is missing is
any test that fails when it is removed, which is the Phase 1 lesson's exact shape
("computed on the half somebody was looking at").

Not counted, and listed so the count is not flattered: three invalid attempts that were
my own errors (S-CB3 hit the withdrawal branch; S-CB5 used a non-existent leaf; S-L2 hit
a dead duplicate guard), each re-run correctly; four probes (S-SCH-a, S-SCH-c, S-K1,
S-K2) and INPUT-1, which test a claim rather than a control. **This gate wrote no new
permanent test**; the only test text it added (the mirror block, §2.3) was temporary and
is not in the tree.

Two §2 items are completed on the live stack in §3 rather than here: the seal diff
over a real snapshotter run, and WP 3.4's egress refusals re-run from inside the worker
container.

_Section §2 COMPLETE (the two stack halves are recorded in §3)._

---

## 3. The cold walk (Standard C)

_COMPLETE. (Teardown is recorded in §7.)_

### 3.1 Procedure and boot

- HEAD at walk start: `73db109` (one execution-log line past `dba6270`; `git diff --stat
dba6270 HEAD` = `docs/plan/01-execution-log.md | 1 +`). The code is `9fb4191`'s.
- `docker compose down -v` (no stack was up), then `docker compose build` from this tree
  (api, proxy, backup images rebuilt, 62 s), then `docker compose up -d --wait`.
- RUNBOOK "First install" step 8's seven Phase 3 provider-key files did not exist on this
  host, and Compose refuses to start a service that mounts a missing secret file. They
  were created **empty**, mode 0444, exactly as step 8 prescribes (`tiingo_api_key`,
  `fred_api_key`, `coingecko_api_key`, `openfigi_api_key`, `coinbase_key_name`,
  `coinbase_private_key`, `etherscan_api_key`) — so this walk is a **zero-provider-key
  install**, the posture dispatch §6 Q1 says Phase 3 must complete in. They are removed
  at teardown. No secret value was read or printed; `ls -ln` metadata only.
- A throwaway `compose.override.yml` sets `PLAID_ENABLED: 'true'` on proxy/api/worker
  (the CSP widening for the Plaid leg, C-2), as `compose.override.example.yml` documents.
  Removed at teardown.

| Observation                                                                                                          | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `migrator`                                                                                                           | exit 0, `migrations complete: 19 applied, 0 already present` (…`0017_net_worth_daily`, `0018_connection_sync_facts`, `0019_snapshot_grant_scopes_v1_1`)                                                                                                                                                                                                                                                                                                                                                                                                                               |
| services                                                                                                             | db, api, worker, proxy, backup all `healthy` within 19 s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| worker at boot (13:57:53Z), no holder yet                                                                            | `"no account holder yet; the worker will idle until one is enrolled"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `just bootstrap-user name="Gate Three Holder" timezone="America/New_York"` (13:58:20Z, ran inside the api container) | `taxonomy 153 categories seeded`, `advisors 31 manifests registered`, `schedules categorization.retrain_weekly, notifications.deliver, notifications.digest, insights.nightly, integrations.price_refresh, planning.net_worth_snapshot`, `key custody unlocked · argon2id m=1048576 KiB t=4 p=4 · 5969 ms`. The enrolment token is not recorded here.                                                                                                                                                                                                                                 |
| **worker, unprompted, 13:58:23Z**                                                                                    | **the worker process exited with code 0 and Docker restarted it** (`RestartCount=1`, `FinishedAt 13:58:23.196Z`, `StartedAt 13:58:23.399Z`, no `shutting down` line — it was not signalled). The restarted process found the holder and logged `modules resolved` with **all 10 modules enabled, `disabled: []`**, 7 consumers (`…investments.lots@v1`, `planning.net_worth@v1`), job kinds including **`integrations.price_refresh`** and **`planning.net_worth_snapshot`**, `scheduler leadership acquired`, `worker ready`. This gate issued no restart. → **finding G3-1**, below |
| api                                                                                                                  | `RestartCount=0`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `schedules` (psql)                                                                                                   | 7 rows; `integrations.price_refresh` next `2026-09-27 07:45Z` and `planning.net_worth_snapshot` next `08:00Z` = 03:45 / 04:00 `America/New_York` — the holder's zone, not the container's                                                                                                                                                                                                                                                                                                                                                                                             |

**What G3-1 is, measured.** In the no-holder branch `worker.ts` builds no pump, runner or
scheduler; its only timer is the idle heartbeat, which is `unref()`'d; and `@core/db`'s
pool has `idleTimeoutMillis: 30_000`. Thirty seconds after boot the last idle client
closes, nothing holds the event loop, `main()` has already returned, and Node exits 0.
Compose's restart policy starts it again; each restart re-reads `users`. The worker booted
at 13:57:53Z and exited at 13:58:23Z — thirty seconds, to the millisecond budget of the
pool timeout. So the RUNBOOK order (`just up`, then `just bootstrap-user`) works **by an
accidental exit-and-restart loop at ~2/min while no holder exists**, not by the "idle
until one is enrolled" the log line and the code comments describe; the idle heartbeat
design (D-3, a fresh `idle.heartbeat` so the healthcheck stays green) never governs
anything longer than 30 s. Consequences: a cold install **cannot** satisfy "no restart
anywhere" (this walk's `RestartCount=1` is the worker's own, and it would be higher the
longer an operator waits before bootstrapping); on any runtime without a restart policy
the worker simply stops. wp3.w §9.4 saw the same symptom and restarted by hand, recording
it as intended behaviour. It is recorded here as a finding (§4) rather than fixed in
place: the correct fix (poll for the holder in the idle branch and then run the same
start-up path without returning from `main()`) restructures `main()` and has no
behavioural test seam today — see C-1 of §6.

### 3.2 Step 1 — passkey enrolment through Caddy, cold cookie jar

Playwright (`@playwright/test` 1.62.1's Chromium) with a real CDP virtual authenticator
(ctap2/internal, resident key, UV, backup-eligible — the Phase 1/2 pattern), a fresh
persistent profile, `--host-resolver-rules=MAP personalfi.lan 127.0.0.1`, TLS through
Caddy's internal CA on `127.0.0.1:443`.

- The first ever visit to the printed `/register#token=…` link: `GET
/api/auth/unlock-state 200`, `POST /api/auth/register/options 200`, `POST
/api/auth/register/verify 200`; **zero 403s**; heading "Add a backup passkey / You're
  all set". `GET /api/auth/session` → 200, `authMethod: webauthn`, `fresh: true`.
  Screenshots `gate-01-register.png`, `gate-02-enrolled.png`.
- **Phase 2 condition C-6 (cold-start CSRF): did not reproduce**, observed first-hand
  on a genuinely cold install — the claim in `cold-start.spec.ts`'s header that WP 3.13
  could not verify is now verified.
- Every later step signs in through `/login` → "Sign in with a passkey" with the same
  virtual credential (exported with `WebAuthn.getCredentials` after enrolment, re-imported
  per run). One incidental observation, recorded because it is a control observed
  working: re-importing the credential at a stale sign counter produced `POST
/api/auth/login/verify 401 invalid_credential` — the server refuses an assertion whose
  counter did not advance (clone detection). The counter was advanced and the walk
  continued.

### 3.3 Step 2 — the committed spreadsheet fixture, loaded into the live stack

The walk needs portfolio data; a zero-key install has no price source and no brokerage.
So the **committed spreadsheet fixture** (`packages/contexts/investments/test/fixtures/
allocation-portfolio.csv` — WP 3.3's, expectations computed by an independent Python
`decimal` implementation, provenance in wp3.14-quality §4) was loaded exactly the way
`apps/api/test/db/investments-routes.test.ts` seeds (wp3.9 §8 item 6): the three
accounts over HTTP, `POST /api/connections` `provider: manual` (201, from the browser
session, step-up fresh); the 10 securities, 11 holdings and 10 prices by SQL through
`docker compose exec db psql`, writing only rows the real writer would (decimal-string
quantities, `NULL` basis for BTC rather than 0, `tiingo`/`coingecko`/`user_override`
sources — never `last_known` — and staleness driven only by `observed_at`: OLDCO observed
48 h ago, everything else 5 min ago). BTC needed `chain='bitcoin'`: the first insert was
refused by `securities_crypto_names_its_chain`, which is itself a control observed
working.

### 3.4 Step 3 — holdings with a price and a staleness label; allocation vs the spreadsheet

**API, compared row by row against `allocation-expected.csv`:** `GET
/api/investments/allocation?basis=last_known` and `?basis=as_of_now`, every expected
row on all three dimensions — **37 rows compared on value to the cent AND weight to
10 dp: 0 mismatches.** `last_known` total `17649960` minor ($176,499.60); `as_of_now`
total `17444960` ($174,449.60) with `excluded: [{ symbol: "OLDCO", reason:
"stale_price" }]` — the $2,050.00 difference the fixture's header predicts;
`unclassifiedPct` `0.0174504645` / `0.0176555292`; `includesCash: true`.

**Browser** (`gate-04-investments-holdings.png`, `gate-05-investments-allocation.png`):

- Holdings: every row carries a price (`228.5200000000 USD` …); OLDCO carries a
  visible **`STALE`** badge and its market value reads _"unavailable (price unknown)"_
  on the as-of-now basis; BTC's cost basis reads _"unavailable (cost basis unknown)"_,
  never `$0.00`; VTI shows "2 accounts" (one security held in two accounts, aggregated).
- Allocation: the donut's legend reads US equity 43% $74,250.80, US bonds 20%
  $34,632.00, Crypto 11% $19,870.60, International developed equity 11% $19,055.38, Cash
  7.2% $12,500.00, Real estate 3.2% $5,539.80, Emerging-market equity 3.2% $5,521.02,
  Unclassified 1.8% $3,080.00 — **every dollar figure equal to the spreadsheet's
  `as_of_now` row**; "% unclassified 1.8%" beside it; "Left out of this total (1) —
  OLDCO — the price is stale"; each slice carries a pattern as well as a hue (D20).
- **"Data provided by CoinGecko"** is present on the holdings and allocation screens,
  where BTC (a `coingecko`-sourced price) appears. It renders a generic `Coins` glyph
  rather than CoinGecko's logo — a documented choice in `Attribution.tsx`'s header, whose
  stated reason (a CSP `img-src` entry) does not apply to a self-hosted asset. → **G3-8
  (Low)**.
- Cosmetic, not findings: quantities render at the full 18 dp (`90.000000000000000000`)
  and prices at 10 dp.

### 3.5 Step 4 — scheduled work on the real scheduler (C-3, and dispatch §5 item 6)

At 14:10:10Z this gate set `next_run_at = now()` on five schedule rows
(`integrations.price_refresh`, `planning.net_worth_snapshot`, `insights.nightly`,
`connections.nightly_sync`, `categorization.retrain_weekly`) — "trigger", as the brief
allows. Nothing else was touched; the worker's own scheduler did the rest.

| Observed                                                         | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| scheduler tick                                                   | all five fired at **14:10:34.136Z** and re-armed to their next cron (`price_refresh` → 2026-09-27 07:45Z = 03:45 ET, `net_worth_snapshot` → 08:00Z, `insights.nightly` → 08:15Z, `connections.nightly_sync` → 07:15Z, `retrain_weekly` → 08:00Z Sunday)                                                                                                                                                                                                                                                                                        |
| unprompted, on their own cron                                    | `notifications.deliver.<user>` ran 14:05Z and 14:10:04Z (`*/5`), `notifications.digest.<user>` ran 14:05:04Z (hourly) — each a `succeeded` job                                                                                                                                                                                                                                                                                                                                                                                                 |
| `categorization.retrain`, `insights.run_all` → 31 `insights.run` | all `succeeded`/settled: `advisor_runs` **25 completed, 6 refused** (`advisor_disabled` — the six that ship off), `domain_events` `insights.AdvisorRunStarted`/`Completed` ×25                                                                                                                                                                                                                                                                                                                                                                 |
| **`integrations.price_refresh`**                                 | `succeeded`, 1 attempt. Worker log `price refresh complete … "priceRowsWritten":0,"sources":[]`; **`domain_events` gained `integrations.PricesUpdated`** `{providers: [], priceRowsWritten: 0, fxRowsWritten: 0, securitiesUnpricedCount: 0}`; `market_data_runs` 0 rows (no request ever left — a refusal-free, key-free run spends nothing, WP 3.4 §3). **A zero-key install degrades without crashing.** The prices on screen are the ones loaded in 3.3; they do not move (no source exists), and the ladder keeps labelling OLDCO `STALE` |
| **`planning.net_worth_snapshot`**                                | `succeeded`; `net_worth_daily` 2026-09-26 revision 1, `source observed`, **`stale_price true`** (OLDCO), `accounts_counted 3`, **`net_worth_minor 17649961`**; `domain_events` `planning.NetWorthSnapshotTaken`. The consumer logged `no open net-worth day to mark; the snapshotter computes it from scratch` on `PricesUpdated` — the documented "mark dirty, never insert a placeholder" path                                                                                                                                               |
| `connections.sync_all`                                           | `succeeded` (the manual connection's scheduled sync → `sync_runs` `transactions success scheduled`)                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| queue latency (observation, not a finding)                       | the price refresh, enqueued 14:10:34Z, ran at **14:16:24Z** — behind the 31-job advisor fan-out, which drained one job roughly every 5 s (the job-runner poll interval). At 03:45 vs 04:15 the two never collide; recorded so nobody reads a six-minute wait as a hang                                                                                                                                                                                                                                                                         |

**Two things this step found.**

1. **The snapshot says $176,499.61; the allocation route and the spreadsheet say
   $176,499.60 for the same holdings.** `planning/src/net-worth.ts` `toMinorUnits`
   rounds **half-up** ("A decimal major-unit string to minor units, half-up away from
   zero"); `@ctx/investments`' valuation and the committed spreadsheet round
   **half-even**, which `planning/src/fx.ts` itself calls the default "the rest of the
   app uses". The fixture has exactly one exact half-cent position — VXUS, 310.5 ×
   61.37 = 19,055.385 → `.39` half-up, `.38` half-even. So two screens of the same app
   disagree by one cent on the same data. The comment above the call also says the
   rounding happens "once, at the end, rather than per position" while the code rounds
   per position. → **G3-6 (Low)**. Criterion (a)'s hand-computation fixture has no
   half-cent, which is why its test cannot see this.
2. The zero-source refresh reports `securitiesUnpricedCount: 0` on an install holding
   ten securities. `providers: []` is truthful; "0 unpriced" undersells it.
   Observation O-4 (Info).

### 3.6 Step 5 — the net-worth chart, and the dashboard hero

`GET /api/net-worth/series?from=2026-09-20&to=2026-09-26` → 200, a **gapless** 7-point
spine: 2026-09-20…25 `netWorth: null, revision 0` (no row — "the day existed and had no
data", never zero), 2026-09-26 `17649961`, `sealed: false`, `stalePrice: true`. The full
view (`gate-11-networth-full.png`) lists Sep 22–25 as "—" and Sep 26 as "$176,499.61 Live
(unsealed)", with a "Sealed history / Live (unsealed)" legend.

**A past date unchanged after a re-run: not observable on this stack, stated plainly.**
`planning.net_worth_snapshot` writes only _today_ (no backfill), and a day seals at 02:00
local the next day, so a same-day cold install has **no sealed day** for a re-run to
disturb. The byte-for-byte proof is therefore run over the seed with a controlled clock
(§3.9). The chart itself draws one point, which renders as no visible line
(`gate-10-dashboard-networth.png`). The full view's caption also reads "Every day in this
window has an observed or corrected value." directly above four "—" days — false on its
face (Low, UI copy, part of G3-2's condition).

**G3-2 (HIGH) — the dashboard's hero net worth is a hard-coded literal.**
`gate-10-dashboard-networth.png` shows **"Net worth +$88,904.00 · +$4,210.00 2.1% this
month"** on an install whose only net-worth row says $176,499.61 and whose ledger read
(`GET /net-worth`) says $0. The figure is `apps/web/src/routes/_app.index.tsx:40–45`:
`<Money value={{ minor: '8890400', currency: 'USD' }} />` and `minor: '421000'` /
`<Percent value={0.021} />`, introduced in the WP 0.x scaffold (`0812909`, 2026-09-12) and
carried untouched through WP 3.12, which added the real chart directly beneath it. Every
install, whatever it holds, has shown the same invented net worth and an invented monthly
gain as the first thing on its front page. No test noticed: the web unit tests never
rendered the dashboard route, and the Playwright specs assert the chart, not the hero.
This is the Phase 1 lesson's exact mechanism — computed on the half somebody was looking
at, hard-coded on the half they were not — on the single most prominent number in a
personal-finance app.

**Fixed in place by this gate — F-1** (one source file + its regression test; the
orchestrator must re-verify it independently, because a gate may not validate its own
fix):

- `apps/web/src/routes/_app.index.tsx` — the literal `StatTile` replaced by an exported
  `NetWorthHero` that reads the **same** `useNetWorthSeriesQuery('p90d')` the compact
  chart reads (one request, shared cache) and shows `latestValued(points)` with "As of
  <date>" (plus "live, may still change" when unsealed). No value yet → "—" and "No net
  worth recorded yet". **No delta at all** — a month-over-month change needs two real
  points and a stated rule, and inventing one is the defect.
- `apps/web/src/routes/-app.index.test.tsx` (new; the `-` prefix keeps it out of the
  route tree, as `-dev.kitchen-sink.test.tsx` does) — `'shows the latest valued day from
GET /net-worth/series, never a literal'` and `'shows no number at all when no day has a
value yet'`.
- **Sabotage of the fix, observed red:** the literal restored into `NetWorthHero` → both
  tests red (`expected 'Net worth+$88,904.00…' to contain '176,499.61'`; `…not to match
/\$\s?\d/`). Restored.
- `tsc -p tsconfig.json` clean; `eslint` clean on both files; `prettier --check` clean;
  web vitest **52 files / 297 tests passed** (was 51 / 295).
- Observed in the browser after rebuilding the proxy image: §3.10.

### 3.7 Step 6 — market-data settings, the watch-only wallet, the private-key refusal

`gate-06-settings-market-data.png`, `gate-07-settings-crypto.png`,
`gate-08-wallet-private-key-refused.png`, `gate-09-wallet-linked.png`.

- `GET /api/market-data/settings` → 200; each provider object has exactly the keys
  `provider, keyPresent, registered, capabilities, budget, attribution` — **no field that
  could hold a key**; all five `keyPresent: false, registered: false` (the zero-key
  install). On screen: FRED's exact sentence _"This product uses the FRED® API but is not
  endorsed or certified by the Federal Reserve Bank of St. Louis."_ (® included) and
  _"Data provided by CoinGecko"_ both present.
- Crypto tab: _"We will never ask for a private key or a seed phrase"_ present.
- **Refusal, live:** BIP32 test vector 1's master **xprv** (a published test vector)
  submitted in the watch-only form → `POST /api/connections` **400**; the refusal names
  private key material; **the xprv is not echoed anywhere on the page**.
- **Link:** BIP84's published test-vector **zpub**, label "Gate3 BIP84 test vector" →
  `POST /api/connections` **201**; `wallet_addresses` 1 row (`bitcoin`, the descriptor,
  the label) — WP 3.9's first-link seam holds on the real stack. The link queued a sync
  to the worker (`wallet_rpc` is not process-local): `sync_runs` `transactions`,
  `balances`, `holdings` all **`success`**, the holdings leg ~37 s of **real Esplora
  requests from the worker to `blockstream.info` through the crypto egress allow-list** —
  the first successful third-party egress this gate observed. The test-vector wallet's
  real balance is 0 BTC (account balance `USD 0`, no holdings, 0 staged facts); this is
  genuine, not a silent zero — the connector throws `DATA_UNAVAILABLE` for any non-zero
  unpriced balance, and the sync succeeded.
- **ETH watch-only and Coinbase: not walkable on this stack.** No `etherscan_api_key`
  (the ETH leg refuses by name without one) and no Coinbase seam — `COINBASE_API_HOST` is
  hard-coded to `api.coinbase.com`, the hermetic fake is a test-only transport, and no CDP
  key exists on this host. So **"its on-ramp shows as a transfer, not spending" was not
  reached in the browser**; it is proven at the connector (S-CB3b red) and _not_ proven
  through categorisation (S-CB5b green, G3-3). Input (5) is ruled in §5.

### 3.8 Step 7 — the encrypted export, and what the bundle carries

`GET /api/export?encrypt=true` (fresh step-up session) → **503
`export.encryption_unavailable`**, `detail: "no age recipients file at
/run/secrets/age_recipients"`. **Did not download; nothing to decrypt.** Two independent
reasons, either sufficient:

1. `bundle.ts` looks for `${SECRETS_DIR}/age_recipients` (plural); the deployment's
   secret is `age_recipient` (singular — `compose.yml:118`, RUNBOOK step 2 item 4,
   `justfile:763`), and `compose.yml` mounts it **only on `backup`**, not on `api`.
   RUNBOOK's export section even names the plural file, which RUNBOOK step 2 never tells
   the operator to create.
2. `docker/api.Dockerfile`'s runtime stage installs `tini` only — no `age` binary.
   RUNBOOK calls the fix "one remaining step … a Dockerfile line"; it is at least three
   (the binary, the filename, the mount).

The refusal is honest (503, the reason named, no plaintext downgrade), but `?encrypt=true`
has **never worked in any deployed image**, and WP 3.13's test passes only because it
plants `age_recipients` itself (`extraSecrets: { age_recipients: … }`) — a control
derived from the artefact it checks. And the branch production actually takes (no `age`
on `PATH`) has no test at all (T13-5b, green). → **G3-4 (Medium)**.

The plaintext export → 200, 365,533 bytes, **32 streams**. Checked for leakage: no
`sealed_credential`, no `access-sandbox…`, no `cdp_private_key`, no `master_key`, and
the wallet's zpub is absent. **But none of the 32 streams is a Phase 3 table** — no
`securities`, `holdings`, `investment_transactions`, `cost_basis_lots`,
`basis_method_elections`, `price_source_priority`, `net_worth_daily` or
`wallet_addresses`. `apps/api/src/reports/export/registry.ts:183–251` lists every one as
_"exported with holdings/lots by WP 3.7"_ / _"exported with the investments batch, not
dropped"_; WP 3.7 never wired it and no open-items list carries it. So an export → import
round trip at the Phase 3 close **loses the entire portfolio**, every cost-basis lot
(including user-supplied basis), the sticky `AVERAGE_COST` election (a tax election the
user cannot take back, per WP 3.9's own route table), and every sealed net-worth day —
the one table the registry itself says "a recomputation cannot rebuild". The nightly
`pg_dump` backup still covers all of it; the portability/restore bundle does not. →
**G3-7 (Medium)**.

### 3.9 Step 8 — notification delivery from inside the worker (gate input 4)

`docker compose -f compose.dev.yml --profile dev-sinks up -d --wait mailpit ntfy` — images
`axllent/mailpit:v1.21.3` and `binwiederhier/ntfy:v2.11.0` pulled, both `healthy` in 16 s
(**the profile's first observed `up`**; wp3.14-carryovers recorded it as never run).

1. **The documented host-side proof** — `apps/api/test/db/notifications-delivery.test.ts`
   with the sinks up: `✓ a real ntfy push lands in the dev-sinks ntfy cache, observed by
reading it back`, `✓ a real SMTP send lands in the dev-sinks mailpit mailbox…` — **2
   passed** (they had skipped in §1). Mailpit's REST API afterwards: 1 message, subject
   `wp3.14 dev-sinks delivery proof delivery-proof-01a0de1c-…`.
2. **From inside the worker container.** The two sink containers were attached to the
   production `personalfi_backend` network (a gate-only topology change, undone at
   teardown; ntfy 172.22.0.6, mailpit 172.22.0.7), and a script was run through
   `docker compose exec -T worker node --input-type=module -` importing the **image's own**
   `packages/contexts/notifications/src/index.ts`:
   - **The unmodified production path** (real guard, real Docker DNS, real transport),
     allow-listing the sinks by name: ntfy on 443 → `refused … resolves to 172.22.0.6
(private)`; ntfy on 2586 → `refused port 2586 is not allowed`; SMTP to mailpit:465 →
     `refused … resolves to 172.22.0.7 (private)`. **A dev sink is unreachable from the
     production worker by design** — the private-range refusal is not configurable.
   - **The delivery idiom, executed in the worker's image and network:** the full guard
     runs (host allow-list, scheme, port, classification of a plausible public answer),
     then only the socket target is swapped to the sink's address with `secure: false` —
     exactly `notifications-delivery.test.ts`'s ntfy half. Result: **`delivered`**, and
     read back from ntfy's cache over the backend network: `{"topic":"gate3-1790432830024",
"title":"gate3 in-worker delivery","message":"gate3-inworker-1790432830009"}`.
     **A successful send, observed from inside the worker container.**
   - The production SMTP factory (nodemailer, mandatory TLS), guard satisfied the same
     way: it dialled the validated public address (93.184.216.34:465) — as it must, the
     address the guard validated is the address the socket uses — and timed out
     (`retryable`, `Connection timeout`). Recorded because it is an outbound SYN this
     gate caused; no payload left.

Ruling in §5. Side finding: `compose.override.example.yml` tells an operator that
`NOTIFICATIONS_ALLOWED_HOSTS: 'mailpit,ntfy'` points a real api/worker at the dev sinks;
the first bullet above shows that can never work (private address; and ntfy's sink speaks
plain HTTP on 2586). → **G3-9 (Low, docs)**.

### 3.10 Step 9 — WP 3.4's egress refusals, from inside the worker container

Test files are pruned from the image, so the suite cannot be run there verbatim. Instead
a script importing the **image's own** `@core/platform` guard and
`@ctx/integrations/src/egress.ts` bindings ran each refusal class against the
container's **real resolver** (Docker's embedded DNS), which the unit suite fakes:

| Destination (Tiingo's per-adapter policy unless stated)                             | Result                                                                                                                                         |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `https://db:5432/`, `https://db/`                                                   | refused `host_not_allowed`                                                                                                                     |
| `https://169.254.169.254/latest/meta-data/`                                         | refused `literal_ip`                                                                                                                           |
| `https://metadata.google.internal/`                                                 | refused `host_not_allowed`                                                                                                                     |
| `https://127.0.0.1/`, `https://[::1]/`, `https://2130706433/` (decimal)             | refused `literal_ip` (all three)                                                                                                               |
| `http://api.tiingo.com/…`                                                           | refused `scheme_not_allowed`                                                                                                                   |
| `https://api.tiingo.com:8443/`                                                      | refused `port_not_allowed`                                                                                                                     |
| `https://user:pw@api.tiingo.com/`                                                   | refused `userinfo_in_url`                                                                                                                      |
| Tiingo's policy → `api.coingecko.com`                                               | refused `host_not_allowed` (one host per adapter)                                                                                              |
| the context-wide policy → `api.coinbase.com`                                        | refused `host_not_allowed` (crypto hosts are not market data)                                                                                  |
| `https://api.tiingo.com/…` (real DNS)                                               | **allowed**, 1 public address                                                                                                                  |
| an operator allow-listing `db`, `api` (ports 5432/8080 allowed too)                 | **refused `private_address`** — `db resolves to 172.22.0.2 (private)`, `api resolves to 172.22.0.4 (private)`, from the real Docker DNS answer |
| `api.tiingo.com` answering `10.0.0.5` / `[public, 172.22.0.2]` / `::ffff:127.0.0.1` | refused `private_address` (all three — rebinding and mixed answers)                                                                            |

Every refusal WP 3.4's matrix claims holds in the production image with the production
resolver; the operator-mistake rows are the strongest result — the private-range layer is
independent of the allow-list, as Phase 2's gate found for notifications. Redirects are
not re-proven here (no in-container server); WP 3.4's sabotage D covers them in-suite.

### 3.11 Step 10 — Plaid Sandbox leg (Phase 2 condition C-2)

Plaid Link's hosted iframe needs a human at `cdn.plaid.com`, so the public token was
minted the way `packages/connectors/plaid/test/sandbox.test.ts` mints one: a script run
**inside the api container** using the deployment's own mounted `plaid_*` file secrets
(refusing unless `plaid_env` reads `sandbox`) called `sandboxPublicTokenCreate` for
`ins_109508` with `transactions, investments, liabilities`. Only the single-use Sandbox
public token was written, to a 0600 file under `/tmp`; no client id, secret or access
token was printed.

- **Link:** `POST /api/connections/plaid/exchange` from the browser session → **201**, 16
  accounts.
- **First sync, all five legs through the worker:** `sync_runs` `transactions success
initial` (49 added), `balances success` (14), **`holdings success` (13)**,
  **`investment_txns success` (1,169)**, **`liabilities success` (3)** — WP 3.7's legs on
  real Sandbox data, each its own row. `domain_events`: `investments.HoldingsUpdated`,
  `investments.LotsUpdated`. The accounts screen (`gate-14-accounts-after-plaid.png`)
  shows cash, credit cards, four loans, 401k and IRA with their Sandbox balances.
- **Scheduled sync:** `connections.nightly_sync` triggered at 14:31Z →
  `connections.sync_all` fanned out three `connections.sync` jobs at 14:34:39Z, all
  `succeeded`; the wallet and manual connections synced `scheduled`, and the Plaid one
  logged `"reason":"min_interval","msg":"sync skipped"` — the per-connection floor after
  a sync five minutes earlier, a correct and visible skip. **A scheduled sync that
  actually hit Plaid was therefore not observed on this walk** (it would need the floor
  to elapse); the scheduler → fan-out → per-connection path was.
- **Disconnect:** `DELETE /api/connections/{plaid}` → 200 `{"revokedAtProvider": true,
"providerSlotMayRemain": false}`; `connections.status = disconnected`,
  **`sealed_credentials IS NULL`** — the access token is purged, not merely flagged. (My
  first attempt returned 400 `fst_err_ctp_empty_json_body` because my own helper sent
  `content-type: application/json` with no body — a harness error, not the app's.)

**C-2 is closed** (link, first sync, scheduled path, disconnect) with the one caveat
above.

**What the real Sandbox holdings found.** Of 13 Plaid Sandbox positions, **12 did not
resolve**: 22 `investments.SecurityResolutionFailed` events, `COUNTS` after the sync = 11
securities (10 from the fixture + BTC's second row, below), and `GET /holdings` lists
only the fixture's symbols. The abstentions say why — every Sandbox security names
itself with a **bare ticker** (`ACHN`, `DBLTX`, `EWZ`, `NFLX180201C00355000`) or a
proprietary id and no CUSIP/ISIN/FIGI; an unqualified ticker is not an identity (D25's
rule, correctly), and the tier that would qualify it — OpenFIGI — is **not registered
without `openfigi_api_key`** (`domain.ts:2190`, `figi` is `undefined` unless the key is
present), although RUNBOOK step 8 says OpenFIGI "also answers anonymously … so absence
here degrades rather than disables". The positions are counted as events and **nowhere
in the UI**: the investments screen, the inbox and the accounts screen say nothing
(`gate-12`, `gate-13`), while the accounts screen shows the 401k at $23,631.98 — so the
holdings view and the balance disagree by the unresolved positions with no explanation
on screen. The resolver is doing the right thing; the surfacing is missing and the
RUNBOOK claim is wrong. → **G3-11 (Medium)**. Second observation from the same data:
BTC now has **two** rows — the fixture's `ticker:BTC:gate3` (my hand-inserted identity
key, not a canonical one) and the wallet connector's canonical `chain_contract` row. That
is an artefact of my SQL load, not the resolver; recorded so it is not misread.

### 3.12 Step 11 — a missing FX rate, live (criterion d)

A manual CAD chequing account was linked (201) and given a CAD 7,080.00 balance through
`POST /api/accounts/{id}/balance` (200). No `fx_rates` row existed.

| Surface                                                           | Observed                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/net-worth/corrections`                                 | **409 `planning.fx_rate_missing`** — _"no FX rate for CAD/USD on or before 2026-09-26 (consulted CAD/USD, USD/CAD (inverted)). This is deliberately an error rather than a 1.0…"_                                                                                     |
| `GET /api/net-worth` (ledger "now")                               | two totals, **CAD 7,080.00 on its own line** and USD on its own — never folded at par                                                                                                                                                                                 |
| `planning.net_worth_snapshot` (triggered)                         | the job **failed with `FxRateUnavailable`** (attempt 1 of 5, retried with backoff); `net_worth_daily` for the day **unchanged** (revision 1, `17649961`, `updated_at` 14:19:01Z) — no par row written                                                                 |
| a rate added (`CAD/USD 0.7400` dated 2026-09-25, `user_override`) | the retried job **succeeded**; the day's row now `8062192` with the CAD breakdown entry `nativeMinor 708000, baseMinor 523920, fxRate 0.7400000000, fxRateDate 2026-09-25` — **the observation's date, not the date asked for** (D4)                                  |
| **the rate row deleted** and the snapshot re-triggered            | the job **failed again with `FxRateUnavailable`**; the stored day stayed at the previously converted value — nothing reverted to par                                                                                                                                  |
| the browser (`gate-15-fx-setup.png`)                              | **nothing on screen says a rate is missing.** The dashboard hero (pre-F-1 image) still showed its literal; the chart shows the last written day. The only surface for `fx_rate_missing` is the corrections route's 409 and a failing background job in the worker log |

**Criterion (d) "surfaces rather than defaulting": the _never defaults_ half is proven
live** (three surfaces, sabotage S-FX1/S-FX2 red). **The _surfaces_ half is not** — 08
§6.6's "typed `FxRateUnavailable` with a manual-entry affordance" and 03 §5's "surfaces
in the API response **and on screen**" are unmet: a scheduled snapshot that cannot convert
simply fails and retries, and the chart silently shows yesterday's (or no) figure. →
**G3-12 (Medium)**. Ruling on input (7) in §5.

### 3.13 Step 12 — advisor snapshot minimisation, from a real snapshot (Standard D, 08 §4.2)

A script run **inside the api container** built a snapshot with the **production**
`SnapshotBuilder` and the **production** ports (`createInsightsLedgerPort`,
`…BudgetPort`, `…RecurringPort`, `…InvestmentsPort`, `…MarketDataPort`) over the live
database — the fixture portfolio, the Plaid Sandbox data, the wallet — then searched the
serialised JSON for every identifier the database holds.

- Scopes rendered: `cashflow_monthly, holdings_aggregate, holdings_detail,
liabilities_terms, recurring_list, transactions_summary` (18,190 bytes).
- **Of 46 known row ids** (every `accounts`, `securities`, `connections`, `holdings` id):
  **0 crossed.** The user id: not present. Account and connection display names
  ("Plaid Checking", "Fixture Taxable", "Gate3 BIP84 test vector"…): **none present.**
  No `security_id`, `securityId`, `account_id`, `accountId`, `institution`, `Platypus`,
  `zpub`, `••` or `mask` substring.
- `holdings_aggregate.top_positions[0]` = `{"symbol":"VTI","weight":0.327…,"value":…,
"asset_class":"US_EQUITY","employer_stock":false,"is_crypto":false}` — symbol and
  weight, no quantity, no basis, no account linkage. `holdings_detail` carries quantity
  and basis **by symbol and `account_type`**, never an account id — exactly 08 §4.2.
  `liabilities_terms` crosses a token (`LIAB_c0b318d21c77`) and every unknown term as
  `null`, never a fabricated APR.
- 13 uuid-shaped strings for `kind: 'builtin'` and `'local_model'`, all at
  `recurring_list.streams[].series_ref` — a `recurring_series` id, by design for
  in-process advisors (the builder's comment: an in-process advisor's evidence must link
  back into the app). **For `kind: 'external'`: 0 uuid-shaped strings.** Correct.
- **`networth.summary` and `cash.summary` could not be built with a CAD account present**
  — the builder threw `CurrencyMismatchError: cannot combine USD with CAD` from
  `#netWorth` (`builder.ts:364`) and then from `#cash` (`:396`). The whole `build()`
  rejects, so an advisor granted either scope gets **no snapshot at all** on any install
  with a foreign-currency account. → **G3-13 (Medium)**.
- **The follow-up query was denied by the host and not run:** a `SELECT advisor_id,
status, granted_scopes, emitted_scopes FROM advisor_runs` over the post-CAD nightly run
  (to see whether real runs hit the same throw). Reformulated from other sources instead:
  the triggered nightly run with the CAD account present logged 25 `completed` + 6
  `refused (advisor_disabled)` and **zero** `currency_mismatch` lines; `snapshot_grants`
  holds **0 rows** and `insights` **0 rows**; and `grantScopes` has **no production
  caller** (grep of `apps/api/src`, `packages/contexts/insights/src`). So in a deployed
  install **every advisor runs with an empty grant set and receives an empty snapshot** —
  which is why the real runs did not throw, and why G3-13 is latent today. It becomes live
  the day WP 4.8's consent route writes a grant. This also sharpens gate input (1): the
  silence is not only I1/I3/I5 — **all 17 Phase 3 rules (and every Phase 2 rule) are
  structurally silent in production** until consent exists (§5). Checked across the
  worker's whole log: **62 advisor runs, every one `"proposed":0`.**

### 3.14 Step 13 — the seal, byte for byte, over a re-run (dispatch §5 risk row 2)

A same-day cold install has no sealed day (3.6), so the seal was exercised on the live
stack by driving the **production** snapshotter — `@ctx/planning`'s `runSnapshot` with
`apps/api`'s `planningPortsFor`, in a transaction on the live database, exactly the call
`netWorthSnapshotJobHandler` makes — with a **controlled clock**, over the walk's real
data (the spreadsheet portfolio, the Plaid Sandbox accounts, the wallet, and the CAD
account with its `0.7400` rate restored). The data is the live stack's, not
`@core/seed`'s generator: the seed has no loader into a compose stack, and this set is a
superset of its shapes (manual assets excepted). The sealed row was dumped as
`to_jsonb(row)` with keys sorted — `updated_at`, `sealed_at`, `revision` and the whole
`breakdown` compared as stored, nothing normalised.

| Run                                     | Clock (America/New_York) | Result                                                                                                                                                             |
| --------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1                                       | 2026-09-27 04:00         | **sealed `["2026-09-26"]`**, opened 2026-09-27; sealed day dump sha256 `836d7a3b8e793f52…`, 5,455 bytes                                                            |
| _the world changed underneath_          | —                        | every fixture price **doubled** (10 rows), a new CAD balance of 999,999.99 recorded                                                                                |
| 2                                       | 2026-09-27 05:30         | sealed nothing new; the open day's net moved to `99188232`                                                                                                         |
| 3                                       | 2026-09-27 06:15         | same                                                                                                                                                               |
| dump of 2026-09-26 after runs 2 and 3   | —                        | sha256 **`836d7a3b8e793f52…`, 5,455 bytes — `SEALED DAY BYTE-IDENTICAL: true`**                                                                                    |
| control: the open day                   | —                        | 2026-09-27's dump **changed** (`true`) — so "unchanged" means "not recomputed", not "the snapshotter wrote nothing"                                                |
| a repair script touching the sealed row | —                        | `UPDATE net_worth_daily SET net_worth_minor = net_worth_minor + 1 WHERE … sealed_at IS NOT NULL` → **refused `23514` `net_worth_daily_sealed_rows_are_immutable`** |

With S-SEAL1/S-SEAL2 (§2.1) red, **"a past date's net worth is immutable across a
re-run" is proven on the production code path and the production database**, not only in
the unit suite. What the browser half ("a past date is unchanged after a re-sync" on the
chart) would add was not observable on a one-day-old install and is carried with the
real-data items.

### 3.15 Step 14 — gate input (5): ETH on Coinbase and in a wallet, one row

The stack cannot host it (3.7): no Coinbase seam, no Etherscan key. So the gate wrote a
**temporary** api-db test (`apps/api/test/db/gate3-eth-one-row.test.ts`, deleted after
the run, never in the tree) that uses what the seams do allow — both adapters' **own**
output, not hand-written identifiers (which is all `investments-db`'s
`securities.test.ts` feeds):

1. The real `CoinbaseConnector` over its hermetic fake (`@connector/coinbase/test`'s
   `harness()`), `syncHoldings` → `BTC-USD=0.35, ETH-USD=2.05`; the ETH fact's identifiers
   exactly as the mapper emits them: `[{"kind":"ticker","value":"ETH","chain":null,"mic":null}]`.
2. The wallet connector's own `nativeSecurityIdentifierOf('ethereum')` →
   `{"kind":"chain_contract","value":"0xeeee…eeee","chain":"ethereum"}`.
3. Both through the real `securityResolverFor(…).resolveAll` on a scratch Postgres:
   Coinbase `resolved, created: true`, identity canonicalised to `chain_contract native
ethereum`; wallet `resolved, created: false`, **the same `securityId`**. `securities`:
   **exactly one row** (`chain_contract`, `ethereum`). `Tests 2 passed`.

**But the wallet half never reaches the resolver in production.** The same temporary file's
second test drove the real `WalletRpcConnector` (hermetic Etherscan fake) with a 1.5 ETH
balance: `syncHoldings` → **`threw DATA_UNAVAILABLE: this wallet holds 1.5 ETH but this
connector has no price source — reported as unavailable rather than as $0.00`** (the same
for `syncBalances`, per `unpriced.test.ts`). That is WP 3.6's deliberate choice ("a real
fiat valuation … is WP 3.4's `PriceSource` plus the resolver's `security_id` join,
joining downstream of this connector"), carried in wp3.6 §8 item 5 as "not this work
package's job" — and **no later work package built the downstream join**. So in the
deployed product a watch-only wallet with any non-zero balance fails its balances and
holdings legs on every sync and never becomes a holding; only an empty wallet (like
BIP84's test vector, 3.7) syncs green. The dispatch's WP 3.6 scope line — "Balances
become holdings of the same `security_id` WP 3.1 resolved ETH to" — is unmet end to end.
→ **G3-14 (High)**. Criterion (c) is proven at the resolver on real adapter output (above)
and cannot occur end to end until G3-14 is fixed. Ruling in §5.

### 3.16 Step 15 — F-1 observed on the running stack (observe only)

The orchestrator committed F-1 as `c4ccf7c` after its own independent re-verification
(the gate did not touch the F-1 files again). The gate rebuilt only the proxy image (the
SPA ships in it) from that commit and recreated the proxy container — the one container
recreation in this walk, made after every Phase 3 step above had been observed.
`gate-16-f1-dashboard-hero.png`: **"Net worth +$80,621.92 · As of 2026-09-26"** — the
sealed day, the latest valued point in the `p90d` window (`GET /net-worth/series`
returned `2026-09-26 = 8062192 sealed` and, from §3.14's controlled-clock run, a
future-dated `2026-09-27`, correctly outside a window that ends today). No delta line;
`88,904` and `4,210` absent from the page. **G3-2 is closed by F-1 on the running
stack.** (Cosmetic, not a finding: a positive net worth renders with a leading `+`.)

### 3.17 Walk summary

| Dispatch §5 item 3 / brief requirement                                                                 | Reached                                                                                                                     | Where     |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | --------- |
| cold `down -v`, build from HEAD, `up`, bootstrap per RUNBOOK                                           | yes — **one unprompted worker restart** (G3-1)                                                                              | 3.1       |
| api + worker healthy, all 10 modules, both Phase 3 job kinds, zero restarts                            | 10 modules + both job kinds **yes**; zero restarts **no** (worker 1, G3-1; proxy recreated once for F-1 after the walk)     | 3.1, 3.16 |
| passkey login through Caddy in a real browser                                                          | yes                                                                                                                         | 3.2       |
| holdings with a price and a staleness label                                                            | yes                                                                                                                         | 3.4       |
| allocation matches the committed spreadsheet fixture                                                   | yes — 37/37 rows, value and weight                                                                                          | 3.4       |
| net-worth chart draws a real series; a past date unchanged after a re-run                              | series yes (one point); past-date **via the production snapshotter + controlled clock**, byte-identical; not in the browser | 3.6, 3.14 |
| watch-only wallet links; on-ramp shows as a transfer                                                   | wallet link **yes** (+ private key refused); on-ramp **not reached** (no Coinbase seam)                                     | 3.7       |
| CoinGecko attribution wherever a crypto price is                                                       | yes (holdings, allocation, settings); generic glyph (G3-8)                                                                  | 3.4, 3.7  |
| market-data settings show key presence, never a value                                                  | yes                                                                                                                         | 3.7       |
| one `integrations.price_refresh` tick, `sync_runs`/`domain_events` appearing; keyless adapters degrade | yes (triggered)                                                                                                             | 3.5       |
| encrypted export downloads and decrypts with `age`                                                     | **no** — 503 in every deployed image (G3-4)                                                                                 | 3.8       |
| dev-sinks delivery, a successful send from inside the worker                                           | yes                                                                                                                         | 3.9       |
| WP 3.4 egress refusals from inside the worker                                                          | yes                                                                                                                         | 3.10      |
| Plaid Sandbox leg (C-2)                                                                                | yes (scheduled leg hit its min-interval floor)                                                                              | 3.11      |
| nightly schedules fire on a real clock (C-3)                                                           | yes (triggered via `next_run_at`, run by the real scheduler)                                                                | 3.5, 3.11 |
| a missing FX rate surfaces                                                                             | refuses yes; **surfaces on screen no** (G3-12)                                                                              | 3.12      |
| advisor snapshot minimisation from a real snapshot                                                     | yes; `networth.summary`/`cash.summary` throw with CAD (G3-13)                                                               | 3.13      |
| ETH on Coinbase and in a wallet → one row                                                              | at the resolver on real adapter output **yes**; end to end **no** (G3-14)                                                   | 3.15      |

_Section §3 COMPLETE._

---

## 4. Threat model and findings (Standard D)

_COMPLETE._

### 4.1 The five Phase 3 surfaces the brief names

**(a) Market data — the second, scheduled egress surface.** The WP 2.4 guard is reused,
not forked (`shared-allowlist.test.ts`; S-SCH-b goes red in both consumers). One host per
adapter, 443 only, HTTPS only (the pin is `checkUrl`'s — input 2), no URL/host/header on
the port, 1 MiB body cap, idle + hard timeouts, redirects refused. **Re-run inside the
worker with the real Docker resolver (§3.10): every refusal holds, and an operator
allow-listing `db`/`api` is still refused `private_address`.** A keyless refresh ran on
the real scheduler and spent nothing (§3.5). Keys: optional file secrets, `ApiKey` renders
`[redacted]`, FRED's query-string key is redacted before `market_data_runs` (WP 3.4's
custody sweep, sabotaged there); the settings route carries presence only and Zod strips
any undeclared field (S-K1). Residual: a `number`-typed generic `value` parameter would pass
the numeric-boundary check (O-1). **Posture: sound.**

**(b) Read-only crypto credentials.** `key_permissions` checked uncached before every
data call, `can_trade`/`can_transfer` refused (S-CB1: 13 data calls made once it was
removed), a five-path GET allow-list checked **before** a token is minted (S-CB2), EdDSA
per-request JWT (S-CB4), no trading endpoint in the package. The live key was never
exercised (no CDP key on this host). **Gap:** the raw-column custody read for the CDP key —
the dispatch's named `custody.test.ts` and the §5 risk table's "raw column read back
through `psql`" — **was never written**: `packages/connectors/coinbase/test/custody.test.ts`
proves only the connector half and says the database half was "specified for the
orchestrator" (wp3.5 §10 item 3); no api-db or connections-db test mentions Coinbase. The
generic sealing path is proven for Plaid (`plaid-routes.test.ts`), and on this walk a
disconnected Plaid connection's `sealed_credentials` was `NULL` (§3.11), so the risk is an
unexercised control, not a known leak. → **G3-16 (Medium)**.

**(c) Watch-only addresses as PII.** An xpub reveals every past and future address of the
wallet — it is not a credential, but it is the complete financial history of that wallet.
Observed: private material refused before it is stored or echoed (§3.7, S-W1); the zpub
and every derived `bc1q…` address appear in **no** api, worker or proxy log line (grep of
all three logs, 0 hits); the descriptor is absent from the advisor snapshot (§3.13) and
from the export bundle (deferred, G3-7). Residuals, accepted and stated: (i)
`wallet_addresses.descriptor` is plaintext `text`, so a database dump or backup carries
every wallet's full history in the clear — the same posture as transactions, but worth
saying because it is a key to a chain's _future_ as well; sealing it with `SecretBox` would
cost nothing the connector needs (it re-reads the descriptor per sync); **Low, C-13**. (ii)
Every derived address is queried against `blockstream.info` from this host's IP, linking
them for Blockstream — inherent to a watch-only design without a self-hosted Esplora;
document it in RUNBOOK (C-13).

**(d) The securities master — `securities.user_id` scoping.** The master is **per user**,
not shared: every row carries `user_id`, the resolver is scoped by it, and every route
predicate names it (wp3.9 §2). Proven: S-S1 (drop `h.user_id`) and S-S1m (drop
`s.user_id`) are each red on the planted cross-user row. Residual: `holdings.security_id`
references `securities(id)` alone, so the schema permits a holding to point at another
user's security — the planted row in WP 3.14a's test is exactly that, inserted by raw SQL.
A composite FK `(user_id, security_id) → securities(user_id, id)` (and the same on
`cost_basis_lots`, `prices`, `investment_transactions`) would make the scope structural
instead of predicate-deep. **Low, C-14.**

**(e) Advisor snapshot minimisation (08 §4.2).** Verified on a **real** snapshot built by
the production builder over the production ports and the live data (§3.13): 0 of 46 row
ids, no user id, no account/connection names, no institution, no mask, no descriptor;
`holdings.aggregate` symbol + weight only; `holdings.detail` by symbol and account _type_;
liabilities as tokens with `null` for unknown terms; `external` kind carries zero
uuid-shaped strings. S-M1 and 3.10a's `security_id` sabotage are red. **Two gaps:** the
builder throws on a multi-currency install for `networth.summary`/`cash.summary` (G3-13),
and in production no advisor receives any scope at all until WP 4.8 (G3-10).

### 4.2 Findings

| ID    | Sev      | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | State                                                                                                                                                                                                |
| ----- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G3-1  | MEDIUM   | Worker with no account holder at boot builds no loops, its only timer is `unref`'d, `main()` returns, and the process **exits 0 after the pool's 30 s idle timeout**; Compose restarts it and the restarted process finds the holder. RUNBOOK's order (`up`, then `bootstrap-user`) works by an accidental exit-restart loop, not the "idle until one is enrolled" the log line and comments claim; a cold install cannot meet "no restart anywhere"; a runtime without a restart policy simply stops (§3.1).                                                                                                                                  | C-1                                                                                                                                                                                                  |
| G3-2  | **HIGH** | The dashboard's hero net worth was a hard-coded Phase 0 literal (`$88,904.00`, `+$4,210.00 2.1% this month`) on every install, above the real chart (§3.6).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | **Fixed in place — F-1** (`apps/web/src/routes/_app.index.tsx` + `-app.index.test.tsx`); sabotage red; orchestrator re-verified independently and committed `c4ccf7c`; observed on the stack (§3.16) |
| G3-3  | MEDIUM   | The on-ramp "never lands in a spending total" is proven only to the connector's PFC label; no test fails when `TRANSFER_IN_ACCOUNT_TRANSFER` maps to a spending category (S-CB5b green). The v0.5 rung's third clause rests on an untested hop.                                                                                                                                                                                                                                                                                                                                                                                                | C-3                                                                                                                                                                                                  |
| G3-4  | MEDIUM   | `?encrypt=true` has never worked in a deployed image: `bundle.ts` reads `age_recipients` (plural) while the secret is `age_recipient`, mounted only on `backup`; the api image has no `age` binary; RUNBOOK names a file it never tells the operator to create and calls the fix "one Dockerfile line". WP 3.13's test plants its own `age_recipients`; the production branch (`age` absent) has no test (T13-5b green). The refusal is honest (503, no plaintext).                                                                                                                                                                            | C-5                                                                                                                                                                                                  |
| G3-5  | MEDIUM   | The worker pool guard is tested by string match only: `assertPoolCoversLeases` made a no-op and the per-consumer reservation zeroed both leave `api` 75/75 green (S-P1, S-P2). The "assertion" also only logs; a pool that cannot cover its leases hangs silently, which is the wiring batch's own finding.                                                                                                                                                                                                                                                                                                                                    | C-6                                                                                                                                                                                                  |
| G3-6  | LOW      | `planning`'s `toMinorUnits` rounds half-up; `@ctx/investments` and the spreadsheet round half-even: the snapshot said $176,499.61, allocation $176,499.60 on the same holdings (VXUS's exact half-cent). The adjacent comment says "once, at the end" while the code rounds per position.                                                                                                                                                                                                                                                                                                                                                      | C-11                                                                                                                                                                                                 |
| G3-7  | MEDIUM   | The export bundle carries **no** Phase 3 table: `securities`, `holdings`, `investment_transactions`, `cost_basis_lots`, `basis_method_elections` (the sticky `AVERAGE_COST` tax election), `price_source_priority`, `net_worth_daily` (sealed history the registry itself says cannot be rebuilt), `wallet_addresses`. The registry says "exported … by WP 3.7"; WP 3.7 did not; 04 §2 carries only two of the eight. Backups cover it; the portability bundle does not.                                                                                                                                                                       | C-7                                                                                                                                                                                                  |
| G3-8  | LOW      | CoinGecko's licence requires its logo; the UI renders a generic `Coins` glyph, justified by a CSP reason that does not apply to a self-hosted asset (CoinGecko publishes brand assets for exactly this).                                                                                                                                                                                                                                                                                                                                                                                                                                       | C-15                                                                                                                                                                                                 |
| G3-9  | LOW      | `compose.override.example.yml`'s dev-sinks block (`NOTIFICATIONS_ALLOWED_HOSTS: 'mailpit,ntfy'`) can never work — private address, and ntfy's sink speaks HTTP on 2586 (§3.9).                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | C-16                                                                                                                                                                                                 |
| G3-10 | Info     | No production caller of `grantScopes`: every advisor gets an empty snapshot; 62/62 runs proposed nothing. Known and owned (04 §2, WP 4.8).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Carried to WP 4.8                                                                                                                                                                                    |
| G3-11 | MEDIUM   | Without `openfigi_api_key` the FIGI tier is not registered, so every bare-ticker security is unresolvable: 12 of 13 real Plaid Sandbox positions never became holdings (22 `SecurityResolutionFailed`), **with nothing on any screen**, while the 401k's balance shows. RUNBOOK says OpenFIGI "also answers anonymously … degrades rather than disables" — the code disables.                                                                                                                                                                                                                                                                  | C-8                                                                                                                                                                                                  |
| G3-12 | MEDIUM   | A missing FX rate is refused correctly but **never surfaced on screen**: the scheduled snapshot fails and retries silently, the chart keeps the last written day; 08 §6.6's manual-entry affordance and 03 §5's "on screen" are unmet. The full view's caption also claims every day has a value above four "—" days.                                                                                                                                                                                                                                                                                                                          | C-9                                                                                                                                                                                                  |
| G3-13 | MEDIUM   | `SnapshotBuilder` throws `CurrencyMismatchError` for `networth.summary` (`builder.ts:364`) and `cash.summary` (`:396`) on any install with a non-USD account; the whole `build()` rejects. Latent until WP 4.8 writes a grant.                                                                                                                                                                                                                                                                                                                                                                                                                 | C-10                                                                                                                                                                                                 |
| G3-14 | **HIGH** | A watch-only wallet with any non-zero balance fails its `balances` and `holdings` legs with `DATA_UNAVAILABLE` on every sync and never becomes a holding; the "downstream" valuation join WP 3.6 deferred to WP 3.4 was never built. The watch-only feature works only for empty wallets; criterion (c) cannot occur end to end (§3.15).                                                                                                                                                                                                                                                                                                       | C-2                                                                                                                                                                                                  |
| G3-15 | LOW      | Two figures both labelled "Net worth" with different definitions (planning: holdings × price, FX-converted; ledger: balances only, per currency) — differed by ~$158k on this data with no explanation on screen.                                                                                                                                                                                                                                                                                                                                                                                                                              | C-9                                                                                                                                                                                                  |
| G3-16 | MEDIUM   | The CDP key's raw-column custody test (dispatch §3 WP 3.5 exit test, §5 risk table) was never written; only the connector half exists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | C-4                                                                                                                                                                                                  |
| —     | Info     | O-1: `value`-named `number` parameters are exempt by shape in `check-numeric-boundaries`. O-2: whether the key-presence test detects a _partial_ key in a declared string field was not established. O-3: running `just verify`/Playwright rewrites committed evidence screenshots (`wp3.11-*`, `wp3.12-*`) — it dirtied the tree twice during this gate. O-4: a sourceless refresh reports `securitiesUnpricedCount: 0`. O-5: `@connector/walletrpc`'s `package.json` exports `./test` → `test/index.ts`, which does not exist. O-6: 04-phase-4-dispatch §2 row 69 (the port's single identifier) is stale — closed by WP 3.14a at `9fb4191`. | No action required; O-3/O-5/O-6 are one-line cleanups for WP 4.12                                                                                                                                    |

---

## 5. Rulings on the eight gate inputs

_COMPLETE._

**(1) I1/I3/I5 enabled and structurally silent (3.10a ruling). — Upheld, and widened.**
Silence is silence, not a false positive: INPUT-1 (§2.8) gave
`createInsightsInvestmentsPort` the target source it lacks and the pinned test went red
with `builtin.investing.drift unexpectedly fired: expected 2 to be +0` — the rule fires on
the real portfolio as soon as a target exists, and its silence at HEAD is the missing
source. The 3.10a pin (`'the investing rules with no field behind them are silent, and it
is these three'`) must be re-derived, never deleted, when WP 4.7 lands the sources (04 §2
already says so). **The walk widens the ruling:** in a deployed install `snapshot_grants`
is empty and `grantScopes` has no production caller, so **every** advisor — all 17 Phase 3
rules and every Phase 2 rule — receives an empty snapshot; 62 of 62 logged runs proposed
nothing (§3.13). That is the known consent-route gap WP 4.8 owns (04 §2 row 66), recorded
here so nobody reads "17 rules enabled" as "17 rules working". G3-13 must be fixed before
WP 4.8 writes the first grant, or the first grant of `networth.summary`/`cash.summary` on
a multi-currency install breaks every run that asks for it.

**(2) WP 3.4's `allowedSchemes` honest gap. — Neither a doubled control nor a missing
test; accepted, with one Low condition.** S-SCH-a/b/c (§2.2): widening
`allowedSchemes` is inert on the market-data path because `checkUrl` passes a **literal**
`scheme: 'https'` to `checkDestination`; the load-bearing control is `checkUrl`'s pin, and
removing it turns `integrations`' own `'only https, only 443'` red (and notifications'
matrix). So the cleartext control is single, platform-level and tested from the
market-data suite — WP 3.4 simply could not sabotage it from inside its package. Low
condition C-12: either have `checkUrl` pass the parsed scheme so `allowedSchemes` becomes
a real second layer, or delete the line / say in `egress.ts` that it is inert on URL paths
— a line that looks like a control and is not one is how the next reader mis-sizes the
defence.

**(3) WP 3.13's seven controls with no surviving sabotage record. — Sabotaged; 8 of 9
red first try.** §2.6: C-1 root fix, C-1 wiring, the lazy-repair absence, C-5,
`pending_review`, the encrypted-export refusal (missing recipients file), module-flag
defaults, the merchant-token pin — all red. One green: the `age`-absent branch (T13-5b),
which is the production branch → G3-4.

**(4) The `dev-sinks` profile and a successful delivery from inside the worker. —
Proven within what the design permits; the production-path success is carried.** The
profile came up for the first time (§3.9); the host-side delivery test passed 2/2 with a
message read back from mailpit; inside the worker's own image and network the delivery
idiom delivered to ntfy and was read back from ntfy's cache. The **unmodified** production
path cannot reach a dev sink — private address, and not operator-configurable — which is
the stronger control and is why `compose.override.example.yml`'s dev-sink block is wrong
(G3-9). A successful send through the unmodified path needs a public host; the gate did
not send to a third party. **Carried** to Chris's own ntfy topic (03 §6 Q6), same terms
as the other real-data items.

**(5) ETH on one row via the hermetic fake + a watch-only address. — Proven at the
resolver on real adapter output; not end to end; live leg carried.** §3.15: the real
Coinbase connector's ETH fact (hermetic fake) and the wallet connector's own ETH
identifier resolve to one `securities` row in real Postgres. But a funded wallet never
emits a holding (`DATA_UNAVAILABLE`, G3-14), so the criterion cannot occur in the product
until the wallet valuation join exists. The live Coinbase leg stays carried (no CDP key on
this host). **Criterion (c): proven at the resolver, blocked end to end by G3-14.**

**(6) WP 3.14a's merge in the mirror order. — Done; closed.** §2.3: transaction-only
FIGI+ticker sighting first, ticker-only sighting second → one row, identity `figi`, zero
merges; red (two rows) with 3.14a reverted. Symmetric, as predicted. Also: S-S1m (§2.5)
shows the planted-row test covers `securities.user_id` too, which 3.14a §4 said it did
not.

**(7) `GET /net-worth` never attempts FX. — A documented non-converting surface, not a
defect against (d).** Observed (§3.12, `gate-17-accounts-with-cad.png`): it reports one
total per currency ("Net worth (CAD) CA$…", "Net worth (USD) −$77,164.15") and never folds
at par — which is what "never defaults to 1.0" requires. The defect against criterion (d)
is on the other surface: the planning path refuses correctly but **nothing on screen says
a rate is missing** (G3-12). The walk also shows the product now has **two different
figures both labelled "Net worth"** — the dashboard's (planning: holdings × price, FX
converted, the accounts with no balance still valued) and the accounts screen's (ledger:
balances only, per currency, accounts with no balance excluded) — which on this data
differed by ~$158k with nothing explaining why. → **G3-15 (Low)**.

**(8) The Phase 2 gate's AT_RISK and impact-ceiling rulings. — Not reopened; cited.**
Phase 2 gate §4 "Rulings": _"wp2.2 metric 7 read as `AT_RISK` at 1.05 periods:
**accepted** … revisit with real data"_; _"wp2.7 ceiling **withholds** rather than clamps:
**accepted** — a clamped figure is an invented numeral and would itself fail the
validator."_ WP 3.13 recorded both as closed-by-ruling with no code change
(wp3.13-carryovers §1 rows 1–2). This gate did not re-sabotage the ceiling (Phase 2's
S-I3 did) and does not revisit either.

---

## 6. Conditions

_COMPLETE._ Every condition proposes WP 4.12 (the Phase 3 carry-over package in
`04-phase-4-dispatch.md`) as owner unless another Phase 4 WP already owns the file. Each
closes with a test that is observed red under sabotage — the four greens in §2.9 are what
happens otherwise.

| #    | Condition                                                                                                                                                                                                                                                                                                                                                                                                     | From             | Sev      | Proposed owner                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | -------- | ----------------------------------------------------------------- |
| C-1  | Worker: poll for the account holder in the no-holder branch and then run the normal start-up path **without returning from `main()`**; a behavioural test (a fake `findPrimary` that answers `null` then a user) proving it resolves modules with no restart; RUNBOOK's first-install section corrected. The Phase 4 gate's cold walk must then show `RestartCount=0` on the worker after `bootstrap-user`.   | G3-1             | MEDIUM   | WP 4.12                                                           |
| C-2  | Watch-only wallet valuation: a funded wallet must produce a holding (quantity + the resolved `security_id`) valued downstream by the price ladder, never `DATA_UNAVAILABLE` on every sync; an api-db test over the hermetic Etherscan fake + a seeded ETH price proving one `securities` row shared with a Coinbase ETH fact and a non-zero holding. Until then RUNBOOK must say a funded wallet cannot sync. | G3-14, crit. (c) | **HIGH** | WP 4.12 (connector + `domain.ts`); price rows via WP 3.4's writer |
| C-3  | On-ramp end to end: a test from the Coinbase connector's fixture through the orchestrator, categorisation and `@ctx/reports`' spending aggregation asserting the USD deposit contributes **zero** to spending — red when `pfc-map.ts` sends `TRANSFER_IN_ACCOUNT_TRANSFER` to a spending leaf (S-CB5b).                                                                                                       | G3-3, v0.5 rung  | MEDIUM   | WP 4.12                                                           |
| C-4  | The CDP key's raw-column custody test in `apps/api/test/db` (the WP 1.3b pattern, as wp3.5 §3 specifies), sabotage-tested.                                                                                                                                                                                                                                                                                    | G3-16            | MEDIUM   | WP 4.12                                                           |
| C-5  | Encrypted export: one recipients filename across `bundle.ts`, `compose.yml`, RUNBOOK and `justfile`; the recipient mounted on `api`; `age` in the api image; a test of the `age`-absent branch (T13-5b red); and the gate walk item re-run — download, decrypt with `age`, diff against the plaintext bundle.                                                                                                 | G3-4             | MEDIUM   | WP 4.12                                                           |
| C-6  | Pool guard: export `assertPoolCoversLeases` and `WORKER_PINNED_CONNECTIONS`, unit-test the arithmetic (red under S-P1 and S-P2), and make the check **fail the boot** rather than log — a crash-loop is visible, a hang is not.                                                                                                                                                                               | G3-5             | MEDIUM   | WP 4.12                                                           |
| C-7  | Export bundle covers the Phase 3 tables (`securities`, `security_identifiers`, `security_overlay`, `holdings`, `holdings_snapshots`, `investment_transactions`, `cost_basis_lots`, `basis_method_elections`, `price_source_priority`, `net_worth_daily` with its revision ladder, `wallet_addresses` with its connection) and a round-trip test; delete the registry's "exported by WP 3.7" reasons.          | G3-7             | MEDIUM   | WP 4.12 (04 §2 already carries two of these)                      |
| C-8  | OpenFIGI: either register the mapper anonymously (the published 10-jobs/batch, 25 req/min tier) or correct RUNBOOK; and surface `SecurityResolutionFailed` somewhere a person reads it (the inbox or the account's holdings), so a position the app could not identify is visible rather than missing.                                                                                                        | G3-11            | MEDIUM   | WP 4.12 (+ a UI WP for the surface)                               |
| C-9  | Surface a missing FX rate on screen with 08 §6.6's manual-entry affordance (the failing snapshot job's `FxRateUnavailable` must reach the UI); fix the full view's "Every day in this window has an observed or corrected value" caption; label the two net-worth figures (planning vs ledger) so they cannot be mistaken for one.                                                                            | G3-12, G3-15     | MEDIUM   | Phase 4 UI WP (4.10) with WP 4.12 for the route                   |
| C-10 | `SnapshotBuilder` `networth.summary`/`cash.summary` must convert through the FX reader (or emit per-currency blocks) instead of throwing on a non-USD account; a test with a CAD account. **Must land before WP 4.8 writes the first grant.**                                                                                                                                                                 | G3-13            | MEDIUM   | WP 4.9 / 4.12, before 4.8                                         |
| C-11 | One rounding rule for money: `planning`'s `toMinorUnits` half-even like the rest of the app (and its comment corrected), with a reconcile fixture that contains an exact half cent.                                                                                                                                                                                                                           | G3-6             | LOW      | WP 4.12                                                           |
| C-12 | `checkUrl` passes the parsed scheme to `checkDestination` (making `allowedSchemes` a real second layer), or the inert line is removed/commented.                                                                                                                                                                                                                                                              | input (2)        | LOW      | WP 4.12                                                           |
| C-13 | Seal `wallet_addresses.descriptor` with `SecretBox`; RUNBOOK notes that every derived address is queried at `blockstream.info` from this host.                                                                                                                                                                                                                                                                | §4.1(c)          | LOW      | WP 4.12                                                           |
| C-14 | Composite FKs `(user_id, security_id) → securities(user_id, id)` on `holdings`, `cost_basis_lots`, `investment_transactions`, `prices`, so cross-user reference is structurally impossible (migration).                                                                                                                                                                                                       | §4.1(d)          | LOW      | WP 4.12 (a 0020–0025 slot)                                        |
| C-15 | CoinGecko attribution with CoinGecko's own published logo asset, self-hosted (no CSP change).                                                                                                                                                                                                                                                                                                                 | G3-8             | LOW      | Phase 4 UI WP                                                     |
| C-16 | Docs/hygiene: fix `compose.override.example.yml`'s dev-sinks block (G3-9); stop Playwright specs rewriting committed evidence screenshots (O-3); add `packages/connectors/walletrpc/test/index.ts` or drop the export (O-5); strike 04 §2 row 69 as closed (O-6).                                                                                                                                             | G3-9, O-3/5/6    | LOW      | WP 4.12                                                           |

**Carried, not conditions (need Chris or his accounts):** the four real-data items of 03
§6 Q8 (two institutions on schedule, a month with zero internal transfers, the recurring
gold set, a real brokerage reconciling to its statement); the live Coinbase leg of
criterion (c) and the on-ramp (no CDP key on this host); a successful notification through
the **unmodified** production path to a public host (Chris's own ntfy topic, 03 §6 Q6);
the browser half of "a past date is unchanged after a re-sync", which needs an install
older than one day; a scheduled Plaid sync that reaches Plaid (this walk's hit the
min-interval floor).

---

## 7. Teardown and final state

_COMPLETE._

- Final restart counts before teardown: api 0, **worker 1** (G3-1's unprompted exit at
  13:58:23Z; no other), proxy 0 (recreated once for the F-1 check, §3.16 — a recreation,
  not a restart), db 0. The worker log held one `"level":"error"` line that this gate did
  not inspect before `down -v` removed the log; the job failures this gate provoked
  (`FxRateUnavailable`, §3.12) logged at `warn`. Recorded rather than guessed at.
- `docker compose down -v` (volumes `pgdata`, `caddy_data`, `caddy_config`, `backups`
  removed); `docker compose -f compose.dev.yml --profile dev-sinks stop` and `rm -f`
  `mailpit ntfy`; `personalfi_backend`, which survived `down -v` because the sink containers
  were still attached at that moment, removed by hand once empty; `compose.override.yml`
  removed; the seven empty provider-key placeholders removed (each checked empty first).
  `docker compose ps` → empty. `personalfi-dev-db-1` left running, as instructed.
- Gate-only files deleted: the temporary `apps/api/test/db/gate3-eth-one-row.test.ts` (never
  in the tree); outside the repo, the virtual passkey credential, the bootstrap output (its
  enrolment token was consumed at step 1), the Plaid Sandbox public-token file (consumed),
  the plaintext export and the snapshot dump. The walk scripts under `/tmp/gate3/` remain
  for a re-run; they hold no secret.
- `git status` at the end: this file, `screenshots/gate-*.png` (17 committed in `1d45c16`
  plus `gate-16`, `gate-17` new), **and three `screenshots/wp3.12-*.png` this gate did not
  write** — rewritten by the orchestrator's Playwright re-verification of F-1 (`c4ccf7c`'s
  message: "Playwright walkthrough + networth 6/6"), the O-3 side effect; left for the
  orchestrator to keep or restore. The F-1 source files are committed (`c4ccf7c`) and were
  not touched after it.
