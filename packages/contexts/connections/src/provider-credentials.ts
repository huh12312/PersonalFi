// SPDX-License-Identifier: MIT
/**
 * A holder's provider API credentials, stored by the product (WP 10.1).
 *
 * Until now the Plaid connector registered only when the operator wrote three
 * secret files. This module is the other way in: the holder pastes their own
 * Plaid client id and secret into the "Add connection" menu, and they are kept
 * here, sealed, tied to the install.
 *
 * ## Custody
 *
 * The same tier as a Plaid access token (03 §2.2, D5): each of the two values is
 * a `SecretBox` envelope under a per-record DEK wrapped by the KEK. The AAD
 * binds a ciphertext to
 *
 *     provider_credentials | <column> | <user_id>.<provider>
 *
 * so it opens only for that holder, only for that provider, and only as the
 * field it was sealed as: the `client_id_sealed` bytes pasted into
 * `secret_sealed`, or into another holder's row, or into
 * `connections.sealed_credentials`, do not authenticate. The record scope is
 * `provider_credentials:<user_id>.<provider>`, so removing the credentials can
 * retire the DEK (`eraseCredentialKey`) and make a backup copy unreadable too.
 *
 * ## What leaves this module
 *
 * - `getProviderCredentialStatus` — env, the four-character hint, dates. Never
 *   a value.
 * - `openProviderCredentials` — an `OpenedProviderCredentials`, whose two values
 *   sit in `#private` fields: `JSON.stringify` of it is `{}` and a logged object
 *   prints no field. A caller asks for a value with `.clientId()` / `.secret()`
 *   at the one place that needs the bytes (building the client) and drops it.
 *
 * Every function takes the caller's executor so a write commits with the event
 * that announces it (08 §3.2: the outbox is the same transaction).
 */
import { newId } from '@core/kernel';
import { appendEvent } from '@core/platform';
import type { ColumnRef, SecretBox } from '@core/secretbox';
import { and, eq } from 'drizzle-orm';
import {
  providerCredentials,
  type ProviderCredentialEnv,
  type ProviderCredentialProvider,
} from '../schema/index.ts';
import { platformOf, type ConnectionsContext, type ConnectionsExecutor } from './db.ts';
import { ProviderCredentialsChanged } from './events.ts';

const TABLE = 'provider_credentials';
const CLIENT_ID_COLUMN = 'client_id_sealed';
const SECRET_COLUMN = 'secret_sealed';

export type CredentialField = 'client_id' | 'secret';

/**
 * Where a field's ciphertext lives, for `SecretBox`. Exported so a test (and the
 * evidence) can describe the AAD without re-deriving it.
 */
export function credentialRef(
  userId: string,
  provider: ProviderCredentialProvider,
  field: CredentialField,
): ColumnRef {
  return {
    table: TABLE,
    column: field === 'client_id' ? CLIENT_ID_COLUMN : SECRET_COLUMN,
    rowId: `${userId}.${provider}`,
  };
}

export interface ProviderCredentialStatus {
  readonly provider: ProviderCredentialProvider;
  readonly env: ProviderCredentialEnv;
  /** The last four characters of the client id. Display only. */
  readonly clientIdHint: string;
  readonly createdAt: Date;
  /** `null` until the first replacement. */
  readonly rotatedAt: Date | null;
}

export interface SetProviderCredentialsInput {
  readonly provider: ProviderCredentialProvider;
  readonly clientId: string;
  readonly secret: string;
  readonly env: ProviderCredentialEnv;
  readonly secretBox: SecretBox;
}

export interface SetProviderCredentialsResult {
  /** True when a row already existed and was replaced. */
  readonly rotated: boolean;
  readonly status: ProviderCredentialStatus;
}

/**
 * Seal and store a holder's credentials, replacing any they already had, and
 * announce it. Call inside a transaction.
 */
export async function setProviderCredentials(
  executor: ConnectionsExecutor,
  input: SetProviderCredentialsInput,
  context: ConnectionsContext,
): Promise<SetProviderCredentialsResult> {
  const now = context.clock.now();
  const [existing] = await executor
    .select({ id: providerCredentials.id })
    .from(providerCredentials)
    .where(
      and(
        eq(providerCredentials.userId, context.userId),
        eq(providerCredentials.provider, input.provider),
      ),
    );
  const rotated = existing !== undefined;

  const clientIdSealed = await input.secretBox.sealText(
    credentialRef(context.userId, input.provider, 'client_id'),
    input.clientId,
  );
  const secretSealed = await input.secretBox.sealText(
    credentialRef(context.userId, input.provider, 'secret'),
    input.secret,
  );
  const clientIdHint = input.clientId.slice(-4);

  const [row] = await executor
    .insert(providerCredentials)
    .values({
      id: newId(),
      userId: context.userId,
      provider: input.provider,
      clientIdSealed,
      secretSealed,
      env: input.env,
      clientIdHint,
      createdAt: now,
      rotatedAt: null,
    })
    .onConflictDoUpdate({
      target: [providerCredentials.userId, providerCredentials.provider],
      set: { clientIdSealed, secretSealed, env: input.env, clientIdHint, rotatedAt: now },
    })
    .returning();
  if (row === undefined) throw new Error('provider_credentials upsert returned no row');

  await appendEvent(
    platformOf(executor),
    ProviderCredentialsChanged.create(
      { provider: input.provider, change: rotated ? 'rotated' : 'set', env: input.env },
      { userId: context.userId, correlationId: context.correlationId, aggregateId: row.id },
      context.clock,
    ),
  );

  return { rotated, status: statusOf(row) };
}

/** The non-secret view of a holder's stored credentials, or `null`. */
export async function getProviderCredentialStatus(
  executor: ConnectionsExecutor,
  userId: string,
  provider: ProviderCredentialProvider,
): Promise<ProviderCredentialStatus | null> {
  const [row] = await executor
    .select()
    .from(providerCredentials)
    .where(and(eq(providerCredentials.userId, userId), eq(providerCredentials.provider, provider)));
  return row === undefined ? null : statusOf(row);
}

/**
 * Two values behind closures and `#private` fields, so that serialising or
 * logging the object cannot print them. See the module comment.
 */
export class OpenedProviderCredentials {
  readonly provider: ProviderCredentialProvider;
  readonly env: ProviderCredentialEnv;
  readonly #clientId: string;
  readonly #secret: string;

  constructor(
    provider: ProviderCredentialProvider,
    env: ProviderCredentialEnv,
    clientId: string,
    secret: string,
  ) {
    this.provider = provider;
    this.env = env;
    this.#clientId = clientId;
    this.#secret = secret;
  }

  clientId(): string {
    return this.#clientId;
  }

  secret(): string {
    return this.#secret;
  }

  toJSON(): Record<string, unknown> {
    return { provider: this.provider, env: this.env };
  }
}

/**
 * Open a holder's stored credentials. `null` when there are none. Throws
 * `SecretBoxError` when the box is locked or a ciphertext does not authenticate
 * (a row moved between holders, a column swapped): the caller treats that as
 * "no usable credentials" and must not echo the error's cause.
 */
export async function openProviderCredentials(
  executor: ConnectionsExecutor,
  secretBox: SecretBox,
  userId: string,
  provider: ProviderCredentialProvider,
): Promise<OpenedProviderCredentials | null> {
  const [row] = await executor
    .select()
    .from(providerCredentials)
    .where(and(eq(providerCredentials.userId, userId), eq(providerCredentials.provider, provider)));
  if (row === undefined) return null;
  const clientId = await secretBox.openText(
    credentialRef(userId, provider, 'client_id'),
    row.clientIdSealed,
  );
  const secret = await secretBox.openText(
    credentialRef(userId, provider, 'secret'),
    row.secretSealed,
  );
  return new OpenedProviderCredentials(provider, row.env, clientId, secret);
}

/**
 * Remove a holder's stored credentials and announce it. Returns whether a row
 * existed. Revokes nothing at the provider: the key stays valid at Plaid until
 * the holder rolls it in the Plaid dashboard.
 *
 * Call inside a transaction, then — after it commits — `eraseCredentialKey`.
 * The key is retired *after* because retiring it is not transactional: a
 * rolled-back delete with a retired DEK would leave a row nobody can open.
 */
export async function removeProviderCredentials(
  executor: ConnectionsExecutor,
  input: { readonly provider: ProviderCredentialProvider },
  context: ConnectionsContext,
): Promise<boolean> {
  const removed = await executor
    .delete(providerCredentials)
    .where(
      and(
        eq(providerCredentials.userId, context.userId),
        eq(providerCredentials.provider, input.provider),
      ),
    )
    .returning({ id: providerCredentials.id, env: providerCredentials.env });
  const [row] = removed;
  if (row === undefined) return false;
  await appendEvent(
    platformOf(executor),
    ProviderCredentialsChanged.create(
      { provider: input.provider, change: 'removed', env: null },
      { userId: context.userId, correlationId: context.correlationId, aggregateId: row.id },
      context.clock,
    ),
  );
  return true;
}

/**
 * Retire the record's DEK: cryptographic erasure, so the removed ciphertext is
 * unreadable even in a backup taken earlier. Best-effort by the caller.
 */
export async function eraseCredentialKey(
  secretBox: SecretBox,
  userId: string,
  provider: ProviderCredentialProvider,
): Promise<boolean> {
  return secretBox.destroyRecordKey(TABLE, `${userId}.${provider}`);
}

function statusOf(row: {
  provider: ProviderCredentialProvider;
  env: ProviderCredentialEnv;
  clientIdHint: string;
  createdAt: Date;
  rotatedAt: Date | null;
}): ProviderCredentialStatus {
  return {
    provider: row.provider,
    env: row.env,
    clientIdHint: row.clientIdHint,
    createdAt: row.createdAt,
    rotatedAt: row.rotatedAt,
  };
}
