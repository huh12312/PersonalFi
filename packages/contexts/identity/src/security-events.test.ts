// SPDX-License-Identifier: MIT
/**
 * The audit writer, tested against a fake queryable (P1-10).
 *
 * No database here on purpose: what is under test is what the writer *puts in the
 * parameters*, and a real Postgres would only tell us that `INSERT` works. The
 * interesting property is negative — that a credential-shaped key never reaches
 * `security_events.detail` — and the cleanest way to assert it is to read the
 * parameter array the writer built.
 *
 * `detail` is JSONB and is the one place in this schema where a future field could
 * smuggle a token into storage that is **not** envelope-encrypted; unlike a log
 * line it is never rotated away.
 */
import { fixedClock } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import type { IdentityQueryable } from './db.ts';
import { hashUserAgent, listSecurityEvents, recordSecurityEvent } from './security-events.ts';

const clock = fixedClock('2026-03-01T12:00:00.000Z');

interface Captured {
  readonly text: string;
  readonly values: readonly unknown[];
}

function recordingDb(rows: Record<string, unknown>[] = []): IdentityQueryable & {
  calls: Captured[];
} {
  const calls: Captured[] = [];
  return {
    calls,
    async query(text, values = []) {
      calls.push({ text, values });
      return { rows };
    },
  };
}

/** The `detail` JSON the writer actually sent, parsed back. */
function detailOf(call: Captured): Record<string, unknown> {
  return JSON.parse(String(call.values[5])) as Record<string, unknown>;
}

describe('recordSecurityEvent', () => {
  it('writes the kind, outcome, user and correlation id', async () => {
    const db = recordingDb();
    await recordSecurityEvent(db, clock, {
      kind: 'auth.webauthn.success',
      outcome: 'success',
      userId: '0192f3c1-0000-7000-8000-000000000001',
      detail: { sessionId: 'sess-1', trustedDevice: true },
      context: { ip: '198.51.100.7', userAgent: 'Firefox', correlationId: 'corr-1' },
    });

    const call = db.calls[0];
    expect(call).toBeDefined();
    expect(call?.text).toContain('INSERT INTO security_events');
    expect(call?.values[1]).toBe('0192f3c1-0000-7000-8000-000000000001');
    expect(call?.values[3]).toBe('auth.webauthn.success');
    expect(call?.values[4]).toBe('success');
    expect(call?.values[6]).toBe('198.51.100.7');
    expect(call?.values[8]).toBe('corr-1');
    expect(detailOf(call!)).toEqual({ sessionId: 'sess-1', trustedDevice: true });
  });

  it('replaces anything credential-shaped in the detail', async () => {
    const db = recordingDb();
    await recordSecurityEvent(db, clock, {
      kind: 'credential.added',
      outcome: 'success',
      detail: {
        // The deny-list is substring-based and deliberately over-broad: the first
        // line of defence is that callers pass counts and ids, never values.
        token: 'access-sandbox-abc',
        refreshToken: 'r-123',
        recoveryCode: 'ABCDE-FGHIJ',
        passphrase: 'hunter2',
        apiKey: 'sk-live-1',
        seedMaterial: 'JBSWY3DP',
        challenge: 'Y2hhbGxlbmdl',
        Cookie: '__Host-pfi_session=x',
        credentialRowId: 'keep-me',
        count: 10,
      },
    });

    const detail = detailOf(db.calls[0]!);
    for (const key of [
      'token',
      'refreshToken',
      'recoveryCode',
      'passphrase',
      'apiKey',
      'seedMaterial',
      'challenge',
      'Cookie',
      // Even an id: the deny-list matches substrings, so `credentialRowId` is
      // caught along with `credential`. Over-broad is the correct failure
      // direction for a column that is never rotated away.
      'credentialRowId',
    ]) {
      expect(detail[key], key).toBe('[redacted]');
    }
    // Counts and plain facts survive; they are what makes the trail useful.
    expect(detail['count']).toBe(10);
    expect(JSON.stringify(detail)).not.toContain('hunter2');
    expect(JSON.stringify(detail)).not.toContain('access-sandbox-abc');
  });

  it('defaults the detail to an empty object rather than null', async () => {
    const db = recordingDb();
    await recordSecurityEvent(db, clock, { kind: 'auth.locked_out', outcome: 'blocked' });
    expect(detailOf(db.calls[0]!)).toEqual({});
    expect(db.calls[0]?.values[1]).toBeNull();
    expect(db.calls[0]?.values[6]).toBeNull();
  });

  it('stores a digest of the user agent and never the string', async () => {
    const db = recordingDb();
    await recordSecurityEvent(db, clock, {
      kind: 'auth.totp.success',
      outcome: 'success',
      context: { userAgent: 'Mozilla/5.0 (very identifying)' },
    });
    const uaHash = db.calls[0]?.values[7];
    expect(Buffer.isBuffer(uaHash)).toBe(true);
    expect(uaHash).toHaveLength(32);
    // A UA string is a fingerprint and belongs in no column.
    expect((uaHash as Buffer).toString('latin1')).not.toContain('Mozilla');
  });
});

describe('hashUserAgent', () => {
  it('is null for an absent or empty user agent', () => {
    expect(hashUserAgent(undefined)).toBeNull();
    expect(hashUserAgent('')).toBeNull();
  });

  it('is deterministic and 32 bytes', () => {
    const a = hashUserAgent('Firefox/140.0');
    const b = hashUserAgent('Firefox/140.0');
    expect(a).toHaveLength(32);
    expect([...(a ?? [])]).toEqual([...(b ?? [])]);
    expect([...(a ?? [])]).not.toEqual([...(hashUserAgent('Firefox/141.0') ?? [])]);
  });
});

describe('listSecurityEvents', () => {
  it('includes events with no user, so a pre-login failure is still visible', async () => {
    const db = recordingDb([
      {
        id: 'e1',
        occurred_at: new Date('2026-03-01T12:00:00.000Z'),
        kind: 'auth.webauthn.failure',
        outcome: 'failure',
        detail: { consecutiveFailures: 1 },
      },
    ]);
    const events = await listSecurityEvents(db, '0192f3c1-0000-7000-8000-000000000001', 50);

    expect(db.calls[0]?.text).toContain('user_id IS NULL');
    expect(db.calls[0]?.values[1]).toBe(50);
    expect(events).toEqual([
      {
        id: 'e1',
        occurredAt: new Date('2026-03-01T12:00:00.000Z'),
        kind: 'auth.webauthn.failure',
        outcome: 'failure',
        detail: { consecutiveFailures: 1 },
      },
    ]);
  });
});
