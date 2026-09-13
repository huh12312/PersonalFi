# Restore drill — 20260913T124114Z

**Verdict: PASS**

- Backup restored: `/backups/personalfi-20260913T123222Z.dump.age` (70311 encrypted bytes)
- Restored db table count: 20
- Restored db schema_migrations max id: 0003
- Live db table count: 20
- Live db schema_migrations max id: 0003
- API /ready against restored db: pass (200 from /ready)

All assertions held: restored tables > 0, restored == live, schema_migrations agree,
and the API served /ready from the restored database. `just restore-drill` exited 0.
