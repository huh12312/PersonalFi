// SPDX-License-Identifier: MIT
/**
 * A real Postgres for the identity context's integration tests.
 *
 * Almost everything this context claims is a claim about the database rather than
 * about our TypeScript, which is why there is no fake here:
 *
 * - single use of a recovery code, a registration token and a WebAuthn challenge
 *   is an `UPDATE ... WHERE used_at IS NULL ... RETURNING`, and it is only
 *   single-use because two concurrent statements race on that predicate;
 * - rate limiting that "survives a restart" (P0-14) is, by definition, not in
 *   memory — a fake would be exactly the in-memory limiter the control forbids;
 * - refresh-reuse detection depends on a superseded generation still being a row.
 *
 * `WP02_DATABASE_URL` (falling back to `DATABASE_URL`) points at an admin
 * database; each suite gets its own scratch database.
 */
import { createPool, runMigrations } from '@core/db';
import { mutableClock, newId, type MutableClock } from '@core/kernel';
import { SecretBox } from '@core/secretbox';
import { createIdentityContext, type IdentityContext } from '../src/index.ts';
import type { IdentityQueryable } from '../src/db.ts';

export const ADMIN_URL = process.env['WP02_DATABASE_URL'] ?? process.env['DATABASE_URL'];

export const RP_ID = 'localhost';
export const RP_NAME = 'PersonalFi Test';
export const ORIGIN = 'http://localhost:8080';

/** The instant every suite starts at, so a failure message reads the same twice. */
export const EPOCH = '2026-03-01T12:00:00.000Z';

/**
 * Development-floor Argon2id (~5 ms). The production numbers are enforced by
 * `loadConfig` and evidenced in `docs/evidence/phase-0/wp0.2-argon2-parameters.md`;
 * nothing in this context's behaviour changes with the cost parameters.
 */
const TEST_KDF = { memoryKiB: 8_192, timeCost: 2, parallelism: 1 } as const;

/** Recovery-code hashing at the same floor: ten Argon2id hashes per `generate()`. */
export const TEST_RECOVERY_HASH_PARAMS = TEST_KDF;

/** Tables this context owns that a test may safely wipe between cases. */
const RESETTABLE = [
  'sessions',
  'webauthn_credentials',
  'webauthn_challenges',
  'totp_secrets',
  'recovery_codes',
  'registration_tokens',
  'auth_attempts',
  'auth_lockouts',
  'security_events',
].join(', ');

export interface IdentityHarness {
  readonly db: IdentityQueryable;
  readonly userId: string;
  readonly clock: MutableClock;
  readonly secretBox: SecretBox;
  readonly identity: IdentityContext;
  /** Wipe everything except `users` and the keyring. */
  reset(): Promise<void>;
  drop(): Promise<void>;
}

const silent = { info: () => undefined, warn: () => undefined };

export interface HarnessOptions {
  /** Overrides `DEFAULT_SESSION_TTLS`. Handy for driving an expiry in one tick. */
  readonly sessionTtls?: IdentityContextOptionsTtls;
  /** 0 by default: the production 250 ms floor would add minutes across a suite. */
  readonly failureDelayMs?: number;
  /**
   * Overrides {@link RP_ID}. Exists so P0-4's remediation can be proved against a
   * *deployment-shaped* relying party (`personalfi.lan`) rather than against
   * `localhost`, which is the one hostname whose special-casing in browsers hides
   * the bug the gate found.
   */
  readonly rpId?: string;
  /** Overrides {@link ORIGIN}. Paired with `rpId`; the two must agree. */
  readonly allowedOrigins?: readonly string[];
  /**
   * Overrides the identity pool's `max`. Default (6) is plenty for ordinary
   * integration tests; a concurrency test that wants N genuinely simultaneous
   * backends (gate-security-review-2.md R-2) must ask for `max >= N` or `pg`'s
   * lazy backend creation will queue the excess callers instead of racing them.
   */
  readonly poolMax?: number;
}

type IdentityContextOptionsTtls = {
  readonly idleSeconds: number;
  readonly absoluteSeconds: number;
  readonly trustedSeconds: number;
  readonly stepUpSeconds: number;
};

export async function createIdentityHarness(
  name: string,
  options: HarnessOptions = {},
): Promise<IdentityHarness> {
  if (ADMIN_URL === undefined) {
    throw new Error('DATABASE_URL is unset; run `just db-up` first');
  }

  // `createPool` rather than a raw `pg.Client`: the boundary lint allows
  // `@core/db` here and denies `pg`, and it is not relaxed for test helpers.
  const admin = createPool({ databaseUrl: ADMIN_URL, max: 1, applicationName: 'wp02-admin' });
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();

  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const databaseUrl = url.toString();
  await runMigrations({ databaseUrl, logger: silent });

  const pool = createPool({
    databaseUrl,
    applicationName: `wp02-${name}`,
    max: options.poolMax ?? 6,
  });
  const clock = mutableClock(EPOCH);

  const userId = newId();
  await pool.query(
    `INSERT INTO users (id, display_name, display_timezone, created_at)
     VALUES ($1, 'Test Holder', 'America/Los_Angeles', $2)`,
    [userId, clock.now()],
  );

  const secretBox = new SecretBox({
    db: pool,
    userId,
    clock,
    kdfParams: TEST_KDF,
    kdfFloor: TEST_KDF,
  });
  const unlocked = await secretBox.unlock('the test passphrase');
  if (unlocked.state !== 'unlocked') {
    throw new Error(`test keyring failed to unlock: ${unlocked.reason}`);
  }

  const identity = createIdentityContext({
    db: pool,
    clock,
    secretBox,
    rpId: options.rpId ?? RP_ID,
    rpName: RP_NAME,
    allowedOrigins: options.allowedOrigins === undefined ? [ORIGIN] : [...options.allowedOrigins],
    ...(options.sessionTtls === undefined ? {} : { sessionTtls: options.sessionTtls }),
    failureDelayMs: options.failureDelayMs ?? 0,
  });

  return {
    db: pool,
    userId,
    clock,
    secretBox,
    identity,

    async reset(): Promise<void> {
      await pool.query(`TRUNCATE ${RESETTABLE} RESTART IDENTITY CASCADE`);
      clock.setTo(EPOCH);
    },

    async drop(): Promise<void> {
      secretBox.destroy();
      await pool.end().catch(() => undefined);
      const cleanup = createPool({
        databaseUrl: ADMIN_URL,
        max: 1,
        applicationName: 'wp02-cleanup',
      });
      await cleanup.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await cleanup.end();
    },
  };
}

/** The request context every flow takes. Nothing here is a credential. */
export function requestContext(ip = '198.51.100.7'): {
  ip: string;
  userAgent: string;
  correlationId: string;
} {
  return { ip, userAgent: 'vitest/1.0 (identity suite)', correlationId: newId() };
}
