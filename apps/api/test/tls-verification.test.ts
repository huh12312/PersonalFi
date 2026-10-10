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
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

/**
 * G9-6 (Phase 9 gate, High): the **hostname** half of G-27.
 *
 * The cases above hand every client a self-signed certificate it does not
 * trust, so chain validation refuses first and the hostname check is never
 * reached: `checkServerIdentity: () => undefined` in `dial.ts` or in the Plaid
 * client left all of them green (gate sabotages T1 and T2), and that one line
 * would send a Plaid secret or a bearer token to any peer holding any publicly
 * trusted certificate for any other name.
 *
 * So here the chain is **valid**. A throwaway CA is minted at runtime and added
 * to the process's default trust store (`tls.setDefaultCACertificates`, Node
 * 24.5+, the repo's pinned Node is 26); every shipped client below is the real
 * one and trusts it exactly as it would trust a public CA. Two loopback servers
 * hold leaves signed by that CA:
 *
 * - the **right-name** server: a leaf for the names the clients dial. Each
 *   client completes a request against it (the positive control: the CA is
 *   trusted, the server is alive, the client works), so a refusal below is
 *   about the name and nothing else;
 * - the **wrong-name** server: a leaf for `evil.test` only. The same client,
 *   the same dial parameters, only the port differs: it must refuse with a
 *   hostname error (`ERR_TLS_CERT_ALTNAME_INVALID`, not a chain error) and
 *   **nothing application-level may reach the peer** — no request, no body, no
 *   byte of application data after the handshake.
 *
 * Sabotage run by hand (gate-conditions-c9-1-2-9.md): `dial.ts`'s
 * `TLS_CLIENT_OPTIONS` gains `checkServerIdentity: () => undefined` (T1) and
 * `createPlaidApi` gains an `httpsAgent` doing the same (T2); each turns its
 * case red.
 */
describe('G9-6: every outbound TLS client refuses a certificate for another name', () => {
  const NAME_ERROR =
    /ERR_TLS_CERT_ALTNAME_INVALID|does not match certificate'?s? altnames|Hostname\/IP does not match|altname/i;

  interface Ca {
    readonly dir: string;
    readonly cert: string;
  }
  interface Leaf {
    readonly key: string;
    readonly cert: string;
  }

  function openssl(args: readonly string[], cwd: string): void {
    const result = spawnSync('openssl', [...args], { encoding: 'utf8', timeout: 20_000, cwd });
    if (result.status !== 0) {
      throw new Error(
        `openssl ${args[0] ?? ''} failed (${String(result.status)}): ${result.stderr}`,
      );
    }
  }

  /** A CA, minted at test time; the key never leaves the temp directory. */
  function mintCa(): Ca {
    const dir = mkdtempSync(join(tmpdir(), 'c9-tls-ca-'));
    openssl(
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        'ca.key',
        '-out',
        'ca.pem',
        '-days',
        '1',
        '-subj',
        '/CN=c9 test CA',
        '-addext',
        'basicConstraints=critical,CA:TRUE',
        '-addext',
        'keyUsage=critical,keyCertSign,cRLSign',
      ],
      dir,
    );
    return { dir, cert: readFileSync(join(dir, 'ca.pem'), 'utf8') };
  }

  /** A leaf signed by `ca`, valid for exactly `san` (`DNS:a,DNS:b,IP:...`). */
  function mintLeaf(ca: Ca, label: string, san: string): Leaf {
    openssl(
      [
        'req',
        '-new',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        `${label}.key`,
        '-out',
        `${label}.csr`,
        '-subj',
        `/CN=${label}`,
      ],
      ca.dir,
    );
    writeFileSync(
      join(ca.dir, `${label}.ext`),
      `subjectAltName=${san}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`,
    );
    openssl(
      [
        'x509',
        '-req',
        '-in',
        `${label}.csr`,
        '-CA',
        'ca.pem',
        '-CAkey',
        'ca.key',
        '-CAcreateserial',
        '-out',
        `${label}.pem`,
        '-days',
        '1',
        '-extfile',
        `${label}.ext`,
      ],
      ca.dir,
    );
    return {
      key: readFileSync(join(ca.dir, `${label}.key`), 'utf8'),
      cert: readFileSync(join(ca.dir, `${label}.pem`), 'utf8'),
    };
  }

  interface Peer {
    readonly server: https.Server;
    readonly port: number;
    readonly seen: Observed;
  }

  async function listen(leaf: Leaf): Promise<Peer> {
    const seen: Observed = { handshakes: 0, requests: 0, bytes: 0 };
    const server = https.createServer({ key: leaf.key, cert: leaf.cert }, (request, response) => {
      seen.requests += 1;
      request.on('data', () => undefined);
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"ok":true}');
      });
    });
    server.on('secureConnection', (socket: tls.TLSSocket) => {
      seen.handshakes += 1;
      // Every application byte the peer is sent, whatever the HTTP layer makes of it.
      socket.on('data', (chunk: Buffer) => {
        seen.bytes += chunk.length;
      });
    });
    server.on('tlsClientError', () => undefined);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { server, port: (server.address() as AddressInfo).port, seen };
  }

  let ca: Ca;
  let originalTrust: string[];
  let rightName: Peer;
  let wrongName: Peer;
  let smtpWrong: tls.Server;
  let smtpWrongPort = 0;
  let smtpRight: tls.Server;
  let smtpRightPort = 0;
  const smtpSeen = {
    wrong: { handshakes: 0, requests: 0, bytes: 0 },
    right: { handshakes: 0, requests: 0, bytes: 0 },
  };

  /** Names the clients below dial; the right-name leaf is valid for all of them. */
  const DIALLED = 'DNS:localhost,DNS:ntfy.c9.test,DNS:llm.c9.test,DNS:mail.c9.test';

  function mailServer(leaf: Leaf, seen: Observed): tls.Server {
    const server = tls.createServer({ key: leaf.key, cert: leaf.cert }, (socket) => {
      seen.handshakes += 1;
      seen.requests += 1;
      socket.on('data', (chunk: Buffer) => {
        seen.bytes += chunk.length;
        socket.end('421 closing\r\n');
      });
      socket.on('error', () => undefined);
      socket.write('220 mail.c9.test ESMTP\r\n');
    });
    server.on('tlsClientError', () => undefined);
    return server;
  }

  function resetPeers(): void {
    for (const o of [rightName.seen, wrongName.seen, smtpSeen.right, smtpSeen.wrong]) {
      o.handshakes = 0;
      o.requests = 0;
      o.bytes = 0;
    }
  }

  /** Nothing application-level crossed the wire. (A completed TLS handshake alone is not a leak.) */
  function expectNothingWritten(seen: Observed): void {
    expect({ requests: seen.requests, bytes: seen.bytes }).toEqual({ requests: 0, bytes: 0 });
  }

  beforeAll(async () => {
    ca = mintCa();
    const right = mintLeaf(ca, 'right-name', `${DIALLED},IP:127.0.0.1`);
    const wrong = mintLeaf(ca, 'evil.test', 'DNS:evil.test');
    originalTrust = tls.getCACertificates('default');
    tls.setDefaultCACertificates([...originalTrust, ca.cert]);

    rightName = await listen(right);
    wrongName = await listen(wrong);
    smtpRight = mailServer(right, smtpSeen.right);
    smtpWrong = mailServer(wrong, smtpSeen.wrong);
    await new Promise<void>((resolve) => smtpRight.listen(0, '127.0.0.1', resolve));
    await new Promise<void>((resolve) => smtpWrong.listen(0, '127.0.0.1', resolve));
    smtpRightPort = (smtpRight.address() as AddressInfo).port;
    smtpWrongPort = (smtpWrong.address() as AddressInfo).port;
  }, 60_000);

  afterAll(async () => {
    if (originalTrust !== undefined) tls.setDefaultCACertificates(originalTrust);
    for (const peer of [rightName, wrongName]) {
      peer?.server.closeAllConnections();
      await new Promise<void>((resolve) =>
        (peer?.server ?? { close: (cb: () => void) => cb() }).close(() => resolve()),
      );
    }
    await new Promise<void>((resolve) => smtpRight?.close(() => resolve()));
    await new Promise<void>((resolve) => smtpWrong?.close(() => resolve()));
    if (ca !== undefined) rmSync(ca.dir, { recursive: true, force: true });
  }, 30_000);

  it(
    'the positive control: a client that trusts only the CA completes a request to each server by its own name',
    async () => {
      resetPeers();
      // The wrong-name server is reachable when the name dialled IS its name.
      const reachWrong = await new Promise<number>((resolve, reject) => {
        const request = https.request(
          {
            host: '127.0.0.1',
            port: wrongName.port,
            path: '/control',
            servername: 'evil.test',
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
      expect(reachWrong).toBe(200);
      expect(wrongName.seen.requests).toBe(1);
      // ... and the default trust store really does carry the CA (no `ca:` given above).
      expect(tls.getCACertificates('default')).toContain(ca.cert);
    },
    SOCKET_TIMEOUT,
  );

  it(
    'the shared egress transport (ntfy, market data, Esplora): works by the leaf’s name, refuses another name and writes nothing',
    async () => {
      resetPeers();
      const transport = createNodeTransport();
      const dial = (port: number) =>
        transport({
          destination: {
            scheme: 'https',
            host: 'ntfy.c9.test',
            port,
            path: '/topic',
            addresses: ['127.0.0.1'],
          },
          method: 'POST',
          headers: { authorization: 'Bearer tk_must_never_reach_the_wrong_name' },
          body: 'a notification body',
          secure: true,
          timeoutMs: 5_000,
          maxResponseBytes: 4_096,
        });

      // Control: the same call, a server whose leaf covers `ntfy.c9.test`.
      const ok = await dial(rightName.port);
      expect(ok.status).toBe(200);
      expect(rightName.seen.requests).toBe(1);

      const error = await errorOf(dial(wrongName.port));
      expect(describeError(error)).toMatch(NAME_ERROR);
      expectNothingWritten(wrongName.seen);
    },
    SOCKET_TIMEOUT,
  );

  it(
    'the local-endpoint transport (a remote https model): works by the leaf’s name, refuses another name and writes nothing',
    async () => {
      resetPeers();
      const transportFor = (port: number) =>
        createLocalEndpointTransport(
          createLocalEndpointPolicy({
            endpoint: `https://llm.c9.test:${String(port)}`,
            allowRemote: true,
            timeoutMs: 5_000,
          }),
          { resolve: async () => ['127.0.0.1'] },
        );
      const call = (port: number) =>
        transportFor(port).request({
          method: 'POST',
          path: '/api/chat',
          body: '{"prompt":"finances"}',
        });

      const ok = await call(rightName.port);
      expect(ok.status).toBe(200);
      expect(rightName.seen.requests).toBe(1);

      const error = await errorOf(call(wrongName.port));
      expect(isLocalEndpointRefusedError(error)).toBe(true);
      expect(describeError(error)).toMatch(NAME_ERROR);
      expectNothingWritten(wrongName.seen);
    },
    SOCKET_TIMEOUT,
  );

  it(
    'the Plaid client (axios, as createPlaidApi builds it): works by the leaf’s name, refuses another name and sends no secret',
    async () => {
      resetPeers();
      const apiFor = (port: number) => {
        const api = createPlaidApi({
          clientId: 'client_id_must_never_reach_the_wrong_name',
          secret: 'secret_must_never_reach_the_wrong_name',
          environment: 'sandbox',
        });
        // The one change: the base URL (host and port). Headers, axios
        // defaults and any agent are exactly what `createPlaidApi` built.
        (api as unknown as { configuration: { basePath: string } }).configuration.basePath =
          `https://localhost:${String(port)}`;
        return api;
      };

      const ok = await apiFor(rightName.port).itemGet({ access_token: 'access-sandbox-control' });
      expect((ok as unknown as { status: number }).status).toBe(200);
      expect(rightName.seen.requests).toBe(1);

      const error = await errorOf(
        apiFor(wrongName.port).itemGet({ access_token: 'access-sandbox-never-sent' }),
      );
      expect(describeError(error)).toMatch(NAME_ERROR);
      expectNothingWritten(wrongName.seen);
    },
    SOCKET_TIMEOUT,
  );

  it(
    'the Coinbase transport (fetch): works by the leaf’s name, refuses another name and sends no bearer token',
    async () => {
      resetPeers();
      const transport = fetchTransport();
      const call = (port: number) =>
        transport({
          method: 'GET',
          host: `localhost:${String(port)}`,
          path: '/api/v3/brokerage/key_permissions',
          query: {},
          headers: { Authorization: 'Bearer jwt-must-never-reach-the-wrong-name' },
          signal: null,
          timeoutMs: 5_000,
        });

      const ok = await call(rightName.port);
      expect(ok.status).toBe(200);
      expect(rightName.seen.requests).toBe(1);

      const error = await errorOf(call(wrongName.port));
      expect(describeError(error)).toMatch(NAME_ERROR);
      expectNothingWritten(wrongName.seen);
    },
    SOCKET_TIMEOUT,
  );

  it(
    'the SMTP adapter (nodemailer, implicit TLS): reaches the greeting by the leaf’s name, refuses another name and sends no EHLO or password',
    async () => {
      resetPeers();
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
      const verifyAt = async (port: number) => {
        const channel = createSmtpChannel({
          policy: createEgressPolicy({ allowedHosts: ['mail.c9.test'] }),
          resolve: async () => ['93.184.216.34'],
          // The adapter's own options (TLS block included) reach nodemailer
          // untouched; only the dialled address and port are re-pointed.
          createTransport: (options: SmtpTransportOptions) =>
            nodemailer.createTransport({ ...options, host: '127.0.0.1', port, pool: false }),
        });
        return await channel.verify({
          kind: 'smtp',
          scheme: 'smtps',
          host: 'mail.c9.test',
          port: 465,
          username: 'holder',
          password: 'smtp-password-must-never-reach-the-wrong-name',
          from: 'pf@c9.test',
          to: 'holder@c9.test',
        });
      };

      // Control: the right-name server's greeting is read and EHLO is written
      // (it hangs up on the first byte, so the verify itself fails — the
      // counters, not the verdict, are the evidence the client got through TLS).
      await verifyAt(smtpRightPort);
      expect(smtpSeen.right.requests).toBe(1);
      expect(smtpSeen.right.bytes).toBeGreaterThan(0);

      const result = await verifyAt(smtpWrongPort);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).toMatch(NAME_ERROR);
      expectNothingWritten(smtpSeen.wrong);
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
