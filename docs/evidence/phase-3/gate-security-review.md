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

_PENDING — written last._

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

| Stage                                                                        | Result                                                                                                                                                         |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `just typecheck` (`tsc -p tsconfig.json`)                                    | pass (18 s)                                                                                                                                                    |
| `just lint` — prettier + eslint                                              | pass; 0 errors, 1 pre-existing warning (`react-hooks/incompatible-library` on TanStack `useVirtualizer`)                                                       |
| `just lint` — schema ownership                                               | pass — `99 table(s) claimed across 14 package(s), 79 defined`                                                                                                  |
| `just lint` — `check-numeric-boundaries` (WP 3.14, new)                      | self-test PASS (8 bad declarations caught, good fixture clean); **PASS — 689 files scanned, 0 violations, 70 exempt identifiers** (exemptions ruled on below) |
| `just check-proxy-routes`                                                    | PASS — Caddyfile routes `/api/*`, covering all **26** contract prefixes (Phase 3 adds `/holdings`, `/investments`, `/market-data`, `/net-worth`, `/prices`, `/securities`) |
| `node scripts/check-ci-projects.ts`                                          | self-test PASS; **PASS — all 40 projects covered (25 in `test`, 16 in `migration-test`)**                                                                      |
| vitest, 25 non-db projects (every project without `db` in its name)          | **Test Files 152 passed (152)** / **Tests 1974 passed \| 6 skipped (1980)**, 49.3 s                                                                            |
| vitest, 14 db projects (all `*-db` + `db`, except `api-db`)                  | **Test Files 59 passed (59)** / **Tests 514 passed (514)**, 518.0 s                                                                                            |
| vitest `api-db`, files 1–20 of 39 (alphabetical)                             | **Test Files 20 passed (20)** / **Tests 115 passed (115)**, 114.3 s                                                                                            |
| vitest `api-db`, files 21–39                                                 | **Test Files 18 passed \| 1 skipped (19)** / **Tests 107 passed \| 4 skipped (111)**, 177.5 s                                                                  |
| web vitest (`pnpm --filter @app/web test`)                                   | **Test Files 51 passed (51)** / **Tests 295 passed (295)**, 29.5 s                                                                                             |
| `pnpm --filter @app/web build` (strip-sourcemaps, sw-precache, CSP static)   | pass — 93 source maps removed, precache excludes the kitchen-sink chunk, 1 HTML file with no inline `<script>`/`style=`                                         |
| `just playwright-check`                                                      | **41 passed, 2 skipped (1.4 m)** — the 2 skips are `cold-start.spec.ts`, which self-skips without a live stack (it is run against the live stack in §3)        |
| gitleaks, full history, CI's pinned digest                                   | pass — 227 commits, no leaks                                                                                                                                   |
| `check-history-rewrite-before-push.sh`                                       | PASS                                                                                                                                                           |
| license gate + `THIRD_PARTY.md` drift                                        | PASS, no drift                                                                                                                                                 |
| `just hardening-check` (self-test, then the real files)                      | pass — 10 secrets held to the strict bar, 0 violations; `check-secret-ownership` PASS                                                                         |
| `.trivyignore` expiry + trivy filesystem scan                                | pass — 0 vulnerabilities in `pnpm-lock.yaml`, 0 misconfigurations in the three Dockerfiles                                                                     |

**Totals.** Backend: **249 files / 2710 tests passed, 10 skipped** (152 + 59 + 38
files; 1974 + 514 + 222 tests). Web: **51 files / 295 tests**. Playwright: **41 + 2
skipped**. Every stage `just verify` runs, run, and green.

**The 10 skipped backend tests, named** (all are live-credential or live-sink gates,
each a visible skip rather than a silent pass):

| Project              | Test                                                                                              | Skips because                                          |
| -------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `connector-coinbase` | `live Coinbase (read-only) > asserts scope, reads five endpoints, and re-runs the R6 probe…`      | no CDP key on this host                                |
| `connector-plaid`    | `live Plaid Sandbox > links, syncs, breaks, reconnects and revokes a real Sandbox Item`           | no `PLAID_CLIENT_ID`/`PLAID_SECRET` in the shell       |
| `integrations`       | `live provider smokes >` tiingo / coingecko / fred / openfigi (4 tests)                           | no market-data key in the shell                        |
| `api-db`             | `plaid-sandbox.test.ts > links a real Sandbox Item through /connections/plaid/exchange…`          | no Plaid creds in the shell                            |
| `api-db`             | `market-data-routes.test.ts > a live test fetch reaches the provider through the egress guard`   | `it.runIf(LIVE)`                                       |
| `api-db`             | `notifications-delivery.test.ts >` real ntfy push / real SMTP send (2 tests)                      | dev-sinks not up (`127.0.0.1:2586`/`:1025` refused) — **gate input (4), exercised in §3** |

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

| #       | Never                                        | Sabotage (source, not test)                                                                                                                                         | Observed                                                                                                                                                                                                                                                                                                                                                  | Red first try |
| ------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| S-Q1    | a quantity never becomes a float             | `investments/src/lots-store.ts`: `Quantity.fromDatabaseString(row.quantity)` → `Quantity.of(String(Number(row.quantity)))`                                          | `investments-db` `× 0.00000001 BTC survives a database round trip`, `× every NUMERIC(38,18) boundary value round-trips exactly` — 2 failed / 242                                                                                                                                                                                                         | yes           |
| S-Q2    | (same, the engine's weight)                  | `investments/src/lots.ts` `quantityWeight`: `BigInt(…replace('.', ''))` → `BigInt(Math.round(Number(…) * 1e18))`                                                    | `investments` `× round-trips any 18-decimal quantity through the weight and back` — `expected 159718324709781696n to be 159718324709781697n` (the float lost the last unit)                                                                                                                                                                              | yes           |
| S-FX1   | a missing FX rate never defaults to 1.0      | `investments/src/fx.ts`: the terminal `throw new FxRateUnavailable(…)` → `return { rate: '1', source: 'fred', … }` (a par rate dressed as a provider observation)   | `investments` 4 red (`× a missing FX rate is an explicit error, never 1.0`, `× never returns 1 for a pair it has no observation for`, `× does not cross via USD…`, `× SABOTAGE: a reader that fell back to 1.0…`); **and over HTTP**: `api-db` `× POST /net-worth/corrections surfaces planning.fx_rate_missing rather than defaulting to 1.0` — `expected 200 to be 409` | yes           |
| S-FX2   | (same, planning's provenance guard)          | `planning/src/fx.ts` `assertRateIsAnObservation`: `if (quote.source === 'identity')` → `if (false)`                                                                 | `planning` `× refuses a reader that answers the identity for a genuine cross pair` — `promise resolved … instead of rejecting`; `× allows the identity only when the two codes are literally equal`                                                                                                                                                      | yes           |
| S-SEAL1 | a sealed net-worth day never changes         | `planning/src/store.ts` `markDirty`: `AND sealed_at IS NULL` deleted (the "simplified WHERE" a late balance would take)                                              | `planning-db` `× marks the open day dirty and leaves a sealed day alone` — the database refused: `23514`, constraint `net_worth_daily_sealed_rows_are_immutable`                                                                                                                                                                                        | yes           |
| S-SEAL2 | (same, the database guard alone)             | `0017_net_worth_daily.sql` trigger: `IF OLD.sealed_at IS NOT NULL THEN RAISE` → `IF false THEN RAISE`                                                               | `planning-db` `× SABOTAGE: lets the writer update a sealed row, and the database refuses by name` — `expected 'net_worth_daily_net_is_assets_minus_l…' to be 'net_worth_daily_sealed_rows_are_immut…'` (the row was still refused, by a _different_ CHECK; the test names the constraint, so it saw the trigger die)                                         | yes           |

S-SEAL1/S-SEAL2 are the unit half; the stack half the dispatch asks for (snapshotter run
twice over live data, sealed range diffed byte for byte) is in §3.

### 2.2 Gate input (2) — WP 3.4's `allowedSchemes` "honest gap"

Three sabotages, run to decide whether this is a doubled control or a missing test:

| #       | Sabotage                                                                                          | Observed                                                                                                                                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S-SCH-a | `integrations/src/egress.ts`: `allowedSchemes: ['https']` → `['https', 'http']` (WP 3.4's own B)   | `integrations` egress suite **17/17 green** — reproduced WP 3.4's observation exactly                                                                                                                              |
| S-SCH-b | `platform/src/egress/policy.ts` `checkUrl`: `if (scheme !== 'https')` → `if (false)`, nothing else | **red in both consumers**: `integrations` `× one host per adapter > only https, only 443` **and** `notifications` `× the refusal matrix holds for every class of destination` — `cleartext http: expected true to be false` |
| S-SCH-c | both at once                                                                                      | `integrations` `× only https, only 443`                                                                                                                                                                            |

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

| Run                                                                                                                                                             | Result                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mirror, fix in place                                                                                                                                            | **green** (and 3.14a's own test green beside it) — `Tests 2 passed`                                                                                                                                                                                                                         |
| Mirror, with 3.14a reverted (`plaid/src/map.ts`: `security: securityFact` → the fact narrowed to `[strongestIdentifier(…)]`, i.e. the pre-3.14a single identifier) | **both red**: 3.14a's `× …still merges with an earlier ticker-only sighting` — `expected [ {…}, {…} ] to have a length of 1 but got 2`; the mirror `× GATE3 mirror…` — `mirror order: one security, not two: … got 2` |

The fix is symmetric, as WP 3.14a predicted, and the mirror test discriminates: it is
red exactly when the defect is present. Ruling in §5.

### 2.4 Securities identity, Coinbase, watch-only wallets

| #       | Control                                              | Sabotage                                                                                                                              | Observed                                                                                                                                                                                                                                                                                                                                                                         | Red first try       |
| ------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| S-R1    | an unmapped security never becomes two rows          | `investments/src/resolver.ts`: look up existing rows by the **strongest** identity key only, not the whole identifier set             | 5 red incl. `× ETH as a Coinbase ticker, a chain+contract and a brokerage CUSIP resolve to one securityId` and `× two identifiers for one security never create two rows`                                                                                                                                                                                                       | yes                 |
| S-R2    | a provider id is evidence, never the identity (D25)  | `investments/src/identifiers.ts`: a `proprietary` id canonicalised with `identity = true`, its abstention dropped                     | `× a provider identifier never becomes the identity`; `× an unresolvable identifier fails loudly and emits SecurityResolutionFailed rather than minting a row`                                                                                                                                                                                                                  | yes                 |
| S-CB1   | a trade-capable CDP key never reaches the API        | `coinbase/src/connector.ts` `#assertViewOnly`: `if (forbidden.length > 0)` → `if (false)` — i.e. the connector is handed a key claiming `can_trade`/`can_transfer` and no longer refuses it | 5 red: `× a key claiming can_trade is refused at startup`, `× …and again before a sync, not only at boot` (`listAccounts did not re-check the key`), `× a key with can_trade is refused before any data call` (`['key_permissions', …(13)]` — thirteen data calls were made), `× refuses can_transfer…`, `× health reports the scope refusal by throwing` | yes                 |
| S-CB2   | no trading endpoint is reachable                     | `coinbase/src/client.ts` `assertReadOnlyPath`: `if (isReadOnlyPath(path)) return;` → `return;`                                        | 6 red: `× refuses to build a request that would place an order` / cancel a batch / edit an order / move funds between portfolios / preview an order / close a position                                                                                                                                                                                                           | yes                 |
| S-CB3   | an on-ramp deposit is a transfer                     | _invalid attempt — my error_: I sabotaged the **withdrawal** branch of the `providerCategory` ternary, not the deposit. It was still caught (`× reports a genuine withdrawal as a transfer out`) but it is not the control named | —                                                                                                                                                                                                                                                                                                                                                                                | (not counted)       |
| S-CB3b  | (same, the deposit branch)                           | `coinbase/src/ledger.ts`: inflow `providerCategory` → `GENERAL_MERCHANDISE`                                                           | `× a USD deposit followed by a BTC buy yields one transfer, one trade and zero spending`, `× a fiat deposit is a transfer, never income`                                                                                                                                                                                                                                        | yes                 |
| S-CB4   | the CDP JWT is EdDSA, not ES256                      | `coinbase/src/provider.ts`: `CDP_JWT_ALGORITHM = 'ES256'`                                                                             | `× a JWT is EdDSA, expires in 120 s and is bound to one method and path` — `expected 'ES256' to be 'EdDSA'`                                                                                                                                                                                                                                                                    | yes                 |
| S-CB5   | the on-ramp's second hop: `TRANSFER_IN_ACCOUNT_TRANSFER` → `transfers.between_accounts` | _invalid attempt — my error_: mapped it to `shopping.general`, which is not a real leaf; red only on "every code maps to an assignable leaf" | —                                                                                                                                                                                                                                                                                                                                                                                | (not counted)       |
| S-CB5b  | (same, a real spending leaf)                         | `categorization/src/pfc-map.ts`: `TRANSFER_IN_ACCOUNT_TRANSFER` → `shopping.other_shopping`                                           | **GREEN.** `categorization`, `categorization-db`, `connector-coinbase`, `budgeting`, `api` — 532 passed; `api-db` reports-aggregation + categorization-wiring — 5 passed. **No test in the tree fails when a Coinbase on-ramp deposit is categorised as shopping.** → finding **G3-3**                                                                                          | **no — green**      |
| S-W1    | a watch-only connector never accepts private material | `walletrpc/src/guard.ts` `assertNoPrivateMaterial`: `if (kind === null) return;` → `if (kind === null \|\| true) return;`             | 7 red: WIF, xprv, yprv, zprv, 12-word seed, raw 32-byte hex, `0x`-prefixed hex                                                                                                                                                                                                                                                                                                  | yes                 |

### 2.5 Routes: scope, step-up, key presence

| #      | Control                                      | Sabotage                                                                                                          | Observed                                                                                                                                                                                                                         | Red first try |
| ------ | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| S-S1   | the WP 3.14a S1 test (`holdings.user_id`)    | `routes/investments.ts` `readHoldings`: `WHERE h.user_id = …` → `WHERE true`                                      | `× a holding whose security belongs to another user is visible to neither` — `expected 3 to be 2`; the other 14 route tests green — WP 3.14a's observation reproduced exactly                                                    | yes           |
| S-S1m  | the mirror: `securities.user_id` alone       | `readHoldings`: `AND s.user_id = …` dropped from the join, `h.user_id` kept                                       | **red** — `× …visible to neither` — `the planted row is not the planter's to see either: … got 1`. WP 3.14a §4 said its test "does not, by itself, prove `securities.user_id` is" load-bearing; it does — the planted row covers both predicates | yes           |
| S-SU1  | step-up on `PUT /market-data/priority`       | `routes/market-data.ts`: `requireFreshSession` → `requireSession`                                                 | `× reordering the ladder needs a step-up assertion…`, `× the settings response contains no API key value` (it drives the 403 case too) — `expected 200 to be 403`                                                               | yes           |
| S-K1   | key presence, never a key value              | settings response gains an **undeclared** `keyHint` field carrying a 6-char key prefix                            | green — see note                                                                                                                                                                                                                 | (probe)       |
| S-K2   | (same, into a **declared** string field)     | the prefix appended to the `provider` field                                                                       | red — but because renaming the provider broke the test's provider lookup, not because it matched the prefix. **Not counted as evidence either way.**                                                                              | (probe)       |

S-K1/S-K2 are probes of the test's _strength_, not of the control, and are not in the
count. S-K1 stayed green because the route's Zod response schema **stripped** the
undeclared field before serialisation — a third layer beside "no field can hold a key"
and `ApiKey`'s `[redacted]` rendering. Whether the exit test would catch a _partial_
key smuggled into a declared string field was not established (S-K2 went red for an
incidental reason). Recorded as observation O-2 (Info).

### 2.6 WP 3.13's seven controls (gate input 3 — `wp3.13-carryovers.md` §4)

No surviving sabotage record existed for any of these. All eight rows below (item 1 was
split into its root fix and its wiring) were run by this gate.

| #       | 3.13 item                                   | Sabotage                                                                                                                  | Observed                                                                                                                                                                                                                  | Red first try      |
| ------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| T13-1   | 1 — C-1 root fix (`seedUserState`)          | `bootstrap-seed.ts`: `ensureTaxonomy(…, { userIds: [options.userId] })` → `userIds: []`                                   | `× a user created after boot has taxonomy, advisors and schedules with no restart and no lazy repair` — `expected +0 to be 153`                                                                                           | yes                |
| T13-1b  | 1 — C-1 wiring (`bootstrap-user` calls it)  | `bin/bootstrap-user.ts`: the `seedUserState(…)` call replaced by a stub returning zeros                                    | `× calls seedUserState right after createPrimary, not only through the api onReady pass`                                                                                                                                  | yes                |
| T13-2   | 2 — both lazy repairs are gone              | the old `ensureTaxonomy`-on-GET lazy repair **re-added** to `routes/categories.ts`                                         | `× a user inserted straight into users after boot reads an empty chart, not a lazily-repaired one` — `… got 153`. The repair cannot be re-introduced silently                                                             | yes                |
| T13-3   | 3 — C-5 dirty-on-create                     | `routes/budgets.ts`: the `markDirtyFrom(…)` call before `recomputeDirty` removed                                           | `× a line created mid-period, after its category was already spent in, comes back dirty-recomputed with no extra call` — `expected { minor: '0' } to deeply equal { minor: '-5000' }`                                    | yes                |
| T13-4   | 4 — `?statuses=pending_review`              | `routes/insights.ts` `statusList`: the `z.union([enum, array])` → bare `z.array(enum)`                                     | `× the pending_review filter returns exactly the queue the inbox needs`                                                                                                                                                   | yes                |
| T13-5   | 5 — `?encrypt=true` never downgrades        | `bundle.ts`: **both** refusal branches → return plaintext (recipients file absent; `age` binary absent)                   | `× AgeUnavailableError names the recipients file, not a bare ENOENT` — `promise resolved "Buffer[…]" instead of rejecting`. The whole file was run (3 tests), incl. the wrong-identity test WP 3.13 never ran — green    | yes                |
| T13-5b  | 5 — isolated: the `age`-not-on-`PATH` branch | `bundle.ts`: only `ENOENT` → `resolve(Buffer.from(plaintext))`, recipients file present                                   | **GREEN — 3 passed.** Nothing tests that a missing `age` binary refuses rather than returning plaintext, and the production api image **has no `age` binary** (§3), so this is the branch production takes. → **G3-4**  | **no — green**     |
| T13-6   | 6 — module-flag defaults pinned             | `platform.ts`: `module.notifications` `defaultEnabled: true` → `false`                                                    | `× every documented module flag exists with its documented default…` — `module.notifications default changed from the documented value`                                                                                  | yes                |
| T13-7   | 7 — merchant-token construction pinned      | `snapshot/tokens.ts` `deriveTokenKey`: label `personalfi/v1|advisor-tokens` → `v2`                                        | 3 red: `× deriveTokenKey is pinned…`, `× a merchant token is pinned…` (`MERCHANT_eb4f916afb51` vs `MERCHANT_f17df14b9b54`), `× ref() is a uuid…`                                                                         | yes                |

### 2.7 Wiring guards and the two CI checks

| #       | Control                                                   | Sabotage                                                                                                                      | Observed                                                                                                                                                                                                                                                                                  | Red first try  |
| ------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| S-MF1   | a module flag off registers nothing (Phase 3 modules)     | `platform.ts` `resolveModules`: the `isEnabled` answer is recorded but the `continue` is removed (the Phase 2 S-W1 shape)     | 3 red: Phase 2's `× a module flag off registers no consumer, no job…`, and Phase 3's `× registers every event @ctx/investments and @ctx/integrations define`, `× a flag that is off contributes no event, no consumer, no job and no schedule` — `got 6`                                   | yes            |
| S-SN1   | schedule names match the DB CHECK (the crash-loop shape)  | `modules.ts`: `PRICE_REFRESH_SCHEDULE_NAME = 'integrations.price-refresh'` (hyphen)                                           | 3 red incl. `× every schedule and job name matches the CHECK constraint the database itself carries`                                                                                                                                                                                      | yes            |
| S-P1    | `assertPoolCoversLeases`                                  | `worker.ts`: `if (poolMax > pinned) return;` → `if (poolMax > pinned \|\| true) return;` (the check never speaks)             | **GREEN — `api` 75/75.** The only test (`regate-worker-boot.test.ts`) asserts that the **string** `assertPoolCoversLeases` appears in `worker.ts`. → **G3-5**                                                                                                                            | **no — green** |
| S-P2    | the pinned-connection reservation itself                  | `worker.ts`: `WORKER_PINNED_CONNECTIONS` per-consumer term `MODULE_FLAGS.length` → `0 * MODULE_FLAGS.length` (reintroduces the wiring-batch deadlock arithmetic: 5 reserved for 5 + 7 pinned) | **GREEN — 75/75.** The regex test matches the text `DATABASE_POOL_MAX + WORKER_PINNED_CONNECTIONS` and never evaluates the constant. → **G3-5**                                                                                                     | **no — green** |
| S-M19   | 0019 scope-check registration test                        | `0019_snapshot_grant_scopes_v1_1.sql`: `'market.rates'` dropped from the widened CHECK                                        | `× every advisor scope can actually be granted, or is a recorded migration gap` — `expected [ 'market.rates' ] to deeply equal []`                                                                                                                                                      | yes            |
| S-QC1   | `check-ci-projects` catches a dropped project             | `ci.yml`: `--project investments-db` removed                                                                                  | `FAIL — 'investments-db' is declared in vitest.config.ts but appears in neither ci.yml job's --project list`, exit 1                                                                                                                                                                     | yes            |
| S-QC2   | `check-numeric-boundaries` catches a float price          | `integrations/src/market-data.ts`: `export const lastClosePrice: number = 232.35;`                                            | `FAIL — 1 violation(s) in 689 file(s)`, exit 1                                                                                                                                                                                                                                           | yes            |
| S-QC3   | (same, `toFixed` on a quantity)                           | `investments/src/lots.ts`: a `formatQuantity(quantity) { return quantity.toFixed(2) }` added                                  | `FAIL — 1 violation(s)`, exit 1                                                                                                                                                                                                                                                          | yes            |

### 2.8 Domain controls, one or more per remaining work package

| #       | WP    | Control                                              | Sabotage                                                                                                         | Observed                                                                                                                                                                                                                             | Red first try          |
| ------- | ----- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| S-L1    | 3.2   | wash-sale window is 61 days, day 31 outside          | `wash-sale.ts`: `<= WASH_SALE_WINDOW_DAYS` → `<= WASH_SALE_WINDOW_DAYS + 1`                                      | `× a repurchase on day 30 after a loss is flagged POSSIBLE_WASH_SALE and one on day 31 is not`                                                                                                                                       | yes                    |
| S-L2    | 3.2   | unknown basis is `unavailable`, never zero           | _invalid attempt_: I broke `costBasisOf`'s **second** null check (line 160), which is unreachable because line 156 already returns `unavailable` for every null-basis lot — a dead guard, green, not the control | —                                                                                                                                                                                                  | (not counted)          |
| S-L2b   | 3.2   | (same, the live guard)                               | `basis.ts` `costBasisOf`: both null checks removed                                                               | `× an unknown basis yields unavailable, not zero`, `× a lot with unknown basis reports unrealized gain as unavailable, never zero`                                                                                                   | yes                    |
| S-A1    | 3.3   | the allocation denominator includes cash             | `analytics/allocation.ts`: the total skips cash-equivalent holdings                                              | 13 red incl. **`× allocation matches the committed spreadsheet fixture to the cent`** and the seed's `× …rebuilt from seed shapes`                                                                                                   | yes                    |
| S-A2    | 3.3   | drift band is an absolute 5 points                   | `analytics/drift.ts`: `points('5')` → `points('4')`                                                              | `× a 4.9-point gap proposes nothing and a 5.1-point gap proposes a trade`                                                                                                                                                           | yes                    |
| S-NW1   | 3.10  | `networth.summary` rounded to $100                   | `snapshot/builder.ts`: `net_worth` rounded to 1 minor unit                                                       | `× networth.summary rounds to $100…` — `expected '262350' to be '260000'`                                                                                                                                                           | yes                    |
| S-I1    | 3.10  | I1 withholds above 10% unclassified                  | `investing/allocation.ts`: the `unclassified_pct > threshold` guard → `false &&`                                 | `× I1 withholds when unclassified exceeds 10 percent`, `× the ceiling is a tenth, and the comparison is strictly greater`                                                                                                            | yes                    |
| S-M1    | 3.10a | `holdings.aggregate` minimisation                    | `snapshot/builder.ts` `#holdingsAggregate`: `quantity: '12.5'` added to each top position                        | `× emits no securityId, no account id, no quantity and no cost basis` — `not to contain 'quantity'`; and the published schema refuses it (`unrecognized_keys: ["quantity"]`)                                                        | yes                    |
| S-NW2   | 3.8   | an investment account is never backfilled by subtraction | `interpolate.ts`: `investment: 'quantity_times_price'` → `'transaction_subtraction'`                           | 7 red incl. `× an investment account is never backfilled by the transaction-subtraction path` and the hand-computation reconcile                                                                                                    | yes                    |
| S-UI1   | 3.12/3.14 | CoinGecko attribution where a crypto price is     | `HoldingsTable.tsx`: the attribution block gated `false &&`                                                      | web `× renders the CoinGecko attribution on the holdings tab because BTC is coingecko-priced`. (My Playwright half of this row failed to launch under the harness's command line; not claimed.)                                     | yes                    |

Gate input (1) was also probed here, as a sabotage in the opposite direction:
**INPUT-1** gave `createInsightsInvestmentsPort` the source it lacks
(`domain.ts`: `targets: []` → a real two-class target set). Result:
`× the investing rules with no field behind them are silent, and it is these three` —
`builtin.investing.drift unexpectedly fired: expected 2 to be +0`. Given a target, I1
proposes two drift insights over the real synced portfolio; its silence at HEAD is the
missing source, not a broken rule. Ruling in §5.

### 2.9 Scorecard

| Group                              | Valid sabotages | Red first valid attempt | Green (no test existed)          |
| ---------------------------------- | --------------- | ----------------------- | -------------------------------- |
| §2.1 the "never" list              | 6               | 6                       | —                                |
| §2.2 scheme (the load-bearing pin) | 1               | 1                       | —                                |
| §2.3 mirror-order merge            | 1               | 1                       | —                                |
| §2.4 identity / Coinbase / wallet  | 8               | 7                       | S-CB5b                           |
| §2.5 routes                        | 3               | 3                       | —                                |
| §2.6 WP 3.13's seven               | 9               | 8                       | T13-5b                           |
| §2.7 wiring guards + CI checks     | 8               | 6                       | S-P1, S-P2                       |
| §2.8 per-WP domain controls        | 9               | 9                       | —                                |
| **Total**                          | **45**          | **41**                  | **4**                            |

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

_IN PROGRESS — steps are appended as they are observed. Stack is UP while this says IN
PROGRESS; a resuming reviewer must `docker compose down -v`, `rm compose.override.yml`,
and remove the seven empty provider-key placeholders listed in 3.1 before anything else._

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

| Observation                                  | Result                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `migrator`                                   | exit 0, `migrations complete: 19 applied, 0 already present` (…`0017_net_worth_daily`, `0018_connection_sync_facts`, `0019_snapshot_grant_scopes_v1_1`)                                                                                                                                                                                                        |
| services                                     | db, api, worker, proxy, backup all `healthy` within 19 s                                                                                                                                                                                                                                                                                                       |
| worker at boot (13:57:53Z), no holder yet    | `"no account holder yet; the worker will idle until one is enrolled"`                                                                                                                                                                                                                                                                                         |
| `just bootstrap-user name="Gate Three Holder" timezone="America/New_York"` (13:58:20Z, ran inside the api container) | `taxonomy 153 categories seeded`, `advisors 31 manifests registered`, `schedules categorization.retrain_weekly, notifications.deliver, notifications.digest, insights.nightly, integrations.price_refresh, planning.net_worth_snapshot`, `key custody unlocked · argon2id m=1048576 KiB t=4 p=4 · 5969 ms`. The enrolment token is not recorded here. |
| **worker, unprompted, 13:58:23Z**            | **the worker process exited with code 0 and Docker restarted it** (`RestartCount=1`, `FinishedAt 13:58:23.196Z`, `StartedAt 13:58:23.399Z`, no `shutting down` line — it was not signalled). The restarted process found the holder and logged `modules resolved` with **all 10 modules enabled, `disabled: []`**, 7 consumers (`…investments.lots@v1`, `planning.net_worth@v1`), job kinds including **`integrations.price_refresh`** and **`planning.net_worth_snapshot`**, `scheduler leadership acquired`, `worker ready`. This gate issued no restart. → **finding G3-1**, below |
| api                                          | `RestartCount=0`                                                                                                                                                                                                                                                                                                                                              |
| `schedules` (psql)                           | 7 rows; `integrations.price_refresh` next `2026-09-27 07:45Z` and `planning.net_worth_snapshot` next `08:00Z` = 03:45 / 04:00 `America/New_York` — the holder's zone, not the container's                                                                                                                                                                  |

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

| Observed                                                                                                 | Result                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| scheduler tick                                                                                           | all five fired at **14:10:34.136Z** and re-armed to their next cron (`price_refresh` → 2026-09-27 07:45Z = 03:45 ET, `net_worth_snapshot` → 08:00Z, `insights.nightly` → 08:15Z, `connections.nightly_sync` → 07:15Z, `retrain_weekly` → 08:00Z Sunday)                                                    |
| unprompted, on their own cron                                                                            | `notifications.deliver.<user>` ran 14:05Z and 14:10:04Z (`*/5`), `notifications.digest.<user>` ran 14:05:04Z (hourly) — each a `succeeded` job                                                                                                                                                         |
| `categorization.retrain`, `insights.run_all` → 31 `insights.run`                                        | all `succeeded`/settled: `advisor_runs` **25 completed, 6 refused** (`advisor_disabled` — the six that ship off), `domain_events` `insights.AdvisorRunStarted`/`Completed` ×25                                                                                                                          |
| **`integrations.price_refresh`**                                                                         | `succeeded`, 1 attempt. Worker log `price refresh complete … "priceRowsWritten":0,"sources":[]`; **`domain_events` gained `integrations.PricesUpdated`** `{providers: [], priceRowsWritten: 0, fxRowsWritten: 0, securitiesUnpricedCount: 0}`; `market_data_runs` 0 rows (no request ever left — a refusal-free, key-free run spends nothing, WP 3.4 §3). **A zero-key install degrades without crashing.** The prices on screen are the ones loaded in 3.3; they do not move (no source exists), and the ladder keeps labelling OLDCO `STALE` |
| **`planning.net_worth_snapshot`**                                                                        | `succeeded`; `net_worth_daily` 2026-09-26 revision 1, `source observed`, **`stale_price true`** (OLDCO), `accounts_counted 3`, **`net_worth_minor 17649961`**; `domain_events` `planning.NetWorthSnapshotTaken`. The consumer logged `no open net-worth day to mark; the snapshotter computes it from scratch` on `PricesUpdated` — the documented "mark dirty, never insert a placeholder" path |
| `connections.sync_all`                                                                                   | `succeeded` (the manual connection's scheduled sync → `sync_runs` `transactions success scheduled`)                                                                                                                                                                                                     |
| queue latency (observation, not a finding)                                                               | the price refresh, enqueued 14:10:34Z, ran at **14:16:24Z** — behind the 31-job advisor fan-out, which drained one job roughly every 5 s (the job-runner poll interval). At 03:45 vs 04:15 the two never collide; recorded so nobody reads a six-minute wait as a hang                                  |

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

| Destination (Tiingo's per-adapter policy unless stated)                        | Result                                                     |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `https://db:5432/`, `https://db/`                                              | refused `host_not_allowed`                                 |
| `https://169.254.169.254/latest/meta-data/`                                    | refused `literal_ip`                                       |
| `https://metadata.google.internal/`                                            | refused `host_not_allowed`                                 |
| `https://127.0.0.1/`, `https://[::1]/`, `https://2130706433/` (decimal)        | refused `literal_ip` (all three)                           |
| `http://api.tiingo.com/…`                                                      | refused `scheme_not_allowed`                               |
| `https://api.tiingo.com:8443/`                                                 | refused `port_not_allowed`                                 |
| `https://user:pw@api.tiingo.com/`                                              | refused `userinfo_in_url`                                  |
| Tiingo's policy → `api.coingecko.com`                                          | refused `host_not_allowed` (one host per adapter)          |
| the context-wide policy → `api.coinbase.com`                                   | refused `host_not_allowed` (crypto hosts are not market data) |
| `https://api.tiingo.com/…` (real DNS)                                          | **allowed**, 1 public address                              |
| an operator allow-listing `db`, `api` (ports 5432/8080 allowed too)            | **refused `private_address`** — `db resolves to 172.22.0.2 (private)`, `api resolves to 172.22.0.4 (private)`, from the real Docker DNS answer |
| `api.tiingo.com` answering `10.0.0.5` / `[public, 172.22.0.2]` / `::ffff:127.0.0.1` | refused `private_address` (all three — rebinding and mixed answers) |

Every refusal WP 3.4's matrix claims holds in the production image with the production
resolver; the operator-mistake rows are the strongest result — the private-range layer is
independent of the allow-list, as Phase 2's gate found for notifications. Redirects are
not re-proven here (no in-container server); WP 3.4's sabotage D covers them in-suite.

---

## 4. Threat model and findings (Standard D)

_PENDING._

---

## 5. Rulings on the eight gate inputs

_PENDING._

---

## 6. Conditions

_PENDING._
