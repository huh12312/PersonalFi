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

**The language model, local or your own key (v0.9.5).** The narrator, which rewords a Brief finding
in plain English and may not add a number, runs on the local model by default. In Settings, Language
model you can instead point it at OpenAI, OpenRouter or Anthropic with your own API key (or turn it
Off). A hosted provider is used only after you tick its consent, which says exactly what leaves the
machine — Brief findings: aggregated amounts, bucketed, merchants pseudonymised, never a transaction
or an account number — and only on the payload you previewed and approved; each narration names the
provider and model that wrote it. The RUNBOOK's
[Language model: local or bring your own key](RUNBOOK.md#language-model-local-or-bring-your-own-key-v095)
has the details and the one host each provider may reach.

Its security posture is documented, including what it does not defend against. Read the
[threat model](docs/security/threat-model.md) and the
[ASVS assessment](docs/security/asvs-assessment.md) before you put real data in it.

## What you need on the host

Install from a clean machine with these tools and nothing else. You do **not** need pnpm, and you do
not need to install the workspace's own Node: installing a release pulls images that were built
elsewhere, and building from source happens inside Docker.

| Tool                                          | Why it is needed                                                                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `git`                                         | To fetch the release's files and update them later. Optional for a release install: its source archive works too.                                |
| Docker Engine 29 or newer, with Compose v2    | Everything runs in containers: `docker compose` and `docker run`. Measured on Compose 5.5.                                                       |
| [`just`](https://github.com/casey/just) 1.21+ | The install, backup, restore-drill and upgrade steps are `just` recipes (`just --list` shows them all).                                          |
| Node.js 18 or newer (`node` on the `PATH`)    | Only the host-side helper scripts use it: `just gen-pg-secrets`, `just gen-master-key` and the secret check that `just upgrade` runs. No `pnpm`. |
| `openssl`, `bash`, and the usual `coreutils`  | `just gen-pg-secrets` draws its random bytes from `openssl`; the recipes are bash.                                                               |
| `curl`                                        | The TLS check in install step 8 (`curl --cacert …`).                                                                                             |
| `sudo` (optional)                             | Only for `just harden-secrets` (tighter secret file modes), the `/etc/hosts` line and importing the TLS certificate into your trust store.       |
| `cosign` v3 (optional)                        | Checks the release images' signatures. Without it, the verifier runs cosign from its pinned container image.                                     |
| `gh`, logged in (optional)                    | Checks the release images' provenance attestations. Without it, the verifier warns and checks the signatures only.                               |

Package names, for a clean host: on Alpine, `apk add git just nodejs openssl bash coreutils curl`
(Docker and its Compose plugin come from Docker's own packages); on Arch, `pacman -S git just nodejs
openssl docker docker-compose curl`; on Debian or Ubuntu, `apt install git nodejs openssl curl`, and `just`
from its [releases](https://github.com/casey/just/releases) because distribution packages are
often older than 1.21. Run `docker`, `just` and `node` as the user who will own the checkout, and
add that user to the `docker` group.

Sizing: a host with 4 GiB of RAM or more and a couple of cores. In steady state the whole stack
sits near 0.3 to 0.5 GiB. At every start the API and the worker each derive their encryption key,
one after the other, and the stack peaks near 1.5 GiB for a few seconds (the two never derive at
once; if that lock cannot be taken they both do and the peak is near 2.4 GiB), so a host with less
than 3 GiB free at that moment can be OOM-killed. A release install downloads a few hundred megabytes of images;
building from source needs network access and takes several minutes the first time.

The machine holding real financial data should have its data disk encrypted (LUKS2 or equivalent).
The RUNBOOK's "First install" has the one-time commands. A throwaway test machine does not need it.

## What is supported

- **Architectures.** `linux/amd64`: built and exercised. `linux/arm64`: built, not yet exercised. If
  you run PersonalFi on arm64 hardware (a Raspberry Pi 5, for example), please open an issue with
  what you saw, working or not.
- **Host.** Docker Engine 29 or newer with Compose v2, and `just` 1.21 or newer, as in "What you
  need on the host" above.
- **Database.** The PostgreSQL image pinned by digest in `compose.yml`; that is the one the
  migrations and backups are tested against.
- **Release.** The newest published release, from v0.10.0. Earlier releases and `main` between
  releases get no fixes; [`SECURITY.md`](SECURITY.md) has the reporting route and the signing
  identity to check.
- **Registries.** `ghcr.io/huh12312/personalfi-{api,backup,proxy}` is canonical. The Docker Hub
  mirror is `masterhuh/personalfi-{api,backup,proxy}`.
- **`latest`.** Published for convenience. `just install-release` and the upgrade path refuse it
  because it names no single commit: pin a version. The install below pulls a verified, pinned
  release; building from source is for development and is described after it.

## Install

There are two ways in. **Install a published release** (below) pulls the three PersonalFi images,
verified, and builds nothing: it is the path for running PersonalFi. **[Build from
source](#build-from-source-developers)** builds the images from a checkout, for development or to
run a commit between releases. Both end at the same steps 8 to 10.

**No release has been published yet.** v0.10.0 is the first public release and is in preparation;
until `gh release list --repo huh12312/PersonalFi` shows it, the commands below that name
`0.10.0` have nothing to pull, and [Build from source](#build-from-source-developers) is the way
to install. Everything below is written for `0.10.0`; for a later release, use its number.

These steps take a clean host to a passkey login over TLS. Run them from the top of the release's
files unless a step says otherwise. Every `just` recipe named here is in the `justfile` (or the
file it imports), and `just --list` shows all of them.

1. **Get the release's files.** The install runs the published images, but it needs the release's
   own `compose.yml` and recipes: `compose.yml`, `justfile`, `scripts/` (the verifier, the upgrade
   recipe it imports and the helpers they call), `.env.example`, `docker/Caddyfile` (mounted into
   the proxy) and `packages/db/migrations/` (read by the pre-migration backup). Take the whole tree
   at the release tag, so these match the images exactly:

   ```bash
   git clone --branch v0.10.0 https://github.com/huh12312/PersonalFi.git personalfi
   cd personalfi
   ```

   Or, without `git`, the tag's source archive from the release page
   (`https://github.com/huh12312/PersonalFi/archive/refs/tags/v0.10.0.tar.gz`, unpacked; rename
   the directory to `personalfi`). A clone lets the verifier also check that the images were built
   from the commit you have; from the archive it checks the release tag only. The directory name
   becomes the Docker Compose project name (`personalfi`), and so the prefix of your volume names.

2. **Choose the hostname and the release, then write `.env`.**

   ```bash
   cp .env.example .env
   echo "PERSONALFI_VERSION=0.10.0" >> .env
   ```

   `.env` holds non-secret settings only. `PERSONALFI_VERSION` is the release you run, and it must
   be the one you pass to `just install-release` in step 7; `just install-release` refuses to start
   if the names compose would run are not the release's. Leave `REGISTRY` at its default,
   `ghcr.io/huh12312` (GitHub Container Registry, the canonical copy); to pull the identical Docker
   Hub copy instead, add `REGISTRY=masterhuh`. The other defaults work as they are: the site is
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

4. **Verify and fetch the images.** Each image was signed by this repository's release workflow at
   the tag `v0.10.0`. The verifier checks every signature (and, with `gh` installed and logged in,
   the provenance attestation) before it pulls anything, then pulls each image by its digest under
   its published name, which is the name compose runs:

   ```bash
   bash scripts/verify-release.sh --release 0.10.0 --pull
   ```

   Add `--source masterhuh` if you set `REGISTRY=masterhuh`, and `--commit "$(git rev-parse HEAD)"`
   from a clone. It prints `PASS` and three `pulled …` lines; any refusal stops it with nothing
   pulled. `cosign` is used from your `PATH`, or run from its pinned container image. Without `gh`
   it prints a warning and checks the signatures only; `--strict` refuses instead.

5. **Create the backup keypair.** Backups are encrypted to a public key; the container never holds
   the private half. Generate the pair with the backup image you just verified (`--pull never`
   makes sure it is that one), so the host needs no `age`. Whoever holds the identity file can read
   every backup, so for real data copy it to a password manager and an offline copy and then remove
   it from this machine.

   ```bash
   (umask 077; docker run --rm --pull never --entrypoint age-keygen ghcr.io/huh12312/personalfi-backup:0.10.0 > "$HOME/personalfi-age-identity.txt")
   grep '^# public key:' "$HOME/personalfi-age-identity.txt" | cut -d' ' -f4 > secrets/age_recipient
   chmod 444 secrets/age_recipient
   ```

   (With `REGISTRY=masterhuh`, the image is `masterhuh/personalfi-backup:0.10.0`.) You need the
   identity file only to restore and for the restore drill below; on a throwaway test host, leave
   it where it is, and on a host with real data bring it back for just those minutes.

6. **Create the empty placeholders for the optional secrets.** Compose will not start a service
   whose secret file is missing, and each optional feature (a bank aggregator, price feeds, the
   advisor token, off-site backup) is simply off while its file is empty. This recipe creates every
   optional secret `compose.yml` declares, empty, never overwrites a file, and refuses to run if a
   required secret from steps 3 and 5 is missing (step 7 runs it again; it is safe to repeat).

   ```bash
   just secrets-placeholders
   ```

7. **Install the release: verify, pull by digest, start.**

   ```bash
   just install-release 0.10.0
   ```

   It refuses `latest` and anything that is not `x.y.z`, and it refuses if `.env` names another
   version or registry than the images it would verify. Then it checks the placeholders, runs the
   verifier from step 4 again (the same call an upgrade makes), pulls the database image, and starts
   the stack with `docker compose up -d --wait --no-build --pull never`, so it runs exactly the
   verified images and never builds or fetches another. It returns once `db`, `api`, `worker`,
   `proxy` and `backup` are healthy and the one-shot `pre-migrate-backup` and `migrator` have exited
   0, prints the API's own `/ready` answer (`200` and a JSON body with `"status":"ready"`), and checks
   that `api` and `worker` have not restarted. Expect two or three minutes on a cold start.

8. **Trust the TLS certificate.** Caddy issues the certificate for your hostname from its own
   internal CA, so your browser does not trust it until you import that CA.

   ```bash
   just trust-ca
   ```

   This writes `personalfi-ca.crt` in the repository root (the current directory). Import it into
   your operating system or browser trust store:
   - Arch: `sudo trust anchor personalfi-ca.crt`.
   - Debian, Ubuntu or Alpine: `sudo cp personalfi-ca.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates`.
   - macOS: `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain personalfi-ca.crt`.
   - Firefox: Settings, Privacy and Security, Certificates, Import (Firefox keeps its own store).
   - Chrome, Chromium or Edge on Linux read their own NSS store, not the system one. If
     `~/.pki/nssdb` does not exist yet (the browser has never run), create it first:
     `mkdir -p $HOME/.pki/nssdb && certutil -d sql:$HOME/.pki/nssdb -N --empty-password`. Then
     `certutil -d sql:$HOME/.pki/nssdb -A -t 'C,,' -n personalfi -i personalfi-ca.crt` (package
     `nss-tools` on Alpine and Arch, `libnss3-tools` on Debian and Ubuntu).

   On the machine whose browser you will use, make the name resolve to the bind address:

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

   This starts a short-lived container of its own for the key derivation (about 1.2 GiB of memory
   for about six seconds, under the same 1536M limit as the `api` service), so the running `api` is
   never the process the kernel can kill. Run it once the stack is up. If it ever ends with
   `exit code 137`, the host did not have that memory free: stop other memory users (the local
   model first) and run the same command again with `reissue=true` added, which issues a fresh link.

   It prints a one-time link of the form `https://personalfi.lan/register#token=...`. Open the
   **whole** link in a browser that trusts the certificate (step 8). Enrol a passkey on this device
   and, when the wizard offers it, a backup passkey on a second device (a phone or a security key).
   The wizard then offers **Create my recovery codes**; choose it and it shows your ten codes,
   once: save them somewhere that is not this computer and tick "I have saved these codes
   somewhere safe" to continue. You can skip that step
   and create them later in Settings › Security › Recovery codes; a new set replaces the old one.
   The token sits in the URL fragment, which is never sent to a server and never reaches a log.
   On a headless test host, use Chromium with a virtual authenticator (DevTools → More tools →
   WebAuthn, or the CDP method `WebAuthn.addVirtualAuthenticator`).

10. **Sign in.** Open `https://personalfi.lan/` and choose **Sign in with a passkey**. Leave the
    **Account** box empty; the passkey identifies you. You are at the dashboard: the install is
    complete.

### Build from source (developers)

This builds the images from a checkout instead of pulling them: for working on PersonalFi, or for
running a commit between releases. It needs network access for the build, which takes several
minutes the first time. Steps 1 to 3 differ from the release path only in what you check out:

1. **Get the code.**

   ```bash
   git clone https://github.com/huh12312/PersonalFi.git personalfi
   cd personalfi
   ```

   The tip of `main`, or any commit or tag you check out.

2. **Write `.env`** as in step 2 above, but leave `PERSONALFI_VERSION` unset: the images are then
   tagged `dev` (`ghcr.io/huh12312/personalfi-api:dev` and so on: compose's names, with a tag no
   release ever carries), or set it to the commit you built. `just build` refuses a release's tag
   such as `0.10.0` under `ghcr.io/huh12312` or `masterhuh`, so a local build can never pose as a
   published image; set `REGISTRY=personalfi` if you would rather not see the registry's name on
   local builds at all.

3. **Create the secrets**: `just gen-pg-secrets` and `just gen-master-key`, as in step 3 above.

4. **Build the images.** This builds the API, worker, migrator, backup and proxy images from the
   checkout.

   ```bash
   just build
   ```

5. **Create the backup keypair** with the image step 4 built:

   ```bash
   (umask 077; docker run --rm --entrypoint age-keygen ghcr.io/huh12312/personalfi-backup:dev > "$HOME/personalfi-age-identity.txt")
   grep '^# public key:' "$HOME/personalfi-age-identity.txt" | cut -d' ' -f4 > secrets/age_recipient
   chmod 444 secrets/age_recipient
   ```

   (If you set `PERSONALFI_VERSION` or `REGISTRY` in `.env`, use that name and tag in place of
   `ghcr.io/huh12312/personalfi-backup:dev`.)

6. **Create the empty placeholders for the optional secrets.**

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

   It prints `200` and a JSON body with `"status":"ready"`. Continue with steps 8 to 10 above.

If a step fails, the RUNBOOK's [Troubleshooting](RUNBOOK.md#troubleshooting) section lists the
failures people actually hit, with the exact error text.

## Your first data, a backup, and proof the backup restores

1. **Add an account and import a CSV.** In the app open **Accounts**: on a fresh install it says
   "Connect your first account" and offers **Add account**, which opens **Connections**, where
   **Add connection** opens the dialog. The **Manual account** tab creates an account you enter by hand. The **File
   import** tab imports a CSV: choose the preset **ISO date, one signed amount column**, name the
   account, and choose the file; leave **Connection name**, **Type** (depository) and **Currency**
   (USD) at their defaults. A file this small works as a first try:

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
   is written under `$DRILL_EVIDENCE_DIR`. On a fresh install the report also says
   `WARNING: the live database holds no plan scenario ...`: that is expected until you have saved a
   plan on the Plan screen, and the verdict is still PASS. Once you have a plan, run `just backup`
   and the drill again so it also checks that a backup with a plan restores. If the host runs other Compose projects, also set
   `COMPOSE_PROJECT_NAME=personalfi`: the recipe refuses to guess which project to drill. Run it
   monthly; the RUNBOOK's [Restore drill](RUNBOOK.md#restore-drill) section says what it asserts.

When you are ready to put real data in, read the RUNBOOK's [First install](RUNBOOK.md#first-install)
for what this walk-through skips: `just harden-secrets` (it asks for `sudo` itself; `sudo just …` fails when `just` is installed under your home directory, which `sudo`'s `secure_path` does not search) (secret file modes of 0400, owned by
the consuming service), encrypting the data disk, off-site backup, remote access over Tailscale,
and optional Plaid and price-feed keys. (Plaid's keys can also be entered in the product itself, under Accounts, Add connection, Plaid; the RUNBOOK's "Plaid: two ways to supply your keys" says which wins. The four market-data keys — Tiingo, FRED, CoinGecko, OpenFIGI — can likewise be entered under Settings, Market data; the RUNBOOK's "Market data: two ways to supply your keys" says which wins, and OpenFIGI works without a key, anonymously.)

## Upgrade

**A release install** (the path above): fetch the new release's files, set the new version (here, for example, 0.10.1), and
install it the same way.

```bash
git fetch --tags && git checkout v0.10.1      # or unpack the new release's source archive
sed -i 's/^PERSONALFI_VERSION=.*/PERSONALFI_VERSION=0.10.1/' .env
just install-release 0.10.1
```

**A source build**:

```bash
git pull
just upgrade
```

Either way the site is unavailable for a few minutes while the new containers start (a source
build also rebuilds the images first). That is the whole upgrade, from any earlier release, however
many you skipped. It creates any secret placeholder your install predates, verifies and pulls the
release's images (or rebuilds them from the checkout), takes a verified backup before the first
migration, applies the migrations, and checks that the stack is ready and stable. If the
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
