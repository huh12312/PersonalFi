# `@connector/walletrpc` — table ownership

`WalletRpcConnector`: watch-only Bitcoin (xpub/ypub/zpub, local BIP32/44/49/84
derivation) and Ethereum (plain address). No provider-hosted flow; the user
pastes the descriptor into our own form.

## Tables

None. An adapter never writes to the database (08 §2.3); this package holds
no database handle at all.

One claim that deliberately is **not** made here, in the same shape
`packages/connectors/csv/OWNERSHIP.md` uses for its mapping-profile schema:
**`wallet_addresses` (migration
`packages/db/migrations/0016_wallet_addresses.sql`) belongs to
`@ctx/investments`**, not to this package. `packages/contexts/investments/OWNERSHIP.md`
already claims it — written at WP 3.1, ahead of this migration, with its own
text: "`wallet_addresses` lands in 0016 (WP 3.6) and is still a claim" — so
`scripts/check-schema-ownership.ts` passes cleanly the moment this migration
exists; there was nothing to add there. What genuinely is carried to the
orchestrator (this work package owns neither `packages/contexts/investments/**`
nor its schema): the actual Drizzle `pgTable('wallet_addresses', …)`
definition, and a Postgres-backed implementation of the interface below —
see `docs/evidence/phase-3/wp3.6-walletrpc.md` §8.

What this package ships instead is the seam that real implementation binds
to: `src/store.ts`'s `WalletAddressStore` interface
(`get`/`put`/`updateScanState`/`delete`, keyed by `providerConnectionId`,
exactly the shape `packages/connectors/csv/src/connector.ts`'s injected
`DurableStore` uses for the identical reason). `WalletRpcConnector` is
constructed with one; `test/fake.ts`'s `InMemoryWalletAddressStore` is what
every test in this package runs against.

## Configuration and secrets

- **`etherscan_api_key`** — a file secret under `${SECRETS_DIR}` (decision D5,
  the same pattern as `tiingo_api_key` etc. in `@ctx/integrations`), optional:
  Etherscan v2 requires a key for any real request, but this connector is
  constructible and its Bitcoin leg works without one. Read at boot, handed to
  this package as `src/eth/api-key.ts`'s `EtherscanApiKey` — never a bare
  `string` past that point, and never logged (`test/egress.test.ts`).
- **`CRYPTO_ALLOWED_HOSTS`** — the config key the wiring batch adds to
  `@core/platform`'s egress allow-list, exactly `blockstream.info` and
  `api.etherscan.io`, https-only. This package never imports
  `@core/platform` itself (`scripts/eslint-boundaries.js`'s `connectors` layer
  denies it, deliberately: "not the database, not the platform, not another
  context") — it takes an already-guarded `EsploraTransport` /
  `EtherscanTransport` function, built at the composition root exactly as
  `CoinbaseConnector`'s transport is.

## Boundary layer

`scripts/eslint-boundaries.js` now has a `connector-walletrpc` entry (allow
list: `@core/kernel`, `@core/secretbox`, `@connector/port`, `@scure/bip32`,
`@scure/base`, `@noble/hashes`, plus `UNIVERSAL`), placed before the generic
`connectors` entry. The layer request this section used to carry to the
orchestrator — the missing `personalfi/layer-imports` entry for `@scure/bip32`
/`@scure/base` — is satisfied.

That layer entry only controls import _direction_, though, and does not fully
clear `pnpm exec eslint packages/connectors/walletrpc`: a separate,
codebase-wide `no-restricted-imports` rule (predating this package) confines
`@noble/hashes` to one audited call site, `packages/secretbox/src/primitives.ts`,
everywhere except there. `src/btc/hash160.ts`, `src/btc/address.ts`,
`src/guard.ts` and `test/no-private-key.test.ts` import `@noble/hashes`
directly (replacing the hand-vendored SHA-256/RIPEMD-160 below) and so still
trip that rule — 5 errors. Routing both hashes through `@core/secretbox`
instead would clear it, but needs two changes outside this package's current
scope: `@core/secretbox` as a declared dependency of this package's
`package.json` (it resolves for `@connector/coinbase`, which does declare it,
but not here), and a `ripemd160` export added to `@core/secretbox` alongside
its existing `sha256`. See `docs/evidence/phase-3/wp3.6-walletrpc.md` §2's
update and §11 for the full note.

## Third party

`@scure/bip32`, `@scure/base` and `@noble/hashes` (all MIT, all declared
dependencies of this package's `package.json`, pinned at 2.4.0). SHA-256 and
RIPEMD-160 come from `@noble/hashes` (`@noble/hashes/sha2.js`'s `sha256`,
`@noble/hashes/legacy.js`'s `ripemd160`) — the same library `@scure/bip32` and
`@core/secretbox` already depend on — rather than from a hand-rolled
transcription. Nothing in this package is vendored. (The chokepoint-correct
end state routes both through `@core/secretbox` rather than importing
`@noble/hashes` directly — see "Boundary layer" above.)

**Resolved 2026-09-23:** both hashes now come from `@core/secretbox` (which gained a `ripemd160` export for
this one caller); `@noble/hashes` is no longer a dependency of this package nor on its boundary allow-list.
The `no-restricted-imports` chokepoint holds with zero exceptions.
