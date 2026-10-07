// SPDX-License-Identifier: MIT
/**
 * WP 9.11, gap G-27 (High): every outbound TLS client refuses a server whose
 * certificate it cannot verify.
 *
 * WP 9.10's SAB-34 set `rejectUnauthorized: false` in the shared egress
 * transport and 219 tests across 29 files stayed green: nothing in the tree
 * stood up a TLS server with an untrusted certificate. This file does. One
 * loopback server per protocol, holding a freshly minted self-signed
 * certificate, and each of the shipped clients is pointed at it:
 *
 * | client | carries | shipped construction used here |
 * |---|---|---|
 * | `createNodeTransport()` (`@core/platform`) | ntfy, market data, Esplora/Etherscan | the factory `domain.ts` calls |
 * | `createLocalEndpointTransport()` | the local model over `https` (`LOCAL_MODEL_ALLOW_REMOTE`) | the factory `modules.ts`/`worker.ts` call |
 * | `createPlaidApi()` (`@connector/plaid`, axios) | Plaid access tokens (A3) | the factory `domain.ts` calls; only the base URL is re-pointed |
 * | `fetchTransport()` (`@connector/coinbase`, undici) | Coinbase JWTs (A1) | the transport `domain.ts` registers |
 * | `createSmtpChannel()` (`@ctx/notifications`, nodemailer) | the SMTP password | the shipped adapter; the factory is wrapped only to re-point the dialled address |
 *
 * Each case asserts three things, so none of them can pass for the wrong
 * reason (G-16's lesson — a test that passes with the control removed is not a
 * test):
 *
 * 1. **the positive control** — the same server *does* complete a handshake
 *    for a client that trusts its certificate, so a refusal below is about
 *    trust, not a dead server;
 * 2. **the refusal** — the shipped client rejects, with a certificate error;
 * 3. **nothing reached the server** — no TLS session completed, so no request
 *    line, header or body (a bearer token, a Plaid secret, an SMTP password)
 *    was ever written to the untrusted peer.
 *
 * And one structural guard: `NODE_TLS_REJECT_UNAUTHORIZED` — the process-wide
 * switch that would turn off every client above at once — is set nowhere in
 * the shipped composition (compose, Dockerfiles, `.env.example`, shipped
 * source), and is not set in this process either (otherwise the cases below
 * would be testing nothing).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createEgressPolicy,
  createLocalEndpointPolicy,
  createLocalEndpointTransport,
  createNodeTransport,
  isLocalEndpointRefusedError,
} from '@core/platform';
import { createPlaidApi } from '@connector/plaid';
import { fetchTransport } from '@connector/coinbase';
import { createSmtpChannel, type SmtpTransportOptions } from '@ctx/notifications';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SOCKET_TIMEOUT = 30_000;

/** The certificate errors Node/OpenSSL raise for an untrusted self-signed leaf. */
const CERT_ERROR =
  /self[- ]signed|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|unable to verify|UNABLE_TO_VERIFY_LEAF_SIGNATURE|certificate/i;

interface Pki {
  readonly dir: string;
  readonly key: string;
  readonly cert: string;
}

/**
 * A throwaway self-signed certificate for `localhost` and 127.0.0.1, minted
 * with the `openssl` CLI at test time (Node has no certificate builder, and a
 * committed private key would be a gitleaks finding for no gain).
 */
function mintSelfSigned(): Pki {
  const dir = mkdtempSync(join(tmpdir(), 'wp911-tls-'));
  const result = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,DNS:ntfy.wp911.test,DNS:llm.wp911.test,DNS:mail.wp911.test,IP:127.0.0.1',
    ],
    { encoding: 'utf8', timeout: 20_000 },
  );
  if (result.status !== 0) {
    throw new Error(`openssl failed (${String(result.status)}): ${result.stderr}`);
  }
  return {
    dir,
    key: readFileSync(join(dir, 'key.pem'), 'utf8'),
    cert: readFileSync(join(dir, 'cert.pem'), 'utf8'),
  };
}

interface Observed {
  /** TLS sessions that completed a handshake. */
  handshakes: number;
  /** HTTP requests (or SMTP greetings) the server got as far as handling. */
  requests: number;
  /** Bytes of application data received after a handshake. */
  bytes: number;
}

let pki: Pki;
let httpsServer: https.Server;
let httpsPort = 0;
let smtpsServer: tls.Server;
let smtpsPort = 0;
const seen: { https: Observed; smtps: Observed } = {
  https: { handshakes: 0, requests: 0, bytes: 0 },
  smtps: { handshakes: 0, requests: 0, bytes: 0 },
};

function reset(): void {
  for (const o of Object.values(seen)) {
    o.handshakes = 0;
    o.requests = 0;
    o.bytes = 0;
  }
}

beforeAll(async () => {
  pki = mintSelfSigned();

  httpsServer = https.createServer({ key: pki.key, cert: pki.cert }, (request, response) => {
    seen.https.requests += 1;
    request.on('data', (chunk: Buffer) => {
      seen.https.bytes += chunk.length;
    });
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
  });
  httpsServer.on('secureConnection', () => {
    seen.https.handshakes += 1;
  });
  await new Promise<void>((resolve) => httpsServer.listen(0, '127.0.0.1', resolve));
  httpsPort = (httpsServer.address() as AddressInfo).port;

  // Implicit-TLS SMTP (`smtps`, 465's shape): TLS from the first byte, then a
  // greeting. A client that completed the handshake would read the greeting
  // and write EHLO; neither may happen.
  smtpsServer = tls.createServer({ key: pki.key, cert: pki.cert }, (socket) => {
    seen.smtps.handshakes += 1;
    seen.smtps.requests += 1;
    socket.on('data', (chunk: Buffer) => {
      seen.smtps.bytes += chunk.length;
      // A client that got this far is already a failure; hang up so the case
      // fails on its assertions, not on a timeout.
      socket.end('421 closing\r\n');
    });
    socket.on('error', () => undefined);
    socket.write('220 mail.wp911.test ESMTP\r\n');
  });
  smtpsServer.on('tlsClientError', () => undefined);
  await new Promise<void>((resolve) => smtpsServer.listen(0, '127.0.0.1', resolve));
  smtpsPort = (smtpsServer.address() as AddressInfo).port;
}, 30_000);

afterAll(async () => {
  httpsServer.closeAllConnections();
  await new Promise<void>((resolve) => httpsServer.close(() => resolve()));
  await new Promise<void>((resolve) => smtpsServer.close(() => resolve()));
  rmSync(pki.dir, { recursive: true, force: true });
});

/** The positive control: a client that trusts the certificate gets through. */
async function trustedHttpsGet(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const request = https.request(
      {
        host: '127.0.0.1',
        port: httpsPort,
        path: '/control',
        method: 'GET',
        servername: 'localhost',
        ca: pki.cert,
        agent: false,
      },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
      },
    );
    request.on('error', reject);
    request.end();
  });
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return null;
}

function describeError(error: unknown): string {
  if (error === null || error === undefined) return 'no error: the request succeeded';
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof Error) {
      const code = (current as Error & { code?: unknown }).code;
      parts.push(`${current.message}${typeof code === 'string' ? ` [${code}]` : ''}`);
      current = (current as Error & { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(' <- ');
}

describe('G-27: the positive control', () => {
  it(
    'the loopback servers complete a handshake for a client that trusts the certificate',
    async () => {
      reset();
      expect(await trustedHttpsGet()).toBe(200);
      expect(seen.https.handshakes).toBe(1);
      expect(seen.https.requests).toBe(1);

      await new Promise<void>((resolve, reject) => {
        const socket = tls.connect(
          { host: '127.0.0.1', port: smtpsPort, servername: 'localhost', ca: pki.cert },
          () => {
            socket.end();
            resolve();
          },
        );
        socket.on('error', reject);
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(seen.smtps.handshakes).toBe(1);
    },
    SOCKET_TIMEOUT,
  );

  it('NODE_TLS_REJECT_UNAUTHORIZED is not set in this process', () => {
    // If it were '0', every refusal below would be the environment's doing —
    // or rather every case would fail, and for the wrong reason.
    expect(process.env['NODE_TLS_REJECT_UNAUTHORIZED']).toBeUndefined();
  });
});

describe('G-27: every outbound TLS client refuses an untrusted certificate', () => {
  it(
    'the shared egress transport (ntfy, market data, Esplora) refuses it and writes nothing',
    async () => {
      reset();
      const transport = createNodeTransport();
      const error = await errorOf(
        transport({
          destination: {
            scheme: 'https',
            host: 'ntfy.wp911.test',
            port: httpsPort,
            path: '/topic',
            addresses: ['127.0.0.1'],
          },
          method: 'POST',
          headers: { authorization: 'Bearer tk_must_never_reach_the_peer' },
          body: 'a notification body',
          secure: true,
          timeoutMs: 5_000,
          maxResponseBytes: 4_096,
        }),
      );
      expect(describeError(error)).toMatch(CERT_ERROR);
      expect(seen.https).toEqual({ handshakes: 0, requests: 0, bytes: 0 });
    },
    SOCKET_TIMEOUT,
  );

  it(
    'the local-endpoint transport (a remote https model) refuses it and writes nothing',
    async () => {
      reset();
      const policy = createLocalEndpointPolicy({
        endpoint: `https://llm.wp911.test:${String(httpsPort)}`,
        allowRemote: true,
        timeoutMs: 5_000,
      });
      const transport = createLocalEndpointTransport(policy, {
        resolve: async () => ['127.0.0.1'],
      });
      const error = await errorOf(
        transport.request({ method: 'POST', path: '/api/chat', body: '{"prompt":"finances"}' }),
      );
      expect(isLocalEndpointRefusedError(error)).toBe(true);
      expect(describeError(error)).toMatch(CERT_ERROR);
      expect(seen.https).toEqual({ handshakes: 0, requests: 0, bytes: 0 });
    },
    SOCKET_TIMEOUT,
  );

  it(
    'the Plaid client (axios, as createPlaidApi builds it) refuses it and sends no secret',
    async () => {
      reset();
      const api = createPlaidApi({
        clientId: 'client_id_must_never_reach_the_peer',
        secret: 'secret_must_never_reach_the_peer',
        environment: 'sandbox',
      });
      // The one change: the base URL. Everything else — headers, axios
      // defaults, any agent — is exactly what `createPlaidApi` built.
      const configured = api as unknown as { configuration: { basePath: string } };
      configured.configuration.basePath = `https://localhost:${String(httpsPort)}`;
      const error = await errorOf(api.itemGet({ access_token: 'access-sandbox-never-sent' }));
      expect(describeError(error)).toMatch(CERT_ERROR);
      expect(seen.https).toEqual({ handshakes: 0, requests: 0, bytes: 0 });
    },
    SOCKET_TIMEOUT,
  );

  it(
    'the Coinbase transport (fetch) refuses it and sends no bearer token',
    async () => {
      reset();
      const transport = fetchTransport();
      const error = await errorOf(
        transport({
          method: 'GET',
          host: `localhost:${String(httpsPort)}`,
          path: '/api/v3/brokerage/key_permissions',
          query: {},
          headers: { Authorization: 'Bearer jwt-must-never-reach-the-peer' },
          signal: null,
          timeoutMs: 5_000,
        }),
      );
      expect(describeError(error)).toMatch(CERT_ERROR);
      expect(seen.https).toEqual({ handshakes: 0, requests: 0, bytes: 0 });
    },
    SOCKET_TIMEOUT,
  );

  it(
    'the SMTP adapter (nodemailer, implicit TLS) refuses it and sends no EHLO or password',
    async () => {
      reset();
      // nodemailer is a dependency of @ctx/notifications only; resolve it from
      // there rather than adding it to the api's manifest.
      const fromNotifications = createRequire(
        join(REPO_ROOT, 'packages/contexts/notifications/package.json'),
      );
      const nodemailer = fromNotifications('nodemailer') as {
        createTransport(options: Record<string, unknown>): {
          verify(): Promise<boolean>;
          sendMail(message: unknown): Promise<{ messageId?: string }>;
          close(): void;
        };
      };
      let handed: SmtpTransportOptions | null = null;
      const channel = createSmtpChannel({
        policy: createEgressPolicy({ allowedHosts: ['mail.wp911.test'] }),
        resolve: async () => ['93.184.216.34'],
        // The adapter's own options — TLS block included — reach nodemailer
        // untouched; only the dialled address and port are re-pointed at the
        // loopback server (the public policy, rightly, will not dial it).
        createTransport: (options) => {
          handed = options;
          return nodemailer.createTransport({
            ...options,
            host: '127.0.0.1',
            port: smtpsPort,
            pool: false,
          });
        },
      });
      const result = await channel.verify({
        kind: 'smtp',
        scheme: 'smtps',
        host: 'mail.wp911.test',
        port: 465,
        username: 'holder',
        password: 'smtp-password-must-never-reach-the-peer',
        from: 'pf@wp911.test',
        to: 'holder@wp911.test',
      });
      expect(handed).not.toBeNull();
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).toMatch(CERT_ERROR);
      expect(seen.smtps).toEqual({ handshakes: 0, requests: 0, bytes: 0 });
    },
    SOCKET_TIMEOUT,
  );
});

describe('G-27: the process-wide switch is off everywhere it could be turned on', () => {
  it('NODE_TLS_REJECT_UNAUTHORIZED appears in no compose file, Dockerfile, env example or shipped source', () => {
    const roots = ['compose.yml', '.env.example', 'docker', 'apps/api/src', 'packages'];
    const offenders: string[] = [];
    const visit = (path: string): void => {
      const stat = statSync(path);
      if (stat.isDirectory()) {
        const name = path.split('/').pop() ?? '';
        if (name === 'node_modules' || name === 'test' || name === 'dist') return;
        for (const entry of readdirSync(path)) visit(join(path, entry));
        return;
      }
      if (/\.test\.ts$/.test(path)) return;
      if (!/(\.ts|\.js|\.yml|\.yaml|\.sh|Dockerfile|Caddyfile|\.example)$/.test(path)) return;
      if (readFileSync(path, 'utf8').includes('NODE_TLS_REJECT_UNAUTHORIZED')) {
        offenders.push(relative(REPO_ROOT, path));
      }
    };
    for (const root of roots) visit(join(REPO_ROOT, root));
    expect(offenders).toEqual([]);
  }, 30_000);
});
