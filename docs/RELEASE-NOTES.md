<!-- SPDX-License-Identifier: MIT -->

# Release notes

Versions follow semantic versioning (09 §5.8): tags are `vMAJOR.MINOR.PATCH`. Until 1.0, a minor
release may change behaviour and add migrations, and a patch release only fixes. Migrations are
forward-only and, through the 90-day soak, **expand-only**: no release drops or rewrites what an
older release wrote. Every release names every manual step an upgrade needs; **the target is zero**,
and a release with none says so. Rolling back is a restore of the pre-migration backup, never a
reverse migration ([RUNBOOK: Upgrade](../RUNBOOK.md#upgrade)).

## v0.9.0: polish and harden

**Status:** the release candidate for the Phase 9 gate. The tag `v0.9.0` is pushed by the maintainer
once the gate has passed (09 §6 Q8), which is also the first run of `release.yml`. Until then,
upgrade to a commit of `main` that CI shows green.

### Upgrading to v0.9.0

From any earlier release, including a v0.8 install and one as old as v0.1, however many releases
you skip:

```bash
git pull
just upgrade
```

That is all. `just upgrade` creates the placeholders for any optional secret your install predates,
rebuilds the images, **takes a verified, encrypted backup before the first migration** (automatic;
no separate `just backup` is needed), applies the migrations, and checks that the stack is ready
and stable. It refuses to start an older release against a newer database. A v0.1 install was
upgraded to a release candidate by `just upgrade` alone (a direct jump, and a chain through each
wave), and the same test runs on a GitHub runner before any release image is published
([wp9.4-upgrade.md](evidence/phase-9/wp9.4-upgrade.md)).

The host needs `git`, Docker with Compose v2, `just` 1.21+ and Node.js 18+ (the host scripts only;
an install made by an earlier release already has all of these). No new environment variable is
required.

### Manual steps

| Step                                                                                                                                                                        | Who needs it                                              | Why                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Approve the narrator's payload preview again** (Settings, then Advisor management at `/settings/advisors`: open the local-model advisor's payload preview and approve it) | Only an install that has enabled the local-model narrator | The narrator now writes figure slots (`{{e1}}`) that the app fills in from each finding, so its prompt template and reply format changed. That changes the template hash, so an earlier approval covers a different query shape. Until you re-approve, a narration is **refused** `payload_not_approved`. It fails closed: nothing is written and nothing else is affected. Installs that never enabled the local model have nothing to do. |

There is no other manual step. In particular: no new secret to create (new optional secrets are
made empty for you), no `.env` edit, no data migration to run by hand, no re-linking of any
provider, and no restart sequence.

### What changed

- **Security: the app no longer runs as the database superuser.** Migration 0039 adds `personalfi_app` (DML only); api and worker use it from the first query with no action. Optional, for a hard boundary: split the roles with the new optional secret `migrator_database_url` (RUNBOOK "Database roles"). No manual step.
- **Security: published images can be verified before they run.** `PERSONALFI_PULL=1 PERSONALFI_RELEASE=x.y.z just upgrade` pulls only images whose cosign signature and provenance attestation match this repository's tagged release at your checked-out commit (`scripts/verify-release.sh`). Building from source stays the default. On `personalfi-prod`, `just upgrade` now runs the isolation guard first.
- **Builds no longer expire.** The images pin their base by digest and no longer pin exact Alpine package builds (which Alpine stops serving); the weekly upgrade test rebuilds them with no cache and scans them with `trivy image`.
- **Budget actuals no longer stop on a new account without a balance**, and a failing `GET /budgets/current` no longer leaves a half-created budget. A stopped consumer can be resumed: `just consumer-resume <name>`. Known: a card already owing at a budget's first period still stops it (O-94-1, WP 9.14).
- **Boot memory: api and worker derive their keys one at a time**: the boot peak drops from ~2.4 GiB to ~1.5 GiB; the worker is ready ~6 s after the api.
- **Accessibility (WCAG 2.2 AA sweep):** every screen has its own page title, every chart has a data table, the lock screen traps focus, Escape closes a dialog from a category field, nothing animates under reduced motion, every screen reflows at 320 px, and the destructive button has its own contrast-checked tokens; 15 defects fixed, none by excluding an element from the scan.
- Also from the security review's fixes: outbound TLS certificate checks are now tested for every provider client; session list and sign-out-everywhere routes; `DELETE /auth/totp`; step-up refusals, exports and imports are in the security event log, which is append-only; `Cache-Control: no-store` on every API response; Caddy's error pages carry the security headers; every container has a PIDs cap; an import re-validates plan data.

**Upgrades are safe to run unattended (WP 9.4).**

- A database newer than the code is refused (`migration.database_newer`); "newer" is set
  membership, never a maximum, so migrations applied out of number order converge.
- A verified encrypted backup is taken before any migration runs, and the migration does not run if
  the backup fails.
- New optional secrets get empty placeholders automatically (`just secrets-placeholders`).
- A test installs v0.1 cold and upgrades it to the release by `just upgrade` alone (direct jump and
  a chain through every wave), and `release.yml` will not publish an image unless it passes.

**Backups you can trust (WP 9.1, WP 9.4).**

- The dashboard shows the age of the last backup and the date of the last restore drill, and warns
  past 26 hours without a backup or 35 days without a drill (`GET /ops/backup-status`).
- **Fixed: a backup of any install holding a plan scenario could not be restored** (migration 0040;
  found by the upgrade test, F-94-6). The restore drill had passed only because its database held no
  plan. The drill now needs one: see [RUNBOOK: Restore drill](../RUNBOOK.md#restore-drill).
- `just restore-drill` no longer picks the first backups volume, network and database on a host
  with several Compose projects: it filters by `COMPOSE_PROJECT_NAME` and refuses when ambiguous.
- A false refusal of a valid backup whose dump table of contents was large is fixed (F-94-1).

**A production install that agents and gates cannot damage (WP 9.1).** The RUNBOOK's
[production install](../RUNBOOK.md#production-install-and-the-real-use-soak) section: an isolation
guard, a SHA-pinned image tag, a weekly aggregates-only soak report with a seeded leak canary, and
the 90-day clock.

**Real-data readiness (WP 9.2).** You can now set an account's tax treatment, role and valuation
yourself, so a mis-typed IRA no longer projects as taxable. A changed override makes the existing
projection read as stale and never recomputes it behind your back. Migration 0035.

**Planning that says what it did (WP 9.7).** Every projection problem is explained in words (56
codes); a deterministic run is labelled as one and is never phrased as a probability; the Monte
Carlo engine says when it is unavailable; every staleness reason names its version. A new `/goals`
screen has goal create, edit, contributions and a risk questionnaire, and a plan can be forked and
compared.

**The advisory surface (WP 9.6, WP 9.3, WP 9.5).**

- The narrator's payload preview can now be approved through the product, and a narrator's wording
  is attached to the Brief item it describes ("AI-assisted wording"). The text of a narration is
  shown only when `NARRATION_TEXT_SHOWN=true`, which **stays false in this release**: the narrator's
  figures are 100% correct on the first five validation steps and 92.9% through all seven on the
  measured 56-item run, under the 95% bar this release sets for showing it. Every figure it does
  write is the finding's own (slots), and the red-team pass found 0 fabricated figures in 32
  payloads.
- A first request to a cold local model no longer times out: the model is loaded by a data-free
  warm-up call first.
- All four kill levels have a screen and read back their real state in words
  ([RUNBOOK: Advisor kill switches](../RUNBOOK.md#advisor-kill-switches)); a published Brief item
  records its action; grant changes are recorded in an append-only history.
- Closed: nightly anomaly runs no longer need per-run consent for built-in advisors, a run's digest
  is verified when inspected, six scoping predicates each have a test, and a category's creep is no
  longer reported on a single large purchase.

**Performance, measured (WP 9.9).** Every master-plan budget was measured on the target host with
the load printed, and all pass: the 50,000-row transaction list p95 15 to 58 ms over real HTTP (budget
200); a 10,000-path Monte Carlo 543 ms (800); the nightly sync chain 243 s (300); a restore to
`/ready` in 36 s (1 hour); idle RAM 317 MiB and 351 MiB through a nightly chain. The
exception is the boot window, when `api` and `worker` each derive their encryption key at once and the
stack peaks near 2.4 GiB for about 3 seconds. The full table is in
[RUNBOOK: Resource envelope](../RUNBOOK.md#resource-envelope).

**Security review (WP 9.10).** An external-style review against ASVS 5.0 (278 requirements) and a
refreshed [threat model](security/threat-model.md): 88 met, 16 met by documentation, 61 gaps, 104 not
applicable. Its 33 gaps and what became of them are in
[wp9.10-security-review.md](evidence/phase-9/wp9.10-security-review.md); the
[ASVS assessment](security/asvs-assessment.md) has the row-by-row evidence.

**Security fixes (WP 9.11).**

- Outbound TLS certificate verification is now tested for every client that dials out (Plaid,
  Coinbase, market data, ntfy, Esplora and Etherscan, SMTP and a remote local-model endpoint): each
  was sabotaged to accept any certificate and the new test went red, where 219 existing tests had
  stayed green (G-27). One dialer now implements the pinned lookup, the TLS options and the header
  checks for the shared transport and the local-model endpoint, and a header value containing a line
  break is refused before any connection is made (G-24, G-16).
- The serving processes no longer run as the database superuser. Migration 0039 adds a DML-only
  role, `personalfi_app`; `api` and `worker` start every connection as it, with no action on your
  part. An optional second secret, `migrator_database_url`, makes that a hard boundary: see
  [RUNBOOK: Database roles](../RUNBOOK.md#database-roles). `security_events`, the audit trail, is
  append-only (G-01, G-25).

**Documentation (WP 9.12).** A README that takes a stranger from a clean host to a passkey login; a
consolidated RUNBOOK with a cryptography inventory, a logging inventory and a lockout section; and
`scripts/check-docs.ts`, a CI check that fails when a doc names a `just` recipe, an environment
variable, a secret, a path or a link the tree does not have.

### Migrations in this release

| Migration                         | What it adds                                                          |
| --------------------------------- | --------------------------------------------------------------------- |
| 0035 `account_overrides`          | Holder-set tax treatment, role and valuation per account              |
| 0036 `ops_status`                 | `ops_backup_runs`, `ops_restore_drills` (the dashboard's backup line) |
| 0038 `brief_actions_grant_events` | A Brief item's recorded action; the append-only grant history         |
| 0040 `plan_levers_search_path`    | Makes backups of databases holding plan scenarios restorable          |

Numbers 0037 (unused) and 0023 (burned in an earlier phase) are gaps; the runner tolerates gaps and
out-of-order application. All are expand-only.

### Known limits

- **`NARRATION_TEXT_SHOWN` stays `false`.** The narration's text is hidden until a counted run
  reaches 95% through step 7. Nothing is lost: the Brief shows that a narration exists.
- **Plaid runs in sandbox only** from the shipped `compose.yml`: the file does not pass
  `PLAID_ALLOW_PRODUCTION` to the api, and the api refuses `production` without it
  ([RUNBOOK: Create secrets](../RUNBOOK.md#2-create-secrets)).
- **Two reads are slow at scale** (WP 9.9, not fixed in this release): `GET /holdings` and
  `/investments/allocation` take about 2 s at 200 positions, and a bulk event is consumed at about
  one per second.
- **Key rotation has no operator procedure yet** ([RUNBOOK: Master-key rotation](../RUNBOOK.md#master-key-rotation)).
- **v1.0 is not this release.** It needs 90 days as the author's only finance tool, and the
  earliest date is 2027-01-10 ([path to v1.0](plan/06-path-to-v1.md)).

### Dependencies and licences

Permissive licences only, audited by `just licenses` and listed in
[`THIRD_PARTY.md`](../THIRD_PARTY.md).
