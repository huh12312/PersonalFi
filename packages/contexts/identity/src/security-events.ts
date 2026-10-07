// SPDX-License-Identifier: MIT
/**
 * The security audit trail (P1-10).
 *
 * One writer. Every auth attempt, lockout, credential change, step-up and session
 * revocation goes through `recordSecurityEvent`, so "is this audited?" is answered
 * by reading one function rather than by grepping for INSERTs.
 */
import { newId, type Clock } from '@core/kernel';
import { sha256 } from '@core/secretbox';
import { toParam, type IdentityQueryable } from './db.ts';

export type SecurityEventKind =
  | 'auth.webauthn.success'
  | 'auth.webauthn.failure'
  | 'auth.totp.success'
  | 'auth.totp.failure'
  | 'auth.recovery_code.success'
  | 'auth.recovery_code.failure'
  | 'auth.rate_limited'
  | 'auth.locked_out'
  | 'auth.step_up'
  | 'credential.added'
  | 'credential.removed'
  | 'credential.counter_regression'
  | 'totp.enrolled'
  | 'totp.removed'
  | 'recovery_codes.generated'
  | 'session.created'
  | 'session.refreshed'
  | 'session.revoked'
  | 'session.reuse_detected'
  | 'user.bootstrapped'
  | 'kek.unlocked'
  | 'kek.unlock_failed'
  | 'kek.rotated'
  // WP 9.11 (G-25): operations a stolen session would want, and its refusals.
  | 'auth.step_up_refused'
  | 'export.downloaded'
  | 'import.loaded';

export type SecurityEventOutcome = 'success' | 'failure' | 'blocked';

/** Request context every event carries. Nothing here is a credential. */
export interface RequestContext {
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
  readonly correlationId?: string | undefined;
}

/**
 * Keys that must never reach `security_events.detail`.
 *
 * The deny-list is deliberately over-broad and is the *second* line of defence:
 * the first is that callers pass counts, ids and reason codes, never values. A
 * JSONB column is the one place in this schema where a future field could smuggle
 * a token into storage that is not envelope-encrypted, and unlike a log line it is
 * never rotated away.
 */
const FORBIDDEN_DETAIL_KEYS = [
  'token',
  'secret',
  'password',
  'passphrase',
  'key',
  'code',
  'seed',
  'challenge',
  'cookie',
  'authorization',
  'credential',
];

function scrub(detail: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    const lowered = key.toLowerCase();
    if (FORBIDDEN_DETAIL_KEYS.some((needle) => lowered.includes(needle))) {
      out[key] = '[redacted]';
      continue;
    }
    out[key] = value;
  }
  return out;
}

export interface SecurityEventInput {
  readonly kind: SecurityEventKind;
  readonly outcome: SecurityEventOutcome;
  readonly userId?: string | null | undefined;
  readonly detail?: Record<string, unknown> | undefined;
  readonly context?: RequestContext | undefined;
}

/** SHA-256 of the user agent. The raw string is a fingerprint; it is never stored. */
export function hashUserAgent(userAgent: string | undefined): Uint8Array | null {
  if (userAgent === undefined || userAgent.length === 0) return null;
  return sha256(new TextEncoder().encode(userAgent));
}

export async function recordSecurityEvent(
  db: IdentityQueryable,
  clock: Clock,
  input: SecurityEventInput,
): Promise<void> {
  const uaHash = hashUserAgent(input.context?.userAgent);
  await db.query(
    `INSERT INTO security_events (id, user_id, occurred_at, kind, outcome, detail, ip, user_agent_hash, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      newId(),
      input.userId ?? null,
      clock.now(),
      input.kind,
      input.outcome,
      JSON.stringify(scrub(input.detail ?? {})),
      input.context?.ip ?? null,
      uaHash === null ? null : toParam(uaHash),
      input.context?.correlationId ?? null,
    ],
  );
}

export interface SecurityEventSummary {
  readonly id: string;
  readonly occurredAt: Date;
  readonly kind: string;
  readonly outcome: string;
  readonly detail: Record<string, unknown>;
}

export async function listSecurityEvents(
  db: IdentityQueryable,
  userId: string,
  limit = 100,
): Promise<SecurityEventSummary[]> {
  const result = await db.query(
    `SELECT id, occurred_at, kind, outcome, detail FROM security_events
     WHERE user_id = $1 OR user_id IS NULL
     ORDER BY occurred_at DESC
     LIMIT $2`,
    [userId, limit],
  );
  return result.rows.map((row) => ({
    id: String(row['id']),
    occurredAt: row['occurred_at'] as Date,
    kind: String(row['kind']),
    outcome: String(row['outcome']),
    detail: (row['detail'] ?? {}) as Record<string, unknown>,
  }));
}
