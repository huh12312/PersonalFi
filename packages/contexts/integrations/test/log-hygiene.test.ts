// SPDX-License-Identifier: MIT
/**
 * *'an API key never appears in a log line'*.
 *
 * ## Why this test is about FRED
 *
 * Three of the four providers take the key in a header, which keeps it out of
 * URLs entirely. FRED has no header form — `api_key` is a query parameter and
 * there is no alternative — so a URL built for FRED **contains a credential**.
 *
 * That makes one realistic mistake fatal: `throw new Error(\`GET ${url}
 * failed\`)`. It would put the key in a stack trace, a log line and
 * `market_data_runs.error_message` in one stroke, and nothing would look wrong.
 * Providers also echo the query string back in error bodies, which is the other
 * realistic path — the key arrives in *their* words rather than ours.
 *
 * So this file drives the real FRED adapter through the real client with a
 * transport that answers with a body containing the key, and asserts on
 * **everything that comes back out**: the outcome's detail, the error message,
 * `util.inspect` of the key object, `JSON.stringify` of a config holding it,
 * and the adapter's whole returned value graph.
 *
 * The sabotage at the end is the control: it removes the redactor and asserts
 * the leak reappears. Without it this file would pass against an
 * implementation that never put the key anywhere to begin with — which is the
 * right outcome, but not the one being claimed.
 */
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createProviderClient } from '../src/http.ts';
import { policyFor } from '../src/egress.ts';
import { apiKeyOf, missingKey, redactSecrets, redactedMessageOf } from '../src/secrets.ts';
import { createFakeTransport, jsonResponse } from '../src/adapters/fake.ts';
import { createFredSource } from '../src/adapters/fred.ts';
import { createTiingoPriceSource } from '../src/adapters/tiingo.ts';

/** Long enough to be a real key, distinctive enough to grep for. */
const SECRET = 'fredkey_9f3c1d7e42ab88c05e6a1b2d3f4e5a6b'; // gitleaks:allow — synthetic fixture; the test asserts it never appears in a log line / raw column
const NOW = new Date('2026-09-21T03:45:00.000Z');
const now = (): Date => NOW;
const PUBLIC = () => Promise.resolve(['93.184.216.34']);

/** Everything a logger, a serialiser or an error handler could get at. */
function everythingRenderable(value: unknown): string {
  return [
    String(value),
    inspect(value, { depth: 10 }),
    (() => {
      try {
        return JSON.stringify(value) ?? '';
      } catch {
        return '';
      }
    })(),
  ].join('\n');
}

describe('log hygiene', () => {
  it('an API key never appears in a log line', async () => {
    const key = apiKeyOf('fred', SECRET);

    // The provider echoes our own query string back at us in an error body.
    // This is not hypothetical: it is how most APIs report a bad parameter.
    const transport = createFakeTransport(() =>
      jsonResponse(
        {
          error_code: 400,
          error_message: `Bad Request. Variable api_key is not a 32 character alpha-numeric lower-case string: ${SECRET}`,
        },
        400,
      ),
    );

    const fred = createFredSource({
      client: createProviderClient({
        provider: 'fred',
        policy: policyFor('fred'),
        transport: transport.transport,
        resolve: PUBLIC,
        keys: [key],
      }),
      key,
      now,
    });

    const outcome = await fred.fxRate('EUR', 'USD', '2026-09-21');

    // The call did happen and did fail — otherwise this proves nothing.
    expect(outcome.kind).toBe('error');
    expect(transport.requests).toHaveLength(1);

    // The key *was* on the wire, in the query string, because FRED leaves no
    // choice. That is the precondition for the claim, so assert it.
    const sent = transport.requests[0];
    expect(sent?.destination.path).toContain('api_key=');
    expect(sent?.destination.path).toContain(SECRET);

    // And it is in none of what came back out.
    const rendered = everythingRenderable(outcome);
    expect(rendered).not.toContain(SECRET);
    expect(rendered).toContain('[redacted]');
  });

  it('the key object renders as [redacted] in every string context', () => {
    const key = apiKeyOf('tiingo', SECRET);

    // The four ways a key escapes without anyone writing `key.reveal()`.
    expect(String(key)).toBe('[redacted]');
    expect(`${key}`).toBe('[redacted]');
    expect(JSON.stringify(key)).toBe('"[redacted]"');
    expect(JSON.stringify({ tiingo: key })).not.toContain(SECRET);
    // What a structured logger does to an object it does not recognise.
    expect(inspect(key)).not.toContain(SECRET);
    expect(inspect({ config: { key } }, { depth: 5 })).not.toContain(SECRET);

    // The one way to the plaintext is explicit and greppable.
    expect(key.reveal()).toBe(SECRET);
  });

  it('a missing key throws rather than revealing an empty string', () => {
    const absent = missingKey('coingecko');
    expect(absent.present).toBe(false);
    expect(() => absent.reveal()).toThrow(/no API key is configured/);
    expect(String(absent)).toBe('[redacted]');
    // An empty-string key would send `Authorization: Token ` and get a 401 that
    // looks like a bad key rather than an absent one.
    expect(apiKeyOf('coingecko', '   ').present).toBe(false);
  });

  it('a transport exception carrying the URL is redacted too', async () => {
    const key = apiKeyOf('fred', SECRET);
    const transport = createFakeTransport(() => {
      // A socket error whose message happens to include the full URL — the
      // shape a real `node:https` failure can take.
      throw new Error(`connect ETIMEDOUT https://api.stlouisfed.org/fred/x?api_key=${SECRET}`);
    });

    const client = createProviderClient({
      provider: 'fred',
      policy: policyFor('fred'),
      transport: transport.transport,
      resolve: PUBLIC,
      keys: [key],
    });

    const response = await client.send({
      method: 'GET',
      path: '/fred/series/observations',
      query: { api_key: key.reveal() },
    });

    expect(response.kind).toBe('transport_error');
    expect(everythingRenderable(response)).not.toContain(SECRET);
  });

  it('a header-authenticated provider never puts its key in a URL at all', async () => {
    // The contrast case. Tiingo also accepts `?token=`, and this package
    // deliberately does not use it: a key in a query string reaches access
    // logs, `Referer` headers and error bodies.
    const key = apiKeyOf('tiingo', SECRET);
    const transport = createFakeTransport(() => jsonResponse([]));
    const tiingo = createTiingoPriceSource({
      client: createProviderClient({
        provider: 'tiingo',
        policy: policyFor('tiingo'),
        transport: transport.transport,
        resolve: PUBLIC,
        keys: [key],
      }),
      key,
      now,
    });

    await tiingo.price({
      subject: { kind: 'ticker', symbol: 'AAPL', mic: null },
      date: '2026-09-21',
      currency: 'USD',
    });

    const sent = transport.requests[0];
    expect(sent?.destination.path).not.toContain(SECRET);
    expect(sent?.destination.path).not.toContain('token=');
    // It is in the header, where it belongs.
    expect(sent?.headers['authorization']).toBe(`Token ${SECRET}`);
  });

  it('redaction survives the key appearing more than once, and short keys are left alone', () => {
    const key = apiKeyOf('fred', SECRET);
    const text = `first ${SECRET} then ${SECRET} again`;
    const clean = redactSecrets(text, [key]);
    expect(clean).not.toContain(SECRET);
    expect(clean.match(/\[redacted\]/g)).toHaveLength(2);

    expect(redactedMessageOf(new Error(`boom ${SECRET}`), [key])).not.toContain(SECRET);

    // A two-character "key" would redact half of every sentence and make the
    // output less auditable, not more. The floor is 8.
    const tiny = apiKeyOf('x', 'ab');
    expect(redactSecrets('a cab and a crab', [tiny])).toBe('a cab and a crab');
  });

  it('SABOTAGE: without the redactor the key leaks, which is what this file prevents', () => {
    // The negative control. `redactSecrets` with no keys to redact is exactly
    // what the code would do if somebody forgot to thread `keys` through
    // `createProviderClient` — the single most likely way this protection is
    // lost, because it is an optional field.
    const key = apiKeyOf('fred', SECRET);
    const body = `Bad Request: api_key=${SECRET}`;

    expect(redactSecrets(body, [])).toContain(SECRET);
    expect(redactSecrets(body, [key])).not.toContain(SECRET);
  });

  it('SABOTAGE: a client built without its keys leaks the provider body', async () => {
    // The same omission, end to end through the real adapter. This is the test
    // that would have caught it in review.
    const key = apiKeyOf('fred', SECRET);
    const transport = createFakeTransport(() =>
      jsonResponse({ error_message: `bad api_key=${SECRET}` }, 400),
    );

    const leaky = createFredSource({
      client: createProviderClient({
        provider: 'fred',
        policy: policyFor('fred'),
        transport: transport.transport,
        resolve: PUBLIC,
        // `keys` omitted — the sabotage.
      }),
      key,
      now,
    });
    const leaked = await leaky.fxRate('EUR', 'USD', '2026-09-21');
    expect(everythingRenderable(leaked)).toContain(SECRET);

    const safe = createFredSource({
      client: createProviderClient({
        provider: 'fred',
        policy: policyFor('fred'),
        transport: createFakeTransport(() =>
          jsonResponse({ error_message: `bad api_key=${SECRET}` }, 400),
        ).transport,
        resolve: PUBLIC,
        keys: [key],
      }),
      key,
      now,
    });
    const clean = await safe.fxRate('EUR', 'USD', '2026-09-21');
    expect(everythingRenderable(clean)).not.toContain(SECRET);
  });
});
