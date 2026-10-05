# Restore drill — 20261005T172944Z

**Verdict: PASS**

- Backup restored: `/backups/personalfi-20261005T172944Z.dump.age` (486249 encrypted bytes)
- Restored db table count: 97
- Restored db schema_migrations max id: 0034
- Live db table count: 97
- Live db schema_migrations max id: 0034
- API /ready against restored db: pass (200 from /ready)

All assertions held: restored tables > 0, restored == live, schema_migrations agree,
and the API served /ready from the restored database. `just restore-drill` exited 0.
