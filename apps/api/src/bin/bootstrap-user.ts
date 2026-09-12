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
import { createPool } from '@core/db';
import { SecretBox, isSecretBoxError } from '@core/secretbox';
import {
  assertIanaZone,
  isAuthError,
  recordSecurityEvent,
  REGISTRATION_TOKEN_TTL_SECONDS,
  UserService,
} from '@ctx/identity';

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

const pool = createPool({
  databaseUrl: config.databaseUrl.reveal(),
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
    state = await secretBox.unlock(passphrase.reveal());
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
  const link = `${config.env.BASE_URL.replace(/\/+$/, '')}/enrol#token=${issued.token}`;

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
