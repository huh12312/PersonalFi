# `@core/db` — table ownership

`@core/db` owns the Drizzle column vocabulary, the connection pool, and the
migration runner. It owns exactly one table: the bookkeeping the runner has to
bootstrap before any other schema exists.

The rest of the platform surface — `domain_events`, `event_consumer_offsets`,
`processed_events`, `jobs`, `job_runs`, `schedules`, `config_snapshots`, and
`feature_flags` — belongs to **`@core/platform`** (WP 0.3), which sits one layer
above this package. WP 0.1 flagged that split as the likely answer and it is the
one taken: the flag service, the pump, and the scheduler live together, and the
tables they exist to drive live with them.

## Tables

- `schema_migrations`
