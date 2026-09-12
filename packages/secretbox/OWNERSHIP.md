# `@core/secretbox` — table ownership

The cryptography chokepoint: XChaCha20-Poly1305 envelope encryption, the keyring,
and KEK custody. The only package in the repository permitted to import a cipher,
a KDF, a hash, or `node:crypto` — enforced by `personalfi/layer-imports` and by the
`no-restricted-imports` override in `eslint.config.js`.

It sits at the `@core/*` tier rather than inside `@ctx/identity` because the
boundary lint forbids `@ctx/*` → `@ctx/*` imports, so a `SecretBox` owned by a
context could never be the chokepoint that `@ctx/connections`, `@ctx/integrations`
and `@ctx/investments` all have to use. See the header of `src/index.ts`.

## Depends on

- Platform (`@core/db` for the column vocabulary, `@core/kernel` for `Clock` and ids)

## Tables

- `encryption_keys`
