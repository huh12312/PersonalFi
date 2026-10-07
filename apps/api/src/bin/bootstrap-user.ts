// SPDX-License-Identifier: MIT
/**
 * `just bootstrap-user` — create the single account holder and print a one-time
 * passkey-enrolment link (decision D21, P0-4).
 *
 * **Why this exists at all.** A box with no credentials cannot authenticate
 * anybody, so something has to be trusted exactly once. The options are a default
 * password (never), an open registration endpoint (an account takeover waiting for
 * one misconfigured proxy), or a single-use token minted by someone with shell
 * access on the host. Only the third has a trust boundary that matches reality:
 * whoever can run this command already owns the machine, the database and the
 * `master_key` file, so it grants them nothing they did not already have.
 *
 * It does three things, in this order, and the order is the point:
 *
 * 1. creates the `users` row;
 * 2. **derives the KEK and initialises the keyring** — this is where a wrong or
 *    missing `master_key` is discovered, at a prompt with an operator watching,
 *    rather than at 03:15 in the middle of a sync. It is also where the ~6 s
 *    Argon2id cost becomes visible, which is the evidence P0-2 asks for;
 *    and it is deliberately *before* the token is minted, so a box that cannot
 *    unlock never hands out an enrolment link it could not honour;
 * 3. mints the enrolment token and prints it.
 *
 * The token is printed to stdout exactly once. It is stored as a SHA-256 digest,
 * so nothing recoverable survives in the database, and it expires in an hour.
 *
 * Run: `just bootstrap-user name="Chris" timezone="America/Los_Angeles"`
 */
import { parseArgs } from 'node:util';
import { loadConfig, ConfigError, describeKek } from '@core/config';
import { systemClock } from '@core/kernel';
import { createDatabase, createPool } from '@core/db';
import { SecretBox, isSecretBoxError } from '@core/secretbox';
import {
  withKekDerivationLock,
  assertIanaZone,
  isAuthError,
  recordSecurityEvent,
  REGISTRATION_TOKEN_TTL_SECONDS,
  UserService,
} from '@ctx/identity';
import { seedUserState } from '../bootstrap-seed.ts';
import { buildPlatform } from '../platform.ts';
import { appRoleDatabaseUrl, ensureAppRole } from '../db-role.ts';

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function fail(message: string, code = 1): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    timezone: { type: 'string' },
    /**
     * Mint a fresh enrolment link for an account that already exists.
     *
     * Gated behind a flag rather than being the default, because the difference
     * between "bootstrap a new box" and "hand out a credential-enrolment link on a
     * live one" is worth one word of typing. It is the documented recovery path
     * for losing every passkey *and* every recovery code, and it is safe for the
     * same reason the command is: it is reachable only from a shell on the host.
     */
    reissue: { type: 'boolean', default: false },
  },
  allowPositionals: false,
});

const config = (() => {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) fail(error.message, 78); // EX_CONFIG
    throw error;
  }
})();

// CF-18 / G-01 (WP 9.11): the DML-only app role, as main.ts and worker.ts.
// Here a failure is fatal: an operator is watching.
const appRole = await ensureAppRole(config.databaseUrl.reveal());
if (!appRole.ok) fail(`could not ensure the database app role: ${appRole.error}`);

const pool = createPool({
  databaseUrl: appRoleDatabaseUrl(config.databaseUrl.reveal()),
  max: 2,
  applicationName: 'personalfi-bootstrap',
});

try {
  const users = new UserService({ db: pool, clock: systemClock });
  const existing = await users.findPrimary();

  if (existing !== null && !values.reissue) {
    fail(
      `A user already exists: ${existing.displayName} (${existing.id}).\n` +
        'Pass reissue=true to mint a fresh passkey-enrolment link for it — that is the ' +
        'recovery path for losing every passkey and every recovery code.',
    );
  }

  let user = existing;
  if (user === null) {
    const displayName = (values.name ?? '').trim();
    if (displayName.length === 0) {
      fail('name is required, e.g. `just bootstrap-user name="Chris"`.');
    }
    // Validated here as well as in `createPrimary` so a typo fails before the
    // six-second key derivation rather than after it.
    const timezone = (values.timezone ?? 'UTC').trim();
    try {
      assertIanaZone(timezone);
    } catch {
      fail(`${JSON.stringify(timezone)} is not an IANA time zone, e.g. America/Los_Angeles.`);
    }
    user = await users.createPrimary({ displayName, displayTimezone: timezone });
    out(`user created      ${user.displayName} (${user.id})`);
    out(`time zone         ${user.displayTimezone}`);

    // C-1 (docs/evidence/phase-2/gate-security-review.md §5): this is the one
    // composition-root call — `apps/api/src/bootstrap-seed.ts` — that seeds
    // everything a brand-new user needs (taxonomy, WP 2.7's advisor
    // catalogue, and the categorization/notifications/insights schedules)
    // right now, rather than leaving any of it to the api's `onReady` pass
    // (which only runs at boot, so a user created after `up` saw none of it
    // until a restart — G2-1) or to a route's own lazy repair (deleted; see
    // `routes/categories.ts` and `routes/insights.ts`). Idempotent throughout,
    // so running it again on a `reissue` (existing user) inserts nothing new.
    const platform = buildPlatform({ config, pool });
    const seeded = await seedUserState(createDatabase(pool), platform.flags, {
      userId: user.id,
      timezone: user.displayTimezone,
      clock: systemClock,
      ...(config.secrets.advisor_token_secret === undefined
        ? {}
        : { advisorTokenSecret: config.secrets.advisor_token_secret.reveal() }),
    });
    out(`taxonomy          ${String(seeded.categoriesInserted)} categories seeded`);
    out(`advisors          ${String(seeded.advisorsRegistered)} manifests registered`);
    out(
      `schedules         ${seeded.schedulesRegistered.length > 0 ? seeded.schedulesRegistered.join(', ') : '(none — modules disabled)'}`,
    );
    await platform.flags.close();
  } else {
    out(`user              ${user.displayName} (${user.id})`);
  }

  const passphrase = config.secrets.master_key;
  if (passphrase === undefined) {
    // Unreachable: `master_key` is a required secret and `loadConfig` would have
    // thrown. Kept because the alternative to this branch is a non-null assertion
    // on the passphrase, and that is not an assertion worth making here.
    fail('the master_key secret is missing; the keyring cannot be initialised.');
  }

  out('deriving the key-encryption key (argon2id); this takes a few seconds…');
  const secretBox = new SecretBox({
    db: pool,
    userId: user.id,
    clock: systemClock,
    kdfParams: config.kek.params,
    kdfFloor: config.kek.floor,
  });

  let state;
  try {
    // WP 9.11 (Q9, WP 9.9's P-5): this is a THIRD 1 GiB Argon2 derivation,
    // and `just bootstrap-user` runs it inside the api container's cgroup
    // (1536M; 9.9 measured a 90 % peak). The derivation lock means it never
    // overlaps the api's or the worker's own derivation (e.g. right after an
    // `up`); the api process's steady state beside it is what remains.
    ({ result: state } = await withKekDerivationLock(pool, () =>
      secretBox.unlock(passphrase.reveal()),
    ));
  } catch (error) {
    if (isSecretBoxError(error)) fail(`key custody: ${error.message}`);
    throw error;
  }

  if (state.state !== 'unlocked') {
    secretBox.destroy();
    fail(
      state.reason === 'passphrase_mismatch'
        ? 'The master_key file does not match the KEK already stored for this user. ' +
            'Restore the original passphrase; there is no way to re-derive it.'
        : 'The master_key file is empty. Write a high-entropy passphrase to it (mode 0400).',
    );
  }

  const kek = describeKek(config, state.kdf.durationMs);
  out(
    `key custody       unlocked · argon2id m=${String(kek['memoryKiB'])} KiB ` +
      `t=${String(kek['timeCost'])} p=${String(kek['parallelism'])} · ` +
      `${String(kek['durationMs'])} ms · KEK generation ${String(state.kekVersion)}`,
  );
  if (state.rotationRecommended) {
    out('warning           the stored KEK is below the current parameter floor; rotate it');
  }

  const issued = await users.issueRegistrationToken(user.id);
  await recordSecurityEvent(pool, systemClock, {
    kind: 'user.bootstrapped',
    outcome: 'success',
    userId: user.id,
    // Ids and counts only. The token itself is never written anywhere but stdout.
    detail: { reissue: existing !== null, expiresAt: issued.expiresAt.toISOString() },
  });

  // The token travels in the URL *fragment*: a fragment is never sent to a server,
  // so it cannot land in Caddy's access log, in a `Referer` header, or in a proxy
  // cache the way a query parameter would.
  // The path is `/register` because that is the route the SPA actually serves
  // (`apps/web/src/routes/register.tsx`). It said `/enrol` until the second
  // security gate walked the flow end to end and landed on "Page not found":
  // the one-time link printed by the only bootstrap path on a fresh box led
  // nowhere, so no passkey could ever be enrolled (gate-security-review-2.md,
  // P0-4). Nothing tested the link, because nothing resolved it.
  const link = `${config.env.BASE_URL.replace(/\/+$/, '')}/register#token=${issued.token}`;

  out('');
  out(`Enrol your first passkey within ${String(REGISTRATION_TOKEN_TTL_SECONDS / 60)} minutes:`);
  out('');
  out(`  ${link}`);
  out('');
  out(`  token only: ${issued.token}`);
  out(`  expires:    ${issued.expiresAt.toISOString()}`);
  out('');
  out('Single-use. It is stored only as a SHA-256 digest, so this is the one and only');
  out('time it is readable — and it is not in any log. Enrol a second authenticator');
  out('and print your ten recovery codes straight after: one passkey on one device is');
  out('a self-inflicted denial of service.');

  secretBox.destroy();
} catch (error) {
  if (isAuthError(error)) fail(`bootstrap failed: ${error.message}`);
  throw error;
} finally {
  await pool.end();
}
