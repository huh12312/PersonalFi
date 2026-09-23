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

## Boundary layer needed

`scripts/eslint-boundaries.js` has no `connector-walletrpc` entry, so this
package currently falls under the generic `connectors` layer, whose allow-list
(`['@core/kernel', '@core/secretbox', '@connector/port', 'zod']`) does not
include `@scure/bip32` or `@scure/base` — both required by the dispatch
("using @scure/bip32" (03 §3 "WP 3.6")) and both already declared dependencies
in this package's own `package.json`. A named layer, in the same shape as
`connector-plaid`'s, is needed:

```js
{
  name: 'connector-walletrpc',
  prefix: 'packages/connectors/walletrpc/',
  allow: ['@core/kernel', '@core/secretbox', '@connector/port', '@scure/bip32', '@scure/base', ...UNIVERSAL],
  allowNodeBuiltins: true,
  why:
    'The watch-only wallet adapter derives BTC addresses locally from an xpub/ypub/zpub via ' +
    '@scure/bip32 + @scure/base (bech32/base58check) and needs no other provider SDK.',
}
```

placed before the generic `connectors` entry (`layerFor` matches the first
prefix). This package does not edit `scripts/eslint-boundaries.js` itself —
see `docs/evidence/phase-3/wp3.6-walletrpc.md` §7 for the observed `eslint`
failures this produces until the entry lands.

## Third party

`@scure/bip32` and `@scure/base` (both MIT, both already pinned in this
package's `package.json` at 2.4.0). `@core/secretbox`'s `sha256` and
`@noble/hashes`' RIPEMD-160 are **not** dependencies of this package and do not
resolve under pnpm's isolated `node_modules`, so SHA-256 (`src/btc/sha256.ts`)
and RIPEMD-160 (`src/btc/ripemd160.ts`) are vendored, pure transcriptions of
their public specifications, each checked against that algorithm's own
published test vectors. Nothing else is vendored.
