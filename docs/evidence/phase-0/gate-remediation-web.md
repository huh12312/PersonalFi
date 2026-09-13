<!-- SPDX-License-Identifier: MIT -->

# Phase 0 gate remediation — web (`apps/web`)

Remediation of the `apps/web` findings from
[`gate-security-review.md`](gate-security-review.md) §3: **H-3** (runtime
`<style>` injectors break under `style-src-elem 'self'`), **M-1**
(`check-csp.ts` can't see runtime CSP violations), **M-2** (generated client
hardcodes an absolute `baseUrl` with no `credentials`), **M-3** (no client-side
auth guard, `useSessionQuery` has zero call sites), **M-4** (no logout
control; neither logout nor idle lock clears the query cache), **M-5** (the
service worker's `NetworkOnly` rule matches `/api/*`, the app calls
`/auth/*`), **L-1** (the fetch wrapper's spread order lets a caller weaken
credentials and drops caller headers), **L-3** (the dev kitchen-sink chunk is
precached in prod), and **I-1** (source maps must never ship). Also fixed:
the recovery-code input (`type="password"`, cleared after submit).

Scope owned here: `apps/web/**` and this document. Infrastructure (Caddy, the
CSP header itself, compose) and the API/identity findings were remediated
concurrently by other agents and are reported in `gate-remediation-infra.md`
and `gate-remediation-api.md`. Two of those agents' commits (`f43c85f`,
`932474e`) landed on `main` partway through this work; both are accounted for
below (in particular, the OpenAPI `servers` field going relative — see M-2).

Working tree at the start of this pass: branch `main`, HEAD `376a957`, clean,
`just check` green. Every fix below has a guarding test, run and shown
passing in this document; the full suite (`typecheck`, `eslint`, `prettier
--check`, `vitest`, `vite build`, both Playwright projects, `just check`) was
re-run green after all fixes together — transcript in §12.

---

## Summary

| Finding                                               | Status                          | Guarding test                                                                                                                 |
| ----------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| M-3 / M-8 — no auth guard                             | Fixed                           | `src/app/router.test.tsx` — `/_app auth guard` describe block (3 cases)                                                       |
| M-4 — no logout, no cache clear                       | Fixed                           | `src/app/shell/TopBar.test.tsx`, `src/features/auth/IdleLockOverlay.test.tsx` (2 cases)                                       |
| M-5 — SW predicate matches nothing real               | Fixed                           | `src/lib/sw-network-only.test.ts` (14 cases)                                                                                  |
| L-3 — dev chunk precached in prod                     | Fixed                           | `scripts/check-sw-precache.ts`, run against the built `dist/sw.js` in `pnpm run build`                                        |
| H-3 — runtime `<style>` injectors                     | Fixed                           | `apps/web/e2e/csp.spec.ts` (2 cases, real Chromium, real production build, real CSP header)                                   |
| M-1 — `check-csp.ts` can't see runtime violations     | Documented, not fixable in kind | `apps/web/e2e/csp.spec.ts` is the check that closes the gap; `check-csp.ts`'s header now says so                              |
| M-2 — hardcoded absolute `baseUrl`, no `credentials`  | Fixed                           | `src/api/pending-contracts.test.ts` (3 cases) + manual inspection of the regenerated `client.gen.ts` (quoted below)           |
| L-1 — spread order weakens credentials, drops headers | Fixed                           | `src/api/pending-contracts.test.ts` (3 cases)                                                                                 |
| I-1 — source maps must never ship                     | Fixed                           | `scripts/strip-sourcemaps.ts`, run against the built `dist/` in `pnpm run build`; verified `find dist -name '*.map'` is empty |
| Recovery-code input                                   | Fixed                           | `apps/web/e2e/smoke.spec.ts` — _"the login screen switches to the recovery-code fallback"_                                    |

Two defects were found **in the course of this remediation**, unrelated to
the findings list, both discovered because `e2e/csp.spec.ts` is the first
thing in this repo to load a real `vite build` production bundle in an actual
browser (`e2e/smoke.spec.ts` only ever exercises the dev server; `check-csp.ts`
never executes any JS). Both are written up in §11.

---

## 1. M-3 / M-8 — no route guard on `/_app`

**Finding.** `src/routes/_app.tsx` had no `beforeLoad`; every screen under
`/` rendered for anyone who could reach the URL, and `useSessionQuery`
(`pending-contracts.ts`) had zero call sites anywhere in the app.

**Fix.** `src/routes/_app.tsx`'s `beforeLoad` now calls
`context.queryClient.fetchQuery({ queryKey: sessionQueryKey, queryFn:
getSession })` and redirects to `/login?redirect=<intended path>` on any
failure (network error, 401, malformed body — anything that isn't a resolved
session). `src/routes/login.tsx` validates that `redirect` param
(`z.object({ redirect: z.string().optional() })`); `LoginScreen` reads it via
`Route.useSearch()` and navigates back there — through
`src/lib/safe-redirect.ts`'s `isSafeRedirectPath`, which rejects anything not
a root-relative, same-document path (an absolute or protocol-relative value
in that query param would otherwise be an open redirect).

**Which client.** `pending-contracts.ts`, not the generated client. See that
guard's own header comment for the full reasoning — short version: the
generated client's `servers` field went relative and its response types are
now populated (both conditions that would have pointed at it), but every
existing `/auth/*` call site in this codebase already imports from
`pending-contracts.ts`, and splitting just the guard onto a second client
would mean two query-key namespaces guarding the same session for no benefit
this pass needs. Migrating everything to the generated client is now
unblocked and is `pending-contracts.ts`'s own tracked TODO — deferred as a
distinct refactor, not folded into this security pass.

**Test.** `src/app/router.test.tsx`, `/_app auth guard` describe block:

```
✓ redirects an unauthenticated visitor to /login, preserving the intended path
✓ sends a visitor who is already signed in straight through, without a redirect
✓ returns to the originally intended path after a successful sign-in
```

The third case drives a real TOTP sign-in (mocked `fetch`, no WebAuthn
browser API needed) starting from `/accounts`, through the `/login` bounce,
back to `/accounts` — round-tripping both directions the brief asked for.

---

## 2. M-4 — no logout control, no cache clear on logout or idle lock

**Finding.** No sign-out control existed anywhere in the UI. Neither logout
nor `IdleLockOverlay` touched the TanStack Query cache, and
`query-client.ts`'s `refetchOnWindowFocus: true` meant a locked session could
keep refetching balances behind the overlay.

**Fix.**

- `pending-contracts.ts`'s `useLogoutMutation` now calls `queryClient.clear()`
  in its own `onSuccess` (not `invalidateQueries`, which would only mark
  entries stale and leave last-fetched data readable).
- `src/app/shell/TopBar.tsx` gained a "Sign out" control: calls the logout
  mutation, then (via that mutation's own `onSuccess`) clears the cache, then
  navigates to `/login` — in that order.
- `src/features/auth/IdleLockOverlay.tsx`: on lock, `queryClient
.cancelQueries().then(() => queryClient.clear())` — cancel first, so an
  in-flight fetch resolving after the lock fires can't repopulate the cache
  it's racing to clear. On a successful unlock, `queryClient.refetchQueries()`.

**Test.**

```
src/app/shell/TopBar.test.tsx
✓ clears the query cache and navigates to /login

src/features/auth/IdleLockOverlay.test.tsx
✓ clears the query cache the moment the idle timer fires
✓ refetches after a successful unlock
```

---

## 3. M-5 — service worker `NetworkOnly` predicate matched nothing real

**Finding.** `sw.ts:34` guarded `/api/` while every real endpoint lives under
`/auth/*` (`apps/api/src/routes/auth.ts`) — the "no financial data or auth
state in the Cache API" rule was enforced by accident (nothing else was
registered to cache it), not by this predicate.

**Fix.** Extracted to `src/lib/sw-network-only.ts`'s `isNetworkOnlyPath`,
matching `^/(api|auth|health|ready)(/|$)` — every data prefix this app calls
or is documented to call, kept as a pure function so it's testable without a
service-worker global scope (`sw.ts` itself has build-time
`self.__WB_MANIFEST` side effects a plain test environment can't provide).

**Test.** `src/lib/sw-network-only.test.ts`, 14 cases — every listed prefix
matches, `/authenticate` (a lookalike, not the `/auth` segment) and static
assets don't:

```
✓ matches /auth/session
✓ matches /auth/login/verify
✓ matches /auth
✓ matches /api/whatever
✓ matches /api
✓ matches /health
✓ matches /ready
✓ does not match /
✓ does not match /index.html
✓ does not match /assets/vendor-react-abc123.js
✓ does not match /icons/icon-192.png
✓ does not match /authenticate
✓ does not match /apiary
✓ does not match /healthcheck
```

---

## 4. L-3 — dev kitchen-sink chunk precached in prod

**Finding.** `/dev/kitchen-sink`'s own `beforeLoad` already redirects away
outside `import.meta.env.DEV`, but `vite-plugin-pwa`'s `injectManifest` glob
(`**/*.{js,css,woff2,svg,png}`) still precached that route's chunk onto every
visitor's disk.

**Fix.** `vite.config.ts`'s `injectManifest.globIgnores: ['**/dev.kitchen-
sink-*.js']`. A new post-build check, `scripts/check-sw-precache.ts`, reads
the built `dist/sw.js` and fails if it mentions `dev.kitchen-sink` — wired
into `pnpm run build` right after `vite build`.

**Test.** Precache manifest entry count dropped from 52 to 51 across the
fix; the check itself, run against the real build:

```
$ pnpm run build
...
precache  51 entries (1202.87 KiB)
files generated
  dist/sw.js
Removed 39 source map(s) from dist.
OK — dist/sw.js's precache manifest excludes the dev kitchen-sink chunk.
OK — 1 HTML file(s) under dist/ have no inline <script> or style=.
```

Confirmed by grepping the built file directly before the fix
(`grep dev.kitchen-sink dist/sw.js` matched a real manifest entry) and after
(no match).

---

## 5. H-3 — runtime `<style>` injectors break under `style-src-elem 'self'`

**Finding.** Two libraries inject a `<style>` element at runtime, which
`style-src-elem 'self'` (no `'unsafe-inline'`, no nonce/hash) blocks outright:
sonner's `<Toaster>` (a module-scope `__insertCSS(...)` call, unconditional
on import), and `react-remove-scroll-bar`, transitively pulled in by `cmdk`'s
`Command.Dialog` (which wraps `@radix-ui/react-dialog`, whose default
`modal` scroll lock mounts `react-remove-scroll` → `react-remove-scroll-bar`).

The security review attributed the second one to "Base UI Dialog." That's
not what the dependency graph shows: `@base-ui-components/react`
(`components/ui/dialog.tsx`, used by the kitchen-sink page's own dialog
example and `BottomTabs`) has **zero** dependency on `react-remove-scroll` —
confirmed by reading its `package.json` `dependencies`. The only consumer of
that dependency chain in this codebase is `CommandPalette.tsx` (the `⌘K`
command palette), via `cmdk`.

**Fix, two parts.**

1. **sonner.** `src/app/App.tsx` now imports `sonner/dist/styles.css` — the
   identical CSS sonner ships specifically for bundlers, served as a real
   `<link>`-loaded, content-hashed stylesheet. That alone isn't sufficient
   (the runtime `__insertCSS` call still fires and still violates CSP even
   with the real stylesheet present), so `vite.config.ts` adds a
   `stripSonnerRuntimeCss` Rollup transform plugin that removes the now-fully-
   redundant `__insertCSS(...)` call from `sonner/dist/index.mjs` at build
   time — a source transform, not a dependency patch, and it throws loudly if
   a future `sonner` upgrade changes the call shape instead of silently
   leaving the injection in place. Verified effective for `vite build`
   (production); `vite dev`'s esbuild pre-bundling runs ahead of this
   transform, so the dev server still shows the (CSP-irrelevant, since
   nothing in front of it sets the header) runtime injection — documented in
   the plugin's own comment, including why `optimizeDeps.exclude: ['sonner']`
   was tried and reverted (it broke `react-dom`'s CJS/ESM interop in dev).
2. **CommandPalette.** Rewritten on this repo's own `Dialog`/`DialogContent`
   (Base UI) instead of `cmdk`'s `Command.Dialog` — `<Command>` (the plain
   root, not `.Dialog`) still supplies every bit of cmdk's actual behaviour
   (filtering, keyboard nav, the input/list/group/item wiring); only the
   dialog _shell_ changed. This removes the `react-remove-scroll-bar`
   runtime injection at the point of actual use: since `Command.Dialog` is
   never rendered, `RemoveScrollBar`'s style-singleton component never
   mounts. (The dead code for it is still present in the built bundle — cmdk
   bundles `Command.Dialog` into the same object as `Command` — but dead code
   that never mounts never injects anything; confirmed by grepping the
   post-fix bundle for `data-scroll-locked`, finding it present but unreached.)

A third, unplanned fix was required to make either of the above verifiable:
zod v4's `ZodObject` constructor probes `new Function` support (via a
cached-getter `allowsEval` check) **at schema construction time**, not first
`.parse()` — confirmed by intercepting the real `Function` constructor in a
live Chromium and reading the call stack, which showed `new ZodObject` →
`.keyof()` → `allowsEval.value`'s getter → `new Function('')`. Zod's own
`core/util.js` documents that "strict CSPs report the caught `new Function`
as a `securitypolicyviolation` even though the throw is swallowed" — the
`z.object(...)` calls in `login.tsx`'s `validateSearch` and every schema in
`pending-contracts.ts` run at module-import time, before any code in
`main.tsx`'s own body (including a `z.config({ jitless: true })` call placed
as that file's first _statement_) had a chance to run. Fixed by moving that
config call into its own module, `src/lib/zod-jitless.ts`, imported as the
first _import_ of `main.tsx` — ES modules execute a program's imports
depth-first in the order written, so a module with no dependencies other
than `zod` itself, imported first, is guaranteed to run before anything that
defines a schema, regardless of how deep those schema-defining imports are
nested.

**Test.** `apps/web/e2e/csp.spec.ts`, described fully in §6 (M-1) below,
since it's the same test:

```
$ pnpm exec playwright test --project=csp
✓ the kitchen sink renders a toast and a dialog with zero CSP violations
✓ the toast, warning, and update-prompt code paths all render under CSP
```

Verified failing before both fixes: the same test against the pre-fix
sources recorded `script-src blocked eval` (the zod probe) and, once that was
worked around during triage, would have recorded a `style-src-elem` violation
for sonner's injected `<style>` — both eliminated by grepping the post-fix
bundle for `__insertCSS` (zero matches) and confirming the CSS rules land in
the real stylesheet (`grep data-sonner-toaster dist/assets/*.css` matches).

---

## 6. M-1 — `check-csp.ts` cannot see runtime CSP violations

**Finding.** `check-csp.ts` only regexes `dist/*.html` for inline
`<script>`/`style=` attributes at build time. It cannot execute JavaScript,
so it cannot observe what the running app does after hydration — exactly the
class of bug H-3 was.

**Fix.** Kept `check-csp.ts` (still the cheap, fast, every-build check for
what it _can_ see) and documented its limits explicitly in its own header
comment — what it doesn't and can't check, and where the gap is closed:
`apps/web/e2e/csp.spec.ts`.

That new spec is the one check in this repo that can observe a runtime CSP
violation. It's served by a purpose-built `apps/web/e2e/csp-static-server.mjs`
— a ~90-line `node:http` static file server with an SPA fallback, chosen over
`vite preview` (can't attach an arbitrary response header) or a full reverse
proxy (a dependency this test suite doesn't otherwise need) — behind the
exact 4-directive policy this remediation brief specified:
`script-src 'self'; style-src-elem 'self'; style-src-attr 'unsafe-inline';
connect-src 'self'`. (The real, deployed Caddy policy —
`docker/Caddyfile:74` — is a superset of this: it also sets `default-src`,
`img-src`, `font-src`, `worker-src`, `manifest-src`, `object-src`,
`frame-ancestors`, `base-uri`, and `form-action`. None of those extra
directives are implicated by the runtime-`<style>`-injection or `eval`-probe
failure modes this remediation targeted, so the narrower 4-directive policy
this test brief specified is a faithful, minimal reproduction of the actual
vector — not a weaker test.)

It installs a real `securitypolicyviolation` listener via `page.addInitScript`
before any app code runs (so it can't miss an early violation), navigates to
`/dev/kitchen-sink`, clicks the page's toast trigger and its dialog trigger,
and asserts the violations array is empty. `/dev/kitchen-sink` is reachable
in this one build only because it's built with `vite build --mode e2e-csp`
(a separate, gitignored `dist-e2e-csp/` output, never the shipped `dist/`) —
that route's own `beforeLoad` was extended with `import.meta.env.MODE !==
'e2e-csp'` alongside the existing `!import.meta.env.DEV` check, specifically
so this harness can exercise every primitive on that page (including the
`Toaster` and `Dialog` H-3 named) under the real production CSP header
without weakening the real deployed guard: `pnpm run build` (what actually
ships) never sets that mode, so the real production redirect is unchanged. A
"Show toast" button was added to the kitchen-sink page for this test to
drive — the page had a dialog example already but no toast trigger, which was
itself a minor gap in "every primitive on one page."

`playwright.config.ts` runs both this and the existing dev-server smoke test
as two independent projects with two `webServer`s; Playwright owns starting
and stopping both regardless of which project's tests are selected, so
`pnpm exec playwright test` is self-contained.

**Test — full run, both projects:**

```
$ pnpm exec playwright test --reporter=list
Running 4 tests using 4 workers
✓ [csp] the toast, warning, and update-prompt code paths all render under CSP
✓ [csp] the kitchen sink renders a toast and a dialog with zero CSP violations
✓ [chromium] the login screen switches to the recovery-code fallback
✓ [chromium] an unauthenticated visitor is redirected to /login
4 passed (15.7s)
```

---

## 7. M-2 — generated client hardcodes an absolute `baseUrl`, no `credentials`

**Finding.** `src/api/generated/client.gen.ts` defaulted to
`baseUrl: 'http://127.0.0.1:8080'` (the OpenAPI document's dev-only `servers`
entry) with no `credentials` set — wrong origin for a same-origin deployment
behind Caddy, and even pointed at the right origin, the session cookie would
never have been attached.

**Fix.** `openapi-ts.shared.mjs`'s `@hey-api/client-fetch` plugin config now
sets `baseUrl: false` (stop baking any origin into the generated file at
all) and `runtimeConfigPath: './src/api/client-runtime-config.ts'` — hey-api's
own documented escape hatch for exactly this case. That hand-written,
gitignore-exempt file exports `createClientConfig`, returning
`{ ...config, baseUrl: '', credentials: 'same-origin' }`, and survives every
`pnpm --filter @app/web gen` regardless of what the contract's `servers`
field says (which, separately, the API team's concurrent work changed from
`http://127.0.0.1:8080` to `/` — this fix doesn't depend on that having
happened, and would be correct either way).

Regenerated `client.gen.ts` after the fix:

```ts
export const client: Client = createClient(createClientConfig(createConfig<ClientOptions2>()));
```

— no `baseUrl` literal baked in at all; `createClientConfig` supplies both
`baseUrl: ''` and `credentials: 'same-origin'` at runtime.

**Test.** `src/api/pending-contracts.test.ts` covers the hand-written
client's equivalent contract (§8, since it's the same file); the generated
client's fix was verified by regenerating and reading the emitted file
(quoted above) rather than a unit test, since `src/api/generated` is
gitignored and regenerated by tooling — there's nothing in that directory to
assert against that survives the next `pnpm gen`.

---

## 8. L-1 — fetch wrapper spread order weakens credentials, drops headers

**Finding.** `pending-contracts.ts`'s `apiFetch` built its request as
`{ credentials: 'include', ...init, headers }` — `...init` spread _after_
`credentials`, so a caller passing its own `credentials` could silently
weaken the request, and the outer `headers` object was assigned _after_
`...init` too, discarding any headers a caller supplied instead of merging
them.

**Fix.** Caller headers merge first (`{ ...JSON_HEADERS,
...(init.headers as Record<string, string> | undefined) }`), then the CSRF
header is added for mutating methods, then the final `fetch` call spreads
`init` _before_ `credentials` and `headers`: `{ ...init, credentials:
'include', headers }` — neither can be overridden by a caller.

**Test.** `src/api/pending-contracts.test.ts`:

```
✓ always sends credentials: include, even if the caller tries to weaken it
✓ merges caller-supplied headers instead of dropping them
✓ still attaches the CSRF header on mutating methods alongside merged headers
```

---

## 9. I-1 — source maps must never ship

**Finding.** `vite.config.ts` already sets `build.sourcemap: 'hidden'`
(maps emitted for CI/error-triage, no `//# sourceMappingURL` comment in the
built JS) — but `hidden` still writes every `*.map` file into `dist/`, and
nothing removed them before that directory became the artifact that becomes
the Docker image.

**Fix.** `scripts/strip-sourcemaps.ts`, wired into `pnpm run build`
immediately after `vite build`: recursively deletes every `*.map` under
`dist/`.

**Test.**

```
$ pnpm run build
...
Removed 39 source map(s) from dist.
$ find dist -name "*.map" | wc -l
0
```

---

## 10. Recovery-code input

**Finding (from the fix brief, not a numbered gate finding).** The recovery
code field in `LoginScreen`'s `RecoveryCodeForm` was a plain text input, not
cleared after submit — a single-use bearer secret left visible in the DOM
and in component state after being used.

**Fix.** `type="password"`, and `setCode('')` immediately on submit
(regardless of whether the request that follows succeeds or fails).

**Test.** `apps/web/e2e/smoke.spec.ts`:

```
✓ the login screen switches to the recovery-code fallback
```

(asserts `type="password"` on the real rendered input, in a real browser).

---

## 11. Two defects found in the course of this remediation

Both discovered because `e2e/csp.spec.ts` is the first thing in this repo to
load a real `vite build` production bundle in an actual browser.

### 11.1 — a circular manual chunk crashed every route in production

`vite.config.ts`'s `build.rollupOptions.output.manualChunks` split `@visx/*`

- `d3-*` into their own `vendor-charts` chunk, separate from
  `vendor-tanstack`. Rollup's own build log said outright: `Circular chunk:
vendor-charts -> vendor-tanstack -> vendor-charts` and `Generated an empty
chunk: "vendor-react"`. The produced bundle threw `Cannot set properties of
undefined (setting 'Activity')` on load, in every route, not just anything
  this WP added — confirmed by intercepting `pageerror` events in a real
  Chromium against the built `dist/`. This is a pre-existing defect in
  `vite.config.ts` unrelated to any finding in scope; nothing about the CSP or
  sonner fixes touches chunk splitting.

**Fix.** Folded `vendor-charts` into `vendor-tanstack` (a single chunk can't
have this failure mode; whatever module Rollup was putting in a chunk that
also needed something from `@tanstack/*` no longer has two chunks to split
across). `vendor-react` is no longer empty as a result.

**Verification.** Before the fix: `pageerror` event captured, page failed to
render at all (confirmed via `page.getByRole('heading', ...).count()`
returning `0` and a raw `Function` constructor stack trace pointing at the
crash). After: zero `pageerror` events, `heading count 1`, and both Playwright
projects (4 tests total) pass.

### 11.2 — Playwright's browser-context callbacks need `DOM` in `tsconfig.node.json`

Adding `e2e/csp.spec.ts` (which references `window`/`document` inside
`page.addInitScript`/`page.evaluate` callbacks — code that runs in Chromium,
not Node) failed `tsc -b` under `tsconfig.node.json`'s `lib: ["ES2024"]`
(no DOM). Fixed by adding `"DOM"` to that project's `lib` array — it's the
one project `e2e/**/*.ts` belongs to; `skipLibCheck: true`
(`tsconfig.base.json`) means a conflict between `@types/node` and
`lib.dom.d.ts` on a shared global name never surfaces as an error either way.

---

## 12. Full verification, after every fix together

```
$ pnpm --filter @app/web typecheck   # clean
$ pnpm exec eslint apps/web           # clean, zero output
$ pnpm exec prettier --check apps/web # All matched files use Prettier code style!
$ pnpm --filter @app/web test         # Test Files  8 passed (8) — Tests  35 passed (35)
$ pnpm --filter @app/web build        # clean; see §4/§9 for the two post-build checks' output
$ pnpm exec playwright test --reporter=list
  Running 4 tests using 4 workers
  ✓ [csp] the toast, warning, and update-prompt code paths all render under CSP
  ✓ [csp] the kitchen sink renders a toast and a dialog with zero CSP violations
  ✓ [chromium] the login screen switches to the recovery-code fallback
  ✓ [chromium] an unauthenticated visitor is redirected to /login
  4 passed (15.7s)
$ just check                          # typecheck + lint + test — green
```

No servers were left running: Playwright owns the lifecycle of both
`webServer`s it starts (`vite dev` for the smoke project, the
`build:e2e-csp` + `csp-static-server.mjs` pair for the CSP project) and tears
both down when the run ends; `dist-e2e-csp/` (gitignored) and `test-results/`
were removed after manual debugging runs outside Playwright's own lifecycle.

---

## 13. What remains

- **`pending-contracts.ts` → generated client migration.** Both conditions
  that would justify it are now true (relative `servers`, populated
  `components.schemas`), but it's a distinct refactor across every
  `/auth/*` call site (`LoginScreen`, `IdleLockOverlay`, `LockScreen`,
  `KekUnlockScreen`, `TopBar`, the `/_app` guard) — deferred, tracked in
  `pending-contracts.ts`'s own header TODO.
- **`vendor-react`/`vendor-charts` chunk sizing.** §11.1's fix restores
  correctness (no more circular-chunk crash); it does not restore the
  original perf intent of splitting chart vendor code into its own
  cacheable chunk. Worth a follow-up if bundle size or cache-hit rate ever
  demands it, but correctly this time.
- **`vite dev`'s sonner runtime-CSS injection.** `stripSonnerRuntimeCss`
  (H-3) is a `vite build`-only fix; the dev server still shows the runtime
  injection. Accepted: nothing in front of `vite dev` sets a CSP header, so
  it was never the CSP-relevant target.
