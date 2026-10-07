<!-- SPDX-License-Identifier: MIT -->

# PersonalFi

A self-hosted, MIT-licensed, single-user personal finance and advisory application. It tracks
spending, budgets, recurring charges and subscriptions, net worth, an investment portfolio and a
retirement plan, across bank, brokerage and crypto accounts. Everything runs in Docker on a machine
you own. Nothing leaves it except the calls you enable (a bank aggregator, a price feed, a
notification host), each limited to a short list of hosts that you can narrow but never widen.

## What it is, and what it is not

**It is** a finance tool for one person on one machine: a ledger you can trust (transfers are not
spending, duplicates are caught, pending charges resolve), budgets, a weekly brief of suggested
actions with the evidence behind each one, and a retirement projection whose assumptions are shown
and sourced. You sign in with a passkey. Every secret is a file, every backup is encrypted, and an
upgrade is two commands.

**It is not** a hosted service, a multi-user product, a tax-filing tool, a trading system or a
source of regulated financial advice. It has no cloud account to sign up for. It does not move
money: connections are read-only. The optional AI narrator runs a model on your own machine and is
off until you turn it on.

Its security posture is documented, including what it does not defend against. Read the
[threat model](docs/security/threat-model.md) and the
[ASVS assessment](docs/security/asvs-assessment.md) before you put real data in it.

## What you need on the host

Install from a clean machine with these tools and nothing else. You do **not** need pnpm, and you do
not need to install the workspace's own Node: the application is built inside Docker.

| Tool                                          | Why it is needed                                                                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `git`                                         | To fetch the code, and to update it later (`git pull`).                                                                                          |
| Docker Engine 29 or newer, with Compose v2    | Everything runs in containers: `docker compose` and `docker run`. Measured on Compose 5.5.                                                       |
| [`just`](https://github.com/casey/just) 1.21+ | The install, backup, restore-drill and upgrade steps are `just` recipes (`just --list` shows them all).                                          |
| Node.js 18 or newer (`node` on the `PATH`)    | Only the host-side helper scripts use it: `just gen-pg-secrets`, `just gen-master-key` and the secret check that `just upgrade` runs. No `pnpm`. |
| `openssl`, `bash`, and the usual `coreutils`  | `just gen-pg-secrets` draws its random bytes from `openssl`; the recipes are bash.                                                               |
| `sudo` (optional)                             | Only for `just harden-secrets` (tighter secret file modes), the `/etc/hosts` line and importing the TLS certificate into your trust store.       |

Package names, for a clean host: on Alpine, `apk add git just nodejs openssl bash coreutils`
(Docker and its Compose plugin come from Docker's own packages); on Arch, `pacman -S git just nodejs
openssl docker docker-compose`; on Debian or Ubuntu, `apt install git nodejs openssl`, and `just`
from its [releases](https://github.com/casey/just/releases) because distribution packages are
often older than 1.21. Run `docker`, `just` and `node` as the user who will own the checkout, and
add that user to the `docker` group.

Sizing: a host with 4 GiB of RAM or more and a couple of cores. In steady state the whole stack
sits near 0.3 to 0.5 GiB. For about three seconds at every start, the API and the worker each
derive their encryption key and the stack peaks near 2.4 GiB, so a host with less than 3 GiB free
at that moment can be OOM-killed. Build the images on a machine with network access; the first
build takes several minutes.

The machine holding real financial data should have its data disk encrypted (LUKS2 or equivalent).
The RUNBOOK's "First install" has the one-time commands. A throwaway test machine does not need it.

## Install

These steps take a clean host to a passkey login over TLS. Run them from the repository root unless
a step says otherwise. Every `just` recipe named here is in the `justfile`, and `just --list` shows
all of them.

1. **Get the code.**

   ```bash
   git clone https://github.com/huh12312/PersonalFi.git personalfi
   cd personalfi
   ```

   To run a released version rather than the tip of `main`, check out its tag (`git tag -l` lists
   them) before step 2. The directory name becomes the Docker Compose project name (`personalfi`), and
   so the prefix of your volume names.

2. **Choose the hostname, then write `.env`.**

   ```bash
   cp .env.example .env
   ```

   `.env` holds non-secret settings only. The defaults work as they are: the site is
   `personalfi.lan`, served on `127.0.0.1` ports 443 and 80. Edit `PUBLIC_HOST` if you want another
   name, and `BIND_ADDRESS` only if other devices on your LAN must reach the box (never `0.0.0.0`).
   **Pick the final `PUBLIC_HOST` now:** passkeys are bound to it, and changing it later invalidates
   every one you enrolled. If port 443 is taken, set `PROXY_HTTPS_PORT` and also list the origin in
   `EXTRA_ALLOWED_ORIGINS` (for example `https://personalfi.lan:8443`).

3. **Create the database and encryption secrets.** Secrets are files under `./secrets`, never
   environment variables.

   ```bash
   just gen-pg-secrets
   just gen-master-key
   ```

   `secrets/master_key` is the passphrase the application derives its encryption key from. **Copy
   it somewhere that is not this machine** (a password manager). Losing it means re-linking every
   provider; the recipes refuse to overwrite an existing one.

4. **Build the images.** This builds the API, worker, migrator, backup and proxy images from the
   checkout, and takes several minutes the first time.

   ```bash
   just build
   ```

5. **Create the backup keypair.** Backups are encrypted to a public key; the container never holds
   the private half. Generate the pair with the backup image, so the host needs no `age`. Whoever
   holds the identity file can read every backup, so for real data copy it to a password manager and
   an offline copy and then remove it from this machine.

   ```bash
   (umask 077; docker run --rm --entrypoint age-keygen personalfi/backup:dev > "$HOME/personalfi-age-identity.txt")
   grep '^# public key:' "$HOME/personalfi-age-identity.txt" | cut -d' ' -f4 > secrets/age_recipient
   chmod 444 secrets/age_recipient
   ```

   (`personalfi/backup:dev` is the image step 4 built; if you set `PERSONALFI_VERSION` in `.env`,
   use that tag in place of `dev`.) You need the identity file only to restore and for the restore
   drill below; on a throwaway test host, leave it where it is, and on a host with real data bring
   it back for just those minutes.

6. **Create the empty placeholders for the optional secrets.** Compose will not start a service
   whose secret file is missing, and each optional feature (a bank aggregator, price feeds, the
   advisor token, off-site backup) is simply off while its file is empty. This recipe creates every
   optional secret `compose.yml` declares, empty, never overwrites a file, and refuses to run if a
   required secret from steps 3 and 5 is missing.

   ```bash
   just secrets-placeholders
   ```

7. **Start the stack and wait for it.**

   ```bash
   docker compose up -d --wait --wait-timeout 900
   docker compose ps
   ```

   `up --wait` returns once `db`, `api`, `worker`, `proxy` and `backup` are healthy and the one-shot
   `pre-migrate-backup` and `migrator` containers have exited 0. Expect a minute or two on a cold
   start. (`just up` is the same without the wait.) Then ask the API, from inside its own
   container, whether it is ready (no certificate is involved yet):

   ```bash
   docker compose exec -T api node -e "fetch('http://127.0.0.1:8080/ready').then(async r => console.log(r.status, await r.text()))"
   ```

   It prints `200` and a JSON body with `"status":"ready"`.

8. **Trust the TLS certificate.** Caddy issues the certificate for your hostname from its own
   internal CA, so your browser does not trust it until you import that CA.

   ```bash
   just trust-ca
   ```

   This writes `personalfi-ca.crt` next to the checkout. Import it into your operating system or
   browser trust store (Arch: `sudo trust anchor personalfi-ca.crt`; Firefox: Settings, Privacy and
   Security, Certificates, Import). On the machine whose browser you will use, make the name
   resolve to the bind address:

   ```bash
   echo "127.0.0.1 personalfi.lan" | sudo tee -a /etc/hosts
   ```

   Check the whole chain, TLS included, from a terminal (replace `personalfi.lan` if you changed
   `PUBLIC_HOST`):

   ```bash
   curl --cacert personalfi-ca.crt --resolve personalfi.lan:443:127.0.0.1 https://personalfi.lan/api/ready
   ```

   It prints a JSON body with `"status":"ready"` and exits 0. A certificate error here means the
   CA was not used; a connection error means the proxy is not publishing the port.

9. **Create your account.**

   ```bash
   just bootstrap-user name="Your Name" timezone="America/New_York"
   ```

   The time zone is an IANA name (`Europe/London`, `America/Los_Angeles`, `UTC`).

   It prints a one-time link of the form `https://personalfi.lan/register#token=...`. Open the
   **whole** link in a browser that trusts the certificate (step 8). Enrol at least two
   authenticators (a passkey on this device and a second one: a phone or a security key), and save
   the ten recovery codes somewhere that is not this machine. The token sits in the URL fragment,
   which is never sent to a server and never reaches a log.

10. **Sign in.** Open `https://personalfi.lan/` and choose **Sign in with a passkey**. You are at the
    dashboard: the install is complete.

If a step fails, the RUNBOOK's [Troubleshooting](RUNBOOK.md#troubleshooting) section lists the
failures people actually hit, with the exact error text.

## Your first data, a backup, and proof the backup restores

1. **Add an account and import a CSV.** In the app open **Accounts**: on a fresh install it says
   "Connect your first account" and offers **Add account**, which opens **Connections**, where
   **Add connection** opens the dialog. The **Manual account** tab creates an account you enter by hand. The **File
   import** tab imports a CSV: choose the preset **ISO date, one signed amount column**, name the
   account, and choose the file. A file this small works as a first try:

   ```bash
   printf 'Date,Description,Amount\n2026-09-01,Coffee shop,-4.50\n2026-09-02,Payroll,2500.00\n2026-09-03,Grocery store,-62.18\n' > sample.csv
   ```

   The three transactions appear under **Transactions** in the account you named.

2. **Take a backup now** (a nightly one also runs, at 02:00 UTC).

   ```bash
   just backup
   ```

   It ends with `backup: complete`. The backup is a verified, age-encrypted dump in the `backups`
   volume.

3. **Prove it restores.** An untested backup is a rumour. The drill restores the newest backup into
   a throwaway database and a throwaway API, compares it with the live database, and prints a
   verdict. It never touches your live data.

   ```bash
   export AGE_IDENTITY_FILE="$HOME/personalfi-age-identity.txt"
   export DRILL_EVIDENCE_DIR="$HOME/personalfi-drills"
   just restore-drill
   ```

   It pulls two small pinned images the first time, and ends with `Verdict: PASS`; the same report
   is written under `$DRILL_EVIDENCE_DIR`. If the host runs other Compose projects, also set
   `COMPOSE_PROJECT_NAME=personalfi`: the recipe refuses to guess which project to drill. Run it
   monthly; the RUNBOOK's [Restore drill](RUNBOOK.md#restore-drill) section says what it asserts.

When you are ready to put real data in, read the RUNBOOK's [First install](RUNBOOK.md#first-install)
for what this walk-through skips: `sudo just harden-secrets` (secret file modes of 0400, owned by
the consuming service), encrypting the data disk, off-site backup, remote access over Tailscale,
and optional Plaid and price-feed keys.

## Upgrade

```bash
git pull
just upgrade
```

That is the whole upgrade, from any earlier release, however many you skipped. It creates any
secret placeholder your install predates, rebuilds the images, takes a verified backup before the
first migration, applies the migrations, and checks that the stack is ready and stable. If the
stack comes up on a database newer than the code, it refuses to start rather than guess. The
RUNBOOK's [Upgrade](RUNBOOK.md#upgrade) section says what to do when a step fails and how to roll
back. The [release notes](docs/RELEASE-NOTES.md) name every manual step a release needs (v0.9.0
needs one, for installs that use the local-model narrator).

## Where to go next

- **Operating it:** [`RUNBOOK.md`](RUNBOOK.md): install in depth, upgrade, backup, restore, the
  restore drill, the 90-day soak, the local model, the advisor kill switches, the panic checklist,
  the resource envelope and troubleshooting.
- **What it defends against:** the [threat model](docs/security/threat-model.md), the
  [ASVS 5.0 assessment](docs/security/asvs-assessment.md) and the
  [CSP nonce strategy](docs/security/csp-nonce-strategy.md).
- **What changed:** [`docs/RELEASE-NOTES.md`](docs/RELEASE-NOTES.md).
- **How it is built and tested:** [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md),
  [`docs/TESTING.md`](docs/TESTING.md), and the plan in
  [`docs/plan/00-master-implementation-plan.md`](docs/plan/00-master-implementation-plan.md); the
  road to v1.0 is [`docs/plan/06-path-to-v1.md`](docs/plan/06-path-to-v1.md).
- **Why it is built this way:** the panel research memos in [`docs/research/`](docs/research/README.md)
  and the decisions in [`docs/plan/reconciliation-notes.md`](docs/plan/reconciliation-notes.md).

## Status

The plan's phases through the advisory layer are built and gated, and v0.9.0 is the polish and
hardening release: see the [release notes](docs/RELEASE-NOTES.md) for what it contains and
[`docs/plan/06-path-to-v1.md`](docs/plan/06-path-to-v1.md) for what is left. The version that ends
the plan, v1.0, requires ninety days as its author's only finance tool, so it cannot be declared
before that has happened. Development setup (Node 26, pnpm 12, `just install`, `just check`) is for
contributors, not for running it; [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md) and
[`docs/TESTING.md`](docs/TESTING.md) cover it.

PersonalFi is MIT-licensed; see [`LICENSE`](LICENSE) and [`THIRD_PARTY.md`](THIRD_PARTY.md).
