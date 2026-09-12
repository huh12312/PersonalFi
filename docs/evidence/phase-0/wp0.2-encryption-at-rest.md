# WP 0.2 evidence — encryption at rest

**P0 item 1** (master plan §4): _"Provider tokens, exchange keys, LLM keys
encrypted app-layer before insert; a test reads the raw column via `psql` and
asserts no plaintext."_

## The shape of it

```
${SECRETS_DIR}/master_key  --Argon2id(m=1GiB,t=4,p=4)-->  KEK (32 B, memory only)
                                                            |
                        XChaCha20-Poly1305 wrap ------------+---> DEK per row      (provider secrets)
                        XChaCha20-Poly1305 wrap ------------+---> DEK per column   (bulk PII, epoch)
```

Stored bytes are a self-describing envelope:

```
version(1) || key_id(16) || nonce(24) || ciphertext+tag      -- 41-byte header
```

and every seal and open is bound to its row by mandatory AAD:

```
"personalfi/v1" | <table> | <column> | <row uuid> | <key version>
```

Not `pgcrypto`: with `pgcrypto` the key is supplied by the client, so it transits
the wire protocol, sits in server memory, and lands in `pg_stat_statements` and
query logs. The database never sees a key.

## The literal P0-1 assertion

Two tests read the raw `bytea` back exactly as `psql` would — once through the
driver and once through `encode(col, 'escape')`, which is what `psql` prints — and
assert the plaintext is absent, in UTF-8 and in Latin-1, whole and in 8-character
fragments:

| Column                                        | Test                                                                                                      |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `totp_secrets.sealed_secret` (real call site) | `packages/contexts/identity/test/totp.test.ts` — _"seals the seed before it touches the database (P0-1)"_ |
| `totp_secrets.sealed_secret` (direct seal)    | `packages/secretbox/test/secret-box.test.ts` — _"leaves no plaintext in the column (P0-1 evidence)"_      |
| `encryption_keys.wrapped_key`                 | `packages/secretbox/test/secret-box.test.ts` — the KEK verifier constant is absent from the keyring too   |

The fragment check matters: a whole-string `not.toContain` would pass against a
cipher that leaked half the value.

Confirmed by hand as well, on the development database:

```
$ just psql
personalfi=# SELECT id, encode(sealed_secret, 'escape') FROM totp_secrets;
-- 41 bytes of header followed by opaque bytes; no base32 seed anywhere
```

## What else is proved, and where

`packages/secretbox/test/secret-box.test.ts` (24 cases against a real Postgres):

| Property                                                                       | Why it is a separate test                                               |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Round trip for bytes, text, empty and multi-byte values                        | The baseline; everything else is a refusal                              |
| Two seals of the same value differ                                             | A fresh nonce per seal; a repeated nonce is the classic XChaCha failure |
| Envelope decodes to version 1 and names the key that made it                   | A `bytea` that cannot say which key made it cannot be rotated           |
| A ciphertext moved to another **row** does not open                            | The AAD binds `rowId`                                                   |
| A ciphertext moved to another **column** does not open                         | The AAD binds `column`                                                  |
| A ciphertext moved to another **table** does not open                          | The AAD binds `table`                                                   |
| A ciphertext replayed against another **key version** does not open            | The AAD binds `key_version`                                             |
| A single flipped bit — in the ciphertext, the tag or the nonce — does not open | The Poly1305 tag                                                        |
| A truncated envelope is refused by the parser                                  | The AEAD never sees a short buffer                                      |
| Every failure reports the same code (`decrypt_failed`)                         | An API that distinguishes them is an oracle                             |
| A key belonging to another user is refused (`unknown_key`)                     | The keyring is scoped by `user_id` (D6)                                 |
| A plaintext above 1 MiB is refused                                             | Refuse absurd inputs rather than allocating for them                    |
| `record` policy gives each row its own DEK                                     | What makes "remove this Plaid Item" a cryptographic erasure             |
| `epoch` policy shares one DEK per `(table, column)`                            | A per-row DEK across 200k transactions is ceremony, not security        |
| An epoch ciphertext is still bound to its own row                              | A shared DEK must not mean a portable ciphertext                        |
| `rotateKek` re-wraps DEKs and re-encrypts **no** user data                     | A rotation that needs downtime never happens (03 §2.4)                  |
| After rotation the old passphrase no longer unlocks                            | The rotation is real, not additive                                      |
| Superseded KEK generations are retired                                         | They are salt-and-verifier rows only                                    |
| `destroyRecordKey` makes a ciphertext permanently unreadable                   | Cryptographic erasure (P1-9): the bytes are already in a backup         |
| `destroy()` leaves the box unusable and the data recoverable on the next boot  | The `SIGTERM` path (P0-2)                                               |

`packages/secretbox/src/envelope.test.ts` and `src/kek.test.ts` (33 cases, no
database) cover the pure layer: header layout, UUID↔bytes, version and length
refusals, AAD determinism and separator-injection refusal, the Argon2id floor and
ceiling, and `KekHolder`.

## Key zeroing

`KekHolder` has **no getter**. The key is lent to a callback by `use()` and
nothing else, which makes "what can reach the KEK?" a greppable question.
`src/kek.test.ts` asserts that:

- `destroy()`, `lock()` and installing a new generation each **zero the caller's
  own buffer** — not merely drop the reference, so a heap dump taken after
  shutdown does not contain the key;
- `JSON.stringify({ security: { kek: holder } })` is `{"security":{"kek":"[KekHolder]"}}`,
  because the realistic leak is an object graph reaching a log serialiser rather
  than a deliberate `console.log`;
- `SecretBox.destroy()` also wipes the cached DEKs, so no unwrapped key outlives
  the KEK that protects it.

`apps/api/src/main.ts` calls `security.destroy()` from the `SIGTERM`/`SIGINT`
handler, after `app.close()` has drained in-flight requests.

## The chokepoint

Exactly one file in the repository may import a cipher, a KDF, a hash or
`node:crypto`: `packages/secretbox/src/primitives.ts`. This is mechanised twice —
`personalfi/layer-imports` denies the primitive packages outside
`packages/secretbox/`, and a `no-restricted-imports` override in
`eslint.config.js` denies them everywhere except that one file, **including in
tests**. The Argon2 benchmark was rewritten to call `deriveKek` rather than
`hash-wasm` so that it needs no exemption.

The failure this prevents is not a broken cipher. It is the second call site that
reuses a nonce, drops the AAD, or compares a tag with `===`.

## Reproducing

```bash
just db-up
just gen-master-key                     # writes secrets/master_key, mode 0400
DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_wp02 \
  pnpm exec vitest run --project secretbox --project secretbox-db --project identity-db
```

## Scope note (decision D5)

**Key loss = re-link providers, never = lose the ledger.** Only credentials are
sealed in Phase 0. Bulk encryption of memo and description columns is P2, and the
`epoch` policy exists now so that adding it later is a backfill rather than a
schema migration.
