// SPDX-License-Identifier: MIT
/**
 * The narrow database surface this context needs.
 *
 * `pg.Pool`, `pg.PoolClient` and a test fake all satisfy it, so the services below
 * can be run inside a transaction by handing them a client instead of a pool —
 * which is how the bootstrap path creates a user and its keyring atomically.
 */
export interface IdentityQueryable {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * Read a `bytea` column.
 *
 * `Uint8Array.from` copies rather than wrapping. That is deliberate twice over:
 * `node-postgres` hands back a `Buffer`, which is allocated out of a shared pool,
 * so a view onto it can outlive the assumption that nothing else sees those bytes;
 * and the copy is a plain `Uint8Array<ArrayBuffer>`, which is what the crypto
 * primitives are typed against.
 */
export function asBytes(value: unknown): Uint8Array<ArrayBuffer> {
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  throw new TypeError('expected a bytea column to arrive as a buffer');
}

export function asDate(value: unknown): Date {
  if (value instanceof Date) return value;
  throw new TypeError('expected a timestamptz column to arrive as a Date');
}

export function asOptionalDate(value: unknown): Date | null {
  return value === null || value === undefined ? null : asDate(value);
}

/** Postgres wants a `Buffer`; the rest of the code speaks `Uint8Array`. */
export function toParam(value: Uint8Array): Buffer {
  return Buffer.from(value);
}
