// SPDX-License-Identifier: MIT
/**
 * The two production adapters and their `verify()` — the "send test" action.
 *
 * Nothing here opens a socket: the ntfy adapter takes an injected transport and
 * the SMTP adapter an injected `createTransport`, and both are given stubs.
 * 02-phase-2-dispatch.md's rule for WP 2.4 is that no test sends a real email
 * or a real ntfy push, so what is asserted is the *shape of what would have
 * gone on the wire* — which is the part that carries the TLS posture and the
 * rebinding close, and the part a test against a real server would prove least
 * about.
 */
import { describe, expect, it } from 'vitest';
import { createFakeChannel } from '../src/adapters/fake.ts';
import { createNtfyChannel, truncate } from '../src/adapters/ntfy.ts';
import {
  createSmtpChannel,
  type SmtpMessage,
  type SmtpTransportOptions,
} from '../src/adapters/smtp.ts';
import type { Resolver } from '../src/egress.ts';
import type { TransportRequest, TransportResponse } from '../src/transport.ts';
import { NTFY_HOST, SMTP_HOST, TEST_POLICY, ntfyConfig, smtpConfig } from './harness.ts';

const PUBLIC_ADDRESS = '93.184.216.34';
const resolve: Resolver = (host) =>
  host === NTFY_HOST || host === SMTP_HOST
    ? Promise.resolve([PUBLIC_ADDRESS])
    : Promise.reject(new Error(`NXDOMAIN ${host}`));

const notification = {
  dedupeKey: 'k',
  priority: 'high' as const,
  title: 'A budget envelope is overspent',
  bodyMd: 'Groceries is overspent in cash.',
  deepLink: 'https://app.example/budget',
};

describe('the ntfy adapter', () => {
  function stubTransport(status: number): {
    transport: (request: TransportRequest) => Promise<TransportResponse>;
    requests: TransportRequest[];
  } {
    const requests: TransportRequest[] = [];
    return {
      requests,
      transport: (request) => {
        requests.push(request);
        return Promise.resolve({ status, body: '{}', bytesRead: 2, location: null });
      },
    };
  }

  it('posts the topic in the body, over TLS, to the validated address', async () => {
    const { transport, requests } = stubTransport(200);
    const channel = createNtfyChannel({ policy: TEST_POLICY, transport, resolve });

    const result = await channel.send(notification, ntfyConfig({ accessToken: 'tk_secret' }));
    expect(result.outcome).toBe('delivered');

    const request = requests[0];
    expect(request?.secure, 'there is no cleartext member of the scheme list').toBe(true);
    expect(request?.destination.addresses).toEqual([PUBLIC_ADDRESS]);
    expect(request?.destination.host).toBe(NTFY_HOST);
    // The topic travels in the JSON body, never interpolated into the path:
    // one code path by which user data reaches the wire, and it cannot split a
    // request.
    expect(request?.destination.path).toBe('/');
    const body = JSON.parse(request?.body ?? '{}') as Record<string, unknown>;
    expect(body['topic']).toBe('personalfi-test');
    expect(body['title']).toBe(notification.title);
    expect(request?.headers['authorization']).toBe('Bearer tk_secret');
  });

  it('verify() reaches the destination and reports the refusal code when it cannot', async () => {
    const ok = createNtfyChannel({
      policy: TEST_POLICY,
      transport: stubTransport(200).transport,
      resolve,
    });
    expect(await ok.verify(ntfyConfig())).toEqual({ ok: true });

    // An unauthorised token is *their* refusal: permanent, not an egress one.
    const unauthorised = createNtfyChannel({
      policy: TEST_POLICY,
      transport: stubTransport(401).transport,
      resolve,
    });
    const denied = await unauthorised.verify(ntfyConfig());
    expect(denied.ok).toBe(false);
    expect(denied.refusalCode ?? null).toBeNull();

    // A host the operator never allow-listed is *ours*, and says so.
    const refused = createNtfyChannel({
      policy: TEST_POLICY,
      transport: stubTransport(200).transport,
      resolve,
    });
    const verdict = await refused.verify(ntfyConfig({ host: 'ntfy.sh' }));
    expect(verdict.ok).toBe(false);
    expect(verdict.refusalCode).toBe('host_not_allowed');
  });

  it('truncates on a byte budget without emitting a replacement character', () => {
    const long = 'é'.repeat(4_000);
    const cut = truncate(long, 64);
    expect(Buffer.byteLength(cut, 'utf8')).toBeLessThanOrEqual(64);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut).not.toContain('�');
    expect(truncate('short', 64)).toBe('short');
  });
});

describe('the smtp adapter', () => {
  function stub(): {
    createTransport: (options: SmtpTransportOptions) => {
      sendMail: (message: SmtpMessage) => Promise<{ messageId?: string }>;
      verify: () => Promise<boolean>;
      close: () => void;
    };
    options: SmtpTransportOptions[];
    messages: SmtpMessage[];
    verifications: number;
    closed: number;
  } {
    const state = {
      options: [] as SmtpTransportOptions[],
      messages: [] as SmtpMessage[],
      verifications: 0,
      closed: 0,
      createTransport: (options: SmtpTransportOptions) => {
        state.options.push(options);
        return {
          sendMail: (message: SmtpMessage) => {
            state.messages.push(message);
            return Promise.resolve({ messageId: 'stub' });
          },
          verify: () => {
            state.verifications += 1;
            return Promise.resolve(true);
          },
          close: () => {
            state.closed += 1;
          },
        };
      },
    };
    return state;
  }

  it('connects to the validated address with the hostname as the TLS servername', async () => {
    const state = stub();
    const channel = createSmtpChannel({
      policy: TEST_POLICY,
      createTransport: state.createTransport,
      resolve,
    });

    const result = await channel.send(notification, smtpConfig());
    expect(result.outcome).toBe('delivered');

    const options = state.options[0];
    // The address, not the name: handing nodemailer the hostname would let a
    // resolver answer 127.0.0.1 on the second lookup, which is the whole
    // rebinding attack.
    expect(options?.host).toBe(PUBLIC_ADDRESS);
    expect(options?.tls.servername, 'certificate validation is unweakened').toBe(SMTP_HOST);
    expect(options?.tls.rejectUnauthorized).toBe(true);
    expect(options?.tls.minVersion).toBe('TLSv1.2');
    expect(options?.secure, 'smtps is implicit TLS from the first byte').toBe(true);
    expect(options?.requireTLS, 'never opportunistic STARTTLS').toBe(true);
    expect(state.closed, 'the connection is not pooled across sends').toBe(1);

    const message = state.messages[0];
    expect(message?.to).toBe('holder@notify.test');
    expect(message?.subject).toBe(notification.title);
    expect(message?.text).toContain('Groceries is overspent');
    expect(message?.text, 'actions degrade to links').toContain('https://app.example/budget');
  });

  it('submission on 587 still requires STARTTLS rather than preferring it', async () => {
    const state = stub();
    const channel = createSmtpChannel({
      policy: TEST_POLICY,
      createTransport: state.createTransport,
      resolve,
    });
    await channel.send(notification, smtpConfig({ scheme: 'smtp+starttls', port: 587 }));
    expect(state.options[0]?.secure).toBe(false);
    expect(state.options[0]?.requireTLS, 'a stripped STARTTLS fails, never downgrades').toBe(true);
  });

  it('verify() authenticates without putting a message in anybody’s inbox', async () => {
    const state = stub();
    const channel = createSmtpChannel({
      policy: TEST_POLICY,
      createTransport: state.createTransport,
      resolve,
    });
    expect(await channel.verify(smtpConfig())).toEqual({ ok: true });
    expect(state.verifications).toBe(1);
    expect(state.messages, 'verify sends nothing').toHaveLength(0);
  });

  it('a refused destination never constructs a transport', async () => {
    const state = stub();
    const channel = createSmtpChannel({
      policy: TEST_POLICY,
      createTransport: state.createTransport,
      resolve,
    });
    const result = await channel.send(notification, smtpConfig({ host: 'db', port: 465 }));
    expect(result.outcome).toBe('refused');
    expect(result.refusalCode).toBe('host_not_allowed');
    expect(state.options, 'no socket options were ever built').toHaveLength(0);
  });
});

describe('the fake channel', () => {
  it('records what it was handed and can be made to fail a fixed number of times', async () => {
    const fake = createFakeChannel();
    fake.failFor(2, { outcome: 'retryable', detail: 'reset' });

    const config = ntfyConfig();
    expect((await fake.send(notification, config)).outcome).toBe('retryable');
    expect((await fake.send(notification, config)).outcome).toBe('retryable');
    expect((await fake.send(notification, config)).outcome).toBe('delivered');
    expect(fake.deliveries).toHaveLength(3);
    expect(fake.deliveries[0]?.notification.title).toBe(notification.title);

    fake.reset();
    expect(fake.deliveries).toHaveLength(0);
    expect((await fake.send(notification, config)).outcome).toBe('delivered');
  });
});
