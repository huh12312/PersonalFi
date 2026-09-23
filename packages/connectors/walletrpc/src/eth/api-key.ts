// SPDX-License-Identifier: MIT
/**
 * A self-contained credential wrapper for `etherscan_api_key`.
 *
 * `@ctx/integrations`'s `ApiKey` (`packages/contexts/integrations/src/secrets.ts`)
 * does exactly this job already, but this package's boundary layer denies
 * `packages/connectors/*` → `@ctx/*` — a connector may not import a context —
 * so this is a deliberately small, independent copy of the same shape rather
 * than a shared import that cannot exist. `toString`/`toJSON`/`util.inspect`
 * all answer `'[redacted]'`, which is what `log-hygiene.test.ts` asserts a
 * structured logger handed this object would print.
 */
import { inspect } from 'node:util';

const REDACTED = '[redacted]';

export interface EtherscanApiKey {
  readonly present: boolean;
  reveal(): string;
  toString(): string;
  toJSON(): string;
}

interface Internals {
  [inspect.custom](): string;
}

export function etherscanApiKeyOf(raw: string | null | undefined): EtherscanApiKey {
  const secret = (raw ?? '').trim();
  if (secret.length === 0) return missingEtherscanApiKey();
  const key: EtherscanApiKey & Internals = {
    present: true,
    reveal: () => secret,
    toString: () => REDACTED,
    toJSON: () => REDACTED,
    [inspect.custom]: () => `EtherscanApiKey(${REDACTED})`,
  };
  return Object.freeze(key);
}

export function missingEtherscanApiKey(): EtherscanApiKey {
  const key: EtherscanApiKey & Internals = {
    present: false,
    reveal: () => {
      throw new Error(
        "no etherscan_api_key is configured. Check `.present` before calling this connector's " +
          'ETH balance leg rather than calling reveal() on a missing key.',
      );
    },
    toString: () => REDACTED,
    toJSON: () => REDACTED,
    [inspect.custom]: () => `EtherscanApiKey(absent)`,
  };
  return Object.freeze(key);
}
