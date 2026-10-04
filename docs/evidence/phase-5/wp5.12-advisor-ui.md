<!-- SPDX-License-Identifier: MIT -->

# WP 5.12 — UI: advisor management

Written against `main` at `d243ffa` (a wip snapshot: `kill-levels.ts`, `ScopeGrantsPanel.tsx` and
`PayloadPreviewPanel.tsx` already on disk, read against the spec first and kept — see §1) while WP 5.11
(Brief UI, `features/{brief,health}/**`, `apps/web/src/app/shell/nav-items.ts`, `_app.brief.tsx`,
`_app.index.tsx`, `InsightCard.tsx`, `DismissReasonDialog.tsx`) and WP 5.8 (backend, `health/store.ts`,
migration `0033`) run concurrently in the same tree, on disjoint files. Compose stack stayed down the
whole time; nothing here touched it.

## 0. Log

Written incrementally as the work happened, per the phase rule.

| When                                                                                                                                                                                                                                                                                | What |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| Read `05-phase-5-dispatch.md` §3's preamble and the WP 5.12 entry in full, §5's C-12 row, `wp5.10-routes.md`, `wp5.1-run-control.md` §3/§7/§8/§14, `wp5.2-local-model.md` §3, `gate-security-review.md` §3.13/§6 C-12, `research/07-advisory-domain.md` §7.3/§7.5.                  | —    |
| Read the state-on-disk files (`kill-levels.ts`, `ScopeGrantsPanel.tsx`, `PayloadPreviewPanel.tsx`) against the spec. Both panels matched the spec already — kept unedited except one bug fixed in each (§1, §7).                                                                    | —    |
| Read the generated API types for every route this WP calls (`listAdvisorRuns`, `getAdvisorRun`, `cancelAdvisorRun`, `setAdvisorKindEnabled`, `getRuleHealth`, the `AdvisorRunInspector`/`AdvisorRunRetainedPayload`/`AdvisorPayloadPreview` shapes) — never guessed.                | —    |
| Resolved the route-filename question empirically rather than by reading documentation alone: added `_app.settings_.advisors.tsx`, ran `vite build --mode development` once to let the real TanStack Router codegen settle the question, inspected the generated `routeTree.gen.ts`. | §2.  |
| Wrote `RunInspectorPanel.tsx`, `KindSwitch.tsx`, `AdvisorManagementScreen.tsx`; moved `AdvisorsSettings` (deleted the old file, removed its tab from `InsightsScreen.tsx`); added the settings tree's one link line.                                                                | §3.  |
| Fixed a pre-existing `react-hooks/set-state-in-effect` lint error in `ScopeGrantsPanel.tsx` (state-on-disk, not written by this WP) and an uncaught-promise-rejection gap in `PayloadPreviewPanel.tsx`'s approve handler (state-on-disk).                                           | §7.  |
| Wrote `features/advisors/*.test.tsx` (5 files, 20 cases) and `e2e/advisors.spec.ts` (5 cases); ran both green.                                                                                                                                                                      | §4.  |
| Sabotage log: four controls, each broken, its test observed red, restored, re-confirmed green — including one test bug the first sabotage attempt exposed (§5, sabotage #3).                                                                                                        | §5.  |
| Posted this report; ran final verification.                                                                                                                                                                                                                                         | §8.  |

## 1. What was on disk, kept or fixed

- **`kill-levels.ts`** — matched the spec exactly: the four levels' state in words, each function pure,
  each doc comment honest about what has no `GET` route yet. Kept unedited.
- **`ScopeGrantsPanel.tsx`** — matched the spec's shape (fetched eagerly, rendered unconditionally,
  sensitivity order, the `requiresPerRunConsent` explanation inline on its own scope's row, `perRunConsent:
true` sent only when such a scope is chosen). Kept the design, fixed one defect (§7 item 1): a
  `useEffect` that called `setSelected` synchronously on every `scopesQuery.data` change — a real
  `react-hooks/set-state-in-effect` lint error, not a style nit (it is exactly the kind of extra render the
  rule exists to prevent), and redundant: the effect only ever recomputed the same fallback the checkbox's
  `checked` prop already computed inline. Replaced with a render-time `isChecked(scope)` helper reused by
  both the checkbox and the save handler's filter; the effect and its `useEffect` import are gone.
- **`PayloadPreviewPanel.tsx`** — matched the spec's shape (eager fetch, the untrusted block marked inside
  the parsed prompt message, the `request.snapshot` fallback marked when `prompt` is `null`, the approval
  button gated on `approvalRequired && !approved`). Kept the design, fixed one defect (§7 item 2): a
  `local_model` advisor's approval 503s on the api process today (no `PromptRenderer` bound —
  `wp5.10-routes.md` §7 item 2, reproduced in §4 below) and `handleApprove`'s only error channel
  (`useStepUpRetry.error`) never reports an action's own failure, only the step-up ceremony's — the 503
  was silently swallowed by the `void handleApprove(...)` call site. Added a dedicated `approveError`
  state, caught and rendered the same way `ScopeGrantsPanel.tsx`'s `saveError` already is.

## 2. Route filename: `_app.settings_.advisors.tsx`, not `_app.settings.advisors.tsx`

Resolved against the actual codegen, not just the documented convention. `routes/_app.settings.tsx` (WP
2.11/3.12's file) is a leaf route: Base UI `Tabs` switches its four sections by client-side state, and the
component renders no `<Outlet/>` — it never has. A dot-nested child (`_app.settings.advisors.tsx`) would
be generated as a genuine child of `/_app/settings` in the **component** tree (rendered through that
parent's `<Outlet/>`); with no `<Outlet/>` to render into, `/settings/advisors` would match and show
nothing — the parent's own component owns the whole page unconditionally.

`_app.settings_.advisors.tsx` (trailing underscore — TanStack Router's documented non-nested-route escape)
keeps the URL `/settings/advisors` but renders as a sibling of `/_app/settings`, directly inside `_app.tsx`'s
own `<Outlet/>` — the same level every other top-level screen (`_app.insights.tsx`, `_app.budget.tsx`, …)
renders at. That is the one that actually displays something.

Confirmed empirically, not just by reading the rule: ran `pnpm exec vite build --mode development` once
(apps/web, ~90s, succeeded) and inspected the generated `routeTree.gen.ts`:

```
const AppSettingsAdvisorsRoute = AppSettingsAdvisorsRouteImport.update({
  id: '/settings_/advisors',
  path: '/settings/advisors',
  getParentRoute: () => AppRoute,     // _app, not AppSettingsRoute
} as any)
```

`getParentRoute: () => AppRoute` (the `_app` shell) — a sibling of `AppSettingsRoute`, not nested inside
it — confirms the choice before any test ran. The dispatch's "child of the settings layout" reads true of
the URL and the sitemap (the settings tree's one link line, §3, is how a holder reaches it) and not of the
React component tree, which has no settings `<Outlet/>` to be a child of in this build. The build's `dist/`
output was deleted afterward (not part of this WP's deliverable); the only artefact kept from it is the
regenerated `routeTree.gen.ts` itself, a 21-line additive diff (`git diff --stat`), which every new route in
this tree regenerates the same way.

No probe file existed on disk to delete — `apps/web/src/routes/` had neither `_app.settings.advisors.tsx`
nor `_app.settings_.advisors.tsx` when this WP started (confirmed by `ls` before writing either).

## 3. Files by path

**New** (`apps/web/src/features/advisors/**`):

- `AdvisorManagementScreen.tsx` — the `/settings/advisors` screen: module-level note, the kind switch
  (local_model only, gated on a registered `local_model` advisor existing), the advisor list (kind, run-now,
  the level-3 switch — ported unchanged from the deleted `AdvisorsSettings.tsx`), and per-advisor expandable
  detail (all four levels in words, `ScopeGrantsPanel`, `PayloadPreviewPanel`, `RunInspectorPanel`), and the
  catalogue-gaps list.
- `KindSwitch.tsx` — level 2's write-only control (two explicit buttons, never a `Switch` — no route
  reports the flag's current value).
- `RunInspectorPanel.tsx` — runs list, run detail (`input_digest`, the verified mark gated strictly on
  `payload.digestVerified`, emitted scopes, rejections, model/prompt hash, cancellation level), cancel
  gated strictly on `isRunInFlight(run.status)` from `kill-levels.ts`.
- `AdvisorManagementScreen.test.tsx`, `KindSwitch.test.tsx`, `RunInspectorPanel.test.tsx`,
  `ScopeGrantsPanel.test.tsx`, `PayloadPreviewPanel.test.tsx` — unit/component tests (§4).

**Edited:**

- `ScopeGrantsPanel.tsx`, `PayloadPreviewPanel.tsx` — bug fixes only (§1).
- `apps/web/src/features/insights/InsightsScreen.tsx` — the move only: the "Advisors" tab and its panel
  removed (now a single-section screen, the `Tabs` wrapper removed with it since one tab is not a
  tablist), its `AdvisorsSettings` import removed. No other change.
- `apps/web/src/routes/_app.settings.tsx` — the settings tree's one link line: a `<Link to="/settings/
advisors">Advisor management</Link>` paragraph, plus a docstring line explaining why the route is a
  separate file rather than a fifth tab (§2). The existing tabs, their screens, and the trailing "future
  work" paragraph are otherwise untouched (its original wording restored after an unintended edit was
  caught and reverted during this session).
- `apps/web/src/routeTree.gen.ts` — regenerated (21-line additive diff), a required side effect of adding
  a route file, not a hand edit.

**Deleted:**

- `apps/web/src/features/insights/AdvisorsSettings.tsx` — moved to `features/advisors/
AdvisorManagementScreen.tsx` and grown (§3's spec); no test file existed for it to delete alongside it.

**New:**

- `apps/web/e2e/advisors.spec.ts` (§4).
- `docs/evidence/phase-5/wp5.12-advisor-ui.md` (this file), `docs/evidence/phase-5/screenshots/wp5.12/**`.

**Not touched** (confirmed by `git status` throughout): `e2e/support/**`, `app-walkthrough.spec.ts`,
`playwright.config.ts` (already carried `advisors` in `testMatch` — confirmed, not added by this WP),
`apps/web/src/api/generated/**`, `features/insights/{DismissReasonDialog.tsx,InsightCard.tsx}`,
`Sidebar.tsx`/`nav-items.ts`, `features/{brief,health}/**`, anything outside `apps/web`, any lockfile.

## 4. Exit tests

**Unit — `features/advisors/*.test.tsx`, 5 files, 20 cases, all passing:**

- `ScopeGrantsPanel.test.tsx` (3): `'shows what every scope yields and what it drops, in sensitivity
order, before any step-up action exists to trigger one'`; `'a requiresPerRunConsent scope is never
offered as a plain standing grant: its own box carries the per-run explanation'`; `'saving a selection
that includes a per-run-consent scope sends perRunConsent: true'`.
- `PayloadPreviewPanel.test.tsx` (3): `'marks the untrusted block distinctly from the instruction text
around it'`; `'a local_model advisor with no bound prompt renderer shows the 503 honestly, not a blank
panel'` (reproduces `wp5.10-routes.md`'s own finding: the api process binds no `PromptRenderer`, so this
  is the live shape, not a guessed error case); `'approval comes before the first run: the button is
offered until approved, then a badge'`.
- `RunInspectorPanel.test.tsx` (7): `'shows the input digest and marks a verified payload only when
digestVerified is true'`; `'never shows a verified mark when digestVerified is false — a tampered
payload is named, not hidden'`; `'a run with no retained payload says so honestly — never a verified mark
with nothing behind it'`; `'cancel is offered on an in-flight run and calls POST
/advisors/runs/{runId}/cancel'`; `'cancel is never offered on a run that already finished'`; `'a
cancelled run names the broadest level that applied'`; `'renders per-step rejections when the run has
any'`.
- `KindSwitch.test.tsx` (4): `'names itself as write-only: no claim about the current value is made before
any write'`; `'disabling sends exactly {enabled: false} and reports exactly what the route returned'`;
  `'enabling sends exactly {enabled: true}'`; `'a 404 for a kind with no declared flag is shown, not
swallowed'`.
- `AdvisorManagementScreen.test.tsx` (3): `'the kind switch is shown only when a local_model advisor is
registered'`; `'shows the kind switch when a local_model advisor exists, and every kill level in words on
expand'` — **red first** on its own first run (wrong literal text expected: `'Level 2 — Kind: local_model'`
  instead of the function's actual `'Level 2 — Kind: the advisors.kind.local_model flag...'`; fixed in the
  test, not the component); `'lists the catalogue gaps'`.

```
 Test Files  5 passed (5)
      Tests  20 passed (20)
```

**Playwright — `e2e/advisors.spec.ts` → `--workers 1`, all four named cases plus one axe/screenshot
case, verbatim against the dispatch, all passing on the first run:**

- `'granting a scope shows what it yields and what it drops before the step-up'`
- `'the payload preview shows the exact bytes the model would receive, and approval comes before the first
run'`
- `'the run inspector shows the input digest and marks a verified payload'`
- `'an in-flight local-model run can be cancelled from the inspector'`
- `'the advisor management screen is axe clean in both themes'`

```
Running 5 tests using 1 worker
  ✓ 1 … granting a scope shows what it yields and what it drops before the step-up (4.0s)
  ✓ 2 … the payload preview shows the exact bytes the model would receive, and approval comes before the first run (2.8s)
  ✓ 3 … the run inspector shows the input digest and marks a verified payload (2.5s)
  ✓ 4 … an in-flight local-model run can be cancelled from the inspector (2.6s)
  ✓ 5 … the advisor management screen is axe clean in both themes (6.3s)
  5 passed (35.0s)
```

No mock in `e2e/support/mock-api.ts` was edited (it carries no `/advisors*` handler at all) — `advisors.spec.ts`
registers its own `page.route` on top of the shared `installApiMocks(page)`, the same technique
`inbox.spec.ts` already uses for its own one-off fixture: a handler added after `installApiMocks` runs
first (Playwright runs route handlers in reverse registration order) and `route.fallback()`s anything it
does not recognise back to the shared mock. Step-up is real: the shared mock's `state.steppedUp` flag
(flipped by `/api/auth/step-up/verify`, already wired to the real `@simplewebauthn/browser` call via
`installFakeWebAuthnAssertion`) gates every advisor mutation route this file adds, exactly as the real
backend gates them (403 `step_up_required` until a fresh session exists).

**Axe.** Scoped to `#app-content`, excluding the known shared-sidebar `aria-current` finding (not this
WP's file — `market-data.spec.ts`/`networth.spec.ts` carry the same exclusion for the same reason). Zero
violations in both themes, on both the advisor list view and the run-detail view.

## 5. Sabotage log (recorded as observed)

Four controls this WP's own files are responsible for, each broken, its test run and observed red, the
line restored, and a scoped re-run confirmed green — before this report was finalised.

| #   | Control                                                                                          | Sabotage                                                                                                                 | Observed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Red first try                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Yields/drops render before any step-up action                                                    | `ScopeGrantsPanel.tsx`: the `<dl>` wrapped in `{lastResult !== null && (…)}` — visible only after a successful save      | `× shows what every scope yields and what it drops, in sensitivity order, before any step-up action exists to trigger one` — `expected element to have text content 'Account balances...'`, received only the scope id/badge, no yields/drops text. Restored; re-run 3/3 green.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | yes                                                                                                                                                                                                                                             |
| 2   | A `requiresPerRunConsent` scope's standing-grant checkbox always carries the per-run explanation | `ScopeGrantsPanel.tsx`: `{scope.requiresPerRunConsent && (…)}` → `{false && scope.requiresPerRunConsent && (…)}`         | `× a requiresPerRunConsent scope is never offered as a plain standing grant…` — expected text `'Consented per run only…'`, received none. Restored; re-run 3/3 green.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | yes                                                                                                                                                                                                                                             |
| 3   | The verified mark is driven only by `payload.digestVerified`                                     | `RunInspectorPanel.tsx`: `payload.digestVerified ? (…) : (…)` → `true ? (…) : (…)` (the "verified" branch unconditional) | `× never shows a verified mark when digestVerified is false — a tampered payload is named, not hidden` — expected `'Not verified'`, received `'Verified — the retained bytes re-digest…'` on a payload whose digest did **not** match. Restored; re-run 7/7 green.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | yes                                                                                                                                                                                                                                             |
| 4   | Cancel is offered only on an in-flight run                                                       | `RunInspectorPanel.tsx`: `{isRunInFlight(run.status) && (…)}` → `{true && (…)}`                                          | **First attempt read green — a test bug, not a control bug.** `'cancel is never offered on a run that already finished'` awaited the outer `data-testid="run-detail"` wrapper, which renders unconditionally (a loading skeleton) the instant a run is selected, before its own query resolves — so the assertion ran against a still-loading panel and passed by accident regardless of the sabotage. Fixed the **test** first (awaits the panel's own loaded content — the "no payload retained" notice — rather than its wrapper), re-ran against the still-live sabotage: `× cancel is never offered on a run that already finished` — `expected document not to contain element, found <button data-testid="cancel-run-button">Cancel this run</button>`. Restored the component; re-run 7/7 green. | **no on the first pass, yes once the test itself was fixed** — recorded rather than silently re-run until it happened to pass, per the phase rule that a red-on-first-run is a bug in the route (here: the test) or the control, never a flake. |

Sabotage #4 is the reason this evidence file records a false negative honestly rather than leaving it
implicit: a sabotage log exists precisely to catch a test that passes for the wrong reason, and this one
did, on the first try, before the fix.

## 6. The preview's bytes vs. the retained payload, byte for byte

`e2e/advisors.spec.ts`'s mock constructs both from the same source value (`PROMPT_MESSAGES`) so the
comparison is exact by construction, mirroring what the real `PromptRenderer`/retention pair guarantees
server-side (`wp5.1-run-control.md` §8: "the inspector re-digests rather than trusting stored bytes"):

```
preview.prompt.text        = JSON.stringify({ messages: PROMPT_MESSAGES })   // 276 bytes
run_done.payload.payload   = { messages: PROMPT_MESSAGES }
JSON.stringify(run_done.payload.payload) === preview.prompt.text             // true, 276 === 276
```

Rendered in the UI: the preview's `PayloadPreviewPanel` shows the parsed message content with the
`<untrusted_data>…</untrusted_data>` span marked (`wp5.12-advisor-ui`'s screenshot `payload-preview-*`);
the run inspector's retained-payload section (not separately rendered as raw bytes in this build — only the
verified/not-verified mark, per spec) carries the same `digestVerified: true` the server would compute from
re-hashing those identical bytes against `run.inputDigest`. The two screens therefore show, from different
angles, the same claim: what you approved is what got sent, and what got sent is what was kept.

## 7. Kill-level wording (every level, screenshotted — `module-level-note`, the per-advisor detail region)

- **Level 1 (module)**: `MODULE_LEVEL_WORDS` — "the operator's `ADVISORS_ENABLED` setting and the
  `module.insights` flag... No route in this build reports its current value to the browser."
- **Level 2 (kind)**: `kindLevelWords('local_model')` — "the `advisors.kind.local_model` flag. Off by
  default... Flip it with the switch below (needs a fresh passkey assertion)."
- **Level 3 (advisor)**: `advisorLevelWords(advisor)` — e.g. "enabled. Flips with the switch on this row
  (needs a fresh passkey assertion) and stops only this advisor; it survives a restart." or the quarantined
  variant.
- **Level 4 (run)**: `runLevelWords(latestRun)` — "no run has started yet" / "a run is in flight right
  now. Cancel it from the run inspector below..." / "the latest run already finished (`status`)."
- **Cancellation level**: `cancellationLevelLabel(run.cancelReason)` — `module_disabled`/`advisors_disabled`
  → "Level 1 (module)"; `kind_disabled` → "Level 2 (kind)"; `advisor_disabled`/`advisor_quarantined` →
  "Level 3 (advisor…)"; `run_cancelled` → "Level 4 (this run)" — exercised live in both the unit test
  (`'a cancelled run names the broadest level that applied'`) and the e2e cancel test.

## 8. C-12's screen half (`gate-security-review.md` §3.13/§6)

`ScopeGrantsPanel.tsx` is the consent screen G4-18 names as missing ("with no consent screen, every
advisor runs on an empty snapshot on every install") and the surface G4-17/G4-22 name as needing to be
honest: it reads `GET /advisors/{id}/scopes` (which `wp5.1-run-control.md` §8 already fixed server-side to
report stored grants, not requested ones) and renders every scope's yields/drops before any action, with a
`requiresPerRunConsent` scope's own row always carrying the per-run explanation (sabotage #2, §5).

**Not this WP's**: "the feed says when consent is why it is empty" (G4-18's other half) is the Insights
feed's own empty-state copy — `features/insights/InsightsScreen.tsx` is scoped to "the move only" in this
WP's ownership, and the feed's `EmptyState` text is unrelated to that move. Left to whichever package owns
the feed's empty-state copy; noted here so it is not silently assumed closed by this file's existence.

## 9. Needs the orchestrator

1. **Levels 1 and 2 have no `GET` route reporting their current boolean value to the browser**
   (`kill-levels.ts`'s own doc comment, confirmed again while building this screen). `MODULE_LEVEL_WORDS`
   and `KindSwitch` both say this explicitly rather than guess a starting state; `KindSwitch` is two
   write-only buttons for exactly that reason. A `GET /advisors/kinds/{kind}/enabled` and a module-level
   equivalent would let this screen show rather than merely describe levels 1–2 — out of this WP's
   `apps/web`-only ownership.
2. **The api process binds no `PromptRenderer`** (`wp5.1-run-control.md` §13, `wp5.10-routes.md` §7 item 2) — reproduced again here (`PayloadPreviewPanel.test.tsx`'s 503 case): a `local_model` advisor's
   payload can be previewed (scopes/request shown) but never rendered to bytes or approved from this
   process today. This screen shows that state honestly (the preview's own error branch, and now the
   approval's own `approveError`, §1) rather than hiding it; it does not fix the underlying gap, which is a
   composition-root decision outside this WP.
3. **G4-18's feed half** (§8) — "the feed says when consent is why it is empty" is not addressed by this
   WP; `features/insights/InsightsScreen.tsx`'s empty-state copy is unrelated to the Advisors-tab move this
   WP made there.
4. **`InsightsScreen.test.tsx` has one failing case** (`'dismissing an insight captures a reason and shows
the cooldown notice'`, `within(dialog).getByRole('radio', { name: 'Not useful' })` not found) —
   confirmed via `git status` to be caused by a concurrent WP's in-flight rewrite of
   `DismissReasonDialog.tsx` (its own header: "07-advisory-domain.md §8.3's seven-value dismiss taxonomy…
   replacing the three free-text presets"), not by this WP's move of the Advisors tab out of that same
   screen file. Confirmed pre-existing/concurrent by inspecting `git status -- apps/web/src/features/
insights/DismissReasonDialog.tsx` (modified, not this WP's file) and by the fact that this WP's own edit
   to `InsightsScreen.tsx` touched nothing about the dismiss dialog. Not this WP's to fix.

## 10. Mock handlers and contract assumptions, for the orchestrator

`e2e/advisors.spec.ts`'s private mock (not shared, not in `mock-api.ts`) assumes:

- `GET /advisors` returns `AdvisorHealth[]`; `lastRunStatus` mirrors the advisor's latest run's `status`
  literally (used to drive `runLevelWords`).
- `GET /advisors/{id}/scopes` returns `AdvisorScopeDefinition[]` already in sensitivity order (the panel
  re-sorts defensively regardless).
- `PUT /advisors/{id}/grants` 403s `step_up_required` until a fresh session exists, then 200s
  `{advisorId, granted, revoked}`.
- `GET /advisors/{id}/payload-preview` 200s `AdvisorPayloadPreview` with `prompt: {text, hash} | null`; for
  a `local_model` advisor on a process with no bound `PromptRenderer`, the **whole route** 503s
  `insights.prompt_renderer_unavailable` (not a 200 with `prompt: null`) — confirmed against
  `wp5.10-routes.md` §4's own test description, not guessed.
- `POST /advisors/{id}/payload-approvals` 403s until stepped up, 503s the same code as the preview for an
  unrenderable `local_model` payload, else 200s `{approvalId, queryShape}`.
- `GET /advisors/{id}/runs` / `GET /advisors/runs/{runId}` / `POST /advisors/runs/{runId}/cancel` follow
  the generated `AdvisorRunSummary`/`AdvisorRunInspector`/`AdvisorRunRetainedPayload` shapes exactly; cancel
  403s until stepped up, 409s `insights.run_not_in_flight` on a second cancel of an already-finished run
  (implemented in the mock though no exit test names it), else 200s `{runId, outcome: 'requested'}`.
- `PUT /advisors/kinds/{kind}/enabled` 403s until stepped up, else 200s `{kind, enabled}`.

If the orchestrator wires a shared `/advisors*` fixture into `mock-api.ts` later for a cross-package
walkthrough, these are the exact shapes this screen was built and tested against.

## 11. Final verification result

Posted before this run, per the phase rule. Run after the report below.

1. `cd apps/web && pnpm exec vitest run` (whole `web` project, no coverage) — **367/368 passed.** The one
   failure, `InsightsScreen.test.tsx` → `'dismissing an insight captures a reason and shows the cooldown
notice'`, is the pre-existing concurrent-WP collision named in §9 item 4 (`git status` shows
   `DismissReasonDialog.tsx` modified by another in-flight package, not this one) — confirmed unrelated to
   this WP's own move of the Advisors tab out of the same screen file. `features/advisors/*.test.tsx`
   itself: **5 files, 20/20 passed.**
2. `cd apps/web && pnpm exec playwright test advisors.spec.ts --workers 1`, with `PLAYWRIGHT_EVIDENCE_DIR`
   pointed at `docs/evidence/phase-5/screenshots/wp5.12/` for this run only — **5/5 passed** on the first
   try (no re-run needed): the four named exit tests plus the axe/screenshot case. Four screenshots
   written: `wp5.12-advisor-management-{light,dark}.png`, `wp5.12-run-inspector-{light,dark}.png`.
3. `pnpm exec tsc --noEmit -p apps/web` — **clean**, no output.
4. `npx eslint` over every file this WP touched (§3's file list) — **clean, exit 0**, including after the
   `react-hooks/set-state-in-effect` fix (§1) and every sabotage restore (§5).
5. `npx prettier --write`/`--check` over every file this WP touched, including this `.md` — **clean**.

Not run: a whole-repo `just check`/`just verify` (the phase rule — other Phase 5 packages are mid-wave in
the same tree) and anything touching the compose stack (left down throughout, per the brief).
