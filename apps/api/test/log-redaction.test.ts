// SPDX-License-Identifier: MIT
/**
 * **P0-12 / H-3: redaction is asserted against real log output, at depth.**
 *
 * The test this replaces asserted that `REDACTED_PATHS` *contained* certain
 * strings. That is a test of an array literal: it passes just as happily against
 * a logger with redaction switched off entirely, and it did — the gate (§2.10)
 * demonstrated `{err:{config:{headers:{authorization}}}}` reaching the log in
 * clear while the test stayed green. `fast-redact` compiles each path to a fixed
 * property access, so `*` matches exactly one level and there is no `**`; a list
 * of paths can never be the whole control.
 *
 * So these cases build the logger the application actually builds, log through
 * it, capture the bytes, and search the **raw line** for sentinel values. A
 * sentinel found anywhere in the serialised output fails, whatever nesting,
 * spelling or casing carried it there.
 *
 * Why the Plaid shape specifically: `app.ts` logs `{ err: error }` on every
 * unhandled error, and an HTTP-client error from the Plaid SDK carries its whole
 * request config — `Authorization`, `PLAID-SECRET`, and a body holding
 * `client_secret` and `access_token` — hanging off the error. Nothing in Phase 0
 * makes such a call. Phase 1 makes it on day one, and by then this is a live
 * P0-12 violation rather than a latent one.
 */
import { Writable } from 'node:stream';
import { loadConfig, REDACTED_MARKER, type AppConfig } from '@core/config';
import { pino, type Logger } from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import { buildLoggerOptions, censorDeep } from '../src/logging.ts';
import { createTempSecrets } from './helpers/secrets.ts';

const secrets = createTempSecrets();

afterAll(() => {
  secrets.dispose();
});

function testConfig(): AppConfig {
  return loadConfig({
    env: {
      NODE_ENV: 'test',
      // `silent` is the application default in tests and would capture nothing.
      LOG_LEVEL: 'trace',
      DATABASE_URL: 'postgres://test:test@127.0.0.1:1/test',
      SECRETS_DIR: secrets.dir,
    },
  });
}

/** A logger built exactly as `app.ts` builds it, writing into a string. */
function captureLog(log: (logger: Logger) => void): string {
  let captured = '';
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      captured += chunk.toString('utf8');
      callback();
    },
  });
  const logger = pino(buildLoggerOptions(testConfig()), sink);
  log(logger);
  return captured;
}

/**
 * Values that must never appear. Distinctive so a match means something, and
 * deliberately not base64-ish, so a partial serialisation cannot coincidentally
 * look clean.
 */
const SENTINELS = {
  bearer: 'SENTINEL-BEARER-b7f1c904e2',
  plaidSecret: 'SENTINEL-PLAID-SECRET-3d5a8e17', // gitleaks:allow (test sentinel, not a credential)
  clientSecret: 'SENTINEL-CLIENT-SECRET-91fe22b0',
  accessToken: 'SENTINEL-ACCESS-TOKEN-4c6d0ba3',
  cookie: 'SENTINEL-COOKIE-ee19773f',
  passphrase: 'SENTINEL-PASSPHRASE-5a2b8cc6',
  accountNumber: 'SENTINEL-ACCOUNT-NUMBER-70913d4e',
} as const;

/**
 * An error shaped like one an HTTP client throws on a failed Plaid call.
 *
 * Built by hand rather than by importing the SDK: the shape is the point, and a
 * test that depends on a provider package to state its threat model stops
 * running the day that dependency moves.
 */
function plaidClientError(): Error {
  const error = new Error('Request failed with status code 400') as Error & Record<string, unknown>;
  error.name = 'AxiosError';
  error['code'] = 'ERR_BAD_REQUEST';
  error['config'] = {
    url: 'https://production.plaid.com/transactions/sync',
    method: 'post',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SENTINELS.bearer}`,
      'PLAID-SECRET': SENTINELS.plaidSecret,
      'PLAID-CLIENT-ID': 'client-id-not-secret-but-noisy',
    },
    data: JSON.stringify({
      client_id: 'abc',
      client_secret: SENTINELS.clientSecret,
      access_token: SENTINELS.accessToken,
    }),
  };
  error['response'] = {
    status: 400,
    headers: { 'set-cookie': [`session=${SENTINELS.cookie}; Path=/`] },
    data: {
      error_code: 'INVALID_ACCESS_TOKEN',
      // Providers echo the offending value back. Routinely.
      access_token: SENTINELS.accessToken,
    },
    config: { headers: { Authorization: `Bearer ${SENTINELS.bearer}` } },
  };
  return error;
}

describe('log redaction holds at depth (H-3)', () => {
  it('leaks nothing from a Plaid-shaped client error logged as { err }', () => {
    // Byte-for-byte the call `app.ts`'s error handler makes on every 5xx.
    const line = captureLog((logger) => {
      logger.error({ err: plaidClientError(), code: 'provider_error' }, 'unhandled error');
    });

    for (const [name, value] of Object.entries(SENTINELS)) {
      expect(line, `${name} reached the log`).not.toContain(value);
    }
  });

  it('still logs enough of that error to diagnose it', () => {
    // Redaction that deletes the diagnosis is not a win: the next person debugging
    // a failed sync at 03:15 needs the message, the type and the status.
    const line = captureLog((logger) => {
      logger.error({ err: plaidClientError() }, 'unhandled error');
    });

    expect(line).toContain('AxiosError');
    expect(line).toContain('Request failed with status code 400');
    expect(line).toContain('ERR_BAD_REQUEST');
    expect(line).toContain('unhandled error');
  });

  it('redacts at every depth, including the two the old paths missed', () => {
    // Each of these went to the log in clear before the fix. Depth 1 and depth 3
    // are the two `*.access_token` structurally cannot reach.
    const line = captureLog((logger) => {
      logger.info({ access_token: SENTINELS.accessToken }, 'depth1');
      logger.info({ plaid: { access_token: SENTINELS.accessToken } }, 'depth2');
      logger.info({ plaid: { item: { access_token: SENTINELS.accessToken } } }, 'depth3');
      logger.info({ a: { b: { c: { secret: SENTINELS.clientSecret } } } }, 'depth4');
      logger.info(
        { a: { b: { c: { d: { e: { passphrase: SENTINELS.passphrase } } } } } },
        'depth6',
      );
    });

    for (const value of [SENTINELS.accessToken, SENTINELS.clientSecret, SENTINELS.passphrase]) {
      expect(line).not.toContain(value);
    }
    // Non-vacuity: the lines were written, and carry the censor marker rather
    // than having been dropped or never logged at all.
    for (const message of ['depth1', 'depth2', 'depth3', 'depth4', 'depth6']) {
      expect(line).toContain(message);
    }
    expect(line).toContain(REDACTED_MARKER);
  });

  it('redacts a credential inside an array, which is where set-cookie lives', () => {
    const line = captureLog((logger) => {
      logger.info(
        { responses: [{ headers: { 'set-cookie': [`a=${SENTINELS.cookie}`] } }] },
        'array',
      );
    });

    expect(line).not.toContain(SENTINELS.cookie);
    expect(line).toContain('array');
  });

  it('matches credential keys whatever their casing', () => {
    // Providers are not consistent, and `fast-redact` is case-sensitive.
    const line = captureLog((logger) => {
      logger.info(
        {
          outer: {
            AUTHORIZATION: `Bearer ${SENTINELS.bearer}`,
            Access_Token: SENTINELS.accessToken,
            'Plaid-Secret': SENTINELS.plaidSecret,
            Account_Number: SENTINELS.accountNumber,
          },
        },
        'casing',
      );
    });

    for (const value of Object.values(SENTINELS)) expect(line).not.toContain(value);
    expect(line).toContain('casing');
  });

  it('leaves the boot configuration snapshot intact', () => {
    // Regression. An earlier revision of this fix dropped the key `config`
    // wherever it appeared, not just inside an error — and `main.ts` logs
    // `{ config: describeConfig(config) }` at boot. The P0-2 configuration
    // snapshot became `"config":"[redacted]"`, destroying the evidence that
    // `log-hygiene.test.ts` exists to read. Envelope-dropping is scoped to
    // errors precisely so this line survives.
    const line = captureLog((logger) => {
      logger.info(
        { config: { NODE_ENV: 'production', AUTH_RP_ID: 'personalfi.lan', TRUST_PROXY: 1 } },
        'configuration loaded',
      );
    });

    expect(line).toContain('personalfi.lan');
    expect(line).toContain('TRUST_PROXY');
    expect(line).not.toContain(`"config":"${REDACTED_MARKER}"`);
  });

  it('still drops the envelope when `config` hangs off an error', () => {
    // The other side of the same boundary: inside an error, `config` is an
    // axios request envelope whose `data` is a JSON *string* holding the
    // credential, which key-by-key censoring cannot reach.
    const line = captureLog((logger) => {
      logger.error({ err: plaidClientError() }, 'unhandled error');
    });

    expect(line).not.toContain(SENTINELS.clientSecret);
    expect(line).not.toContain('production.plaid.com/transactions/sync');
  });

  it('is not vacuous: a non-credential field of the same shape survives', () => {
    // If everything were censored the assertions above would pass trivially.
    const line = captureLog((logger) => {
      logger.info({ plaid: { item: { item_id: 'ITEM-ID-VISIBLE-8827' } } }, 'visible');
    });

    expect(line).toContain('ITEM-ID-VISIBLE-8827');
  });
});

describe('censorDeep', () => {
  it('terminates on a cycle rather than overflowing the stack', () => {
    // An HTTP-client error's `config` routinely points back at the error.
    const cyclic: Record<string, unknown> = { secret: SENTINELS.clientSecret };
    cyclic['self'] = cyclic;

    const serialised = JSON.stringify(censorDeep(cyclic));

    expect(serialised).not.toContain(SENTINELS.clientSecret);
    expect(serialised).toContain('[circular]');
  });

  it('does not mutate the object it was given', () => {
    // A logger that edits its inputs changes program behaviour when LOG_LEVEL
    // changes, which is the worst class of logging bug to chase.
    const original = { plaid: { access_token: SENTINELS.accessToken } };

    censorDeep(original);

    expect(original.plaid.access_token).toBe(SENTINELS.accessToken);
  });

  it('summarises a Buffer instead of serialising it', () => {
    const out = censorDeep({ body: Buffer.from(SENTINELS.accessToken, 'utf8') }) as {
      body: string;
    };

    expect(out.body).not.toContain(SENTINELS.accessToken);
    expect(out.body).toMatch(/^\[Buffer \d+]$/);
  });

  it('caps depth rather than walking an unbounded graph', () => {
    let deep: Record<string, unknown> = { secret: SENTINELS.clientSecret };
    for (let level = 0; level < 40; level += 1) deep = { nested: deep };

    const serialised = JSON.stringify(censorDeep(deep));

    expect(serialised).not.toContain(SENTINELS.clientSecret);
  });
});
