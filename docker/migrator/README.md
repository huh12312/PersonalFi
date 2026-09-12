# migrator

Not a separate image. The `migrator` compose service (see `compose.yml`) runs
`docker/api.Dockerfile`'s image with `ROLE=migrator`, which makes
`docker/entrypoint.mjs` `import()` `packages/db/src/cli/migrate.ts` in-process
instead of `apps/api/src/main.ts`.

Same image, same digest, same dependency tree as api/worker: "no drift between
app and schema" (06 §4.4). It runs to completion and exits — `restart: "no"` in
compose, gated into the dependency graph via
`depends_on: { condition: service_completed_successfully }` on api and worker,
so neither starts against a database mid-migration.

The migrator's own database role should eventually be a higher-privilege one
than the api/worker's (06 §4.4: "the API's role should not own tables or have
DDL rights"). WP 0.4 does not introduce that role split — it requires a second
Postgres role and connection string, which is a `@core/db`/`@core/config`
decision, not an infrastructure one. Tracked for a follow-up work package.
