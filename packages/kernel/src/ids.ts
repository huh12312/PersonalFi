// SPDX-License-Identifier: MIT
import { v7 as uuidv7, validate as uuidValidate, version as uuidVersion } from 'uuid';
import type { Brand } from './brand.ts';
import { InvalidValueError } from './errors.ts';

/** A UUIDv7 primary key, branded by the entity it identifies. */
export type Id<TTag extends string> = Brand<string, TTag>;

/**
 * Generate a fresh UUIDv7.
 *
 * Application-side, never `gen_random_uuid()`: v7 is time-ordered, so inserts stay
 * at the right edge of the b-tree, and the id is known before the INSERT, which is
 * what lets an aggregate and its outbox event share one transaction.
 */
export function newId<TTag extends string = string>(): Id<TTag> {
  return uuidv7() as Id<TTag>;
}

export function isUuid(value: string): boolean {
  return uuidValidate(value);
}

export function isUuidV7(value: string): boolean {
  return uuidValidate(value) && uuidVersion(value) === 7;
}

/** Validate and brand an id received from outside (a request, a file, a column). */
export function parseId<TTag extends string>(what: string, value: string): Id<TTag> {
  if (!uuidValidate(value)) {
    throw new InvalidValueError(`${what} id`, `expected a UUID, got ${JSON.stringify(value)}`);
  }
  return value as Id<TTag>;
}

/** The timestamp embedded in a UUIDv7, as milliseconds since the epoch. */
export function timestampOfUuidV7(value: string): number {
  if (!isUuidV7(value)) {
    throw new InvalidValueError('uuidv7', `not a version 7 UUID: ${JSON.stringify(value)}`);
  }
  return Number(BigInt(`0x${value.replaceAll('-', '').slice(0, 12)}`));
}

// Ids for concepts every context must be able to name. A context's own private
// ids belong in that context, not here.
export type UserId = Id<'UserId'>;
export type AccountId = Id<'AccountId'>;
export type TransactionId = Id<'TransactionId'>;
export type ConnectionId = Id<'ConnectionId'>;
export type CategoryId = Id<'CategoryId'>;
export type SecurityId = Id<'SecurityId'>;
export type InsightId = Id<'InsightId'>;
export type EventId = Id<'EventId'>;
