// SPDX-License-Identifier: MIT
/**
 * `ApiKey` — a provider credential that cannot be printed by accident.
 *
 * ## The failure this exists to prevent
 *
 * An API key is a string. Every logger, every `JSON.stringify` of a config
 * object, every `throw new Error(\`GET ${url} failed\`)` and every template
 * literal in a debug line will happily render a string, and none of them will
 * warn anyone. Phase 1's `wp1.3b` custody work established the pattern for
 * Plaid's credentials — the raw column is read back through `psql` and asserted
 * to contain no plaintext — and the same claim for market data has a *wider*
 * surface, because a provider key travels in a header or a query string on
 * every one of the ~1,000 requests a day Tiingo permits.
 *
 * So the key is never a bare `string` after it leaves `@core/config`. It is
 * this object, whose `toString`, `toJSON` and `util.inspect.custom` all answer
 * `'[redacted]'`. `reveal()` is the only way to the plaintext, it is called in
 * exactly one place per adapter (building the outbound header), and
 * `test/log-hygiene.test.ts` greps this package's source to prove the count.
 *
 * ## Why FRED still needs `redactSecrets`
 *
 * Three of the four providers take the key in a header, which keeps it out of
 * URLs entirely:
 *
 *   * Tiingo — `Authorization: Token <key>`
 *   * CoinGecko — `x-cg-demo-api-key: <key>`
 *   * OpenFIGI — `X-OPENFIGI-APIKEY: <key>`
 *
 * FRED has no header form: `api_key` is a query parameter and there is no
 * alternative. That is a fact about FRED, not a choice, and it means one
 * provider's key does end up in a URL string. Two consequences, both handled:
 * the HTTP client never puts a URL in an error message or a run record, and
 * every string that *is* recorded goes through `redactSecrets` first — because
 * providers echo the query string back in error bodies, and an unredacted
 * upstream error body is the realistic way a key reaches `market_data_runs`.
 *
 * `test/custody.test.ts` sabotages exactly that: it makes the fake FRED
 * transport answer with an error body containing the key, runs a refresh, and
 * reads every text column of `market_data_runs` back through raw SQL.
 */
import { inspect } from 'node:util';

const REDACTED = '[redacted]';

/**
 * A provider credential.
 *
 * `present` is on the *type* rather than being expressed as `ApiKey | null`
 * because every adapter must handle the missing case anyway — §6 of the
 * dispatch: "Every adapter degrades to 'no price, stale flag, visible' without
 * its key, so Phase 3 completes with zero keys" — and a nullable key invites
 * `key!` at the one call site that matters.
 */
export interface ApiKey {
  /** Which provider this belongs to. Safe to log. */
  readonly provider: string;
  readonly present: boolean;
  /**
   * The plaintext. Call this **only** where the outbound header or query is
   * built, and never store what it returns.
   */
  reveal(): string;
  /** `'[redacted]'`. */
  toString(): string;
  /** `'[redacted]'`. Covers `JSON.stringify(config)`. */
  toJSON(): string;
}

interface KeyInternals {
  [inspect.custom](): string;
}

function makeKey(provider: string, secret: string, present: boolean): ApiKey {
  const key: ApiKey & KeyInternals = {
    provider,
    present,
    reveal: () => secret,
    toString: () => REDACTED,
    toJSON: () => REDACTED,
    // `console.log(key)` and `util.inspect(key)` — which is what a structured
    // logger does to an object it does not recognise — both go through this.
    [inspect.custom]: () => `ApiKey(${provider}, ${REDACTED})`,
  };
  return Object.freeze(key);
}

/**
 * Wrap a secret read from `${SECRETS_DIR}/<provider>_api_key`.
 *
 * Whitespace is trimmed because a file secret written with `echo` carries a
 * trailing newline, and a newline in a header value is request splitting —
 * `assertHeaderValueSafe` would refuse it, which is correct but would present
 * as "my key does not work".
 */
export function apiKeyOf(provider: string, raw: string): ApiKey {
  const secret = raw.trim();
  if (secret.length === 0) return missingKey(provider);
  return makeKey(provider, secret, true);
}

/** The absence of a key, as a value. `reveal()` throws rather than returning `''`. */
export function missingKey(provider: string): ApiKey {
  const key: ApiKey & KeyInternals = {
    provider,
    present: false,
    reveal: () => {
      throw new Error(
        `${provider}: no API key is configured. An adapter must check \`key.present\` and ` +
          'return { kind: "skipped_no_key" } rather than calling reveal().',
      );
    },
    toString: () => REDACTED,
    toJSON: () => REDACTED,
    [inspect.custom]: () => `ApiKey(${provider}, absent)`,
  };
  return Object.freeze(key);
}

/**
 * Replace every occurrence of every configured secret with `'[redacted]'`.
 *
 * The last line of defence, applied to anything derived from a provider's own
 * words before it is stored or logged: an upstream error body, an exception
 * message, a truncated response. Deliberately a dumb substring replacement
 * rather than a pattern matcher — a pattern would need to know what each
 * provider's keys look like, and would miss the day one of them changes format.
 *
 * Short secrets are skipped: a two-character "key" would redact half of every
 * sentence and the result would be less auditable, not more. A real provider
 * key is 32+ characters; the floor is 8.
 */
export function redactSecrets(text: string, keys: readonly ApiKey[]): string {
  let out = text;
  for (const key of keys) {
    if (!key.present) continue;
    const secret = key.reveal();
    if (secret.length < 8) continue;
    out = out.split(secret).join(REDACTED);
  }
  return out;
}

/** `redactSecrets` over whatever an unknown thrown value turns out to be. */
export function redactedMessageOf(error: unknown, keys: readonly ApiKey[]): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactSecrets(raw, keys);
}
