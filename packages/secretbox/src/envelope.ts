// SPDX-License-Identifier: MIT
/**
 * The storage envelope (03 §2.1), and the AAD that binds it to its row.
 *
 *     version(1) || key_id(16) || nonce(24) || ciphertext+tag
 *
 * Self-describing on purpose. A `BYTEA` that says which key and which nonce made
 * it is a column that can be rotated, migrated and audited years later; a bare
 * ciphertext beside a `key_version INTEGER` in a sibling column is a column that
 * loses its meaning the first time someone writes a row by hand.
 *
 * `key_id` is the UUIDv7 primary key of the `encryption_keys` row, stored as its
 * 16 raw bytes rather than 36 characters of text.
 */
import { SecretBoxError } from './errors.ts';
import { NONCE_BYTES, TAG_BYTES } from './primitives.ts';

/** Envelope format version. Bump only for a change the parser must branch on. */
export const ENVELOPE_VERSION = 1;

export const KEY_ID_BYTES = 16;
export const HEADER_BYTES = 1 + KEY_ID_BYTES + NONCE_BYTES; // 41

/** The AAD namespace. Changing it invalidates every ciphertext; it never changes. */
export const AAD_NAMESPACE = 'personalfi/v1';

export interface Envelope {
  readonly version: number;
  /** Canonical UUID string of the `encryption_keys` row. */
  readonly keyId: string;
  readonly nonce: Uint8Array;
  /** Ciphertext with the Poly1305 tag appended. */
  readonly ciphertext: Uint8Array;
}

/** A column reference. Every seal and every open names exactly where it lives. */
export interface ColumnRef {
  /** Physical table name, e.g. `plaid_items`. */
  readonly table: string;
  /** Physical column name, e.g. `access_token`. */
  readonly column: string;
  /** The row's UUID primary key. */
  readonly rowId: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuidToBytes(uuid: string): Uint8Array {
  if (!UUID_PATTERN.test(uuid)) {
    throw new SecretBoxError('envelope_malformed', 'key id is not a UUID');
  }
  const hex = uuid.replaceAll('-', '');
  const bytes = new Uint8Array(KEY_ID_BYTES);
  for (let i = 0; i < KEY_ID_BYTES; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToUuid(bytes: Uint8Array): string {
  if (bytes.length !== KEY_ID_BYTES) {
    throw new SecretBoxError('envelope_malformed', 'key id is not 16 bytes');
  }
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The mandatory additional authenticated data.
 *
 *     "personalfi/v1|" || table || "|" || column || "|" || row_uuid || "|" || key_version
 *
 * This is what makes a stolen ciphertext non-portable: lifting the bytes from
 * `plaid_items.access_token` row A into row B, or into `llm_credentials.api_key`,
 * changes the AAD and the tag no longer verifies. `key_version` is included so a
 * ciphertext cannot be replayed against a different generation of the same key.
 *
 * The separator is `|`, and the components are validated to exclude it, so the
 * encoding is unambiguous — `a|b` and `a` + `|b` must not produce the same AAD.
 */
export function buildAad(ref: ColumnRef, keyVersion: number): Uint8Array {
  assertAadComponent(ref.table, 'table');
  assertAadComponent(ref.column, 'column');
  assertAadComponent(ref.rowId, 'rowId');
  if (!Number.isInteger(keyVersion) || keyVersion < 1) {
    throw new SecretBoxError('envelope_malformed', 'key version must be a positive integer');
  }
  const text = `${AAD_NAMESPACE}|${ref.table}|${ref.column}|${ref.rowId}|${keyVersion}`;
  return new TextEncoder().encode(text);
}

/** Readable form of the AAD, for tests and for the evidence document. */
export function describeAad(ref: ColumnRef, keyVersion: number): string {
  return new TextDecoder().decode(buildAad(ref, keyVersion));
}

function assertAadComponent(value: string, field: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SecretBoxError('envelope_malformed', `${field} must be a non-empty string`);
  }
  if (value.includes('|')) {
    throw new SecretBoxError('envelope_malformed', `${field} must not contain the AAD separator`);
  }
}

export function encodeEnvelope(envelope: Envelope): Uint8Array {
  if (envelope.nonce.length !== NONCE_BYTES) {
    throw new SecretBoxError('envelope_malformed', 'nonce must be 24 bytes');
  }
  const keyId = uuidToBytes(envelope.keyId);
  const out = new Uint8Array(HEADER_BYTES + envelope.ciphertext.length);
  out[0] = envelope.version;
  out.set(keyId, 1);
  out.set(envelope.nonce, 1 + KEY_ID_BYTES);
  out.set(envelope.ciphertext, HEADER_BYTES);
  return out;
}

export function decodeEnvelope(bytes: Uint8Array): Envelope {
  // A ciphertext shorter than the tag cannot be authentic, so refuse it here
  // rather than handing a truncated buffer to the AEAD.
  if (bytes.length < HEADER_BYTES + TAG_BYTES) {
    throw new SecretBoxError('envelope_malformed', 'envelope is shorter than its header and tag');
  }
  const version = bytes[0];
  if (version !== ENVELOPE_VERSION) {
    throw new SecretBoxError('envelope_malformed', `unsupported envelope version ${String(version)}`);
  }
  return {
    version,
    keyId: bytesToUuid(bytes.subarray(1, 1 + KEY_ID_BYTES)),
    nonce: bytes.subarray(1 + KEY_ID_BYTES, HEADER_BYTES),
    ciphertext: bytes.subarray(HEADER_BYTES),
  };
}
