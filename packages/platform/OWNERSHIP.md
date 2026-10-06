# `@core/platform` — table ownership

Platform.

The substrate every bounded context stands on: the `domain_events` transactional
outbox and its consumer pump, the Postgres job queue, the cron scheduler, feature
flags, and the boot config record. It holds no business rules and knows nothing
about money, accounts, or budgets.

`@core/platform` sits between `@core/db` and the contexts. Contexts may import it;
it may never import a context. That direction is enforced by
`personalfi/layer-imports`, and it is the whole point: the outbox exists so that
`@ctx/ledger` can tell the world something happened without knowing who is
listening.

Exactly one context may write a table, and only that context may read it directly.
Everyone else goes through this context's published interface or a read model. The
`pnpm lint:schema-ownership` check parses the list below, so it is the contract, not
a comment: a table defined outside its owning package, or claimed twice, fails CI.

## Depends on

- `@core/kernel` (Clock, ids)
- `@core/db` (columns, pool, migration runner)
- Identity, for the `user_id` foreign key only — declared in SQL, never imported.

## Tables

- `domain_events`
- `event_consumer_offsets`
- `processed_events`
- `jobs`
- `job_runs`
- `schedules`
- `config_snapshots`
- `feature_flags`
- `ops_backup_runs` — one row per `docker/backup/backup.sh` attempt (CF-17,
  D24; migration `0036_ops_status.sql`, WP 9.1). Install-wide, never
  user-scoped.
- `ops_restore_drills` — one row per `just restore-drill` run (CF-17, D24;
  migration `0036_ops_status.sql`, WP 9.1). Install-wide, never
  user-scoped.

`feature_flags` moved here from `@core/db` in WP 0.3. `packages/db/OWNERSHIP.md`
anticipated the split: the flag _service_ lives next to the consumers and
schedules it gates, so the table follows it. `0001_initial.sql` still creates the
table; only the owner changed, which is a documentation change, not a migration.

## Not owned here

- `schema_migrations` — `@core/db`, because the runner bootstraps it before this
  package exists in the boot order.
- `users` — `@ctx/identity`. The foreign keys above reference it from SQL; no
  TypeScript in this package imports a context.
