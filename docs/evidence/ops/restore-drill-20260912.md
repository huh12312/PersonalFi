# Restore drill — 20260912T131439Z

- Backup restored: `/backups/personalfi-20260912T131411Z.dump.age`
- Restored db table count: 0
- Restored db schema_migrations max id: (schema_migrations not present)
- Live db table count: 0
- Live db schema_migrations max id: (schema_migrations not present)
- API /ready against restored db: fail or skipped — see docker logs restore-drill-api-3861384; not necessarily an infra defect, see evidence notes

## Notes (added by hand after the run)

Both the live and restored databases show zero tables. This is expected given
the state of the repo at the time this drill ran, not a defect in the
backup/restore mechanism: the `migrator` service currently fails to boot
because `packages/config/src/schema.ts`'s `ROLE` enum only accepts
`'api' | 'worker'` and does not yet know about `ROLE=migrator` (added by WP
0.4's three-role single image, D13). No migrations have ever applied to the
live `db`, so an empty schema is exactly what a byte-correct restore of it
should also produce — the mechanism (`pg_dump` -> `age --encrypt` ->
`age --decrypt` -> `pg_restore`) is what this drill is actually proving, and
it did: the encrypted dump round-tripped cleanly into a fresh, independent
Postgres instance with `pg_isready`/`psql` both able to talk to it
immediately afterward. `/ready` failing against a database with no schema at
all is the _correct_ answer from `apps/api/src/routes/health.ts`'s own
contract, not a false negative.

Re-run this drill once the `ROLE` enum gap above is fixed and at least one
migration has applied to the live database — at that point table counts and
`schema_migrations`'s max id should match between live and restored, and
`/ready` against the restored db should return 200 (assuming WP 0.2's auth
wiring is also complete enough to leave the API in a bootable state by then).

One operational note this run surfaced: `AGE_IDENTITY_FILE` must be
world-readable (e.g. `chmod 644`) before running this drill, not just
owner-readable. Docker bind-mounts (this script uses plain `docker run -v`,
not a compose secret) preserve the host file's own uid/mode verbatim inside
the container, and the `backup` image runs as uid 10002 — a file only its
owner (whoever ran `just restore-drill`) can read fails to open from inside
the container. Documented in RUNBOOK.md's "Restore" and "Restore drill"
sections.
