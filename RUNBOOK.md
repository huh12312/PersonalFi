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

# 6. Plaid (optional — C-3, gate-security-review.md §2.2 F-2). `compose.yml`
#    declares `plaid_client_id`, `plaid_secret` and `plaid_env` as file
#    secrets on `api` and `worker` (never on `proxy` or `backup` — neither
#    has any use for a Plaid credential), and Compose refuses to start a
#    container that mounts a secret whose host file does not exist — there
#    is no "optional bind mount" in its secret model. So these three are
#    created **empty** unconditionally, whether or not this deployment is
#    using Plaid yet:
touch secrets/plaid_client_id secrets/plaid_secret secrets/plaid_env
chmod 444 secrets/plaid_client_id secrets/plaid_secret secrets/plaid_env
#    `packages/config` treats a zero-length secret file exactly as it treats
#    a missing one (`load.ts`'s `loadConfig`, tested in `load.test.ts`), so
#    three empty files boot exactly as three absent ones would: the API logs
#    "plaid not configured; connector not registered" and `GET /connectors`
#    omits Plaid. Nothing else to do until you actually want Plaid.
#
#    To actually enable it: sign up at https://dashboard.plaid.com, create a
#    Sandbox (then, later, Production) API key, and write the Client ID and
#    secret into the two files above. `just harden-secrets` now covers these
#    three (gate-security-review.md §8.2 N-1 / §8.11 D-4 — it did not before,
#    and a deployment that hardened its secrets per an earlier version of
#    this sentence crash-looped both `api` and `worker` on EACCES the moment
#    Plaid was enabled). Run it after writing real content here, same as
#    every other secret:
#      echo -n '<client id>'      > secrets/plaid_client_id
#      echo -n '<secret>'         > secrets/plaid_secret
#      echo -n 'sandbox'          > secrets/plaid_env   # or 'production' —
#                                                        # see PLAID_ALLOW_PRODUCTION
#                                                        # below; D16.
#    Then, in `.env`: set `PLAID_ENABLED=true` (so `docker/Caddyfile` widens
#    its CSP for `cdn.plaid.com`/`sandbox.plaid.com`/`production.plaid.com` —
#    C-2), and, only if you need an OAuth institution (most US banks do not),
#    `PLAID_REDIRECT_URI=https://<PUBLIC_HOST>/link/oauth` — see
#    `.env.example` for both. `@core/config` refuses to boot if the redirect
#    URI is set but is not `https` or does not share an origin with
#    `AUTH_ALLOWED_ORIGINS`.
#
# 7. Insights advisor token secret (optional — wp2.6-insights.md §6, open item
#    5; docs/evidence/phase-2/wp2.w-wiring.md). `@ctx/insights` keys every
#    merchant pseudonym it hands a `builtin`/`local_model` advisor from this
#    value, mixed with the user id; rotating it re-pseudonymises every
#    merchant and orphans every `MERCHANT_…` reference an evidence row already
#    stored. File-only, same posture as `master_key` — never an env var, never
#    read from `NOTIFICATIONS_ALLOWED_HOSTS`'s neighbourhood in `.env`.
#    `compose.yml` declares it as a file secret on `api` and `worker` only
#    (never `proxy` or `backup`), and — like the three `plaid_*` secrets above
#    — Compose refuses to start a container that mounts a secret whose host
#    file does not exist, so it is created **empty** unconditionally, whether
#    or not this deployment is opting into insights yet:
touch secrets/advisor_token_secret        # leave empty to stay opted out
chmod 444 secrets/advisor_token_secret
#    `packages/config` treats a zero-length secret file exactly as it treats a
#    missing one (`load.ts`'s `loadConfig`, tested in `load.test.ts`), so an
#    empty file boots exactly as an absent one would: `apps/api/src/
#    modules.ts`'s `insightsModule` registers `module.insights`'s flag with no
#    consumer, no job and no schedule. Nothing else to do until you actually
#    want insights.
#
#    To actually enable `module.insights`, write a high-entropy value instead,
#    then run `just harden-secrets` (it covers this file the same way it
#    covers the three `plaid_*` secrets):
openssl rand -hex 32 > secrets/advisor_token_secret
chmod 444 secrets/advisor_token_secret

# 8. Phase 3's seven provider keys (all optional — 03 §6: "Phase 3 completes
#    with zero keys; it just cannot prove freshness"). `compose.yml` declares
#    all seven as file secrets on `api` and `worker` only — never `migrator`,
#    which applies DDL and will never dial a provider — and Compose has no
#    optional-secret model, so like the plaid_* trio and advisor_token_secret
#    above they are created **empty** unconditionally. `packages/config` treats
#    a zero-length file exactly as a missing one, so seven empty files boot
#    exactly as seven absent ones would.
touch secrets/tiingo_api_key secrets/fred_api_key secrets/coingecko_api_key \
      secrets/openfigi_api_key secrets/coinbase_key_name \
      secrets/coinbase_private_key secrets/etherscan_api_key
chmod 444 secrets/tiingo_api_key secrets/fred_api_key secrets/coingecko_api_key \
          secrets/openfigi_api_key secrets/coinbase_key_name \
          secrets/coinbase_private_key secrets/etherscan_api_key
#
#    What each one buys, and what happens without it:
#
#      tiingo_api_key        equity/ETF/fund EOD closes. Absent -> that adapter
#                            is not registered at all; the 03:45 refresh runs,
#                            asks nobody, and records that honestly.
#      fred_api_key          macro series and FX. FRED has NO header auth, so
#                            this key travels in every request's query string —
#                            which is why @ctx/integrations redacts every
#                            provider-authored string before logging it or
#                            storing it in market_data_runs.
#      coingecko_api_key     crypto prices (Demo plan).
#      openfigi_api_key      symbol -> FIGI mapping. Also answers anonymously,
#                            at 10 jobs per batch instead of 100, so absence
#                            here degrades rather than disables.
#      coinbase_key_name     the CDP API key name, `organizations/{org}/apiKeys/
#                            {key}`. All-or-nothing with the next one.
#      coinbase_private_key  the CDP **Ed25519** key (EdDSA — ES256 is Plaid's
#                            *webhook* algorithm; 01 §3.2 warns against
#                            cargo-culting between the two). Create the CDP key
#                            with the `view` permission only: the connector
#                            asserts `key_permissions` at startup and refuses a
#                            key that can trade.
#      etherscan_api_key     the watch-only wallet connector's ETHEREUM leg
#                            only. Its BITCOIN leg needs no key — addresses are
#                            derived locally from the xpub/ypub/zpub and
#                            Blockstream Esplora is unauthenticated — so with
#                            no file here the connector is still registered and
#                            BTC wallets work; an ETH balance request refuses
#                            by name (CONFIG_ERROR naming this file) rather
#                            than dialling.
#
#    Watch-only wallets, independent of any key above (Phase 3 gate C-2,
#    closed by WP 4.12a): a funded wallet's HOLDINGS sync and value — the
#    on-chain quantity, priced through the same ladder a Coinbase sighting of
#    the same asset joins onto. Its account BALANCE still cannot sync:
#    `syncBalances` has no fiat quote for a wallet and refuses any non-zero
#    balance rather than fabricate one, so the account's own balance figure
#    (as opposed to its holdings and their value, which are correct) stays
#    unset until `ProviderBalanceFact.current` is widened or the
#    account-balance path is changed to value from holdings instead.
#
#    To enable any of them, write the real value and re-run `just
#    harden-secrets` (it covers all seven):
#      echo -n '<token>' > secrets/tiingo_api_key
#
#    `CRYPTO_ALLOWED_HOSTS` and `MARKET_DATA_ALLOWED_HOSTS` in `.env` can only
#    NARROW which hosts these adapters may reach; neither can add one.
#
#    Watch-only wallet privacy (Phase 3 gate C-13,
#    docs/evidence/phase-3/gate-security-review.md §4.1(c)): every address
#    this connector derives from a linked xpub/ypub/zpub, and every 0x
#    address linked directly, is queried against `blockstream.info` from
#    THIS HOST'S IP over its public Esplora API — there is no self-hosted
#    Esplora option today. Blockstream can therefore link every derived
#    address of every watch-only wallet an install has ever linked to that
#    IP. This is inherent to the watch-only design, not a bug this release
#    fixes; an operator who needs to avoid it needs a self-hosted or
#    Tor-routed block explorer, which is out of scope here.
#
#    `wallet_addresses.descriptor` (the xpub/ypub/zpub or 0x address) is
#    sealed with SecretBox once a KEK is threaded into the composition
#    root's `createWalletRpcRuntime` calls (migration 0027; not done by
#    default in this release — see `docs/evidence/phase-4/
#    wp4.12c-gate-conditions.md` §1). Until an operator's deployment applies
#    that wiring, a newly linked wallet's descriptor is stored in the clear,
#    exactly as every watch-only wallet's descriptor has been since WP 3.6 —
#    a database dump or backup carries it, and with it every address that
#    wallet has ever used or will use.
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
# -r-------- 1 10001 10001 plaid_client_id   api / worker
# -r-------- 1 10001 10001 plaid_secret      api / worker
# -r-------- 1 10001 10001 plaid_env         api / worker
# -r--r----- 1     70  10002 pg_password     postgres (owner) + backup (group)
# -r-------- 1 10002 10002 age_recipient     backup
```

`just hardening-check` (part of `just verify`) then runs
`scripts/check-secret-ownership.sh` against these files: it re-derives the
expected owner/mode for every secret from `compose.yml`'s own `secrets:`/
`user:` declarations, so a secret this recipe forgets again — the same way it
forgot `plaid_*` the first time — fails loudly instead of crash-looping the
next `docker compose up`.

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

If step 2 wrote real content into `secrets/plaid_client_id`/`plaid_secret`,
also set `PLAID_ENABLED=true` (and, for an OAuth institution,
`PLAID_REDIRECT_URI`) — see `.env.example`'s Plaid section and step 2, item 6,
above. Leave both unset for a deployment with no Plaid secrets yet; the
defaults (`PLAID_ENABLED=false`, no redirect URI) are correct for that case.

`NOTIFICATIONS_ALLOWED_HOSTS` — leave unset (deny-all) until `module.notifications`
is turned on and you know which ntfy topic host / SMTP relay it should be
allowed to reach. Comma-separated, lowercase hostnames only — no wildcard, no
IP literal; `@core/config` refuses to boot with either. See `.env.example`.

**This list is a trust decision, not a formality (condition C-4,
gate-security-review.md §4, finding G2-2).** Every notification body carries
amounts and merchant names, so naming a host here means handing whoever
controls that host every notification this deployment ever sends. The
egress guard refuses a private, loopback or link-local address independently
of this list and is not configurable to allow one — even `NOTIFICATIONS_ALLOWED_HOSTS=db`,
tried during the Phase 2 gate walk, was refused `private_address` — so this
setting can only ever widen reach to a **public** host, and only to one you
actually operate or otherwise trust with that data.

**Phase 5 (05-phase-5-dispatch.md §2/§4 item 9)** adds seven keys, all
optional and all defaulted for a deployment that has not opted into the
local model yet — see `.env.example`'s own "Phase 5 wiring" section for each
one's default:

- `ADVISORS_ENABLED` — kill switch 1 of WP 5.1's four-level advisor ladder,
  the global on/off for every advisor. Defaults to `true`.
- `LOCAL_MODEL_ENDPOINT` — the `local_model` advisor kind's endpoint,
  feature-detected the same way Plaid is: leave it unset and no local model
  advisor is registered (kill level 2). A single-label compose service name
  and port, e.g. `ollama:11434`.
- `LOCAL_MODEL_NAME` and `LOCAL_MODEL_DIGEST` — both **required** once
  `LOCAL_MODEL_ENDPOINT` is set; `@core/config` refuses to boot otherwise.
  The digest is `sha256:` followed by 64 lowercase hex characters, copied
  from what `GET /api/tags` reports for the pulled model — the model is
  pinned by digest like an image (05 §3 WP 5.2).
- `LOCAL_MODEL_TIMEOUT_MS` — defaults to `180000`; never configurable above
  the platform's own advisor-run ceiling of `300000`.
- `LOCAL_MODEL_ALLOW_REMOTE` — defaults to `false`; Ollama stays on this
  host unless explicitly allowed off it, and then only over `https` (05 §6
  Q2).
- `MONTE_CARLO_MAX_CONCURRENT` — the Monte Carlo concurrency cap. Defaults
  to `8`.

### 4. Bring the stack up

```bash
just build
just up
docker compose ps        # everything healthy? the P0-6/-7 evidence in
                          # docs/evidence/phase-0/wp0.4-container-hardening.md
                          # is what "healthy" is checked against
```

**`worker` has no account holder yet at this point** — steps 5 and 6 below can
take as long as you need. It logs `no account holder yet; polling for one`
once and then idles, polling in place, until step 7 enrols one; its
healthcheck stays `healthy` the whole time (D-3's liveness heartbeat touches on
every poll). It does **not** restart while it waits, however long that is —
`docker compose ps` / `docker inspect --format='{{.RestartCount}}' <container>`
should read `0` from boot through step 7 and beyond. (Condition C-1,
`docs/evidence/phase-3/gate-security-review.md` §3.1/§6, G3-1: earlier builds
returned from the worker's start-up function while idle, which let the
process exit once the database pool's idle connections timed out — the
Compose restart policy then masked it as a roughly 30-second
exit-and-restart loop rather than the "idle until enrolled" the log line
always claimed. A worker that restarts here on the current build is a
regression, not a known quirk.)

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

This prints a one-time passkey-enrolment link of the form
`https://<PUBLIC_HOST>/register#token=...`. Open it in a browser that trusts
the internal CA (step 5), enrol at least two authenticators (D21), and save the
ten recovery codes somewhere that is not this host.

The token travels in the URL **fragment**, which is never sent to a server — so
it cannot land in an access log, a `Referer` header, or a proxy cache the way a
query parameter would. Copy the whole line, including the `#`.

Because the stack is up at this point, the recipe runs the bootstrap script
**inside the `api` container** and says so. It has to: `secrets/database_url`
points at `db:5432`, a compose-internal name, and only the proxy publishes a
port (P0-3), so the host has no route to Postgres by design. Running it on the
host would fail with `getaddrinfo ENOTFOUND db`. With the stack down, the same
recipe falls back to the host and the local dev database, which is what
`just dev` wants.

---

## Export and import (condition C-4)

`GET /export` (step-up required) downloads the whole database as a JSONL
bundle. `?encrypt=true` pipes it through `age` first, encrypted to
`secrets/age_recipient` (**singular** — the same recipients file step 2, item
4 above already has you write for backups, so nothing new to create if
backups are already configured; earlier releases of this file and of
`bundle.ts`'s own default said `age_recipients`, plural, which no `compose.yml`
service ever mounted — condition C-5, `gate-security-review.md` G3-4, fixed
one recipients filename everywhere).

**As of WP 4.12b, C-5:** `docker/api.Dockerfile`'s runtime stage installs
`age` (pinned, alongside `tini`), and `compose.yml` mounts the `age_recipient`
secret on `api` as well as on `backup` — the export route runs in `api`, and
until this change it had no way to read the recipients file even once the
binary existed. If this secret was already hardened on this host under the
old, single-consumer state (`just harden-secrets`'s previous behaviour: owner
`10002:10002`, mode `0400`), `scripts/check-secret-ownership.sh` will now
correctly report it as a violation until you re-run `just harden-secrets`
(needs sudo) — that recipe now chowns `age_recipient` to `10001:10002` at
mode `0440` (two consumers, the same shape `pg_password` already uses). This
is the intended signal, not a regression: the file's real permissions have to
change to match the new mount, and the check is what makes that visible
instead of a silent `EACCES` the first time someone downloads an encrypted
export.

**Not re-walked live by this work package:** downloading `?encrypt=true`
from a running `api` container built from this Dockerfile and decrypting the
result with `age` — that needs a rebuilt image and the compose stack up,
which this work package's rules kept it from doing. `apps/api/test/db/
export-encrypt.test.ts` (WP 3.13) and `export-encrypt-age-absent.test.ts`
(WP 4.12b) prove the code path — the happy path against a real `age` binary
on the dev host, and the `age`-absent refusal in isolation — but the gate
walk item ("download, decrypt with `age`, diff against the plaintext bundle")
against the actual shipped image is still owed.

`POST /import` refuses to run against an instance that already has user
data (`409 export.instance_not_empty`) — it is a same-schema restore, not a
merge. The target instance still needs its own account holder **enrolled
first** (step 7 above) before the import call, because every route the
import needs — including `POST /import` itself — requires a session, and a
freshly-migrated database has no user and therefore no session to authenticate
with. This is not a defect (gate finding G2-6, gate-security-review.md §4):
bring the target up, run `just bootstrap-user` and enrol a passkey exactly as
you would for a first install, _then_ import.

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
2. `pg_restore --list` parses the archive (rejects a truncated or non-archive
   file outright);
3. that listing has at least `MIN_TOC_ENTRIES` (10) restorable objects _and_
   includes the `schema_migrations` table by name — proof this is a real dump
   of our schema, not an empty database or a near-empty stub. (An earlier
   version gated on raw dump size instead; that rejected a genuinely valid
   backup on a fresh install's first night, before any user data existed —
   see `docker/backup/backup.sh`'s header for finding 9.)
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

### Fresh install: why `backup` doesn't flap unhealthy on a cold `docker compose up`

`backup`'s startup run used to race `migrator`: on a truly empty database, the
first dump had no tables, `backup.sh`'s structural guard correctly refused to
promote it (`0 object(s)` below `MIN_TOC_ENTRIES`), and `docker compose ps`
showed `backup (unhealthy)` until the next nightly window — a real control
firing on a startup-ordering bug, not a backup problem (R-13,
`gate-security-review-2.md`). Two independent fixes close this:

1. `compose.yml`: `backup` now `depends_on: migrator: service_completed_successfully`,
   so on a normal `docker compose up` the `backup` container is not even
   created until migrations have run.
2. `docker/backup/backup-loop.sh`: before its startup attempt, the loop
   additionally polls `information_schema.tables` for `schema_migrations`
   (up to `BACKUP_SCHEMA_WAIT_SECONDS`, default 600s) — defense in depth for
   anyone who starts or restarts `backup` on its own (`--no-deps`, or after
   wiping just the `pgdata` volume) and bypasses the compose-level ordering.

Until the first backup completes, `docker compose ps` correctly shows
`backup (health: starting)`, not `unhealthy` — the `starting` status file
state and `BACKUP_START_GRACE_SECONDS` (default 900s) cover the time spent
waiting on the migrator plus the dump itself. Only a backup attempt that
actually fails — as opposed to one that hasn't run yet — reports unhealthy.
On a fresh `docker compose up -d`, expect `backup` to go `healthy` within a
few minutes with no operator action; see
`docs/evidence/phase-0/gate-remediation-4.md` for the timed proof.

---

## What survives a disconnect

**A disconnected provider's sealed credential is not necessarily gone from
every copy of the database the moment `DELETE /connections/{id}` returns 200.**

`disconnectConnection` (`packages/contexts/connections/src/connections.ts`)
sets `connections.sealed_credentials = NULL` in the **live** database
immediately, unconditionally — that half always happens, and is correct: it
is what "disconnect" means from the ledger's own point of view, and it happens
even when the provider itself could not be reached to revoke the token
(`revokedAtProvider: false`).

It does not, and cannot, reach into a backup already taken. This repo's
nightly backup (`docker/backup/backup.sh`) is a full `pg_dump`, encrypted with
`age` and retained:

- **`BACKUP_RETENTION_DAYS`, 30 days by default**, on the local `backups`
  volume — a dump taken the night before a disconnect still holds that
  connection's sealed credential (still sealed, still under the KEK — see
  below) for up to thirty more nightly prunes.
- **Indefinitely on Backblaze B2**, if `RCLONE_REMOTE` is set (`RUNBOOK.md`
  "Backup"): `backup.sh` `rclone copy`s every dump it takes and never deletes
  one from B2 — object lock (D24) is the point, and this application does not
  and should not hold the ability to delete an already-written backup. B2's
  own bucket-level object-lock retention policy, not `BACKUP_RETENTION_DAYS`,
  governs how long a pushed copy is immutable there; that policy is set on the
  bucket when it is created, outside anything this repo configures.

**This is not a plaintext exposure.** The dump itself is `age`-encrypted end
to end, and the credential inside it is _itself_ sealed under the KEK
(`SecretBox`, D5) — two independent layers, neither of which a disconnect
touches or needs to touch. A backup that leaks discloses nothing about a
disconnected connection's credential that it did not already disclose about
every _connected_ one.

**Why it is still worth stating plainly, not just filing as "fine":** D5's
scope rule — "key loss = re-link providers, never = lose the ledger" — assumes
the KEK is the _only_ thing standing between a backup and a live provider
token, and a user who clicks "disconnect" reasonably believes the credential
itself is gone everywhere, not just live. Neither is quite true while an old
backup exists.

**What actually retires an old credential: KEK rotation.** The envelope design
(03 §2, D5) is epoch-keyed — each sealed value is bound to the KEK that sealed
it, so rotating the KEK and re-sealing every live row under the new one
changes what unwraps a _live_ row, but does nothing to ciphertext already
frozen inside a `.dump.age` file, because that ciphertext is never touched by
the rotation. A backup taken _after_ a rotation carries only values sealed
under the new KEK; a backup taken _before_ it still needs the _old_ KEK's
epoch to open, and once the old epoch's derivation material is itself
destroyed (not merely superseded — actually deleted, which rotation as
designed does not yet automate; see "Master-key rotation" below, which is a
pointer, not a shipped procedure, as of this writing), no key remaining on the
box can open that old backup's sealed columns at all, disconnected credential
included. Rotation is therefore the operation that actually retires an old
credential from backup exposure, not disconnect, and not the local retention
window lapsing (thirty days after disconnect, the _local_ copy ages out on its
own — B2 does not, absent rotation and destruction of the old epoch's key
material).

**In short:** disconnect stops the credential from being used and clears it
from the live database. If backups matter to your threat model — someone with
read access to `backups/` or the B2 bucket, not read access to this host's
`secrets/master_key` — treat a disconnect as "revoked, pending the backup
retention window and, fully, a KEK rotation," not as "gone."

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
