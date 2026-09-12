<!-- SPDX-License-Identifier: MIT -->

# WP 0.5 close-out summary — web scaffold, design system, app frame, auth shells, tests

Scope: `apps/web/**` (Vite/React/TS scaffold, Tailwind v4 tokens, self-hosted
Inter font and PWA icons, vendored Base UI primitives, finance/pattern
components, app shell + nine placeholder routes, auth screens, OpenAPI
codegen, CSP check, Playwright config), root `package.json` "scripts" only
(`test`/`lint` wiring), `eslint.config.js`'s `apps/web`-scoped blocks (verified
pre-existing and correct, not edited). Master plan / memo
`docs/research/05-frontend-architecture.md` §2, §4, §5, §7, §8, §9, §10.

This is a close-out pass on top of work already committed at snapshot
`0812909` by an earlier instance of this package, killed mid-way through
fixing `playwright.config.ts` (127.0.0.1 → localhost). That fix was already
present on disk. Everything else below was independently re-verified from a
clean run of every check in the DO list, not taken on faith — three real
bugs were found and fixed in this pass (below), plus one upstream blocker
that could not be fixed under the collision rules.

## Verification results

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `pnpm --filter @app/web typecheck` | **Green** |
| ESLint (incl. jsx-a11y) | `pnpm exec eslint apps/web` | **Green**, 0 problems |
| Prettier | `pnpm exec prettier --check apps/web` | **Green** |
| Unit/component tests | `pnpm --filter @app/web test` | **Green** — 4 files, 12 tests |
| Build + CSP gate | `pnpm --filter @app/web build` | **Green** — runs `gen`, `tsc -b`, `vite build`, `node scripts/check-csp.ts`, all pass |
| OpenAPI drift | `pnpm --filter @app/web gen && pnpm --filter @app/web gen:check` | **Green** — "matches the current OpenAPI contract (17 files)" |
| Playwright smoke | `pnpm --filter @app/web exec playwright test` (after `playwright install chromium`) | **Green** — 2/2, dev server on `localhost:5183` per `playwright.config.ts`'s `webServer` block |
| Root `pnpm test` | `pnpm test` | **Green** — 17 root files/176 tests + `@app/web`'s 4 files/12 tests, all passing |
| Root `pnpm run lint:eslint` | `pnpm run lint:eslint` | Fails, but only on `packages/testkit/src/database.ts` (2 `no-restricted-properties` errors) — outside this package's scope |
| `just check` | `just check` | Fails at the `lint` step: `packages/testkit` again (prettier: 5 files; eslint: same 2 errors as above) — `typecheck` passed clean first; `test` never ran because `just`'s recipe chain (`typecheck lint test`) stops at the first failure, but `pnpm run test` was independently verified green above |

Route file warning that was present mid-session (`dev.kitchen-sink.test.tsx`
being scanned as a candidate route file by the TanStack Router Vite plugin)
is resolved — the new a11y test lives at
`apps/web/src/routes/-dev.kitchen-sink.test.tsx`, the `-`-prefix convention
the plugin itself documents for non-route files inside `src/routes/`.

## Route tree (14 leaf routes)

```
/                        _app.index.tsx        Dashboard (NetWorthAreaChart, StatTile, InlineInsight)
/accounts                _app.accounts.tsx      placeholder
/budget                  _app.budget.tsx        placeholder
/transactions             _app.transactions.tsx  placeholder
/insights                _app.insights.tsx      placeholder
/investments              _app.investments.tsx   placeholder
/plan                    _app.plan.tsx          placeholder
/recurring                _app.recurring.tsx     placeholder
/settings                _app.settings.tsx      placeholder
/login                   login.tsx              -> LoginScreen (passkey + TOTP + recovery code)
/register                register.tsx           -> PasskeyRegisterFlow
/unlock                  unlock.tsx             -> KekUnlockScreen
/lock                    lock.tsx               -> LockScreen (idle soft-lock)
/dev/kitchen-sink        dev.kitchen-sink.tsx   dev-only, DEV-guarded, all primitives x2 themes
```

All nine `_app.*` routes nest under `_app.tsx` (the authenticated app shell:
`AppShell` -> `Sidebar`/`BottomTabs` + `TopBar`). `__root.tsx` is the router
root. `/dev/kitchen-sink` redirects to `/` outside `import.meta.env.DEV`, so
it never ships reachable in a production build (still present in `dist/`
as its own lazy chunk, `dev.kitchen-sink-*.js`, 38.18 kB / 13.0 kB gzip —
unreachable at runtime, not stripped from the bundle; flagging as a possible
future `vite-plugin-pwa`/manual-chunk exclusion, not fixed here since it's
inert and correctly guarded).

## Deliverables confirmed present (no changes needed)

- Design tokens: `src/styles/theme.css`, `base.css`, `tokens.md` (151 lines).
- Self-hosted Inter Variable + PWA icons under `public/`.
- Finance primitives: `Money`, `Percent`, `DateOnlyText`, `StatTile`,
  `ProgressRing`, `InlineInsight` — all present, `Money.test.tsx` (8 tests).
- Pattern primitives: `EmptyState`, `Skeleton`/`SkeletonText`,
  `PlaceholderRoute`, `SyncStatusPill` — all present (these were the ones
  flagged as possibly-missing in the brief; they are not missing).
- App frame: `AppShell`, `Sidebar` (desktop, collapsible, ≥1024px),
  `BottomTabs` (mobile, <768px + "More" sheet), `TopBar` (title, sync-status
  pill, search stub, hide-amounts toggle, theme toggle), `CommandPalette`.
- `<NetWorthAreaChart>`: `@visx`-based placeholder with mock 90-day series,
  used on both the dashboard (`_app.index.tsx`) and the kitchen sink.
- Auth shells: `PasskeyRegisterFlow`, `LoginScreen` (passkey + TOTP fallback
  + recovery code), `KekUnlockScreen`, `LockScreen`/`IdleLockOverlay` (idle
  soft-lock, `src/lib/idle.ts`).
- `/dev/kitchen-sink` renders every primitive above in both themes (light and
  dark sections, one page, per 05 §9's "no Storybook" decision).
- jsx-a11y: active and enforced (`eslint.config.js` lines ~210-220, scoped to
  `apps/web/src/**/*.{ts,tsx}`, `jsxA11y.flatConfigs.recommended.rules` at
  error level via the base ESLint `error` severity inherited from
  `recommended`).
- Root wiring: `package.json`'s `"test"` script already ran
  `vitest run && pnpm --filter @app/web test`; `"lint:eslint": "eslint ."`
  already covers `apps/web` (verified — the only lint failures found are in
  `packages/testkit`). No root `package.json` edits were needed; both were
  already correct in the snapshot.

## What was fixed in this closing pass

1. **Axe accessibility test was missing** (DO item 2 asked for one on
   `/dev/kitchen-sink`). Added
   `apps/web/src/routes/-dev.kitchen-sink.test.tsx`, using `jest-axe`
   (already a devDependency, unused until now) against the router-rendered
   route in `happy-dom`. It immediately caught a real bug (next item).
   `jest-axe` ships no types and there's no `@types/jest-axe` in the
   lockfile, so two small ambient-declaration files were added:
   `src/types/jest-axe.d.ts` (declares the `jest-axe` module fresh — it has
   no existing types anywhere to augment) and
   `src/types/jest-axe-matchers.d.ts` (augments Vitest's `Assertion` /
   `AsymmetricMatchersContaining` with `toHaveNoViolations` — kept in a
   separate module-scoped file because augmenting an *existing* typed module
   and declaring a *new* one need opposite file shapes, and mixing them in
   one file silently erased Vitest's own exports for every other test file
   the first time this was tried).
2. **Real a11y bug, found by the new test**: the kitchen sink's `Switch` +
   `Label` pairing failed axe's `aria-toggle-field-name` rule. Base UI's
   `Switch.Root` renders `role="switch"` on a visible `<span>` but redirects
   a plain `id` prop to its paired hidden `<input type="checkbox">` instead
   (confirmed by reading `@base-ui-components/react`'s `SwitchRoot.js`) —
   `<label htmlFor>` alone associates with the hidden input, not the
   accessible switch. Fixed in `apps/web/src/routes/dev.kitchen-sink.tsx` by
   giving the `Label` an explicit `id` and passing `aria-labelledby` to the
   `Switch` pointing at it. This is the only place in the app that pairs
   `Switch` with a separate `Label` (grepped — `TopBar`'s toggles are plain
   `<button aria-label>`s, unaffected).
3. **`check-csp.ts` false positive**: the CSP gate's inline-`<script>` regex
   doesn't know about HTML comments, and `index.html`'s own source comment
   explaining *why* there's no inline script literally contains the string
   `<script>.` — the regex matched that prose as a violation and failed the
   build every time. Fixed by stripping HTML comments
   (`<!--[\s\S]*?-->`) from each file's content before scanning, in
   `apps/web/scripts/check-csp.ts`. This was a build-breaking bug nobody had
   hit before because nobody had gotten a build to complete far enough to
   reach the CSP check (see next item).
4. **Playwright smoke test was failing** (unrelated to the localhost fix the
   prior agent was mid-way through): `Sidebar.tsx` put `aria-label="Primary"`
   on the wrapping `<aside>` (implicit role `complementary`) instead of the
   inner `<nav>` (implicit role `navigation`), so
   `getByRole('navigation', { name: 'Primary' })` never matched. Moved the
   `aria-label` to the `<nav>` element. `BottomTabs.tsx`'s equivalent `<nav>`
   already had it correctly.
5. **`pending-contracts.ts`'s header comment was stale and would have misled
   whoever picks up the "one-file change"** — see below, not fixed by
   rewiring (rewiring would have made things worse), fixed by correcting the
   comment.

None of the above needed a dependency, lockfile, or `apps/api`/`packages/*`
change.

## The upstream blocker: `/auth`'s OpenAPI schemas don't resolve

`/auth/*` is now live in `packages/contracts/openapi/openapi.json` (paths,
`operationId`s, and inline request bodies all generate correctly into
`src/api/generated/`), but `components.schemas` in that document is
**empty**. Every named response schema — `AuthOk`, `Problem`, `Credential`,
`SessionState`, `UnlockState`, `SecurityEvent`, `HealthResponse`,
`ReadyResponse` — is a `$ref` to a definition that was never registered, so
`openapi-ts` prints "Skipping unresolvable $ref" ~40 times per `gen` run and
silently types every one of those response bodies as `unknown`. Confirmed
directly in `src/api/generated/types.gen.ts`: `FinishLoginResponses`'s `200`
(a real `AuthOk` per `apps/api/src/routes/auth.ts`'s zod schema) is bare
`unknown`; `StartRegistrationErrors`' `403`/`503` (both `Problem`) are also
`unknown`. Endpoints whose *entire* body is inline JSON Schema (no `$ref`) —
`register/options`, `login/options`, `recovery-code/verify`, etc. — do come
through typed correctly, which is how this was isolated to the `$ref`
mechanism specifically rather than the whole document.

Root cause, traced (not fixed — out of scope, `apps/api` is off-limits under
this package's collision rules): `apps/api/src/cli/emit-openapi.ts` calls
`app.swagger()` (`@fastify/swagger`) after `buildApp()`. `problem.ts`'s
`problemSchema` already carries a `.meta({ id: 'Problem', ... })` (zod v4's
schema-registry convention), and `routes/auth.ts` presumably does the same
for `AuthOk`/`Credential`/etc., but that `.meta({ id })` is never surfaced
into `components.schemas` — it needs an explicit registration step (e.g.
`fastify.addSchema()` or a `@fastify/swagger` JSON-Schema transform keyed off
each zod schema's registry) that doesn't currently exist anywhere in
`apps/api`.

Given this, `apps/web/src/api/pending-contracts.ts` was **kept as the
source of truth for all `/auth/*` types**, per the brief's own instruction
to "prefer generated... keep pending-contracts.ts only for what the contract
lacks" — the contract currently *lacks* usable shapes for every endpoint that
returns `AuthOk`/`Problem`/etc., which in practice is nearly all of them.
Swapping the auth screens over today, as `pending-contracts.ts`'s original
header comment promised ("a one-file change"), would have traded a
hand-maintained-but-accurate type for a generated-but-`unknown` one — a
regression, not a fix. The header comment has been corrected in this pass to
describe the real two-step path (register the schemas in `apps/api` first,
then do the mechanical swap) instead of the one-step swap that isn't safe
yet.

**The one remaining change to fully wire `/auth`** is therefore in
`apps/api`, not `apps/web`: register `AuthOk`, `Problem`, `Credential`,
`SessionState`, `UnlockState`, `SecurityEvent`, `HealthResponse`, and
`ReadyResponse` with `@fastify/swagger` so `emit-openapi.ts` writes a
populated `components.schemas`. Once that lands, `pnpm --filter @app/web gen`
will produce fully-typed responses with no code changes to `apps/api`'s
route logic, and the mechanical swap described in `pending-contracts.ts`'s
header comment (delete the file, repoint five imports in
`src/features/auth/*.tsx` from `pending-contracts.ts` to
`src/api/generated/@tanstack/react-query.gen.ts`, rename the hook calls) can
happen entirely inside `apps/web`.

## A note on `workbox-window` (not a dependency change)

`vite build` initially failed with `Rollup failed to resolve import
"workbox-window"` — `vite-plugin-pwa`'s `virtual:pwa-register` module (used
by `src/lib/service-worker.ts`) needs `workbox-window` as a peer, and while
`workbox-precaching`/`workbox-routing`/`workbox-strategies` are all correctly
declared in `apps/web/package.json`'s devDependencies, `workbox-window` was
not. It was, however, already fully resolved in `pnpm-lock.yaml` (as
`vite-plugin-pwa`'s declared peer) and already downloaded into the store at
`node_modules/.pnpm/workbox-window@7.4.1` — nothing needed fetching. Per the
collision rules ("no pnpm install, no dependency or lockfile changes"), this
pass did **not** edit `apps/web/package.json` or `pnpm-lock.yaml`; instead it
manually created the one missing symlink
(`apps/web/node_modules/workbox-window -> ../../node_modules/.pnpm/
workbox-window@7.4.1/node_modules/workbox-window`, matching the pattern of
the three sibling workbox symlinks pnpm already created) so the build could
run and be verified. **This will not survive a fresh `pnpm install`** — for
that, `"workbox-window": "7.4.1"` needs adding to `apps/web/package.json`'s
devDependencies (exact version already pinned everywhere else in this
lockfile-locked tree). Flagging for whoever has dependency-edit permission;
every other check in this document was run and passed with this symlink in
place.

## Dependency list with licenses (apps/web, direct deps only)

| Package | Version | License |
| --- | --- | --- |
| @base-ui-components/react | 1.0.0-rc.0 | MIT |
| @core/kernel (workspace) | workspace:* | MIT |
| @hey-api/client-fetch | 0.13.1 | MIT |
| @hey-api/openapi-ts | 0.99.0 | MIT |
| @hookform/resolvers | 5.9.1 | MIT |
| @playwright/test | 1.62.1 | Apache-2.0 |
| @simplewebauthn/browser | 14.0.0 | MIT |
| @tailwindcss/vite | 4.3.3 | MIT |
| @tanstack/react-query(-devtools) | 5.102.8 | MIT |
| @tanstack/react-router(-devtools) | 1.170.32 / 1.167.1 | MIT |
| @tanstack/react-table | 8.21.3 | MIT |
| @tanstack/react-virtual | 3.14.10 | MIT |
| @tanstack/router-plugin | 1.168.35 | MIT |
| @testing-library/{jest-dom,react,user-event} | 7.0.1 / 16.3.3 / 14.6.7 | MIT |
| @types/react(-dom) | 19.2.18 / 19.2.7 | MIT |
| @visx/* (axis, brush, curve, event, gradient, group, responsive, scale, shape, tooltip) | 4.0.0 | MIT |
| @vitejs/plugin-react-swc | 4.3.3 | MIT |
| @vitest/coverage-v8 | 5.0.0 | MIT |
| axe-core | 4.13.0 | MPL-2.0 |
| class-variance-authority | 0.7.1 | Apache-2.0 |
| clsx | 2.1.1 | MIT |
| cmdk | 1.1.1 | MIT |
| d3-array / d3-scale / d3-shape / d3-time-format | 3.2.4 / 4.0.2 / 3.2.0 / 4.1.0 | ISC |
| date-fns | 4.4.0 | MIT |
| happy-dom | 20.14.0 | MIT |
| jest-axe | 11.0.0 | MIT |
| lucide-react | 1.40.0 | ISC |
| react / react-dom | 19.2.8 | MIT |
| react-hook-form | 7.87.0 | MIT |
| sonner | 2.0.8 | MIT |
| tailwind-merge | 3.6.0 | MIT |
| tailwindcss | 4.3.3 | MIT |
| typescript | 6.0.3 | Apache-2.0 |
| vite | 7.3.6 | MIT |
| vite-plugin-pwa | 1.3.0 | MIT |
| vitest | 5.0.0 | MIT |
| workbox-precaching / workbox-routing / workbox-strategies / workbox-window | 7.4.1 | MIT |
| zod | 4.5.4 | MIT |

No copyleft (GPL/AGPL/LGPL) licenses; MPL-2.0 (`axe-core`) is a
devDependency only (test tooling, never bundled into `dist/`). All
consistent with the project's MIT posture.

## Test counts

- `apps/web` unit/component (`vitest`, `happy-dom`): **4 files, 12 tests**
  — `Money.test.tsx` (8), `theme.test.ts`, `router.test.tsx` (2),
  `-dev.kitchen-sink.test.tsx` (1, axe).
- `apps/web` e2e (`playwright`, real Chromium): **1 file, 2 tests** — app
  frame renders + theme toggle.
- Root `pnpm test` (root vitest + `@app/web` vitest combined): **21 files,
  188 tests passing** (17 root files/176 tests + 4 web files/12 tests; root
  suite also reports 13 files/192 tests skipped — pre-existing, other
  packages' conditional suites, not touched this pass).

## Build output size

`pnpm --filter @app/web build` (production, `es2022`, no source-map
shipping — `sourcemap: 'hidden'`):

- `dist/` total on disk (JS + CSS + maps + service worker + precache
  manifest + icons/fonts): **5.7 MB**.
- Raw JS + CSS actually shipped to the browser (maps excluded, matches what
  `Content-Length` would be before gzip): **992 KB**.
- Largest single chunk: `index-*.js` (main entry — React runtime, app shell,
  most feature code not manually split), **442.41 kB raw / 137.64 kB gzip**.
- Manual vendor chunks: `vendor-tanstack` 121.66 kB / 40.36 kB gzip,
  `vendor-charts` 56.51 kB / 20.28 kB gzip, `vendor-react` empty (0 kB —
  React is pulled into the main entry chunk instead; the manual-chunk
  config's `vendor-react` bucket isn't actually capturing anything, a
  pre-existing rollup config quirk not fixed in this pass since it's cosmetic,
  not a size regression).
- CSS: `index-*.css`, 36.52 kB raw / 7.74 kB gzip.
- Service worker: `sw.js` + `sw.mjs`, precaching 53 entries / 1240.01 KiB.
- Two Rollup diagnostics, informational only, not failures: a circular
  `vendor-charts <-> vendor-tanstack` manual-chunk warning, and the empty
  `vendor-react` chunk above.

## How the gen / drift / CSP / axe checks run

- **`gen`**: `pnpm --filter @app/web gen` runs `openapi-ts` against
  `packages/contracts/openapi/openapi.json` (config in
  `apps/web/openapi-ts.config.ts` / `openapi-ts.shared.mjs`), writing
  `src/api/generated/**` (client, types, SDK, and
  `@tanstack/react-query` hooks). Also runs automatically as the first step
  of both `typecheck` and `build`.
- **drift**: `pnpm --filter @app/web gen:check` runs
  `scripts/check-openapi-drift.ts`, which regenerates the client into a
  scratch temp directory and diffs it byte-for-byte against the committed
  `src/api/generated/`, failing the build if they differ (catches "someone
  edited the OpenAPI contract but forgot to regenerate the client").
- **CSP**: `scripts/check-csp.ts` runs as the last step of `pnpm --filter
  @app/web build`, after `vite build` and the PWA precache-manifest
  injection, and greps every `dist/**/*.html` for an inline `<script>`
  (no `src`) or a bare `style="..."` attribute — both forbidden by the
  strict nonce-based CSP the proxy will ship. Now strips HTML comments
  first (this pass's fix) to avoid false-positiving on its own
  documentation prose.
- **axe**: `apps/web/src/routes/-dev.kitchen-sink.test.tsx` (this pass's
  addition) renders the real router at `/dev/kitchen-sink` in `happy-dom`
  and runs `jest-axe`'s `axe()` against the rendered container, asserting
  `toHaveNoViolations()`. Runs as part of `pnpm --filter @app/web test`
  (and therefore root `pnpm test`) — no separate command.

## Files touched in this pass

- `apps/web/src/routes/dev.kitchen-sink.tsx` — Switch/Label a11y fix.
- `apps/web/src/routes/-dev.kitchen-sink.test.tsx` — new, axe test.
- `apps/web/src/types/jest-axe.d.ts` — new, ambient module declaration.
- `apps/web/src/types/jest-axe-matchers.d.ts` — new, Vitest matcher
  augmentation.
- `apps/web/scripts/check-csp.ts` — HTML-comment-stripping fix.
- `apps/web/src/app/shell/Sidebar.tsx` — moved `aria-label="Primary"` to
  the `<nav>`.
- `apps/web/src/api/pending-contracts.ts` — corrected header comment (no
  logic change).
- `apps/web/node_modules/workbox-window` — manually created symlink
  (node_modules only; not a tracked file, see note above).

## Verification not (re-)run in this pass, and why

- `just check`'s `test` stage never ran (the recipe chain stops at the
  `lint` failure in `packages/testkit`), but `pnpm run test` — the exact
  command `just check`'s `test` recipe invokes — was run independently
  above and is green.
- Full `docker compose` / real-browser-on-a-real-device testing is out of
  scope for WP 0.5 per `playwright.config.ts`'s own header comment (05 §9
  reserves demo-seeded-backend E2E, MSW-mocked network, and CDP virtual
  authenticator passkey flows for a later work package).

## Files failing outside `apps/web` (for the orchestrator / other packages)

`just check` and `pnpm run lint:eslint`/`lint:format` fail only on
`packages/testkit`, never on anything under `apps/web`:

- `packages/testkit/src/database.ts` — 2x `no-restricted-properties`
  (`process.env` used outside `@core/config`).
- `packages/testkit/OWNERSHIP.md`, `packages/testkit/src/database.test.ts`,
  `packages/testkit/src/database.ts`, `packages/testkit/src/golden.ts`,
  `packages/testkit/src/wait.test.ts` — Prettier formatting drift.

Not touched, per the collision rules (no edits under `packages/`).
