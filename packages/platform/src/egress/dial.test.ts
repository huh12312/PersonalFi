// SPDX-License-Identifier: MIT
/**
 * WP 9.11 — the one dialer (G-24) and the header refusal that can fail (G-16).
 *
 * G-24: 03 §5.2's warning is that the second implementation of an allow-list
 * is where the hole is, and WP 9.10 found two copies of the dial whose header
 * rules had already drifted. `dial.ts` is now the only file in shipped source
 * that opens an HTTP(S) or TLS connection itself; the structural case below
 * fails the moment a second one appears.
 *
 * G-16: WP 9.10's SAB-28 removed the CR/LF refusal and the one test that named
 * it stayed green, because it injected a transport that refused everything.
 * These cases drive the **real** `createNodeTransport()` and
 * `createLocalEndpointTransport()` at a real loopback server, with a positive
 * control on the same server, and assert that a CR, LF or NUL in a header
 * value is refused with `header_not_allowed` **and that the server accepted
 * no connection at all** — not one byte reached the wire.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { headerProblem } from './dial.ts';
import {
  createLocalEndpointPolicy,
  createLocalEndpointTransport,
  isLocalEndpointRefusedError,
} from './local-endpoint.ts';
import { isEgressRefusedError } from './policy.ts';
import { createNodeTransport } from './transport.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SOCKET_TIMEOUT = 30_000;

// ---------------------------------------------------------------------------
// G-24: the tree has one dialer
// ---------------------------------------------------------------------------

/** Shipped source: every `src/` under `packages/` and `apps/api`, tests excluded. */
function shippedSourceFiles(): string[] {
  const files: string[] = [];
  const visit = (path: string, insideSrc: boolean): void => {
    const name = path.split('/').pop() ?? '';
    if (name === 'node_modules' || name === 'dist' || name === 'test' || name === 'e2e') return;
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) visit(join(path, entry), insideSrc || name === 'src');
      return;
    }
    if (!insideSrc || !/\.(ts|js|mjs|cjs)$/u.test(name) || /\.test\.ts$/u.test(name)) return;
    files.push(path);
  };
  visit(join(REPO_ROOT, 'packages'), false);
  visit(join(REPO_ROOT, 'apps/api'), false);
  return files;
}

/** Node's client modules: whoever imports one of these can open a socket. */
const CLIENT_MODULE =
  /\bfrom\s+['"](?:node:)?(?:http|https|http2|tls)['"]|require\(\s*['"](?:node:)?(?:http|https|http2|tls)['"]\s*\)|\bfrom\s+['"]undici['"]/u;
/** A hand-rolled resolver override is the other half of a second dialer. */
const LOOKUP_OVERRIDE = /\blookup\s*:\s*(?!undefined)[A-Za-z_(]/u;

describe('G-24: one dialer', () => {
  it(
    'dial.ts is the only shipped file that imports a socket-level client or overrides lookup',
    () => {
      const files = shippedSourceFiles();
      // Sanity: the scan sees the tree (a wrong root would pass vacuously).
      expect(files.length).toBeGreaterThan(200);
      const dialers = files
        .filter((file) => {
          const text = readFileSync(file, 'utf8');
          return CLIENT_MODULE.test(text) || LOOKUP_OVERRIDE.test(text);
        })
        .map((file) => relative(REPO_ROOT, file))
        .sort();
      expect(dialers).toEqual(['packages/platform/src/egress/dial.ts']);
    },
    SOCKET_TIMEOUT,
  );

  it('one header rule: names are plain tokens, values carry no CR, LF or NUL', () => {
    expect(headerProblem('authorization', 'Bearer tk_ok')).toBeNull();
    expect(headerProblem('x-cg-demo-api-key', 'k')).toBeNull();
    expect(headerProblem('authorization', 'tk\r\nX-Injected: yes')).toMatch(/control character/);
    expect(headerProblem('authorization', 'tk\nX')).toMatch(/control character/);
    expect(headerProblem('authorization', 'tk\0')).toMatch(/control character/);
    expect(headerProblem('x\r\ninjected', 'v')).toMatch(/plain header name/);
    expect(headerProblem('x injected', 'v')).toMatch(/plain header name/);
    expect(headerProblem('authorization', 'a'.repeat(4097))).toMatch(/implausibly long/);
  });
});

// ---------------------------------------------------------------------------
// G-16: the refusal, through the real transports, against a real server
// ---------------------------------------------------------------------------

let server: http.Server;
let port = 0;
let connections = 0;
let requests = 0;

beforeAll(async () => {
  server = http.createServer((request, response) => {
    requests += 1;
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
  });
  server.on('connection', () => {
    connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
}, 30_000);

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  connections = 0;
  requests = 0;
});

const INJECTIONS: readonly string[] = [
  'tk_good\r\nX-Injected: yes',
  'tk_good\nX-Injected: yes',
  'tk_good\rX-Injected: yes',
  'tk_good\0',
];

function publicTransportCall(authorization: string): Promise<unknown> {
  return createNodeTransport()({
    destination: {
      scheme: 'https',
      host: 'ntfy.wp911.test',
      port,
      path: '/topic',
      addresses: ['127.0.0.1'],
    },
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: '{"m":1}',
    // Cleartext so the positive control can complete against a plain server;
    // the header check runs before the scheme matters.
    secure: false,
    timeoutMs: 5_000,
    maxResponseBytes: 4_096,
  });
}

function localTransportCall(authorization: string): Promise<unknown> {
  const transport = createLocalEndpointTransport(
    createLocalEndpointPolicy({ endpoint: `http://ollama:${String(port)}`, timeoutMs: 5_000 }),
    { resolve: async () => ['127.0.0.1'] },
  );
  return transport.request({
    method: 'POST',
    path: '/api/chat',
    headers: { authorization },
    body: '{}',
  });
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (isEgressRefusedError(error) || isLocalEndpointRefusedError(error)) return error.code;
    throw error;
  }
  return 'delivered';
}

describe('G-16: a CR, LF or NUL in a header value never reaches the wire', () => {
  it(
    'positive control: a clean header goes through both transports to the same server',
    async () => {
      expect(await codeOf(publicTransportCall('Bearer tk_good'))).toBe('delivered');
      expect(await codeOf(localTransportCall('Bearer tk_good'))).toBe('delivered');
      expect(requests).toBe(2);
      expect(connections).toBe(2);
    },
    SOCKET_TIMEOUT,
  );

  it(
    'the shared egress transport refuses it with header_not_allowed and opens no connection',
    async () => {
      for (const value of INJECTIONS) {
        expect(await codeOf(publicTransportCall(value)), JSON.stringify(value)).toBe(
          'header_not_allowed',
        );
      }
      // Give a stray socket time to land before counting.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(connections).toBe(0);
      expect(requests).toBe(0);
    },
    SOCKET_TIMEOUT,
  );

  it(
    'the local-endpoint transport refuses it with header_not_allowed and opens no connection',
    async () => {
      for (const value of INJECTIONS) {
        expect(await codeOf(localTransportCall(value)), JSON.stringify(value)).toBe(
          'header_not_allowed',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(connections).toBe(0);
      expect(requests).toBe(0);
    },
    SOCKET_TIMEOUT,
  );
});
