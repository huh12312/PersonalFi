<!-- SPDX-License-Identifier: MIT -->

# WP 3.14 — carry-over half, evidence

Four small, precisely scoped items owed by earlier packages (dispatch §5 item
3 for item 1; WP 3.12's own §6 seam for item 2; `wp3.13-carryovers.md` §1
rows 6 and 8b for items 3 and 4). This document is written incrementally,
alongside the code, not reconstructed afterward.

Scope discipline: this pass owns `apps/web/src/features/{investments,crypto,
connections,recurring}/**` (additive), `apps/web/e2e/{investments,networth,
crypto-connect}.spec.ts` + `support/mock-{investments,networth}.ts`,
`compose.dev.yml`/`compose.override.example.yml` (dev-sinks only),
`apps/api/test/db/{notifications-delivery,recurring-routes}.test.ts`,
`apps/api/src/routes/recurring.ts`, `packages/contexts/recurring/**`
(additive), and `packages/contracts/openapi/openapi.json` (regenerated).
Concurrently in flight and never touched by this pass: a 3.10a finisher
(`packages/contexts/insights/**`, `apps/api/src/{domain,modules,app,
worker}.ts`) and a 3.14-core agent (`packages/seed/**`, `scripts/**`,
`apps/api/test/db/investments-perf.test.ts`, `ci.yml`,
`docs/TESTING.md`).

---

## 1. Attribution wherever a crypto price appears

**What was missing.** WP 3.12 exported `ProviderAttribution` from
`apps/web/src/features/market-data/Attribution.tsx` specifically so WP 3.11's
investments screens could use it (that component's own doc comment: "Exported
for WP 3.11 to use... this work package owns `features/market-data/**` but
not investments, and cannot edit those files itself"). WP 3.11 never did.
Holdings, per-account detail, allocation and performance all rendered
CoinGecko-priced crypto holdings with no attribution anywhere on screen.

**The wire shape has no `attribution` field to read.** Checked directly
against the generated client (`apps/web/src/api/generated/types.gen.ts`):
`ListHoldingsResponse`/`ListAccountHoldingsResponse` carry `price.source:
string | null` per row (`'coingecko'` among the values `wp3.9-routes.md`'s
ladder names), but neither that type nor `GetAllocationResponse`/
`GetDriftResponse`/`GetPerformanceResponse` carries an `attribution` field —
only `GET /market-data/settings`'s `providers[].attribution` and
`POST /market-data/test-fetch`'s `quote.attribution` do. So the obligation is
derived client-side, per `wp3.4-market-data.md` §4's framing ("the read model
computes `attributionRequirementsOf(...)`... every quote carries its
provider"): `features/market-data/api.ts`'s `useCoinGeckoAttribution()`
(already built by WP 3.12, fetching `GET /market-data/settings`) supplies the
exact licensed text/logo/link, and each investments view decides _whether_ to
render it from its own data.

**What landed.**

| Screen                                           | Signal used                                                                                                                                                                                               |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Holdings table (`HoldingsTable.tsx`)             | `holdings.some(h => h.price?.source === 'coingecko')` — per row, from `GET /holdings`                                                                                                                     |
| Per-account detail (`AccountPositionsPanel.tsx`) | `data.positions.some(p => p.price?.source === 'coingecko')` — per row, scoped to the open account, from `GET /accounts/{id}/holdings`                                                                     |
| Allocation (`AllocationPanel.tsx`)               | `hasCoinGeckoCryptoHolding`, a portfolio-level boolean computed once in `InvestmentsScreen.tsx` from `GET /holdings` and passed down, because `GET /investments/allocation` carries no per-slice `source` |
| Performance (`PerformancePanel.tsx`)             | same portfolio-level boolean — `GET /investments/performance` returns only aggregate TWR/MWR/dollar-gain figures                                                                                          |

Drift was deliberately left out: it is not named in the dispatch item, and its
rows are gap/rebalance analysis rather than a rendered price.

`InvestmentsScreen.tsx` calls `useCoinGeckoAttribution()` once and computes
`hasCoinGeckoCryptoHolding` once, passing both down; each panel independently
decides whether _its own_ data justifies rendering the block, so a non-crypto
account's detail view (e.g. "Taxable brokerage") renders nothing.

**Files touched:** `apps/web/src/features/investments/{HoldingsTable,
AccountPositionsPanel,AllocationPanel,PerformancePanel,InvestmentsScreen,
fixtures}.tsx/.ts`, `apps/web/src/features/investments/InvestmentsScreen.test.tsx`
(added a `/api/market-data/settings` route stub — `useCoinGeckoAttribution`
now fires on every mount — plus three new assertions), `apps/web/e2e/
investments.spec.ts`, `apps/web/e2e/support/mock-investments.ts` (BTC's price
now carries `source: 'coingecko'`; added `marketDataSettingsResponse()` +
route).

**Test.** `apps/web/e2e/investments.spec.ts` → `'the CoinGecko attribution is
present on every investments screen showing a crypto price'` — visits
Holdings, the Coinbase account's per-account detail (asserting the
attribution appears there but _not_ on a non-crypto account's own detail
view), Allocation and Performance in one flow, asserting
`attribution-coingecko`'s text and its link's `href`, and running axe on each.
Also three narrower assertions in `InvestmentsScreen.test.tsx` (one per
screen family) for fast unit-level coverage.

**Screenshots.** Not captured separately — `investments.spec.ts`'s existing
`'every investments screen is axe clean in both themes'` test already shoots
`wp3.11-holdings-{theme}.png`, `wp3.11-account-detail-{theme}.png`,
`wp3.11-allocation-{theme}.png` and `wp3.11-performance-{theme}.png`, and now
carries the attribution block in each (that test opens "Taxable brokerage",
not "Coinbase", for its account-detail shot, so the attribution is visible
there via the Holdings/Allocation/Performance shots and the dedicated
attribution test above, not the account-detail shot specifically). Recorded
as a gap rather than duplicating screenshot infrastructure for one more
crop.

---

## 2. Crypto connect forms into the link flow

**What was missing.** WP 3.12 built `features/crypto/{CoinbaseKeyForm,
WalletWatchOnlyForm}.tsx` as fully self-contained forms against
`useCreateConnectionMutation`/`useStepUpRetry` — sealed key, step-up gated,
the never-echo behaviour already correct — but could not wire them into
`AddConnectionDialog`'s `credential_form` branch because that work package
did not own `features/connections/**`. Its own evidence
(`wp3.12-networth-ui.md` §6) names this seam explicitly and ships
`CryptoConnectScreen.tsx` as a standalone workaround entry point, reachable
only from Settings, not from the real "Add a connection" dialog.

**What landed.** `AddConnectionDialog.tsx`'s `credential_form` branch now
looks the connector's `provider` up in a small `CREDENTIAL_FORMS` map
(`coinbase → CoinbaseKeyForm`, `wallet_rpc → WalletWatchOnlyForm`) and renders
the matched form with `onDone={handleDone}`; a `credential_form` connector
outside the map still renders the original placeholder, so an unrecognised
future connector degrades the same way this branch always has. Nothing in
either form changed — `pnpm --filter @app/web gen` confirmed the generated
client (connections `POST /connections` request shape, `providers` list) is
current and unchanged by this pass; both forms already matched it.

**Files touched:** `apps/web/src/features/connections/AddConnectionDialog.tsx`,
`apps/web/e2e/networth.spec.ts`, `apps/web/e2e/support/mock-networth.ts`
(added step-up gating + `lastConnectionBody`/`connectionRequiredStepUp` to the
existing `POST /connections` stub, matching `mock-investments.ts`'s
basis-method pattern — no prior test exercised that route, so nothing broke).

**Test.** `apps/web/e2e/networth.spec.ts` → `'a watch-only wallet links from
the add-connection dialog and the private-key warning is shown'` — opens
`/accounts/connections`, opens "Add a connection", switches to the wallet
tab, asserts the verbatim "We will never ask for a private key or a seed
phrase" line, submits an Ethereum address, and asserts (a) the dialog closes,
(b) the POST body that actually reached the server matches `{ provider:
'wallet_rpc', input: { chain: 'ethereum', value } }`, and (c) it only arrived
after the step-up ceremony (`state.connectionRequiredStepUp === true`) —
`installFakeWebAuthnAssertion` answers the passkey prompt `useStepUpRetry`
triggers on the first `step_up_required` refusal.

**Playwright config.** No new spec file — this test lives in the existing
`networth.spec.ts`, already matched by `playwright.config.ts`. Nothing for
the orchestrator to add.

---

## 3. `dev-sinks` compose profile + delivery test

**What was missing.** `docs/evidence/phase-3/wp3.13-carryovers.md` §1 row 6,
verbatim: _"Nothing... `docker/compose.dev-sinks.yml`, named explicitly in the
WP's own `Owns` list (03-phase-3-dispatch.md §3), does not exist... the only
§2 row assigned to 3.13 with zero code toward it."_

**What landed.** A `dev-sinks` profile added to `compose.dev.yml` (the
dispatch named `docker/compose.dev-sinks.yml`; this repo's actual convention
— confirmed by reading the file — is one `compose.dev.yml` with profile-gated
services, the same pattern `compose.yml`'s `sidecar`/`local-llm`/`webhooks`
placeholders already use, so the profile was added there rather than
resurrecting a path-that-was-never-real):

- `mailpit` (`axllent/mailpit:v1.21.3`) — SMTP on `127.0.0.1:1025`, its web UI
  - REST API on `127.0.0.1:8025`.
- `ntfy` (`binwiederhier/ntfy:v2.11.0`) — HTTP on `127.0.0.1:2586` (ntfy's own
  documented unprivileged alternative to `:80`, so no `cap_add` is needed).

Both hardened to the exact same P0-6/P0-7 baseline as `db`: `read_only: true`
(no documented exception needed — neither image is given a persistence path,
so nothing needs a writable volume), `cap_drop: [ALL]`,
`security_opt: ['no-new-privileges:true']`, a non-root `user`, loopback-only
published ports, small `tmpfs` scratch mounts. Verified with `bash
scripts/compose-hardening-check.sh` (read-only run against the real files,
`scripts/**` is out of this pass's scope to edit) — **PASS**, 3 services in
`compose.dev.yml`, 0 violations, the one documented exception is still only
`db`'s pre-existing `missing-read-only` waiver.

`compose.override.example.yml` gained a commented block showing how an
operator running the _full_ `compose.yml` stack would point
`NOTIFICATIONS_ALLOWED_HOSTS` at these two sinks (`mailpit,ntfy`) — the dev
override the item's own wording asks for. `compose.dev.yml` itself runs no
`api`/`worker` (see that file's own header), so this is documentation for a
different, optional topology, not something this pass's own delivery test
depends on.

**The delivery test.** `apps/api/test/db/notifications-delivery.test.ts`, two
cases:

- `'a real ntfy push lands in the dev-sinks ntfy cache, observed by reading
it back'`
- `'a real SMTP send lands in the dev-sinks mailpit mailbox, observed by
reading it back'`

Each probes its sink's loopback port first and calls vitest's test-context
`skip()` — not `describe.skipIf`, which can only see a value computed before
an async probe runs — if the profile is not up, so the file is a clean no-op
in every environment (including this one) where `dev-sinks` was never
started. Verified: `pnpm exec vitest run --project api-db
apps/api/test/db/notifications-delivery.test.ts` → **2 skipped**, 0 failed.

When the profile _is_ up, both cases drive the real `@ctx/notifications`
adapters (`createNtfyChannel`/`createSmtpChannel`), reusing the exact
destination-swap idiom `packages/contexts/notifications/test/
egress-allowlist.test.ts` already established for its own real-local-server
proof (`guardDestination` runs in full against an allow-listed host; only the
_validated address_ a test-only transport/factory dials is swapped for the
dev-sinks container's real loopback port) — never a switch that weakens
`guardDestination`'s "no allow-private-addresses switch, not even for tests"
in production. The SMTP half hand-rolls a minimal sequential SMTP client
(`net.createConnection`, five commands) instead of importing `nodemailer`,
because `scripts/eslint-boundaries.js` allow-lists that package for
`packages/contexts/notifications/` alone. Delivery is confirmed by reading
the message back from each sink's own store (ntfy's `?poll=1` cache; mailpit's
`GET /api/v1/messages`), not by trusting the adapter's own `outcome:
'delivered'`.

**Open item, recorded rather than claimed.** Neither `axllent/mailpit` nor
`binwiederhier/ntfy` was cached in this environment (`docker images` showed
neither), and this pass did not pull ~150 MB of image over the network to
live-verify a real `up`. `docker compose --profile dev-sinks config` is clean
and the hardening gate passes; an actual `up`/delivery round-trip against the
real containers has not been observed by this pass. The two skipped tests
above are the honest state of that proof today — the mechanism is built and
exercised down to the point where a real socket would open, and the point at
which it would open is exactly where it stops for lack of a pulled image.

**Files touched:** `compose.dev.yml`, `compose.override.example.yml`,
`apps/api/test/db/notifications-delivery.test.ts` (new).

---

## 4. `price_change_events` projected onto `GET /recurring/series`

**What was missing.** `wp3.13-carryovers.md` §1 row 8b, verbatim: _"Nothing.
`apps/api/src/routes/recurring.ts`'s `seriesSchema` (lines 82–100) has no
`priceChangeEvents` field or anything naming price changes;
`grep -rn priceChangeEvents apps/api/src/routes/recurring.ts` returns
nothing."_ Confirmed independently before touching anything: `listSeries`
(`packages/contexts/recurring/src/read.ts`) selects only `recurringSeries`
columns — no join, no separate read of `price_change_events` anywhere in the
read model.

**What landed.**

- `packages/contexts/recurring/src/read.ts` — a new, **additive** read
  function, `listPriceChangeEventsBySeries(executor, userId, seriesIds)`,
  returning `ReadonlyMap<seriesId, PriceChangeEventView[]>`, newest-first per
  series. Deliberately a separate function rather than a join folded into
  `listSeries` itself: `RecurringSeriesRow`/`listSeries`'s own return shape
  is byte-for-byte unchanged, so every existing caller (this package's own
  49 tests, `apps/api/src/routes/recurring.ts`'s other reads) is unaffected.
  `userId` is filtered on directly rather than derived from the series ids
  passed in, so a caller cannot be handed another user's events by passing
  their series ids.
- `packages/contexts/recurring/src/store.ts` — `upsertPriceChange` (already
  existed, used internally by `service.ts`'s detection pass) is now exported
  from the package root, so a test can seed a real row through the same
  natural-key upsert the detector itself calls, rather than a raw `INSERT`.
- `apps/api/src/routes/recurring.ts` — `seriesSchema` gained a
  `priceChangeEvents: RecurringPriceChangeEvent[]` field (newest-first,
  `[]` for a series that has never had one, never `null`); the route handler
  fetches `listPriceChangeEventsBySeries` alongside `listSeries` and merges
  by id. A new `RecurringPriceChangeEvent` schema (`id`, `direction`,
  `effectiveDate`, `fromAmount`/`toAmount`/`deltaAmount`/`annualImpact` as
  `Money`, `confirmed`) mirrors the `price_change_events` table's own
  magnitude-not-signed convention (the schema column comment: "Magnitudes,
  not signed amounts").
- `packages/contracts/openapi/openapi.json` regenerated (`just openapi`) and
  `apps/web/src/api/generated/**` regenerated (`pnpm --filter @app/web gen`).
  **Note on the OpenAPI diff's size:** regenerating captures the _whole_
  current app, not just this item — the committed file predated the 3.10a
  finisher's concurrent, uncommitted insights work (`advisorVersion` etc.,
  `wp3.13-carryovers.md` §1 row 8c), so the regenerated file's diff includes
  their in-flight schema changes too. Verified this item's own piece is
  correct and isolated: `RecurringPriceChangeEvent` and
  `RecurringSeries.priceChangeEvents` both present and correctly shaped in
  the regenerated document, checked directly against the parsed JSON.
- `apps/web/src/features/recurring/SeriesList.tsx` — the optional UI item,
  trivial as instructed: a series with at least one price-change event shows
  its latest ("Price increased to $X on 2026-05-15") under the next-due
  line. Reads `(row.priceChangeEvents ?? []).length` defensively even though
  the wire schema makes the field required, so an older fixture this work
  package does not own (an e2e mock, a client not yet regenerated) degrades
  to "no price-change line" instead of throwing.

**Test.** `apps/api/test/db/recurring-routes.test.ts` →
`'a series carries its price-change events'` — seeds a real, confirmed
series (the file's own `beforeAll`), asserts `GET /recurring/series` returns
`priceChangeEvents: []` for it, seeds one event through `upsertPriceChange`,
re-fetches, and asserts the one event's every field (`direction`,
`effectiveDate`, `fromAmount`/`toAmount`/`deltaAmount`/`annualImpact`,
`confirmed`) round-trips exactly, plus that no _other_ series carries it.
Runs alongside the file's existing `?days=45` tests unchanged. Also
`apps/web/src/features/recurring/RecurringScreen.test.tsx` →
`'shows the latest price change alongside a series that has one'` for the
optional UI piece.

**Files touched:** `packages/contexts/recurring/src/{read,store,index}.ts`,
`apps/api/src/routes/recurring.ts`, `apps/api/test/db/recurring-routes.test.ts`,
`packages/contracts/openapi/openapi.json`, `apps/web/src/features/recurring/
{SeriesList,RecurringScreen.test}.tsx`.

---

## 5. Check results

| Check                                                                                                                                                                                                                                                        | Result                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @app/web typecheck`                                                                                                                                                                                                                           | **PASS** (regenerates the client first, then `tsc -b --noEmit`)                                                                                                                                                                                                                                                                                                                  |
| `pnpm --filter @app/web test`                                                                                                                                                                                                                                | **PASS** — 51 files, 295 tests                                                                                                                                                                                                                                                                                                                                                   |
| `pnpm --filter @app/web build`                                                                                                                                                                                                                               | **PASS** — CSP untouched (no new domain, no new directive; nothing in this pass edits `docker/Caddyfile`, an index-html meta tag, or the vite CSP config)                                                                                                                                                                                                                        |
| `pnpm --filter @app/web exec playwright test e2e/investments.spec.ts e2e/networth.spec.ts`                                                                                                                                                                   | **PASS** — 14 tests (includes item 1's and item 2's new tests)                                                                                                                                                                                                                                                                                                                   |
| `pnpm exec vitest run --project recurring --project recurring-db --project api-db apps/api/test/db/recurring-routes.test.ts apps/api/test/db/notifications-delivery.test.ts` (`DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev`) | **PASS** — 6 passed, 2 skipped (the dev-sinks tests, cleanly — see item 3)                                                                                                                                                                                                                                                                                                       |
| `pnpm exec tsc -b --noEmit`                                                                                                                                                                                                                                  | **PASS** (clean; two pre-existing failures in `packages/seed/test/` and `scripts/` — both outside this pass's scope — were observed once mid-pass and had resolved by the final run, presumably the concurrent 3.14-core agent's own in-flight fix)                                                                                                                              |
| `just lint`                                                                                                                                                                                                                                                  | **PASS** (format, eslint, schema-ownership, numeric-boundaries all clean; one pre-existing `TransactionsList.tsx` React Compiler warning, not this pass's file, unrelated to any change here)                                                                                                                                                                                    |
| `node scripts/check-proxy-routes.ts`                                                                                                                                                                                                                         | **PASS** — `/recurring` still covered, 26 contract prefixes total                                                                                                                                                                                                                                                                                                                |
| `docker compose --profile dev-sinks config >/dev/null` (as literally specified, no `-f`)                                                                                                                                                                     | **PASS**, trivially — this reads `compose.yml`, which has no `dev-sinks` profile at all, so compose silently no-ops the profile flag. The meaningful check for this item is `docker compose -f compose.dev.yml --profile dev-sinks config`, run separately — also **PASS**, and additionally verified with `bash scripts/compose-hardening-check.sh` (0 violations, see item 3). |

Also run, not in the required list but load-bearing for this pass's own
confidence: `pnpm exec vitest run --project recurring --project recurring-db`
(49/49 passed, package-level regression check for the additive read/store
exports) and `pnpm --filter @app/web exec vitest run
src/features/recurring/RecurringScreen.test.tsx` (6/6 passed).

---

## 6. Files touched, in total

`apps/web/src/features/investments/{HoldingsTable,AccountPositionsPanel,
AllocationPanel,PerformancePanel,InvestmentsScreen,fixtures,
InvestmentsScreen.test}.tsx/.ts`, `apps/web/src/features/connections/
AddConnectionDialog.tsx`, `apps/web/src/features/recurring/{SeriesList,
RecurringScreen.test}.tsx`, `apps/web/e2e/{investments,networth}.spec.ts`,
`apps/web/e2e/support/mock-{investments,networth}.ts`, `compose.dev.yml`,
`compose.override.example.yml`, `apps/api/test/db/{notifications-delivery
(new),recurring-routes}.test.ts`, `apps/api/src/routes/recurring.ts`,
`packages/contexts/recurring/src/{read,store,index}.ts`,
`packages/contracts/openapi/openapi.json` (regenerated), this file (new).

**Not touched, observed only:** `apps/api/src/routes/investments.ts` showed
as modified in `git status` partway through this pass (two `export` keyword
additions) without this pass having edited it — a concurrent agent's change
surfacing in the shared working tree, not this pass's doing. Left exactly as
found; noted here per the collision-recording convention rather than silently
absorbed or reverted.

## 7. Open items

1. **Item 3's `up`/`down` round-trip is unobserved.** `docker images` had
   neither `axllent/mailpit` nor `binwiederhier/ntfy` cached in this
   environment, and this pass did not pull them. `docker compose config` and
   the hardening gate both pass; a real container start has not been seen.
2. **Item 1's account-detail screenshot doesn't show the attribution block.**
   The existing axe/screenshot test opens the non-crypto "Taxable brokerage"
   account for its `wp3.11-account-detail-*.png` shot; the dedicated
   attribution e2e test covers the Coinbase account's attribution correctly
   but takes no screenshot. Recorded rather than fixed, to avoid restructuring
   shared screenshot infrastructure for one crop.
3. **Item 4's OpenAPI diff is not isolated to this item**, per §4 above — a
   consequence of one generated artifact reflecting a shared working tree
   with a concurrent agent's uncommitted changes in it, not an error in this
   item's own work.
