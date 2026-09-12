# WP 0.2 evidence — Argon2id parameters for the KEK

**P0 item 2** (master plan §4): _"KEK never in env or cleartext on disk; Argon2id
(m ≥ 1 GiB, t = 4, p = 4)."_

This file records the measurement behind the shipped numbers, and the one
constraint the memo could not have known about: the KDF runs on wasm32, which puts
a hard ceiling on `m`.

## Decision

| Setting                | Value                      | Where                                      |
| ---------------------- | -------------------------- | ------------------------------------------ |
| Default `m`            | **1 GiB** (1048576 KiB)    | `KEK_ARGON2_MEMORY_KIB` default            |
| Default `t`            | **4**                      | `KEK_ARGON2_TIME_COST` default             |
| Default `p`            | **4**                      | `KEK_ARGON2_PARALLELISM` default           |
| Production floor       | m ≥ 1 GiB, t ≥ 4, p ≥ 4    | `KEK_ARGON2_FLOORS.production`             |
| Development/test floor | m ≥ 8 MiB, t ≥ 2, p ≥ 1    | `KEK_ARGON2_FLOORS.development`            |
| Hard ceiling           | **1.75 GiB** (1835008 KiB) | `KEK_MAX_MEMORY_KIB`, and the schema `max` |

The floor is selected from `NODE_ENV`, never from a setting of its own
(`packages/config/src/load.ts`). A "relax the KDF" switch is a switch that
eventually gets flipped in production at 02:00 to make a restart faster.

## Measurement

`node packages/secretbox/test/argon2-bench.ts`, node v26.8.1, linux/x64, on the
development machine. The bench calls `deriveKek` — the same code path the
application runs — rather than `hash-wasm` directly, because `hash-wasm` may be
imported in exactly one file and a benchmark is not an exception to that.

| m (KiB) | m (MiB) | t   | p   | wall ms | result                                                |
| ------- | ------- | --- | --- | ------- | ----------------------------------------------------- |
| 19456   | 19      | 2   | 1   | 68      | ok — OWASP password-storage minimum, far too low here |
| 65536   | 64      | 3   | 4   | 252     | ok                                                    |
| 131072  | 128     | 4   | 4   | 782     | ok                                                    |
| 262144  | 256     | 4   | 4   | 1856    | ok                                                    |
| 524288  | 512     | 4   | 4   | 3930    | ok                                                    |
| 1048576 | 1024    | 4   | 4   | 8424    | ok — **the shipped default**                          |
| 1835008 | 1792    | 4   | 4   | 12618   | ok — the measured ceiling                             |
| 2097152 | 2048    | 4   | 4   | —       | **FAILED: `Invalid typed array length: 2147484672`**  |

An earlier run on an idle machine measured the 1 GiB case at **5.86 s**; the 8.4 s
above was taken with the dev database and a test suite resident. Both are the same
order and both are acceptable, because this derivation happens **once, at boot**,
not once per request. That is also why the OWASP figure in the first row is the
wrong reference: it is tuned for thousands of logins per second.

### The ceiling is measured, not chosen

`hash-wasm` compiles Argon2 to **wasm32**, so the memory block plus its working
buffers must fit in a 4 GiB address space. At `m = 2 GiB` the allocation is
`2147484672` bytes — 1 KiB over the 2 GiB `TypedArray` limit — and it throws.
`KEK_MAX_MEMORY_KIB` is therefore 1.75 GiB, enforced in two places:

- `environmentSchema` rejects it at boot with every other config problem, so an
  operator sees it at `docker compose up`;
- `assertParamsAtOrAboveFloor` rejects it again inside `SecretBox`, so a caller
  that skipped `loadConfig` still cannot ask for it.

Discovering this on a 03:15 restart instead would mean an API that crash-loops
with a `TypedArray` error and no explanation.

## Library choice

`hash-wasm` (MIT, zero dependencies), not `@node-rs/argon2` and not
`@noble/hashes`:

- **`@node-rs/argon2`** is a native addon. It breaks the musl/glibc story for the
  Alpine image (D13) and cannot be audited from the lockfile, which matters because
  03 §1.4 ranks a malicious dependency running in this process as the top risk.
- **`@noble/hashes`** implements Argon2id in pure JS but is roughly an order of
  magnitude slower at 1 GiB, turning a 6 s boot into a minute.

## How this is verified

| Claim                                                            | Test                                         |
| ---------------------------------------------------------------- | -------------------------------------------- |
| Parameters at the floor are accepted                             | `packages/secretbox/src/kek.test.ts`         |
| Each parameter below the floor is rejected, all reported at once | `packages/secretbox/src/kek.test.ts`         |
| `m` above the wasm32 ceiling is rejected                         | `packages/secretbox/src/kek.test.ts`         |
| `SecretBox.unlock` re-checks the floor                           | `packages/secretbox/test/secret-box.test.ts` |
| `loadConfig` rejects a sub-floor configuration                   | `packages/config/src/*.test.ts`              |
| The boot log carries the parameters and the duration             | `apps/api/test/db/log-hygiene.test.ts`       |

## Custody, not just cost

The parameters are only half of P0-2. The other half is that the passphrase is a
**file secret** with no environment fallback — see
[wp0.2-log-hygiene.md](wp0.2-log-hygiene.md) and `SECRET_SPECS` in
`packages/config/src/schema.ts` — and that the derived key lives in one
`KekHolder`, is never returned by a getter, and is zeroed on `SIGTERM`.
