<!-- SPDX-License-Identifier: MIT -->

# RUNBOOK

Operational procedures for running PersonalFi: install, upgrade, backup, restore, the restore drill,
the 90-day soak, the local model, the advisor kill switches, key rotation, lockout recovery, the
panic checklist, the resource envelope and troubleshooting. This is the doc to open when something
needs doing on the actual host, not when reading the code. For the design rationale behind the
choices this file tells you to execute, see `docs/research/06-platform-devops-licensing.md` and
`docs/plan/00-master-implementation-plan.md`; for what an attacker can and cannot do, the
[threat model](docs/security/threat-model.md) and the
[ASVS assessment](docs/security/asvs-assessment.md). A first-time reader should start with
[`README.md`](README.md), which walks one clean host to a passkey login; this file goes deeper at
every step and covers everything after.

Commands are given as `just ...` where a recipe exists (`justfile`; `just --list` shows them all)
and as raw `docker compose ...` otherwise. Everything here assumes Docker 29+ with the Compose v2
plugin and these host tools: `git`, `just` 1.21+, Node.js 18+ (the host scripts only), `openssl`,
`bash`. The machine the plan targets is the Arch Linux host of D13/D24; nothing here is
Arch-specific except where a step says so.

| Section                                                                                                                                     | When you need it                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| [First install](#first-install)                                                                                                             | Once, on a new host                                    |
| [Upgrade](#upgrade)                                                                                                                         | Every release: `git pull` then `just upgrade`          |
| [Backup](#backup), [Restore](#restore), [Restore drill](#restore-drill)                                                                     | Nightly (automatic), after a disaster, monthly         |
| [Production install and the real-use soak](#production-install-and-the-real-use-soak)                                                       | Running it as your only finance tool for 90 days       |
| [Database roles](#database-roles), [Master-key rotation](#master-key-rotation), [Lockout and operator unlock](#lockout-and-operator-unlock) | Hardening the database login; a key or a login problem |
| [Advisor kill switches](#advisor-kill-switches), [Local model](#local-model-profile-local-llm)                                              | The advisory layer                                     |
| [Panic button](#panic-button-outline)                                                                                                       | You think the box or a credential is compromised       |
| [Cryptography inventory](#cryptography-inventory), [Logging inventory](#logging-inventory)                                                  | What is encrypted, with what, and what is logged where |
| [Resource envelope](#resource-envelope), [Troubleshooting](#troubleshooting)                                                                | Sizing, and errors with their fixes                    |

---

## First install

### 0. Before you start: LUKS2

Master plan D24 / P0-13: **the volume holding `pgdata` and `backups` must be
LUKS2-encrypted at the block-device level.** This is a host-provisioning step,
not something `docker compose up` can do for you — Docker sees a filesystem
path and has no idea whether the block device under it is encrypted. (A
throwaway test host holding no real data can skip it.)

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

### 1. Clone the repository

```bash
git clone https://github.com/huh12312/PersonalFi.git personalfi
cd personalfi
```

The host does **not** need pnpm or the workspace's Node: every image is built inside Docker, and
`just install` (which runs `pnpm install --frozen-lockfile`) is for contributors. The directory name
becomes the Compose project name and so the prefix of every volume (`personalfi_pgdata`, ...); the
soak install below sets it explicitly instead.

### 2. Create secrets

Every secret is a **file** under `./secrets/`, never an environment variable
(P0-2: `docker inspect` and `/proc/<pid>/environ` must stay clean). The
directory is gitignored. Docker mounts each one at `/run/secrets/<name>`
inside the relevant container regardless of the host filename, but the
host-side filenames below are also what `.env.example` and `just
gen-master-key` already assume — use exactly these names, with no extension.
`compose.yml`'s top-level `secrets:` block is the authoritative list; `just secrets-placeholders`
(item 4) reads it, so this section cannot drift from what compose will mount.

**1. The database credentials.** `compose.yml` mounts two: `pg_password` (Postgres's own bootstrap
password) and `database_url` (the full connection string the app uses). One recipe writes both,
because the password has to be URL-safe: a base64 password can contain `/`, `+` or `=`, any of
which breaks `postgres://...` parsing or silently changes what the URL means. `just
gen-pg-secrets` draws 32 bytes from `openssl` as hex (always URL-safe), writes both files, and parses
its own output with Node's `URL` before it finishes. It creates `./secrets` at mode 0700 and refuses
to overwrite an existing `pg_password`.

```bash
just gen-pg-secrets
```

**2. The key-encryption passphrase.** `master_key` is the passphrase the application derives its
KEK from (D5, P0-2). Never hand-type this one: low entropy defeats the whole envelope-encryption
design. The recipe writes 48 random bytes, base64url, and refuses to overwrite an existing file.
**Back it up somewhere that is not this host**: losing it means re-linking every provider.

```bash
just gen-master-key
```

**3. An age keypair for backups.** The `backup` container only ever gets the public half
(`age_recipient`; see `docker/backup/backup.sh`'s header for why); keep the private half **outside
this repo and this host**, in a password manager entry plus one offline copy. Generate it with the
backup image itself, so the host needs no `age`. The image must exist, so build first (several
minutes the first time):

```bash
just build
(umask 077; docker run --rm --entrypoint age-keygen personalfi/backup:dev > "$HOME/personalfi-age-identity.txt")
grep '^# public key:' "$HOME/personalfi-age-identity.txt" | cut -d' ' -f4 > secrets/age_recipient
chmod 444 secrets/age_recipient
```

(`personalfi/backup:dev` is the tag `just build` produced; if `.env` sets `PERSONALFI_VERSION` or
`REGISTRY`, use that tag.) Move `$HOME/personalfi-age-identity.txt` to your password manager and an
offline copy, then `shred -u` it once it is safely stored. Never commit it, and do not leave it on a
host that holds real data: you need it only to restore and to run the restore drill (bring it back
for those few minutes), and whoever holds it can read every backup.

**4. Every optional secret, empty.** Compose has no optional-secret model: it refuses to start a
container that mounts a secret whose host file does not exist. So every optional feature's secret is
created **empty**, and `packages/config` treats a zero-length (or whitespace-only) file exactly as a
missing one (`load.ts`'s `loadConfig`, tested in `load.test.ts`): an empty placeholder boots exactly
as no file would, and the feature stays off until you write a real value. One recipe creates all
of them, computed from `compose.yml` rather than hand-listed:

```bash
just secrets-placeholders
```

It never overwrites or re-modes an existing file, keeps `./secrets` at 0700, creates the files at
mode 0444, prints only secret **names**, and **refuses** (before writing anything) if a required
secret (`database_url`, `pg_password`, `master_key`, `age_recipient`) is missing or empty. `just
upgrade` runs it for you, so a release that adds an optional secret needs no hand step.

**5. Turning an optional feature on.** Write the real value, run `just harden-secrets` (see
below), set the `.env` key if the row names one, and run `docker compose up -d` so the services
that read it start again: `api` and `worker` read their secrets once, at boot, and the proxy
reads `PLAID_ENABLED` at start.

| Secret file(s)                                              | What it enables                                                                                                                                                                                                                                         | Write                                                                                                                                                                                                                     | Also                                                                                                                                                                                |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `b2_key_id`, `b2_application_key`                           | Off-site backup to Backblaze B2                                                                                                                                                                                                                         | A B2 application key scoped to **one bucket with object lock**                                                                                                                                                            | `RCLONE_REMOTE=b2:<your-bucket-name>` in `.env`                                                                                                                                     |
| `plaid_client_id`, `plaid_secret`, `plaid_env`              | Bank linking through Plaid                                                                                                                                                                                                                              | The client id, the secret, and `sandbox` (or `production`, see below) with `echo -n`                                                                                                                                      | `PLAID_ENABLED=true` so the proxy widens its CSP for Plaid's origins; `PLAID_REDIRECT_URI=https://<PUBLIC_HOST>/link/oauth` only for an OAuth institution (most US banks need none) |
| `advisor_token_secret`                                      | The insights module (`module.insights`): keys every merchant pseudonym an advisor sees                                                                                                                                                                  | `openssl rand -hex 32 > secrets/advisor_token_secret`                                                                                                                                                                     | Rotating it re-pseudonymises every merchant and orphans every `MERCHANT_…` reference already stored                                                                                 |
| `tiingo_api_key`                                            | Equity, ETF and fund end-of-day closes. Can also be entered in the product (Settings, Market data); a non-empty file wins                                                                                                                               | The key                                                                                                                                                                                                                   | `MARKET_DATA_ALLOWED_HOSTS` can only narrow the four hosts the code names                                                                                                           |
| `fred_api_key`                                              | Macro series and FX. FRED has no header auth, so the key travels in the query string; `@ctx/integrations` redacts every provider-authored string before it is logged. Can also be entered in the product (Settings, Market data); a non-empty file wins | The key                                                                                                                                                                                                                   |                                                                                                                                                                                     |
| `coingecko_api_key`                                         | Crypto prices (Demo plan). Can also be entered in the product (Settings, Market data); a non-empty file wins                                                                                                                                            | The key                                                                                                                                                                                                                   |                                                                                                                                                                                     |
| `openfigi_api_key`                                          | Symbol-to-FIGI mapping (also answers anonymously, at 10 jobs per batch instead of 100). Can also be entered in the product (Settings, Market data); a non-empty file wins                                                                               | The key                                                                                                                                                                                                                   |                                                                                                                                                                                     |
| `openai_api_key`, `openrouter_api_key`, `anthropic_api_key` | A hosted narrator with your own key (v0.9.5, D30). Used only when the holder makes that provider the narrator in Settings, Language model, with its consent ticked. Can also be entered in the product; a non-empty file wins                           | The key                                                                                                                                                                                                                   | See [Language model: local or bring your own key](#language-model-local-or-bring-your-own-key-v095)                                                                                 |
| `coinbase_key_name`, `coinbase_private_key`                 | The Coinbase connector. All-or-nothing: one without the other is a boot error                                                                                                                                                                           | The CDP key name `organizations/{org}/apiKeys/{key}` and the **Ed25519** private key. Create the key with the `view` permission only: the connector asserts `key_permissions` at startup and refuses a key that can trade |                                                                                                                                                                                     |
| `etherscan_api_key`                                         | The watch-only wallet connector's Ethereum leg. The Bitcoin leg needs no key (addresses are derived locally and Blockstream Esplora is unauthenticated)                                                                                                 | The key                                                                                                                                                                                                                   | Without it an ETH balance request refuses by name (`CONFIG_ERROR` naming this file) rather than dialling                                                                            |
| `migrator_database_url`                                     | The hard database-role boundary: the migrator alone connects as the schema owner while `database_url` is the DML-only `personalfi_app`                                                                                                                  | The owner's `postgres://` URL, as [Database roles](#database-roles) describes                                                                                                                                             | Empty means the migrator uses `database_url`, as before                                                                                                                             |

With no provider key (by file or stored in Settings), the price adapters answer `skipped_no_key`,
OpenFIGI answers anonymously, and the app boots normally; Phase 3 "completes with zero keys, it
just cannot prove freshness". `CRYPTO_ALLOWED_HOSTS` and
`MARKET_DATA_ALLOWED_HOSTS` in `.env` can only **narrow** which hosts those adapters may reach;
neither can add one. The seven provider keys are mounted on `api` and `worker` only, never on the
migrator (it applies DDL and will never dial a provider).

Plaid's `plaid_env` file reads `sandbox` or `production`. The api refuses to boot with `production`
unless `PLAID_ALLOW_PRODUCTION=true` is also set in its environment (D16: two independent settings
must agree before a real charge is possible). `compose.yml` passes that variable to `api` and
`worker` with a default of `false`, so an install runs Plaid **sandbox** only until you set
`PLAID_ALLOW_PRODUCTION=true` in `.env` as well as `plaid_env` to `production`. `@core/config` also refuses to boot if `PLAID_REDIRECT_URI` is set but is not
`https` or does not share an origin with `AUTH_ALLOWED_ORIGINS`.

**Plaid: two ways to supply your keys (v0.9.1).** Bank linking through Plaid needs a Plaid client id
and secret. They can come from either of two places, and the install tells you which in
Accounts, then Add connection, then the Plaid tab.

1. **The operator's secret files**: `secrets/plaid_client_id`, `secrets/plaid_secret` and
   `secrets/plaid_env`, as in the table above. Right for the person who runs the install and wants
   the keys outside the database altogether. The product shows them read-only ("Plaid is configured
   by the operator's secret files") and refuses to store a second set.
2. **The product, for the account holder**: Accounts, Add connection, the Plaid tab ("Set up
   Plaid") asks for the client id, the secret and the environment. Saving asks for your passkey,
   checks the keys with Plaid first (a Link token request, which costs nothing), and only then
   stores them, **sealed with the same key that protects your bank access tokens**. The secret is
   never shown again, only the last four characters of the client id. The Plaid connector is
   registered at once: **no restart, no file, no `just harden-secrets`** (the worker picks the
   change up from the event log within seconds). **Change** and **Remove** are on the same tab,
   each behind a passkey. Removing stops the connections linked with those keys from syncing and
   revokes nothing at Plaid; roll the key in your Plaid dashboard if you want it dead.

**Precedence.** If the secret files are non-empty they win and the product's stored keys, if any,
sit unused. Otherwise the stored keys are used. `PLAID_ENABLED` keeps its old meaning for **both**:
it is the proxy's switch for Plaid Link's script (D26), not the connector's, so keep it `true`
whichever way you supply the keys, or Link will not open in the browser.

**Production.** `production` is refused in the product, and a stored production row is ignored,
unless `PLAID_ALLOW_PRODUCTION=true` is set in `.env` and the stack restarted, exactly as for the
files path (D16). Start with `sandbox`; the first use is the check that the keys are right.

**What a stored key survives and does not.** The sealed row is in the database, so it is in every
backup (the dumps are `age`-encrypted) and a restore with the same `master_key` keeps it. It is
**never** in the app's own export bundle. Entering keys from a different Plaid account than the old
ones leaves the banks linked under the old account unable to sync; the app's ten-Item counter
counts every Plaid connection ever made here, whichever keys made it.

**Market data: two ways to supply your keys (v0.9.3).** Prices (Tiingo for equities, ETFs and
funds; CoinGecko for crypto), macro series and FX (FRED), and symbol-to-FIGI mapping (OpenFIGI)
each take an API key. Each key can come from either of two places, provider by provider, and the
install tells you which in **Settings, Market data**.

1. **The operator's secret files**: `secrets/tiingo_api_key`, `fred_api_key`, `coingecko_api_key`
   and `openfigi_api_key`, as in the table above. A non-empty file wins: the product shows that
   provider read-only ("Set by the operator's secret file") and refuses to store a second key for
   it. Changing a file still needs `docker compose up -d` (the processes read files at boot).
2. **The product, for the account holder**: Settings, Market data has one card per provider with
   what it is for, where its key comes from now, and a key field. **Save with passkey** asks for
   your passkey, checks the key with the provider first (one cheap call through the same adapter
   the nightly refresh uses: one end-of-day row from Tiingo, one simple price from CoinGecko, one
   FRED observation, one OpenFIGI mapping; the same single host per provider, nothing new is
   reachable), and only then stores it, **sealed with the same key that protects your bank access
   tokens**. The key is never shown again, only its last four characters. **No restart, no file,
   no `just harden-secrets`**: the worker picks a saved or removed key up within 30 seconds (at
   once when the change reaches it through the event log). **Remove** is on the same card, behind
   a passkey; it revokes nothing at the provider.

**Precedence.** A non-empty secret file wins for its provider; otherwise the holder's stored key is
used; otherwise there is none. With no key, Tiingo, CoinGecko and FRED are not used at all (no
prices, so no gain figures, for what they would price), and **OpenFIGI is used anonymously** (10
jobs per request, 25 requests per minute): the card says "using OpenFIGI anonymously".
`MARKET_DATA_ALLOWED_HOSTS` still only narrows: a provider it excludes cannot be saved or used,
whichever way the key arrives.

**When prices refresh (v0.9.4).** Every night at about 03:45 (your time zone, with up to fifteen
minutes' jitter) the worker prices **every security you hold a non-zero position in**, across every
account: stocks, ETFs and mutual funds through Tiingo by ticker, crypto through CoinGecko by its coin
id (Bitcoin, Ether and Solana are mapped; a token contract is not), and an FX rate through FRED for
every non-US-dollar currency a position is held in. Cash, bonds and "other" are not sent to any
provider. Each provider is asked for the latest close in the week before the day (two weeks for
FRED's exchange rates, which are published with a lag), so a weekend, a holiday or a run before
today's close still gets the last session's price, marked as carried forward. **Refresh prices**, on
the Investments screen header and in Settings, Market data, runs the same refresh for you at once,
at most once every ten minutes, and says what happened in words ("Priced 12 of 13; 1 unpriced: no
CoinGecko key"), naming every holding it could not price and why. Both spend against the same
per-provider budgets (`market_data_runs`). Before v0.9.4 the nightly job priced nothing on any
install: it was never given the list of holdings.

**What OpenFIGI does and does not fix.** It turns an ISIN, a CUSIP or an exchange-qualified ticker
into a FIGI, so the same security reported two ways by two institutions becomes one row. A **bare
ticker** with no exchange never identifies a security on its own (`BHP` is three companies), with
one narrow exception (decision D29): when the institution gave nothing stronger, the position is
priced in **US dollars** and is a **stock, ETF or mutual fund**, the ticker is sent to OpenFIGI as a
US listing (`exchCode: US`), and the position is identified by the **composite FIGI** OpenFIGI
returns — only when every line of the answer names the same one. This is how Plaid's US holdings,
which usually arrive as bare tickers, become real holdings; it works keyed or anonymous, and not at
all when OpenFIGI is excluded by `MARKET_DATA_ALLOWED_HOSTS`. A bare ticker in another currency, of
another type (cash, bonds, options) or with no currency is never sent. Any position still not
identified is listed on Holdings as **"Could not identify this security"**, with the institution's
name, ticker, quantity and its own value labelled as the institution's figure, and the reasons in
plain words — for a US ticker OpenFIGI could not settle, "matched it to more than one US listing",
"found no US listing with that ticker", or "could not be reached … the next sync will try again".
It is left out of allocation and performance and named in their "excluded" lists, and its buys,
sells and contributions are still listed under Activity.

**What a stored key survives and does not.** As for Plaid: in every backup (encrypted), kept by a
restore with the same `master_key`, **never** in the app's own export bundle.

**Watch-only wallet privacy** (Phase 3 gate C-13): every address the connector derives from a linked
xpub/ypub/zpub, and every `0x` address linked directly, is queried against `blockstream.info` and
`api.etherscan.io` from **this host's IP**. There is no self-hosted Esplora option today, so
Blockstream can link every derived address of every watch-only wallet this install has ever linked
to that IP. This is inherent to the watch-only design. An operator who needs to avoid it needs a
self-hosted or Tor-routed block explorer, which is out of scope here. The stored descriptor itself
(`wallet_addresses.descriptor`: the xpub/ypub/zpub or the `0x` address) **is sealed with `SecretBox`**
when a wallet is linked (migration 0027; WP 5.13b C-4: the api and the worker both pass the unlocked
keyring into the wallet runtime), and a descriptor an earlier release stored in the clear is
re-sealed at the worker's next boot (it logs `wallet descriptors: re-sealed at boot`). A database
dump or a backup therefore carries the descriptor only as ciphertext.

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
container (running as 10001): -rw-r--r-- 1 1000 1000 the mounted file   -> READABLE
```

Nothing was applied. So with a 0400 file owned by you, every consumer fails:
`db` runs as uid 70, `api`/`worker`/`migrator` as 10001, `backup` as 10002, and
none of them is the uid that ran `just`. 0444 inside a **0700 directory** is
the working default: only you and root can traverse into `./secrets` at all.

The way to actually get 0400 inside the container is to make the host file
0400 _owned by the consuming uid_, which needs root once:

```bash
just harden-secrets     # chown/chmod per consuming service, one sudo prompt per file
ls -l secrets/
# -r-------- 1 10001 10001 database_url      api / worker / migrator
# -r-------- 1 10001 10001 migrator_database_url  migrator (empty unless the roles are split)
# -r-------- 1 10001 10001 master_key        api / worker
# -r-------- 1 10001 10001 plaid_client_id   api / worker   (and plaid_secret, plaid_env,
#                                                            advisor_token_secret and the
#                                                            seven provider keys: same)
# -r--r----- 1     70  10002 pg_password     postgres (owner) + backup (group)
# -r--r----- 1 10001 10002 age_recipient     api + backup
# -r-------- 1 10002 10002 b2_key_id         backup   (and b2_application_key)
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
  on the same LAN to reach it directly over the internal CA. **Both** published
  ports follow it: HTTPS on `PROXY_HTTPS_PORT` (default 443) and a plain-HTTP
  listener on `PROXY_HTTP_PORT` (default 80) that serves the same app without
  TLS, there for `tailscale serve` (step 6) to forward to. On a LAN address that
  second port is reachable by anyone on the LAN in clear text, so firewall it, or
  keep `BIND_ADDRESS` on loopback and reach the box over Tailscale.
- `PUBLIC_HOST` — defaults to `personalfi.lan`; **renamed from
  `PERSONALFI_HOSTNAME`** because it is one fact used in four places and they
  were allowed to disagree once (P0-4). Setting it sets, together: Caddy's site
  address and internal-CA certificate (`docker/Caddyfile`), the API's
  `BASE_URL`, `AUTH_RP_ID` (the WebAuthn relying-party id), and the single
  entry in `AUTH_ALLOWED_ORIGINS` (the CSRF origin allow-list). Changing it
  after passkeys are enrolled **invalidates every passkey** — the RP id is
  bound into the credential — so pick the final hostname before step 7.
- `PERSONALFI_VERSION` and `COMPOSE_PROJECT_NAME` — leave unset for a single
  install on its own host (images are tagged `dev` and the project is the
  directory name). A **production** install sets both; see "Production install
  and the real-use soak".
- `EXTRA_ALLOWED_ORIGINS` — optional, comma-separated, appended to
  `AUTH_ALLOWED_ORIGINS`. Only for a second origin on the **same registrable
  name** (a different port, or a subdomain of `PUBLIC_HOST`). It is _not_ a way
  to add the Tailscale MagicDNS name: WebAuthn §7.1 requires every allowed
  origin's host to equal `AUTH_RP_ID` or be a subdomain of it, and
  `@core/config` enforces that at boot — `<node>.<tailnet>.ts.net` alongside
  `personalfi.lan` refuses to start, by design, rather than failing later in
  the browser. If you want passkeys over Tailscale, set `PUBLIC_HOST` to the
  tailnet name and reach the box by that name on the LAN too. The same goes for
  a non-default `PROXY_HTTPS_PORT`: the browser's origin then carries the port,
  so list it here (`https://personalfi.lan:8443`).

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
just build               # already done in step 2; re-run after any change to the code
docker compose up -d --wait --wait-timeout 900
docker compose ps        # everything healthy? the P0-6/-7 evidence in
                          # docs/evidence/phase-0/wp0.4-container-hardening.md
                          # is what "healthy" is checked against
```

`just up` is `docker compose up -d` without the wait. With `--wait`, the command returns once `db`,
`api`, `worker`, `proxy` and `backup` are healthy and the one-shot containers have exited 0:
`pre-migrate-backup` (a backup before any migration; with nothing pending, or on an empty database,
it exits at once) and `migrator` (applies the migrations). Expect a minute or two on a cold start:
the API derives its encryption key (Argon2id, about 7 s) before it answers. A cold install ends with
the readiness check:

```bash
docker compose exec -T api node -e "fetch('http://127.0.0.1:8080/ready').then(async r => console.log(r.status, await r.text()))"
# 200 {"status":"ready", ...}
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
`PUBLIC_HOST` is) to `/etc/hosts` pointing at the bind address. To prove the
whole chain, TLS included, without a browser:

```bash
curl --cacert personalfi-ca.crt --resolve personalfi.lan:443:127.0.0.1 https://personalfi.lan/api/ready
```

It prints the readiness JSON and exits 0. A certificate error means the CA was
not applied (the file is the one `just trust-ca` wrote from this install's
`caddy_data` volume; a rebuilt volume means a new CA and a new file).

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
ten recovery codes somewhere that is not this host. The wizard shows the codes once after the backup-passkey step; if you skipped it, Settings › Security › Recovery codes creates a set (each new set replaces the last).

The token expires **one hour** after it is minted. If it lapses, or you lose
every passkey and every recovery code, `just bootstrap-user reissue=true`
mints a fresh enrolment link for the account that already exists (it is
reachable only from a shell on the host, which already owns the database and
`master_key`).

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

## Monte Carlo return series (condition C-1)

The interactive and nightly Monte Carlo projection resamples a real historical
monthly return series (Shiller's US stock/bond dataset, cross-checked against
Damodaran's annual series — `packages/contexts/planning/data/returns/
PROVENANCE.md`). **Neither source grants redistribution**, so this repository
never ships the series: the image carries the fetch/derive/verify code and the
pinned checksum, never the data itself (`data/returns/cache/` is git-ignored
and absent from every built image). Until an operator runs the command below,
`POST /plan/scenarios/{id}/projections {"method":"monte_carlo"}` refuses
honestly rather than substituting a different engine silently.

Run it once, inside the `worker` service — the one container that mounts the
`returns_cache` named volume read-write (`compose.yml`) and, since
`docker/api.Dockerfile` creates `/var/lib/personalfi/returns` owned by
`10001:10001` before the volume is ever bound, needs no `chown` and no root
execution: the image's own `USER 10001:10001` is already the fetch's user.

```bash
docker compose run --rm --no-deps --entrypoint node worker \
  packages/contexts/planning/data/returns/fetch.ts \
  --cache-dir /var/lib/personalfi/returns
```

**`--entrypoint node` is not optional.** The image's `ENTRYPOINT` is fixed to
`tini -- node /app/entrypoint.mjs`, and `entrypoint.mjs` dispatches on the
`ROLE` env var alone — it never reads its own `argv`, so `docker compose run
--rm --no-deps worker node packages/.../fetch.ts …` **silently ignores** the
command you typed and starts an ordinary, idle `worker` instead (found live
while writing this section — it looked like nothing happened because nothing
had). Overriding the entrypoint replaces `tini -- node /app/entrypoint.mjs`
outright, so the trailing arguments become `node`'s own, exactly as typed.

Expect output naming the source, its last-modified date, the derived window
(1871-02..2024-12) and a line reading `matches the pin` before it writes
`shiller-monthly.csv`. The command derives the workbook into a canonical CSV
and **refuses to write anything** if that CSV's SHA-256 does not match the
value committed in `packages/contexts/planning/data/returns/SHA256SUMS`
(`REFUSED: the derived series hashes to …, the pin is …. Review, then
--pin.`) — a defence against an upstream file that has quietly changed shape,
not against Shiller re-uploading routinely (the raw file's own hash is
printed but not pinned; only the derived, window-bounded bytes are). The same
pin is checked again on every read (`loadReturnSeries`), so a cache file
edited, truncated or swapped out from under a running container is refused
the same way, never served as a silent, different distribution. A successful
fetch's checksum prefix travels into every Monte Carlo run's
`engine_version` column, so a stored run names the series that produced it.

**A restart is required after the fetch — this build does not re-read the
cache on its own.** Both the `api` and the `worker` process read the volume
exactly once, at boot, and hold whatever they found (or didn't) for the rest
of the process's life:

```bash
docker compose restart worker api
```

(A re-read-on-every-call design was prototyped for this condition and
rejected: it made the nightly `planning.projection_refresh` job stop writing
_any_ baseline run — not even the deterministic one it writes today — on an
install that has not yet fetched the series, because the nightly job's own
"deterministic or Monte Carlo" choice reads the same bound-or-not signal the
interactive route does. A documented restart is condition C-1's other named
exit, and the one this build takes; see `docs/evidence/phase-5/
wp5.13-carry-overs.md` §1 for the sabotage that proved the rejected design
regressed the nightly path.)

**What a missing series looks like.** Before the fetch (or before the
restart that follows it), `POST /plan/scenarios/{id}/projections
{"method":"monte_carlo"}` answers **409** with
`{"code":"planning.monte_carlo_unavailable", ...}` — never a 500, never a
silently substituted lognormal or deterministic result dressed up as Monte
Carlo. The plan screen says so in words ("The Monte Carlo engine is not
available on this install. It needs the operator to fetch the pinned return
series once") and offers the single deterministic path. A deterministic run is
labelled as one and is never phrased as a probability of success (WP 9.7,
C-8). The nightly refresh keeps producing its usual deterministic baseline
run in the meantime (`method: "deterministic"` in `projection_runs`), and the
retirement-wave advisors that read the newest _Monte Carlo_ baseline
(`newestBaselineRunId`, C-1) simply have nothing to prefer yet.

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

**Prove your first encrypted export once.** The code path is tested (`apps/api/test/db/export-encrypt.test.ts`
against a real `age` binary, and `export-encrypt-age-absent.test.ts` for the refusal when `age` is
missing: it never downgrades to plaintext), but a restore you have not tried is a rumour. After
your first `?encrypt=true` download, decrypt it with your age identity and compare it with a plain
`GET /export` of the same data:

```bash
age --decrypt -i "$HOME/personalfi-age-identity.txt" export.jsonl.age > export.decrypted.jsonl
```

(Run `age` from the backup image if the host has none:
`docker run --rm -i -v "$HOME/personalfi-age-identity.txt:/id:ro" --entrypoint age personalfi/backup:dev --decrypt -i /id < export.jsonl.age > export.decrypted.jsonl`.)

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
git pull && just upgrade
```

That is the whole upgrade, from any earlier release — including v0.1 — to this
one, skipping as many releases as you like (WP 9.4 proves it on every release
tag: `.github/workflows/upgrade-test.yml`, and the chain through every gate
commit at each gate: `bash scripts/upgrade-test/run.sh --path chain`). If you
pin images by version (`PERSONALFI_VERSION` in `.env`, required for the
production install), set it to the commit you pulled, in the same edit:
`PERSONALFI_VERSION=<sha> just upgrade`. Build from the checkout you pulled —
never point a checkout at images built from a different one.

Upgrade **to a commit that has `just upgrade`** (this section). A commit from
before it has no placeholder step, so stopping at one on the way — say v0.1 to
a Phase 2 commit by that commit's own instructions — fails at `docker compose
up` on the secrets it added (WP 9.4's finding F-94-2). If you ever must, run
this checkout's `bash scripts/secrets-placeholders.sh --project-dir <that
checkout>` first; it is the same step `just upgrade` runs.

**What is automatic** — every step that used to be a hand step:

1. **New secrets.** `scripts/secrets-placeholders.sh` creates every _optional_
   secret `compose.yml` declares that your install predates, **empty** (mode
   0444). An empty file is the same as no file to the app: the feature stays
   off until you write a real value (then `just harden-secrets`). It never
   overwrites a file, keeps `secrets/` at 0700, and **refuses** — before
   writing anything — if a _required_ secret (`database_url`, `pg_password`,
   `master_key`, `age_recipient`) is missing or empty. A v0.1 install is
   missing eleven optional files; without this, `docker compose up` stops at
   `secret file <project>_<name> does not exist`, then
   `bind source path does not exist: …/secrets/<name>`
   (older Compose: `secret … file not found`).
2. **The build** of `api`/`worker`/`migrator`, `backup` and `proxy` from the
   checkout.
3. **The pre-migration backup.** `docker compose up -d --wait` starts the
   `pre-migrate-backup` one-shot before the migrator. When migrations are
   pending against a database that has any, it takes one full backup — the
   same verified, age-encrypted `personalfi-<UTC timestamp>.dump.age` the
   nightly loop writes, into the same `backups` volume — plus a
   `personalfi-<timestamp>.pre-migrate` note naming what was applied and what
   was about to be. **If the backup fails, the migrator does not run, and
   neither do the new `api`/`worker`** (`migrator` waits on it
   `service_completed_successfully`). With nothing pending it exits at once. A
   separate `just backup` is no longer needed.
4. **Migrations.** The `migrator` one-shot applies whatever is pending and
   exits; `api` and `worker` start only after it completes. It **refuses a
   database that is newer than the code** — one holding a migration this
   checkout does not have — with `migration.database_newer`, naming the
   version, and `/ready` stays false on any `api` pointed at such a database.
5. **The checks.** `/ready` must answer 200, and after a settle period `api`
   and `worker` must still be running with a restart count of 0. The recipe
   prints the up-to-ready time and the pre-migration backup's outcome, and
   exits non-zero if any of this fails.

**If it fails**, the recipe prints the last lines of `pre-migrate-backup` and
`migrator`; `docker compose logs pre-migrate-backup migrator` has the rest.
A failure at step 1 or 2 changes nothing: the old version keeps serving. A
failure at step 3 or 4 changes nothing in the database either (a failed
pre-migration backup means no migration ran; a refused or failed migration
rolls itself back), but by then Compose has replaced the old `api` and `worker`
containers, so the app stays **down** until you fix the cause and run `just
upgrade` again — or roll back as below. It is never left serving a schema its
code does not match. Step 5 fails after a successful migration: the new
version is running; read why `api`/`worker` restarted, or why `backup` is
unhealthy, before anything else.

**On the production install, the isolation guard runs first.** When the compose project is
`personalfi-prod` (as `docker compose config` resolves it, `.env` included), `just upgrade` runs
`scripts/soak/check-isolation.sh` before it touches anything and stops on any violation: the
wrong project name, `PERSONALFI_VERSION` not a 40-character commit SHA, or the agent checkout's
directory. Every other project (a scratch install, the upgrade test, a gate) skips it, because
the guard refuses every project but production by design.

**Installing published images instead of building (pull-and-verify).** Once a release is tagged
(`v0.9.0` onward), the images `release.yml` built, signed and attested can be used instead of a local
build:

    git pull && git checkout v0.9.0
    PERSONALFI_VERSION="$(git rev-parse HEAD)" PERSONALFI_PULL=1 PERSONALFI_RELEASE=0.9.0 just upgrade

For each of `api`, `backup` and `proxy`, `scripts/verify-release.sh` resolves
`ghcr.io/<owner>/personalfi-<image>:0.9.0` to a digest once, then checks — by digest only — that the
cosign signature was made by this repository's `release.yml` at `refs/tags/v0.9.0` **at the commit
you have checked out**, and that GitHub holds a provenance attestation for it
(`gh attestation verify`, so `gh` must be logged in). Only if all three images pass are they pulled
by digest and tagged as the names compose runs; the upgrade then starts them with `--no-build`.
Any failure stops before anything is pulled, and the old version keeps serving. `cosign` is used
from your PATH, or run from its pinned container image if it is not installed. To check a release
without upgrading: `bash scripts/verify-release.sh --release 0.9.0 --commit <sha>`; to check the
verifier itself (it must accept a known-good signature and refuse an unsigned image):
`bash scripts/verify-release.sh --self-test`. Building from source stays the default.

**Rollback is "restore the pre-migration backup"** — never "pin the prior
image". Migrations are forward-only, and an older binary refuses the newer
schema (step 4), so the old advice now fails safe instead of serving a schema
the old code does not know. To go back to where you were before an upgrade:

```bash
git checkout <the commit you were on>      # the code that matches the backup
docker compose stop api worker proxy backup
docker compose run --rm --no-deps --entrypoint ls backup -1 /backups
# pick personalfi-<timestamp>.dump.age next to the newest .pre-migrate note, then
# restore it exactly as "Restore" below says (FORCE_RESTORE=1, your age identity):
docker compose run --rm --no-deps \
  -v /tmp/age-identity.txt:/run/age_identity:ro \
  -e AGE_IDENTITY_FILE=/run/age_identity -e FORCE_RESTORE=1 \
  backup /usr/local/bin/restore.sh /backups/personalfi-<timestamp>.dump.age
just upgrade                                 # or `docker compose up -d --wait` on a
                                             # checkout older than this section
```

Anything written between the backup and the rollback is lost — which is why the
backup is taken immediately before the first migration, not the night before.
(WP 9.4's evidence walks exactly this: an upgrade to a release one migration
ahead, the old image refused, the pre-migration backup restored, `just
upgrade` back to current, every fact intact.)

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

A restore drops every grant (`restore.sh` runs `pg_restore --no-owner --no-privileges`), and a
restore into a fresh cluster has no `personalfi_app` role at all (a role is in no database dump).
Nothing to do: `api` and `worker` re-create the role and its grants at every boot
(["Database roles"](#database-roles)).

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

---

## Restore drill

P0-11 / D24: an untested backup is a rumour. Run this monthly at minimum, and
after any change to `docker/backup/*.sh` or the schema.

```bash
export AGE_IDENTITY_FILE=/path/to/your/age-identity.txt
just restore-drill
```

This decrypts and `pg_restore`s the newest backup into a **throwaway**
Postgres container (never the live `db` service), boots a throwaway `api`
container against it, hits `/ready`, and compares table counts and the latest
applied migration against the live database. It tears down everything it
created on exit, pass or fail, and writes
`docs/evidence/ops/restore-drill-<date>.md` with a **PASS/FAIL verdict**
(`DRILL_EVIDENCE_DIR` redirects where; set it outside the checkout if you do not
want the report in your working tree). On first use it pulls two small images
pinned by digest.

The drill reads `AGE_IDENTITY_FILE` through a root container and copies it into a
scratch directory, so, on a rootful Docker, the file's own mode does not matter.
That is different from a real restore (above), where the `backup` container
reads it as uid 10002 and the file must be `chmod 644` for the few seconds the
command runs.

It asserts, and exits non-zero if any of these fails (H-5 — it used to collect
these numbers and never compare them, so the committed evidence read
"Restored db table count: 0 ... /ready: fail" and the recipe exited 0):

- restored table count > 0,
- restored table count == live table count,
- restored `schema_migrations` max version == live,
- `/ready` returns 200 from an api container pointed at the restored database.

A green run writes a report like this one:

```text
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
```

**Hold a plan scenario in the live database before you drill.** Since migration 0040 (WP 9.4's
finding F-94-6), a backup of a database holding a plan scenario restores correctly under
`pg_restore`'s empty `search_path`; before it, the restore failed on the constraint that checks a
scenario's levers, and every drill that passed had run against a database with no scenario to
show it. The drill is only as strong as the data it restores, and one row of any shape in `plan_scenarios`
is enough to exercise the fix. Check the live database holds one, and create one on the Plan screen
first if it does not:

```bash
docker compose exec -T db psql -U personalfi -d personalfi -tAc "select count(*) from plan_scenarios"
```

The drill needs `docker compose up` (or at least `create`) to have run at least once, so the
`backend` network and `backups` volume already exist. It finds them, and the live `db` container,
**by Compose project label**: on a host with more than one project, set `COMPOSE_PROJECT_NAME` to
the one you are drilling (the recipe refuses when the lookup is ambiguous rather than guess), and
`DRILL_SECRETS_DIR` redirects where it reads `pg_password` and `master_key` (default `./secrets`).
The verdict is also recorded in the database (`ops_restore_drills`), which is what the dashboard's
"restore drill passed" line reads; the dashboard warns after 35 days without a pass.

---

## Production install and the real-use soak

The soak (`docs/plan/09-phase-9-dispatch.md` §3 "WP 9.1") is Chris using
PersonalFi as his only finance tool for 90 days, on a **production install
that no agent and no gate ever touches**. This section is that install's rules,
its day-one checklist, the weekly report, who upgrades it and when, and the
monthly restore drill. It is the place where "dev", "the gate" and "production"
are told apart, because on this host they share a Docker daemon.

### Isolation rules (CF-20, CF-21)

Three facts found in the code at `1417b36` make a careless production install
destroyable by a routine agent or gate command, and each rule below answers one:

1. **Own directory, own project.** Production lives in its **own clone**
   (default `~/personalfi-prod`) at a pinned commit, never in the checkout the
   agents and the gate work in (`/home/chris/Projects/PersonalFi`).
   `compose.yml` has no top-level `name:`, so a Compose project is named after
   its directory by default; the gate's `down -v` targets a project by name.
   Set the name explicitly in the production clone's `.env`:

   ```bash
   COMPOSE_PROJECT_NAME=personalfi-prod
   ```

   That gives production its own volumes (`personalfi-prod_pgdata`,
   `personalfi-prod_backups`, …) by project name; the dev and gate stack's
   (`personalfi_*`) are a different set.

2. **A real commit, never `dev`.** Every image is tagged
   `${REGISTRY:-personalfi}/<service>:${PERSONALFI_VERSION:-dev}`, and every
   gate or agent `docker compose build` **overwrites `:dev`**. A production stack
   on `:dev` comes back up on unreviewed code at its next `up`. In the production
   `.env`:

   ```bash
   PERSONALFI_VERSION=<the 40-hex commit SHA you cloned at>
   ```

   `PERSONALFI_VERSION` is **required, and never `dev`, for production**. Build
   from the checkout you pulled; never point a checkout at images built from a
   different one.

3. **Own secrets, own address.** The production clone has its **own `secrets/`**
   (generated for it, never copied from the dev checkout), hardened per C-16
   with `just harden-secrets`, and its own bind address — the Tailscale or
   LAN address on 443 (`BIND_ADDRESS=<tailscale ip>`, `PUBLIC_HOST=<tailnet
name>`, see "Enabling remote access"). The dev and gate stack stay on
   `127.0.0.1`.

**The guard.** `scripts/soak/check-isolation.sh` refuses unless the project is
exactly `personalfi-prod`, the version is a 40-hex SHA, and the directory is not
the agent/gate checkout. It names **every** violation, not just the first:

```bash
cd ~/personalfi-prod
set -a; . ./.env; set +a                     # the guard reads the ENVIRONMENT, not .env — export .env first (just upgrade resolves it for you)
bash scripts/soak/check-isolation.sh          # reads COMPOSE_PROJECT_NAME and PERSONALFI_VERSION from the environment
bash scripts/soak/check-isolation.sh --self-test   # proves it refuses project personalfi, version dev, and this checkout
```

Run it before anything that could touch the production project. The weekly report
wrapper runs it for you.

**For agents and the gate** (Phase 9 rules 5 and 6, carried verbatim): production
is off-limits — its directory, project, volumes, images, secrets and database.
Every `docker compose` invocation names its own project with `-p` and its own
ports; `down -v` only on a project the invoker created; `docker volume prune`,
`image prune`, `system prune` and `builder prune --all` are forbidden outright
(a prune while production is stopped deletes production).

### Day one

Soak day one is targeted at **2026-10-12** (earliest v1.0 2027-01-10). The
checklist is `docs/plan/06-path-to-v1.md` "What only Chris can close", items 1–8:

1. Link **two real institutions** and let them sync on schedule.
2. A month of real data with **zero internal transfers in spend totals**
   (computed by the weekly report from the first complete month).
3. The recurring gold set against your own confirmed subscription list.
4. A real brokerage's holdings reconciling to its statement.
5. A projection run against real balances with real tax treatment per account.
6. A view-only Coinbase CDP key, so the live on-ramp and ETH-on-one-row checks run.
7. The decisions with stated defaults the work is proceeding on (return-series
   licence; merchant-pseudonym construction — decide **before the first real
   link**; plan terms; the local model).
8. The Phase 0 hand actions: production LUKS2, Tailscale HTTPS, real secrets,
   B2 with object lock.

Then install production from a CI-green commit (`First install`, steps 0–7, in
the production clone, with the three rules above in its `.env`), run the
return-series fetch (`Monte Carlo return series`), and **write day one** in
`docs/evidence/phase-9/soak/clock.md` (on the dev checkout; commit and push it).

### The clock

`docs/evidence/phase-9/soak/clock.md` holds **your** dated attestations, one table
row each: `| YYYY-MM-DD | event | one-line note |`. The events:

| Event                       | Meaning                                                                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `day_one`                   | The soak started: production installed, two institutions linked, other tools retired.                                              |
| `attest`                    | "This week I used only PersonalFi, nothing went wrong that I have not written here." One per week keeps the week clean.            |
| `fallback`                  | You used another tool or a spreadsheet for something. **Resets the clock** to this date (09 §8.2: zero in the final 90).           |
| `data_loss`                 | Data lost beyond the 24 h RPO. **Resets the clock.**                                                                               |
| `outage_start`/`outage_end` | Production was down. An outage **over 24 h** without loss **pauses** the clock for its length.                                     |
| `upgrade`                   | A record of `just upgrade` (the SHA). Bookkeeping: **never resets or pauses**, and does not count as an attestation.               |
| `criterion`                 | A judged line for the criteria ledger: `3: met - gold set matched my list` (`met`, `failed` or `observing`, criteria 3–8, 10, 11). |

The weekly report prints "day N of 90" from the latest reset, and **prints a
week with no attestation as a GAP, never as clean** — a gap is the clock telling
you it has no evidence for that week, not a pass. Day one is day 1.

### The weekly soak report

`scripts/soak/report.ts` reads **aggregates and whitelisted dimensions only** (ISO
week, connection ordinal, provider kind, status, job kind, reason code): never an
amount, a name, a memo, an institution, a merchant or a goal — enforced by a
structural test, an output-column whitelist, and a canary test, because the file
is committed and pushed. It runs in one READ ONLY transaction. It is **the
orchestrator's alone** (rule 5); an agent never runs it against production.

From the production clone (the wrapper runs the isolation guard first, mounts the
one script and `clock.md` read-only into a throwaway `api` container — the image
deletes `scripts/`, so this is how it gets in — and writes the file only if the
report succeeded):

```bash
cd ~/personalfi-prod
COMPOSE_PROJECT_NAME=personalfi-prod PERSONALFI_VERSION=<sha> \
SOAK_EVIDENCE_DIR=/home/chris/Projects/PersonalFi/docs/evidence/phase-9/soak \
  just soak-report                                     # = bash scripts/soak/run-report.sh
# -> .../week-YYYY-Www.md ; commit it and push
```

`SOAK_EVIDENCE_DIR` is where `clock.md` is read and the week file written (the
production clone is pinned and is not where evidence is committed). Optional
flags: `--as-of 2026-11-09T12:00:00Z` (a backfill week), `--label TEXT`.

Without a container — from a checkout with a database URL it can reach (a dev
database, a restored copy):

```bash
DATABASE_URL=postgres://… node --experimental-strip-types scripts/soak/report.ts \
  --clock docs/evidence/phase-9/soak/clock.md --out docs/evidence/phase-9/soak
```

Each file carries the sections (sync health per connection ordinal, ledger
invariants as counts, categorisation, review burden, the Brief, notifications,
jobs, auth, backups and drills, the assumptions file's age, upgrades applied),
the clock, and the **criteria ledger**: 06 items 1–8, the Brief's first month,
the narrator, "only finance tool". Criteria 1, 2 and 9 are computed; the rest are
your `criterion` rows. The report does not need to exist first — it backfills.

### Who upgrades production, and when

**You do. Nothing an agent does touches production** (09 §6 Q6). After each wave
lands and CI is green, the orchestrator posts "wave X at `<sha>`, CI green". Then,
in the production clone:

```bash
git fetch && git checkout <sha>
bash scripts/soak/check-isolation.sh            # with PERSONALFI_VERSION=<sha> in .env
just upgrade                                     # see "Upgrade": automatic pre-migration backup
```

and add an `upgrade` row to `clock.md`. Each upgrade is a real-world observation
for v1.0's second clause and is recorded by the report from
`schema_migrations.applied_at`. **Every Phase 9 migration is expand-only**; upgrades
never reset the clock.

### The monthly restore drill

D24: an untested backup is a rumour. Monthly at minimum — next due **2026-11-05**
from the 2026-10-05 drill. The dashboard shows "Last backup 4 h ago · restore
drill passed 2026-10-13" and turns that line into a warning past 26 h without a
successful backup (`BACKUP_MAX_AGE_SECONDS`) or past 35 days without a drill.
Both facts come from `ops_backup_runs` and `ops_restore_drills`, which
`docker/backup/backup.sh` and `just restore-drill` write (best-effort: a database
that predates migration 0036 simply has no rows).

```bash
cd ~/personalfi-prod
export COMPOSE_PROJECT_NAME=personalfi-prod PERSONALFI_VERSION=<sha>
export AGE_IDENTITY_FILE=/path/to/your/age-identity.txt
just restore-drill
```

**On a host with more than one Compose project, `COMPOSE_PROJECT_NAME` is
required**: the recipe looks up the `backups` volume, the `backend` network and
the live `db` container by Compose label, and unset it **refuses** when the lookup
is ambiguous rather than drilling — and writing its verdict into — the first
project it finds. `DRILL_SECRETS_DIR` and `DRILL_EVIDENCE_DIR` redirect the two
paths the recipe otherwise takes from the checkout (`./secrets`,
`docs/evidence/ops`), so a scratch project can be drilled without touching either.

---

## Database roles

Until v0.9.0, `api`, `worker`, `migrator` and `backup` all connected as `personalfi`: the cluster's
bootstrap **superuser** (it can `COPY ... TO PROGRAM`, disable triggers and read server files) and
the owner of every table. A SQL injection or a compromised dependency in the serving process was
therefore a few statements from the host (9.10's finding G-01). Migration 0039 adds a second role.

**`personalfi_app`** is `NOLOGIN` by default and has no superuser, `CREATEDB`, `CREATEROLE`,
`REPLICATION` or `BYPASSRLS`. It holds `SELECT`, `INSERT`, `UPDATE` and `DELETE` on every table and
`USAGE`, `SELECT` and `UPDATE` on every sequence (including every table a later migration
creates), owns nothing, and may create nothing. It can only **read** `schema_migrations`, and it
cannot `UPDATE`, `DELETE` or `TRUNCATE` `security_events`: the audit trail is append-only (a trigger
refuses the rest for every role).

**What you get with no action.** `api` and `worker` start every pooled connection with the libpq
option `-c role=personalfi_app`, so the server sets the role before the first query, and `RESET ROLE`
returns to it rather than to the login. At every boot each calls `personalfi_app_grants()`
(idempotent), because a restore drops both the grants (`pg_restore --no-owner --no-privileges`) and,
into a fresh cluster, the role itself (a role is cluster-wide and is in no database dump). This
stops accidental DDL and the injection path to `COPY ... TO PROGRAM`. It is **not** a hard boundary
while the login (`database_url`) is still the superuser: code that runs `SET ROLE NONE` gets it back.
The `migrator` keeps DDL by connecting as the owner. Check it:

```bash
docker compose exec -T db psql -U personalfi -d personalfi -tAc \
  "select rolname, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolcanlogin from pg_roles where rolname in ('personalfi', 'personalfi_app')"
docker compose logs api | grep "database connections use the app role"
```

`personalfi_app` shows `f` for the first four columns. The api and the worker each log the line
above at boot; the line `could not ensure the database app role` means the migrations have not
run yet (`docker compose logs migrator`).

**The split (optional; the real boundary).** Make `database_url` log in as `personalfi_app` itself,
and give the migrator the owner's URL through the optional secret `migrator_database_url`. Then the
serving processes hold no DDL right and no superuser, whatever code runs in them. Nothing about
`just upgrade`, the pre-migration backup, `backup` or the restore drill changes: they keep using
`personalfi` and `pg_password`. Do it once, on the stack that is up, as the owner:

```bash
app_pw="$(openssl rand -hex 32)"
printf "ALTER ROLE personalfi_app LOGIN PASSWORD '%s';\n" "$app_pw" \
  | docker compose exec -T db psql -U personalfi -d personalfi -v ON_ERROR_STOP=1
chmod u+w secrets/database_url secrets/migrator_database_url
cp secrets/database_url secrets/migrator_database_url      # the owner's URL, unchanged
printf 'postgres://personalfi_app:%s@db:5432/personalfi\n' "$app_pw" > secrets/database_url
chmod 0444 secrets/database_url secrets/migrator_database_url
unset app_pw
docker compose restart api worker
```

(If you have run `just harden-secrets`, the files belong to uid 10001 at mode 0400: write them with
`sudo tee`, then run `just harden-secrets` again, which also covers `migrator_database_url`.)
Check that the serving connections are now the app role's own:

```bash
docker compose exec -T db psql -U personalfi -d personalfi -tAc \
  "select usename, count(*) from pg_stat_activity where datname = 'personalfi' group by 1"
```

`personalfi_app` carries the api's and the worker's connections. **To undo the split**, write the owner's
URL back to `secrets/database_url`, empty `secrets/migrator_database_url` (an empty file is the
same as none), and `docker compose restart api worker`. `migrator_database_url` is optional by rule:
a required new secret would break the unattended upgrade, so an install that never splits is
unchanged, and an empty file means "use `database_url`".

---

## Master-key rotation

**There is no operator procedure for rotating the KEK today.** The primitive exists and is
unit-tested (`SecretBox.rotateKek` in `packages/secretbox`: it re-wraps every DEK under a new KEK
generation), but no `just` recipe or route reaches it, and it has never been exercised against a
running stack (9.10's finding G-04, tracked for a later release). The design rationale is in
03 §2 and D5; the scope rule is **"key loss = re-link providers, never = lose the ledger"**, and it
only holds if rotation goes through the path the identity context implements, not a file swap.
So:

- **Do not hand-edit `secrets/master_key` on a box with existing encrypted data.** The api and the
  worker would derive a different KEK, refuse to unlock (`passphrase_mismatch`, the `/unlock` screen
  says so) and every sealed value would be unreadable until the original file is back.
- **If you suspect the passphrase leaked**, run the [panic checklist](#panic-button-outline): it
  revokes every provider credential at its source, which is what makes the sealed copies of them
  worthless to whoever holds the passphrase and a database copy.
- Back up `master_key` somewhere that is not this host, as soon as `just gen-master-key` writes it.
  Without it, a restored backup holds ciphertext nothing can open.

---

## Lockout and operator unlock

Authentication failures are rate limited and locked out **in Postgres**, so a restart (which an
attacker who can reach `/auth` might provoke) does not reset them. A locked or limited attempt gets
`429` with `Too many attempts. Try again in N seconds.`

| Bucket                       | Allowed per window |
| ---------------------------- | ------------------ |
| `webauthn` (passkey sign-in) | 10 per 5 minutes   |
| `totp`                       | 5 per 15 minutes   |
| `recovery_code`              | 5 per hour         |
| `refresh`                    | 60 per hour        |
| `unlock` (KEK passphrase)    | 5 per hour         |
| `register` (enrolment)       | 10 per hour        |

Separately, **ten consecutive failures** in a bucket lock that subject (an IP address, or
`user:<uuid>`) for 15 minutes, doubling at each repeat up to a ceiling of **24 hours**. A success
clears the failure count but not the level; the level decays after a full quiet maximum window.
The ceiling is deliberate: a permanent lockout on a one-user app with no support desk is a
self-inflicted denial of service.

**Waiting is the normal answer.** If you cannot wait, read why, then clear it from the host. The
tables are `auth_lockouts` (the lock) and `auth_attempts` (the window counters), and the audit
trail is `security_events`:

```bash
docker compose exec -T db psql -U personalfi -d personalfi -c \
  "SELECT occurred_at, kind, outcome, ip FROM security_events ORDER BY occurred_at DESC LIMIT 20"
docker compose exec -T db psql -U personalfi -d personalfi -c \
  "SELECT bucket, subject, consecutive_failures, lock_level, locked_until FROM auth_lockouts ORDER BY updated_at DESC LIMIT 20"
```

Only after you know the failures were yours (or that you accept the risk of clearing an attacker's
lock), clear it:

```bash
docker compose exec -T db psql -U personalfi -d personalfi -c \
  "UPDATE auth_lockouts SET consecutive_failures = 0, lock_level = 0, locked_until = NULL, updated_at = now(); DELETE FROM auth_attempts"
```

**Lost every passkey and every recovery code.** `just bootstrap-user reissue=true` mints a new
one-hour enrolment link for the existing account. It works only from a shell on the host (which
already owns the database and `master_key`), so it grants nothing the shell did not. A session
reached through TOTP or a recovery code alone is single-factor and **cannot** export, change
factors or credentials, or act on advisors (none of those sessions is step-up fresh); enrol a
passkey first.

**KEK unlock.** The KEK is unlocked by the server reading `secrets/master_key` at boot, never by a
passphrase typed into a browser. The `/unlock` screen only reports the state: `no_passphrase` (the
file was empty or missing when the server started: fix the file and restart `api` and `worker`) or
`passphrase_mismatch` (the file is not the one this data was sealed with).

---

**Sessions.** Any number of browser sessions may be signed in at once; each lasts 8 hours (14 days
on a trusted device) unless you sign it out, sign out everywhere, or a replayed refresh token kills
it. `GET /api/auth/sessions` lists them and `DELETE /api/auth/sessions` signs out every other one
(both need a fresh passkey assertion); the settings screen for it is WP 9.14's.

**A leaked TOTP seed** is revoked with `DELETE /api/auth/totp` (fresh passkey assertion), or replaced
by enrolling and confirming a new one, which swaps it in atomically.

## Advisor kill switches

Four independent ways to stop an advisor (WP 5.1; 05-phase-5-dispatch.md §3). Any one of them is
enough, and each is checked **three times per run**: before it starts, **once a second while it is in
flight** (the run watcher aborts the call), and at the **write barrier** — under a row lock, just before
anything is written — so a kill that lands between the model's reply and the insert still writes
nothing. A refused or cancelled run always names the **broadest** level that applied.

| Level     | Mechanism                                                             | Scope                       | Default | Who flips it              | Survives restart |
| --------- | --------------------------------------------------------------------- | --------------------------- | ------- | ------------------------- | ---------------- |
| 1 Module  | `ADVISORS_ENABLED` (env) **and** `module.insights` (flag)             | every advisor               | on      | operator / user           | yes              |
| 2 Kind    | `advisors.kind.local_model` (flag) **and** `LOCAL_MODEL_ENDPOINT` set | every `local_model` advisor | **off** | user, step-up / operator  | yes              |
| 3 Advisor | `advisors.enabled` **and** the breaker's `quarantined_at`             | one advisor                 | off     | user, step-up / the app   | yes — rows       |
| 4 Run     | `advisor_runs.cancel_requested_at`; the run's deadline                | one run                     | —       | user, step-up / the clock | n/a              |

Under all four sits `docker compose stop ollama`. It is not a level — nothing records it — but it stops
the model container outright; a run waiting on it fails fast (WP 5.2) and the rest of the app is
unaffected.

**A kill stops the run at once; it does not always stop the model.** Levels 1–4 close the run within
about a second and the write barrier guarantees nothing is written, but the model container may keep
computing after our side of the connection is gone: Ollama finishes the prompt-evaluation batch it is
in before it notices the socket closed. The Phase 5 gate measured `ollama` at about 390 % CPU for about
38 s after a level-4 cancel (after levels 1–3 it dropped within 4 s). The cost is CPU and a queued next
request, never a write. If you need the model idle now, `docker compose stop ollama` (below).

Every level has a route and a control on the advisor-management screen (`/settings/advisors`; WP 5.12,
completed by WP 9.6): level 1's two halves and its holder switch at the top of the screen (G5-14), the
local-model kind switch (level 2), the per-advisor switch (level 3) and "Cancel this run" in the run
inspector (level 4). Levels 1 and 2 **read back their real state**, in words, from
`GET /advisors/module/enabled` and `GET /advisors/kinds/local_model/enabled` — the screen no longer
shows only the last write. The holder's switches (levels 1–4) need a fresh passkey assertion; level 1's
operator half (`ADVISORS_ENABLED`) is shown on the screen but only a change to `.env` and a restart
moves it. The database commands below use `psql` on the production stack
(`docker compose exec db psql -U personalfi -d personalfi`) only as a fallback when the app itself is
unreachable, or where no route covers the case — level 3's breaker-driven quarantine is read-only from
SQL.

**Level 1 — everything off.**

- Operator, whole deployment: set `ADVISORS_ENABLED=false` in `.env`, then
  `docker compose up -d api worker`. The restart ends any in-flight run with its process; nothing runs
  again until it is `true`.
- User, this account: the **Insights module** switch at the top of Settings → Advisor management
  (passkey step-up), or `PUT /advisors/module/enabled` `{"enabled": false}`. Takes effect **within one
  second** on a run in flight — flags are read uncached on the run path. `GET /advisors/module/enabled`
  (and the screen) report both halves and whether advisors are effectively on. The SQL is only the
  fallback for an unreachable app:
  ```sql
  INSERT INTO feature_flags (user_id, key, enabled)
  SELECT id, 'module.insights', false FROM users
  ON CONFLICT (user_id, key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now();
  ```
  `POST /advisors/run` then answers **409 `insights.module_disabled`** and runs nothing. The worker stops
  registering the nightly schedule and the insights consumer at its next start.

**Level 2 — every local model off** (the built-in rules keep running).

- User: the local-model kind switch on the same screen, or `PUT /advisors/kinds/local_model/enabled`
  `{"enabled": false}` (step-up). It ships `false`. The route only accepts a kind with a declared flag —
  today that is `local_model` alone — and answers 404 `insights.kind_flag_not_found` for any other.
  `GET /advisors/kinds/local_model/enabled` answers `{enabled, configured, effective}`: the flag, whether
  this deployment has a model configured (`LOCAL_MODEL_PIN_NAME` and `LOCAL_MODEL_PIN_DIGEST` on the api,
  which compose takes from `LOCAL_MODEL_NAME` and `LOCAL_MODEL_DIGEST`), and both together.
- Operator: leave `LOCAL_MODEL_ENDPOINT` empty. With no endpoint no local advisor is registered, and the
  kind is off whatever its flag says.

**Level 3 — one advisor off.** `POST /advisors/{advisorId}/enabled` `{"enabled": false}` (step-up), or:

```sql
UPDATE advisors SET enabled = false, enabled_source = 'user', updated_at = now()
 WHERE advisor_id = '<advisor id>';
```

`enabled_source = 'user'` matters: a row still marked `default` follows the catalogue, and the next
api start would put the catalogue's value back. The **breaker** pulls this level on its own —
`quarantined_at` set, `quarantine_reason` `consecutive_failures` or `rejection_rate` — at **3** consecutive
failures or **5** validator rejections in a rolling 24 h for a `local_model` advisor, and at **5**
consecutive failures or one run ≥ 50 % refused (with ≥ 4 proposals) for a built-in. A quarantine never
decays; clear it with `{"enabled": true, "clearQuarantine": true}` on the same route, after reading why.

**Level 4 — one run.** `GET /advisors/{advisorId}/runs` to find it (or `GET /advisors/runs/{runId}` for
one already known), then `POST /advisors/runs/{runId}/cancel` (step-up) to ask it to stop; it closes
within about a second under the advisor's row lock, naming `cancel_reason = run_cancelled`. 404 if the
run is not the caller's, 409 `insights.run_not_in_flight` if it has already finished. Directly, when
neither route is reachable:

```sql
SELECT id, advisor_id, started_at FROM advisor_runs WHERE status = 'started' ORDER BY started_at;
UPDATE advisor_runs SET cancel_requested_at = now() WHERE id = '<run id>' AND status = 'started';
```

The deadline is the other half of this level: a run past its manifest's `timeout_ms` (never above 300 s;
a local model's is `LOCAL_MODEL_TIMEOUT_MS`) is aborted by us.

**What each looks like in `advisor_runs`.**

```sql
SELECT advisor_id, status, refusal, cancel_reason, cancel_requested_at, error_code,
       llm_model, started_at, finished_at
  FROM advisor_runs ORDER BY started_at DESC LIMIT 20;
```

| Situation                                                                | `status`                    | `refusal` / `cancel_reason` / `error_code`                                                               |
| ------------------------------------------------------------------------ | --------------------------- | -------------------------------------------------------------------------------------------------------- |
| Level 1 off before the run                                               | `refused`                   | `refusal = advisors_disabled` or `module_disabled`                                                       |
| Level 2 off before the run                                               | `refused`                   | `refusal = kind_disabled`                                                                                |
| Level 3 off / quarantined before the run                                 | `refused`                   | `refusal = advisor_disabled` / `advisor_quarantined`                                                     |
| Local model whose payload shape was never approved                       | `refused`                   | `refusal = payload_not_approved`                                                                         |
| Any level flipped **during** the run, or between the reply and the write | `cancelled`                 | `cancel_reason` = the broadest level's name; `run_cancelled` for level 4, with `cancel_requested_at` set |
| The deadline                                                             | `failed`                    | `error_code = advisor_timeout` (counts toward the breaker; a kill does not)                              |
| A process killed mid-run                                                 | `started`, no `finished_at` | — (what an interrupted run looks like)                                                                   |

A refused run has no `input_digest`: nothing was built. A cancelled one keeps the digest of what was
sent before it was stopped, and `insights.AdvisorRunCancelled` names the level and whether the watcher
(`in_flight`) or the barrier (`write_barrier`) caught it. Either way, **no insight is written**.

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
on this box," and a single panic script that always does the same
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
```

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

## Local model (profile `local-llm`)

The optional `local_model` advisor runs against **Ollama on this host**, in its own container on its
own internal network (WP 5.2; 05-phase-5-dispatch.md §3, §6 Q1–Q2). Nothing here is needed for the
rest of the app: with `LOCAL_MODEL_ENDPOINT` empty (the default) no local advisor is registered and
none of this runs. Budget: **~5 GB of RAM and 4 of 8 threads** while a model is loaded (limit 8G);
Ollama unloads an idle model after 5 minutes.

The sandbox, in one paragraph: `ollama` joins only the `llm` network, which is `internal: true`
(no route off the host) and whose only other member is `worker`; `api` and `db` are not on it. It
runs as uid 10003 on a read-only root filesystem with every capability dropped, no secret, no
published port, the model store mounted **read-only**, and debug logging off (at debug level Ollama
logs prompt content). The adapter in `worker` reaches it only through the local-endpoint policy —
a single-label name that must resolve to a private or loopback address, never a public one — and
refuses to send a prompt unless the served model's digest is the one pinned below.
`bash scripts/compose-hardening-check.sh` enforces the compose half on every commit.

### Pull (the only time the model runtime touches the internet)

1. Choose the model. The reference is **`qwen2.5:7b-instruct-q4_K_M`** (Apache-2.0, 7.6B, 4-bit,
   ~4.7 GB). With less than 16 GB of RAM, a 3–4B model is the fallback (05 §6 Q1); the ≥95%
   narration criterion is measured on whatever you choose.
2. In `.env`: `LOCAL_MODEL_NAME=qwen2.5:7b-instruct-q4_K_M`.
3. Pull, with the one-shot service in its own profile, on its own network that reaches neither
   `backend` nor `llm`:
   ```bash
   docker compose --profile local-llm-pull run --rm ollama-pull
   ```
   It pulls into the `ollama_models` volume and ends by printing one line per model:
   `<64 hex>  /var/tmp/ollama/models/manifests/registry.ollama.ai/library/qwen2.5/7b-instruct-q4_K_M`.

### Pin

4. `LOCAL_MODEL_DIGEST=sha256:<the 64 hex on your model's line>`. For the reference model that is
   `sha256:845dbda0ea48ed749caafd9e6037047aa19acfcfd82e704d7ca97d631a0b697e` — if the pull prints
   anything else, the tag has moved upstream: stop and decide whether to adopt the new model (and
   re-run the narration evaluation, WP 5.3) before changing the pin. The digest is the sha256 of the
   model's manifest, which is exactly what `GET /api/tags` reports, and the adapter checks it
   **before and after every run**: a different digest refuses the run `model_digest_mismatch`
   without sending a prompt.

### Configure

5. In `.env` (all read by `worker` only):
   ```bash
   LOCAL_MODEL_ENDPOINT=ollama:11434        # a single-label compose name; http is fine on `llm`
   LOCAL_MODEL_NAME=qwen2.5:7b-instruct-q4_K_M
   LOCAL_MODEL_DIGEST=sha256:845dbda0ea48ed749caafd9e6037047aa19acfcfd82e704d7ca97d631a0b697e
   LOCAL_MODEL_TIMEOUT_MS=180000            # one narration's deadline; never above 300000
   LOCAL_MODEL_ALLOW_REMOTE=false
   ```
   `@core/config` refuses to boot with an endpoint but no name or digest. The adapter refuses to
   build (and so the worker to boot) on an endpoint the policy rejects: a dotted name, an IP literal,
   a path, or credentials in the URL.
   **A LAN box instead of this host** (05 §6 Q2): only behind TLS —
   `LOCAL_MODEL_ENDPOINT=https://llm.lan:443` with `LOCAL_MODEL_ALLOW_REMOTE=true`; plain `http` is
   refused once remote is allowed, and the name must still resolve to a private address (a Tailscale
   100.64/10 address is CGNAT, not private, and is refused).
6. The kill ladder's level 2 ships **off**: turn `advisors.kind.local_model` on (and the advisor's own
   switch, level 3) as "Advisor kill switches" above describes, and approve its payload preview.
   **After an upgrade past WP 9.5, approve it again.** The narrator now writes figure slots
   (`{{e1}}`) and the app fills each one with the finding's own figure beside its label, so the
   prompt template and reply format changed. That changes the template hash, so an approval given
   before 9.5 covers a different query shape; until it is re-approved, a narration is refused
   `payload_not_approved`.

### Start

7. ```bash
   docker compose --profile local-llm up -d ollama
   docker compose up -d api worker        # worker: the endpoint; api: the model's name and digest (the payload preview)
   docker compose ps ollama               # healthy after the first `ollama list` succeeds
   ```
   The first request after a start finds the model cold. The adapter then loads it with one
   data-free warm-up call (the constant system prompt and a constant line, one token), and only after
   that sends the narration (WP 9.5). The warm-up spends the headroom the narrator's 300 s request
   deadline leaves above `LOCAL_MODEL_TIMEOUT_MS`, so the narration still gets its full 180 s.
   Measured on this host: about 60 s to load, then a 94 s narration. The worker log's
   `local_model.run` line carries `model_before` (`cold`/`warm`), `warm_up` and `warm_up_ms`; a failed
   warm-up logs `local_model.warm_up_failed` once and is not retried.

### Stop

8. `docker compose stop ollama` — the model container stops; the rest of the app is unchanged. A local
   run in flight fails **at once** (its connection resets) and a new one fails in milliseconds
   (`model_unavailable`: the name no longer resolves), recorded as a failure that counts toward the
   advisor's breaker. To turn the feature off rather than pause it, clear `LOCAL_MODEL_ENDPOINT` and
   `docker compose up -d worker`.

### What each kill looks like from here

| Kill                                                                      | What the model container sees                                                                      | What the run records                     |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Level 1–3 flipped mid-run (watcher, ≤ 1 s)                                | the chat connection closes mid-stream; generation usually stops within seconds, not always at once | `cancelled`, `cancel_reason` = the level |
| Level 4, `cancel_requested_at`                                            | the same (measured: CPU stayed high for ~38 s once)                                                | `cancelled`, `run_cancelled`             |
| Our deadline (`LOCAL_MODEL_TIMEOUT_MS` / the request's `limits.deadline`) | the connection closes                                                                              | `failed`, the adapter's `model_timeout`  |
| `docker compose stop ollama`                                              | — (it is gone)                                                                                     | `failed`, `model_unavailable`            |
| A re-tagged or re-pulled model                                            | a `GET /api/tags`, **no** chat request                                                             | `failed`, `model_digest_mismatch`        |
| A reply that will not stop                                                | the connection closes at 512 KiB of stream                                                         | `failed`, `model_reply_too_large`        |

The adapter's log lines (`event: local_model.run` / `local_model.failed` in `worker`'s log) carry
sizes, the digest, token counts and durations, never prompt or reply text. `docker compose logs
ollama` should never show one either; if it does, `OLLAMA_DEBUG` is on and that is a finding.

### Upgrading the image

The image is pinned by digest in `compose.yml` (`ollama/ollama:0.34.2@sha256:da6e0dc5…`), not by tag.
To move it: pick a release at least seven days old, `docker buildx imagetools inspect
ollama/ollama:<version>`, replace the digest, update `THIRD_PARTY.md`, run
`bash scripts/compose-hardening-check.sh`, and repeat the live checks in
`docs/evidence/phase-5/wp5.2-local-model.md` §8 on the new image.

---

## Language model: local or bring your own key (v0.9.5)

The narrator — the only part of the product that uses a language model — rewords a Brief finding
in plain English. It never decides anything and never adds a number: every figure is the app's, and
a reply that introduces one is refused. By default it runs on the local model
([Local model](#local-model-profile-local-llm)). Since v0.9.5 (decision D30) the holder can choose,
in **Settings, Language model**:

| Provider                         | What it needs                                                                                                                                                                                                                              | Talks only to                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| **Ollama (local)** — the default | The operator's `LOCAL_MODEL_*` (and `LOCAL_MODEL_PIN_*` on the api), or, when those are unset, an endpoint, model name and `sha256:` digest set in the card (the same local-endpoint policy applies; an optional bearer token for a proxy) | The `ollama` service on the internal `llm` network |
| **OpenAI**                       | The holder's key and the consent box                                                                                                                                                                                                       | `api.openai.com`                                   |
| **OpenRouter**                   | The holder's key and the consent box                                                                                                                                                                                                       | `openrouter.ai`                                    |
| **Anthropic**                    | The holder's key and the consent box                                                                                                                                                                                                       | `api.anthropic.com`                                |
| **Off**                          | —                                                                                                                                                                                                                                          | nothing: the Brief shows its own wording           |

**The consent.** A hosted provider cannot be made active until its box is ticked. The text the
holder ticks, recorded with its version (`narrator-consent/1`) and the sha256 of the exact words:

> Send the narrator's payload to &lt;Provider&gt; (&lt;host&gt;) with my own key. What leaves this
> machine: Brief findings: aggregated amounts, bucketed, merchants pseudonymised — never a
> transaction, never an account number. I see the exact payload before anything is sent, and approve
> it first. &lt;Provider&gt;'s own terms apply to what it receives.

Unticking it for the active provider turns the narrator **Off**.

**Keys.** Two ways, as for Plaid and market data: the operator's secret file
(`secrets/openai_api_key`, `openrouter_api_key`, `anthropic_api_key`; a non-empty file wins and the
card shows "file", read-only), or the holder's own key in the card (**Save with passkey**), sealed
under the KEK in `provider_credentials`, never shown again (only its last four characters), never
logged or exported. **Remove** deletes it and retires its key; it revokes nothing at the provider.

**Switching.** Making a hosted provider active, or changing its model, withdraws the narrator's
payload approval: approve the payload again in Advisor management, where the preview names the
provider and model it will go to. The worker picks a change up without a restart (at once through
`insights.NarratorSettingsChanged`, at worst after its 30 s cache). Each narration on the Brief
says who wrote it ("Narrated by Anthropic claude-sonnet-5-5", "Narrated by the local model …").

**Test.** Each card's **Test** sends a fixed probe with no personal data (an instruction to return
an empty narration, under the narration's reply format) and reports the round trip in words. A
hosted Test spends one call of the provider's hourly window (30 calls an hour per provider, per
process). The api has no route to the local model, so the Ollama Test checks the configuration and
says the worker verifies the model's digest before every narration.

**Egress.** Each hosted adapter is built with an egress policy naming one host, `https`, port 443;
DNS is classified before the connect and a redirect is never followed. No other host is reachable
for this purpose. The worker (narrations) and the api (the Test) use their existing `backend`
network's outbound HTTPS; no compose network changes.

**Defaults.** Anthropic `claude-sonnet-5-5`; OpenAI `gpt-6.1-sol`; OpenRouter
`anthropic/claude-sonnet-5.5`. Any model id the vendor serves can be set in the card; a model that
cannot return structured output fails the Test ("refused the request") rather than a Sunday
narration. The timeout is `LOCAL_MODEL_TIMEOUT_MS` (the same 300 s ceiling).

**Turning it off.** Settings, Language model, **Off**; or untick the consent; or, operator-wide, the
existing kill switches ([Advisor kill switches](#advisor-kill-switches)) — they apply to a hosted
narrator exactly as to the local one, including a run in flight.

## Cryptography inventory

What is encrypted or hashed, with what, where the key lives, and how it rotates. The primitives
live in one place, `packages/secretbox/src/primitives.ts`, enforced by ESLint (any `node:crypto` or
noble import elsewhere fails lint); the two carve-outs are the migration checksum and the Coinbase
JWT. Every primitive is an industry-validated implementation, none hand-rolled. The assessment's V11
rows ([ASVS](docs/security/asvs-assessment.md)) are the evidence behind each line.

| What                                                                                             | Algorithm                                                                                                                                                                         | Key or secret                                                                                                                                                      | Where it lives                                                                                                           | Rotation                                                                               |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Key-encryption key (KEK)                                                                         | Argon2id (`hash-wasm`), m = 1 GiB, t = 4, p = 4; the production floor refuses a lower setting                                                                                     | The `master_key` passphrase (48 random bytes, base64url) plus a per-install 32-byte salt                                                                           | The passphrase in `secrets/master_key`; the KEK in memory only (derived at boot by `api` and `worker`, wiped on SIGTERM) | No operator procedure yet ([Master-key rotation](#master-key-rotation))                |
| Data-encryption keys (DEKs)                                                                      | Random 256-bit keys, wrapped under the KEK with XChaCha20-Poly1305                                                                                                                | Generated per record (provider credentials: deleting one DEK is cryptographic erasure of that credential) or per column epoch (bulk PII such as transaction names) | The `encryption_keys` table (the keyring), wrapped                                                                       | Epoch DEKs rotate by bumping the epoch; per-record DEKs with the credential            |
| Sealed columns (provider tokens, exchange credentials, wallet descriptors, TOTP seeds, bulk PII) | XChaCha20-Poly1305 with a 24-byte random nonce and a mandatory AAD binding `personalfi/v1`, table, column, row and key version; envelope `version, key id, nonce, ciphertext+tag` | The DEKs above                                                                                                                                                     | Postgres columns                                                                                                         | With their DEK                                                                         |
| Session and refresh tokens                                                                       | 256 bits from the CSPRNG, base64url; only the **SHA-256 digest** is stored                                                                                                        | The token itself, in the browser                                                                                                                                   | Cookie; digest in `sessions`                                                                                             | Per session; reuse of a refresh token is detected and logged                           |
| Recovery codes                                                                                   | Argon2id, PHC-encoded (verify only, never decryptable)                                                                                                                            | The ten codes shown once at enrolment                                                                                                                              | Hashes in the database; the codes on paper, off this host                                                                | Regenerate in settings                                                                 |
| Passkeys (WebAuthn)                                                                              | ES256 or EdDSA public-key credentials; RS256 is rejected                                                                                                                          | The authenticator holds the private key                                                                                                                            | Public keys in the database                                                                                              | Enrol a second authenticator (the app asks for two)                                    |
| TOTP                                                                                             | HMAC-SHA1 per RFC 6238 (the algorithm authenticator apps speak)                                                                                                                   | The seed, sealed with SecretBox                                                                                                                                    | `totp_secrets.sealed_secret`                                                                                             | Re-enrol                                                                               |
| Enrolment token                                                                                  | 256-bit random; SHA-256 digest stored; one hour                                                                                                                                   | Printed once by `just bootstrap-user`                                                                                                                              | Digest in the database                                                                                                   | Single use                                                                             |
| Merchant pseudonyms (`MERCHANT_<12 hex>`)                                                        | HMAC (keyed, one-way, stable per user)                                                                                                                                            | `secrets/advisor_token_secret` mixed with the user id                                                                                                              | The secret file                                                                                                          | Rotating re-pseudonymises every merchant and orphans stored references                 |
| Backups, and `GET /export?encrypt=true`                                                          | `age`: X25519 recipient, ChaCha20-Poly1305 payload                                                                                                                                | The `age_recipient` **public** key on the host; the private identity off-host with you                                                                             | `secrets/age_recipient`; your password manager and offline copy                                                          | Generate a new keypair, replace `age_recipient`, keep the old identity for old backups |
| TLS to the browser                                                                               | TLS 1.3 negotiated, 1.2 accepted, 1.1 refused (Caddy defaults); ECDHE with X25519 or P-256; AEAD suites                                                                           | Caddy's internal CA and leaf key (LAN mode); a Let's Encrypt certificate under Tailscale Serve                                                                     | The `caddy_data` volume                                                                                                  | Caddy renews automatically; `just trust-ca` exports the CA root                        |
| TLS to providers (Plaid, Coinbase, price feeds, Esplora, ntfy, SMTP)                             | TLS 1.2 minimum, certificate verification on (`rejectUnauthorized: true`, one dialer, tested for all five clients)                                                                | The platform trust store                                                                                                                                           | `packages/platform/src/egress/dial.ts`                                                                                   | n/a                                                                                    |
| Provider request signing                                                                         | Coinbase CDP: an Ed25519 (EdDSA) JWT built per request                                                                                                                            | The CDP private key (`coinbase_private_key`)                                                                                                                       | Secret file                                                                                                              | Create a new CDP key with the `view` permission and replace both files                 |
| Integrity pins                                                                                   | SHA-256: the Monte Carlo return series (`SHA256SUMS`), the local model (manifest digest), container images (digest in `compose.yml`), migrations (checksum)                       | n/a                                                                                                                                                                | The repository                                                                                                           | When a pin is deliberately moved                                                       |
| Postgres bootstrap password                                                                      | 32 random bytes, hex                                                                                                                                                              | `secrets/pg_password` and `database_url`                                                                                                                           | Secret files                                                                                                             | The panic checklist, step 4                                                            |

**Not encrypted, on purpose.** Traffic between containers on the compose `backend` network is plain
(a private bridge on one host; no internal TLS: accepted risk A-08 in the assessment). The plain-HTTP
listener on `PROXY_HTTP_PORT` exists for `tailscale serve`; see First install, step 3. The database
volume itself is protected by the host's LUKS2, not by Postgres.

**A crypto-migration plan.** Agility hooks exist (the envelope carries a version and a key id, and
every KDF parameter is stored with the key it produced), so a primitive can change without
re-encrypting the world at once. The triggers for a deliberate migration are: a practical attack on
Argon2id, XChaCha20-Poly1305 or X25519 that the maintainers of `@noble` or `age` announce; the
arrival of post-quantum recipients in `age` (then generate a new keypair, re-encrypt the backups
you still need, and retire the old identity), or of a post-quantum key exchange in Caddy and Node
(then it arrives with a routine image update); and any change to the Argon2 floor in `@core/config`.
Until a trigger fires, the plan is to change nothing.

---

## Logging inventory

What is logged, where, in what format, for how long, and who can read it.

| Log                                                                             | What it records                                                                                                                                                                                                                                                                                                                | Format and destination                                                                                                      | Retention                                                                                                    | Who can read it                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Container logs (`api`, `worker`, `migrator`, `proxy`, `backup`, `db`, `ollama`) | The api's request lines with a `correlationId`, job and consumer activity, startup and shutdown, errors (the `internal` family at `error` with the error object), refused requests (401/403/404 at `info`)                                                                                                                     | pino JSON lines (one object per line, epoch-millisecond UTC timestamps) to stdout, collected by Docker's `json-file` driver | 10 MB x 5 files per service (`compose.yml`'s shared logging block), rotated; nothing is shipped off the host | Anyone with Docker access on the host (root-equivalent)                                                                                                                                                                                                                                                                                                                               |
| `security_events` (database)                                                    | Authentication successes and failures (passkey, TOTP, recovery code), lockouts, step-up, refresh and reuse, KEK unlock, credential, TOTP and recovery-code changes. Columns: when, who, kind, outcome, IP, a hash of the user agent, the correlation id; `detail` is scrubbed of credential-shaped values before it is written | A Postgres table                                                                                                            | In the database; the only off-host copy is the nightly encrypted backup                                      | The app role can read and append; it cannot `UPDATE`, `DELETE` or `TRUNCATE` the table, and a trigger refuses every `UPDATE` and `DELETE` for every role (the one exception is the `user_id` set to NULL when a user row is deleted). A database superuser can still disable the trigger; the serving processes are no longer one (migration 0039, [Database roles](#database-roles)) |
| `snapshot_grant_events` (database)                                              | Every change to what an advisor may see: append-only, enforced by a trigger                                                                                                                                                                                                                                                    | A Postgres table                                                                                                            | In the database and backups                                                                                  | The app role (read)                                                                                                                                                                                                                                                                                                                                                                   |
| `advisor_runs` (database)                                                       | Every advisor run: status, refusal or cancel reason, the digest of what was sent, never the prompt, the reply or the snapshot                                                                                                                                                                                                  | A Postgres table                                                                                                            | In the database                                                                                              | The app role                                                                                                                                                                                                                                                                                                                                                                          |
| `ops_backup_runs`, `ops_restore_drills` (database)                              | Backup and drill outcomes, which the dashboard line reads                                                                                                                                                                                                                                                                      | Postgres tables                                                                                                             | In the database                                                                                              | The app role                                                                                                                                                                                                                                                                                                                                                                          |
| Postgres server log                                                             | Statements slower than 500 ms (`log_min_duration_statement=500`), connection errors                                                                                                                                                                                                                                            | Postgres's stderr, collected as a container log                                                                             | The `db` container's json-file rotation                                                                      | As container logs                                                                                                                                                                                                                                                                                                                                                                     |
| Caddy's own log                                                                 | Startup, certificate and error lines. No per-request access log is configured                                                                                                                                                                                                                                                  | Caddy's default output on stderr, a container log                                                                           | As container logs                                                                                            | As container logs                                                                                                                                                                                                                                                                                                                                                                     |

What is **never** logged, and is tested: any credential or token (deep redaction by key on every
log line, and a scrub of every provider-authored string, since FRED puts its key in the query
string), any amount or merchant in the soak report, and any prompt, reply or snapshot byte from
the local model (the adapter's lines carry sizes, digests, token counts and durations only). There
is no remote log sink and no third-party error reporter. Time is UTC everywhere (`TZ: UTC` on every
service). Not recorded as security events: data export and import, connection link and unlink,
payload approvals and CSRF refusals appear only in the container log. Read the log:

```bash
docker compose logs --since 1h api | tail -50
```

---

## Resource envelope

Limits are set per service in `compose.yml` (`deploy.resources.limits`). They are _limits_, not
reservations. Steady-state use is far below them (the measured numbers follow), but the sum is what
the host must be able to give up at once.

| Service              | CPU | Memory    | Why that number                                                                                                                                                                                                                                                                                    |
| -------------------- | --- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api`                | 2.0 | **1536M** | Argon2id KEK derivation allocates 1 GiB in one buffer at boot (P0-2 floor). At 768M the kernel OOM-killed it at exit 137 with no output, and because `/auth/unlock-state` derives lazily, an unauthenticated GET was a remote kill switch.                                                         |
| `worker`             | 1.0 | **1536M** | **The worker derives the KEK too**: it unlocks the keyring at boot to open provider credentials (G4-2). At 512M it was OOM-killed at every boot once an account holder existed (189 silent restarts, Phase 1 gate N-4).                                                                            |
| `db`                 | 2.0 | 1G        | `shared_buffers=256MB`, `max_connections=40`, plus 256M `shm_size`.                                                                                                                                                                                                                                |
| `proxy`              | 0.5 | 128M      | Caddy plus a static bundle.                                                                                                                                                                                                                                                                        |
| `backup`             | 0.5 | 256M      | `pg_dump` + `age`; the plaintext dump lives in a 256M tmpfs.                                                                                                                                                                                                                                       |
| `pre-migrate-backup` | 0.5 | 256M      | The same image as `backup`, a one-shot before migrations.                                                                                                                                                                                                                                          |
| `migrator`           | —   | —         | Runs to completion before api/worker start; no limit set.                                                                                                                                                                                                                                          |
| placeholders         | 0.1 | 32M       | `sleep infinity`, profile-gated, off by default.                                                                                                                                                                                                                                                   |
| `ollama`             | 4.0 | 8G        | Profile `local-llm`, off by default (WP 5.2). A 7-8B model at 4-bit holds ~5 GiB resident and saturates the cores it is given; `pids: 256`. Not in the steady-state numbers below: when it runs, the whole-stack target in master plan §3.4 is knowingly exceeded on this host. See "Local model". |

The limits sum to about 4.6 GiB (api 1.5 + worker 1.5 + db 1 + proxy 0.1 + backup 0.25). **Measured**
(WP 9.9, `docs/evidence/phase-9/wp9.9-perf.md`: an AMD Ryzen 5 3501U, 4 cores / 8 threads, 23 GiB,
Docker 29.8, the stack with a 50,040-row ledger, `ollama` stopped, no build running, load printed with
every number):

| What                                                                               | Measured                                                                                                                                    | Budget (master plan §3.4)                        |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| RAM, idle ten minutes (all services, resident)                                     | 316.7 MiB RSS (447 MiB charged, most of it Postgres's page cache)                                                                           | whole stack under 2 GB                           |
| RAM through one nightly sync chain                                                 | 351.3 MiB RSS at its peak (485 MiB charged)                                                                                                 | under 2 GB                                       |
| RAM at boot (api and worker each derive the KEK, one after the other since v0.9.0) | **1.37 to 1.52 GiB RSS** at the peak (1.2 GiB per container, never two at once; WP 9.11, load 2.7–6.3); before the stagger 2.31 to 2.43 GiB | under 2 GB                                       |
| Cold start                                                                         | 19.5 s to the api's own `/ready`; 24.8 to 25.4 s to the first 200 through Caddy                                                             | under 20 s including migrations (met at the api) |
| Nightly sync, 8 connections, a 730-day backfill, the worker's real job chain       | 243 s                                                                                                                                       | under 5 minutes                                  |
| Backup restore (RTO)                                                               | 36 s from restore start to `/ready` (a 116 MB database)                                                                                     | under 1 hour                                     |
| Transactions list at 50,000 rows, over real HTTP                                   | p95 15 to 58 ms (through Caddy, worst 82 ms)                                                                                                | p95 under 200 ms                                 |
| Monte Carlo, 10,000 paths x 40 years                                               | p95 543 ms (engine), 532 ms (over HTTP)                                                                                                     | p95 at most 800 ms                               |

**The boot window.** api and worker each derive a 1 GiB Argon2id key at boot. Since v0.9.0 they
take turns: a Postgres advisory lock lets only one derivation run at a time (the second waits
about six seconds on an idle connection), so the stack's resident set peaks near 1.5 GiB instead
of 2.4 GiB, and the worker becomes ready about six seconds later than the api. The lock fails
open — if it cannot be taken, both derive and you are back to the old peak — so a host with less
than about 3 GiB free is still safer with the local model off. Do not lower
`KEK_ARGON2_MEMORY_KIB` to save memory: it is a security parameter with a production floor.

`just bootstrap-user` (first install, or `reissue=true`) derives its key in a one-shot container
(`docker compose run --rm --no-deps`) made from the api service's own definition: the same image,
secrets, read-only root and 1536M limit, in its own cgroup. WP 9.14 measured it at 1.2 GiB for about
six seconds while the running api stayed at 176 MiB. It takes the same derivation lock as the api's
and worker's own, so it never overlaps them.

Every service also has a PIDs cap (`deploy.resources.limits.pids`): api, worker and db 256; proxy,
backup, pre-migrate-backup and migrator 128; the placeholders 16; ollama 256.
`scripts/compose-hardening-check.sh` refuses a service without one. Where a number above was
informational only, the evidence says so: 200 held positions make `GET /holdings` take about 60 ms (2 s before WP 9.14's bounded, batched price read), and the 250k-row list's rare-word search passes 200 ms.

---

## Troubleshooting

**`age: error: ... permission denied` during a restore.** `AGE_IDENTITY_FILE` is owner-readable
only. A **real restore** needs it `chmod 644` for the few seconds the command runs: see "Restore"
above for why (Docker bind mounts and file-based secrets both preserve the host file's own
uid/mode as-is; the `backup` container reads it as uid 10002, not whichever host user ran the
command). The restore **drill** does not have this problem on a rootful Docker (it reads the file
through a root container); if it reports the file is "empty or unreadable", check the path.

**`docker compose up` fails with "secret ... file not found", or `bind source path does not
exist: .../secrets/<name>`.** A file under `./secrets/` that `compose.yml` declares does not exist
(older Compose says `secret ... file not found`). Run `just secrets-placeholders`: it creates every
optional one empty, never overwrites, and refuses, naming the secret, if a required one
(`database_url`, `pg_password`, `master_key`, `age_recipient`) is missing. Every filename is exact
and extension-less (`secrets/master_key`, not `secrets/master_key.txt`).

**A container crash-loops on `EACCES` reading a secret.** The file's owner and mode do not match
the uid that reads it. After `just harden-secrets`, `just check-secret-ownership` (also part of
`just hardening-check`) re-derives the expected owner and mode for every secret from `compose.yml`
and names the mismatched file. A secret hardened under an older release (for example
`age_recipient` at `10002:10002 0400`, which `api` now also reads) needs `just harden-secrets`
again.

**A `just` recipe fails with `node: command not found`.** `just gen-pg-secrets`, `just
gen-master-key`, `just secrets-placeholders` and therefore `just upgrade` use `node` on the host
(only `node -e` and a JSON read): install any Node.js 18 or newer. The application itself needs no
host Node, because it runs in the images.

**`db` container fails to start / "database files are incompatible with server" / permission errors
on the data directory.** `postgres:18`'s own image stores data in a major-version subdirectory and
expects the _volume mount point one level up_, at `/var/lib/postgresql` — **not**
`/var/lib/postgresql/data` (the path older Postgres images and older tutorials use). `compose.yml`
and `compose.dev.yml` both mount `pgdata:/var/lib/postgresql` for exactly this reason; if you're
hand-rolling a `docker run` for debugging, mounting at `.../data` instead makes the container refuse
to start with a confusing message rather than an obvious one.

**`proxy` exits immediately with "operation not permitted."** Something rebuilt or replaced
`docker/caddy.Dockerfile`'s image with stock `caddy:2-alpine` while `compose.yml`'s `cap_drop:
[ALL]` + `no-new-privileges:true` are still set. Stock Caddy's binary carries a
`cap_net_bind_service` file capability (`getcap /usr/bin/caddy`); with an empty capability set and
`no-new-privileges`, the kernel refuses to apply it at `execve`, and Caddy never starts.
`docker/caddy.Dockerfile` strips that capability at build time (this proxy only ever binds
unprivileged container ports 8443/8080) — rebuild with `just build` rather than pulling the
upstream image directly.

**A container is `unhealthy` in `docker compose ps`.** `api`/`worker`/`migrator` depend on `db`'s
healthcheck and, for `api`/`worker`, on `migrator` completing successfully first. `docker compose
logs migrator` is almost always the first thing to check — a failed migration is the most common
reason `api` never becomes healthy on a fresh box. `backup` reads `starting` for its first minutes
on a fresh install and only goes `unhealthy` after a failed attempt: see "Backup".

**`just bootstrap-user` ends with `exit code 137` after "deriving the key-encryption key".** The
recipe runs the derivation in its own one-shot container with a 1536M limit; the kernel OOM-killed
that container because the host had less than about 1.5 GiB free. The running `api` is not
affected. The user row was already written, so the next plain run says `A user already exists`:
free memory (stop `ollama` first) and run the same command with `reissue=true`, which issues a
fresh one-time link.

**`api` or `worker` exits 137 at boot, or restarts in a loop on a small host.** The kernel OOM-killed
it: each derives a 1 GiB Argon2id key at start, and the two together peak near 2.4 GiB for a few
seconds ("Resource envelope"). Stop other memory consumers (notably `ollama`), or use a host with
more RAM. `docker inspect --format '{{.State.OOMKilled}}' <container>` confirms it.

**`/ready` answers 200 with `"status":"degraded"`, or `just upgrade` printed `WARNING: /ready
reports degraded`.** The app is serving, but the platform sees something stuck: an outbox lagging,
a job waiting too long, or **a consumer stopped at an event it cannot handle** (`just upgrade`
names it). Read `curl --cacert personalfi-ca.crt https://personalfi.lan/api/ready` and `docker
compose logs worker | tail`. The thresholds are defaults compiled into the app: an outbox more than
1,000 events behind, or a runnable job waiting more than 15 minutes.

**`api` logs `could not ensure the database app role; queries will fail until the migrator has
run`.** The api and the worker call `personalfi_app_grants()` at boot, and that function comes from
migration 0039. If the migrator has not run (a failed migration, or a database restored from before
0039 and not yet migrated), run `docker compose logs migrator`, fix what it says, and `docker compose
up -d`: the next boot re-asserts the role. With the roles split, a wrong `database_url` password
shows here too.

**The upgrade stops with `migration.database_newer`.** The database holds a migration this checkout
does not have, so an older binary was pointed at a newer schema. That is the guard working: it never
serves such a database. Check out the version the database was last migrated by, or restore the
pre-migration backup ("Upgrade", "Rollback").

**A narration is refused `payload_not_approved` after an upgrade.** The narrator's prompt template
changed in v0.9.0 (WP 9.5), so an approval given before it covers a different query shape. Approve
the payload preview again: "Local model", step 6.

**`just restore-drill` says "backend network or backups volume not found."** Run `docker compose up`
(or `docker compose create`) at least once first — the drill discovers both by their
compose-assigned labels rather than guessing a project name, and those labels only exist once
compose has created the resources. If it says it found **more than one** candidate, set
`COMPOSE_PROJECT_NAME` to the project you mean.

**A sign-in answers `429 Too many attempts`.** You are rate limited or locked out: see "Lockout and
operator unlock".

**Browser shows a certificate warning for `personalfi.lan`.** You haven't imported the internal CA
yet, or you're hitting the box from a device you haven't imported it onto. See "Trust the internal
CA" above. This is expected and correct behaviour, not a bug — an untrusted-by-default internal CA is
what makes a stray misconfigured client fail loudly instead of quietly trusting an unexpected
certificate.

**Sign-in fails with `403 csrf_failed`, or the browser refuses the passkey ceremony.** The origin
the browser uses is not the one the api was configured with. `PUBLIC_HOST` sets the allowed origin
and the WebAuthn relying-party id together; a non-default port needs `EXTRA_ALLOWED_ORIGINS`, and a
different hostname than the one passkeys were enrolled under cannot use them (the relying-party id
is bound into the credential).

### `/ready` says `degraded` and names a stopped consumer

`GET /api/ready` answers 200 with `"status":"degraded"` and lists
`outbox.failedConsumers` (and `just upgrade` prints a WARNING) when an event consumer has failed
the same event five times: the worker stops it rather than skip the event, so whatever it
maintains (budget actuals, categorisation, …) stops updating. Read why first — the error is in
`docker compose logs worker` and is printed again by the command below — and fix the cause.
Then resume it:

    just consumer-resume budgeting.actuals@v1     # the name /ready lists

It retries the **same** event; nothing is skipped. If the cause is still there it stops again
after five attempts. Before v0.9.0, an on-budget account with no balance yet stopped
`budgeting.actuals@v1` this way; since v0.9.0 that waits instead (the budget recomputes when the
balance arrives). Known at v0.9.0 and not yet fixed: a **credit card that already owes money**
when a budget period is first computed stops the same consumer with
`identity II failed for card …` (WP 9.4's O-94-1); resuming retries into the same refusal until
that is fixed (WP 9.14).
