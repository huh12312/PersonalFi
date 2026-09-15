<!-- SPDX-License-Identifier: MIT -->

# WP 1.6 — Transactions, accounts, and connections UI

Scope: `apps/web/**` — the transactions screen, the accounts screens, the
connections management screen, the SSE-backed sync-status indicator, their
tests, and this evidence file. Master plan §5 Phase 1 / 01-execution-log.md
line 58 ("transactions UI ... connections UI with reconnect CTA").

Repo `/home/chris/Projects/PersonalFi`, branch `main`, built on snapshot
`05f254b` (features/accounts/account-groups.ts, features/sync/useSyncStatus.ts,
Sidebar/TopBar, features/transactions scaffolding, route stubs — all already
on disk and extended here, not replaced).

---

## 1. Screens and routes

| Route                   | Component                                      | Deliverable |
| ----------------------- | ---------------------------------------------- | ----------- |
| `/transactions`         | `features/transactions/TransactionsScreen.tsx` | 1           |
| `/accounts` (layout)    | `routes/_app.accounts.tsx` (`<Outlet/>`)       | —           |
| `/accounts/` (index)    | `features/accounts/AccountsScreen.tsx`         | 2           |
| `/accounts/$accountId`  | `features/accounts/AccountDetailScreen.tsx`    | 2           |
| `/accounts/connections` | `features/connections/ConnectionsScreen.tsx`   | 3           |

`/accounts/connections` (not `/settings/connections`) because the route
stubs already on disk implied it: `TopBar.tsx`'s sync-error pill and
`Sidebar.tsx`'s own error pill both already called
`navigate({ to: '/accounts/connections' })` — a type error before this pass
added the route (no such path existed), and a passing `router.test.tsx`
assertion on `_app.settings.tsx`'s existing placeholder text confirms
settings was **not** meant to move. `_app.settings.tsx` is untouched.

`_app.accounts.tsx` became a layout (`<Outlet/>`) with three children
(`_app.accounts.index.tsx`, `_app.accounts.$accountId.tsx`,
`_app.accounts.connections.tsx`) — TanStack Router's flat file-route
convention, no new library.

### Transactions (`TransactionsScreen.tsx`)

- **Filter bar** (`TransactionsFilterBar.tsx`): debounced search, from/to
  date, multi-select account filter, transfers include/exclude/only,
  pending/excluded/uncategorized-only checkboxes, "Clear filters". URL state
  via the route's `validateSearch: transactionsSearchSchema`
  (`features/transactions/filters.ts`, already on disk).
- **List** (`TransactionsList.tsx`): `@tanstack/react-virtual` over
  `useTransactionsList`'s flattened keyset pages; infinite scroll triggers
  `fetchNextPage` within 5 rows of the bottom; arrow-key roving focus + Enter
  to open; loading skeleton, error state with Retry, empty state that
  distinguishes "no transactions at all" from "no matches for these
  filters".
- **Detail sheet** (`TransactionDetailSheet.tsx`): amount, date, pending vs
  posted badge, excluded badge, transfer badge + pairing detail with a "Not
  a transfer" unpair action (`POST /transfers/{id}/reject`); inline category
  edit and note edit through `PATCH /transactions/{id}` (the existing
  `useTransactionOverlayMutation`, optimistic with rollback).
- **Bulk actions** (`BulkActionBar.tsx`): appears once ≥1 row is selected;
  applies a category or excluded/included to every selected id via
  `POST /transactions/bulk`.
- **Export** (`useExportTransactions.ts`): step-up gated
  `GET /transactions/export.csv`, called imperatively through
  `useStepUpRetry` (existing hook) since a declarative query can't run a
  ceremony between the first 403 and a retry; downloads via the existing
  `downloadTextFile`.
- Amount formatting, currency, and the negative-is-outflow sign convention
  all come from the already-on-disk `<Money>`/`lib/money.ts` — no new
  formatting code was needed for that part.

### Accounts (`AccountsScreen.tsx`, `AccountDetailScreen.tsx`)

- Grouped by type via the existing `groupAccounts` (depository → credit →
  loan → investment → crypto → manual, closed accounts collapsed into their
  own disclosure). New: `groupNetWorth` (`account-groups.ts`) sums each
  group's own accounts per currency (never across currencies) for a
  **net figure per group**, shown in the group header.
- The screen's own hero stat is `GET /net-worth`'s per-currency totals — a
  deliberately different number from a group's own sum, since `/net-worth`
  applies `includeInNetWorth`/closed-account exclusion via its own audit
  trail and a group total doesn't.
- Empty state ("Connect your first account") and a loading/error state with
  Retry.
- `/accounts/$accountId`: account header (icon, name, mask, latest balance,
  an `includeInNetWorth` toggle via `PATCH /accounts/{id}`) plus that
  account's own transactions, reusing `TransactionsList`/
  `TransactionDetailSheet` with a fixed `accounts: [accountId]` filter.

### Connections (`ConnectionsScreen.tsx`)

- List from `GET /connections`: health badge (`connection-health.ts`'s
  `describeConnectionHealth` — active/reauth_required/error+kind/
  disconnected, colour + text together per WCAG 1.4.1), last-synced
  relative time, account count, an expandable sync-run history
  (`GET /connections/{id}/sync-runs`, `SyncRunHistory.tsx`).
- Actions per connection: **Sync now** (`POST /connections/{id}/sync`, no
  step-up — it moves no credential), **Reconnect** (shown only when
  `shouldOfferReconnect` — an unhealthy connection whose connector actually
  has a reconnect flow), **Disconnect** behind a real `ConfirmDialog`
  (new, `components/patterns/ConfirmDialog.tsx`) then step-up +
  `DELETE /connections/{id}`.
- **Add a connection** (`AddConnectionDialog.tsx`): tabs rendered from
  `GET /connectors` (today: Manual account, File import — CSV/OFX isn't
  registered as a separate provider, the CSV connector's own manifest is
  what's there), so a new adapter reaches this dialog by being registered in
  `apps/api`, no UI change.
  - **Manual** (`ManualAccountForm.tsx`): name/type/currency/mask →
    step-up-gated `POST /connections` with `@connector/manual`'s real
    `connect()` schema.
  - **CSV** (`CsvImportForm.tsx`): file read as text client-side (no
    multipart — the contract's `ImportFileInput.content` is a string).
    Preset selector for all five built-in mappings
    (`iso_signed`/`us_signed`/`us_debit_credit`/`uk_dmy`/
    `european_semicolon`); a hand-built column-mapping profile isn't exposed
    (see §5). Not step-up gated (`POST /imports/csv` is session+CSRF only
    per wp1.5-api.md's route table).
  - **Reconnect** (`ReconnectDialog.tsx`): branches on
    `capabilities.reconnectFlow` — `reupload` re-renders `CsvImportForm`
    with `connectionId` set; `provider_hosted`/`credential_form` render the
    Plaid/generic paths described in §4.
- Sync status is the same SSE-backed `useSyncStatus()` pill the top bar and
  sidebar already use (deliverable 4), shown once at the top of the screen —
  not a second, per-connection `/connections/{id}/events` subscription per
  card, to avoid opening one SSE socket per row.

---

## 2. What the tsconfig fight was, and why it ended where it did

`pnpm --filter web typecheck` (`tsc -b --noEmit`, unchanged — `apps/web/package.json`
is off-limits) was **already red** on `e8021e5` before this pass touched
anything: `src/api/generated` grew a `client/`+`core/` split once the
contract gained SSE routes (`packages/contracts/openapi/openapi.json`,
WP 1.5), and `tsconfig.app.json`'s `exclude: ["src/api/generated"]` stopped
being enough — a `composite` project's `tsc -b` raises **TS6307**
("Projects must list all files") the instant an _included_ file (`main.tsx`,
`lib/sse.ts`, every feature hook) imports an _excluded_ one, which this now
is on every import of the generated client.

Confirmed, methodically, before picking a fix:

- **TS6307 is triggered by `composite: true` alone**, independent of
  `tsc -b` vs. plain `tsc -p` (verified both ways).
- A second, relaxed-settings project referenced from `tsconfig.app.json`
  (`tsconfig.generated.json`, `emitDeclarationOnly: true`, `strict: false`)
  fixes TS6307 **only** when invoked without `--noEmit` on the command line.
  The real script is `tsc -b --noEmit`, and `--noEmit` on the CLI forces
  emit off for **every** project in the graph — a referenced project that
  can't emit its declarations raises **TS6310** ("may not disable emit").
  This combination is unsatisfiable: `apps/web/package.json`'s script can't
  change, and a referenced project can't both emit (to satisfy TS6307) and
  not emit (forced by `--noEmit`, to satisfy TS6310).

The fix that actually satisfies both constraints: **`src/api/generated` is a
normal, `include`d part of `tsconfig.app.json`** (the `exclude` entry is
gone), and `exactOptionalPropertyTypes` is off for the whole `apps/web`
project — every remaining error, in every file, after removing the exclude
was `TS2379`/`TS2375` with `exactOptionalPropertyTypes: true` named in the
message, entirely inside `src/api/generated/client/**` and `core/**`
(`@hey-api/client-fetch`'s own template, not code this repo controls).
`tsconfig.base.json` (every backend package) is untouched — this is an
apps/web-only relaxation, documented at length in `tsconfig.app.json` itself.
Two smaller, real bugs this surfaced and fixed along the way:

- `src/api/client-runtime-config.ts`'s `createClientConfig` took
  `Record<string, unknown> | undefined` — the actual argument
  (`Config<ClientOptions>`, a plain interface with no index signature) isn't
  assignable to that regardless of strictness (`TS2345`, "Index signature
  ... is missing"). Made generic (`<T extends object>`) instead.
- `features/transactions/useTransactionsList.ts`'s `initialPageParam` was
  typed `string | undefined`; the generated page-param type is `string |
Pick<...>` (no `undefined`) once the contract grew past a handful of
  endpoints. Fixed by deriving the type from
  `ReturnType<typeof listTransactionsInfiniteOptions>` instead of hand-typing
  it, so it can't drift again silently.

`pnpm --filter web gen:check` (`node scripts/check-openapi-drift.ts`) is a
**separate, pre-existing bug**, not part of any gate this work package's
DO list names (`just verify`/`just check` never call it — confirmed by
grep) and left unfixed: it regenerates into an OS temp directory and diffs
against the committed output, but `client.gen.ts`'s
`runtimeConfigPath`-derived import is a path _relative to the output
directory_, so a temp directory anywhere other than `apps/web/src/api/generated`
itself produces a different (still correct, just differently-relative)
import path — the check will report drift on `client.gen.ts` on every run,
regardless of whether anything actually drifted. Reproduced directly with
the same `mkdtemp` the script itself uses; not something a `pnpm gen` fixes.

---

## 3. Accessibility findings (from actually running axe, not from believing the design system)

The e2e walkthrough (§6) runs axe-core against every screen it visits and
found three real, pre-existing issues, all fixed:

1. **`AuthCard.tsx`** (shared by login/lock/unlock/register) had no `<main>`
   landmark anywhere — `landmark-one-main`. Fixed: the card is now a
   `<main>`.
2. **`--accent: #2a78d6`** (light theme) against white
   (`--accent-contrast`) is **4.41:1** — under WCAG AA's 4.5:1 for normal
   text — on every primary button, found via the login screen's "Sign in
   with a passkey" button. Darkened to `#2563eb` (**5.17:1**), same hue,
   dark theme's pairing left untouched (already 5.4:1).
3. **`--status-good: #0ca30c`** against light mode's `--bg-subtle`
   (`#f1f1ee`) is **2.96:1**, found via the "Connected" badge on the
   connections screen. The same value against _dark_ mode's `--bg-subtle`
   (`#202326`) is **4.71:1** — passing — so a single fixed value can't serve
   both, and `--status-good` is now the one status colour with a light/dark
   split (`#0c7a0c` light / `#0ca30c` dark, both re-verified by the formula
   in `theme.css`'s own comment). `--status-warning`/`--status-serious` were
   **not** exercised by this walkthrough and were not audited — see §7.

All three fixes are in `apps/web/src/{features/auth/AuthCard.tsx,styles/theme.css}`;
`tokens.md` documents both colour changes with the exact contrast math.

A fourth thing fixed to make axe _usable_ rather than a finding about the
app: `App.tsx` wraps the router's own tree in `<div id="app-content">`,
because the dev-only TanStack Query/Router devtool panels
(`import.meta.env.DEV`-gated) render as real children of `#root`, not a
portal to `document.body` — scoping axe to `#root` still caught their own
(real, upstream, not-this-repo's-problem) violations. `e2e/support/axe.ts`
runs `axe.run('#app-content')`.

---

## 4. Plaid: what's real, what's scaffolded, and the one missing endpoint

Plaid is **not registered** in the connector registry today —
`apps/api/src/domain.ts` line 96 is still the commented-out
`// registry.register({ connector: new PlaidConnector(...) ... })` from
WP 1.5. `GET /connectors` therefore returns only Manual and File import;
nothing in this pass could exercise a live Plaid flow, registered or not.

**No new dependency was needed or added.** `react-plaid-link` is not
installed and this pass didn't add it — Plaid documents a dependency-free
integration path (their own CDN-hosted `link-initialize.js`,
`https://cdn.plaid.com/link/v2/stable/link-initialize.js`, a `<script>` tag
plus `window.Plaid.create(...)`), and `src/lib/plaid-link.ts` implements
exactly that: `loadPlaidLinkScript`/`openPlaidLink`, idempotent, typed. If a
bundled dependency is ever preferred instead: `react-plaid-link` MIT,
current major `4.x` (pin the exact patch per this repo's `save-exact`
convention at install time).

**What's real:** `PlaidConnectCard.tsx` renders from any `GET /connectors`
manifest whose `linkKind === 'provider_hosted'` — generic, not
Plaid-specific by name — and on click, loads the script and opens Link with
whatever token `getLinkToken()` returns. `ReconnectDialog.tsx`'s
`provider_hosted` branch is the same shape for the update-mode reconnect
token. Both wrap the resulting `POST /connections`
`/POST /connections/{id}/reconnect` call in `useStepUpRetry`, matching the
route table's step-up requirement.

**The one missing piece:** `getLinkToken()`/`getUpdateLinkToken()` both
throw `PlaidLinkTokenUnavailableError` unconditionally, because **no route
in the OpenAPI contract returns a Plaid link token.**
`packages/connectors/plaid/src/connector.ts`'s `createLinkToken`/
`createUpdateLinkToken` exist and are tested (WP 1.3), but nothing in
`apps/api/src/routes/connections.ts` calls them — `POST /connections`'s
`input` for Plaid, per `PlaidConnector#connect`'s own schema, is
`{ publicToken, institutionName? }`, i.e. the _second_ half of a
provider-hosted link; there is no first-half route to get the token Link
itself needs to open. This is a backend gap (`apps/api`), not a dependency
gap, and not something this pass's rules allow fixing (`apps/api` is
off-limits). **What's needed:** a route — e.g.
`POST /connections/plaid/link-token` returning `{ linkToken: string }` (and
an update-mode variant, or a query param) — added to
`packages/contracts/openapi/openapi.json` and `apps/api`, after which
`pnpm --filter web gen` produces the typed client call and the only edit
`apps/web` needs is replacing `getLinkToken`'s body with that call; nothing
else in `PlaidConnectCard.tsx`/`ReconnectDialog.tsx`/`plaid-link.ts` changes.

---

## 5. Tests

### Unit / component (Vitest, happy-dom)

| File                                                                            | Tests | What it pins                                                                                                                                                    |
| ------------------------------------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `features/accounts/account-groups.test.ts` (new)                                | 8     | Grouping order/omission/closed-split; `groupNetWorth`'s per-currency summing, sign-as-contribution, no-balance-skipped-not-zero                                 |
| `features/accounts/AccountsScreen.test.tsx` (new)                               | 3     | Grouped render with balances, empty state + CTA, error state + Retry                                                                                            |
| `features/connections/connection-health.test.ts` (new)                          | 11    | Health label/tone per status incl. error-kind fallback, last-synced formatting, `canSyncNow`, `shouldOfferReconnect`'s two guard conditions                     |
| `features/connections/ConnectionsScreen.test.tsx` (new)                         | 3     | List render with health/last-sync, empty state, full add-manual-account flow incl. the step-up 403→ceremony→retry round trip (mocked `@simplewebauthn/browser`) |
| `features/transactions/TransactionsScreen.test.tsx` (new)                       | 4     | List render/formatting, pending+transfer badges, empty state, detail-sheet note edit through the real overlay PATCH                                             |
| `features/transactions/filters.test.ts` (existing, unchanged)                   | 11    | URL schema, `hasActiveFilters`, `toTransactionsQuery`                                                                                                           |
| 8 further pre-existing files (Money, TopBar, router, auth, theme, CSP-adjacent) | 41    | Unchanged by this pass                                                                                                                                          |

**Root total: 14 files, 81 tests, all passing** (`pnpm --filter web test` /
`pnpm exec vitest run` from `apps/web`). 29 of the 81 are new this pass.

New test-support: `src/test-support/api-test-utils.ts` (`ensureApiClient`,
`jsonResponse`, `stubFetchRoutes` — a method+pathname fetch router, the same
idea as `src/app/router.test.tsx`'s pre-existing `stubFetch`, generalised
because several new screens PATCH/POST/DELETE the same resource family a
pathname-only map can't disambiguate, and because the generated client calls
`fetch(new Request(url, init))` for a mutating request — the method and body
live on the `Request`, not the second `fetch` argument, which the naive
version got wrong on the first pass and which cost real debugging time
before the fix — worth calling out precisely because a second implementation
of the same test helper is exactly where that mistake would recur).

### Playwright e2e

Three specs now, two run against the plain Vite dev server (port 5183, no
API — the existing `smoke.spec.ts` pattern), one against the CSP-hardened
static build (port 5184, unchanged):

- `smoke.spec.ts` (existing, 3 tests) — unchanged.
- `csp.spec.ts` (existing, 3 tests) — unchanged.
- **`app-walkthrough.spec.ts` (new, 1 test)**: login (TOTP fallback, not
  passkey — see below) → transactions (open a row, edit its category through
  the real `CategoryPicker`, assert the real `PATCH` body) → accounts →
  connections (empty state → Add connection → Manual form → step-up ceremony
  → the new connection appears) — **axe-clean on every screen it visits**
  (login, transactions, accounts, connections-empty, connections-with-a-
  connection: 5 axe passes in one test).

**7/7 Playwright tests pass** (`pnpm exec playwright test` from `apps/web`).

**Network is mocked** (`e2e/support/mock-api.ts`, `page.route('**/*', ...)`),
not backed by a live `apps/api` + Postgres. This is a deliberate scope
choice, not an oversight — see §7. The one real WebAuthn ceremony the
walkthrough exercises (the step-up assertion before `POST /connections`)
runs through the actual `@simplewebauthn/browser` → `navigator.credentials.get`
call path in a real Chromium, via `e2e/support/fake-webauthn.ts`'s
`navigator.credentials.get` override — built from reading
`@simplewebauthn/browser`'s own `startAuthentication` source
(`esm/methods/startAuthentication.js`) for the exact assertion shape it
expects, rather than a CDP `WebAuthn.addVirtualAuthenticator` +
`WebAuthn.addCredential` setup (which needs a real keypair and a live server
to mean anything more than this does — see §7's honest accounting of what a
CDP-and-live-backend version would still need). Axe is injected via
`page.addScriptTag` against the already-a-devDependency `axe-core` package's
own bundle (`axe-core/axe.min.js`) — no `@axe-core/playwright` dependency
added.

---

## 6. Commands run

```
pnpm --filter web typecheck   # tsc -b --noEmit — clean
pnpm --filter web test        # vitest — 14 files, 81 tests, all passing
pnpm --filter web build       # tsc + vite build + CSP/SW checks — clean
pnpm exec playwright test     # (from apps/web) — 7/7 passing
pnpm exec prettier --write apps/web   # (from repo root) — clean after formatting
pnpm exec eslint apps/web              # (from repo root) — 0 errors, 1 warning (informational, see below)
```

The one ESLint warning left: `react-hooks/incompatible-library` on
`TransactionsList.tsx`'s `useVirtualizer()` call — the React Compiler
plugin flags `@tanstack/react-virtual`'s API as returning functions it can't
safely memoize. It's a warning, not an error (`eslint apps/web` exits 0),
and is exactly the caveat this rule exists to surface for a third-party
library the compiler doesn't control — not something to work around, and
tanstack-virtual is the DO list's own choice of virtualizer.

Five `react-hooks/set-state-in-effect` / `react-hooks/purity` errors were
real findings, all fixed with a scoped `eslint-disable-next-line` and a
comment explaining why the pattern is the correct one (reacting to an SSE
frame, resetting a draft when a different transaction loads, a wall-clock
relative "stale" check) rather than blanket-disabling the rule: two in
already-on-disk `lib/sse.ts`/`features/sync/useSyncStatus.ts`, three in this
pass's own `TransactionDetailSheet.tsx`/`TransactionsFilterBar.tsx`. Two
`jsx-a11y` errors (a click handler needing a keyboard listener on
`TransactionRow.tsx`, a `role="grid"` needing a `tabIndex`) were fixed for
real (an `onKeyDown` handler, `tabIndex={-1}` on the roving-tabindex
container) — not disabled.

### `just verify`

Run from the repo root. Every stage that touches `apps/web` (or that could
plausibly be affected by it) is green:

```
pnpm run typecheck        # tsc -p tsconfig.json — clean, root + apps/web
pnpm run lint              # prettier --check ., eslint . (0 errors, the one
                            # informational react-hooks/incompatible-library
                            # warning from §6), schema-ownership — all clean
pnpm run test               # vitest run (root) + pnpm --filter @app/web test
                            # root: 87 files, 1412 passed / 1 skipped
                            # apps/web: 14 files, 81 passed
pnpm --filter @app/web build   # clean (tsc + vite build + CSP/SW checks)
just playwright-check           # apps/web Playwright — 7/7 passed
```

**`just verify` itself stopped after that**, at the next stage —
`gitleaks detect --source . ...` (full git history, CI's pinned digest) —
which reported `leaks found: 1`. This is **not** in `apps/web` and not
something this pass touched: the collision rules for this dispatch
explicitly forbid editing anything under `secrets/` or outside `apps/web`,
and the finding is in git _history_ (75 commits scanned), which nothing in
this pass's diff can retroactively change. `docs/plan/personalfi-resume-point.md`'s
own carried-forward note — "Plaid Sandbox credentials exist only as
gitignored file secrets ... rotate the sandbox secret after Sandbox work
since it was pasted into a chat" — is a plausible match for exactly this
finding. Flagging for the orchestrator rather than investigating further:
gitleaks' `--redact` flag means the tool's own stdout doesn't say which
commit or file, and finding that out means either dropping `--redact` (this
pass didn't have gitleaks credentials/scope to do that safely) or reading
`docker run ... --report-path` output this invocation didn't request.
`just verify`'s later stages (license gate, `.trivyignore` sweep, `trivy
fs`, compose-hardening) never ran as a result — none of them are `apps/web`
concerns.

---

## 7. Left open

- **Category filter/edit is limited by a real, documented API gap, not by
  this pass.** `GET /categories` does not exist (`CategoryPicker.tsx`'s own
  header comment, from before this pass, already says so). The filter bar's
  "Uncategorized only" checkbox and the detail sheet's category picker are
  the full extent of what's possible against the current contract; a real
  combobox needs that endpoint.
- **Split editor, rule-from-transaction, review inbox**: not built. The
  DO list's explicit deliverable 1 is note/category edit + pending/transfer
  display, which is what's here; the master plan's fuller Phase 1 line
  ("split editor, rule-from-transaction, review inbox") is broader than this
  pass's DO list and wasn't attempted.
- **Transfer _pairing_ creation** (`POST /transfers/pair`, choosing two
  transactions and linking them) isn't built — only _un_-pairing
  (`POST /transfers/{id}/reject`) from the detail sheet, which is what
  "transfer pairs shown as such" needed.
- **Manual account balance/transaction entry has no route.** Adding a manual
  account (`ManualAccountForm.tsx`) creates the account; there is no
  endpoint to set a starting balance or enter a manual transaction, so a
  manual account reads "No balance yet" until the API grows one.
- **Plaid's link-token route** — the one missing backend piece, detailed in
  §4.
- **A live-backend, CDP-virtual-authenticator e2e walkthrough** was
  deliberately not attempted this pass. What it would need beyond what's
  here: a dev proxy from `vite dev` to a running `apps/api`
  (`vite.config.ts` has none today — confirmed by inspection, not assumed),
  `just db-up` + migrations + demo seed data, the Plaid-registration gap
  above resolved or worked around, and — given "backend agents are
  concurrently editing `apps/api`" per this dispatch's own rules — accepting
  that such a suite's flakiness would often be someone else's
  in-flight change, not this UI's bug. The mocked suite in §5 proves the
  frontend's own request/response wiring and accessibility; a live-backend
  walkthrough is squarely a phase-gate concern (WP 1.7 per
  `01-execution-log.md`'s RESUME POINT), not a single work package's e2e
  harness.
- **`--status-warning`/`--status-serious` contrast**: flagged as plausibly
  broken by the same math that found `--status-good`'s failure, not
  confirmed by an actual axe run (this walkthrough never rendered a warning
  or serious badge) — see `tokens.md`. Left for a broader contrast pass
  (the master plan's Phase 9 "WCAG 2.2 AA pass" explicitly owns this).
- **`scripts/check-openapi-drift.ts`** always reports drift on
  `client.gen.ts` regardless of whether anything drifted — §2. Not part of
  any gate this pass's DO list names; flagged for whoever owns that script.
- **No screenshots captured.** Playwright's default config here has no
  screenshot-on-run step; none were added, since the DO list makes them
  optional ("if you capture any").

---

## 8. Files touched

New: `src/features/accounts/{AccountCard,AccountDetailScreen,AccountGroupSection,AccountsScreen,AccountsScreen.test,account-groups.test,account-icons,useAccounts,useAccountsLookup}.{ts,tsx}`;
`src/features/connections/**` (new directory — `AddConnectionDialog`,
`ConnectionCard`, `ConnectionsScreen(.test)`, `CsvImportForm`,
`ManualAccountForm`, `PlaidConnectCard`, `ReconnectDialog`, `SyncRunHistory`,
`connection-health(.test)`, `connector-icons`, `useConnections`);
`src/features/transactions/{BulkActionBar,TransactionDetailSheet,TransactionsFilterBar,TransactionsList,TransactionsScreen(.test),useBulkUpdateMutation,useExportTransactions}.{ts,tsx}`;
`src/components/patterns/ConfirmDialog.tsx`; `src/lib/plaid-link.ts`;
`src/routes/_app.accounts.{index,$accountId,connections}.tsx`;
`src/test-support/api-test-utils.ts`; `e2e/app-walkthrough.spec.ts`,
`e2e/support/{axe,fake-webauthn,mock-api}.ts`.

Modified: `src/routes/_app.accounts.tsx` (layout conversion),
`src/routes/_app.transactions.tsx` (wired to `TransactionsScreen`),
`src/app/App.tsx` (`#app-content` wrapper), `src/app/shell/AppShell.tsx`
(`titleForPath` for the two new sub-routes), `src/features/auth/AuthCard.tsx`
(`<main>` landmark), `src/features/accounts/account-groups.ts`
(`groupNetWorth` added), `src/features/transactions/{TransactionRow,useTransactionOverlay,useTransactionsList}.tsx`
(a11y fix, re-export used by the new bulk-update hook, page-param type fix),
`src/features/sync/useSyncStatus.ts` / `src/lib/sse.ts` (lint fixes only, no
behaviour change), `src/api/client-runtime-config.ts` (generic
`createClientConfig`), `src/styles/{theme.css,tokens.md}` (two contrast
fixes), `tsconfig.app.json` (§2), `playwright.config.ts` (new project
match), `src/routeTree.gen.ts` (generated, regenerated by `vite build`).

No changes outside `apps/web/**` and this file. No `pnpm install`, no
`package.json`/lockfile edits, no commits.
