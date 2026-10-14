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
import { isSecretBoxError, type ColumnRef, type SecretBox } from '@core/secretbox';
import { and, eq } from 'drizzle-orm';
import {
  MARKET_DATA_KEY_PROVIDERS,
  providerCredentials,
  type MarketDataKeyProvider,
  type ProviderCredentialEnv,
  type ProviderCredentialProvider,
} from '../schema/index.ts';
import { platformOf, type ConnectionsContext, type ConnectionsExecutor } from './db.ts';
import { ProviderCredentialsChanged } from './events.ts';

const TABLE = 'provider_credentials';
const CLIENT_ID_COLUMN = 'client_id_sealed';
const SECRET_COLUMN = 'secret_sealed';

export type CredentialField = 'client_id' | 'secret';

/** The providers whose credentials are a client id, a secret and an environment: Plaid. */
export type PairCredentialProvider = Exclude<ProviderCredentialProvider, MarketDataKeyProvider>;

/**
 * A Plaid row always carries an environment (0043's `provider_credentials_env_by_provider`
 * CHECK). A row that does not is not a Plaid row this module wrote, and is refused by name.
 */
function pairEnvOf(env: ProviderCredentialEnv | null): ProviderCredentialEnv {
  if (env === null) throw new Error('provider_credentials: a client-id/secret row has no env');
  return env;
}

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
  readonly provider: PairCredentialProvider;
  readonly env: ProviderCredentialEnv;
  /** The last four characters of the client id. Display only. */
  readonly clientIdHint: string;
  readonly createdAt: Date;
  /** `null` until the first replacement. */
  readonly rotatedAt: Date | null;
}

export interface SetProviderCredentialsInput {
  readonly provider: PairCredentialProvider;
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
  const provider = input.provider;

  await appendEvent(
    platformOf(executor),
    ProviderCredentialsChanged.create(
      { provider: input.provider, change: rotated ? 'rotated' : 'set', env: input.env },
      { userId: context.userId, correlationId: context.correlationId, aggregateId: row.id },
      context.clock,
    ),
  );

  return { rotated, status: statusOf({ ...row, provider }) };
}

/** The non-secret view of a holder's stored credentials, or `null`. */
export async function getProviderCredentialStatus(
  executor: ConnectionsExecutor,
  userId: string,
  provider: PairCredentialProvider,
): Promise<ProviderCredentialStatus | null> {
  const [row] = await executor
    .select()
    .from(providerCredentials)
    .where(and(eq(providerCredentials.userId, userId), eq(providerCredentials.provider, provider)));
  return row === undefined ? null : statusOf({ ...row, provider });
}

/**
 * Two values behind closures and `#private` fields, so that serialising or
 * logging the object cannot print them. See the module comment.
 */
export class OpenedProviderCredentials {
  readonly provider: PairCredentialProvider;
  readonly env: ProviderCredentialEnv;
  readonly #clientId: string;
  readonly #secret: string;

  constructor(
    provider: PairCredentialProvider,
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
  provider: PairCredentialProvider,
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
  return new OpenedProviderCredentials(provider, pairEnvOf(row.env), clientId, secret);
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
  provider: PairCredentialProvider;
  env: ProviderCredentialEnv | null;
  clientIdHint: string;
  createdAt: Date;
  rotatedAt: Date | null;
}): ProviderCredentialStatus {
  return {
    provider: row.provider,
    env: pairEnvOf(row.env),
    clientIdHint: row.clientIdHint,
    createdAt: row.createdAt,
    rotatedAt: row.rotatedAt,
  };
}

// ---------------------------------------------------------------------------
// WP 10.4: a market-data provider's single API key
// ---------------------------------------------------------------------------
//
// The same row, the same AAD, the same DEK scope as Plaid's pair; one value
// instead of two. Migration 0043's header states the shape: `secret_sealed` is
// the key's envelope, `client_id_sealed` the envelope of a fixed sentinel (so
// every byte in both columns is still an envelope), `env` is NULL, and
// `client_id_hint` is the last four characters of a key that is at least
// `MARKET_DATA_KEY_MIN_LENGTH` long -- at most a quarter of it.

/** Sealed into `client_id_sealed` for a single-value key. Not a secret; never read back. */
export const MARKET_DATA_KEY_SENTINEL = 'single-value-key';

/** The shortest key the product will store; the hint is then at most a quarter of it. */
export const MARKET_DATA_KEY_MIN_LENGTH = 16;

/** Characters of a stored key ever shown, for recognition ("ends in 9f2c"). */
export const MARKET_DATA_KEY_HINT_LENGTH = 4;

export function isMarketDataKeyProvider(value: string): value is MarketDataKeyProvider {
  return (MARKET_DATA_KEY_PROVIDERS as readonly string[]).includes(value);
}

export interface MarketDataKeyStatus {
  readonly provider: MarketDataKeyProvider;
  /** The last four characters of the stored key. Display only. */
  readonly keyHint: string;
  readonly createdAt: Date;
  /** `null` until the first replacement. */
  readonly rotatedAt: Date | null;
}

/**
 * The hint for a key: its last four characters, and only for a key long enough
 * that four characters are at most a quarter of it. Throws for a shorter key:
 * the route refuses it first, and this is the second line.
 */
export function marketDataKeyHintOf(key: string): string {
  if (key.length < MARKET_DATA_KEY_MIN_LENGTH) {
    throw new RangeError(
      `a market-data key must be at least ${String(MARKET_DATA_KEY_MIN_LENGTH)} characters`,
    );
  }
  return key.slice(-MARKET_DATA_KEY_HINT_LENGTH);
}

/**
 * Seal and store a holder's key for one market-data provider, replacing any
 * they had, and announce it (`connections.ProviderCredentialsChanged`, env
 * null, never a value). Call inside a transaction.
 */
export async function setMarketDataKey(
  executor: ConnectionsExecutor,
  input: {
    readonly provider: MarketDataKeyProvider;
    readonly key: string;
    readonly secretBox: SecretBox;
  },
  context: ConnectionsContext,
): Promise<{ readonly rotated: boolean; readonly status: MarketDataKeyStatus }> {
  const now = context.clock.now();
  const keyHint = marketDataKeyHintOf(input.key);
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
    MARKET_DATA_KEY_SENTINEL,
  );
  const secretSealed = await input.secretBox.sealText(
    credentialRef(context.userId, input.provider, 'secret'),
    input.key,
  );

  const [row] = await executor
    .insert(providerCredentials)
    .values({
      id: newId(),
      userId: context.userId,
      provider: input.provider,
      clientIdSealed,
      secretSealed,
      env: null,
      clientIdHint: keyHint,
      createdAt: now,
      rotatedAt: null,
    })
    .onConflictDoUpdate({
      target: [providerCredentials.userId, providerCredentials.provider],
      set: { clientIdSealed, secretSealed, env: null, clientIdHint: keyHint, rotatedAt: now },
    })
    .returning();
  if (row === undefined) throw new Error('provider_credentials upsert returned no row');

  await appendEvent(
    platformOf(executor),
    ProviderCredentialsChanged.create(
      { provider: input.provider, change: rotated ? 'rotated' : 'set', env: null },
      { userId: context.userId, correlationId: context.correlationId, aggregateId: row.id },
      context.clock,
    ),
  );

  return {
    rotated,
    status: {
      provider: input.provider,
      keyHint: row.clientIdHint,
      createdAt: row.createdAt,
      rotatedAt: row.rotatedAt,
    },
  };
}

/** Every market-data key a holder has stored, as status only. One query. */
export async function listMarketDataKeyStatuses(
  executor: ConnectionsExecutor,
  userId: string,
): Promise<ReadonlyMap<MarketDataKeyProvider, MarketDataKeyStatus>> {
  const rows = await executor
    .select({
      provider: providerCredentials.provider,
      clientIdHint: providerCredentials.clientIdHint,
      createdAt: providerCredentials.createdAt,
      rotatedAt: providerCredentials.rotatedAt,
    })
    .from(providerCredentials)
    .where(eq(providerCredentials.userId, userId));
  const statuses = new Map<MarketDataKeyProvider, MarketDataKeyStatus>();
  for (const row of rows) {
    if (!isMarketDataKeyProvider(row.provider)) continue;
    statuses.set(row.provider, {
      provider: row.provider,
      keyHint: row.clientIdHint,
      createdAt: row.createdAt,
      rotatedAt: row.rotatedAt,
    });
  }
  return statuses;
}

/**
 * One opened key. The value sits in a `#private` field: `JSON.stringify` prints
 * the provider only, and a logged object prints no key.
 */
export class OpenedMarketDataKey {
  readonly provider: MarketDataKeyProvider;
  readonly #key: string;

  constructor(provider: MarketDataKeyProvider, key: string) {
    this.provider = provider;
    this.#key = key;
  }

  key(): string {
    return this.#key;
  }

  toJSON(): Record<string, unknown> {
    return { provider: this.provider };
  }
}

/**
 * Open every market-data key a holder stored. A row whose envelope will not
 * open (a locked box, a row moved between holders) is left out and named in
 * `unopenable`, so one bad row does not take the other three providers with
 * it; the caller says so by provider name and never echoes the cause. Any
 * other failure (the database) propagates.
 */
export async function openMarketDataKeys(
  executor: ConnectionsExecutor,
  secretBox: SecretBox,
  userId: string,
): Promise<{
  readonly keys: ReadonlyMap<MarketDataKeyProvider, OpenedMarketDataKey>;
  readonly unopenable: readonly MarketDataKeyProvider[];
}> {
  const rows = await executor
    .select({
      provider: providerCredentials.provider,
      secretSealed: providerCredentials.secretSealed,
    })
    .from(providerCredentials)
    .where(eq(providerCredentials.userId, userId));
  const keys = new Map<MarketDataKeyProvider, OpenedMarketDataKey>();
  const unopenable: MarketDataKeyProvider[] = [];
  for (const row of rows) {
    const provider = row.provider;
    if (!isMarketDataKeyProvider(provider)) continue;
    try {
      const key = await secretBox.openText(
        credentialRef(userId, provider, 'secret'),
        row.secretSealed,
      );
      keys.set(provider, new OpenedMarketDataKey(provider, key));
    } catch (error) {
      if (!isSecretBoxError(error)) throw error;
      unopenable.push(provider);
    }
  }
  return { keys, unopenable };
}
