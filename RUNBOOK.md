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

# 0444, not 0400: Docker Compose's file-secret provider preserves the host
# file's own uid/mode verbatim inside the container rather than remapping it
# to the consuming service's runtime user (verified empirically — `docker
# compose secrets` has no per-service uid/gid/mode override outside Swarm
# mode). db (uid 70), api/worker/migrator (uid 10001), and backup (uid 10002)
# all read secrets from this same directory, so a mode that only the file's
# *owner* (you, on the host) can read fails inside every one of them. The
# actual confidentiality boundary is the 0700 directory above, which only you
# and root can even traverse into — 0444 on the files inside it does not
# weaken that.
chmod 444 secrets/b2_key_id secrets/b2_application_key
```

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
- `PERSONALFI_HOSTNAME` — defaults to `personalfi.lan`. Caddy issues an
  internal-CA certificate for whatever this is set to (`docker/Caddyfile`).

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
`PERSONALFI_HOSTNAME` is) to `/etc/hosts` pointing at the bind address.

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

Backups never touch disk unencrypted at rest: `pg_dump`'s output is piped
directly into `age --encrypt` before it is written (`docker/backup/backup.sh`).
The backup container holds only the age **public** key (`secrets/age_recipient`)
— it can produce backups it cannot itself decrypt, which is the point (a
ransomware actor who compromises this container gets nothing from the
backups it already made).

---

## Restore

**Disaster recovery — restoring into the live `db` service.** This is
destructive; `restore.sh` runs `pg_restore --clean --if-exists`, which drops
and recreates everything in the target database.

```bash
docker compose stop api worker           # stop anything writing to the db
docker cp /path/to/your/age-identity.txt /tmp/age-identity.txt   # onto the host, not into the repo
chmod 644 /tmp/age-identity.txt          # see note below — the container reads this as uid 10002, not you
docker compose run --rm \
  -v /tmp/age-identity.txt:/run/age_identity:ro \
  -e AGE_IDENTITY_FILE=/run/age_identity \
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
container against it, hits `/ready`, and compares table counts and the
latest applied migration against the live database. It tears down everything
it created on exit, pass or fail, and writes
`docs/evidence/ops/restore-drill-<date>.md`. It needs `docker compose up` (or
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
