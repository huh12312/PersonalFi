# `@app/web` — placeholder

Owned by **WP 0.5**. Intentionally empty.

When it lands it is React 19 + Vite 7 + TanStack Router/Query as an SPA (no SSR),
Tailwind v4 with shadcn/ui on Base UI vendored as source, visx for every chart,
Lucide icons, everything self-hosted — no CDNs, no analytics, no phone-home.

Two constraints inherited from WP 0.1 that are cheaper to honour now than to retrofit:

- The TypeScript client is **generated from `packages/contracts/openapi/openapi.json`**
  with `@hey-api/openapi-ts`. Do not hand-write request types.
- Money crosses the wire as `{ minor: "1234", currency: "USD" }` — a _string_, never a
  JSON number. Render it through a helper that reads `minor` as a `bigint`.

This package is excluded from the root `tsconfig.json`; add its own once it has
sources, since it needs DOM libs the server packages must not have.
