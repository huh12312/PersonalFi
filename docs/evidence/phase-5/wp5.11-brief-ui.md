<!-- SPDX-License-Identifier: MIT -->

# WP 5.11 — UI: the Weekly Brief and the health score

_Agent: frontend-architect (Sonnet). Branch `main`, started at `d243ffa`. Written incrementally,
sabotages recorded as they happened, per the phase rule. Concurrent in the same tree, on disjoint
files: WP 5.8 (backend, health score) and WP 5.12 (advisor management UI)._

## 0. Log

| Step                          | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read                          | `docs/plan/05-phase-5-dispatch.md` §3's preamble, the WP 5.11 entry in full, §4 ("UI packages code against contracts, never against a guess"), §5, §6 Q3 (in-app only this phase).                                                                                                                                                                                                                                                                                                  |
| Read                          | The contracts: `apps/web/src/api/generated/types.gen.ts` for `BriefItem`/`AdvisoryBrief`/`GetHealthScoreResponses`/`ReviewInsightData`; `docs/evidence/phase-5/wp5.10-routes.md` (money shape, months-as-decimal-string, the health-score 404 stub as it stood when that WP landed); `wp5.6-brief.md` (the Brief's assembly, ranking, retirement effect); `wp5.9-feedback.md` (the seven reason codes, each effect); `wp5.3-narrator.md` §4 (linked-never-ranked, `narrationsFor`). |
| Read                          | `docs/research/07-advisory-domain.md` §7.2 (the disclaimer, verbatim) and §8.3 (the dismiss taxonomy).                                                                                                                                                                                                                                                                                                                                                                              |
| Read                          | The existing screens: `features/insights/{InsightsScreen,InsightCard,EvidencePanel,DismissReasonDialog,TopInsightsWidget}.tsx`, `routes/_app.insights.tsx`, `app/shell/{Sidebar,nav-items}.tsx`, `e2e/plan.spec.ts` and `support/{screenshot-dir,mock-plan,fake-webauthn,axe}.ts`, `docs/CONVENTIONS.md`.                                                                                                                                                                           |
| Found                         | `GET /insights/health-score`'s generated client type (`GetHealthScoreResponses`) had no 200 branch (`unknown`) — but **the real route had already landed in this same tree**, mid-session, by WP 5.8/5.10 (`apps/api/src/routes/brief.ts:235–265`), wrapping the body as `{ healthScore: {...} }`. Read the route's own source rather than guess; `features/health/types.ts` models that exact shape. See §7 item 2.                                                                |
| Found                         | No REST route anywhere serves a narration for a Brief item — `listInsights` (behind both the feed and `GET /insights/{id}`) unconditionally excludes narration rows. See §7 item 3.                                                                                                                                                                                                                                                                                                 |
| Found                         | `BriefItem` carries none of `confidenceBasis`/`impactBasis`/`caveats`/`actions` that `EvidencePanel.tsx` (reused, not owned) requires, and no action data of its own for "one primary action". See §7 items 4–5.                                                                                                                                                                                                                                                                    |
| Found                         | The nav items `Sidebar.tsx` renders live in `app/shell/nav-items.ts`, not literally in `Sidebar.tsx` — edited there instead. See §7 item 6.                                                                                                                                                                                                                                                                                                                                         |
| Built                         | `routes/_app.brief.tsx`; `features/brief/{disclaimer,types,retirement-effect,evidence-adapter,NarrationBadge,AttentionStrip,BriefItemCard,BriefScreen,BriefDashboardCard}.{ts,tsx}`; `features/health/{types,format,HealthScoreSection}.{ts,tsx}`; edited `features/insights/{DismissReasonDialog,InsightCard}.tsx`, `app/shell/nav-items.ts`, `routes/_app.index.tsx`.                                                                                                             |
| Regenerated                   | `src/routeTree.gen.ts` — tracked, not gitignored, normally written by the TanStack Router Vite plugin (skipped in `mode: 'test'`); no standalone generator CLI exists in this repo's `node_modules/.bin`, so a foregrounded `timeout 25 pnpm exec vite dev --port 0` was run once to let the plugin regenerate it, then killed by the timeout. See §7 item 7.                                                                                                                       |
| Typecheck                     | `pnpm exec tsc -b --noEmit` (whole `apps/web`) clean after every file.                                                                                                                                                                                                                                                                                                                                                                                                              |
| Unit tests                    | `features/brief/BriefScreen.test.tsx` (11), `features/health/HealthScoreSection.test.tsx` (4) written and run green.                                                                                                                                                                                                                                                                                                                                                                |
| Sabotaged                     | Four sabotages, one per required case, each observed red on the first try, then restored and reconfirmed green — §5.                                                                                                                                                                                                                                                                                                                                                                |
| e2e                           | `e2e/brief.spec.ts` (7 tests, including the five exit tests verbatim and an axe-both-themes test) — green on the first run, `--workers 1`.                                                                                                                                                                                                                                                                                                                                          |
| Found while writing this file | `InsightsScreen.test.tsx` (not owned by this package; `features/insights/InsightsScreen.tsx` is WP 5.12's this wave) has one test that now fails because of this package's mandated `DismissReasonDialog` change. Recorded, not fixed — see §7 item 1.                                                                                                                                                                                                                              |
| Posted                        | This report, before the final verification run — §6.                                                                                                                                                                                                                                                                                                                                                                                                                                |

## 1. Files

**New:**

- `apps/web/src/routes/_app.brief.tsx`
- `apps/web/src/features/brief/disclaimer.ts`
- `apps/web/src/features/brief/types.ts`
- `apps/web/src/features/brief/retirement-effect.ts`
- `apps/web/src/features/brief/evidence-adapter.ts`
- `apps/web/src/features/brief/NarrationBadge.tsx`
- `apps/web/src/features/brief/AttentionStrip.tsx`
- `apps/web/src/features/brief/BriefItemCard.tsx`
- `apps/web/src/features/brief/BriefScreen.tsx`
- `apps/web/src/features/brief/BriefDashboardCard.tsx`
- `apps/web/src/features/brief/BriefScreen.test.tsx`
- `apps/web/src/features/health/types.ts`
- `apps/web/src/features/health/format.ts`
- `apps/web/src/features/health/HealthScoreSection.tsx`
- `apps/web/src/features/health/HealthScoreSection.test.tsx`
- `apps/web/e2e/brief.spec.ts`
- `docs/evidence/phase-5/wp5.11-brief-ui.md` (this file)
- `docs/evidence/phase-5/screenshots/wp5.11/**` (final run only, §8)

**Edited:**

- `apps/web/src/features/insights/DismissReasonDialog.tsx` — the three free-text presets replaced
  with 07 §8.3's seven `reasonCode`s (`DISMISS_REASON_CODES`), plus an optional free-text note; the
  `onDismiss` callback now reports `{ reasonCode, note }` instead of a bare string.
- `apps/web/src/features/insights/InsightCard.tsx` — its one call site updated to the new
  `onDismiss` shape and `reasonCode`/`reason` body fields.
- `apps/web/src/app/shell/nav-items.ts` — a `/brief` entry added to `NavPath`, `NAV_GROUPS`
  ("Overview") and `MORE_NAV_ITEMS` (so it is reachable on mobile too); `CalendarClock` imported.
- `apps/web/src/routes/_app.index.tsx` — one import, one mount line (`<BriefDashboardCard />`,
  beside `<TopInsightsWidget />`).
- `apps/web/src/routeTree.gen.ts` — regenerated (§0, §7 item 7); no hand edit.

## 2. The route, the nav entry, the dashboard card

`/brief` (`_app.brief.tsx` → `BriefScreen`), reachable from the sidebar's "Overview" group (after
"Insights") and from the mobile "More" sheet. The dashboard card is mounted by the one line
`apps/web/src/routes/_app.index.tsx` adds beside `TopInsightsWidget`.

## 3. The Brief screen

`BriefScreen.tsx` reads `GET /insights/brief/current` (`getCurrentBriefOptions()`). States, each
with its own `data-testid`:

- **Loading** — `SkeletonText`.
- **No Brief published yet** (404 `insights.brief_not_found`) — an `EmptyState` naming the Sunday
  schedule, with the health score section still rendered beneath (it is computed on its own
  schedule and may exist even before the first Brief).
- **Any other error** — a plain `role="alert"` message.
- **Cold start** (`brief.coldStart && coldStartNote !== null`) — the server's own note, verbatim,
  `data-testid="brief-cold-start"`.
- **Nothing material** (`brief.nothingMaterial`) — an `EmptyState` saying so plainly, no filler
  item; `brief-item-card` count is `0`.
- **Normal** — the attention strip (`AttentionStrip.tsx`, `brief.items` filtered to
  `section === 'attention'`) above at most five ranked cards (`BriefItemCard.tsx`, filtered to
  `section === 'ranked'`, then `.slice(0, MAX_RANKED_CARDS)` — the view's own, second, independent
  enforcement of the five-card cap the backend already applies, §5 sabotage 1).

07 §7.2's disclaimer renders once, verbatim, `data-testid="brief-disclaimer"`:

> Educational information generated from your own data. Not investment, tax, or legal advice.
> Figures are estimates based on assumptions you can review and change. Consider consulting a
> qualified professional.

## 4. One ranked card — every number traced to its API field

`BriefItemCard.tsx`, per item of `brief.items` (`BriefItem`, `apps/web/src/api/generated/types.gen.ts`):

| On screen                        | Source field                                                                                                                                                          | Client-side operation                                                                                                             |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Severity badge, title            | `item.severity`, `item.title`                                                                                                                                         | none                                                                                                                              |
| Body text (template or narrated) | `item.summaryMd` (always); `item.narration?.narratedSummaryMd` when present (§7 item 3)                                                                               | none                                                                                                                              |
| "Carried from last week" badge   | `item.carried`                                                                                                                                                        | none                                                                                                                              |
| The one dollar figure            | `item.annualizedImpact` / `item.oneTimeImpact` (`{minor, currency}`) via `headlineImpactOf` (reused from `features/insights/severity.ts`, unmodified)                 | none beyond `<Money>`'s own formatting                                                                                            |
| Retirement effect text           | `item.retirementEffect` — `yearsEarlier` (a whole number, printed as-is), `monthsOfSpending.months` (a decimal string, printed as-is), or `reason` (`not_computable`) | `retirement-effect.ts#retirementEffectWording` only _selects_ which already-computed branch to show — no arithmetic on any figure |
| "Why am I seeing this?" panel    | `item.evidence`, `item.advisorId`, `item.confidence` via `evidence-adapter.ts#insightViewOf` into the unmodified `EvidencePanel.tsx`                                  | none; `confidenceBasis` is hardcoded `'rule'` as a structural invariant (§7 item 4), not a derived or guessed value               |
| Accept / Dismiss                 | `item.insightId` (session-scoped `POST /insights/{id}/review`)                                                                                                        | none                                                                                                                              |

No client-side money math beyond formatting anywhere in this table — confirmed again by sabotage
4 (§5).

## 5. Sabotages, recorded as they happened — all four red on the first try, all restored

| #   | Sabotage (file, change)                                                                                                                                                                                                                                                                                                    | Test                                                                                                                                             | Observed red                                                                                                                                                                                                                                                                                                                                   | Restored, confirmed green                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | **The five-card cap removed.** `BriefScreen.tsx`'s `.slice(0, MAX_RANKED_CARDS)` changed to `.slice(0, MAX_RANKED_CARDS * 99)`, against a fixture serving eight ranked items.                                                                                                                                              | `BriefScreen.test.tsx > "the view's own five-card cap holds even when the backend serves more than five"`                                        | `AssertionError: expected 8 to be less than or equal to 5`                                                                                                                                                                                                                                                                                     | Yes — `vitest run src/features/brief/BriefScreen.test.tsx` → 11/11       |
| 2   | **The direction glyph without its word.** `HealthScoreSection.tsx`'s `DirectionCell` had its `<span>{DIRECTION_LABEL[direction]}</span>` deleted, leaving only the `aria-hidden` glyph.                                                                                                                                    | `HealthScoreSection.test.tsx > "a direction word is present beside its glyph — the test the \"glyph without its word\" sabotage is run against"` | `TestingLibraryElementError: Unable to find an element with the text: Unchanged`                                                                                                                                                                                                                                                               | Yes — `vitest run src/features/health/HealthScoreSection.test.tsx` → 4/4 |
| 3   | **A reason code dropped.** `DismissReasonDialog.tsx`'s `DISMISS_REASON_CODES` had `'LATER'` removed (six codes left).                                                                                                                                                                                                      | `BriefScreen.test.tsx > "dismissing asks for one of seven reasons and the code reaches the API"`                                                 | `AssertionError: expected [ …(6) ] to have a length of 7 but got 6`                                                                                                                                                                                                                                                                            | Yes — `vitest run src/features/brief/BriefScreen.test.tsx` → 11/11       |
| 4   | **A money figure formatted from a number.** `BriefItemCard.tsx`'s `<Money value={impact.money} .../>` replaced with a naive `` `+$${(Number(impact.money.minor) / 100).toFixed(2)}` `` span, against a fixture minor value of `9007199254740993` (2^53 + 1 — the smallest integer a JS `number` cannot represent exactly). | `BriefScreen.test.tsx > "a large dollar figure renders exactly, from the bigint minor units…"`                                                   | `TestingLibraryElementError: Unable to find an element with the text: +$90,071,992,547,409.93` — the naive path actually rendered `+$90071992547409.92` (wrong cent, no thousands separators; computed by hand: `Number('9007199254740993') / 100 === 90071992547409.92`, one cent short of the exact `…93` a bigint-based formatter produces) | Yes — `vitest run src/features/brief/BriefScreen.test.tsx` → 11/11       |

After each restore, `git status`/`grep -rn "SABOTAGE"` confirmed no leftover marker in any touched
file.

## 6. The health score

`HealthScoreSection.tsx` reads `GET /insights/health-score` (`getHealthScoreOptions()`). The real
route (landed mid-session by WP 5.8/5.10, §7 item 2) answers `{ healthScore: { isoWeek, overall,
components, excluded, computedAt } }`; a 404 `insights.health_score_not_computed` (the state before
WP 5.8 lands, or a holder with no computed week yet) renders as "Not computed yet", never as an
error.

The overall figure (`result.overall`, 0–100 or `null`) renders only beside the six component rows
in the same card — never on its own, never on the dashboard or anywhere else in this package.
Each row (`ComponentRow`):

| Field          | Source                                                                               | Display                                                                                                                                                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Component name | `component.component` (enum)                                                         | `COMPONENT_LABEL` lookup                                                                                                                                                                                                                                          |
| Value          | `component.value` — a decimal string (months/ratio) or `MoneyJson` (`fee_drag` only) | months: printed as-is with a unit word; ratios: `×100` + `.toFixed(1)` + `%` (formatting a _ratio_, not money — `docs/CONVENTIONS.md`'s own carve-out, "Floats are correct for … percentages"); `fee_drag`: the real `<Money>` component, never parsed to a float |
| Weight         | `component.weight` — a decimal string                                                | same ratio-percent formatting as above                                                                                                                                                                                                                            |
| Band           | `component.band` (`poor`/`fair`/`good`/`excellent`)                                  | an icon (`AlertOctagon`/`AlertTriangle`/`CheckCircle2`) **and** the word (`BAND_LABEL`)                                                                                                                                                                           |
| Direction      | `component.direction` (`improved`/`worsened`/`unchanged`/`no_previous_data`)         | an `aria-hidden` glyph (↑/↓/→/—) **and** the word (`DIRECTION_LABEL`) — sabotage 2 above is the proof that the word is load-bearing, not decorative                                                                                                               |

Excluded components (`result.excluded`) are named with their reason in a separate list, never
folded into the six scored rows and never scored as zero.

## 7. Contract gaps found, and what this package did about each — needs the orchestrator

1. **`InsightsScreen.test.tsx`'s dismiss test now fails** (not this package's file —
   `features/insights/InsightsScreen.tsx` is WP 5.12's this wave, mid-move). The mandated
   `DismissReasonDialog` change (three free-text presets → 07 §8.3's seven `reasonCode`s) means the
   test's `within(dialog).getByRole('radio', { name: 'Not useful' })` no longer finds a match (that
   label no longer exists) and the body it asserts (`{ action: 'dismiss', reason: 'Not useful' }`)
   no longer matches what the dialog sends. Confirmed red, twice, including after WP 5.12's own
   concurrent edits landed (the move itself doesn't touch the Feed tab's `InsightCard`/
   `DismissReasonDialog` usage, so the failure is unrelated to their work). **Recommended fix**
   (not applied here — the file isn't this package's to touch, and `InsightsScreen.tsx` is
   mid-move by a concurrent agent): replace the radio click with
   `within(dialog).getByRole('radio', { name: "True, but I can't act on it" })` and the assertion
   with `{ action: 'dismiss', reasonCode: 'NOT_ACTIONABLE', reason: null }`.
2. **The health-score 200 response has no generated client type.** `apps/web/src/api/generated/types.gen.ts`'s
   `GetHealthScoreResponses` still has no 200 branch (success type `unknown`) as of this package's
   work, even though the real route landed in this same tree mid-session (WP 5.8/5.10,
   `apps/api/src/routes/brief.ts:235–265`, wrapping the body as `{ healthScore: {...} }`).
   `features/health/types.ts` models that exact shape, read from the route's own source rather than
   guessed. **Recommended:** `pnpm run gen` (regenerate `packages/contracts/openapi/openapi.json`
   then `apps/web`'s client) at the next wave boundary; once done, `features/health/types.ts` and
   the one cast in `HealthScoreSection.tsx` (`query.data as HealthScoreWireResponse`) can be deleted
   in favour of the generated type.
3. **No REST route surfaces a narration for a Brief item.** WP 5.3 built the narrator and its
   storage (`insights.narrates_insight_id`) and a server-side reader (`narrationsFor`,
   `packages/contexts/insights/src/advisors/local/link.ts` per `wp5.3-narrator.md` §4), but
   `listInsights` — the one function behind both the feed and `GET /insights/{id}` — unconditionally
   excludes narration rows, by design. So the AI-assisted badge (`NarrationBadge.tsx`'s
   `NarratedSummary`) is built pure and correct but **never fires against the real backend today**:
   `features/brief/types.ts#BriefItemWithNarration` names the exact field (`narration:
{ narratedSummaryMd: string } | null`) `BriefItem` would need for it to. Exercised here only by
   this package's own unit and e2e fixtures, which add that field to the mocked JSON body directly —
   never a guessed URL. **Recommended:** `brief.ts`'s Brief-item serialiser (or `brief/store.ts`)
   joins `narrationsFor` for each item's `insightId` and adds the field; then `pnpm run gen`.
4. **`BriefItem` carries none of the fields `EvidencePanel.tsx` (reused, not owned) needs beyond
   `evidence`/`advisorId`/`confidence`.** `evidence-adapter.ts#insightViewOf` supplies
   `confidenceBasis: 'rule'` as a structural invariant (the Brief's assembly only ever includes
   builtin, rule-based insights — confirmed against `read.ts:172` and `wp5.6-brief.md`'s own
   assembly header) and empty defaults for `impactBasis`/`caveats`/`actions` (EvidencePanel's own
   guards hide those rows rather than rendering a fabricated value). **Recommended:** if a future
   WP wants those rows live, add `impactBasis`/`caveats` to the Brief item's snapshot (mirroring
   `Insight`'s own fields) rather than reading them from a live join — the Brief's own immutability
   rule (§4, "served exactly as stored") forbids a live re-fetch here.
5. **"One primary action" has no field of its own on `BriefItem`.** Interpreted as the Accept
   button — the one action verb `POST /insights/{id}/review` actually defines — rather than
   fabricated action text/URL. Recorded as an interpretation, not a guess at a missing field.
6. **The nav line lives in `nav-items.ts`, not `Sidebar.tsx`.** The dispatch names "the one nav line
   in `apps/web/src/app/shell/Sidebar.tsx`"; `Sidebar.tsx` itself only renders `NAV_GROUPS` (no
   literal item list) — the actual nav structure was factored out into `app/shell/nav-items.ts` at
   some point after the dispatch was written. Edited there instead (`NavPath`, `NAV_GROUPS`,
   `MORE_NAV_ITEMS`), which is where "the one nav line" now genuinely lives.
7. **`routeTree.gen.ts` is a tracked file with no standalone CLI generator in this repo.** It is
   normally written by `@tanstack/router-plugin`'s Vite plugin (skipped under `mode: 'test'`), and
   `apps/web`'s own `typecheck`/`gen` scripts never invoke it (`gen` runs `openapi-ts` only). This
   package regenerated it by running `timeout 25 pnpm exec vite dev --port 0 --host 127.0.0.1` once
   in the foreground and letting the timeout kill it after the plugin's startup write — confirmed
   first against the unmodified tree (no file write, since nothing had changed yet) and then again
   after adding `_app.brief.tsx` (the new route appeared). Recorded for the orchestrator in case a
   later wave needs the same trick.

## 8. `pnpm exec vitest run`, the spec alone, `tsc --noEmit`, eslint — posted before the final run

Per the phase rule, this section is written up to this point before the run that follows it; only
§9 below is appended after.

Commands intended for the final pass:

1. `cd apps/web && pnpm exec vitest run src/features/brief/BriefScreen.test.tsx src/features/health/HealthScoreSection.test.tsx`
2. `cd apps/web && timeout 600 pnpm exec playwright test e2e/brief.spec.ts --workers 1`
   (`PLAYWRIGHT_EVIDENCE_DIR=docs/evidence/phase-5/screenshots/wp5.11/` set for this run only)
3. `pnpm exec tsc --noEmit -p apps/web`
4. `npx eslint` over every file this package touched (§1's list)

Every one of the above has already been run once during this session (§0, §5, §6) and read clean;
this final pass re-confirms after the health-score wire-shape correction (§7 item 2) and the
sabotage restores (§5) are all in place together.

## 9. Final verification result

Run after §0–8 were written and posted, foreground, in the order the phase rule asks for:

1. **`cd apps/web && pnpm exec vitest run`** (the whole `apps/web` suite, not scoped to this
   package's own files — confirms no regression anywhere else in the app):
   **1 file failed, 64 passed (65 total); 1 test failed, 367 passed (368 total).** The one failure
   is exactly `InsightsScreen.test.tsx > InsightsScreen > dismissing an insight captures a reason
and shows the cooldown notice`, the pre-named, documented consequence of the mandated
   `DismissReasonDialog` change (§7 item 1) — not owned by this package, not a new or
   unanticipated regression. Every other file, including every other insights/advisors file WP 5.12
   touched concurrently, passed.
2. **`cd apps/web && timeout 600 PLAYWRIGHT_EVIDENCE_DIR="../../docs/evidence/phase-5/screenshots/wp5.11/" pnpm exec playwright test e2e/brief.spec.ts --workers 1`**:
   **7 passed, 0 failed**, including the five exit tests verbatim, the health-score-not-yet-computed
   case, and axe clean in both light and dark. Screenshots written to
   `docs/evidence/phase-5/screenshots/wp5.11/` for the first and only time this session (seven
   files: `wp5.11-{five-cards,narration-badge,nothing-material,health-score,dismiss-reasons,brief-light,brief-dark}.png`,
   confirmed present and non-empty, 200–215 KB each, and visually inspected — the Brief screen
   renders the attention strip, a ranked card with its dollar figure, retirement effect, evidence
   toggle and Accept/Dismiss, and the health score's six rows with value/weight/band/direction all
   in words, exactly as designed).
3. **`pnpm exec tsc --noEmit -p apps/web`**: **clean, no output.**
4. **`npx eslint`** over every file this package touched (§1's new and edited lists, plus
   `e2e/brief.spec.ts`): **clean, exit 0.**

No red anywhere in this final pass except the one pre-named, already-explained exception in step 1.
`git status --porcelain` at the end of this session shows every changed or new path either in this
package's own Owns list, or already present before this session started (WP 5.8's and WP 5.12's
concurrent work, untouched by this agent). No `git add`, `git commit`, `git stash` or
`git checkout --` was run at any point.
