<!-- SPDX-License-Identifier: MIT -->

# RUNBOOK

Operational procedures for running PersonalFi: first install, upgrade, backup,
restore, master-key rotation, the panic button, and troubleshooting. This is
the doc to open when something needs doing on the actual host, not when
reading the code — see `docs/research/06-platform-devops-licensing.md` and
`docs/plan/00-master-implementation-plan.md` for the design rationale behind
the choices this file just tells you to execute.

Everything here assumes Docker 29+ with the Compose v2 plugin, on the Arch
Linux host the master plan targets (D13/D24). Commands are given as `just ...`
where a target exists (`justfile`) and as raw `docker compose ...` otherwise.

---

## First install

### 0. Before you start: LUKS2

Master plan D24 / P0-13: **the volume holding `pgdata` and `backups` must be
LUKS2-encrypted at the block-device level.** This is a host-provisioning step,
not something `docker compose up` can do for you — Docker sees a filesystem
path and has no idea whether the block device under it is encrypted.

```bash
# One-time, on the host, before Docker ever touches the disk:
cryptsetup luksFormat /dev/sdX1
cryptsetup open /dev/sdX1 personalfi-data
mkfs.ext4 /dev/mapper/personalfi-data
mount /dev/mapper/personalfi-data /var/lib/docker/volumes   # or wherever you point Docker's data-root
```

Add it to `/etc/crypttab` (or a systemd unit) so it unlocks at boot rather
than requiring a manual `cryptsetup open` after every restart — decide
up front whether that unlock is itself automated (TPM2-bound, e.g.
`systemd-cryptenroll --tpm2-device=auto`) or requires a passphrase typed at
the console, and document your own answer here once you've made it. Nothing
in this repo can make that call for you: it depends on the physical security
model of wherever the box lives.

### 1. Clone and install workspace tooling

```bash
git clone https://github.com/chris/personalfi.git
cd personalfi
just install     # pnpm install --frozen-lockfile
```

### 2. Create secrets

Every secret is a **file** under `./secrets/`, never an environment variable
(P0-2: `docker inspect` and `/proc/<pid>/environ` must stay clean). The
directory is gitignored. Docker mounts each one at `/run/secrets/<name>`
inside the relevant container regardless of the host filename, but the
host-side filenames below are also what `.env.example` and `just
gen-master-key` already assume — use exactly these names.

```bash
mkdir -p secrets && chmod 700 secrets

# 1-2. Postgres's own bootstrap password (compose.yml's `pg_password` secret —
#    not one of the four the memo names; postgres and the backup/restore
#    scripts need a bare password, database_url is separate) and the full
#    connection string the app itself uses. One recipe, not raw `openssl`/
#    `echo`, because the password has to be URL-safe: a base64 password can
#    contain `/`, `+`, or `=`, any of which either breaks `postgres://...`
#    parsing outright or silently changes what the URL means. `just
#    gen-pg-secrets` uses a hex alphabet (always URL-safe, no escaping ever
#    needed) and parses its own output with Node's `URL` before writing it.
just gen-pg-secrets

# 3. The KEK passphrase (D5, P0-2). Never hand-type this one — low entropy
#    here defeats the entire envelope-encryption design.
just gen-master-key

# 4. An age keypair for backups. The container only ever gets the public
#    half (see docker/backup/backup.sh's header for why); keep the private
#    half OUTSIDE this repo and this host — a password manager entry plus
#    one offline paper/USB copy. Generate it using the backup image itself
#    so you don't need `age` installed on the host at all:
just build
docker run --rm --entrypoint age-keygen personalfi/backup:dev > /tmp/personalfi-age-identity.txt
grep '^# public key:' /tmp/personalfi-age-identity.txt | cut -d' ' -f4 > secrets/age_recipient
chmod 444 secrets/age_recipient
# Move /tmp/personalfi-age-identity.txt to your password manager / offline
# copy, then delete it from /tmp. Never commit it, never leave it on this host.
shred -u /tmp/personalfi-age-identity.txt

# 5. Backblaze B2 (optional — skip if you're not pushing backups off-box yet;
#    placeholder files are fine and are the default, see .env.example).
echo "placeholder" > secrets/b2_key_id
echo "placeholder" > secrets/b2_application_key
# To actually enable it: create a B2 application key scoped to one bucket
# with object lock enabled, put the key id/secret in the two files above,
# and set RCLONE_REMOTE=b2:<your-bucket-name> in .env.

chmod 444 secrets/b2_key_id secrets/b2_application_key
```

#### Secret file modes: 0444 by default, 0400 via `just harden-secrets`

`packages/config/src/schema.ts` and `.env.example` both say mode 0400, and the
files this writes are 0444. That gap is real, was raised by the Phase 0
security gate (M-2), and here is exactly what it is.

Docker Compose's file-secret provider **bind-mounts the host file and preserves
its uid, gid and mode verbatim**. The `uid`/`gid`/`mode` keys in compose's
secret long syntax are Swarm-only and `docker compose up` ignores them
silently. Measured on Compose v5.5.1:

```
host file: -rw-r--r-- 1 1000 1000 s.txt      declared: mode: 0400, uid/gid 10001
container (running as 10001): -rw-r--r-- 1 1000 1000 /run/secrets/s   -> READABLE
```

Nothing was applied. So with a 0400 file owned by you, every consumer fails:
`db` runs as uid 70, `api`/`worker`/`migrator` as 10001, `backup` as 10002, and
none of them is the uid that ran `just`. 0444 inside a **0700 directory** is
the working default: only you and root can traverse into `./secrets` at all.

The way to actually get 0400 inside the container is to make the host file
0400 _owned by the consuming uid_, which needs root once:

```bash
just harden-secrets     # sudo chown/chmod per consuming service
ls -l secrets/
# -r-------- 1 10001 10001 database_url      api / worker / migrator
# -r-------- 1 10001 10001 master_key        api / worker
# -r--r----- 1     70  10002 pg_password     postgres (owner) + backup (group)
# -r-------- 1 10002 10002 age_recipient     backup
```

After that you can no longer `cat secrets/master_key` without `sudo` either —
which is the point — and `just gen-*` will need `sudo` to rewrite them.
`just restore-drill` already reads `pg_password` through a root container, so
it keeps working. Run it before handing the box real credentials; it is the
one remaining hand action in this section.

### 3. Configure `.env`

```bash
cp .env.example .env
```

The two settings that matter for a fresh box:

- `BIND_ADDRESS` — the address Caddy's ports publish to. **Never `0.0.0.0`
  on a machine holding financial data.** Defaults to `127.0.0.1` (LAN mode:
  reach it via an SSH port-forward, or `just trust-ca` and a browser on the
  box itself). Set it to the host's actual LAN IP if you want other devices
  on the same LAN to reach it directly over the internal CA.
- `PUBLIC_HOST` — defaults to `personalfi.lan`; **renamed from
  `PERSONALFI_HOSTNAME`** because it is one fact used in four places and they
  were allowed to disagree once (P0-4). Setting it sets, together: Caddy's site
  address and internal-CA certificate (`docker/Caddyfile`), the API's
  `BASE_URL`, `AUTH_RP_ID` (the WebAuthn relying-party id), and the single
  entry in `AUTH_ALLOWED_ORIGINS` (the CSRF origin allow-list). Changing it
  after passkeys are enrolled **invalidates every passkey** — the RP id is
  bound into the credential — so pick the final hostname before step 7.
- `EXTRA_ALLOWED_ORIGINS` — optional, comma-separated, appended to
  `AUTH_ALLOWED_ORIGINS`. Only for a second origin on the **same registrable
  name** (a different port, or a subdomain of `PUBLIC_HOST`). It is _not_ a way
  to add the Tailscale MagicDNS name: WebAuthn §7.1 requires every allowed
  origin's host to equal `AUTH_RP_ID` or be a subdomain of it, and
  `@core/config` enforces that at boot — `<node>.<tailnet>.ts.net` alongside
  `personalfi.lan` refuses to start, by design, rather than failing later in
  the browser. If you want passkeys over Tailscale, set `PUBLIC_HOST` to the
  tailnet name and reach the box by that name on the LAN too.

### 4. Bring the stack up

```bash
just build
just up
docker compose ps        # everything healthy? the P0-6/-7 evidence in
                          # docs/evidence/phase-0/wp0.4-container-hardening.md
                          # is what "healthy" is checked against
```

### 5. Trust the internal CA (LAN mode)

Caddy's internal CA issues a real certificate for `personalfi.lan` with no
ACME and no public DNS — but your browser doesn't trust that CA until you
tell it to.

```bash
just trust-ca
```

Then import `personalfi-ca.crt` into your OS/browser trust store (exact
steps vary by OS — Arch: `trust anchor personalfi-ca.crt` as root, or import
via your browser's certificate settings). Add `personalfi.lan` (or whatever
`PUBLIC_HOST` is) to `/etc/hosts` pointing at the bind address.

### 6. Enabling remote access (Tailscale Serve + MagicDNS)

D12: zero public ingress by default; remote access is Tailscale Serve,
**not** a compose service — Tailscale runs on the host and only needs a
route to whatever Caddy publishes on the bind address.

```bash
# One-time, on the host:
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up
# In the Tailscale admin console: enable MagicDNS and HTTPS certificates
# for your tailnet (Settings -> DNS -> "Enable HTTPS certificates" — this
# is what lets `tailscale serve` mint a real Let's Encrypt certificate for
# your <node>.<tailnet>.ts.net name).

tailscale serve --bg --https=443 http://127.0.0.1:${PROXY_HTTP_PORT:-80}
```

Choose a bland Tailscale node name — it appears in Certificate Transparency
logs once a cert is issued for it, so `chris-personalfi-prod` tells an
attacker more than `node7` does. The bank OAuth redirect URI
(`https://<node>.<tailnet>.ts.net/link/oauth`) only needs to be reachable
from a browser during the Link flow, never from the public internet — this
is what makes Tailscale-only sufficient (D12, verified 2026-09-10).

### 7. Create the account holder

```bash
just bootstrap-user name="Chris" timezone="America/New_York"
```

This prints a one-time passkey-enrolment link. Open it, enrol at least two
authenticators (D21), and save the ten recovery codes somewhere that is not
this host.

---

## Upgrade

```bash
git pull
just build          # rebuild api/backup/proxy images against the new source
just backup          # take a fresh backup before touching anything running
docker compose up -d --wait   # migrator runs to completion before api/worker start
docker compose ps
```

The `migrator` service is `restart: "no"`, gated into the dependency graph via
`depends_on: {condition: service_completed_successfully}` on `api` and
`worker` — neither starts against a mid-migration schema. If a migration
fails, `api`/`worker` simply never start; `docker compose logs migrator` has
the reason, and the previous image tag is still on disk to roll back to
(`docker compose up -d` with `PERSONALFI_VERSION` pinned to the prior value).

A Postgres **major-version** upgrade (e.g. 18 -> 19) is a dump/restore
project, not a `docker compose up` — take a backup, stand up the new major
version against a fresh volume, `just restore-drill`-style restore into it,
verify, then cut over. Renovate is configured to require manual approval for
this (`renovate.json`'s `postgres` package rule) rather than proposing it as
a routine bump.

---

## Backup

Nightly and automatic: the `backup` service's `backup-loop.sh` runs
`pg_dump -Fc | age --encrypt` once a day (`BACKUP_HOUR_UTC`, default 02:00
UTC) and prunes anything older than `BACKUP_RETENTION_DAYS` (default 30) from
the local `backups` volume. If `RCLONE_REMOTE` is set (e.g.
`b2:personalfi-backups`), it also pushes to Backblaze B2.

On demand:

```bash
just backup
```

The backup container holds only the age **public** key (`secrets/age_recipient`)
— it can produce backups it cannot itself decrypt, which is the point (a
ransomware actor who compromises this container gets nothing from the backups
it already made). The plaintext dump exists only inside the container's `/tmp`,
which is a 256 MB **tmpfs** (`compose.yml`), long enough to be verified; it
never touches a disk and is deleted before the script exits.

### What "successful" means, and how you find out when it isn't

Every run must clear four bars before it counts (`docker/backup/backup.sh`):

1. `pg_dump` exits 0 — captured explicitly, not through a pipeline;
2. the dump is at least `MIN_DUMP_BYTES` (1024) bytes;
3. `pg_restore --list` parses it and finds at least one restorable object;
4. only then is it encrypted, `mv`d into place, and only then is anything old
   pruned. **A failed backup never deletes a good one.**

The run writes its outcome to a status file that the container healthcheck
reads, so `docker compose ps` tells the truth:

```bash
docker compose ps                         # backup: "unhealthy" if the last run failed
docker compose exec backup /usr/local/bin/healthcheck.sh
# healthy: last backup 4s ago: /backups/personalfi-...dump.age (66131 plaintext bytes, 154 objects)
# unhealthy: last backup attempt reported 'fail' 0s ago: backup.sh exited 1 (see container logs)
```

It also goes unhealthy when the last _successful_ backup is older than
`BACKUP_MAX_AGE_SECONDS` (default 26 h — the nightly cadence plus slack), so a
loop that is alive but no longer backing up is visible too. Before the Phase 0
gate (H-2) the healthcheck only asked whether the loop process existed, which
stays true through thirty consecutive silent failures.

---

## Restore

**Disaster recovery — restoring into the live `db` service.** This is
destructive; `restore.sh` runs `pg_restore --clean --if-exists`, which drops
and recreates everything in the target database.

Because of that, `restore.sh` **refuses** to run when `PGDATABASE` equals the
production database name (`personalfi`, overridable via `PRODUCTION_DATABASE`)
unless you pass `FORCE_RESTORE=1`. With the flag it prints the full list of
tables it is about to drop, waits five seconds, and then proceeds:

```
restore: target personalfi@db; --clean --if-exists will DROP and recreate these:
    BASE TABLE  public.users
    BASE TABLE  public.sessions
    ... (20 tables)
restore: archive contains 154 restorable object(s)
restore: FORCE_RESTORE=1 given; proceeding against the production database in 5s (Ctrl-C to abort)
```

Without the flag it exits 1 and points you at `just restore-drill`.

```bash
docker compose stop api worker           # stop anything writing to the db
docker cp /path/to/your/age-identity.txt /tmp/age-identity.txt   # onto the host, not into the repo
chmod 644 /tmp/age-identity.txt          # see note below — the container reads this as uid 10002, not you
docker compose run --rm \
  -v /tmp/age-identity.txt:/run/age_identity:ro \
  -e AGE_IDENTITY_FILE=/run/age_identity \
  -e FORCE_RESTORE=1 \
  backup /usr/local/bin/restore.sh /backups/personalfi-<timestamp>.dump.age
shred -u /tmp/age-identity.txt
docker compose up -d
```

`AGE_IDENTITY_FILE` (the private key) is deliberately never a secret declared
in `compose.yml` — see `docker/backup/backup.sh`'s header. It only ever
exists on the host filesystem for the duration of a real restore or a drill,
supplied by whoever is running the command, from wherever it's actually kept
(password manager export, offline copy).

**Make it world-readable before mounting it (`chmod 644`), not just
owner-readable.** This is a plain bind mount, not a compose secret, and
Docker does not remap file ownership for either mechanism — the `backup`
image runs as uid 10002 regardless of which host user ran `docker compose
run`, so a file only its owner can read fails to open from inside the
container with `age: error: ... permission denied`. The exposure window is
the few seconds this command runs for; `shred -u` immediately after closes
it. (The same non-remapping behaviour is why every file under `./secrets/`
is `chmod 444`, not `400` — see "Create secrets" above.)

## Restore drill

P0-11 / D24: an untested backup is a rumour. Run this monthly at minimum, and
after any change to `docker/backup/*.sh` or the schema.

```bash
export AGE_IDENTITY_FILE=/path/to/your/age-identity.txt
chmod 644 "$AGE_IDENTITY_FILE"   # see "Restore" above — the container reads this as uid 10002
just restore-drill
```

This decrypts and `pg_restore`s the newest backup into a **throwaway**
Postgres container (never the live `db` service), boots a throwaway `api`
container against it, hits `/ready`, and compares table counts and the latest
applied migration against the live database. It tears down everything it
created on exit, pass or fail, and writes
`docs/evidence/ops/restore-drill-<date>.md` with a **PASS/FAIL verdict**.

It asserts, and exits non-zero if any of these fails (H-5 — it used to collect
these numbers and never compare them, so the committed evidence read
"Restored db table count: 0 ... /ready: fail" and the recipe exited 0):

- restored table count > 0,
- restored table count == live table count,
- restored `schema_migrations` max version == live,
- `/ready` returns 200 from an api container pointed at the restored database.

A green run looks like this:

````
- Backup restored: `/backups/personalfi-20260913T024827Z.dump.age` (66346 encrypted bytes)
- Restored db table count: 20        - Live db table count: 20
- Restored db schema_migrations: 0003 - Live db schema_migrations: 0003
- API /ready against restored db: pass (200 from /ready)
**Verdict: PASS**
``` It needs `docker compose up` (or
at least `create`) to have run at least once, so the `backend` network and
`backups` volume already exist.

---

## Master-key rotation

Not yet implemented as a `just` target — this is a pointer, not a procedure,
because rotating the KEK means re-encrypting every envelope-encrypted column
in place (03 §2, D5), which is application code that ships with the identity
context, not an infrastructure script. When it lands, it will live at
`just rotate-master-key` and this section gets the real procedure. Until
then: **do not hand-edit `secrets/master_key` on a box with existing
encrypted data** — the scope rule (D5) is "key loss = re-link providers,
never = lose the ledger," and that only holds if the rotation path is the
one the identity context actually implements, not a file swap.

---

## Panic button (outline)

For "I think this box or a provider credential is compromised, stop
everything now":

1. `docker compose stop api worker proxy` — stops serving traffic and
   running background jobs immediately. `db` and `backup` stay up so a final
   backup can still be taken.
2. `just backup` — one last encrypted backup before anything else changes.
3. Revoke the exposed credential at the source: Plaid dashboard (remove the
   Item), Coinbase (revoke the CDP key), any LLM API key in use. These are
   the only credentials this app ever holds that another party can act on.
4. Rotate `secrets/pg_password` and `secrets/database_url` (new random
   password, `docker compose down && docker compose up -d` to pick it up —
   Postgres's own user password needs `ALTER ROLE personalfi WITH PASSWORD
'...'` run against the old instance first if you're not also restoring
   from backup).
5. If the host itself (not just a credential) is suspect: do not trust
   anything on it. Restore the latest backup onto a **new** host from the
   offline age identity and a fresh LUKS2 volume, then work through step 3
   again before reconnecting anything live.

This is deliberately not automated into one script: the right response
differs enormously between "a Plaid token leaked" and "someone has a shell
on this box," and a single `just panic` button that always does the same
four things regardless of which is actually true is worse than a checklist a
human reads under pressure.

---

## Before you push: `just verify`

`just check` is typecheck + lint + tests. It does **not** run gitleaks, trivy,
the license gate, or the compose-hardening gate — those were CI-only, a green
`just check` was read as "CI will pass" for all of Phase 0, and CI was red at
HEAD the whole time while three of those gates were themselves broken. So:

```bash
just verify     # = just check, plus every gate CI runs, same pinned digests
````

In order, `just verify` runs:

| Step                                   | Matches CI job              |
| -------------------------------------- | --------------------------- |
| `just check` (typecheck, lint, test)   | `typecheck`, `lint`, `test` |
| gitleaks, full history, pinned digest  | `gitleaks`                  |
| license gate + `THIRD_PARTY.md` drift  | `license-gate`              |
| compose hardening self-test + sweep    | `compose-hardening`         |
| `.trivyignore` expiry sweep            | `trivy-fs` (first step)     |
| `trivy fs` (vuln + secret + misconfig) | `trivy-fs`                  |

It needs Docker and, on a cold cache, a network. What it does not cover is the
per-image `trivy image` scan and SBOM generation — `just scan` and `just sbom`
do those, and they rebuild the images first, which is minutes rather than
seconds. Run those before a release, not before every push.

The compose-hardening step deliberately runs twice: once with `--self-test`,
which feeds a deliberately hostile compose file
(`scripts/fixtures/compose-hostile.yml`) through the gate and asserts that all
seventeen rules fire, and once over the real files. The gate this replaced
passed a privileged, host-networked, Docker-socket-mounting service for a
month, so "the check ran and said PASS" is not evidence unless the check has
been seen failing something.

---

## Resource envelope

Limits are set per service in `compose.yml` (`deploy.resources.limits`). They
are _limits_, not reservations — steady-state usage is far below these — but
the sum is what the host must be able to give up at once.

| Service      | CPU | Memory    | Why that number                                                                                                                                                                                                                                                                     |
| ------------ | --- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api`        | 2.0 | **1536M** | Argon2id KEK derivation allocates 1 GiB in one buffer at boot (P0-2 floor). At 768M the kernel OOM-killed it at exit 137 with no output, and because `/auth/unlock-state` derives lazily, an unauthenticated GET was a remote kill switch.                                          |
| `worker`     | 1.0 | **512M**  | Does **not** derive the KEK today — `apps/api/src/worker.ts` constructs no `SecurityRuntime`. **Raise to 1536M in the same PR that makes the worker unlock the keyring** (first sync job that decrypts a provider credential), or it will OOM at exit 137 exactly like the api did. |
| `db`         | 2.0 | 1G        | `shared_buffers=256MB`, `max_connections=40`, plus 256M `shm_size`.                                                                                                                                                                                                                 |
| `proxy`      | 0.5 | 128M      | Caddy plus a static bundle.                                                                                                                                                                                                                                                         |
| `backup`     | 0.5 | 256M      | `pg_dump` + `age`; the plaintext dump lives in a 256M tmpfs.                                                                                                                                                                                                                        |
| `migrator`   | —   | —         | Runs to completion before api/worker start; no limit set.                                                                                                                                                                                                                           |
| placeholders | 0.1 | 32M       | `sleep infinity`, profile-gated, off by default.                                                                                                                                                                                                                                    |

Worst case with everything running and api cold-starting: ~3.4 GiB of limits,
of which the real simultaneous peak is api's 1 GiB Argon2 spike plus Postgres's
~1 GiB — comfortably inside the 2 GB whole-stack target in master plan §3.4
_while the worker stays at 512M_. When the worker starts deriving the KEK, two
simultaneous 1 GiB spikes exceed that target: the levers are staggering the
derivations or `KEK_ARGON2_MEMORY_KIB` (a security parameter with a production
floor — do not lower it casually), not the container limits.

---

## Troubleshooting

**`age: error: ... permission denied` during restore or a restore drill.**
`AGE_IDENTITY_FILE` is owner-readable only. It needs `chmod 644` — see
"Restore" above for why (Docker bind mounts and file-based secrets both
preserve the host file's own uid/mode as-is; the `backup` container reads it
as uid 10002, not whichever host user ran the command).

**`db` container fails to start / "database files are incompatible with
server" / permission errors on the data directory.** `postgres:18`'s own
image stores data in a major-version subdirectory and expects the _volume
mount point one level up_, at `/var/lib/postgresql` — **not**
`/var/lib/postgresql/data` (the path older Postgres images and older
tutorials use). `compose.yml` and `compose.dev.yml` both mount
`pgdata:/var/lib/postgresql` for exactly this reason; if you're hand-rolling
a `docker run` for debugging, mounting at `.../data` instead makes the
container refuse to start with a confusing message rather than an obvious
one.

**`proxy` exits immediately with "operation not permitted."** This means
something rebuilt or replaced `docker/caddy.Dockerfile`'s image with stock
`caddy:2-alpine` while `compose.yml`'s `cap_drop: [ALL]` +
`no-new-privileges:true` are still set. Stock Caddy's binary carries a
`cap_net_bind_service` file capability (`getcap /usr/bin/caddy`); with an
empty capability set and `no-new-privileges`, the kernel refuses to apply it
at `execve`, and Caddy never starts. `docker/caddy.Dockerfile` strips that
capability at build time (this proxy only ever binds unprivileged container
ports 8443/8080, so it never needed the capability) — rebuild with `just
build` rather than pulling the upstream image directly.

**`docker compose up` fails with "secret ... file not found."** One of
`./secrets/*` is missing. See "Create secrets" above — every filename is
exact and extension-less (`secrets/master_key`, not `secrets/master_key.txt`).

**A container is `unhealthy` in `docker compose ps`.** `api`/`worker`/
`migrator` depend on `db`'s healthcheck and, for `api`/`worker`, on
`migrator` completing successfully first. `docker compose logs migrator` is
almost always the first thing to check — a failed migration is the most
common reason `api` never becomes healthy on a fresh box.

**`migrator` exits with `configuration is invalid ... ROLE: Invalid option:
expected one of "api"|"worker"`.** A known gap as of this writing:
`packages/config/src/schema.ts`'s `ROLE` schema has not yet been updated to
include `'migrator'` alongside `'api'`/`'worker'`, even though `compose.yml`
sets `ROLE: migrator` on that service (D13's three-role single image) and
`docker/entrypoint.mjs` already dispatches on it correctly. Until
`packages/config` adds `'migrator'` to that enum, the migrator (and
therefore `api`/`worker`, which both depend on it completing) cannot start
from a fresh clone. Not something this file can fix — it lives in a
different package's schema.

**`just restore-drill` says "backend network or backups volume not found."**
Run `docker compose up` (or `docker compose create`) at least once first —
the drill discovers both by their compose-assigned labels rather than
guessing a project name, and those labels only exist once compose has
created the resources.

**Browser shows a certificate warning for `personalfi.lan`.** You haven't
imported the internal CA yet, or you're hitting the box from a device you
haven't imported it onto. See "Trust the internal CA" above. This is
expected and correct behaviour, not a bug — an untrusted-by-default internal
CA is what makes a stray misconfigured client fail loudly instead of quietly
trusting an unexpected certificate.
