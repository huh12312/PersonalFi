# WP 3.5 — Coinbase read-only connector

_Phase 3, Wave A. Owner: Opus `security-engineer`. Package: `packages/connectors/coinbase/**`.
Spec: [`docs/plan/03-phase-3-dispatch.md`](../../plan/03-phase-3-dispatch.md) §3 "WP 3.5" and §6;
[`docs/research/01-aggregation-plaid.md`](../../research/01-aggregation-plaid.md) §3.1–§3.3 and R6;
[`docs/research/07-advisory-domain.md`](../../research/07-advisory-domain.md) §6; 08 §2.2–§2.6;
master plan D5 and D16. Template: [`wp1.3-plaid.md`](../phase-1/wp1.3-plaid.md) and
`packages/connectors/plaid/**`._

---

## 1. The R6 ledger-gap prototype — deliverable one

> R6 — _"Coinbase v3 may not expose a full ledger (deposits/withdrawals/staking/transfers vs. trade
> fills only). Cost basis and crypto cash flows could be incomplete. **Prototype against a real
> Coinbase account early.** Highest-priority unknown in this memo."_ — 01, Open risks

**Verdict: `v3_alone_cannot_reconstruct_the_ledger`.** Advanced Trade v3 reconstructs **trades and
nothing else**. There is no endpoint in the v3 brokerage surface that reports a deposit, a
withdrawal, a staking reward or an on-chain transfer; those lived in the v2 `/transactions` Wallet
API, which 01 §3.1 records as deprecated in favour of v3 — deprecated with no replacement for its
ledger half. **WP 3.2's lot engine therefore has one fewer source to satisfy**, and the CSV export is
the plan of record for the rest.

The finding is a _measurement_, not an assertion. `src/ledger-gap.ts` carries a determination table;
`probeLedgerGap` calls all five endpoints and then does the arithmetic that settles the question, and
the verdict is derived from the residuals rather than hardcoded (sabotage **S13** proves it).

### 1.1 Each endpoint tried, and what it returned

Run hermetically over recorded shapes (`test/fixtures/*.json`, `test/ledger-gap.test.ts` →
_'reaches all five read-only endpoints with a can_view key'_). The identical probe runs against a
live key in `test/smoke.test.ts` and prints the same table; it skips honestly today (§8).

| #   | Endpoint                                             | Outcome  | What it returned                                   |
| --- | ---------------------------------------------------- | -------- | -------------------------------------------------- |
| 1   | `GET /api/v3/brokerage/key_permissions`              | answered | `can_view=true can_trade=false can_transfer=false` |
| 2   | `GET /api/v3/brokerage/accounts`                     | answered | 4 wallet(s) — USD, BTC, ETH, DOGE                  |
| 3   | `GET /api/v3/brokerage/portfolios`                   | answered | 1 live portfolio, 1 deleted                        |
| 4   | `GET /api/v3/brokerage/orders/historical/fills`      | answered | 2 fill(s) — both BUY                               |
| 5   | `GET /api/v3/brokerage/products/{product_id}/ticker` | answered | 1 recent trade                                     |

A refused endpoint is _recorded_ rather than thrown (a probe that aborted on the first 403 could not
report which endpoints a key reaches), and a probe that could not measure returns the **pessimistic**
verdict — an unmeasured ledger is not a reconstructed one. Both are asserted.

### 1.2 The reconciliation — the number that settles R6

For each asset: `residual = balance(now) − Σ(fills that moved it)`, using the _same_
`quoteEffectOf` / `baseEffectOf` the connector itself uses, so the probe cannot reach a comfortable
answer the adapter disagrees with.

| Asset | Observed | Explained by fills |         Residual | What the residual is                                    |
| ----- | -------: | -----------------: | ---------------: | ------------------------------------------------------- |
| USD   | `980.00` |        `−9,032.50` | **`+10,012.50`** | deposits v3 never reported                              |
| BTC   |   `0.35` |            `+0.10` |      **`+0.25`** | a transfer in                                           |
| ETH   |   `2.05` |            `+2.00` |      **`+0.05`** | staking rewards                                         |
| DOGE  |      `0` |                `0` |              `0` | the control: the method does not simply always disagree |

### 1.3 The determination, five lines

| Movement              | v3 endpoint                | Reconstructible | CSV fallback row                    | Cost of its absence (WP 3.2)                                                                                                                                                                                                                 |
| --------------------- | -------------------------- | --------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **deposit**           | _none_                     | **no**          | `Transaction Type = Deposit`        | cash inflow invisible; an on-ramp would otherwise look like spending. Inferred from the balance delta (§4) and labelled `inferred`.                                                                                                          |
| **withdrawal**        | _none_                     | **no**          | `Transaction Type = Withdrawal`     | cash outflow invisible. Inferred as a transfer out — never income, never a disposal.                                                                                                                                                         |
| **staking reward**    | _none_                     | **no**          | `Staking Income` / `Rewards Income` | Rev. Rul. 2023-14 (07 §6.5) needs FMV **at receipt**; with no receipt instant there is no FMV to look up, so the lot is `ESTIMATED` with a visible warning — never a silent zero basis.                                                      |
| **internal transfer** | _none_                     | **no**          | `Send` / `Receive`                  | a self-transfer is not taxable but must carry its lots (07 §6.2). Without the event the destination sees an unexplained quantity and the source an unexplained disposal — 07 §6.2's "single most common source of wrong crypto tax numbers". |
| **fiat on-ramp buy**  | `/orders/historical/fills` | **partial**     | `Buy` (both legs on one row)        | the trade leg is exact (quantity, unit price, fee, instant); the **funding leg has no record**, and a one-tap retail buy that never touched Advanced Trade produces no fill either.                                                          |

### 1.4 The CSV fallback, as the plan of record

Crypto **basis** from this connector is exact for an Advanced Trade purchase (`basis_source = BROKER`)
and **absent** for every other acquisition route. Per 04 §5.5 the absent case reports `unavailable`,
never gain-from-zero: `ProviderHoldingFact.costBasis` is `null` and not `0` (`map.test.ts`). The
remaining history comes from Coinbase's **transaction-history CSV export**, whose row types are named
per movement above. Two consequences the orchestrator should carry forward:

1. **`historical_backfill` is deliberately _not_ declared.** The flag would tell the orchestrator to
   ask for 730 days of a ledger that does not exist.
2. §2.3's cut order already puts lot-level crypto basis last; this is the finding that justifies it.
   Holdings-level valuation ships now.

---

## 2. Key custody

| Where the key can be                          | For how long                      | Enforced by                                                                                                  |
| --------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `ConnectResult.credentials`, once             | until `@ctx/connections` seals it | `connect` is the only producer; `custody.test.ts` asserts the key set is exactly `COINBASE_CREDENTIAL_NAMES` |
| `CoinbaseCredentials`, a constructor argument | one connector method call         | `#clientFor(handle, …)` builds a fresh `CoinbaseClient` per method and drops it                              |
| a `KeyObject`                                 | one signature                     | `client.ts#sign` parses per request; the object is a local, there is no field and no cache                   |

**Sealed credential = two names.** `cdp_key_name` + `cdp_private_key`, both returned by `connect`,
both sealed. A key name without its key is useless and a key without its name cannot be used, so
sealing one and not the other is not a saving.

**There is no cache, deliberately.** A cache keyed on the key name is a place a credential survives a
request; `mintCdpJwt` has no cache to reuse _from_, which is also what makes the uri binding
meaningful.

### 2.1 The database half of the custody proof is **not** in this package

The plan's exit test is `test/custody.test.ts` → _'the raw `sealed_credentials` column contains no
plaintext CDP key'_ — the WP 1.3b pattern, a raw `bytea` read at
`apps/api/test/db/plaid-routes.test.ts:146–158`. **That test cannot live here.** It needs a scratch
database, the migrations and `@ctx/connections` to do the sealing; `personalfi/layer-imports` denies
`packages/connectors/*` → `@ctx/*` outright and the `connector-coinbase` vitest project is hermetic
by design. Writing a test with that _name_ here that never read a column would be a control that has
never been exercised, dressed as evidence — the exact failure the Phase 2 gate found.

**Ask for the orchestrator (§9 item 3), specified verbatim:** in
`apps/api/test/db/coinbase-routes.test.ts` (or alongside the Plaid one), link a Coinbase connection
with `cdp_private_key` set to a recognisable string, then

```sql
SELECT sealed_credentials FROM connections WHERE id = $1
```

and assert the raw `Buffer` contains neither the key in `utf8` nor in `latin1`, and no 8-byte
substring of it — the Plaid assertion, character for character.

### 2.2 What this package _does_ prove (`test/custody.test.ts`, 5 cases)

- the key leaves exactly once, in `ConnectResult.credentials`, under both documented names;
- nothing else in the `ConnectResult`, the connector object, the logs, the facts or **the cursor**
  contains it (sabotage **S15**: put the key name in the cursor → red);
- a purged sealed blob makes every method refuse `invalid_input`/`CONFIG_ERROR` **with nothing
  signed and no request sent** — `api.requests` is empty;
- a half-purged blob names which half is missing, by constant, never by value;
- no parsed `KeyObject` survives on the client (`inspect(client, {showHidden:true})` contains neither
  `KeyObject` nor `asymmetricKeyType`).

### 2.3 Revocation, honestly

`disconnect` has nothing to call. Coinbase exposes no endpoint that revokes a CDP key — and if it
did, it would be a _write_, which this connector refuses by construction. A key is revoked by its
owner at `portal.cdp.coinbase.com`. So `disconnect` logs one line saying exactly that and returns,
and the revocation that is observable is the caller purging `sealed_credentials`. The conformance
check `disconnect/revokes` observes that, and this document says so rather than implying a revocation
we do not perform.

---

## 3. The scope assertion

01 §3.2: _"Verify at runtime via `GET /api/v3/brokerage/key_permissions` and refuse to start if the
key has `can_trade` or `can_transfer`."_ The dispatch sharpens it to **"at startup and again before
every sync"**.

| Property                                                  | Where                                                                        | Test                                                                                                                                                              |
| --------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| refused at `connect()`                                    | `connector.ts#assertViewOnly`, first line of `connect`                       | `'a key claiming can_trade is refused at startup'`                                                                                                                |
| refused before **every** leg, uncached                    | first line of `listAccounts`, all four sync legs, `health`                   | `'…and again before a sync, not only at boot'` — the key is widened _after_ two successful syncs, as it would be if edited in the portal between two nightly runs |
| refused **before any data call**                          | request log has four `key_permissions` and nothing else                      | `'a key with can_trade is refused before any data call'`                                                                                                          |
| `can_transfer` refused likewise; both named when both set | —                                                                            | `'refuses can_transfer for the same reason…'`                                                                                                                     |
| a key without `can_view` refused                          | —                                                                            | `'refuses a key that cannot even view…'`                                                                                                                          |
| `can_receive` **accepted**                                | it cannot move money out; refusing it would reject the common portal default | `'accepts can_receive, which cannot move money out'`                                                                                                              |

**Classification.** `INSUFFICIENT_SCOPE` → `permanent` → `{retryable: false, userActionRequired:
true}`, asserted through `retryPolicyFor`. `providerCode` is `KEY_NOT_READ_ONLY`; the message names
which permission (a permission name is not a secret, and "create a view-only key" is only actionable
if the user is told what is wrong with this one). `redactedContext` carries `{forbidden: [...]}`.

**`health()` throws the scope refusal** rather than reporting `reachable: false` — a deliberate
divergence from `PlaidConnector.health`, documented on the method: a key that has acquired
`can_trade` is not an unhealthy connection, it is one we refuse to operate, and a soft "unreachable"
would let a caller retry it forever. Transport and provider failures still report.

**Cost:** one extra `GET /key_permissions` per leg. It consumes no refresh budget and touches no
balance. The alternative — caching — makes the specified control untrue exactly in the window it
exists for.

---

## 4. The JWT, and the on-ramp

### 4.1 One signed example, decoded and redacted

Minted by `mintCdpJwt` for `GET /api/v3/brokerage/key_permissions` at the fixed test clock
(`2026-09-22T12:00:00Z`). Signature truncated; the key is the fixed test seed in `test/fake.ts` and
has never been near Coinbase.

```json
header  { "alg": "EdDSA", "typ": "JWT",
          "kid": "organizations/…/apiKeys/…",
          "nonce": "9f3c…" }                       // 16 CSPRNG bytes, hex, per request
payload { "sub": "organizations/…/apiKeys/…",
          "iss": "cdp",
          "nbf": 1790078400,
          "exp": 1790078520,                       // nbf + 120
          "aud": ["cdp_service"],
          "uri": "GET api.coinbase.com/api/v3/brokerage/key_permissions" }
```

**`EdDSA`, explicitly not ES256** — 01 §3.2 warns against cargo-culting from Plaid's _webhook_
algorithm, and `parseCdpPrivateKey` **refuses an ECDSA key by name** rather than silently
downgrading. **No query string in `uri`** (`?limit=250` would produce a 401 that looks like clock
skew); the query still goes on the wire, and both halves are asserted.

Every one of these is checked **from the server's side**: `FakeCoinbaseApi` decodes the
`Authorization` header it received, checks `alg`/`kid`/`sub`/`iss`/`aud`/`nbf`/`exp`/`uri`/nonce
uniqueness, **verifies the Ed25519 signature** against the public half of the test key, and answers
`401 UNAUTHENTICATED` otherwise. A token minted for one path and replayed at another is rejected
(`'a token minted for one path does not authenticate another'`).

### 4.2 The on-ramp, walked end to end

`test/onramp.test.ts` → _'a USD deposit followed by a BTC buy yields one transfer, one trade and zero
spending'_. v3 reports no deposit, so the transfer is **inferred** from a balance delta, with the
trades subtracted so a trade is never mistaken for a deposit:

```
watermark  2026-09-01  USD wallet     0.00
deposit                              +5,000.00     (no v3 endpoint reports it)
BTC buy    2026-09-10  0.1 @ 40,000  −4,000.00
                       commission    −    20.00
observed   2026-09-22  USD wallet      980.00

delta    =    980.00 −     0.00  = +  980.00
traded   = −4,000.00 −    20.00  = −4,020.00
residual =    980.00 − (−4,020.00) = +5,000.00     ← one transfer
```

- **one transfer** — `+$5,000.00` on the USD wallet, `providerCategory =
{primary: TRANSFER_IN, detailed: TRANSFER_IN_ACCOUNT_TRANSFER}`, which
  `packages/contexts/categorization/src/pfc-map.ts:102` resolves to `transfers.between_accounts`.
  That is the hook that makes **zero spending** a property of the system rather than a promise: the
  boundary lint denies `connectors/*` → `@ctx/*`, so the two codes are pinned as literals here and
  asserted by name — if 2.x renames them, `onramp.test.ts` goes red.
- **one trade** — a `ProviderInvestmentTransactionFact`: `quantity 0.1`, `price 40000`,
  `amount −$4,020.00` (fees included, Plaid's convention), `fees $20.00` as a positive magnitude,
  `security {kind: ticker, value: BTC}`.
- **zero spending** — every ledger transaction this adapter emits is a `TRANSFER_IN`/`TRANSFER_OUT`.
- **never income** — `'a fiat deposit is a transfer, never income'` (sabotage **S10**).
- the inference carries its own working in `raw` (`inferred: balance_delta`, both balances, the
  traded total, the fills considered, the window).

**Stated limits**, asserted rather than left implicit: the first sync emits nothing (an opening
balance is not a deposit); a wallet that did not exist at the watermark contributes no phantom
deposit; two deposits between two syncs are one transfer for their sum, because v3 cannot separate
them and splitting them by guesswork would be worse than saying so.

---

## 5. Error map

Body name first, HTTP status as the fallback — v3 answers with a gRPC-shaped envelope and sometimes a
bare `400`. Every row is asserted by iterating the tables (`errors.test.ts`).

| Coinbase                                                            | Condition            | Kind                   | Policy                     |
| ------------------------------------------------------------------- | -------------------- | ---------------------- | -------------------------- |
| `UNAUTHENTICATED`, `unauthorized`, `invalid_token`, 401             | `AUTH_REQUIRED`      | `auth_required`        | stop; user must act        |
| `PERMISSION_DENIED`, 403                                            | `INSUFFICIENT_SCOPE` | `permanent`            | stop; user must act        |
| `RESOURCE_EXHAUSTED`, `rate_limit_exceeded`, 429                    | `RATE_LIMITED`       | `rate_limited`         | retry after `retryAfterMs` |
| `UNAVAILABLE`, `DEADLINE_EXCEEDED`, `INTERNAL`, `ABORTED`, 5xx, 408 | `PROVIDER_DOWN`      | `provider_unavailable` | back off                   |
| `NOT_FOUND`, 404                                                    | `DATA_UNAVAILABLE`   | `permanent`            | stop                       |
| `INVALID_ARGUMENT`, `invalid_request`, `FAILED_PRECONDITION`, 400   | `CONFIG_ERROR`       | `invalid_input`        | stop; our bug              |
| `OUT_OF_RANGE`                                                      | `CURSOR_EXPIRED`     | `transient`            | restart `from_null`        |
| anything unrecognised                                               | `PROVIDER_DOWN`      | `provider_unavailable` | back off                   |
| a 2xx with a non-object body                                        | `MALFORMED_RESPONSE` | `permanent`            | stop                       |

**Rate limit → `retryAfterMs`**, end to end: a 429 with `Retry-After: 45` reaches the caller as
`retryAfterMs: 45_000` and `retryPolicyFor` returns `{retryable: true, retryAfterMs: 45000}`. Seconds
only; the HTTP-date form yields `null` so the orchestrator falls back to its own jittered backoff.

**Unrecognised is `PROVIDER_DOWN`, not `permanent`** — a deliberate departure from
`asConnectorError`'s fail-closed default, and the same one `asPlaidConnectorError` makes: we know
this was a network call, and calling an unfamiliar 5xx permanent would disable a healthy connection
because Coinbase had a bad afternoon.

**No `cause`, ever.** There is no axios here, but a `Request`/`Response` pair carries `headers`, and
our `Authorization` header is a bearer token valid for the next 120 seconds. `errors.ts` reads
status, body name and `Retry-After` and lets the rest go; `log-hygiene.test.ts` asserts
`error.cause === undefined` on every failure path.

---

## 6. Conformance, counts and log hygiene

**`pnpm exec vitest run --root packages/connectors/coinbase` → 11 files, 133 passed, 1 skipped.**

| File                       |         Cases | What it holds                                         |
| -------------------------- | ------------: | ----------------------------------------------------- |
| `ledger-gap.test.ts`       |             7 | **the R6 prototype** (§1)                             |
| `permissions.test.ts`      |             7 | the scope assertion (§3)                              |
| `jwt.test.ts`              |            11 | EdDSA, 120 s, uri binding, freshness, ECDSA refusal   |
| `onramp.test.ts`           |             9 | the v0.5 rung (§4.2)                                  |
| `custody.test.ts`          |             5 | key custody (§2.2)                                    |
| `no-trade-surface.test.ts` |            11 | the read-only surface (§7)                            |
| `conformance.test.ts`      |        **14** | the shared suite, all green                           |
| `log-hygiene.test.ts`      |            17 | no key, no JWT, no nonce, anywhere                    |
| `errors.test.ts`           |            19 | every row of the map, plus budget and cursor refusals |
| `map.test.ts`              |            30 | facts, decimal boundaries, `size_in_quote`            |
| `smoke.test.ts`            | 4 (1 skipped) | the live probe, honestly gated (§8)                   |

**Conformance: 14/14.** Including `holdings/every position names a security and carries a decimal
quantity` and `investment-txns/every fact is fingerprinted and never floats a price` — WP 3.1's two
new checks, green against this adapter on the port as it stands on disk.

**Log hygiene.** Success logs exactly `{provider, endpoint, httpStatus}`; failure logs exactly
`{provider, endpoint, kind, condition, providerCode}`. The scanner walks every artefact through
`util.inspect(…, {depth: null, showHidden: true, getters: true})` and searches for the key material,
**every token the fake actually received** and **every nonce**. The scanner is itself tested against
six kinds of planted leak. The ticker endpoint label is collapsed to `products/{product_id}/ticker`,
because which coins somebody holds is user data.

---

## 7. The read-only surface

Checked two ways. **Dynamically**: every public method is driven and every recorded request is
asserted `GET` on one of the five allowed paths — `accounts`, `key_permissions`, `portfolios`,
`orders/historical/fills`, `products/{product_id}/ticker`, and no others.
**Statically**: `src/**` with comments stripped — every `method:` literal is `GET`, the
`CoinbaseMethod` type is exactly `'GET'`, every path built from `COINBASE_BROKERAGE_PREFIX` is on the
allow-list, and `fetch` appears only in `client.ts`.

The comment-stripping matters: `provider.ts` and `ledger-gap.ts` legitimately _name_ `POST /orders`,
`batch_cancel` and `move_funds` in prose and in the determination table. A test that forbade naming
the thing would push the documentation out of the package.

`assertReadOnlyPath` refuses `/orders`, `/orders/batch_cancel`, `/orders/edit`, `/orders/preview`,
`/orders/close_position` and `/portfolios/{uuid}/move_funds` — `permanent`/`INTERNAL`, because
reaching there is a defect in this package and not something a user can fix. `/orders/historical/fills`
is allowed and its parent is not; the ticker placeholder is matched structurally, so `..`, an extra
slash and a query are all refused **before anything is signed**.

`fetchTransport` pins `https`, the host from the JWT's own `uri` claim, `redirect: 'error'` (a 302 is
how an SSRF escapes an allow-list, and there is no legitimate redirect on a uri-bound signed request)
and a 20-second timeout merged with the run's signal.

---

## 8. Secrets, config keys and the live smoke

### 8.1 The two secret files

D5: provider credentials are **file secrets, never env vars** — an environment variable leaks into
`docker inspect`, crash dumps, every child process and `/proc/<pid>/environ`.

| File                                  | Contents                                                                        | Notes                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `${SECRETS_DIR}/coinbase_key_name`    | `organizations/{org_uuid}/apiKeys/{key_uuid}`                                   | the JWT's `kid` **and** `sub`; validated against `CDP_KEY_NAME_PATTERN` |
| `${SECRETS_DIR}/coinbase_private_key` | the CDP Ed25519 private key — PKCS#8 PEM, or the portal's `base64(seed‖public)` | mode `0400`; **an ECDSA key here is refused by name**                   |

Both follow the `plaid_client_id` / `plaid_secret` shape in `packages/config/src/load.ts`, and
`scripts/check-secret-ownership.sh` / `harden-secrets` should cover them. **Feature-detect, do not
flag**: with neither file present, the connector is simply not registered, exactly as Plaid is not.

### 8.2 The live smoke

`test/smoke.test.ts` reads those two files and **`SECRETS_DIR` is the only environment variable it
consults — a path, not a secret**, asserted by a source scan (sabotage **S14**: add one
`process.env['COINBASE_PRIVATE_KEY']` read → red). With either file absent it prints one line naming
the files and skips; `'the live smoke skips honestly without credentials'` proves the gate is real
rather than vacuously green.

**Runbook.** Write the two files, then:

```
pnpm exec vitest run --root packages/connectors/coinbase test/smoke.test.ts
```

It asserts the scope refusal against the real service, re-runs `probeLedgerGap` against the real
account and prints the live residual table, links, lists accounts, syncs balances and one transaction
page, probes health, and scans everything it produced for the key. Running it is safe: every request
is a `GET` on one of five paths, and it refuses before its first data call if the key can trade.
There is no Coinbase analogue of Plaid's ten-Item ratchet (D16) — a read costs nothing and creates
nothing.

### 8.3 Registration lines for `apps/api/src/domain.ts`

Feature-detected on the secret files, the `createConnectorRegistry` shape at `domain.ts:765–802`:

```ts
import {
  CoinbaseConnector,
  COINBASE_MANIFEST,
  COINBASE_PROVIDER,
  fetchTransport,
} from '@connector/coinbase';

// inside createConnectorRegistry(), after the Plaid block:
const coinbase = options.coinbase ?? null; // CoinbaseConfig | null from @core/config
if (coinbase === null) {
  logger?.info(
    { provider: COINBASE_PROVIDER },
    'coinbase not configured; connector not registered',
  );
} else {
  registry.register({
    connector: new CoinbaseConnector({
      transport: fetchTransport(),
      clock: options.clock ?? systemClock,
    }),
    manifest: COINBASE_MANIFEST,
  });
  logger?.info({ provider: COINBASE_PROVIDER }, 'coinbase configured; connector registered');
}
```

The credentials are **not** passed to the constructor: unlike Plaid's client, which takes its client
id and secret once, every Coinbase request reads the sealed pair from the `ConnectionHandle`. The
config object only decides _whether_ to register, and `CoinbaseConfig` therefore needs no
`reveal()`-able field at all beyond presence — `apps/api` can gate on the files existing.

Also needed: `CRYPTO_ALLOWED_HOSTS` already lists `api.coinbase.com` (§4 shared files item 8), and
`@connector/coinbase` joins `apps/api/package.json`'s workspace deps in the dependency batch.

### 8.4 Vitest and CI

`vitest.config.ts` — the project the orchestrator reserved (§4 shared files item 1):

```ts
{
  // WP 3.5. The Coinbase adapter, driven end to end by `FakeCoinbaseApi` over
  // recorded-shape fixtures: the R6 ledger-gap prototype, the shared conformance
  // suite, the CDP JWT, the key_permissions refusal, the on-ramp, custody and the
  // log-hygiene check. No network and no database. The live smoke lives in the
  // same project and skips itself when secrets/coinbase_* are absent.
  root: './packages/connectors/coinbase',
  test: {
    name: 'connector-coinbase',
    include: ['src/**/*.test.ts', 'test/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
},
```

`.github/workflows/ci.yml` — `connector-coinbase` joins the **two** hand-maintained `--project` lists
and the prose project→job map in the header (line 34 already says _"connector-coinbase joins when WP
3.5's package lands"_). It needs no database and no service container, like `connector-plaid`.
`scripts/check-ci-projects.ts` fails the build if any of the three drifts.

---

## 9. Sabotage — fifteen controls, all red on the first valid attempt

Each control was made to fail, observed red, and restored. The matrix is reproducible with a script
that patches one line, runs the owning suite and restores the file.

| #   | Sabotage                                           | File            | Observed red in                                                          |
| --- | -------------------------------------------------- | --------------- | ------------------------------------------------------------------------ |
| S1  | `alg` downgraded to `ES256`                        | `provider.ts`   | `'a JWT is EdDSA, expires in 120 s and is bound to one method and path'` |
| S2  | nonce reused across requests                       | `jwt.ts`        | `'a JWT is not reused…'`, `'the JWT is fresh per request…'`, +1          |
| S3  | `uri` bound to a fixed path                        | `jwt.ts`        | 3 JWT cases; the fake answers 401                                        |
| S4  | lifetime widened to 3,600 s                        | `provider.ts`   | `'a JWT is EdDSA, expires in 120 s…'`                                    |
| S5  | `key_permissions` cached after the first check     | `connector.ts`  | `'…and again before a sync, not only at boot'`, +2                       |
| S6  | `can_trade` no longer refused                      | `connector.ts`  | `'a key claiming can_trade is refused at startup'`, +2                   |
| S7  | a `POST /orders` added to the client               | `client.ts`     | `'the package contains no code path that POSTs to /orders'`              |
| S8  | the JWT logged on every request                    | `client.ts`     | `'no log line contains the private key, JWT or nonce'`, +1               |
| S9  | trades no longer subtracted from the balance delta | `ledger.ts`     | `'…one transfer, one trade and zero spending'`, +2                       |
| S10 | a fiat deposit filed as `INCOME`                   | `ledger.ts`     | `'a fiat deposit is a transfer, never income'`, +1                       |
| S11 | `size_in_quote` ignored                            | `map.ts`        | `'reads size_in_quote as dollars, not as coins'`                         |
| S12 | an unpriceable position valued at zero             | `connector.ts`  | `'refuses to value an unpriceable position rather than calling it zero'` |
| S13 | the R6 verdict hardcoded optimistic                | `ledger-gap.ts` | `'returns the pessimistic verdict…'`, +1                                 |
| S14 | the live smoke reads its key from the environment  | `smoke.test.ts` | `'reads its credentials from files and never from the environment'`      |
| S15 | the cursor carries the key name                    | `cursor.ts`     | `'the cursor the orchestrator persists carries no credential'`           |

After restoring: 133 passed, 1 skipped; `eslint` clean; `tsc --noEmit` reports nothing in this
package.

---

## 10. Carried, and asks for the orchestrator

1. **`eslint.config.js` carve-out for `node:crypto`.** The single-crypto-call-site rule (03 §2) bans
   `node:crypto` outside `packages/secretbox/src/primitives.ts` and `packages/db/src/migrate.ts`.
   This package must sign **Ed25519**, which `@core/secretbox` exposes no primitive for and which the
   dispatch explicitly chose over `jose` (§4: _"`node:crypto` signs **Ed25519** natively"_). Two
   files therefore carry an in-file `eslint-disable-next-line no-restricted-imports -- …` with a full
   justification, following `packages/platform/src/config-snapshot.ts:8`'s precedent —
   `packages/connectors/coinbase/src/jwt.ts` and `packages/connectors/coinbase/test/fake.ts`. **The
   project's convention is the config `ignores` list, not an inline disable**, and this package may
   not edit that file. Please move both paths into `eslint.config.js`'s `ignores` beside
   `packages/db/src/migrate.ts` and delete the two comments.
2. **Vitest project, CI lists and `domain.ts` registration** — §8.3 and §8.4, verbatim.
3. **The database custody test** — §2.1, specified verbatim, to be written where a `*-db` project and
   `@ctx/connections` are available.
4. **Secrets and config** — `coinbase_key_name`, `coinbase_private_key` (§8.1) into the config loader,
   the secrets batch and `harden-secrets`.
5. **Nothing needed from WP 3.1 that is not already on disk.** This package was built against the
   port's additive members as they stand at `95d1c64` — `ProviderSecurityFact`,
   `ProviderInvestmentTransactionFact`, optional `syncHoldings`/`syncInvestmentTransactions`,
   `ProviderHoldingFact.security: SecurityIdentifier` — and all 14 conformance checks pass against
   them. **No port name was changed by this WP, and no port file was touched.**
6. **For WP 3.1's resolver:** Coinbase names a crypto security as
   `{kind: 'ticker', value: 'ETH', chain: null, mic: null}`, with `providerSecurityId = 'ETH-USD'`
   carried as evidence only. That is the Coinbase half of the §5 exit criterion _"ETH on Coinbase and
   in a wallet resolves to one security"_; the wallet half (WP 3.6) supplies a `chain_contract`.
7. **For WP 3.2:** basis from this connector is `BROKER`-exact for Advanced Trade purchases and
   `null` for everything else (§1.4). `fees` is a **positive magnitude already included in `amount`**
   — adding them is how one $20 commission becomes $40 of fee drag.
8. **A sharp edge, stated:** a crypto wallet with a non-zero balance and **no USD quote** fails the
   holdings and balances legs loudly (`DATA_UNAVAILABLE` naming the asset) rather than reporting
   `$0.00`. A $0.00 position disappears from net worth silently, which 08 §2.2 says an honest adapter
   must not produce. WP 3.4's `PriceSource` is what turns this connector's ticker into a _fallback_
   rather than the only source; until then, one unlisted asset stops both legs for that connection.
9. **Carried to the Phase 3 gate:** the live smoke has never run — no CDP key exists on this machine
   (§6 Q2's "if the account is unavailable, WP 3.5 builds against recorded fixtures and ships
   disabled"). The R6 determination is therefore measured against **recorded shapes**, and the gate's
   browser walk plus one live smoke run is what converts it from a well-founded finding into an
   observed one.

---

## 11. `just check`, appended

Run foreground at the close of the work package, after the sabotage matrix was restored.

```
$ just check
pnpm run typecheck
$ tsc -p tsconfig.json                                   ← PASS, repo-wide
pnpm run lint
$ prettier --check .
[warn] apps/api/src/bootstrap-seed.ts
[warn] apps/api/src/routes/categories.ts
[warn] apps/api/test/db/export-encrypt.test.ts
[warn] apps/web/e2e/support/cold-start-authenticator.ts
[warn] docs/evidence/phase-2/wp2.11-inbox-ui.md
[warn] packages/connectors/plaid/src/map.ts
error: recipe `lint` failed on line 128 with exit code 1
```

**Every remaining file belongs to a concurrent work package, not to this one.** `git status` puts
`export-encrypt.test.ts`, `wp2.11-inbox-ui.md` and `categories.ts` in WP 3.13's lane and
`plaid/src/map.ts` in WP 3.1/3.7's; `bootstrap-seed.ts` and `cold-start-authenticator.ts` were
already modified in the tree at `95d1c64`. This package edits none of them, so the formatting run was
scoped to what it owns:

```
$ pnpm exec prettier --check "packages/connectors/coinbase/**/*.{ts,json}" \
      "docs/evidence/phase-3/wp3.5-coinbase.md"
All matched files use Prettier code style!

$ pnpm exec eslint packages/connectors/coinbase --max-warnings 0
(no output)

$ pnpm exec vitest run --root packages/connectors/coinbase
Test Files  11 passed (11)
     Tests  133 passed | 1 skipped (134)
```

`tsc -p tsconfig.json` covers `packages/**/*.ts` and reports nothing in this package. The
`connector-coinbase` vitest project is not yet in `vitest.config.ts` (§8.4 is the orchestrator's
edit), so `just test` does not reach this suite yet — which is exactly why the command above is
recorded verbatim.
