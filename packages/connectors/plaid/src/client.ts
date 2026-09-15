// SPDX-License-Identifier: MIT
/**
 * The only file that constructs a real HTTP client.
 *
 * Kept apart from `connector.ts` so that nothing in the test suite — and nothing
 * in a deployment that has not configured Plaid — loads axios. `PlaidConnector`
 * takes a `PlaidApiLike`; this produces one from credentials.
 *
 * ## `Plaid-Version` is pinned here and nowhere else
 *
 * 01 §1.9: "If the header is omitted, the Dashboard-configured default applies."
 * A response shape that depends on a browser checkbox is not a contract. The
 * header is set on the axios defaults so that every one of the eleven calls
 * carries it whether or not someone remembered, and `pins.test.ts` asserts it
 * from the constructed configuration rather than from this source line.
 *
 * ## The two secrets never leave this function's argument
 *
 * `clientId` and `secret` go into the axios default headers and are not stored,
 * logged, or returned. They are also the reason `errors.ts` refuses to attach an
 * axios error as a `cause`: that error carries `config.headers`, and
 * `config.headers` carries `PLAID-SECRET`.
 */
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import type { PlaidApiLike, PlaidSandboxApiLike } from './api.ts';
import { PLAID_API_VERSION } from './provider.ts';

/** 01 §1.1. "Development" no longer exists (01 §1.2); there are two. */
export const PLAID_ENVIRONMENTS = Object.freeze(['sandbox', 'production'] as const);

export type PlaidEnvironment = (typeof PLAID_ENVIRONMENTS)[number];

export interface PlaidCredentials {
  readonly clientId: string;
  readonly secret: string;
  readonly environment: PlaidEnvironment;
}

/** The headers every request carries. Exported so a test can assert the pin. */
export function plaidRequestHeaders(credentials: PlaidCredentials): Record<string, string> {
  return {
    'PLAID-CLIENT-ID': credentials.clientId,
    'PLAID-SECRET': credentials.secret,
    'Plaid-Version': PLAID_API_VERSION,
  };
}

export function plaidBasePath(environment: PlaidEnvironment): string {
  const basePath = PlaidEnvironments[environment];
  if (basePath === undefined) {
    throw new Error(`unknown plaid environment ${JSON.stringify(environment)}`);
  }
  return basePath;
}

/**
 * A live client, narrowed to the eleven methods the adapter may call.
 *
 * The return type is the intersection because the live smoke test needs the two
 * Sandbox helpers and `PlaidConnector` must not be able to reach them; the
 * connector's own constructor accepts only `PlaidApiLike`, so passing this in
 * widens nothing.
 */
export function createPlaidApi(credentials: PlaidCredentials): PlaidApiLike & PlaidSandboxApiLike {
  return new PlaidApi(
    new Configuration({
      basePath: plaidBasePath(credentials.environment),
      baseOptions: { headers: plaidRequestHeaders(credentials) },
    }),
  );
}
