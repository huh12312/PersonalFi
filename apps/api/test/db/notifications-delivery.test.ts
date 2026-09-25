// SPDX-License-Identifier: MIT
/**
 * A real delivery, proven by reading it back from the sink — not by trusting
 * `@ctx/notifications`'s channel adapters' own `outcome: 'delivered'` return
 * value.
 *
 * `docs/plan/03-phase-3-dispatch.md` §3 named this file and named
 * `compose.dev.yml`'s `dev-sinks` profile (WP 3.13's own `Owns` list); neither
 * landed (`docs/evidence/phase-3/wp3.13-carryovers.md` §1 row 6, recorded as
 * "the only §2 row assigned to 3.13 with zero code toward it"). This is
 * `wp3.14-carryovers.md` item 3's half of closing that row — `compose.dev.yml`
 * carries the profile itself (`mailpit` + `ntfy`, both hardened to the same
 * P0-6/P0-7 baseline as `db`).
 *
 * ## Skips cleanly when the profile is not up
 *
 * This suite never assumes `docker compose -f compose.dev.yml --profile
 * dev-sinks up -d` has been run. Each test probes its own sink's loopback
 * port first and calls the vitest test-context `skip()` if it is closed —
 * not `describe.skipIf`, which only ever evaluates a value computed *before*
 * the async probe could run. A skip here is a visible "skipped", not a
 * silently-green pass with an empty body.
 *
 * ## Why this is not a WP 2.4 hermetic-suite violation
 *
 * `packages/contexts/notifications/test/harness.ts`'s header is explicit:
 * "02-phase-2-dispatch.md's rule for WP 2.4 is that no test may send a real
 * email or a real ntfy push" — enforced three ways in that package's own
 * suites (a fake channel in every DB-backed test, unroutable `.test` hosts,
 * and OS-assigned ephemeral ports only `test/egress-allowlist.test.ts`'s own
 * transport ever dials). That rule is about the suites that run by default,
 * every time, in CI, with no external state — this file is a different,
 * deliberately opt-in exception living outside that package, named by the
 * dispatch specifically to prove delivery against a *real* local sink, and it
 * degrades to a no-op the instant the sink is absent. The WP 2.4 guarantee
 * ("no *default* test suite ever opens a socket to a real destination") is
 * unweakened by this file existing.
 *
 * ## The destination-swap idiom, reused rather than reinvented
 *
 * `packages/contexts/notifications/test/egress-allowlist.test.ts`'s own
 * comment: "the redirect proof uses real sockets... a stub transport
 * asserting 'we returned 302' would prove the classification and nothing
 * about the second request... the transport is pointed at the redirector
 * directly because `transport.ts` deliberately holds no policy — that
 * separation is what lets this half be proven without a switch that turns a
 * security control off." That file's own end-to-end case swaps
 * `destination.port`/`destination.addresses` for a live loopback fixture
 * while `resolve()` still answers a plausible public address and
 * `guardDestination`'s classification still runs in full. The ntfy half below
 * is exactly that pattern, aimed at `compose.dev.yml`'s `ntfy` container
 * instead of an ephemeral test-local server.
 *
 * `guardDestination`'s "no allow-private-addresses switch, not even for
 * tests" (`packages/platform/src/egress/policy.ts` §"There is no...") is not
 * weakened by any of this: production's own `createNtfyChannel`/
 * `createSmtpChannel`, given the real `createNodeTransport()`/`nodemailer`
 * factories, still cannot reach a loopback address, ever. What is swapped
 * here is which bytes a *test-only* transport/factory physically dials, after
 * the guard has already run — the same seam `NtfyChannelOptions.transport`
 * and `SmtpChannelOptions.createTransport`'s own doc comments name as
 * test-fixture-only.
 *
 * ## The SMTP half hand-rolls the wire protocol, on purpose
 *
 * `scripts/eslint-boundaries.js`'s `notifications` layer entry allow-lists
 * `nodemailer` for `packages/contexts/notifications/` alone — "and on no
 * other context" — so this file (`apps/api/test/db/`) cannot import it.
 * `createSmtpChannel`'s `createTransport` hook still lets a caller supply any
 * object shaped like `SmtpTransport` (`sendMail`/`verify`/`close?`), so the
 * minimal, deliberately non-general SMTP client below (`net.createConnection`,
 * five commands, no STARTTLS) plays that role instead — mailpit's dev-sinks
 * profile is configured with `MP_SMTP_AUTH_ALLOW_INSECURE=1` and no TLS cert,
 * so a plaintext local exchange is exactly what it expects to see. Production's
 * own `nodemailerFactory` (`adapters/smtp.ts`) is untouched and still refuses
 * anything without mandatory TLS.
 */
import net from 'node:net';
import { newId } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import {
  createEgressPolicy,
  createNodeTransport,
  createNtfyChannel,
  createSmtpChannel,
  type Notification,
  type SmtpMessage,
  type SmtpTransport,
} from '@ctx/notifications';

const NTFY_HOST = '127.0.0.1';
const NTFY_PORT = 2586;
const MAILPIT_HOST = '127.0.0.1';
const MAILPIT_SMTP_PORT = 1025;
const MAILPIT_HTTP_PORT = 8025;

/** A fake, plausible public address — the exact value `egress-allowlist.test.ts` uses for the same reason: it only has to classify `public`, never actually be dialled (the transport/factory below swap the real socket target in afterwards). */
const FAKE_PUBLIC_ADDRESS = '93.184.216.34';

function probePort(host: string, port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function pollUntil<T>(
  attempt: () => Promise<T | undefined>,
  { retries = 8, delayMs = 250 }: { retries?: number; delayMs?: number } = {},
): Promise<T | undefined> {
  for (let index = 0; index < retries; index += 1) {
    const result = await attempt();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return undefined;
}

/**
 * A minimal, sequential SMTP client — see this file's header for why it
 * exists instead of an import. Not a general-purpose implementation: no
 * pipelining, no dot-stuffing of a leading `.` in the body (the fixed test
 * message below never starts a line with one), no STARTTLS. Mailpit, over
 * loopback, is a well-behaved, single-line-then-multi-line-reply server, so
 * "wait for a line matching `NNN `" is enough here.
 */
function createDevSinkSmtpTransport(host: string, port: number): SmtpTransport {
  function sendMail(message: SmtpMessage): Promise<{ messageId?: string }> {
    return new Promise((resolvePromise, rejectPromise) => {
      const socket = net.createConnection({ host, port });
      let buffer = '';
      type Stage = 'greeting' | 'ehlo' | 'mail' | 'rcpt' | 'data' | 'body' | 'done';
      let stage: Stage = 'greeting';
      let settled = false;

      function finish(error?: Error): void {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) rejectPromise(error);
        else resolvePromise({});
      }

      socket.setTimeout(5_000, () => finish(new Error('dev-sinks smtp: timed out')));
      socket.on('error', (error) => finish(error));
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\r\n').filter((line) => line.length > 0);
        const last = lines.at(-1) ?? '';
        // A multi-line SMTP reply's final line has a space after the status
        // code; every continuation line has a dash there instead.
        if (!/^\d{3} /.test(last)) return;
        const code = Number(last.slice(0, 3));
        buffer = '';

        if (stage === 'greeting') {
          if (code !== 220) {
            finish(new Error(`dev-sinks smtp: unexpected greeting ${String(code)}`));
            return;
          }
          stage = 'ehlo';
          socket.write('EHLO personalfi-dev-sinks\r\n');
          return;
        }
        if (stage === 'ehlo') {
          if (code !== 250) {
            finish(new Error(`dev-sinks smtp: EHLO refused ${String(code)}`));
            return;
          }
          stage = 'mail';
          socket.write(`MAIL FROM:<${message.from}>\r\n`);
          return;
        }
        if (stage === 'mail') {
          if (code !== 250) {
            finish(new Error(`dev-sinks smtp: MAIL FROM refused ${String(code)}`));
            return;
          }
          stage = 'rcpt';
          socket.write(`RCPT TO:<${message.to}>\r\n`);
          return;
        }
        if (stage === 'rcpt') {
          if (code !== 250) {
            finish(new Error(`dev-sinks smtp: RCPT TO refused ${String(code)}`));
            return;
          }
          stage = 'data';
          socket.write('DATA\r\n');
          return;
        }
        if (stage === 'data') {
          if (code !== 354) {
            finish(new Error(`dev-sinks smtp: DATA refused ${String(code)}`));
            return;
          }
          stage = 'body';
          const payload = [
            `Subject: ${message.subject}`,
            `From: ${message.from}`,
            `To: ${message.to}`,
            '',
            message.text,
            '.',
            '',
          ].join('\r\n');
          socket.write(payload);
          return;
        }
        if (stage === 'body') {
          if (code !== 250) {
            finish(new Error(`dev-sinks smtp: message refused ${String(code)}`));
            return;
          }
          stage = 'done';
          socket.write('QUIT\r\n');
          finish();
        }
      });
    });
  }

  return { sendMail, verify: () => Promise.resolve(true) };
}

describe('notifications delivery — dev-sinks (wp3.14-carryovers.md item 3)', () => {
  it('a real ntfy push lands in the dev-sinks ntfy cache, observed by reading it back', async ({
    skip,
  }) => {
    if (!(await probePort(NTFY_HOST, NTFY_PORT))) {
      skip(
        `dev-sinks ntfy is not up (127.0.0.1:${String(NTFY_PORT)} refused a connection) — ` +
          'start it with `docker compose -f compose.dev.yml --profile dev-sinks up -d ntfy`',
      );
      return;
    }

    const topic = `personalfi-dev-sinks-${newId().slice(0, 8)}`;
    const marker = `delivery-proof-${newId()}`;
    const transport = createNodeTransport();

    const channel = createNtfyChannel({
      policy: createEgressPolicy({ allowedHosts: ['ntfy.dev-sinks.test'] }),
      resolve: () => Promise.resolve([FAKE_PUBLIC_ADDRESS]),
      transport: (request) =>
        transport({
          ...request,
          destination: { ...request.destination, addresses: [NTFY_HOST], port: NTFY_PORT },
          secure: false,
        }),
    });

    const notification: Notification = {
      dedupeKey: marker,
      priority: 'normal',
      title: 'wp3.14 dev-sinks delivery proof',
      bodyMd: marker,
    };

    const result = await channel.send(notification, {
      kind: 'ntfy',
      scheme: 'https',
      host: 'ntfy.dev-sinks.test',
      port: 443,
      topic,
      accessToken: null,
    });
    expect(result.outcome, result.detail ?? '').toBe('delivered');

    // Observed as delivered, not merely queued: read it back from ntfy's own
    // message cache (`poll=1`) rather than trusting `result.outcome`.
    const found = await pollUntil(async () => {
      const response = await fetch(`http://${NTFY_HOST}:${String(NTFY_PORT)}/${topic}/json?poll=1`);
      if (!response.ok) return undefined;
      const lines = (await response.text())
        .trim()
        .split('\n')
        .filter((line) => line.length > 0);
      const messages = lines.map((line) => JSON.parse(line) as { message?: string });
      return messages.find((message) => message.message === marker);
    });
    expect(found, 'the marker message was never observed in ntfy’s cache').not.toBeUndefined();
  }, 20_000);

  it('a real SMTP send lands in the dev-sinks mailpit mailbox, observed by reading it back', async ({
    skip,
  }) => {
    if (!(await probePort(MAILPIT_HOST, MAILPIT_SMTP_PORT))) {
      skip(
        `dev-sinks mailpit is not up (127.0.0.1:${String(MAILPIT_SMTP_PORT)} refused a connection) — ` +
          'start it with `docker compose -f compose.dev.yml --profile dev-sinks up -d mailpit`',
      );
      return;
    }

    const marker = `delivery-proof-${newId()}`;

    const channel = createSmtpChannel({
      policy: createEgressPolicy({ allowedHosts: ['smtp.dev-sinks.test'] }),
      resolve: () => Promise.resolve([FAKE_PUBLIC_ADDRESS]),
      createTransport: () => createDevSinkSmtpTransport(MAILPIT_HOST, MAILPIT_SMTP_PORT),
    });

    const notification: Notification = {
      dedupeKey: marker,
      priority: 'normal',
      title: `wp3.14 dev-sinks delivery proof ${marker}`,
      bodyMd: marker,
    };

    const result = await channel.send(notification, {
      kind: 'smtp',
      scheme: 'smtps',
      host: 'smtp.dev-sinks.test',
      port: 465,
      username: 'dev-sinks',
      password: 'unused-by-the-dev-sink-transport',
      from: 'personalfi-dev-sinks@example.test',
      to: 'holder@example.test',
    });
    expect(result.outcome, result.detail ?? '').toBe('delivered');

    // Observed as delivered, not merely queued: read it back from mailpit's
    // own REST API rather than trusting `result.outcome`.
    const found = await pollUntil(async () => {
      const response = await fetch(
        `http://${MAILPIT_HOST}:${String(MAILPIT_HTTP_PORT)}/api/v1/messages?limit=25`,
      );
      if (!response.ok) return undefined;
      const body = (await response.json()) as { messages?: { Subject?: string }[] };
      return body.messages?.find((message) => message.Subject?.includes(marker));
    });
    expect(found, 'the marker message was never observed in mailpit’s mailbox').not.toBeUndefined();
  }, 20_000);
});
