// SPDX-License-Identifier: MIT
/**
 * The envelope and the AAD, tested as pure functions.
 *
 * These need no database and no key, which is exactly why they are worth testing
 * separately: the AAD is the control that makes a stolen ciphertext non-portable
 * (03 §2.1), and an off-by-one in the header layout or an ambiguous separator
 * would still let every round-trip test pass.
 */
import { describe, expect, it } from 'vitest';
import {
  AAD_NAMESPACE,
  buildAad,
  bytesToUuid,
  decodeEnvelope,
  describeAad,
  encodeEnvelope,
  ENVELOPE_VERSION,
  HEADER_BYTES,
  KEY_ID_BYTES,
  uuidToBytes,
  type ColumnRef,
} from './envelope.ts';
import { isSecretBoxError } from './errors.ts';
import { NONCE_BYTES, TAG_BYTES } from './primitives.ts';

const KEY_ID = '0192f3c1-4d5e-7a8b-9c0d-1e2f3a4b5c6d';
const REF: ColumnRef = {
  table: 'plaid_items',
  column: 'access_token',
  rowId: '0192f3c1-0000-7000-8000-000000000001',
};

function nonce(fill = 9): Uint8Array {
  return new Uint8Array(NONCE_BYTES).fill(fill);
}

describe('uuid <-> bytes', () => {
  it('round-trips a UUID through its sixteen raw bytes', () => {
    const bytes = uuidToBytes(KEY_ID);
    expect(bytes).toHaveLength(KEY_ID_BYTES);
    expect(bytesToUuid(bytes)).toBe(KEY_ID);
  });

  it('is case-insensitive on input and lower-case on output', () => {
    expect(bytesToUuid(uuidToBytes(KEY_ID.toUpperCase()))).toBe(KEY_ID);
  });

  it('refuses anything that is not a UUID', () => {
    for (const bad of ['', 'not-a-uuid', KEY_ID.slice(0, -1), `${KEY_ID}0`]) {
      expect(() => uuidToBytes(bad)).toThrowError(/not a UUID/);
    }
  });

  it('refuses a key id that is not sixteen bytes', () => {
    expect(() => bytesToUuid(new Uint8Array(15))).toThrowError(/not 16 bytes/);
  });
});

describe('envelope encoding', () => {
  it('lays out version(1) || key_id(16) || nonce(24) || ciphertext', () => {
    const ciphertext = new Uint8Array([1, 2, 3, 4]);
    const encoded = encodeEnvelope({
      version: ENVELOPE_VERSION,
      keyId: KEY_ID,
      nonce: nonce(),
      ciphertext,
    });

    expect(HEADER_BYTES).toBe(41);
    expect(encoded).toHaveLength(HEADER_BYTES + ciphertext.length);
    expect(encoded[0]).toBe(ENVELOPE_VERSION);
    expect(bytesToUuid(encoded.subarray(1, 1 + KEY_ID_BYTES))).toBe(KEY_ID);
    expect([...encoded.subarray(HEADER_BYTES)]).toEqual([1, 2, 3, 4]);
  });

  it('round-trips through decode', () => {
    // Long enough to clear the "shorter than header and tag" guard.
    const ciphertext = new Uint8Array(TAG_BYTES + 8).fill(7);
    const decoded = decodeEnvelope(
      encodeEnvelope({ version: ENVELOPE_VERSION, keyId: KEY_ID, nonce: nonce(3), ciphertext }),
    );
    expect(decoded.version).toBe(ENVELOPE_VERSION);
    expect(decoded.keyId).toBe(KEY_ID);
    expect([...decoded.nonce]).toEqual([...nonce(3)]);
    expect([...decoded.ciphertext]).toEqual([...ciphertext]);
  });

  it('refuses a nonce that is not 24 bytes', () => {
    expect(() =>
      encodeEnvelope({
        version: ENVELOPE_VERSION,
        keyId: KEY_ID,
        nonce: new Uint8Array(12),
        ciphertext: new Uint8Array(TAG_BYTES),
      }),
    ).toThrowError(/nonce must be 24 bytes/);
  });

  it('refuses an envelope too short to hold a header and a tag', () => {
    // A truncated buffer must be rejected by the parser rather than handed to the
    // AEAD, which would report a tag failure and hide the real problem.
    for (const length of [0, HEADER_BYTES, HEADER_BYTES + TAG_BYTES - 1]) {
      expect(() => decodeEnvelope(new Uint8Array(length))).toThrowError(/shorter than/);
    }
  });

  it('refuses an unsupported envelope version', () => {
    const encoded = encodeEnvelope({
      version: ENVELOPE_VERSION,
      keyId: KEY_ID,
      nonce: nonce(),
      ciphertext: new Uint8Array(TAG_BYTES),
    });
    encoded[0] = 2;
    expect(() => decodeEnvelope(encoded)).toThrowError(/unsupported envelope version 2/);
  });

  it('reports every failure as a SecretBoxError', () => {
    try {
      decodeEnvelope(new Uint8Array(4));
      expect.unreachable('decodeEnvelope should have thrown');
    } catch (error) {
      expect(isSecretBoxError(error)).toBe(true);
    }
  });
});

describe('the AAD', () => {
  it('binds namespace, table, column, row and key version', () => {
    expect(describeAad(REF, 1)).toBe(`${AAD_NAMESPACE}|plaid_items|access_token|${REF.rowId}|1`);
  });

  it('is byte-identical for identical inputs', () => {
    expect([...buildAad(REF, 3)]).toEqual([...buildAad({ ...REF }, 3)]);
  });

  it('changes when any component changes — this is what makes a ciphertext non-portable', () => {
    const base = describeAad(REF, 1);
    const variants = [
      describeAad({ ...REF, table: 'llm_credentials' }, 1),
      describeAad({ ...REF, column: 'api_key' }, 1),
      describeAad({ ...REF, rowId: '0192f3c1-0000-7000-8000-000000000002' }, 1),
      describeAad(REF, 2),
    ];
    for (const variant of variants) expect(variant).not.toBe(base);
    // And they are all distinct from each other, not merely from the base.
    expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
  });

  it('refuses a component containing the separator, so the encoding stays unambiguous', () => {
    // Without this, `{table: 'a|b', column: 'c'}` and `{table: 'a', column: 'b|c'}`
    // would produce the same AAD and a ciphertext could be moved between them.
    expect(() => buildAad({ ...REF, table: 'a|b' }, 1)).toThrowError(/separator/);
    expect(() => buildAad({ ...REF, column: 'a|b' }, 1)).toThrowError(/separator/);
    expect(() => buildAad({ ...REF, rowId: 'a|b' }, 1)).toThrowError(/separator/);
  });

  it('refuses an empty component', () => {
    expect(() => buildAad({ ...REF, table: '' }, 1)).toThrowError(/non-empty/);
  });

  it('refuses a key version that is not a positive integer', () => {
    for (const version of [0, -1, 1.5, Number.NaN]) {
      expect(() => buildAad(REF, version)).toThrowError(/positive integer/);
    }
  });
});
