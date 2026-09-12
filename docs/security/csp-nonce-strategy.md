# CSP nonce strategy for `apps/web`

Owner: WP 0.5 (frontend). Consumer: WP 0.4 (the API container that serves
`dist/` and sets response headers) and the optional Caddy TLS front door.
This document describes what the frontend build guarantees and what the
serving layer must do with it — it does not implement the header itself;
apps/api and the Dockerfiles are out of this work package's scope.

## What the two source docs say, reconciled

- `docs/research/03-security-architecture.md` §4.4 specifies the
  authoritative target header: strict, nonce-based, `script-src
  'nonce-{RANDOM}' 'strict-dynamic'`, no `'unsafe-inline'` anywhere, plus
  `require-trusted-types-for 'script'`.
- `docs/research/05-frontend-architecture.md` §7.3 documents a narrower,
  *deliberate* compromise on `style-src`: React writes `style="..."`
  attributes for dynamic values (progress-ring arcs, chart gradients,
  `StatTile` layout), and there is no practical way to put a matching nonce
  on every one of those attribute writes. It proposes CSP Level 3's split
  directives — `style-src-elem` (no injected `<style>` blocks) vs.
  `style-src-attr` (the attribute form) — so the narrow exception never
  reopens `script-src`.

These are not in conflict once you read `style-src` as two directives, not
one. The header this build is compatible with is:

```
Content-Security-Policy:
  default-src 'none';
  script-src 'nonce-{RANDOM}' 'strict-dynamic';
  style-src-elem 'self';
  style-src-attr 'unsafe-inline';
  img-src 'self' data: blob:;
  font-src 'self';
  connect-src 'self';
  worker-src 'self' blob:;
  form-action 'self';
  frame-ancestors 'none';
  base-uri 'none';
  object-src 'none';
  require-trusted-types-for 'script';
  upgrade-insecure-requests;
  report-uri /api/csp-report
```

`frame-src https://cdn.plaid.com` and `script-src ... https://cdn.plaid.com`
are added **only** on the response for the route that mounts Plaid Link
(`/accounts/connect`, `/plaid/oauth` once WP 0.2/later work adds them) — not
globally. Everything else in the app never talks to a third-party origin
(§7.4).

## What the frontend build guarantees

1. **Zero inline `<script>` in the built HTML.** `vite.config.ts` sets
   `build.modulePreload.polyfill = false` (the polyfill is the #1 cause of an
   inline script Vite injects on your behalf) and the app never uses
   `dangerouslySetInnerHTML`, `eval`, or `new Function`. `scripts/check-csp.ts`
   greps every `dist/**/*.html` for a `<script>` tag without a `src`
   attribute and fails the build if it finds one.
2. **Zero inline `style="..."` in the built HTML shell.** The same script
   checks for `style=` attributes in `dist/**/*.html`. `index.html` itself
   never carries one; Tailwind emits real, hashed `.css` files.
3. **Content-hashed assets**, so `Cache-Control: public, max-age=31536000,
   immutable` is safe for everything except `index.html`.
4. **The pre-render theme/privacy write in `src/main.tsx`** (docs/research/05
   §2.7) runs from an external module script (`<script type="module"
   src="/src/main.tsx">` in dev, a hashed bundle in prod) — never an inline
   script — so it needs no special CSP carve-out at all, only the same nonce
   every other script tag gets under `strict-dynamic`.

What the build does **not** and cannot guarantee: React's `style` prop and
visx's inline SVG `fill`/`stroke` attributes are written to the live DOM at
runtime, not present in the static `dist/index.html` the CSP check inspects.
Those require the `style-src-attr 'unsafe-inline'` carve-out above. (SVG
presentation attributes like `fill="var(--money-pos)"` are not gated by
`style-src` at all — only the literal `style=""` attribute and `<style>`
elements are — so most chart theming needs no exception.)

## What the proxy/serving layer (WP 0.4) must do

`index.html` cannot be a static, indefinitely-cached file under this policy:
the nonce is per-request.

1. Serve every other file under `dist/` as-is, with immutable caching, exactly
   as today.
2. Serve `dist/index.html` as a **small dynamic response**, not a `sendFile`
   passthrough:
   - generate a cryptographically random nonce per request (≥128 bits,
     base64url — the same primitive already used for session tokens);
   - insert `nonce="{RANDOM}"` on the app's one `<script type="module"
     src="/assets/index-HASH.js">` tag (the only script tag Vite emits into
     `index.html`; everything `strict-dynamic` loads afterward inherits trust
     from it, so no other tag needs a nonce attribute);
   - set the same `{RANDOM}` value in the `Content-Security-Policy` response
     header's `script-src 'nonce-{RANDOM}'` token;
   - respond with `Cache-Control: no-cache` (already the plan for
     `index.html` regardless, docs/research/05 §10.2) so a CDN or the browser
     never serves a stale nonce.
3. Add the Plaid-specific `script-src`/`frame-src` tokens only when serving
   the route(s) that mount Link, not the global policy.
4. Wire `report-uri /api/csp-report` (or the CSP-Level-3 `report-to`
   equivalent) to a local endpoint that logs violations — no third-party
   report collector, consistent with "no analytics, no telemetry" (§7.4).

None of the above is implemented by WP 0.5; this document is the contract
WP 0.4 builds the static-file server against, and the rationale for why
`scripts/check-csp.ts` checks exactly the two things it checks and no more.
