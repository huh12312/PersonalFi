// SPDX-License-Identifier: MIT
/**
 * The CDP per-request JWT (01 §3.2). Ed25519 / EdDSA, 120 seconds, uri-bound.
 *
 * ## Why this is the most security-sensitive file in the package
 *
 * Everything else here maps JSON. This file is the only place a private key
 * exists as a usable object, and three properties are load-bearing:
 *
 *  1. **EdDSA, never ES256.** 01 §3.2 quotes CDP directly — "ECDSA is a legacy
 *     key algorithm. You should use Ed25519 instead" — and notes that Plaid's
 *     *webhook* verification is ES256, so the two are adjacent in this codebase
 *     and easy to confuse. `parseCdpPrivateKey` therefore **refuses** an ECDSA
 *     key with a typed error naming the fix, rather than signing with whatever
 *     it was handed. A silent downgrade is the classic JWT vulnerability and
 *     this is the one place it could happen.
 *  2. **A fresh token per request.** `nonce` is 16 CSPRNG bytes and `exp` is
 *     `nbf + 120`. Reuse is not merely impolite: the `uri` claim binds the token
 *     to one method and one path, so a reused token is a token being replayed
 *     against an endpoint it was not minted for, and CDP rejects it. We do not
 *     rely on CDP rejecting it — `mintCdpJwt` has no cache to reuse *from*.
 *  3. **The key never outlives the signature.** The `KeyObject` is a local, the
 *     function returns a string, and nothing retains either. There is no
 *     module-level cache keyed by key name, because a cache is a place a
 *     credential survives a request.
 *
 * ## Serialisation
 *
 * A JWS compact serialisation is three base64url segments. It is thirty lines of
 * `node:crypto` and a `Buffer`, and writing them is strictly safer than adding a
 * JWT library: the boundary lint allow-list for this package is `@core/kernel`,
 * `@core/secretbox`, `@connector/port` and Node builtins, and every JWT library
 * that has ever had a CVE had it in the *verification* path we do not need.
 */
// The single-crypto-call-site rule (03 §2) exists to stop a *second* AEAD call
// site — "the one that reuses a nonce, drops the AAD, or compares a tag with
// `===`". None of those exists here: this is an Ed25519 **signature** over a
// public string, mandated by the provider (01 §3.2 — CDP accepts EdDSA and
// nothing we could substitute), and `@core/secretbox` exposes no signing
// primitive to route it through. The dispatch made the same judgement when it
// rejected `jose` before an agent could propose it: "`node:crypto` signs
// **Ed25519** natively" (§4, dependency batch). The nonce that *is* here comes
// from `@core/secretbox`'s `randomBytes`, which is the audited CSPRNG, and no
// comparison of any kind happens in this file.
//
// This follows `packages/platform/src/config-snapshot.ts`'s precedent for an
// in-file carve-out. It would sit better in `eslint.config.js`'s `ignores` list
// beside `packages/db/src/migrate.ts` — see wp3.5-coinbase.md §9, which asks the
// orchestrator to move it there, since this package may not edit that file.
// eslint-disable-next-line no-restricted-imports -- Ed25519 signing, provider-mandated; no cipher, no AAD, no tag comparison
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { ConnectorError } from '@connector/port';
import { randomBytes } from '@core/secretbox';
import {
  CDP_JWT_ALGORITHM,
  CDP_JWT_AUDIENCE,
  CDP_JWT_ISSUER,
  CDP_JWT_LIFETIME_SECONDS,
  CDP_JWT_NONCE_BYTES,
} from './provider.ts';

/** The PKCS#8 prelude for a raw Ed25519 seed: SEQUENCE, version, OID 1.3.101.112. */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_SEED_BYTES = 32;
/** CDP hands out `base64(seed ‖ publicKey)`; libsodium's "secret key" layout. */
const ED25519_SODIUM_SECRET_BYTES = 64;

function configError(message: string, redactedContext: Record<string, unknown>): ConnectorError {
  return ConnectorError.fromCondition('CONFIG_ERROR', message, { redactedContext });
}

function base64url(input: Buffer | string): string {
  return (typeof input === 'string' ? Buffer.from(input, 'utf8') : input).toString('base64url');
}

/**
 * A CDP private key, in any of the three shapes the portal hands out.
 *
 * Accepted:
 *   * a PKCS#8 PEM whose key type is `ed25519`;
 *   * `base64(seed ‖ publicKey)`, 64 bytes — the current CDP download format;
 *   * `base64(seed)`, 32 bytes.
 *
 * Refused, loudly and by name:
 *   * an EC / ECDSA PEM, because signing with it would mean ES256 (01 §3.2);
 *   * an RSA PEM, for the same reason;
 *   * anything else, as `CONFIG_ERROR` → `invalid_input`, which the orchestrator
 *     renders as "fix your key" rather than retrying forever.
 *
 * **No part of the key, and no length of it, appears in any error raised here.**
 * `redactedContext` carries the *format* that was detected and nothing else.
 */
export function parseCdpPrivateKey(material: string): KeyObject {
  const text = material.trim();
  if (text.length === 0) {
    throw configError('the CDP private key is empty', { reason: 'empty' });
  }

  if (text.startsWith('-----BEGIN')) {
    let key: KeyObject;
    try {
      key = createPrivateKey(text);
    } catch {
      // The cause is deliberately dropped: an OpenSSL error from a malformed
      // PEM can quote the offending bytes, and the offending bytes are the key.
      throw configError('the CDP private key is not a readable PEM', { reason: 'unreadable_pem' });
    }
    if (key.asymmetricKeyType !== 'ed25519') {
      throw configError(
        `the CDP key is ${String(key.asymmetricKeyType)}, and this connector signs only Ed25519 ` +
          '(EdDSA). CDP documents ECDSA as a legacy algorithm; create a new Ed25519 key at ' +
          'portal.cdp.coinbase.com. Signing with a legacy key here would be an algorithm ' +
          'downgrade, which is why it is refused rather than accommodated.',
        { reason: 'wrong_algorithm', keyType: String(key.asymmetricKeyType) },
      );
    }
    return key;
  }

  // Not a PEM. The remaining legitimate shape is base64 of raw key bytes.
  const raw = Buffer.from(text, 'base64');
  const seed =
    raw.length === ED25519_SODIUM_SECRET_BYTES
      ? raw.subarray(0, ED25519_SEED_BYTES)
      : raw.length === ED25519_SEED_BYTES
        ? raw
        : null;
  if (seed === null) {
    throw configError(
      'the CDP private key is neither a PEM nor base64-encoded Ed25519 key bytes. Paste the ' +
        '`privateKey` field from the JSON the CDP portal downloaded.',
      { reason: 'unrecognised_format' },
    );
  }
  try {
    return createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
      format: 'der',
      type: 'pkcs8',
    });
  } catch {
    throw configError('the CDP private key bytes are not a valid Ed25519 seed', {
      reason: 'invalid_seed',
    });
  }
}

/**
 * The `uri` claim: `"{METHOD} {host}{path}"`, with **no query string**.
 *
 * 01 §3.2's worked example is `GET api.coinbase.com/api/v3/brokerage/accounts`.
 * Including the query would be the natural mistake — `?limit=250` is part of the
 * request, after all — and it produces a 401 that looks like a clock skew
 * problem. `jwt.test.ts` asserts the query is stripped.
 */
export function cdpRequestUri(method: string, host: string, path: string): string {
  const withoutQuery = path.split('?')[0] ?? path;
  return `${method.toUpperCase()} ${host}${withoutQuery}`;
}

export interface CdpJwtInput {
  /** `organizations/{org}/apiKeys/{key}`. Becomes both `kid` and `sub`. */
  readonly keyName: string;
  readonly privateKey: KeyObject;
  readonly method: string;
  readonly host: string;
  readonly path: string;
  /** From the injected `Clock`. `Date.now()` is lint-banned outside `@core/kernel`. */
  readonly nowMs: number;
}

/** The decoded token, for tests and for nothing else. Never logged. */
export interface DecodedCdpJwt {
  readonly header: {
    readonly alg: string;
    readonly typ: string;
    readonly kid: string;
    readonly nonce: string;
  };
  readonly payload: {
    readonly sub: string;
    readonly iss: string;
    readonly nbf: number;
    readonly exp: number;
    readonly aud: readonly string[];
    readonly uri: string;
  };
  readonly signature: string;
}

/**
 * Mint one token for one request.
 *
 * There is no `expiresAt` in the return value and no caching hook, deliberately:
 * the only correct lifetime for a uri-bound token is "this request", and an API
 * that let a caller hold one would invite exactly the reuse `jwt.test.ts`
 * forbids.
 */
export function mintCdpJwt(input: CdpJwtInput): string {
  const issuedAt = Math.floor(input.nowMs / 1000);
  const header = {
    alg: CDP_JWT_ALGORITHM,
    typ: 'JWT',
    kid: input.keyName,
    nonce: Buffer.from(randomBytes(CDP_JWT_NONCE_BYTES)).toString('hex'),
  };
  const payload = {
    sub: input.keyName,
    iss: CDP_JWT_ISSUER,
    nbf: issuedAt,
    exp: issuedAt + CDP_JWT_LIFETIME_SECONDS,
    aud: [...CDP_JWT_AUDIENCE],
    uri: cdpRequestUri(input.method, input.host, input.path),
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  // `null` as the digest is how Node says "the algorithm chooses": Ed25519 is
  // PureEdDSA and pre-hashing it would produce a signature CDP rejects.
  const signature = sign(null, Buffer.from(signingInput, 'utf8'), input.privateKey);
  return `${signingInput}.${signature.toString('base64url')}`;
}

/**
 * Decode without verifying. **Test-only**, and it says so in its name's absence
 * from `index.ts`'s public story: nothing in `src/` calls it.
 *
 * It exists because `jwt.test.ts` must assert the header and claims of a token
 * this package produced, and reaching for a JWT library to do that would put a
 * verification code path in the tree that production does not have.
 */
export function decodeCdpJwtForTest(token: string): DecodedCdpJwt {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('not a compact JWS');
  const [rawHeader, rawPayload, signature] = parts as [string, string, string];
  return {
    header: JSON.parse(
      Buffer.from(rawHeader, 'base64url').toString('utf8'),
    ) as DecodedCdpJwt['header'],
    payload: JSON.parse(
      Buffer.from(rawPayload, 'base64url').toString('utf8'),
    ) as DecodedCdpJwt['payload'],
    signature,
  };
}
