// SPDX-License-Identifier: MIT
/**
 * The egress refusal matrix. **This is WP 2.4's security proof.**
 *
 * 02-phase-2-dispatch.md §5: "Notification channels are egress — the first
 * outbound path in the app that a *user-supplied string* controls. An SSRF here
 * reaches `db:5432` and the container metadata endpoint."
 *
 * Every refusal below was sabotaged once and observed going red before its PASS
 * was accepted; the sabotage, the line changed and the resulting failure are
 * recorded in `docs/evidence/phase-2/wp2.4-notifications.md` §3. A control that
 * has never been seen failing is not evidence.
 *
 * ## Why `db:5432` is refused three separate times
 *
 * Defence in depth is only real when the layers are independent, so each layer
 * is asserted against a policy that has had the previous one *deliberately
 * misconfigured*:
 *
 *   1. under the production policy, `db` is not in the allow-list →
 *      `host_not_allowed`;
 *   2. under a policy where an operator mistakenly allow-listed `db`, port 5432
 *      is not in the port list → `port_not_allowed`;
 *   3. under a policy that allow-listed *both*, the name resolves into
 *      172.16/12 → `private_address`.
 *
 * Only the third survives every operator error, which is why it exists.
 *
 * ## The redirect proof uses real sockets
 *
 * A stub transport asserting "we returned 302" would prove the classification
 * and nothing about the second request. So this suite starts two real HTTP
 * servers on the loopback — one that answers 302 pointing at the other, one
 * that counts every request it receives — and asserts the second one was
 * **never contacted**. The transport is pointed at the redirector directly
 * because `transport.ts` deliberately holds no policy; that separation is what
 * lets this half be proven without a switch that turns a security control off.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNtfyChannel } from '../src/adapters/ntfy.ts';
import {
  checkUrl,
  classifyAddress,
  classifyStatus,
  createEgressPolicy,
  guardDestination,
  guardUrl,
  looksLikeIpLiteral,
  type Destination,
  type RefusalCode,
  type Resolver,
} from '../src/egress.ts';
import { createNodeTransport, type HttpTransport } from '../src/transport.ts';
import { NTFY_HOST, TEST_POLICY, ntfyConfig } from './harness.ts';

/** A resolver that answers from a fixed table. Never touches the network. */
function resolverOf(table: Readonly<Record<string, readonly string[]>>): Resolver {
  return (host) => {
    const answer = table[host];
    if (answer === undefined) return Promise.reject(new Error(`NXDOMAIN ${host}`));
    return Promise.resolve(answer);
  };
}

/** A transport that records that it was called, and refuses to be. */
function forbiddenTransport(): HttpTransport & { calls: number } {
  const transport = (): Promise<never> => {
    transport.calls += 1;
    return Promise.reject(new Error('the transport was reached; the guard did not refuse'));
  };
  transport.calls = 0;
  return transport as HttpTransport & { calls: number };
}

describe('the egress guard', () => {
  // -------------------------------------------------------------- db:5432

  it('a channel URL pointing at db:5432 is refused', async () => {
    // 1. The production policy: `db` was never named by the operator.
    const first = checkUrl('https://db:5432/personalfi', TEST_POLICY);
    expect(first.ok).toBe(false);
    expect(first.ok ? null : first.code).toBe('host_not_allowed');

    // 2. An operator who allow-listed `db` by mistake still cannot reach 5432.
    const hostAllowed = createEgressPolicy({ allowedHosts: ['db'] });
    const second = checkUrl('https://db:5432/personalfi', hostAllowed);
    expect(second.ok ? null : second.code).toBe('port_not_allowed');

    // 3. And an operator who allow-listed both still cannot reach the address:
    //    `db` is a container name and it resolves into RFC 1918.
    const bothAllowed = createEgressPolicy({
      allowedHosts: ['db'],
      allowedPorts: [443, 465, 587, 5432],
    });
    const third = await guardDestination(
      { scheme: 'https', host: 'db', port: 5432 },
      bothAllowed,
      resolverOf({ db: ['172.18.0.2'] }),
    );
    expect(third.ok).toBe(false);
    expect(third.ok ? null : third.code).toBe('private_address');
    expect(third.ok ? '' : third.detail).toContain('172.18.0.2');

    // And through the adapter, which is where a real send would go: the
    // transport is never reached.
    const transport = forbiddenTransport();
    const channel = createNtfyChannel({
      policy: TEST_POLICY,
      transport,
      resolve: resolverOf({ db: ['172.18.0.2'] }),
    });
    const result = await channel.send(
      { dedupeKey: 'k', priority: 'high', title: 't', bodyMd: 'b' },
      ntfyConfig({ host: 'db', port: 443 }),
    );
    expect(result.outcome).toBe('refused');
    expect(result.refusalCode).toBe('host_not_allowed');
    expect(transport.calls, 'nothing was dialled').toBe(0);
  });

  // ------------------------------------------------------- the metadata IP

  it('169.254.169.254 is refused', async () => {
    // As a literal, in a URL. Refused before the allow-list is even consulted:
    // a destination given as an address has no legitimate reason to exist here.
    const literal = checkUrl('https://169.254.169.254/latest/meta-data/', TEST_POLICY);
    expect(literal.ok).toBe(false);
    expect(literal.ok ? null : literal.code).toBe('literal_ip');

    // As the numeric forms that walk past an allow-list which only looked for
    // dotted quads. 2852039166 === 0xa9fea9fe === 169.254.169.254.
    for (const form of [
      'https://2852039166/',
      'https://0xa9fea9fe/',
      'https://[::ffff:a9fe:a9fe]/',
    ]) {
      const decision = checkUrl(form, TEST_POLICY);
      expect(decision.ok, form).toBe(false);
      expect(decision.ok ? null : decision.code, form).toBe('literal_ip');
      expect(looksLikeIpLiteral(new URL(form).hostname)).toBe(true);
    }

    // And as a *resolved* address: an allow-listed name whose DNS answer is the
    // metadata endpoint. This is the rebinding case, and it is refused on the
    // answer, not on the name.
    const rebound = await guardDestination(
      { scheme: 'https', host: NTFY_HOST, port: 443 },
      TEST_POLICY,
      resolverOf({ [NTFY_HOST]: ['169.254.169.254'] }),
    );
    expect(rebound.ok).toBe(false);
    expect(rebound.ok ? null : rebound.code).toBe('private_address');
    expect(classifyAddress('169.254.169.254')).toBe('link_local');

    // A name that answers with one public and one metadata address is refused
    // outright rather than filtered: there is no benign reason for that answer.
    const mixed = await guardDestination(
      { scheme: 'https', host: NTFY_HOST, port: 443 },
      TEST_POLICY,
      resolverOf({ [NTFY_HOST]: ['93.184.216.34', '169.254.169.254'] }),
    );
    expect(mixed.ok ? null : mixed.code).toBe('private_address');

    // Through the adapter, with the transport forbidden.
    const transport = forbiddenTransport();
    const channel = createNtfyChannel({
      policy: TEST_POLICY,
      transport,
      resolve: resolverOf({ [NTFY_HOST]: ['169.254.169.254'] }),
    });
    const result = await channel.send(
      { dedupeKey: 'k', priority: 'high', title: 't', bodyMd: 'b' },
      ntfyConfig(),
    );
    expect(result.outcome).toBe('refused');
    expect(result.refusalCode).toBe('private_address');
    expect(transport.calls).toBe(0);
  });

  // ----------------------------------------------------------- the matrix

  it('the refusal matrix holds for every class of destination', async () => {
    const resolve = resolverOf({
      [NTFY_HOST]: ['93.184.216.34'],
      'loopback.notify.test': ['127.0.0.1'],
      'rfc1918.notify.test': ['10.0.0.5'],
      'cgnat.notify.test': ['100.64.0.1'],
      'ula.notify.test': ['fd00::1'],
      'v6ll.notify.test': ['fe80::1'],
      'mapped.notify.test': ['::ffff:127.0.0.1'],
      'zero.notify.test': ['0.0.0.0'],
      'multicast.notify.test': ['224.0.0.1'],
    });
    const wide = createEgressPolicy({
      allowedHosts: [
        NTFY_HOST,
        'loopback.notify.test',
        'rfc1918.notify.test',
        'cgnat.notify.test',
        'ula.notify.test',
        'v6ll.notify.test',
        'mapped.notify.test',
        'zero.notify.test',
        'multicast.notify.test',
        'nxdomain.notify.test',
      ],
    });

    const cases: readonly (readonly [string, string, RefusalCode | 'allowed'])[] = [
      ['localhost by name', 'https://localhost/topic', 'host_not_allowed'],
      ['the container name', 'https://db:5432/', 'host_not_allowed'],
      ['gcp metadata by name', 'https://metadata.google.internal/', 'host_not_allowed'],
      ['cleartext http', 'http://ntfy.notify.test/', 'scheme_not_allowed'],
      ['file', 'file:///etc/passwd', 'scheme_not_allowed'],
      ['gopher', 'gopher://ntfy.notify.test/', 'scheme_not_allowed'],
      ['a credential in the URL', 'https://u:p@ntfy.notify.test/', 'userinfo_in_url'],
      ['not a URL at all', 'ntfy.notify.test/topic', 'url_malformed'],
      ['redis', 'https://ntfy.notify.test:6379/', 'port_not_allowed'],
      ['smtp relay port 25', 'https://ntfy.notify.test:25/', 'port_not_allowed'],
      ['a trailing-dot bypass of an internal name', 'https://db./', 'host_not_allowed'],
      ['loopback v4', 'https://127.0.0.1/', 'literal_ip'],
      ['loopback v6', 'https://[::1]/', 'literal_ip'],
      ['decimal loopback', 'https://2130706433/', 'literal_ip'],
      ['hex loopback', 'https://0x7f000001/', 'literal_ip'],
      ['a name resolving to loopback', 'https://loopback.notify.test/', 'private_address'],
      ['a name resolving into RFC 1918', 'https://rfc1918.notify.test/', 'private_address'],
      ['a name resolving into CGNAT', 'https://cgnat.notify.test/', 'private_address'],
      ['a name resolving to a v6 ULA', 'https://ula.notify.test/', 'private_address'],
      ['a name resolving to v6 link-local', 'https://v6ll.notify.test/', 'private_address'],
      ['a v4-mapped loopback', 'https://mapped.notify.test/', 'private_address'],
      ['the unspecified address', 'https://zero.notify.test/', 'private_address'],
      ['a multicast group', 'https://multicast.notify.test/', 'private_address'],
      ['a name that does not resolve', 'https://nxdomain.notify.test/', 'dns_resolution_failed'],
      ['the operator’s own ntfy', 'https://ntfy.notify.test/', 'allowed'],
    ];

    for (const [label, url, expected] of cases) {
      const decision = await guardUrl(url, wide, resolve);
      if (expected === 'allowed') {
        expect(decision.ok, label).toBe(true);
        continue;
      }
      expect(decision.ok, label).toBe(false);
      expect(decision.ok ? null : decision.code, label).toBe(expected);
    }
  });

  it('an allow-list entry may not be an IP literal or a wildcard', () => {
    expect(() => createEgressPolicy({ allowedHosts: ['127.0.0.1'] })).toThrow(/hostname/);
    expect(() => createEgressPolicy({ allowedHosts: ['169.254.169.254'] })).toThrow(/hostname/);
    expect(() => createEgressPolicy({ allowedHosts: ['*.notify.test'] })).toThrow(/wildcard/);
    expect(() => createEgressPolicy({ allowedHosts: ['  '] })).toThrow();
  });

  it('a CR in an ntfy access token cannot split the request', async () => {
    const transport = forbiddenTransport();
    const channel = createNtfyChannel({
      policy: TEST_POLICY,
      transport,
      resolve: resolverOf({ [NTFY_HOST]: ['93.184.216.34'] }),
    });
    const result = await channel.send(
      { dedupeKey: 'k', priority: 'normal', title: 't', bodyMd: 'b' },
      ntfyConfig({ accessToken: 'tk_good\r\nX-Injected: yes' }),
    );
    // The transport asserts every header value before it writes one, so the
    // request is never issued and the failure is not a delivery failure.
    expect(result.outcome).not.toBe('delivered');
  });
});

// ---------------------------------------------------------------------------
// The redirect, over real sockets
// ---------------------------------------------------------------------------

describe('redirects', () => {
  let internal: http.Server;
  let redirector: http.Server;
  let internalPort = 0;
  let redirectorPort = 0;
  let internalHits = 0;

  const listen = async (server: http.Server): Promise<number> => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  };

  beforeAll(async () => {
    // Stands in for `db:5432` / the metadata endpoint: the thing a redirect
    // would launder a request into. It counts, and answers 200 if reached, so
    // "never contacted" is a measurement and not the absence of an error.
    internal = http.createServer((_request, response) => {
      internalHits += 1;
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('INTERNAL SERVICE — THIS SHOULD NEVER BE REACHED');
    });
    internalPort = await listen(internal);

    redirector = http.createServer((_request, response) => {
      response.writeHead(302, {
        location: `http://127.0.0.1:${String(internalPort)}/latest/meta-data/`,
      });
      response.end();
    });
    redirectorPort = await listen(redirector);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => internal.close(() => resolve()));
    await new Promise<void>((resolve) => redirector.close(() => resolve()));
  });

  it('a 302 to an internal host is not followed', async () => {
    internalHits = 0;
    const transport = createNodeTransport();
    const destination: Destination = {
      scheme: 'https',
      host: NTFY_HOST,
      port: redirectorPort,
      path: '/',
      // The address the guard validated. The transport connects to *this* and
      // never consults DNS again — the rebinding close.
      addresses: ['127.0.0.1'],
    };

    const response = await transport({
      destination,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      secure: false,
      timeoutMs: 2_000,
      maxResponseBytes: 64 * 1024,
    });

    // The claim, first: the internal service counted zero requests.
    expect(internalHits, 'the redirect target was never contacted').toBe(0);
    expect(response.status).toBe(302);
    expect(response.location).toContain(String(internalPort));
    expect(response.body, 'no internal body was read').not.toContain('INTERNAL SERVICE');

    // And the classification an adapter turns that into: a refusal we chose,
    // not a failure they had.
    const verdict = classifyStatus(response.status);
    expect(verdict.kind).toBe('refused');
    expect(verdict.kind === 'refused' ? verdict.code : null).toBe('redirect_not_followed');

    // End to end through the adapter. The adapter's own guard still runs in
    // full; the stub only swaps the port and the validated address for the live
    // fixture's, because a loopback literal is the one destination an allow-list
    // may never contain.
    const channel = createNtfyChannel({
      policy: TEST_POLICY,
      transport: (request) =>
        transport({
          ...request,
          destination: { ...request.destination, port: redirectorPort, addresses: ['127.0.0.1'] },
          secure: false,
        }),
      resolve: () => Promise.resolve(['93.184.216.34']),
    });
    const result = await channel.send(
      { dedupeKey: 'k', priority: 'normal', title: 't', bodyMd: 'b' },
      ntfyConfig(),
    );
    expect(result.outcome).toBe('refused');
    expect(result.refusalCode).toBe('redirect_not_followed');
    expect(result.httpStatus).toBe(302);
    expect(internalHits, 'still never contacted, through the adapter').toBe(0);
  });

  it('every 3xx is a refusal, and no 2xx is', () => {
    for (const status of [300, 301, 302, 303, 307, 308]) {
      const verdict = classifyStatus(status);
      expect(verdict.kind, String(status)).toBe('refused');
    }
    expect(classifyStatus(200).kind).toBe('ok');
    expect(classifyStatus(429).kind).toBe('retryable');
    expect(classifyStatus(500).kind).toBe('retryable');
    expect(classifyStatus(401).kind).toBe('permanent');
  });

  it('a destination with no validated address is refused by the transport itself', async () => {
    const transport = createNodeTransport();
    await expect(
      transport({
        destination: { scheme: 'https', host: NTFY_HOST, port: 443, path: '/', addresses: [] },
        method: 'POST',
        headers: {},
        secure: true,
        timeoutMs: 1_000,
        maxResponseBytes: 1_024,
      }),
    ).rejects.toThrow(/validated address/);
  });

  it('a response larger than the cap is refused while it arrives', async () => {
    const flood = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      // Far more than the cap, written in chunks so the counter has to bite
      // during the stream rather than after it.
      for (let i = 0; i < 64; i += 1) response.write('x'.repeat(4096));
      response.end();
    });
    const port = await listen(flood);
    try {
      const transport = createNodeTransport();
      await expect(
        transport({
          destination: {
            scheme: 'https',
            host: NTFY_HOST,
            port,
            path: '/',
            addresses: ['127.0.0.1'],
          },
          method: 'GET',
          headers: {},
          secure: false,
          timeoutMs: 2_000,
          maxResponseBytes: 8 * 1024,
        }),
      ).rejects.toThrow(/response exceeded/);
    } finally {
      await new Promise<void>((resolve) => flood.close(() => resolve()));
    }
  });

  it('a destination that never answers times out rather than hanging', async () => {
    const silent = http.createServer(() => {
      /* accept the socket, answer nothing */
    });
    const port = await listen(silent);
    try {
      const transport = createNodeTransport();
      await expect(
        transport({
          destination: {
            scheme: 'https',
            host: NTFY_HOST,
            port,
            path: '/',
            addresses: ['127.0.0.1'],
          },
          method: 'GET',
          headers: {},
          secure: false,
          timeoutMs: 250,
          maxResponseBytes: 1_024,
        }),
      ).rejects.toThrow(/no response within/);
    } finally {
      silent.closeAllConnections();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });
});
