# `@core/db` — table ownership

`@core/db` plays the Platform role for WP 0.1: infrastructure tables that belong to
no bounded context. It owns the Drizzle column vocabulary, the pool, and the
migration runner.

WP 0.2 and WP 0.3 add the rest of the platform surface (`domain_events`,
`event_consumer_offsets`, `jobs`, `job_runs`, `schedules`, `config_snapshots`) and
should claim them here, or split a `@core/platform` package out and claim them there.

## Tables

- `schema_migrations`
- `feature_flags`
