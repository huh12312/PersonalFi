// SPDX-License-Identifier: MIT
/**
 * WP 5.2 part 1 — the local-endpoint policy (05-phase-5-dispatch.md §3). The
 * five exit-test names are verbatim; the rest pin the table in
 * `local-endpoint.ts`'s header. Every case that talks to a real socket
 * declares its own timeout (05 §3 rule 2).
 *
 * The resolver is injected everywhere: that is how a test says "this name
 * answers 93.184.216.34" without owning a DNS server, and it is exactly the
 * seam a rebinding attacker controls in production.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkLocalEndpoint,
  createLocalEndpointPolicy,
  createLocalEndpointTransport,
  guardLocalEndpoint,
  isLocalEndpointRefusedError,
  type LocalEndpointRefusalCode,
} from './local-endpoint.ts';

const SOCKET_TIMEOUT = 30_000;

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function listen(
  handler: http.RequestListener,
): Promise<{ port: number; server: http.Server }> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, server };
}

const fixed =
  (...answers: string[]) =>
  async (): Promise<readonly string[]> =>
    answers;

async function refusalOf(promise: Promise<unknown>): Promise<LocalEndpointRefusalCode> {
  try {
    await promise;
  } catch (error) {
    if (isLocalEndpointRefusedError(error)) return error.code;
    throw error;
  }
  throw new Error('expected a refusal, got a response');
}

describe('local-endpoint policy: addresses', () => {
  const policy = createLocalEndpointPolicy({ endpoint: 'ollama:11434' });

  it('a name resolving to any public address is refused', async () => {
    // Public alone.
    const alone = await guardLocalEndpoint(policy, fixed('93.184.216.34'));
    expect(alone).toMatchObject({ ok: false, code: 'public_address' });
    // Public beside private: the whole destination goes, never filtered down.
    const mixed = await guardLocalEndpoint(policy, fixed('172.18.0.5', '93.184.216.34'));
    expect(mixed).toMatchObject({ ok: false, code: 'public_address' });
    // A v6 public answer, and one wearing an IPv4-mapped hat.
    expect(await guardLocalEndpoint(policy, fixed('127.0.0.1', '2606:4700::1111'))).toMatchObject({
      ok: false,
      code: 'public_address',
    });
    expect(await guardLocalEndpoint(policy, fixed('::ffff:8.8.8.8'))).toMatchObject({
      ok: false,
      code: 'public_address',
    });
    // And the dial refuses before a socket is opened: nothing listens here.
    const transport = createLocalEndpointTransport(policy, {
      resolve: fixed('10.0.0.2', '1.1.1.1'),
    });
    expect(await refusalOf(transport.request({ method: 'GET', path: '/api/tags' }))).toBe(
      'public_address',
    );
    // The control: loopback and every RFC1918 / ULA range pass.
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.18.0.5',
      '192.168.1.20',
      'fd00::5',
      '::1',
    ]) {
      expect(await guardLocalEndpoint(policy, fixed(address))).toEqual({
        ok: true,
        addresses: [address],
      });
    }
  });

  it('link-local and the metadata range are refused although they are not public', async () => {
    for (const address of [
      '169.254.169.254', // the cloud metadata endpoint
      '169.254.0.1',
      'fe80::1',
      '100.100.100.200', // CGNAT (and Alibaba's metadata address)
      '0.0.0.0',
      '224.0.0.1',
      '240.0.0.1',
      '192.0.2.10', // documentation
      '::ffff:169.254.169.254',
    ]) {
      const decision = await guardLocalEndpoint(policy, fixed(address));
      expect(decision, address).toMatchObject({ ok: false, code: 'address_not_local' });
    }
    // One bad answer among good ones still refuses the whole name.
    expect(await guardLocalEndpoint(policy, fixed('172.18.0.5', '169.254.169.254'))).toMatchObject({
      ok: false,
      code: 'address_not_local',
    });
  });

  it('a name that does not resolve fails closed', async () => {
    const decision = await guardLocalEndpoint(policy, async () => {
      throw new Error('ENOTFOUND ollama');
    });
    expect(decision).toMatchObject({ ok: false, code: 'dns_resolution_failed' });
    expect(await guardLocalEndpoint(policy, fixed())).toMatchObject({
      ok: false,
      code: 'dns_resolution_failed',
    });
  });
});

describe('local-endpoint policy: the endpoint string', () => {
  it('a dotted hostname is refused unless remote is explicitly allowed, and then only over https', () => {
    // Local: a single label, http or https.
    expect(checkLocalEndpoint({ endpoint: 'ollama:11434' })).toMatchObject({
      ok: true,
      policy: { scheme: 'http', host: 'ollama', port: 11434, allowRemote: false },
    });
    expect(checkLocalEndpoint({ endpoint: 'http://localhost:11434' }).ok).toBe(true);
    // Dotted, remote not allowed: refused whatever the scheme.
    expect(checkLocalEndpoint({ endpoint: 'llm.lan:11434' })).toMatchObject({
      ok: false,
      code: 'host_not_allowed',
    });
    expect(checkLocalEndpoint({ endpoint: 'https://llm.lan:443' })).toMatchObject({
      ok: false,
      code: 'host_not_allowed',
    });
    // A trailing dot is still dotted once it is stripped? No — `ollama.` IS
    // `ollama` (the DNS root); it stays single-label and is allowed.
    expect(checkLocalEndpoint({ endpoint: 'http://ollama.:11434' })).toMatchObject({
      ok: true,
      policy: { host: 'ollama' },
    });
    // Remote allowed: http refused, even for a single label.
    expect(
      checkLocalEndpoint({ endpoint: 'http://llm.lan:11434', allowRemote: true }),
    ).toMatchObject({ ok: false, code: 'scheme_not_allowed' });
    expect(checkLocalEndpoint({ endpoint: 'llm.lan:11434', allowRemote: true })).toMatchObject({
      ok: false,
      code: 'scheme_not_allowed',
    });
    expect(checkLocalEndpoint({ endpoint: 'ollama:11434', allowRemote: true })).toMatchObject({
      ok: false,
      code: 'scheme_not_allowed',
    });
    // Remote allowed, https: accepted.
    expect(
      checkLocalEndpoint({ endpoint: 'https://llm.lan:8443', allowRemote: true }),
    ).toMatchObject({
      ok: true,
      policy: { scheme: 'https', host: 'llm.lan', port: 8443, allowRemote: true },
    });
    // And the throwing form a composition root uses.
    expect(() => createLocalEndpointPolicy({ endpoint: 'llm.lan:11434' })).toThrow(
      /host_not_allowed/,
    );
  });

  it('literals, credentials, paths and foreign schemes are refused before anything resolves', () => {
    const cases: [string, LocalEndpointRefusalCode][] = [
      ['127.0.0.1:11434', 'literal_ip'],
      ['http://[::1]:11434', 'literal_ip'],
      ['http://2130706433:11434', 'literal_ip'],
      ['http://0x7f000001:11434', 'literal_ip'],
      ['http://user:pw@ollama:11434', 'userinfo_in_url'],
      ['http://ollama:11434/api', 'url_malformed'],
      ['http://ollama:11434/?x=1', 'url_malformed'],
      ['ftp://ollama:21', 'scheme_not_allowed'],
      ['file:///etc/passwd', 'scheme_not_allowed'],
      ['', 'url_malformed'],
      ['ollama :11434', 'url_malformed'],
      ['oll_ama:11434', 'host_not_allowed'],
    ];
    for (const [endpoint, code] of cases) {
      expect(checkLocalEndpoint({ endpoint }), endpoint).toMatchObject({ ok: false, code });
    }
  });
});

describe('local-endpoint transport: the dial', () => {
  it(
    'a redirect is never followed',
    async () => {
      let targetHits = 0;
      const target = await listen((_req, res) => {
        targetHits += 1;
        res.end('{"reached":"the redirect target"}');
      });
      const origin = await listen((_req, res) => {
        res.writeHead(302, { location: `http://127.0.0.1:${String(target.port)}/api/tags` });
        res.end('moved');
      });
      const transport = createLocalEndpointTransport(
        createLocalEndpointPolicy({ endpoint: `ollama:${String(origin.port)}` }),
        { resolve: fixed('127.0.0.1') },
      );
      expect(await refusalOf(transport.request({ method: 'GET', path: '/api/tags' }))).toBe(
        'redirect_not_followed',
      );
      // 301, 307 and 308 as well — none of them is a status Ollama sends.
      for (const status of [301, 307, 308]) {
        const other = await listen((_req, res) => {
          res.writeHead(status, { location: `http://127.0.0.1:${String(target.port)}/` });
          res.end();
        });
        const t = createLocalEndpointTransport(
          createLocalEndpointPolicy({ endpoint: `ollama:${String(other.port)}` }),
          { resolve: fixed('127.0.0.1') },
        );
        expect(await refusalOf(t.request({ method: 'POST', path: '/api/chat', body: '{}' }))).toBe(
          'redirect_not_followed',
        );
      }
      expect(targetHits).toBe(0);
    },
    SOCKET_TIMEOUT,
  );

  it(
    'the connection goes to the address that was checked, not a second resolution',
    async () => {
      const seen: string[] = [];
      const server = await listen((req, res) => {
        seen.push(`${req.socket.remoteAddress ?? '?'} ${req.headers.host ?? '?'}`);
        res.end('{"models":[]}');
      });
      // The rebinding resolver: the first answer is the one the guard checks,
      // every later one is public. `ollama` is a name this host's own DNS
      // does not know, so if the dial resolved again through the OS it would
      // fail outright rather than reach the server.
      let calls = 0;
      const rebinding = async (host: string): Promise<readonly string[]> => {
        expect(host).toBe('ollama');
        calls += 1;
        return calls === 1 ? ['127.0.0.1'] : ['93.184.216.34'];
      };
      const transport = createLocalEndpointTransport(
        createLocalEndpointPolicy({ endpoint: `ollama:${String(server.port)}` }),
        { resolve: rebinding },
      );

      const response = await transport.request({ method: 'GET', path: '/api/tags' });
      expect(response.status).toBe(200);
      expect(response.address).toBe('127.0.0.1');
      expect(calls).toBe(1); // resolved once, by the guard — never by the socket layer
      expect(seen).toEqual([`127.0.0.1 ollama:${String(server.port)}`]);

      // The next request is guarded afresh, sees the rebound (public) answer
      // and refuses without dialling anything.
      expect(await refusalOf(transport.request({ method: 'GET', path: '/api/tags' }))).toBe(
        'public_address',
      );
      expect(calls).toBe(2);
      expect(seen).toHaveLength(1);
    },
    SOCKET_TIMEOUT,
  );

  it(
    'a body over the cap is aborted while it arrives, not after it is buffered',
    async () => {
      let closed = false;
      let written = 0;
      const server = await listen((req, res) => {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        const chunk = Buffer.alloc(1024, 0x61);
        const timer = setInterval(() => {
          written += chunk.length;
          res.write(chunk);
        }, 2);
        req.socket.on('close', () => {
          closed = true;
          clearInterval(timer);
        });
      });
      const transport = createLocalEndpointTransport(
        createLocalEndpointPolicy({
          endpoint: `ollama:${String(server.port)}`,
          maxResponseBytes: 16_384,
        }),
        { resolve: fixed('127.0.0.1') },
      );
      expect(await refusalOf(transport.request({ method: 'GET', path: '/api/tags' }))).toBe(
        'response_too_large',
      );
      await expect.poll(() => closed, { timeout: 5_000 }).toBe(true);
      // The server kept writing until the socket went; it went early.
      expect(written).toBeLessThan(16_384 * 8);
    },
    SOCKET_TIMEOUT,
  );

  it(
    'the deadline and the caller’s signal both destroy the socket',
    async () => {
      let closes = 0;
      const server = await listen((req, res) => {
        res.writeHead(200);
        res.write('{"partial":');
        req.socket.on('close', () => {
          closes += 1;
        });
      });
      const policy = createLocalEndpointPolicy({
        endpoint: `ollama:${String(server.port)}`,
        timeoutMs: 300,
      });
      const transport = createLocalEndpointTransport(policy, { resolve: fixed('127.0.0.1') });
      expect(await refusalOf(transport.request({ method: 'GET', path: '/api/tags' }))).toBe(
        'timeout',
      );

      const controller = new AbortController();
      const slow = createLocalEndpointTransport(
        createLocalEndpointPolicy({ endpoint: `ollama:${String(server.port)}` }),
        { resolve: fixed('127.0.0.1') },
      );
      const pending = slow.request({ method: 'GET', path: '/api/tags', signal: controller.signal });
      setTimeout(() => controller.abort(), 100);
      expect(await refusalOf(pending)).toBe('aborted');
      await expect.poll(() => closes, { timeout: 5_000 }).toBe(2);

      // An already-aborted signal never dials.
      expect(
        await refusalOf(slow.request({ method: 'GET', path: '/', signal: AbortSignal.abort() })),
      ).toBe('aborted');
    },
    SOCKET_TIMEOUT,
  );

  it('a path or header the adapter did not build is refused', async () => {
    const transport = createLocalEndpointTransport(
      createLocalEndpointPolicy({ endpoint: 'ollama:11434' }),
      { resolve: fixed('127.0.0.1') },
    );
    for (const path of ['api/tags', '//evil.example/x', '/api/tags?x=1', '/a b', '/a\r\nHost: x']) {
      expect(await refusalOf(transport.request({ method: 'GET', path })), path).toBe(
        'path_not_allowed',
      );
    }
    expect(
      await refusalOf(
        transport.request({ method: 'GET', path: '/api/tags', headers: { 'x-a': 'b\r\nc: d' } }),
      ),
    ).toBe('header_not_allowed');
  });
});
