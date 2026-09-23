# WP 3.6 — `WalletRpcConnector` (watch-only BTC/ETH)

_Phase 3, Wave A. Package: `packages/connectors/walletrpc/**`. Spec:
[`docs/plan/03-phase-3-dispatch.md`](../../plan/03-phase-3-dispatch.md) §3 "WP 3.6" and §5;
[`docs/research/08-domain-model.md`](../../research/08-domain-model.md) §2.6, §2.2;
[`docs/research/01-aggregation-plaid.md`](../../research/01-aggregation-plaid.md) §3.5, §3.6.
Template: [`wp3.5-coinbase.md`](wp3.5-coinbase.md) and `packages/connectors/coinbase/**`._

---

## 1. What "no key material exists, therefore none can leak" is enforced by

Not a comment. Three independent, grep-provable facts:

1. **The only input seam is `connect()`**, and `src/connect-input.ts`'s `parseConnectInput` calls
   `src/guard.ts`'s `assertNoPrivateMaterial` on the raw string **before** any chain-specific
   parsing, storage, or logging happens. `test/no-private-key.test.ts` proves the refusal and
   §4 below proves it sabotage-tested.
2. **No signing primitive is imported anywhere in this package.**
   ```
   $ grep -rn "\.sign(" packages/connectors/walletrpc/src packages/connectors/walletrpc/test
   packages/connectors/walletrpc/src/btc/derive.ts:73:  if (account.publicKey === null || account.privateKey !== null) {
   ```
   That one hit is a **defensive read** of `HDKey.privateKey` (asserting it is `null` before deriving
   an address), not a call to anything that signs. There is no `.sign(` call in this package at all.
3. **`HDKey.fromMasterSeed` does not appear anywhere in this package**, and every `HDKey` this
   connector ever constructs comes from `HDKey.fromExtendedKey(value, { public: <prefix's public
version>, private: <prefix's private version> })` (`src/btc/scheme.ts`, `src/btc/derive.ts`) — a
   **public-only** construction path. Even a hypothetical gap in the string-level refusal could not
   produce a signing-capable key, because the version pair passed to `fromExtendedKey` only accepts
   the public half; a private extended key decodes to a version mismatch and throws.
   ```
   $ grep -rn "fromMasterSeed" packages/connectors/walletrpc/src
   (no matches other than doc comments naming it as absent)
   ```
4. **No credential is ever stored.** `connect()` returns `credentials: {}` (`src/connector.ts`): an
   xpub or an address is not a secret Ledger has to protect, so nothing here is ever sealed with
   `SecretBox`, and `wallet_addresses.descriptor` (migration 0016) has no `sealed_` column at all.

---

## 2. BTC derivation, walked against the published BIP84 test vector

`src/btc/scheme.ts` picks BIP44 (`xpub`), BIP49 (`ypub`) or BIP84 (`zpub`) by the extended key's own
four-character prefix, each with its correct mainnet version-byte pair. `src/btc/derive.ts` parses the
account-level extended **public** key with `HDKey.fromExtendedKey` and derives `m/<chain>/<index>`
(chain `0` = external/receiving, `1` = internal/change) — the only path available from a public key at
all, since `HDKey.deriveChild` throws without a private key for a hardened index, and an account-level
xpub/ypub/zpub has no more hardened segments left to derive.

Address encoding (`src/btc/address.ts`) implements all three schemes from `HASH160 = RIPEMD160(SHA256(pubkey))`:

| Scheme       | Address form | Encoding                                                         |
| ------------ | ------------ | ---------------------------------------------------------------- |
| BIP44 (xpub) | `1...`       | `base58check(0x00 \|\| hash160(pubkey))`                         |
| BIP49 (ypub) | `3...`       | `base58check(0x05 \|\| hash160(0x00 0x14 \|\| hash160(pubkey)))` |
| BIP84 (zpub) | `bc1...`     | `bech32('bc', 0 \|\| toWords(hash160(pubkey)))`                  |

**Neither `@core/secretbox`'s `sha256` nor RIPEMD-160 could be imported** — the former is not a
declared dependency of this package's `package.json` (which this work package may not edit) and does
not resolve under pnpm's isolated `node_modules`; the latter is exported by nothing on the dependency
list at all. Both are vendored from their public specifications (`src/btc/sha256.ts`,
`src/btc/ripemd160.ts`) and checked against **their own published test vectors** independently of the
BTC address test, in `src/btc/sha256.test.ts` and `src/btc/ripemd160.test.ts` — FIPS 180-4's `''`/`'abc'`/
the two-block 448-bit vector for SHA-256, and RIPEMD-160's own `''`/`'abc'`/`'message digest'`/the
alphabet/a two-block vector, 9 tests total, all green.

### The walk, against BIP84's own published test vector

Mnemonic `"abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon
about"` (BIP84's published vector), account 0 zpub:

```
zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs
```

| Path              | Expected (BIP84 spec)                        | This connector produces |
| ----------------- | -------------------------------------------- | ----------------------- |
| `m/84'/0'/0'/0/0` | `bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu` | same                    |
| `m/84'/0'/0'/0/1` | `bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g` | same                    |
| `m/84'/0'/0'/1/0` | `bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el` | same                    |

`test/derive.test.ts` → `'a BIP84 zpub derives the published test-vector addresses'` asserts all three
byte-for-byte.

### Gap limit

`src/btc/derive.ts`'s `scanChain` derives addresses in order, awaits an activity check per address, and
stops after `GAP_LIMIT = 20` **consecutive** empty ones. `test/derive.test.ts` →
`'derivation stops at the gap limit of 20 empty addresses'`: against a fake that always answers "no
activity", the scan checks **exactly 20** addresses (indices 0–19) and stops; a second case plants
activity at index 5 and confirms the scan checks 26 addresses total (5 unused + 1 used + 20 more unused)
before stopping, proving the counter genuinely resets on activity rather than merely counting to 20 once.

---

## 3. ETH: by address, not by derivation

08 §2.6 and the dispatch both describe the Ethereum leg as "by address" — the user pastes a public
`0x…` address directly, exactly like pointing a block explorer at it. `src/eth/address.ts` validates
shape only (`^0x[0-9a-fA-F]{40}$`); there is no BIP32 path, no HD key, and no seed of any kind on this
side at all, which is one less place private material could ever be asked for.

Native balance comes from Etherscan v2 (`GET /v2/api?chainid=1&module=account&action=balance`),
mainnet only. **No "enumerate all token balances" primitive exists on Etherscan** (01 §3.5) — it
answers per-contract `tokenbalance` only, so discovering an unknown token set requires first walking
transfer-event logs, which is out of scope here. `src/eth/etherscan.ts`'s header names the documented
upgrade path explicitly: **Alchemy's `alchemy_getTokenBalances`**, which would be a new host, a new
adapter, and a new allow-list entry — not a change to this file.

---

## 4. The refusal seam, and the sabotage

`src/guard.ts`'s `classifyPrivateMaterial` recognises four shapes, each deterministically (no pattern
guessing on the input's first character):

| Shape                                   | How it is recognised                                                                                                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WIF                                     | base58check-decodes to 33/34 bytes with version byte `0x80` or `0xef`                                                                                                  |
| `xprv`/`yprv`/`zprv` (+ testnet triple) | base58check-decodes to 78 bytes whose 4-byte version matches a known **private** extended-key version                                                                  |
| Raw 32-byte key                         | `^(0x)?[0-9a-fA-F]{64}$`                                                                                                                                               |
| BIP39-shaped mnemonic                   | 12/15/18/21/24 whitespace-separated tokens (BIP39's own closed list of valid mnemonic word counts), each 3–8 lowercase letters (every real BIP39 English word's shape) |

`test/no-private-key.test.ts` → `'an input parsing as a WIF, a seed phrase or an xprv is refused'`
drives all four shapes (using structurally-valid, checksum-correct — but not real-key — fixtures built
with the same `base58check` coder the guard uses, so the test is not merely checking a string prefix)
plus two "must not refuse" cases (a genuine zpub, a genuine ETH address) and a prose sentence that
merely contains many words. 10 assertions, all green; the offending value never appears in the thrown
error's message (only the _kind_ does).

**Sabotage, both red on the first attempt, both restored and re-verified green:**

1. Commented out the mnemonic branch (`if (looksLikeMnemonic(value)) return 'bip39_mnemonic_shaped';`)
   → `'refuses a 12-word BIP39-shaped seed phrase'` failed (`expected null to be 'bip39_mnemonic_shaped'`).
   Restored → 10/10 green.
2. Commented out the extended-private-key version check
   (`if (PRIVATE_EXTENDED_KEY_VERSIONS.has(version)) return 'extended_private_key';`) → all three of
   `'refuses an xprv'`, `'refuses a yprv'`, `'refuses a zprv'` failed. Restored → 10/10 green.

---

## 5. The one-security proof: a wallet ETH balance and a Coinbase ETH balance

**Not imported from `@ctx/investments`.** The dispatch asks to drive both identifiers through the real
resolver's merge rule "if importable from a test, else through the port's identifier equality — say
which." It is not importable: `scripts/eslint-boundaries.js`'s `connectors` layer allow-list is
`['@core/kernel', '@core/secretbox', '@connector/port', 'zod']` with no `@ctx/*` member, and the
test-file exemption only adds `vitest`/`fast-check` — confirmed by attempting the import and observing
`personalfi/layer-imports` reject it identically to the `@scure/*` imports in §7.

So `test/one-security.test.ts` uses **the port's identifier equality**, checked against a verbatim
transcription of `packages/contexts/investments/src/identifiers.ts`'s `NATIVE_ASSETS` ethereum entry
(cited, not reinvented) and the exact Coinbase-shaped identifier
[`wp3.5-coinbase.md` §10 item 6](wp3.5-coinbase.md) states:

```
coinbase:  { kind: 'ticker', value: 'ETH', chain: null, mic: null }
walletrpc: { kind: 'chain_contract', value: '0xEeee…eEEeE', chain: 'ethereum', mic: null }
                                             (nativeSecurityIdentifierOf('ethereum'), src/connector.ts)
```

The test proves: (1) the wallet's identifier is a `chain_contract` naming a value in `NATIVE_ASSETS`'s
`ethereum` entry's `sentinelContracts`; (2) Coinbase's bare `ETH` ticker is a member of that same
entry's `aliases`; (3) both therefore canonicalise onto **the same table row** — which is the actual
merge rule (transcribed and cited, pinned against `@ctx/investments`'s own drift-detection test rather
than reinvented) that lands them on one `security_id`; (4) a bitcoin wallet identifier does not collide
with it. 4/4 green.

`nativeSecurityIdentifierOf` is wired into the connector's real runtime path, not left as dead code: it
is attached to the `DATA_UNAVAILABLE` error's `redactedContext` in §6 below, so the identifier a priced
fact would eventually carry (once WP 3.4 supplies a price) is already present today.

---

## 6. Why every non-zero balance raises `DATA_UNAVAILABLE`, never `$0.00`

This connector has **no price source of its own** — its only two hosts (§7) are Esplora and Etherscan,
neither of which quotes a USD price. `ProviderBalanceFact.current` and `ProviderHoldingFact.value` are
`Money`: `@core/kernel`'s `CurrencyCode` defaults to a 2-decimal minor-unit scale, structurally
incapable of holding a native 8-decimal BTC or 18-decimal ETH quantity without ruinous truncation, so
reporting either would require a real fiat price this connector cannot get.

08 §2.2: **"an honest adapter never reports $0.00 for an unpriced asset."** So:

- A **non-zero** on-chain balance/holding raises a named `ConnectorError.fromCondition('DATA_UNAVAILABLE', …)`
  naming the asset and quantity — exactly `CoinbaseConnector`'s `#pricesFor` failure mode for an
  unlisted altcoin, generalised to the whole connector because it has no listed ones at all.
- A **literal zero** balance is reported honestly as `Money.zero('USD')`; a literal zero _holding_ is
  simply omitted (mirrors `CoinbaseConnector.syncHoldings` skipping a zero balance).

`test/unpriced.test.ts` → `'an unpriced non-zero balance fails loudly rather than reporting zero'`:
funds a BTC wallet (1,234 sats via the fake Esplora fixture) and an ETH wallet (0.042 ETH via the fake
Etherscan fixture), asserts both `syncBalances`/`syncHoldings` raise `DATA_UNAVAILABLE` naming the exact
quantity, and separately asserts a literal zero is reported as `Money.zero`/omitted rather than refused.
`test/connector.test.ts` exercises the same property end-to-end through `connect()` → `syncBalances`.
A real fiat valuation for these balances is WP 3.4's `PriceSource` plus the resolver's `security_id`
join downstream — never inside this connector.

---

## 7. Egress: hosts, redirect, and the API key

Two hosts, one per network, both **source-code constants** — never a parameter, never derived from
user input:

| Host               | Client                 | What travels in the request                                                  |
| ------------------ | ---------------------- | ---------------------------------------------------------------------------- |
| `blockstream.info` | `src/btc/esplora.ts`   | `GET /api/address/:address` — the address only, `encodeURIComponent`-escaped |
| `api.etherscan.io` | `src/eth/etherscan.ts` | `GET /v2/api?chainid=1&module=account&action=balance&address=…&apikey=…`     |

**This package does not, and per `scripts/eslint-boundaries.js`'s `connectors` layer `why` must not,
import `@core/platform`** ("not the database, not the platform, not another context"). The SSRF-grade
guard — DNS-rebinding-safe resolution, private/link-local refusal, no redirect following, a bounded
body — is `@core/platform`'s `guardDestination`/`createNodeTransport`, built once at the composition
root and injected here exactly as `CoinbaseConnector`'s transport is (`packages/connectors/coinbase/src/api.ts`'s
`CoinbaseTransport`). What this package owns, and what `test/egress.test.ts` proves:

1. **The destination host is a constant no input can change.** Both clients driven with adversarial
   "addresses" (`../../../etc/passwd`, an embedded `http://169.254.169.254/…`, a query-string host
   override) — every recorded request's `host` is still exactly `ESPLORA_HOST`/`ETHERSCAN_HOST`.
2. **A 302 is not followed.** Both clients handed a bare `{status: 302}` fake response produce
   **exactly one** request and a typed error — there is no second-request code path in either client
   to trigger.
3. **The Etherscan API key never appears in a thrown error's message or in `JSON.stringify`.** Tested
   directly against a 500 response and against the `EtherscanApiKey` wrapper's own serialisation
   (`toString`/`toJSON` answer `'[redacted]'`, same shape as `@ctx/integrations`'s `ApiKey`).

6 assertions, all green.

---

## 8. Carried, and asks for the orchestrator

1. **Boundary layer.** `scripts/eslint-boundaries.js` has no `connector-walletrpc` entry; this package
   falls under the generic `connectors` layer, whose allow-list has no `@scure/*` member. `pnpm exec
eslint packages/connectors/walletrpc` currently reports exactly 5 violations, all `@scure/bip32`/
   `@scure/base` imports in `src/btc/address.ts`, `src/btc/derive.ts`, `src/btc/scheme.ts`,
   `src/guard.ts` and `test/no-private-key.test.ts` — no `eslint-disable` was added. The orchestrator
   needs, in the same shape as `connector-plaid`'s entry, placed before the generic `connectors` entry:
   ```js
   {
     name: 'connector-walletrpc',
     prefix: 'packages/connectors/walletrpc/',
     allow: ['@core/kernel', '@core/secretbox', '@connector/port', '@scure/bip32', '@scure/base', ...UNIVERSAL],
     allowNodeBuiltins: true,
     why: 'The watch-only wallet adapter derives BTC addresses locally from an xpub/ypub/zpub via ' +
       '@scure/bip32 + @scure/base (bech32/base58check) and needs no other provider SDK.',
   }
   ```
2. **Secret and config lines.**
   - `etherscan_api_key` — a file secret under `${SECRETS_DIR}` (decision D5, same pattern as
     `tiingo_api_key`), **optional**: this connector is constructible and its BTC leg works without
     one; the ETH leg raises `CONFIG_ERROR`/`invalid_input` naming the missing secret if a balance is
     requested with none present. Handed to the connector as `src/eth/api-key.ts`'s `EtherscanApiKey`.
   - `CRYPTO_ALLOWED_HOSTS` — the config key the wiring batch adds to `@core/platform`'s egress
     allow-list: exactly `blockstream.info` and `api.etherscan.io`, https-only, default ports.
3. **Registry entry.** `WALLETRPC_PROVIDER = 'wallet_rpc'` (`src/provider.ts`), `WALLETRPC_MANIFEST`
   (icon key `'crypto'`, `linkKind: 'credential_form'`, no docs URL) — register in `ConnectorRegistry`
   the same way `COINBASE_MANIFEST` is registered.
4. **The real `WalletAddressStore`.** `src/store.ts`'s interface (`get`/`put`/`updateScanState`/
   `delete`, keyed by `providerConnectionId`) needs a Postgres-backed implementation against
   `wallet_addresses` (migration 0016), bound to `WalletRpcConnector` at construction exactly as
   `@connector/csv`'s injected `DurableStore` is bound. `wallet_addresses` is already claimed by
   `@ctx/investments`'s `OWNERSHIP.md` (written at WP 3.1, ahead of this migration landing it) — no
   schema-ownership change was needed — but no Drizzle `pgTable('wallet_addresses', …)` definition
   exists yet; that belongs inside `packages/contexts/investments/schema/`, which this work package
   does not own.
5. **Not this work package's job, named so it is not re-opened:** enumerating ERC-20 token balances
   (Alchemy `alchemy_getTokenBalances`, §3), and a real fiat valuation for any balance this connector
   finds (WP 3.4's `PriceSource`, §6).

---

## 9. Test counts, `tsc`, `eslint`

| Suite                 | File                          | Count  |
| --------------------- | ----------------------------- | ------ |
| `connector-walletrpc` | `src/btc/ripemd160.test.ts`   | 5      |
| `connector-walletrpc` | `src/btc/sha256.test.ts`      | 4      |
| `connector-walletrpc` | `test/derive.test.ts`         | 4      |
| `connector-walletrpc` | `test/no-private-key.test.ts` | 10     |
| `connector-walletrpc` | `test/connector.test.ts`      | 8      |
| `connector-walletrpc` | `test/conformance.test.ts`    | 14     |
| `connector-walletrpc` | `test/egress.test.ts`         | 6      |
| `connector-walletrpc` | `test/unpriced.test.ts`       | 3      |
| `connector-walletrpc` | `test/one-security.test.ts`   | 4      |
| **Total**             |                               | **58** |

```
$ pnpm exec vitest run --project connector-walletrpc --project db
 Test Files  10 passed (10)
      Tests  68 passed (68)

$ pnpm exec tsc -b --noEmit
(clean — no output)

$ pnpm exec eslint packages/connectors/walletrpc
5 problems, all @scure/bip32 / @scure/base boundary-lint violations — see §8 item 1.

$ node scripts/check-schema-ownership.ts
schema-ownership: ok — 98 table(s) claimed across 14 package(s), 77 defined.

$ node scripts/check-ci-projects.ts
PASS — connector-walletrpc already listed (registered when the package scaffold landed).
```

`packages/db/test/migrate.test.ts` rows added, minimally: `'wallet_addresses'` inserted into the
alphabetical post-migration table list, and one narrative comment block for `0016_wallet_addresses`
matching the style of every other migration's entry there. No new `describe`/`it` blocks — the existing
`runMigrations` suite exercises 0016 by construction (10/10 green against a real scratch Postgres at
`DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev`).

---

## 10. Files touched

- `packages/connectors/walletrpc/src/**` (new: `provider.ts`, `guard.ts`, `connect-input.ts`,
  `connector.ts`, `store.ts`, `units.ts`, `index.ts`, `btc/{scheme,derive,address,hash160,sha256,
ripemd160}.ts` (+ `.test.ts` for `sha256`/`ripemd160`), `eth/{address,etherscan,api-key}.ts`).
  `src/index.ts` replaced the placeholder.
- `packages/connectors/walletrpc/test/**` (new: `fake.ts`, `harness.ts`, `derive.test.ts`,
  `no-private-key.test.ts`, `connector.test.ts`, `conformance.test.ts`, `egress.test.ts`,
  `unpriced.test.ts`, `one-security.test.ts`).
- `packages/connectors/walletrpc/OWNERSHIP.md` (new).
- `packages/db/migrations/0016_wallet_addresses.sql` (new).
- `packages/db/test/migrate.test.ts` (minimal: one table-list entry, one narrative comment block).
- `docs/evidence/phase-3/wp3.6-walletrpc.md` (this file).

## 11. Open

- The `connector-walletrpc` boundary-lint layer (§8 item 1) — required before CI's `just verify` can
  be green on this package; `just verify` was not run as part of this work package (out of scope per
  the dispatch's per-agent verification list, which names `vitest`, `tsc`, `eslint` directly).
- The real `WalletAddressStore` implementation and its Drizzle schema (§8 items 3–4).
- No live smoke against real Esplora/Etherscan servers exists — every test here is hermetic, per the
  dispatch's "no network in tests" rule. The gate's browser walk is what converts the BIP84 vector
  match and the egress design from a well-founded implementation into an observed one, the same
  posture WP 3.5 recorded for its own live smoke.
