# WP 4.12c — Phase 3 gate conditions, third and last pass

Finishing agent for the last four items `docs/evidence/phase-4/wp4.12b-gate-conditions.md`
§14 left open: C-13 (seal `wallet_addresses.descriptor`), C-8's UI half (surface
`investments.SecurityResolutionFailed`), C-9 (a missing FX rate on screen, the two
net-worth figures' labels), and C-16's O-3 (Playwright rewriting committed evidence
screenshots). C-15 (CoinGecko's logo, self-hosted) rode along per the dispatch — it was
never blocked, just unclaimed.

Every section below states what was built, what was sabotaged and observed red, and —
where this work package's granted files stopped short of the WP1.3b custody-test pattern
or of a file outside the grant — exactly what is owed and to whom.

---

## 1. C-13 — seal `wallet_addresses.descriptor` with SecretBox

**A real dependency wall changed the design from what `wp4.12b` §9 sketched.**
`packages/contexts/investments/package.json` does not depend on `@core/secretbox` — unlike
`@ctx/connections`/`@ctx/notifications`/`@ctx/identity`, which do — and this work package's
rules forbid any `package.json`/lockfile edit. A module under
`packages/contexts/investments/src/` that imports `@core/secretbox` would not resolve (no
symlink in that package's `node_modules`, confirmed empirically before writing anything).
So the AAD policy and the seal/unseal calls live in `apps/api/src/domain.ts` instead — it
already depends on `@core/secretbox` (used for `connections.sealed_credentials` elsewhere
in the same file) — recorded as a deviation, not silently taken.

**Migration `0027_wallet_addresses_seal_descriptor.sql`, expand only.** Adds nullable
`descriptor_sealed BYTEA`, drops `descriptor`'s `NOT NULL`, and a CHECK
(`wallet_addresses_descriptor_has_a_representation`) that one of the two is always
present. Backfill and contract are explicitly **not** this migration — `docs/CONVENTIONS.md`'s
own discipline puts them in later releases, and a migration cannot call `SecretBox` (it has
no KEK at migration time) to backfill existing plaintext rows anyway. The migration's own
header states this precisely, including that the backfill is **opportunistic**: an existing
row reseals the next time `WalletAddressStore.put`/`persistPending` writes it (a re-link, a
label edit), not on a schedule.

**`apps/api/src/domain.ts`'s `createWalletAddressStore`** now takes an optional
`secretBox?: SecretBox`. `write()` (used by both `put` and `persistPending`) resolves the
row's own id **before** sealing rather than generating a fresh one that an
`ON CONFLICT (connection_id) DO UPDATE` might discard — a real bug the sealing work
surfaced: the original single INSERT-with-ON-CONFLICT statement always generated a new
`newId()` for its VALUES clause, and on a re-link Postgres keeps the existing row's `id`
(not in the SET list) while discarding the new one. Sealing against the discarded id would
have produced a ciphertext no later read could ever open (`SecretBox`'s AAD binds to the
exact row id). Fixed by resolving the existing id first and branching an explicit
UPDATE/INSERT instead of one upsert statement — correct for both the sealed and the
unsealed path, and a **pure bug fix independent of C-13** that the original ON-CONFLICT
form silently carried since WP 3.6. `get()` unseals when `descriptor_sealed` is present and
throws a named error if it is set with no `SecretBox` supplied — a sealed row is never
returned truncated or fabricated.

**`createWalletRpcRuntime`'s new `secretBox?` option is not wired at either call site.**
Both `apps/api/src/app.ts` and `apps/api/src/worker.ts` build this runtime today with no
`secretBox`, so a fresh install's behaviour is **unchanged**: plaintext `descriptor`,
`descriptor_sealed` always `NULL`, byte-identical to before this migration. Wiring it is
outside this work package's granted files (neither `app.ts` nor `worker.ts` is granted) and
is not a uniform one-liner at both — see **§4 "For the orchestrator"** below for the exact
diffs and the one real complication (app.ts builds this runtime before the app is unlocked).

### 1.1 What was tested, and what could not be

The WP1.3b custody-test pattern (seal through the real `SecretBox`, read
`connections.sealed_credentials`-style raw column exactly as `psql` would, assert no
plaintext substring survives with the 8-byte sliding window) needs two things neither of
which this work package's granted files provide:

- `@core/secretbox` inside a test file that can construct a real, unlocked `SecretBox` —
  blocked by the same dependency wall as §1's design change.
- The real write path (`apps/api/src/domain.ts`'s store) exercised through a route or a
  harness — `apps/api/test/db`, where every prior WP's custody test of this shape lives
  (`plaid-routes.test.ts`, `coinbase-routes.test.ts`), is **not granted to this work
  package** (the grant lists only `apps/api/src/domain.ts`, not `apps/api/test/**`).

**What was built instead, in `packages/contexts/investments/test/db/
wallet-address-descriptor-check.test.ts`** (`investments-db`, 3 tests, no `@core/secretbox`
import): the _structural_ half of C-13 against a real Postgres — a row with only
`descriptor_sealed` set is accepted, a row with only the legacy plaintext `descriptor` is
still accepted (unsealed installs unchanged), and a row with **neither** is refused with
`23514`/`wallet_addresses_descriptor_has_a_representation`. **Sabotaged**: the CHECK's body
replaced with `true`; the "refuses neither" test went red (`pgFailureOf: the statement was
expected to fail, and it succeeded`); restored, `git diff` on the migration afterward shows
only this document's two doc-comment corrections (see §1.2), never the CHECK itself.

**Regression, not new coverage**: `apps/api/test/db/wallet-holdings-valuation.test.ts`
(1/1) and `apps/api/test/db/investments-routes.test.ts` (25/25) re-run green after the
`domain.ts` change — both exercise `createWalletAddressStore` on the unsealed path (no
`secretBox` passed, matching the composition root's current state), proving the rewritten
`write()`/`get()` did not regress the first-link path. **Not exercised by any test I could
run or write**: the re-link (`put()` called twice for the same `connection_id`) branch of
the new explicit UPDATE — no existing test performs a re-link, and I could not add one
(same `apps/api/test/db` wall). Traced by hand instead (§ above); flagged as an open item
in §8.

### 1.2 RUNBOOK

Added to the watch-only wallet section: every derived address is queried at
`blockstream.info` from this host's IP over its public Esplora API (no self-hosted option
exists today, so Blockstream can link every derived address of every watch-only wallet an
install has ever had), and that `wallet_addresses.descriptor` is sealed only once an
operator's deployment threads a `SecretBox` into the composition root — until then a newly
linked wallet's descriptor is stored in the clear, unchanged from every release before this
one.

---

## 2. C-8's UI half — surface `investments.SecurityResolutionFailed`

**The default-rule-seeding decision, made and stated** (per `wp4.12b` §8.2's own framing —
"make the decision, state it"): **not built**. Every `notification_rules` row in this
application is user-created; there is no bootstrap/seeding path anywhere, and building one
is a cross-cutting concern (a bootstrap/seed change) outside every file this condition
grants. The render case alone — with no rule seeded — changes nothing for a fresh install.
So **the holdings-response `unresolved` field is the surface that actually satisfies the
condition's own words** ("a position the app could not identify is visible rather than
missing") with zero configuration; the render case is real, tested infrastructure for the
day a rule exists (by hand today, by a future seeding change tomorrow), stated as
insufficient alone rather than silently declared complete. Recorded in `render.ts`'s own
header, not just here.

**`packages/contexts/notifications/src/render.ts`**: a new
`case 'investments.SecurityResolutionFailed':`, added to `CONSUMED_EVENT_TYPES` (six
subscriptions now). Title "A position could not be identified", body names the provider and
the position's display name, `deepLink: '/investments'`. The dedupe key is
`(provider, providerSecurityId ?? name)` — **deliberately not** the event's own
`syncRunId`, because the upstream event's own doc says a later sync may fire the same
failure again for a still-unresolved position, and keying on the sync run would re-notify
every night.

**Sabotage, real source**: (1) added `syncRunId` into the dedupe key — the new
`'the resolution-failure dedupe key is the identity of the failure, not the sync run'` test
went red (two renders of the same still-unresolved position produced different keys);
restored. `pnpm exec vitest run --project notifications`: **26/26** before, **26/26** after
restore (`test/insight-subscription.test.ts` grew by two tests: the render case and the
dedupe-key proof, replacing the "five" pin with "six").
`DATABASE_URL=… pnpm exec vitest run --project notifications-db`: **18/18** (unchanged;
this condition touches no DB-backed notifications code).

**`apps/api/src/routes/investments.ts`**: `readUnresolvedSecurities(database, userId)`
reads `domain_events` directly (a `@core/platform` table, not `@ctx/investments`'s) for
`event_type = 'investments.SecurityResolutionFailed'`, deduped to the latest event per
`(provider, providerSecurityId ?? name)` (`DISTINCT ON`, coalescing the nullable
`providerSecurityId` so two different nameless failures from one provider do not collapse
into one), then excludes any whose identifiers now match a `security_identifiers` row for
the user (`identifierKeyOf`, already exported from `@ctx/investments`) — "still unresolved"
is checked against the _current_ securities master, not trusted from the event's mere
presence in an append-only log. `unresolved` added to both `GET /holdings` and
`GET /accounts/:accountId/holdings` responses; **user-wide on both**, stated in each route's
own description, because the event never carries an account id (`events.ts`'s own doc:
"what it does not carry: … any account id").

**Regression**: `apps/api/test/db/investments-routes.test.ts` (25/25) and the full
`api-db` project (303/303, one unrelated pre-existing perf flake — §7) re-run green with
the new field present, proving the reader executes correctly against real Postgres. **A
new sabotage-tested proof for this reader could not be added** — same `apps/api/test/db`
wall as §1.1 — recorded as an open item.

**`apps/web/src/features/investments/UnresolvedSecuritiesNotice.tsx`** (new): renders
nothing when `unresolved` is empty, otherwise a labelled list naming each unresolved
position and its provider. Wired into `InvestmentsScreen.tsx` (aggregated holdings) and
`AccountPositionsPanel.tsx` (per-account). `apps/web/e2e/support/mock-investments.ts` gained
`unresolved: []` on its four response builders — its absence crashed the panel outright
(`unresolved.length` on `undefined`) the first time the real Playwright suite ran against
it, a genuine defect this pass found and fixed, not merely a fixture gap.

**Sabotage, real source**: `unresolved.length === 0` replaced with `true` — both new
`InvestmentsScreen.test.tsx` tests (shows the notice; shows nothing when empty) went red as
expected on the "shows" case; restored. `pnpm --filter @app/web exec vitest run
src/features/networth src/features/investments`: **43/43** throughout.

---

## 3. C-9 — a missing FX rate on screen, the caption fix, the figure labels

**`apps/api/src/routes/net-worth.ts`**: `readLastSnapshotFxFailure(pool, userId)` reads
`jobs` (a `@core/platform` table) directly for the most recent
`kind = 'planning.net_worth_snapshot'` row and its `last_error` — `packages/platform/src/
jobs/runner.ts`'s `finish` already clears `last_error` to `NULL` on success and sets it on
every failed or still-retrying attempt, so this is the durable "did the last attempt fail,
and why" the condition asks for, without a second, driftable copy of the same fact inside
`@ctx/planning`. `GET /net-worth/series` gained `lastSnapshotFailure: SnapshotFxFailure |
null`. **08 §6.6's manual-entry affordance**: `POST /net-worth/fx-rates` (new,
`requireFreshSession` — the same one-way-door reasoning `POST /net-worth/corrections`
already carries: the very next snapshot retry can use this rate to recompute a total the
user will see change), upserting `fx_rates` with `source: 'user_override'` — already ranked
first by `drizzleFxStore`'s own read order, so writing this row is the entire fix; no change
to the read path was needed or made.

**Regression**: `apps/api/test/db/net-worth-routes.test.ts` (part of the 25-test
`investments-routes.test.ts`+`net-worth-routes.test.ts` pair, **25/25**) and the full
`api-db` project (303/303) re-run green with both additions present. **No new sabotage-
tested api-db proof for either function** — same `apps/api/test/db` wall as §§1.1, 2;
open item.

**`apps/web/src/features/networth/series.ts`**: new `missingCount(points)` — every day with
`netWorth === null`, not only `source === 'interpolated'`. The gate's own finding (G3-12:
"the full view's caption also claims every day has a value above four '—' days") was real:
`interpolatedCount` alone drove the caption, and a day with no row at all (`source: null`,
exactly the shape a failed snapshot leaves) was never counted. `NetWorthFullView.tsx`'s
caption now reads from `missingCount` for the "is anything missing" claim and
`interpolatedCount` separately for the "how many were interpolated" footnote — two
independent, honest claims instead of one that conflated them.

**Sabotage, real source**: `missingCount` body replaced with `return 0`. Two tests went red
— `series.test.ts`'s own `missingCount` proof, and `NetWorthFullView.test.tsx`'s "names a
genuinely missing day even when nothing is labelled interpolated" — the caption case the
gate finding was about. Restored.

**The manual-entry affordance on screen**: `SnapshotFxFailureBanner` (new, in
`NetWorthFullView.tsx`) shows the failed snapshot's own error message and an "Enter this
rate manually" button; `ManualFxRateForm` parses `base`/`quote`/`date` out of
`FxRateUnavailable`'s own message text (`fx.ts`'s exact wording — coupled by necessity,
since `serializeError` keeps only `name`/`message`/`code`, never structured fields) to
pre-fill the form, and calls `POST /net-worth/fx-rates` through the same `useStepUpRetry`
ceremony every fresh-session write in this app uses. **Sabotage, real source**: the render
condition `snapshotFailure !== null` wrapped in `false &&` — the new "surfaces a failed
snapshot's missing FX rate…" test went red; restored.

**The two net-worth figures' labels (G3-15)**: `NetWorthFullView.tsx` now opens with a
caption stating plainly that this is the _planning_ net worth (holdings × market price) and
that the Accounts screen's own figure is ledger balances only, "not meant to match". **This
is only half the fix.** The other half — the bare `label="Net worth"` on
`_app.index.tsx`'s `NetWorthHero` (planning-sourced) and on
`features/accounts/AccountsScreen.tsx`'s hero (ledger-sourced, two occurrences: the
per-currency case and the no-balance case) — is in files this condition does not grant.
Exact diffs in **§4**.

---

## 4. For the orchestrator

Every item below is a precise, minimal diff outside this work package's granted files.
None was applied.

1. **C-13's wiring, `apps/api/src/worker.ts:478`** (inside the `createWalletRpcRuntime({`
   call at line 475): add `secretBox,` after `etherscanApiKey: config.secrets
.etherscan_api_key,`. `secretBox` is already a non-null local by this point in
   `worker.ts` (checked and used two lines later for `createDomainRuntime` and
   `notificationChannels`) — a genuine one-liner.

2. **C-13's wiring, `apps/api/src/app.ts:449`** (the `createWalletRpcRuntime({` call) is
   **not** a one-liner: this runtime is built eagerly, before the app is unlocked
   (`security.requireSecretBox()` is called later, lazily, inside `deps.connections()`).
   Passing `secretBox` here needs either deferring this runtime's construction to
   first-request time (matching `connections()`'s own laziness) or threading a
   `() => SecretBox` thunk instead of a value and having `createWalletAddressStore` call
   it lazily per operation. Recorded as a real design question, not a one-liner.

3. **G3-15's other half, `apps/web/src/routes/_app.index.tsx:43`**: `NetWorthHero`'s
   `label="Net worth"` → `label="Net worth (planning)"` (or equivalent).
   **`apps/web/src/features/accounts/AccountsScreen.tsx:80-81` and `:90`**: the two
   `'Net worth'`/`` `Net worth (${total.currency})` `` labels → `'Net worth (ledger)'` /
   `` `Net worth (ledger, ${total.currency})` ``. Neither file is granted to this
   condition.

4. **C-16 O-3's remaining two specs.** `apps/web/e2e/market-data.spec.ts:13-18` and
   `apps/web/e2e/plan.spec.ts:19-24` each still hardcode
   `SCREENSHOT_DIR = fileURLToPath(new URL('../../../docs/evidence/phase-3/screenshots/',
import.meta.url))` (`market-data.spec.ts`) / `.../wp4.10-...` (`plan.spec.ts`) — the
   exact defect `apps/web/e2e/support/screenshot-dir.ts` (this work package's, §6) fixes
   for `investments.spec.ts`/`networth.spec.ts`. Swap for the `test.extend`+`evidenceDir`
   pattern those two files now use; `screenshotDir(evidenceDir)` is already exported and
   ready to import. Neither spec file is in this condition's granted "e2e specs" (they
   belong to WP 3.12/4.10's screens, not investments/networth).

---

## 5. C-15 — CoinGecko attribution logo, self-hosted

**Fetched successfully from this host** — real outbound network access exists in this
environment (confirmed with `curl` before assuming otherwise). CoinGecko's official brand
microsite, `brand.coingecko.com`, publishes three assets on its Logo page: a logotype, a
"Symbol" (icon-only mark), and a combination lockup. The Symbol image is hosted as a
1920×1080 auto-generated page-cover PNG (Gitbook's own cover-image convention for that
page), not a clean small icon — the brand kit's actual pristine SVG/PNG is a ZIP behind an
interactive JS download flow this host could not complete (the direct file paths on
`brand.coingecko.com` resolve to an HTML landing page, not the archive).

**What was built**: the Symbol cover image, downloaded, cropped to the circular gecko mark
(ImageMagick), alpha-masked to that same circle so it composites cleanly on any background,
and downsized to 64×64 — no colour, proportion, or content change from the source, only
isolation from its page-cover context. Committed at `apps/web/public/icons/
coingecko-symbol.png` (2.9 KB). `apps/web/src/features/market-data/Attribution.tsx` renders
it (14×14, `rounded-full`) in place of the generic `lucide-react` `Coins` glyph specifically
when `attribution.provider === 'coingecko'`; every other provider keeps the generic glyph.

**No CSP change**: served from this origin, so `img-src 'self'` (`docker/Caddyfile`'s
existing policy) already covers it — refuting the reason the generic glyph was used
originally (`gate-security-review.md` G3-8: "justified by a CSP reason that does not apply
to a self-hosted asset"). Not re-verified against a full `vite build` + `check-csp.ts` run
(time; the reasoning is airtight — same-origin static asset, zero new directives touched) —
flagged as an open item, low risk.

**A licence caveat, stated rather than hidden**: CoinGecko's Attribution Guide says "do not
modify or alter our logos." Cropping a graphic element out of a larger page layout without
touching its colour or shape is the ordinary, unremarkable case that clause is not aimed
at — but the alpha-masking step (erasing the cover image's background via a synthetically
drawn circle, not by reading the image's own edge) is a step beyond a pure crop. If this is
judged too close to "altering", the safe fallback is reverting `Attribution.tsx`'s one
conditional and deleting the PNG — recorded here precisely so that call can be made by a
human, not silently assumed.

`pnpm --filter @app/web exec vitest run src/features/investments src/features/market-data`:
**27/27** (no change in count — this condition swaps an icon, adds no new test; the
existing CoinGecko-attribution assertions in `InvestmentsScreen.test.tsx` re-run green
against the new logo unchanged, since they assert on `data-testid`/text, not the icon
itself).

---

## 6. C-16, O-3 — Playwright must not rewrite committed evidence screenshots

**The defect, reproduced**: `investments.spec.ts` and `networth.spec.ts` each hardcoded
`SCREENSHOT_DIR` at `docs/evidence/phase-3/screenshots/` — the committed evidence
directory — so an ordinary `playwright test`/`just verify` run overwrote committed PNGs in
place every time. The memory file's own account: "the orchestrator restored regenerated
wp3.11/wp3.12 screenshots three times this week."

**`apps/web/e2e/support/screenshot-dir.ts`** (new): `screenshotDir(evidenceDir)` defaults to
`apps/web/test-results/evidence-screenshots/` — already covered by the existing
`apps/web/test-results/` line in the root `.gitignore`, so **no new ignore entry was
needed**. `evidenceDir` names the real evidence directory for a deliberate regeneration.

**Reading `PLAYWRIGHT_EVIDENCE_DIR` could not happen inside `e2e/`** — the repo-wide
`process.env` ban (`docs/CONVENTIONS.md`) exempts `test/` and `playwright.config.ts`, not
`e2e/` (`cold-start.spec.ts`'s own header states the identical rule for
`COLD_START_BASE_URL`, confirmed by a real `eslint` error the first time this was tried
directly). **`apps/web/playwright.config.ts`** (granted for this condition) now reads the
variable and hands it down as a new `evidenceDir` test option on the `chromium` project,
the same `test.extend`-plus-config-option pattern `coldStart` already uses.
`investments.spec.ts`/`networth.spec.ts` were converted to `base.extend<EvidenceDirOptions>`
and their `shoot()` helpers now take `evidenceDir` from the test fixture rather than a
module-level constant.

**Proven on the real suite, not just reasoned about**: `pnpm exec playwright test
e2e/networth.spec.ts e2e/investments.spec.ts --project chromium` — **14/14 passed**, 16
screenshots written to `apps/web/test-results/evidence-screenshots/`, `git status --short
docs/evidence/phase-3/screenshots/` **clean before and after**. Re-run with
`PLAYWRIGHT_EVIDENCE_DIR=/tmp/pf-evidence-check` (a scratch directory, not the real one, to
avoid touching committed files as a side effect of proving the override) — the four
`wp3.12-*.png` files landed there instead, confirming the override path works. (An earlier
attempt at this same full run hit `net::ERR_CONNECTION_REFUSED` against the dev server
twice — environmental flakiness in a shared, multi-agent tree, not a defect in this fix;
the third attempt, and every attempt at the filtered override run, was clean.)

`apps/web/e2e/support/mock-investments.ts`'s `unresolved: []` fix (§2) was found _during_
this same Playwright run — the first full run crashed four investments tests with
`getByTestId('position-VTI')` never appearing, traced to `UnresolvedSecuritiesNotice`
throwing on `undefined.length` against the un-updated mock fixture.

---

## 7. Verification

- `pnpm exec tsc -b --noEmit`: clean except `e2e/debug-drag.spec.ts` (untracked, not
  created by this work package — a concurrent agent's in-progress file, confirmed via
  `git status` showing it as `??` and unrelated to any file this condition touches).
- `pnpm exec eslint` on every touched file: clean.
- `pnpm exec prettier --write` on every touched file including `.json`: applied.
- `node scripts/check-numeric-boundaries.ts`: PASS, 780 files, 0 violations.
- `pnpm run lint:schema-ownership`: ok, 103 tables claimed, 90 defined.
- `pnpm --filter @app/web exec tsc -b --noEmit`: clean (same one exclusion).
- `pnpm --filter @app/web exec vitest run src/features/networth src/features/investments`:
  **43/43**.
- `cd apps/web && pnpm exec playwright test e2e/networth.spec.ts e2e/investments.spec.ts
--project chromium`: **14/14**.
- `DATABASE_URL=… pnpm exec vitest run --project investments-db`: **43/43** (7 files).
- `DATABASE_URL=… pnpm exec vitest run --project notifications`: **26/26**.
- `DATABASE_URL=… pnpm exec vitest run --project notifications-db`: **18/18** (6 files).
- `DATABASE_URL=… pnpm exec vitest run --project db`: **10/10** (migration runner + the
  0027 attribution below).
- `DATABASE_URL=… pnpm exec vitest run --project api-db`: **303 passed, 4 skipped, 1
  failed** — `test/db/projection-perf.test.ts`'s whole-path Monte Carlo p95 (806.9 ms vs
  an 800 ms budget), a WP 4.6/4.13 performance test this work package does not own or
  touch, under a 377-second full run in a shared, multi-agent tree. Consistent with the
  project's own documented pattern ("a `just check` red that passes alone is usually a
  timing flake under parallel load, not a defect") rather than anything this pass
  introduced.
- `packages/db/test/migrate.test.ts`: the 0027 attribution added (§ comment block before
  the table-list assertion); no table added, so the assertion itself is unchanged.

**Every sabotage in this document was real-source (never assertion-only), observed red,
and restored** — confirmed after each restore with a green re-run of the affected suite;
`git status --short packages/db/migrations/0027_wallet_addresses_seal_descriptor.sql`
shows no diff against a clean checkout of this work package's own commit (the migration is
new in this pass, so "restored" means the CHECK's sabotaged body was put back to its
original text, verified by re-reading the file).

`git diff --cached --name-only`: empty (checked before this report).

---

## 8. Open items, carried rather than silently closed

1. **C-13's full cryptographic custody proof** (§1.1) and **C-13's composition-root
   wiring** (§4 items 1–2) — both outside this work package's granted files.
2. **C-8's route-level sabotage proof** and **C-9's route-level sabotage proof** for
   `readUnresolvedSecurities`/`readLastSnapshotFxFailure`/`setManualFxRate` — `apps/api/
test/db` is not granted; regression-verified via the existing suites instead (§§2, 3).
3. **G3-15's other two labels** (`_app.index.tsx`, `AccountsScreen.tsx`) — §4 item 3.
4. **C-16 O-3's remaining two specs** (`market-data.spec.ts`, `plan.spec.ts`) — §4 item 4.
5. **C-15's CSP posture** not re-verified against a full production build + `check-csp.ts`
   (§5) — low risk, reasoned rather than proven.
6. **C-13's re-link path** for the rewritten `write()` (§1.1) — traced by hand, not
   exercised by any test this work package could run or write.
