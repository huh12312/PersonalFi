// SPDX-License-Identifier: MIT
/**
 * The connector error taxonomy (08 §2.4).
 *
 * **One error type, one discriminant, and the orchestrator — not the adapter —
 * decides policy.** That sentence is the whole design. An adapter's only job is
 * to classify what the provider did; what to do about it (retry, back off, mark
 * the connection, tell the user) is decided once, in `retryPolicyFor`, so
 * per-provider retry logic cannot metastasize across twelve adapters.
 *
 * ## Two vocabularies, deliberately
 *
 * 08 §2.4 lists twelve provider conditions. The master plan's §3.3 seam and this
 * work package's brief specify six *kinds*. Both are here and they are not
 * redundant:
 *
 *   * **`kind`** — six values, the discriminant the orchestrator branches on.
 *     Small enough that every branch is visibly handled and a new provider
 *     cannot invent a thirteenth policy.
 *   * **`condition`** — the finer provider-facing name, optional, carried for the
 *     sync-run detail UI and for the log line. It never changes behaviour.
 *
 * The mapping is `KIND_OF_CONDITION` below and it is asserted by a unit test, so
 * "which kind does `CURSOR_EXPIRED` get?" has exactly one answer.
 *
 * ## What is deliberately *not* here
 *
 * A `ConnectorError` never escapes the Connections context unwrapped (08 §6.4).
 * It becomes a connection *status* plus an event. Nothing in this file knows
 * about HTTP, problem details, or Fastify.
 */

/** The six kinds the orchestrator branches on. */
export const CONNECTOR_ERROR_KINDS = [
  /** Credentials, consent or an interactive challenge. Only the user can fix it. */
  'auth_required',
  /** 429, or a provider budget we have exhausted. Honour `retryAfterMs`. */
  'rate_limited',
  /** 5xx, an institution outage, a provider-side lock. Back off and come back. */
  'provider_unavailable',
  /** We sent something wrong: a bad file, a malformed handle, misconfigured keys. */
  'invalid_input',
  /** True for this connection until something changes. Retrying cannot help. */
  'permanent',
  /** Might work next time. The default for anything unrecognised but recoverable. */
  'transient',
] as const;

export type ConnectorErrorKind = (typeof CONNECTOR_ERROR_KINDS)[number];

/** The twelve provider conditions of 08 §2.4, kept for the sync-run detail UI. */
export const CONNECTOR_CONDITIONS = [
  'AUTH_REQUIRED',
  'MFA_REQUIRED',
  'CONSENT_EXPIRED',
  'PROVIDER_DOWN',
  'RATE_LIMITED',
  'ITEM_LOCKED',
  'INSUFFICIENT_SCOPE',
  'DATA_UNAVAILABLE',
  'CURSOR_EXPIRED',
  'MUTATION_DURING_PAGINATION',
  'MALFORMED_RESPONSE',
  'CONFIG_ERROR',
  'INTERNAL',
] as const;

export type ConnectorCondition = (typeof CONNECTOR_CONDITIONS)[number];

/**
 * Condition → kind. The one place the twelve collapse into the six.
 *
 * `MUTATION_DURING_PAGINATION` is 08's table plus one: 01 §5.1 describes Plaid's
 * `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` as a distinct recovery (restart
 * the loop from the page-1 cursor) and there was no condition for it.
 */
export const KIND_OF_CONDITION: Readonly<Record<ConnectorCondition, ConnectorErrorKind>> =
  Object.freeze({
    AUTH_REQUIRED: 'auth_required',
    MFA_REQUIRED: 'auth_required',
    CONSENT_EXPIRED: 'auth_required',
    PROVIDER_DOWN: 'provider_unavailable',
    ITEM_LOCKED: 'provider_unavailable',
    RATE_LIMITED: 'rate_limited',
    // "Disable that dataset for this connection, keep others" / "clear the
    // capability permanently": both are permanent until the user reconnects with
    // wider scope, and neither is worth a retry.
    INSUFFICIENT_SCOPE: 'permanent',
    DATA_UNAVAILABLE: 'permanent',
    // Recoverable, but only by resetting the cursor — see `restart` below.
    CURSOR_EXPIRED: 'transient',
    MUTATION_DURING_PAGINATION: 'transient',
    // The provider broke its own contract. Retrying the same call reproduces it;
    // the run fails and the payload is kept for forensics.
    MALFORMED_RESPONSE: 'permanent',
    CONFIG_ERROR: 'invalid_input',
    INTERNAL: 'permanent',
  });

/**
 * What the orchestrator must do with the cursor before it tries again.
 *
 * This is the cursor contract's rules 2 and 4 (08 §2.3) made into data rather
 * than into an `if` in the sync loop.
 */
export const RESTART_MODES = [
  /** Carry on from the cursor the last committed page produced. The normal case. */
  'resume',
  /**
   * Discard the in-flight page sequence and restart from the cursor this run
   * began with. 01 §5.1: "the entire pagination request loop must be restarted
   * beginning with the cursor for the first page". Retrying the single failed
   * call corrupts the stream.
   */
  'page_one',
  /**
   * Restart from `null`: a full re-pull, healed by idempotent upsert. Never by
   * deleting data (08 §2.3 rule 4).
   */
  'from_null',
] as const;

export type RestartMode = (typeof RESTART_MODES)[number];

/** The orchestrator's policy for one error, as data. */
export interface RetryPolicy {
  readonly retryable: boolean;
  /** Honour the provider's own figure when it gave one; otherwise back off. */
  readonly retryAfterMs: number | null;
  readonly restart: RestartMode;
  /** The connection cannot heal itself: show a banner, stop the schedule. */
  readonly userActionRequired: boolean;
}

export interface ConnectorErrorOptions {
  readonly kind: ConnectorErrorKind;
  readonly condition?: ConnectorCondition;
  /** The provider's own code, verbatim, for the sync-run detail view. */
  readonly providerCode?: string;
  readonly retryAfterMs?: number;
  readonly restart?: RestartMode;
  /**
   * Anything useful for debugging that is **not** a token, a credential, an
   * account number or a name. The orchestrator writes this straight into
   * `sync_runs.last_error`, which the UI renders.
   */
  readonly redactedContext?: Record<string, unknown>;
  readonly cause?: unknown;
}

export class ConnectorError extends Error {
  override readonly name = 'ConnectorError';
  readonly kind: ConnectorErrorKind;
  readonly condition: ConnectorCondition | null;
  readonly providerCode: string | null;
  readonly retryAfterMs: number | null;
  readonly restart: RestartMode;
  readonly redactedContext: Record<string, unknown> | null;

  constructor(message: string, options: ConnectorErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.kind = options.kind;
    this.condition = options.condition ?? null;
    this.providerCode = options.providerCode ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.restart = options.restart ?? defaultRestartFor(options.condition ?? null);
    this.redactedContext = options.redactedContext ?? null;
  }

  /** Build from the finer provider condition; the kind follows from the table. */
  static fromCondition(
    condition: ConnectorCondition,
    message: string,
    options: Omit<ConnectorErrorOptions, 'kind' | 'condition'> = {},
  ): ConnectorError {
    return new ConnectorError(message, { ...options, kind: KIND_OF_CONDITION[condition], condition });
  }

  /** The policy the orchestrator applies. Pure, and therefore unit-testable. */
  policy(): RetryPolicy {
    return retryPolicyFor(this);
  }
}

export function isConnectorError(value: unknown): value is ConnectorError {
  return value instanceof ConnectorError;
}

function defaultRestartFor(condition: ConnectorCondition | null): RestartMode {
  if (condition === 'MUTATION_DURING_PAGINATION') return 'page_one';
  if (condition === 'CURSOR_EXPIRED') return 'from_null';
  return 'resume';
}

/**
 * The policy table of 08 §2.4, as one pure function.
 *
 * Note what it does *not* decide: how long to wait. That is
 * `@core/platform`'s `backoffDelayMs` with full jitter and a six-hour cap, and
 * keeping the two apart is why `retryAfterMs` here means "the provider told us"
 * rather than "we guessed".
 */
export function retryPolicyFor(error: ConnectorError): RetryPolicy {
  const base = { retryAfterMs: error.retryAfterMs, restart: error.restart };
  switch (error.kind) {
    case 'auth_required':
      // Stop retrying. Every further call is guaranteed to fail and burns the
      // rate limit that the *reconnect* will need (04 §4.5).
      return { ...base, retryable: false, userActionRequired: true };
    case 'rate_limited':
      return { ...base, retryable: true, userActionRequired: false };
    case 'provider_unavailable':
      return { ...base, retryable: true, userActionRequired: false };
    case 'transient':
      return { ...base, retryable: true, userActionRequired: false };
    case 'invalid_input':
      // Our bad file, or our bad keys. Retrying the identical input is a loop.
      return { ...base, retryable: false, userActionRequired: true };
    case 'permanent':
      return { ...base, retryable: false, userActionRequired: true };
  }
}

/**
 * Wrap anything an adapter threw that was not already a `ConnectorError`.
 *
 * Fail closed: an unrecognised exception is *ours*, so it is `permanent` and
 * loud rather than `transient` and silently retried forever.
 */
export function asConnectorError(value: unknown): ConnectorError {
  if (isConnectorError(value)) return value;
  const message = value instanceof Error ? value.message : String(value);
  return ConnectorError.fromCondition('INTERNAL', message, { cause: value });
}
