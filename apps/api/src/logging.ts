// SPDX-License-Identifier: MIT
import type { AppConfig } from '@core/config';
import { REDACTED_MARKER } from '@core/config';
import { systemClock } from '@core/kernel';
import type { LoggerOptions } from 'pino';

/**
 * Everything that must never reach a log line.
 *
 * This list is a P0 security control (master plan §4.12): a CI test greps captured
 * sync logs and fails on a token or an account number. Adding a field that holds a
 * credential without adding it here is the failure mode this exists to prevent, so
 * prefer over-broad paths.
 */
export const REDACTED_PATHS: readonly string[] = [
  // Transport-level credentials.
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["plaid-verification"]',
  'res.headers["set-cookie"]',

  // Provider and session credentials, at any depth.
  '*.access_token',
  '*.accessToken',
  '*.refresh_token',
  '*.refreshToken',
  '*.public_token',
  '*.publicToken',
  '*.link_token',
  '*.id_token',
  '*.client_secret',
  '*.clientSecret',
  '*.api_key',
  '*.apiKey',
  '*.secret',
  '*.password',
  '*.passphrase',
  '*.private_key',
  '*.privateKey',
  '*.master_key',
  '*.kek',
  '*.dek',
  '*.session_token',
  '*.cookie',
  '*.authorization',

  // Personally identifying account detail.
  '*.account_number',
  '*.accountNumber',
  '*.routing_number',
  '*.routingNumber',
  '*.iban',
  '*.wire_routing',
  '*.ssn',
  '*.tax_id',
  '*.card_number',
  '*.cvv',
  '*.xpub',
  '*.mnemonic',
];

export function buildLoggerOptions(config: AppConfig): LoggerOptions {
  return {
    level: config.env.LOG_LEVEL,
    // A second line of defence behind `Redacted<T>`: the type stops a secret being
    // serialised at all, this stops one that slipped into a plain object.
    redact: { paths: [...REDACTED_PATHS], censor: REDACTED_MARKER, remove: false },
    base: { service: 'api' },
    // Instants in logs are ISO-8601 UTC so a log line and a timestamptz column
    // can be compared without guessing a zone.
    timestamp: () => `,"time":"${systemClock.now().toISOString()}"`,
    formatters: {
      level: (label) => ({ level: label }),
    },
    serializers: {
      req: (request: {
        id: string;
        method: string;
        url: string;
        headers: Record<string, unknown>;
      }) => ({
        id: request.id,
        method: request.method,
        url: request.url,
        headers: { host: request.headers['host'], 'user-agent': request.headers['user-agent'] },
      }),
      res: (reply: { statusCode: number }) => ({ statusCode: reply.statusCode }),
    },
    ...(config.env.LOG_PRETTY
      ? { transport: { target: 'pino-pretty', options: { colorize: true, singleLine: false } } }
      : {}),
  };
}
