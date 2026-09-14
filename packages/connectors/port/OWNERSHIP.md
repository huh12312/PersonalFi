# `@connector/port` — table ownership

The `Connector` port: the interface every provider adapter implements, the
canonical fact shapes they produce, the capability declaration they publish, and
the error taxonomy they raise.

## Tables

None. This package is types, one error class, and three pure functions. It owns
no table and touches no database — `@ctx/connections` does the persisting.

## Why this is a package and not a module inside `@ctx/connections`

The same reason `@core/secretbox` is a package and not a module inside
`@ctx/identity`, and the argument is mechanised in `scripts/eslint-boundaries.js`:
`personalfi/layer-imports` denies `@ctx/*` → `@ctx/*` **and** `packages/connectors/*`
→ `@ctx/*` outright (the `crossContext` message: "must talk to it through a domain
event or its published port, never a direct import"). A `Connector` interface
living inside `@ctx/connections` therefore could not be imported by
`@connector/manual` or `@connector/csv`, and the adapters would have to re-declare
the whole contract structurally — which is precisely the drift a port exists to
prevent.

So the port sits below both: adapters implement it, `@ctx/connections` consumes
it, and neither imports the other's internals. `packages/contexts/connections/src/port.ts`
re-exports this package verbatim, so the context still has one published port
surface.
