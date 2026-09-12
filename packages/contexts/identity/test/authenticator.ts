// SPDX-License-Identifier: MIT
/**
 * A software WebAuthn authenticator, for testing the passkey flows end to end.
 *
 * **Why build one rather than stub `@simplewebauthn/server`.** Stubbing the
 * verifier would delete the only part of registration and authentication that has
 * any security content: that a signature over
 * `authenticatorData || SHA-256(clientDataJSON)` verifies under the public key we
 * stored, against the challenge we minted, for the RP id and origin we configured.
 * A test with the verifier mocked out passes just as happily against a build that
 * accepts any assertion at all, which is the bug it most needs to catch. So this
 * file assembles real CBOR, real COSE and a real ES256 signature, and the library
 * checks them for real.
 *
 * Signing uses the Web Crypto global (`crypto.subtle`) rather than an import:
 * `node:crypto` is lint-banned outside `@core/secretbox/src/primitives.ts` and
 * there is deliberately no exemption for tests, because "it is only a test" is how
 * a second crypto call site gets into the tree.
 *
 * Structures assembled here (WebAuthn Level 3, §6.1 and §6.5.2):
 *
 *     authData = rpIdHash(32) || flags(1) || signCount(4) [|| attestedCredentialData]
 *     attestedCredentialData = aaguid(16) || credIdLen(2) || credId || COSE public key
 *     attestationObject = CBOR({ fmt: "none", attStmt: {}, authData })
 */
import { sha256 } from '@core/secretbox';
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransport,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { isoCBOR } from '@simplewebauthn/server/helpers';

/** Authenticator data flags (WebAuthn §6.1). */
const FLAG_UP = 0x01; // user present
const FLAG_UV = 0x04; // user verified
const FLAG_BE = 0x08; // backup eligible
const FLAG_BS = 0x10; // backed up
const FLAG_AT = 0x40; // attested credential data included

const COSE_KTY = 1;
const COSE_ALG = 3;
const COSE_CRV = -1;
const COSE_X = -2;
const COSE_Y = -3;
const COSE_KTY_EC2 = 2;
const COSE_ALG_ES256 = -7;
const COSE_CRV_P256 = 1;

function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function fromB64url(value: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(value, 'base64url'));
}

function utf8(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value);
}

function uint32(value: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

function uint16(value: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, false);
  return out;
}

/**
 * ASN.1 DER for an ECDSA signature.
 *
 * WebCrypto signs to the raw `r || s` of the WebCrypto spec; WebAuthn carries the
 * DER `SEQUENCE { INTEGER r, INTEGER s }` that the FIDO signature formats specify,
 * and SimpleWebAuthn's `unwrapEC2Signature` parses exactly that. For P-256 the
 * body is at most 70 bytes, so the short-form length byte is always sufficient.
 */
function toDerSignature(raw: Uint8Array): Uint8Array<ArrayBuffer> {
  const body = concat([derInteger(raw.subarray(0, 32)), derInteger(raw.subarray(32, 64))]);
  return concat([Uint8Array.of(0x30, body.length), body]);
}

function derInteger(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  let value = bytes.subarray(start);
  // DER integers are signed, so a leading high bit needs a zero byte in front or
  // the value reads as negative.
  if (((value[0] ?? 0) & 0x80) !== 0) value = concat([Uint8Array.of(0), value]);
  return concat([Uint8Array.of(0x02, value.length), value]);
}

function clientData(type: 'webauthn.create' | 'webauthn.get', challenge: string, origin: string) {
  return utf8(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
}

export interface AuthenticatorOptions {
  readonly rpId: string;
  readonly origin: string;
  /** Returned as `userHandle` on an assertion, as a discoverable credential would. */
  readonly userId: string;
  /**
   * Authenticators that keep a signature counter start above zero. Platform
   * passkeys mostly report 0 forever, which is why the clone check in
   * `WebAuthnService` is `> 0n` rather than `>= 0n`; both are exercised.
   */
  readonly signCount?: number;
  readonly backedUp?: boolean;
  readonly aaguid?: Uint8Array;
  readonly transports?: readonly AuthenticatorTransport[];
}

export interface TestAuthenticator {
  /** base64url, as it appears on the wire and in `response.id`. */
  readonly credentialId: string;
  /** The counter the authenticator will report on its *next* assertion. */
  signCount: number;
  register(challenge: string): Promise<RegistrationResponseJSON>;
  authenticate(
    challenge: string,
    overrides?: { readonly signCount?: number; readonly userVerified?: boolean },
  ): Promise<AuthenticationResponseJSON>;
  /** Sign an assertion with a *different* key, as a cloned-but-wrong device would. */
  authenticateWithForeignKey(challenge: string): Promise<AuthenticationResponseJSON>;
}

export async function createAuthenticator(
  options: AuthenticatorOptions,
): Promise<TestAuthenticator> {
  const rpIdHash = sha256(utf8(options.rpId));
  const aaguid = options.aaguid ?? new Uint8Array(16).fill(0);
  const backedUp = options.backedUp ?? false;
  const transports = options.transports ?? (['internal', 'hybrid'] as const);

  const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
    'verify',
  ]);
  const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  const cosePublicKey = isoCBOR.encode(
    new Map<string | number, number | Uint8Array>([
      [COSE_KTY, COSE_KTY_EC2],
      [COSE_ALG, COSE_ALG_ES256],
      [COSE_CRV, COSE_CRV_P256],
      [COSE_X, fromB64url(jwk.x ?? '')],
      [COSE_Y, fromB64url(jwk.y ?? '')],
    ]),
  );

  const credentialIdBytes = crypto.getRandomValues(new Uint8Array(32));
  const credentialId = b64url(credentialIdBytes);

  const state = { signCount: options.signCount ?? 0 };

  function flags(extra: number): number {
    return FLAG_UP | extra | (backedUp ? FLAG_BE | FLAG_BS : 0);
  }

  function authenticatorData(
    includeAttestedData: boolean,
    extraFlags: number,
  ): Uint8Array<ArrayBuffer> {
    const header = concat([
      rpIdHash,
      Uint8Array.of(flags(extraFlags) | (includeAttestedData ? FLAG_AT : 0)),
      uint32(state.signCount),
    ]);
    if (!includeAttestedData) return header;
    return concat([
      header,
      aaguid,
      uint16(credentialIdBytes.length),
      credentialIdBytes,
      cosePublicKey,
    ]);
  }

  async function sign(
    data: Uint8Array<ArrayBuffer>,
    key: CryptoKey = keyPair.privateKey,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const raw = new Uint8Array(
      await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, data),
    );
    return toDerSignature(raw);
  }

  async function assertion(
    challenge: string,
    key: CryptoKey,
    overrides: { signCount?: number | undefined; userVerified?: boolean | undefined } = {},
  ): Promise<AuthenticationResponseJSON> {
    if (overrides.signCount !== undefined) state.signCount = overrides.signCount;
    else if (options.signCount !== undefined) state.signCount += 1;

    const json = clientData('webauthn.get', challenge, options.origin);
    const authData = authenticatorData(false, overrides.userVerified === false ? 0 : FLAG_UV);
    const signature = await sign(concat([authData, sha256(json)]), key);

    return {
      id: credentialId,
      rawId: credentialId,
      type: 'public-key',
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
      response: {
        clientDataJSON: b64url(json),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        userHandle: b64url(utf8(options.userId)),
      },
    };
  }

  return {
    credentialId,

    get signCount(): number {
      return state.signCount;
    },
    set signCount(value: number) {
      state.signCount = value;
    },

    async register(challenge: string): Promise<RegistrationResponseJSON> {
      const json = clientData('webauthn.create', challenge, options.origin);
      const authData = authenticatorData(true, FLAG_UV);
      const attestationObject = isoCBOR.encode(
        new Map<string | number, unknown>([
          ['fmt', 'none'],
          ['attStmt', new Map<string | number, unknown>()],
          ['authData', authData],
        ]) as never,
      );

      return {
        id: credentialId,
        rawId: credentialId,
        type: 'public-key',
        clientExtensionResults: {},
        authenticatorAttachment: 'platform',
        response: {
          clientDataJSON: b64url(json),
          attestationObject: b64url(attestationObject),
          transports: [...transports],
        },
      };
    },

    async authenticate(challenge, overrides = {}) {
      return assertion(challenge, keyPair.privateKey, overrides);
    },

    async authenticateWithForeignKey(challenge) {
      const other = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
        'sign',
        'verify',
      ]);
      return assertion(challenge, other.privateKey);
    },
  };
}
