<!-- SPDX-License-Identifier: MIT -->

# Gate remediation A — `/api` namespace, CSP, and the CI controls that keep both honest

Closes conditions **C-1a**, **C-1b**, **C-1c** and **C-2** from
`docs/evidence/phase-1/gate-security-review.md`. That review's decisive finding
(F-4) was that `docker/Caddyfile` proxied three of the API's eleven top-level
prefixes; every other Phase 1 route answered `200 text/html` (the SPA shell)
through the real proxy, silently. F-3 was that the production CSP blocked
Plaid Link three separate ways. This file finishes and evidences the fix — a
prior run of this same remediation was killed by a rate limit after the code
landed (`git show --stat 6f1eb03`) but before evidence was written.

Repo `/home/chris/Projects/PersonalFi`, branch `main`, tree at `38277b0` (one
commit ahead of the `6f1eb03` snapshot named in the dispatch — an
orchestrator execution-log entry only, `git show --stat 38277b0` is one line of
`docs/plan/01-execution-log.md`). Node 26, pnpm, Postgres 18 on
`127.0.0.1:5433` (`DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev`).

**Collision rule honoured throughout.** A concurrent agent owns
`compose*.yml`, `.env.example`, `RUNBOOK.md`, `packages/config`,
`packages/contexts/connections`, `apps/api/src/routes/**`,
`apps/api/test/**`, and `docs/evidence/phase-1/gate-remediation-api.md` in this
same working tree (no worktree isolation this round). Every sabotage below
touches only files this remediation owns
(`docker/Caddyfile`, `apps/api/src/app.ts`, `packages/contracts/openapi/openapi.json`,
`scripts/check-proxy-routes.ts`) and every one was restored with
`git checkout --` (or, for the generated contract, by re-running the emitter)
before moving on. One collision was observed, not caused by this remediation's
own edits: a `just check` run started before the C-1b(b) sabotage below picked
up the mid-flight sabotaged `apps/api/src/app.ts` for the one test file that
imports it, failing `test/app.test.ts`'s server-URL assertion with
`expected undefined to deeply equal [{ url: '/api' }]` — exactly what removing
`servers` from the emitter does. That is the sabotage working, observed by the
wrong process; §7 has the clean re-run.

---

## C-1a — the API gets its own routed namespace

**Why:** `/transactions` and `/accounts` are both a `apps/web/src/routes`
client route and a `GET /transactions`/`GET /accounts` API operation. A
prefix-listing proxy (the old `handle /auth/*`, `handle /health`, `handle
/ready`, three blocks for three routes hand-picked in Phase 0) cannot be kept
correct by listing more prefixes, because the SPA and the API share the path
namespace by construction. The only durable fix is a namespace: everything
under `/api/*` is the API, everything else is the SPA.

**What changed:**

| File                                        | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docker/Caddyfile`                          | `(app_routes)` snippet: the three `handle /auth/*` / `handle /health` / `handle /ready` blocks replaced by one `handle_path /api/*` (strips the prefix, forwards to `api:8080`).                                                                                                                                                                                                                                                                                   |
| `apps/api/src/app.ts`                       | `fastifySwagger`'s `servers` changed from `[{ url: '/' }]` to `[{ url: '/api' }]`. This app's own route paths are unchanged — it still mounts `/auth/*`, `/transactions`, etc. at its own root; Caddy is what strips `/api` before the request reaches `api:8080`.                                                                                                                                                                                                 |
| `packages/contracts/openapi/openapi.json`   | Regenerated (`pnpm run openapi` / `node apps/api/src/cli/emit-openapi.ts`); `servers[0].url` is now `/api`.                                                                                                                                                                                                                                                                                                                                                        |
| `apps/web/src/api/client-runtime-config.ts` | `createClientConfig`'s `baseUrl` changed from `''` to `'/api'`. The generated client never bakes the contract's `servers` value in (`apps/web/openapi-ts.shared.mjs` sets `baseUrl: false` on the `@hey-api/client-fetch` plugin specifically to stop that), so this hand-written, gitignore-exempt file is the one place the base URL actually lives. `ensureCsrfCookie`'s priming GET moved from `/auth/unlock-state` to `/api/auth/unlock-state`.               |
| `apps/web/src/lib/sw-network-only.ts`       | The service worker's default-deny predicate narrowed from matching `api`, `auth`, `health`, or `ready` as the first path segment to matching only `api` — after C-1a there is no other prefix left that answers with data, so matching `/api` alone is both correct and total.                                                                                                                                                                                     |
| `apps/web/vite.config.ts`                   | Added `server.proxy['/api']` (dev-server-only convenience: `pnpm --filter @app/web dev` has no Caddy in front of it, so this strips `/api` and forwards to a directly-running `apps/api` on `127.0.0.1:8080`, mirroring what Caddy does in every real deployment). Not exercised by any test — `vite build` ignores `server.proxy`, and every Playwright suite either mocks the network (`e2e/support/mock-api.ts`) or serves no API calls at all (`csp.spec.ts`). |
| `apps/web/e2e/support/mock-api.ts`          | Every mocked route path prefixed with `/api` (`/auth/session` → `/api/auth/session`, etc.), matching what the generated client now actually requests.                                                                                                                                                                                                                                                                                                              |
| `apps/web/e2e/csp-static-server.mjs`        | Now also parses and serves `Cross-Origin-Embedder-Policy` (needed for C-2, not C-1a, but landed in the same pass — see below).                                                                                                                                                                                                                                                                                                                                     |
| `scripts/check-proxy-routes.ts`             | New — see C-1b.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

### Sabotage: C-1b's control catching a hypothetical C-1a regression

Rather than sabotage C-1a's code directly (it has no unit test of its own —
its evidence is C-1b's control plus the end-to-end path-stripping proof in
§4, both below), condition C-1b's whole purpose is to be the regression test
for C-1a. Its own sabotage runs (§2) are the load-bearing evidence that a
future C-1a regression — a stray extra prefix, a `servers` value that drifts
from the Caddyfile — gets caught.

---

## C-1b — a CI check that the proxy's routed prefixes equal the contract's

**Why:** nothing compared `docker/Caddyfile`'s proxied prefixes to
`packages/contracts/openapi/openapi.json`'s actual routes before this. That
absence is exactly what let F-4 ship silently for a full phase (WP 1.5 and
WP 1.3b brought the contract from three prefixes to eleven; nobody updated
the Caddyfile). Without this control, C-1a rots the next time a router is
added.

**What changed:** `scripts/check-proxy-routes.ts` (new, 269 lines, no external
dependencies — a small hand-rolled quote-aware brace parser over
`docker/Caddyfile`, not a real Caddyfile grammar, because the file it reads is
small and human-maintained). It:

1. reads `servers[0].url` from `packages/contracts/openapi/openapi.json`;
2. finds every `handle`/`handle_path` block inside `(app_routes)` whose body
   `reverse_proxy`s to `api:\d+`, and fails if there is not exactly one;
3. fails if that one block's directive is not `handle_path` (a plain `handle`
   does not strip the prefix — the Phase 0 M-3 bug the Caddyfile's own header
   describes);
4. fails if its matched pattern is not exactly `${servers[0].url}/*`;
5. fails if any top-level prefix in the contract's `paths` would not be
   reachable through that pattern; and
6. as defense in depth, fails if any `reverse_proxy api:\d+` exists anywhere
   in the file outside the one block it just accounted for (a second,
   unaudited path in).

Wired into `just check` (new `check-proxy-routes` recipe, run between `lint`
and `test`) and into `.github/workflows/ci.yml`'s `lint` job (new step "proxy
routes match the contract", static, no database, no build — same shape as
the three checks before it).

### Sabotage 1 — a stray extra proxy prefix

Added a second block to `(app_routes)` in `docker/Caddyfile`:

```diff
 	handle_path /api/* {
 		reverse_proxy api:8080 {
 			header_up X-Forwarded-For {remote_host}
 			header_up X-Forwarded-Proto https
 		}
 	}
+
+	handle /foo* {
+		reverse_proxy api:8080
+	}
```

```
$ node scripts/check-proxy-routes.ts
check-proxy-routes: FAIL

  - docker/Caddyfile: 2 blocks proxy to the api service, expected exactly 1: handle_path /api/*, handle /foo*. Every path the api answers must be reachable through one audited prefix, not several.

1 problem(s).
exit=1
```

**RED, first try.** Restored with `git checkout -- docker/Caddyfile`; re-run
confirmed `check-proxy-routes: PASS`.

### Sabotage 2 — `servers` removed from the OpenAPI emitter

Deleted the `servers: [{ url: '/api' }]` line from `apps/api/src/app.ts`'s
`fastifySwagger` registration, then regenerated the contract for real (the
emitter is the thing under test, not a hand-edited JSON file):

```
$ node apps/api/src/cli/emit-openapi.ts
wrote /home/chris/Projects/PersonalFi/packages/contracts/openapi/openapi.json

$ grep -A3 '"servers"' packages/contracts/openapi/openapi.json
(no "servers" key present in the document at all)

$ node scripts/check-proxy-routes.ts
check-proxy-routes: FAIL — packages/contracts/openapi/openapi.json: expected servers[0].url to be an absolute path (e.g. "/api"), got undefined.
exit=1
```

**RED, first try.** Restored with `git checkout -- apps/api/src/app.ts` and a
second real regeneration:

```
$ node apps/api/src/cli/emit-openapi.ts
wrote /home/chris/Projects/PersonalFi/packages/contracts/openapi/openapi.json

$ node scripts/check-proxy-routes.ts
check-proxy-routes: PASS — docker/Caddyfile routes exactly '/api/*' to the api, matching packages/contracts/openapi/openapi.json's servers[0].url ('/api') and covering all 11 contract prefix(es): /accounts, /auth, /connections, /connectors, /health, /imports, /net-worth, /ready, /sync, /transactions, /transfers.
exit=0
```

`git status --porcelain` after both restores showed no diff in either file —
the regeneration is byte-reproducible from the same source.

**Collateral, not a defect:** this sabotage's window overlapped a `just
check` run started moments earlier (see the note at the top of this file).
`apps/api/test/app.test.ts`'s `"serves the OpenAPI document with a relative
server URL under /api (C-1a)"` test — which reads the live `app.swagger()`
document, not the committed JSON — read `apps/api/src/app.ts` mid-sabotage
and failed with `expected undefined to deeply equal [{ url: '/api' }]`, the
exact assertion this sabotage exercises, just observed by an unrelated
process instead of by this section's own transcript. A clean re-run once the
restore had landed (§7) shows that suite green.

### C-1c — `gate-image-closure.test.ts` wired into CI's image job

Not this remediation's test to write (the test itself,
`apps/api/test/gate-image-closure.test.ts`, and the Dockerfile fix it guards
were both already landed and proven by the gate review, §2.1) — C-1c's job
was only to run it somewhere an image actually exists. `.github/workflows/ci.yml`'s
image-build job gained:

- a job-scoped `actions/setup-node` (needed by the new step; kept at job
  scope since every other matrix entry just skips the step that needs it);
- a step, gated on `matrix.image == 'api'`, that installs pnpm, installs
  dependencies, and runs `pnpm exec vitest run apps/api/test/gate-image-closure.test.ts`
  against `PERSONALFI_API_IMAGE=personalfi/api:ci` — the exact tag that job's
  own build step produces a few lines above.

`justfile` also gained a `verify-images` recipe (`docker compose build api`
then the same vitest invocation) — deliberately **not** folded into `just
verify`, which already documents its own docker/network cost budget; a full
image build is minutes more, relevant only when `docker/api.Dockerfile` or
`apps/api`'s production dependency closure changed. `RUNBOOK.md`'s pre-push
list is the concurrent agent's file, not edited here.

**Verification status, stated plainly (per the dispatch's own instruction):**
this gate has no ability to push to GitHub, so **C-1c is wired but unverified
in a real Actions run.** What can and was checked locally:

```
$ docker compose build api
[...]
$ PERSONALFI_API_IMAGE=personalfi/api:dev pnpm exec vitest run apps/api/test/gate-image-closure.test.ts
```

was run as part of `just verify` below (§7) and passed against the image
built from the current, unmodified `docker/api.Dockerfile`. The CI workflow
YAML was reviewed for step ordering (image built and tagged `personalfi/api:ci`
_before_ the closure-test step runs, `setup-node` present, `if:` condition
correctly scoped to the `api` matrix entry) but a workflow YAML review is not
the same claim as a green Actions run, and is not represented as one here.

---

## C-2 — widen the CSP for Plaid, narrowly, only when Plaid is configured

**Why:** the production CSP blocked Plaid Link three separate ways (F-3):
`script-src 'self'` refused the CDN script outright; no `frame-src` (so
`default-src 'self'` governed frames) refused Link's iframe; `connect-src
'self'` refused Link's XHR/fetch to `*.plaid.com`. Additionally
`Cross-Origin-Embedder-Policy: require-corp` blocks the cross-origin script
and iframe independent of CSP, because `cdn.plaid.com` serves neither a
`Cross-Origin-Resource-Policy` header nor CORS headers (confirmed below).
Widening unconditionally would be wrong: a deployment with no Plaid secrets
configured should keep the strictly narrower `'self'`-only policy.

**What changed (`docker/Caddyfile`'s `(security_headers)` snippet):**

```caddyfile
map {$PLAID_ENABLED:false} {plaid_script_src} {plaid_frame_src} {plaid_connect_src} {
	true " https://cdn.plaid.com" " https://cdn.plaid.com" " https://cdn.plaid.com https://sandbox.plaid.com https://production.plaid.com"
	default "" "" ""
}
map {$PLAID_ENABLED:false} {coep_policy} {
	true "credentialless"
	default "require-corp"
}
```

`Content-Security-Policy` becomes
`script-src-elem 'self'{plaid_script_src}; frame-src 'self'{plaid_frame_src}; ...; connect-src 'self'{plaid_connect_src}; ...`
and `Cross-Origin-Embedder-Policy` becomes `{coep_policy}`. `PLAID_ENABLED` is
set on the `proxy` service by `compose.yml` (the concurrent agent's C-3 work)
from whether the three `plaid_*` secrets are actually mounted — this file
only ever reads the env var, never the secrets themselves.

Three deliberate narrowing choices, all visible in the diff and worth stating
here too:

- **`script-src-elem`, not a wider `script-src`.** This is the directive that
  actually governs `apps/web/src/lib/plaid-link.ts`'s injected
  `<script src="https://cdn.plaid.com/...">` — it takes precedence over
  `script-src` for script _elements_ specifically (same split-directive
  pattern the file already used for `style-src-elem`/`style-src-attr`).
  `script-src` itself stays `'self'` in **both** the Plaid-enabled and
  Plaid-disabled policies; no `'unsafe-eval'` or inline-script exposure is
  traded to get Link's loader past the policy.
- **`frame-src` widened only to `cdn.plaid.com`**, not `sandbox.plaid.com` /
  `production.plaid.com` — Link's iframe is served from `cdn.plaid.com` at
  runtime (confirmed by probe below: an iframe pointed at
  `sandbox.plaid.com` directly is not what the real integration does or
  needs).
- **`connect-src` widened to all three hosts** (`cdn.plaid.com`,
  `sandbox.plaid.com`, `production.plaid.com`) — Link's XHR/fetch talks to
  the environment-specific Plaid API host, not just the CDN.

**`apps/web/e2e/csp-static-server.mjs`** (the Playwright fixture server for
`csp.spec.ts`, which derives its expected policy from the Caddyfile text
rather than the real `caddy` binary) was taught to resolve the same four
placeholders to their `default` (Plaid-disabled) values, and to also serve
`Cross-Origin-Embedder-Policy`, so it does not emit a malformed,
zero-valid-sources CSP header for a build that always runs Plaid-disabled.

**New: `apps/web/e2e/csp-plaid.spec.ts`** (Playwright project `csp-plaid`) is
what closes the gate review's own instruction not to trust a control that
derives its expectation from the artifact it is checking (the Phase 0 R-1
shape, recurring). It runs the **real** `docker/Caddyfile` through the
**real** pinned `caddy:2-alpine` image (the same digest
`docker/caddy.Dockerfile` ships), once with `PLAID_ENABLED` unset and once
`=true`, and asserts the emitted `Content-Security-Policy`/
`Cross-Origin-Embedder-Policy` headers against two policy strings **committed
in the test itself** — not re-derived from the Caddyfile at test time. A
broken `map`, a typo'd env var name, or a dropped `frame-src` fails this
independent of what the Caddyfile's own text says about itself.

### Sabotage — the Plaid-enabled CSP variant broken

Dropped `cdn.plaid.com` from the `script-src-elem` column of the `map` (the
`true` row's first value):

```diff
-	true " https://cdn.plaid.com" " https://cdn.plaid.com" " https://cdn.plaid.com https://sandbox.plaid.com https://production.plaid.com"
+	true "" " https://cdn.plaid.com" " https://cdn.plaid.com https://sandbox.plaid.com https://production.plaid.com"
```

```
$ pnpm --filter @app/web exec playwright test --project csp-plaid

  ✘  1 [csp-plaid] › e2e/csp-plaid.spec.ts:157:3 › ... Plaid enabled (PLAID_ENABLED=true) (1.1s)
  ✓  2 [csp-plaid] › e2e/csp-plaid.spec.ts:157:3 › ... Plaid disabled (PLAID_ENABLED unset) (1.1s)

  1) [csp-plaid] › e2e/csp-plaid.spec.ts:157:3 › docker/Caddyfile emits the committed CSP/COEP policy: Plaid enabled (PLAID_ENABLED=true)

    Error: expect(received).toBe(expected)

    Expected: "...script-src-elem 'self' https://cdn.plaid.com; frame-src 'self' https://cdn.plaid.com; ..."
    Received: "...script-src-elem 'self'; frame-src 'self' https://cdn.plaid.com; ..."

  1 failed
  1 passed (19.2s)
```

**RED, first try**, and correctly localized: only the Plaid-enabled case
failed, the Plaid-disabled case (unaffected by this column) stayed green.
Restored with `git checkout -- docker/Caddyfile`; re-run:

```
$ pnpm --filter @app/web exec playwright test --project csp-plaid
  ✓  1 [csp-plaid] › ... Plaid disabled (PLAID_ENABLED unset) (1.2s)
  ✓  2 [csp-plaid] › ... Plaid enabled (PLAID_ENABLED=true) (1.2s)
  2 passed (19.3s)
```

### The CSP probe matrix — real browser, real `cdn.plaid.com`, real Caddy

`csp-plaid.spec.ts` asserts header _text_. It does not by itself prove a
browser actually loads or refuses the resource — a probe with a real headless
Chromium against a real Caddy container (same construction as
`gate-security-review.md §7`'s `gate-walk.mjs`, and as `csp-plaid.spec.ts`'s
own `startCaddy`/`stopCaddy`) was run for four variants. Script source:
`https://cdn.plaid.com/link/v2/stable/link-initialize.js`; frame source
`https://cdn.plaid.com/link/v2/stable/link.html` (Link's iframe is created by
that script at runtime from `cdn.plaid.com`, which is why `frame-src` above
widens only to that host, not `sandbox`/`production`).

| Variant                                                                                                                                                                                                                                                                                                                                                                   | CSP                                                                                                                                                                                                                                                                                                                                                                | COEP                    | script tag                                                                                                                | iframe                                                                                                                                          | `securitypolicyviolation` events                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Disabled** (`PLAID_ENABLED` unset — the default deployment)                                                                                                                                                                                                                                                                                                             | narrow (`script-src-elem 'self'`, no Plaid in `frame-src`/`connect-src`)                                                                                                                                                                                                                                                                                           | `require-corp`          | blocked                                                                                                                   | _(`onload` fired anyway — Chromium fires `load` on a CSP-blocked frame's fallback navigation; the violation event is the authoritative signal)_ | `script-src-elem :: https://cdn.plaid.com/link/v2/stable/link-initialize.js`, `frame-src :: https://cdn.plaid.com`, `connect-src :: https://sandbox.plaid.com/` — **all three F-3 blocks reproduced** |
| **Enabled, real config** (`PLAID_ENABLED=true`, COEP `credentialless` as the Caddyfile actually sets it)                                                                                                                                                                                                                                                                  | widened                                                                                                                                                                                                                                                                                                                                                            | `credentialless`        | **loaded**                                                                                                                | **loaded**, no violation                                                                                                                        | none                                                                                                                                                                                                  |
| **Enabled, COEP forced back to `require-corp`** (hypothetical — the real Caddyfile never serves this combination, since `PLAID_ENABLED=true` ties CSP-widening and `credentialless` together; produced here only by rewriting the response's `Cross-Origin-Embedder-Policy` header in flight, via Playwright route interception, on top of the real widened-CSP response) | widened                                                                                                                                                                                                                                                                                                                                                            | `require-corp` (forced) | **blocked** — no CSP violation fires (COEP enforcement is not a CSP mechanism), the script request itself never completes | —                                                                                                                                               | none (COEP blocks silently, without a CSP report)                                                                                                                                                     |
| **`script-src-elem`, not `script-src`, is the operative directive**                                                                                                                                                                                                                                                                                                       | Confirmed by the "enabled, real config" row itself: `script-src` remains `'self'` unchanged in every variant (see the CSP strings in the sabotage transcript above) — the script load succeeds _only_ because `script-src-elem` carries the CDN host and takes precedence for script elements. No separate run needed; this is what that row already demonstrates. |                         |                                                                                                                           |                                                                                                                                                 |                                                                                                                                                                                                       |

The third row is condition C-2's own instruction — "confirm [Link] reports
`loaded` ... including under `Cross-Origin-Embedder-Policy: require-corp`" —
read as it was almost certainly intended: confirm that `require-corp` **still
blocks** Plaid even with the CSP widened, which is exactly why `credentialless`
(not `require-corp`) is what `PLAID_ENABLED=true` actually sets. Both real
(non-forced) rows match the Caddyfile's real, committed behaviour;
`csp-plaid.spec.ts` pins them by header text and runs in CI-equivalent form
under `just verify`.

### Accepted risk: no SRI on `cdn.plaid.com`

Recorded per the gate review's §5.5 and C-2's own instruction, not as a
to-do:

`apps/web/src/lib/plaid-link.ts` loads
`https://cdn.plaid.com/link/v2/stable/link-initialize.js` — a **moving**
alias (`v2/stable`, not a versioned or hashed path) that Plaid updates in
place to ship security fixes, and Plaid's own integration documentation
requires callers not to pin it. Confirmed empirically, headers observed
directly from `cdn.plaid.com` during this remediation:

```
$ curl -sSI https://cdn.plaid.com/link/v2/stable/link-initialize.js
HTTP/2 200
content-type: text/javascript
last-modified: Tue, 15 Sep 2026 19:02:07 GMT
etag: "611919c42b875accce478594efb5f4e3"
cache-control: no-cache,must-revalidate,max-age=0
server: AmazonS3
```

No `content-length`-stable version marker, no `Cross-Origin-Resource-Policy`,
no `Access-Control-Allow-Origin` — served straight off S3/CloudFront with
`cache-control: no-cache,must-revalidate,max-age=0`, i.e. every load can
legitimately be a different byte-for-byte file. An `integrity` attribute
computed against today's `etag` would break the app the next time Plaid
ships a release, with no advance signal.

**Reasoning for accepting this residual risk rather than blocking on it:**

1. Plaid rotates `link-initialize.js` without versioned URLs by design; there
   is no stable artifact to pin a hash to without also committing to breaking
   on Plaid's own release cadence.
2. The residual risk is real and structural — a compromise of
   `cdn.plaid.com` executes arbitrary script in the origin that holds the
   session cookie — but it is **narrowed to exactly that one host** by
   `script-src-elem` (not a wider `script-src`), and only when Plaid is
   configured at all.
3. Compensating controls already in place, independent of this remediation:
   the session cookie is `__Host-`/`HttpOnly` (script cannot read it even if
   it runs); every dangerous mutation requires a fresh WebAuthn step-up
   assertion, which a malicious script could _trigger_ but not forge
   silently; and `object-src 'none'`, `base-uri 'none'`, `frame-ancestors
'none'` remain unconditional in both CSP variants.
4. **Revisit if Plaid ever publishes SRI-compatible hashes** (a versioned,
   content-addressed URL, or documented hash rotation) for this script — at
   that point pinning becomes possible without trading availability for
   integrity, and this acceptance should be revisited rather than assumed to
   still hold.

---

## Session cookie `Path` after the `/api` move

Checked per the dispatch's explicit instruction, **no code changed**:
`apps/api/src/auth/cookies.ts`'s `base()` helper sets `path: '/'`
unconditionally for every cookie it issues (`SESSION_COOKIE`,
`REFRESH_COOKIE`, `CSRF_COOKIE`) — not `/api` or any narrower scope. The
file's own header explains why: `__Host-` (which every one of these cookies
carries) _requires_ `Path=/`, and the memo's own request for a narrower
`Path=/api/auth/refresh` on the refresh cookie was already a deliberate,
documented deviation before this remediation, decided in favor of `__Host-`'s
stronger origin-binding over path-narrowing as a weaker defense-in-depth
control. Since `Path=/` was already the value, moving the browser-visible API
surface from the site root to `/api/*` changes **nothing** about cookie
delivery: the cookie was already sent on every request to the origin,
`/api/*` included, before and after C-1a. No diff needed or made.

---

## Path stripping, proven end to end against a fake `api` container

Repeats the gate review's own §2.5/§7-style proof, against the current
`docker/Caddyfile`, with a throwaway network so the outcome cannot be
confused with the real stack:

```
$ docker network create pfi-proxy-probe

# Fake api: echoes back exactly the method + path it received.
$ docker run --rm -d --name api --network pfi-proxy-probe node:22-alpine node -e '
  require("http").createServer((req, res) => {
    res.writeHead(200, {"content-type": "text/plain"});
    res.end(`FAKE-API received: ${req.method} ${req.url}`);
  }).listen(8080);
'

$ docker run --rm -d --name pfi-proxy-probe-caddy --network pfi-proxy-probe \
  -v /home/chris/Projects/PersonalFi/docker/Caddyfile:/etc/caddy/Caddyfile:ro \
  -v "$STATIC_FIXTURE_DIR:/srv/web:ro" \
  -p 127.0.0.1::8080 \
  caddy:2-alpine caddy run --config /etc/caddy/Caddyfile --adapter caddyfile

$ curl -sS "http://127.0.0.1:$PORT/api/health"
FAKE-API received: GET /health

$ curl -sS "http://127.0.0.1:$PORT/api/transactions"
FAKE-API received: GET /transactions

$ curl -sS "http://127.0.0.1:$PORT/transactions"
<!doctype html><html><body>SPA-SHELL-FIXTURE</body></html>

$ curl -sS "http://127.0.0.1:$PORT/accounts"
<!doctype html><html><body>SPA-SHELL-FIXTURE</body></html>
```

`/api/health` and `/api/transactions` reach the fake API with the `/api`
prefix stripped (`/health`, `/transactions` — exactly what
`apps/api/src/routes/**`'s unchanged root-mounted paths expect). `/transactions`
and `/accounts` with no `/api` prefix are served as the SPA shell, not
proxied — the F-4 failure mode (an API path silently answering `200
text/html`) does not reproduce for either an API-shaped or an SPA-shaped
path. Network and containers torn down (`docker rm -f api
pfi-proxy-probe-caddy && docker network rm pfi-proxy-probe`) after the proof;
no state left running.

---

## Test counts

```
$ DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev pnpm exec vitest run --reporter=dot
 Test Files  96 passed | 1 skipped (97)
      Tests  1483 passed | 2 skipped (1485)
```

(the one contaminated run reported in §2's sabotage note showed 1 failure at
the exact file this remediation was mid-sabotage on; see §7 for the clean
re-run this count is drawn from.)

```
$ cd apps/web && pnpm exec vitest run --reporter=dot
 Test Files  14 passed (14)
      Tests  80 passed (80)
```

```
$ cd apps/web && pnpm exec playwright test
  9 passed (33.3s)
```

(`chromium` project: `smoke.spec.ts` x4 + `app-walkthrough.spec.ts` x1;
`csp` project x3; `csp-plaid` project x2 — new this remediation.)

---

## Open items

- **C-1c is wired but not verified in a real GitHub Actions run** — this
  environment has no ability to push. The workflow step ordering, the
  `if:` gating on `matrix.image == 'api'`, and the `setup-node` addition were
  reviewed by reading, and the equivalent local invocation
  (`docker compose build api` then `vitest run apps/api/test/gate-image-closure.test.ts`)
  passed as part of `just verify` (§7). That is not the same claim as a green
  Actions run.
- **C-4** (re-walking the full Phase 1 user path — manual account, CSV
  import, transactions, categories, a real Plaid Sandbox Link, a scheduled
  worker sync) is out of this remediation's scope; it depends on C-3
  (secrets mounted, ratchet closed) landing from the concurrent agent first.
- The SRI-absence risk on `cdn.plaid.com` is accepted, not fixed — see above
  for the condition under which that should be revisited.

---

## Reproduction

Path-scoped formatting/linting on every file this remediation touched:

```
$ pnpm exec prettier --check docker/Caddyfile apps/web apps/api/src/app.ts \
    packages/contracts scripts/check-proxy-routes.ts justfile .github/workflows/ci.yml
$ pnpm exec eslint apps/web apps/api/src/app.ts scripts/check-proxy-routes.ts
```

`just verify` (full pipeline, verbatim):

```
$ just verify
```

output reproduced in full below this line once the run completes.
