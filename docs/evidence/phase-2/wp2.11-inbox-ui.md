<!-- SPDX-License-Identifier: MIT -->

# WP 2.11 — UI: review inbox and transaction affordances

Scope: `apps/web/**` — category combobox, split editor, rule-from-transaction,
review inbox, transfer-pair creation, manual balance/transaction entry,
notification settings, their tests, and this evidence file.

Repo `/home/chris/Projects/PersonalFi`, branch `main`, built on snapshot
`2b2bc38` (WP 2.5 rules/categories/manual-entry API, WP 2.6 insights platform,
WP 2.8 reports/export all landed; WP 2.4 notifications and WP 2.9/2.10 UI were
concurrent in-flight work this session did not depend on).

---

## 1. Screens and what they consume

| Screen / control              | File                                                                                                             | Routes consumed                                                                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Category combobox             | `src/features/transactions/CategoryPicker.tsx`, `src/components/ui/combobox.tsx`                                 | `GET /categories`, `POST /categories` (via `CreateCategoryDialog.tsx`)                                                                             |
| Category filter control       | `src/features/transactions/CategoryFilterControl.tsx`, `src/components/ui/popover.tsx`                           | `GET /categories` (read); writes `categoryIds` into `GET /transactions`'s query via the filter bar                                                 |
| Split editor                  | `src/features/transactions/SplitEditor.tsx`, `split-math.ts`                                                     | `POST`/`DELETE /transactions/{id}/splits`                                                                                                          |
| Rule-from-transaction         | `src/features/rules/RuleFromTransactionDialog.tsx`                                                               | `POST /transactions/{id}/rule`, `POST /rules/preview`, `POST /rules/{id}/apply`                                                                    |
| Rules list (Settings → Rules) | `src/features/rules/RulesListScreen.tsx`, `src/routes/_app.settings.tsx`                                         | `GET /rules`, `PATCH /rules/{id}`, `DELETE /rules/{id}`                                                                                            |
| Transfer-pair creation        | `src/features/transactions/TransferPairDialog.tsx`, `transfer-candidates.ts`                                     | `GET /transactions` (candidate window), `POST /transfers/pair`                                                                                     |
| Review inbox                  | `src/routes/_app.inbox.tsx`, `src/features/inbox/InboxScreen.tsx`, `inbox-reducer.ts`, `transfer-suggestions.ts` | `GET /transactions` (`uncategorized=true`, `transfers=exclude`), `PATCH /transactions/{id}`, `POST /transfers/pair`, `POST /transfers/{id}/reject` |
| Manual balance entry          | `src/features/accounts/RecordBalanceDialog.tsx`                                                                  | `POST /accounts/{id}/balance` (step-up)                                                                                                            |
| Manual transaction entry      | `src/features/accounts/AddManualTransactionDialog.tsx`                                                           | `POST /accounts/{id}/transactions` (step-up)                                                                                                       |
| Notification settings         | `src/features/notifications/NotificationSettingsScreen.tsx`, `api-pending.ts`                                    | pending — see §4                                                                                                                                   |

`GET /categories`, the split/rule/transfer/manual-entry routes and `GET
/rules` all existed before this WP (WP 2.5); nothing here required an
`apps/api` change, and none was made.

### 1.1 Category combobox

`CategoryPicker.tsx` was a native `<select>` with grouped `<optgroup>`s
(wp1.4/closeout-architecture era). It is now a Base UI combobox
(`@base-ui-components/react`, already a dependency — no new package added):
`role="combobox"` input, `role="listbox"` popup, `role="option"` items,
`role="group"` per heading (`aria-labelledby` pointing at the group's own
label div). Two synthetic rows keep the external contract identical to the
old `<select>`'s: `CLEAR_ITEM` (id `''`) stands in for "no category" so it can
never collide with a real category that happens to be labelled the same, and
an orphan row ("Current category") appears when `value` names a category not
in the list (archived, or not yet loaded) — the same "never silently drop an
assignment" rule the old `<select>` enforced.

The "create new category" escape hatch is a footer button inside the popup
(`+ Create "<query>"`), opening `CreateCategoryDialog.tsx`: a name field, an
"under" `<select>` listing only top-level headings (never a leaf — the
two-level `CHECK`, migration 0006, is reflected in the UI rather than
discovered from a 400), and a `kind` field that only appears when creating a
new top-level heading (a leaf always inherits its parent's kind, matching
`POST /categories`'s own contract). Calls `useCreateCategoryMutation`
(`features/categories/useCategories.ts`), invalidates the categories query,
and selects the new row.

**A real, only-visible-in-a-browser bug found and fixed while building this**:
the combobox's default width (`w-full`) made a row-based caller
(`BulkActionBar.tsx`, the inbox's own uncategorized row) squeeze its siblings
to zero width — jsdom/happy-dom never compute flex layout, so every component
test passed while the real Playwright walkthrough failed with an invisible
"Farmers Market" row. Fixed by defaulting to `w-56` and having the two
vertical-layout callers (`TransactionDetailSheet.tsx`,
`RuleFromTransactionDialog.tsx`) opt into `className="w-full"` explicitly.
Documented at length in `combobox.tsx`'s own comment so it isn't rediscovered.

### 1.2 Category filter control

`GET /transactions` has accepted `categoryIds` (plural) since before this WP
— closeout-architecture.md §4's "no category filter" bullet was already
corrected as stale by WP 2.5. What was missing was the UI control.
`CategoryFilterControl.tsx` is a grouped checklist behind a popover
(`components/ui/popover.tsx`, also newly vendored from the same
already-a-dependency Base UI package) rather than a multi-select combobox: a
checklist states "narrow to several categories at once" more plainly than
chips restating the same checkboxes, and it reuses the same accessible
primitive shape (`Popover` + native checkboxes) the rest of the filter bar
already trusts. Wired into `filters.ts` (`categoryIds` added to
`transactionsSearchSchema`) and `TransactionsFilterBar.tsx`, so it round-trips
through the URL like every other filter — `e2e/category-filter.spec.ts`
proves the reload case.

### 1.3 Split editor

`SplitEditor.tsx`, opened from a "Split" button on the detail sheet (renamed
to show "N splits" once a transaction has any). All arithmetic lives in
`split-math.ts` — pure functions over `@core/kernel`'s `Money`, unit tested
apart from the dialog: `sumSplits`, `remainder`, `isBalanced`, `splitEvenly`
(`Money.allocateEvenly`'s largest-remainder division), `parseSplitMagnitude`/
`applyDirection` (a typed magnitude gets the parent transaction's sign
re-applied, so a line can never point the opposite direction from its
siblings). The live remainder is shown as "$X unallocated" (warning colour)
or "Balanced" (neutral), and Save is disabled until it is exactly zero — the
must-balance invariant lives, not checked only on submit. "Split evenly"
recomputes every line via the kernel's largest-remainder allocator; "Assign
remainder" adds whatever is left to one line. "Remove splits" (only shown
when the transaction already has any) calls the `DELETE` route.

### 1.4 Rule-from-transaction

`RuleFromTransactionDialog.tsx` implements 05 §5.4's two-step shape against
the real contract: `POST /transactions/{id}/rule` only ever affects _future_
syncs (`runOnSync`), so a preview of what it would change _retroactively_ is
a genuinely separate call — `POST /rules/preview` on the rule that was just
created, with `retroactive: true`. Only a further, explicit
"Apply to N transactions" click calls `POST /rules/{id}/apply` with the same
flag. `docs/plan/02-phase-2-dispatch.md`'s own exit test
(`'the preview count matches the count after apply'`) is asserted both as an
e2e test and inline in the extended `app-walkthrough.spec.ts`, by comparing
the number in the UI's own button label (built from the preview response) to
the apply response's `changedCount`.

### 1.5 Rules list

`RulesListScreen.tsx`, under `Settings → Rules` (`_app.settings.tsx`, now two
tabs — Rules and Notifications — replacing the placeholder). Enable/disable
(`PATCH /rules/{id}`) and delete (`DELETE /rules/{id}`) only, per the
dispatch's literal scope ("rules list screen ... with enable/disable/delete");
a full rule builder (05 §5.4's drag-to-reorder priority editor) is out of
scope and left for a later pass — every rule shown here was created via
`RuleFromTransactionDialog`.

### 1.6 Review inbox

`_app.inbox.tsx` → `InboxScreen.tsx`, added to the nav (`Inbox`, under
"Money", both the sidebar and the mobile "More" sheet — `nav-items.ts`).
Combines two real queues:

- **Uncategorized transactions** — `GET /transactions?uncategorized=true`.
- **Pending transfer-pair suggestions** — computed client-side
  (`transfer-suggestions.ts#findTransferSuggestions`, built on
  `transfer-candidates.ts#findTransferCandidates`) over
  `GET /transactions?transfers=exclude`: same absolute amount, opposite sign,
  a different account, within a ±5-day window, greedily paired so no row is
  offered twice. There is no candidate-suggestion route — 05 §5's own
  description of transfer pairing is exactly this client-side filter, which
  is also what `TransferPairDialog.tsx` (the detail-sheet affordance) reuses.
  A transaction claimed by a suggestion is excluded from the plain
  "uncategorized" list (a transfer is not spend, and offering the same two
  rows as two different kinds of problem at once was a real bug this session
  found and fixed before it reached e2e).

State is a small reducer (`inbox-reducer.ts`, unit tested with 10 cases):
`set-items` (load, preserving focus if the focused item survives),
`resolve` (drop an item, move focus to whatever slides into its place),
`focus`/`focus-delta` (roving tabindex). Resolving an item — picking a real
category, or Accept/Reject on a transfer suggestion — removes it from local
state immediately on the mutation's `onSuccess`, independent of any query
cache invalidation, so the row disappears the instant the write succeeds.

**Third queue — low-confidence categorizations — is empty, and that is a
real API gap, not a bug in this screen.** See §5.

**Keyboard-first**, per the dispatch's exact exit test:
`e2e/inbox.spec.ts` → `'twenty items clear with keyboard only'` seeds 20
uncategorized rows and clears every one of them using only `Tab` (onto the
row's own category combobox), `ArrowDown` ×2 (open the popup, move off the
"Uncategorized" non-answer onto a real category), `Enter` (commit) — the same
four keys repeat because resolving a row moves focus to its neighbour.

### 1.7 Transfer-pair creation from the detail sheet

`TransferPairDialog.tsx`: "Pair as transfer" appears on the detail sheet
whenever the transaction is not already a transfer. Same candidate-finding
function as the inbox (`findTransferCandidates`), queried narrowly
server-side (`amountMin`/`amountMax` as the _minor-unit integer string_ of
the counterpart's magnitude, `from`/`to` as a ±5-day window) and rendered as a
clickable list; picking one calls `POST /transfers/pair`, oriented correctly
regardless of which leg is which (`orientPair`, unit tested).

### 1.8 Manual balance / manual transaction entry

`AccountDetailScreen.tsx` gained two buttons, shown only for
`provider === 'manual'` accounts: "Record balance"
(`RecordBalanceDialog.tsx` → `POST /accounts/{id}/balance`) and "Add
transaction" (`AddManualTransactionDialog.tsx` → `POST
/accounts/{id}/transactions`, a single signed amount — negative is money out,
matching the app's own convention everywhere else, rather than a "type"
toggle the amount field would have to agree with). Both wrap their mutation
in the existing `useStepUpRetry`, matching the route table's step-up policy
(wp2.5-rules-api.md §2). Amounts travel as `Money.toJSON(...)` end to end; no
`number` reaches either request body.

---

## 2. Notification settings — the pending stub

**The REST surface does not exist.** Confirmed by inspection before writing
anything: `apps/api/src/routes/notifications.ts` does not exist on this
branch, and WP 2.6's own evidence
(`docs/evidence/phase-2/wp2.6-insights.md` §"apps/api/src/routes/insights.ts")
and WP 2.4's (`wp2.4-notifications.md`) both confirm neither insights nor
notifications has grown a route file yet — WP 2.4's scope is the context and
its migration, not a REST surface, and this task's own dispatch text says so
directly ("notifications context is being wired now; its REST surface comes
with the next package").

`features/notifications/api-pending.ts` is the Phase 0 `pending-contracts.ts`
pattern applied to that gap: real `fetch` calls (reusing
`pending-contracts.ts`'s own `apiFetch` — CSRF header, credentials, the
empty-body-JSON fix), real Zod validation, real React Query hooks
(`useNotificationChannelsQuery`, `useCreateNotificationChannelMutation`,
`useSendTestNotificationMutation`, `useNotificationRulesQuery`, plus
update/delete for rules), against the paths the eventual REST surface will
most plausibly use (`/api/notifications/channels`,
`/api/notifications/channels/{id}/test`, `/api/notifications/rules`, mirroring
WP 2.4's own `notification_channels`/`notification_rules` tables). Every call
here 404s against a real deployment today — by design, exactly like the
`pending-contracts.ts` header explains for its own three TODO items — and the
component test `api-pending.test.tsx` pins that a 404 surfaces as a normal
`isError` query state, not a thrown exception the screen has to special-case.

`NotificationSettingsScreen.tsx` imports only the _hooks_ this file exports;
when WP 2.4's routes land, the swap is confined to `api-pending.ts`'s
internals (or its wholesale replacement by the generated client's
`…Options()`/`…Mutation()` factories) — the screen needs no change. The
screen itself renders an honest empty/error state
("Notifications aren't available yet") when the channels query fails, rather
than pretending the feature works.

The e2e exit test (`e2e/notification-settings.spec.ts` →
`'a test send reports a real delivery result'`) proves the request/response
cycle is real even though the network is mocked (as every spec in this suite
mocks it, per `mock-api.ts`'s own header): the button click triggers an
actual `POST`, and the UI renders exactly the JSON body that response
carried, not a canned toast the network round trip never touched.

---

## 3. Tests

### 3.1 Unit / component (Vitest, happy-dom)

New files this WP (14), by what they pin:

| File                                                         | Tests | What it proves                                                                                                                                        |
| ------------------------------------------------------------ | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `features/transactions/split-math.test.ts`                   | 8     | Sum/remainder/balance invariant, largest-remainder split-evenly (incl. a negative-total sign-preservation case and a small sweep over counts/amounts) |
| `features/transactions/transfer-candidates.test.ts`          | 7     | Same-amount/opposite-sign/different-account/date-window matching; pair orientation                                                                    |
| `features/inbox/inbox-reducer.test.ts`                       | 10    | Load-focus, resolve-and-refocus-neighbour, focus-delta clamping, ignoring an unknown id                                                               |
| `features/inbox/transfer-suggestions.test.ts`                | 5     | Greedy pairing, no double-claiming, excludes already-transfer rows                                                                                    |
| `features/transactions/CategoryFilterControl.test.tsx`       | 5     | Summary text, checking emits the id, search narrows the list, clear                                                                                   |
| `features/transactions/SplitEditor.test.tsx`                 | 4     | Seeded even split, disabled Save while unbalanced, split-evenly rebalances, real POST body on save                                                    |
| `features/transactions/TransferPairDialog.test.tsx`          | 3     | Candidate shown, empty state, pair POST oriented correctly                                                                                            |
| `features/rules/RuleFromTransactionDialog.test.tsx`          | 2     | Preview creates the rule then previews it; apply sends the same `retroactive` flag and closes                                                         |
| `features/rules/RulesListScreen.test.tsx`                    | 4     | Empty state, list+describe, enable/disable PATCH, delete                                                                                              |
| `features/inbox/InboxScreen.test.tsx`                        | 3     | All-caught-up empty state, resolving an uncategorized row, accepting a transfer suggestion                                                            |
| `features/notifications/NotificationSettingsScreen.test.tsx` | 3     | Honest not-available state on 404, test-send renders the real result, add-channel POST body                                                           |
| `features/notifications/api-pending.test.tsx`                | 4     | Request shape pinning for the pending stub, incl. the 404-as-query-error case                                                                         |
| `features/accounts/RecordBalanceDialog.test.tsx`             | 1     | Balance recorded in bigint minor units through the step-up path                                                                                       |
| `features/accounts/AddManualTransactionDialog.test.tsx`      | 2     | Signed amount POSTed correctly; submit disabled without required fields                                                                               |

Modified: `CategoryPicker.test.tsx` (rewritten for the combobox's ARIA shape —
same guarantees as the old `<select>` suite: grouping, no heading-as-option,
correct id emitted, orphan value preserved, degrades on failure);
`TransactionsScreen.test.tsx` (the category-edit assertion now opens the
combobox and clicks an option instead of `selectOptions`); `filters.ts`/
`useCategories.ts`/`api-test-utils.ts` (new `categoryIds` field,
`useCreateCategoryMutation`, `buildTransaction`/`buildTransactionDetail`
fixture builders shared across the new suites).

**Root total: 29 files, 146 tests, all passing** (`pnpm --filter @app/web test`).

### 3.2 Playwright e2e

Five new spec files, each pinning one exit test **verbatim** from
`docs/plan/02-phase-2-dispatch.md` §3, plus `app-walkthrough.spec.ts` extended
with the category-combobox/split/rule-preview/inbox/transfer-pairing steps
the dispatch's item 8 named:

| File                                | Test                                                                                                                             | Result |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `e2e/inbox.spec.ts`                 | `'twenty items clear with keyboard only'`                                                                                        | pass   |
| `e2e/splits.spec.ts`                | `'a split that does not sum to the parent cannot be saved'`                                                                      | pass   |
| `e2e/rule-from-transaction.spec.ts` | `'the preview count matches the count after apply'`                                                                              | pass   |
| `e2e/category-filter.spec.ts`       | `'the category filter survives a reload via the URL'`                                                                            | pass   |
| `e2e/notification-settings.spec.ts` | `'a test send reports a real delivery result'`                                                                                   | pass   |
| `e2e/app-walkthrough.spec.ts`       | extended (login → category combobox → split → rule preview → accounts → connections → manual account → inbox → transfer pairing) | pass   |

`playwright.config.ts`'s `chromium` project's `testMatch` regex only matched
`smoke`/`app-walkthrough` before this WP — the five new spec files would
silently never have run under any project. Extended to include all five.

`e2e/support/mock-api.ts` gained an in-memory transaction/rule/transfer/
notification-channel store so mutations actually persist across a spec's own
steps (a category PATCH is visible on the next fetch, a paired transfer
marks both legs, a created rule can be previewed and applied) instead of one
fixed canned response per path. Two accounts (`Everyday Checking`,
`Savings`) and four transactions (`txn_1` Blue Bottle Coffee, `txn_2` Farmers
Market, `txn_out`/`txn_in` a same-amount opposite-sign pair) seed the default
scenario; `inbox.spec.ts` layers a 20-row fixture on top via its own
`page.route` (registered after `installApiMocks`'s catch-all, so it runs
first and `fallback()`s everything it doesn't own back to the shared mock).

**9/9 Playwright tests pass** on the `chromium` project
(`pnpm exec playwright test --project=chromium`): `smoke.spec.ts` (3, unchanged),
`app-walkthrough.spec.ts` (1, extended), `inbox.spec.ts`,
`rule-from-transaction.spec.ts`, `splits.spec.ts`, `category-filter.spec.ts`,
`notification-settings.spec.ts` (1 each). The `csp` project (3 tests) also
re-run clean — no new CSP directive was needed (§6).

**`csp-plaid` was not run** — it manages its own Caddy container via `docker`,
and this WP's own rules forbid `docker`. Untouched by this WP's changes
(nothing here touches Plaid, the proxy, or compose).

### 3.3 A real bug the browser suite found that the component suite could not

Documented in §1.1: the combobox's default `w-full` broke row-based layouts
in a way jsdom/happy-dom cannot observe (they never compute flex sizing).
Found by a genuinely invisible "Farmers Market" row in the real
`app-walkthrough.spec.ts` run — `getBoundingClientRect()` reported `width: 0`
on the text container while every component test for the same code passed.
A second, independent bug in the same investigation: the inbox's roving-focus
effect re-focused a row's `<li>` container on every `onFocus` bubble
(including from clicking a child control), which fought Base UI's combobox
popup for focus and silently closed it before an option could be selected —
fixed by only reclaiming focus when it has fallen out of the list entirely,
not when it is already on a legitimate descendant. Both fixes are in
`combobox.tsx` and `InboxScreen.tsx` respectively, with the reasoning kept in
the code as a comment rather than only here.

---

## 4. Axe results

Every screen this WP touches or adds is checked by `expectNoAxeViolations`
(scoped to `#app-content`, excluding the dev-only TanStack devtools panels) at
every step of `app-walkthrough.spec.ts` and again in each dedicated spec:
login, transactions, transaction detail sheet (before and after the split),
rule-from-transaction (before and after preview), accounts, connections
(empty and with a connection), inbox (twenty items, and cleared), the split
editor, the category-filtered transactions list (before and after reload),
and Settings' notifications tab (no channels, one channel, after a test
send). **Zero violations in every run** — see §3.2's pass results; axe is
part of the same Playwright run, not a separate report.

---

## 5. Left open, and the exact API need for each

- **Low-confidence categorizations (inbox's third queue) has no data
  source.** `GET /transactions` carries no categorisation-confidence field,
  and WP 2.6's `pending_review` table (`packages/contexts/insights/**`) has
  no REST route — confirmed absent by inspection, and by both WP 2.6's and
  WP 2.4's own evidence files (§2 above). **Exact need**: either a
  `categoryConfidence`/`categorySource` field on `GET /transactions`'s
  response, or a dedicated route reading `pending_review` (most likely
  `apps/api/src/routes/insights.ts`, already named in WP 2.6's own `Owns`
  list but not built). The inbox section renders its own honest
  "coming once the insights review queue has a route to read it from"
  message rather than fabricating data or hiding the section.
- **Notification settings' REST surface does not exist** — §2, `api-pending.ts`
  documents the exact paths it assumes and is built to swap cleanly once WP
  2.4 (or whichever package finishes wiring `apps/api/src/routes/notifications.ts`)
  lands. Quiet-hours and per-rule condition editing are stubbed data shapes
  only (`quietHoursStart`/`quietHoursEnd` on `NotificationRule`) with no
  editing UI yet — the screen only lets a rule be enabled/disabled, matching
  what could be verified against a real route today.
- **Rules list has no rule _builder_** (05 §5.4's fuller
  `/transactions/rules` screen with drag-to-reorder priority, condition
  editing, a per-rule match-count hint) — every rule in the list today was
  created via "Always categorize like this." The dispatch's literal scope for
  this WP was "enable/disable/delete," which is what's built.
- **Manual balance/transaction entry has no dedicated e2e coverage** — proven
  by component tests (`RecordBalanceDialog.test.tsx`,
  `AddManualTransactionDialog.test.tsx`) with a real step-up round trip, but
  the dispatch's exact e2e-extension list for this WP (item 8) named category
  combobox / split / rule preview / inbox / transfer pairing specifically,
  not manual entry — a deliberate scope cut given the size of this WP, not an
  oversight.
- **No new CSP directive was needed.** `csp.spec.ts`'s 3 tests re-run clean;
  nothing in this WP loads a new origin, opens a new `<script>`/`<style>`
  vector, or changes the service worker's precache shape beyond the new
  route chunks Vite already code-splits automatically.
- **`csp-plaid` not re-run** — forbidden by this WP's own rules (no `docker`);
  untouched by anything in this WP's diff.

---

## 6. Verification

```
$ pnpm --filter @app/web typecheck   # tsc -b --noEmit (via pnpm run gen first) — clean
$ pnpm --filter @app/web test        # vitest run — 29 files, 146 tests, all passing
$ pnpm --filter @app/web build       # tsc + vite build + CSP/SW checks — clean
$ pnpm exec playwright test --project=chromium   # (from apps/web) — 9/9 passing
$ pnpm exec playwright test --project=csp        # (from apps/web) — 3/3 passing
$ pnpm prettier --write apps/web     # clean after formatting (31 files reformatted, no semantic change)
$ pnpm eslint apps/web               # 0 errors, 1 warning (pre-existing, documented in wp1.6-ui.md §6:
                                      # react-hooks/incompatible-library on TransactionsList.tsx's
                                      # useVirtualizer — untouched by this WP)
```

`just check` result: see the orchestrator-facing final report for this
session — run in the foreground per this WP's own instructions, after the
above.

---

## 7. Files touched

New: `src/components/ui/{combobox,popover}.tsx`;
`src/features/categories/CreateCategoryDialog.tsx`;
`src/features/transactions/{CategoryFilterControl,SplitEditor,TransferPairDialog,split-math,transfer-candidates}.{ts,tsx}`
plus their `.test.{ts,tsx}` files;
`src/features/rules/**` (new directory — `useRules.ts`,
`RuleFromTransactionDialog.tsx`, `RulesListScreen.tsx`, tests);
`src/features/inbox/**` (new directory — `InboxScreen.tsx`, `inbox-reducer.ts`,
`transfer-suggestions.ts`, tests); `src/features/notifications/**` (new
directory — `api-pending.ts`, `NotificationSettingsScreen.tsx`, tests);
`src/features/accounts/{RecordBalanceDialog,AddManualTransactionDialog}.{tsx,test.tsx}`;
`src/routes/_app.inbox.tsx`; `e2e/{inbox,splits,rule-from-transaction,
category-filter,notification-settings}.spec.ts`.

Modified: `src/features/transactions/CategoryPicker.tsx` (native `<select>` →
combobox) and its test; `src/features/transactions/{TransactionDetailSheet,
TransactionsFilterBar,filters}.{ts,tsx}` and `TransactionsScreen.test.tsx`;
`src/features/categories/useCategories.ts` (`useCreateCategoryMutation`);
`src/features/accounts/AccountDetailScreen.tsx` (manual-entry buttons);
`src/routes/_app.settings.tsx` (placeholder → Rules/Notifications tabs);
`src/app/shell/nav-items.ts` (Inbox nav item); `src/test-support/api-test-utils.ts`
(`buildTransaction`/`buildTransactionDetail`); `e2e/app-walkthrough.spec.ts`
(extended); `e2e/support/mock-api.ts` (in-memory store, new routes);
`playwright.config.ts` (`testMatch` extended, header comment updated);
`src/routeTree.gen.ts` (generated, regenerated by `vite build`).

No changes outside `apps/web/**` and this file. No `pnpm install`, no
`package.json`/lockfile edits, no `apps/api` edits, no `docker`, no commits.
