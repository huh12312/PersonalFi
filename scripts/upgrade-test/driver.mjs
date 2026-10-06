// SPDX-License-Identifier: MIT
//
// The upgrade harness's one Node verifier (WP 9.4; 09-phase-9-dispatch.md §3).
// It talks to each waypoint's OWN running API — never SQL — to load that
// waypoint's data, and after every upgrade reads every fact back and asserts
// checks (ii) and (iii):
//
//   (ii)  every fact loaded earlier is readable through the running version's
//         API — counts and spot values;
//   (iii) the same master_key unlocks (`/auth/unlock-state`), the KEK
//         generation is unchanged, a TOTP code from W0's secret verifies, and
//         W0's passkey logs in.
//
// Passkeys are real WebAuthn ceremonies in Chromium (the repo's own
// Playwright) against a CDP virtual authenticator, as the Phase 5 gate did.
// The one credential, its sign counter, the TOTP seed and the recovery codes
// are kept in $AUTH_DIR (0700, under the harness's $WORK, deleted at the end)
// and never printed. Everything else is a plain HTTPS client through Caddy
// with the session cookies the browser obtained, exactly the headers a
// same-origin fetch sends.
//
//   node driver.mjs <command> [args]       (env: see `env` below)
//     register <token-file>   enrol W0's passkey from the bootstrap token
//     enrol-factors           TOTP enrolment + recovery codes (W0)
//     load <waypoint>         that waypoint's data, through its own API
//     verify <waypoint>       (ii) for every fact loaded so far, then (iii)
//     status                  /auth/unlock-state and /ready, no session
import { createHmac } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';

// The harness reads this script's stdout line by line (one JSON object or one
// check line per command) and its stderr for the reason a step failed. Both are
// written directly: a script's protocol, not a debug log (the repo's no-console).
function say(line) {
  process.stdout.write(`${line}\n`);
}
function warn(line) {
  process.stderr.write(`${line}\n`);
}

const env = {
  repoRoot: must('REPO_ROOT'),
  authDir: must('AUTH_DIR'),
  factsFile: must('FACTS_FILE'),
  // The waypoint whose code is running now: decides route prefixes.
  running: must('RUNNING'),
  host: process.env.PUBLIC_HOST_TEST ?? 'personalfi.lan',
  port: Number(process.env.PROXY_HTTPS_PORT ?? '8451'),
  // W1 only: Caddy at W1 proxies /auth, /health, /ready and nothing else, so
  // its data API is reached through a loopback forwarder to api:8080.
  directPort: process.env.DIRECT_PORT ? Number(process.env.DIRECT_PORT) : undefined,
};

function must(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    warn(`driver: ${name} is required`);
    process.exit(2);
  }
  return value;
}

const ORIGIN = `https://${env.host}:${env.port}`;
const ERA = env.running; // W0..W5, HEAD, HEAD+1, ...
/** W0 and W1 serve the API at the root, through Caddy only for /auth/*. */
const ROOT_ERA = ERA === 'W0' || ERA === 'W1';
const AUTH_PREFIX = ROOT_ERA ? '' : '/api';

mkdirSync(env.authDir, { recursive: true, mode: 0o700 });
chmodSync(env.authDir, 0o700);
const P = {
  cred: join(env.authDir, 'cred.json'),
  cookies: join(env.authDir, 'cookies.json'),
  totp: join(env.authDir, 'totp.json'),
  recovery: join(env.authDir, 'recovery.json'),
};

function readJson(path, fallback) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
}
function writeSecret(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
}
const facts = readJson(env.factsFile, {});
function saveFacts() {
  writeFileSync(env.factsFile, `${JSON.stringify(facts, null, 2)}\n`);
}

// ------------------------------------------------------------------ HTTP

let jar = readJson(P.cookies, {});

function cookieHeader() {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function absorbSetCookie(headers) {
  const set = headers['set-cookie'] ?? [];
  for (const line of set) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (/max-age=0|expires=thu, 01 jan 1970/i.test(line) || value === '') delete jar[name];
    else jar[name] = value;
  }
  writeSecret(P.cookies, jar);
}

/**
 * One request, the way a same-origin fetch from the SPA makes it.
 * `via`: 'proxy' (Caddy, TLS, the era's prefix) or 'direct' (W1's forwarder).
 */
function call(method, path, body, { via = 'proxy', timeoutMs = 60_000 } = {}) {
  const direct = via === 'direct';
  const fullPath = direct ? path : `${AUTH_PREFIX}${path}`;
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const headers = {
    accept: 'application/json',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    host: direct ? 'api:8080' : `${env.host}:${env.port}`,
  };
  if (!direct) headers.origin = ORIGIN;
  if (Object.keys(jar).length > 0) headers.cookie = cookieHeader();
  if (method !== 'GET' && method !== 'HEAD') {
    if (jar['__Host-pfi_csrf'] !== undefined) headers['x-csrf-token'] = jar['__Host-pfi_csrf'];
  }
  if (payload !== undefined) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(payload.length);
  }
  const options = direct
    ? { host: '127.0.0.1', port: env.directPort, path: fullPath, method, headers }
    : {
        host: '127.0.0.1',
        port: env.port,
        servername: env.host,
        path: fullPath,
        method,
        headers,
        // Caddy's internal CA on a loopback test stack. The browser half of
        // this harness ignores the same certificate the same way.
        rejectUnauthorized: false,
      };
  return new Promise((resolve, reject) => {
    const req = (direct ? httpRequest : httpsRequest)(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        absorbSetCookie(res.headers);
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = text.length > 0 ? JSON.parse(text) : undefined;
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode, json, text, headers: res.headers });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`${method} ${fullPath} timed out`)));
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** Data routes: W1 goes through the forwarder; every other era through Caddy. */
function api(method, path, body, opts = {}) {
  return call(method, path, body, { ...opts, via: ERA === 'W1' ? 'direct' : 'proxy' });
}

async function expectStatus(promise, want, what) {
  const res = await promise;
  const ok = Array.isArray(want) ? want.includes(res.status) : res.status === want;
  if (!ok) {
    throw new Error(
      `${what}: HTTP ${res.status} (wanted ${want}) ${res.text.slice(0, 300).replaceAll('\n', ' ')}`,
    );
  }
  return res.json;
}

async function primeCsrf() {
  // Any /auth GET mints the CSRF cookie in every era.
  await call('GET', '/auth/unlock-state');
}

// ------------------------------------------------------------- WebAuthn

const require = createRequire(join(env.repoRoot, 'apps', 'web', 'package.json'));

async function withAuthenticator(fn) {
  const { chromium } = require('@playwright/test');
  const browser = await chromium.launch({
    headless: true,
    args: [`--host-resolver-rules=MAP ${env.host} 127.0.0.1`],
  });
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable', { enableUI: false });
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    const stored = readJson(P.cred, null);
    if (stored !== null) {
      await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: stored });
    }
    // The session cookies the Node client holds, so a ceremony that needs a
    // session (step-up) runs in it.
    const cookies = Object.entries(jar).map(([name, value]) => ({
      name,
      value,
      domain: env.host,
      path: '/',
      secure: true,
      httpOnly: name !== '__Host-pfi_csrf',
      sameSite: 'Strict',
    }));
    if (cookies.length > 0) {
      // `__Host-` cookies cannot carry a Domain attribute; Playwright wants a url.
      await context.addCookies(
        cookies.map(({ domain: _d, path: _p, ...rest }) => ({ ...rest, url: `${ORIGIN}/` })),
      );
    }
    // A same-origin document: the SPA's index (every era serves one).
    await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
    const result = await fn(page);
    // Persist the credential (its sign counter moved) and the browser's cookies.
    const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
    if (credentials.length > 0) writeSecret(P.cred, credentials[0]);
    for (const c of await context.cookies(`${ORIGIN}/`)) jar[c.name] = c.value;
    writeSecret(P.cookies, jar);
    return result;
  } finally {
    await browser.close();
  }
}

/** Runs in the page: one WebAuthn ceremony against `${prefix}/auth/...`. */
const CEREMONY = async ({ prefix, kind, token, friendlyName }) => {
  const b64uToBuf = (s) => {
    const pad = '='.repeat((4 - (s.length % 4)) % 4);
    const bin = atob((s + pad).replaceAll('-', '+').replaceAll('_', '/'));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer;
  };
  const bufToB64u = (b) =>
    btoa(String.fromCharCode(...new Uint8Array(b)))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '');
  const csrf = () =>
    decodeURIComponent(
      (globalThis.document.cookie.match(/(?:^|; )__Host-pfi_csrf=([^;]*)/) ?? [])[1] ?? '',
    );
  const post = async (path, body) => {
    const res = await fetch(`${prefix}${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf() },
      body: JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
    return text.length > 0 ? JSON.parse(text) : {};
  };
  await fetch(`${prefix}/auth/unlock-state`, { credentials: 'same-origin' });

  if (kind === 'register') {
    const { userId, options } = await post('/auth/register/options', { registrationToken: token });
    const publicKey = {
      ...options,
      challenge: b64uToBuf(options.challenge),
      user: { ...options.user, id: b64uToBuf(options.user.id) },
      excludeCredentials: (options.excludeCredentials ?? []).map((c) => ({
        ...c,
        id: b64uToBuf(c.id),
      })),
    };
    const cred = await navigator.credentials.create({ publicKey });
    const response = {
      id: cred.id,
      rawId: bufToB64u(cred.rawId),
      type: cred.type,
      authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
      clientExtensionResults: cred.getClientExtensionResults(),
      response: {
        clientDataJSON: bufToB64u(cred.response.clientDataJSON),
        attestationObject: bufToB64u(cred.response.attestationObject),
        transports: cred.response.getTransports ? cred.response.getTransports() : [],
      },
    };
    return post('/auth/register/verify', { userId, friendlyName, response });
  }

  const optionsPath = kind === 'login' ? '/auth/login/options' : '/auth/step-up/options';
  const verifyPath = kind === 'login' ? '/auth/login/verify' : '/auth/step-up/verify';
  const { options } = await post(optionsPath, {});
  const publicKey = {
    ...options,
    challenge: b64uToBuf(options.challenge),
    allowCredentials: (options.allowCredentials ?? []).map((c) => ({ ...c, id: b64uToBuf(c.id) })),
  };
  const cred = await navigator.credentials.get({ publicKey });
  const response = {
    id: cred.id,
    rawId: bufToB64u(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: bufToB64u(cred.response.clientDataJSON),
      authenticatorData: bufToB64u(cred.response.authenticatorData),
      signature: bufToB64u(cred.response.signature),
      userHandle: cred.response.userHandle ? bufToB64u(cred.response.userHandle) : undefined,
    },
  };
  return post(verifyPath, kind === 'login' ? { response, trustedDevice: false } : { response });
};

async function ceremony(kind, extra = {}) {
  return withAuthenticator((page) =>
    page.evaluate(CEREMONY, { prefix: AUTH_PREFIX, kind, ...extra }),
  );
}

async function passkeyLogin() {
  jar = {};
  writeSecret(P.cookies, jar);
  await ceremony('login');
  const session = await expectStatus(call('GET', '/auth/session'), 200, 'GET /auth/session');
  if (session.fresh !== true)
    throw new Error('a passkey login did not yield a step-up-fresh session');
  return session;
}

async function stepUp() {
  await ceremony('stepup');
}

/** Run `fn`; on 403 step_up_required, step up once and retry. */
async function fresh(fn) {
  const first = await fn();
  if (first.status === 403 && first.text.includes('step_up_required')) {
    await stepUp();
    return fn();
  }
  return first;
}

// ------------------------------------------------------------------ TOTP

function base32Decode(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const v = alphabet.indexOf(ch);
    if (v < 0) throw new Error('bad base32 in TOTP secret');
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8)
    bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** RFC 6238, parameters read from the otpauth:// URI the server returned. */
function totpNow({ secret, digits = 6, period = 30, algorithm = 'SHA1' }, at = Date.now()) {
  const counter = Math.floor(at / 1000 / period);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm.toLowerCase(), base32Decode(secret)).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return { code: String(code).padStart(digits, '0'), counter };
}

/** A code from a period never used before (replay protection rejects reuse). */
async function freshTotp() {
  const t = readJson(P.totp, null);
  if (t === null) throw new Error('no TOTP enrolment recorded');
  for (;;) {
    const { code, counter } = totpNow(t);
    if (counter > (t.lastCounter ?? -1)) {
      t.lastCounter = counter;
      writeSecret(P.totp, t);
      return code;
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

// ------------------------------------------------------------ the loads

const loads = {
  /** W0: passkey (separately, `register`), TOTP enrolment, recovery codes. */
  async W0() {
    const session = await expectStatus(call('GET', '/auth/session'), 200, 'GET /auth/session');
    const enrol = await fresh(() => call('POST', '/auth/totp/enroll', {}));
    if (enrol.status !== 200)
      throw new Error(`TOTP enrol: HTTP ${enrol.status} ${enrol.text.slice(0, 200)}`);
    const uri = new URL(enrol.json.uri);
    const t = {
      secret: enrol.json.secret,
      digits: Number(uri.searchParams.get('digits') ?? '6'),
      period: Number(uri.searchParams.get('period') ?? '30'),
      algorithm: (uri.searchParams.get('algorithm') ?? 'SHA1').toUpperCase(),
    };
    writeSecret(P.totp, t);
    const code = await freshTotp();
    await expectStatus(
      fresh(() =>
        call('POST', '/auth/totp/confirm', { enrolmentId: enrol.json.enrolmentId, token: code }),
      ),
      200,
      'POST /auth/totp/confirm',
    );
    const rc = await fresh(() => call('POST', '/auth/recovery-codes', {}));
    if (rc.status !== 200) throw new Error(`recovery codes: HTTP ${rc.status}`);
    writeSecret(P.recovery, { codes: rc.json.codes, used: [] });
    const unlock = await expectStatus(call('GET', '/auth/unlock-state'), 200, 'unlock-state');
    const after = await expectStatus(call('GET', '/auth/session'), 200, 'GET /auth/session');
    const creds = await expectStatus(
      call('GET', '/auth/credentials'),
      200,
      'GET /auth/credentials',
    );
    facts.W0 = {
      userId: session.userId,
      displayName: session.displayName,
      displayTimezone: session.displayTimezone,
      credentialIds: creds.credentials.map((c) => c.credentialId).sort(),
      totpEnrolled: after.totpEnrolled,
      recoveryCodesRemaining: after.recoveryCodesRemaining,
      kekVersion: unlock.kekVersion,
    };
    if (!after.totpEnrolled || after.recoveryCodesRemaining !== 10) {
      throw new Error(`W0 factors not recorded: ${JSON.stringify(after)}`);
    }
    saveFacts();
    return facts.W0;
  },

  /** W1: a CSV import of generateDemoData(1); a category override (W1 has no rule API). */
  async W1() {
    const seed = await import(join(env.repoRoot, 'packages', 'seed', 'src', 'index.ts'));
    const data = seed.generateDemoData(1);
    const typeMap = { checking: 'depository', savings: 'depository', credit_card: 'credit' };
    const files = [];
    let rows = 0;
    for (const account of data.accounts) {
      const type = typeMap[account.type];
      if (type === undefined) continue;
      const txs = data.transactions.filter(
        (t) => t.accountId === account.id && t.status === 'posted',
      );
      const lines = ['Date,Description,Amount'];
      for (const t of txs) {
        const minor = BigInt(t.amount.minor);
        const neg = minor < 0n;
        const abs = neg ? -minor : minor;
        const amount = `${neg ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
        const desc = `"${t.descriptorRaw.replaceAll('"', '""')}"`;
        lines.push(`${t.postedOn},${desc},${amount}`);
      }
      rows += txs.length;
      files.push({
        name: `${account.type}.csv`,
        format: 'csv',
        presetId: 'iso_signed',
        content: `${lines.join('\n')}\n`,
        account: {
          providerAccountId: `seed-${account.type}`,
          name: account.name,
          type,
          currency: 'USD',
          mask: account.id.replaceAll('-', '').slice(-4),
        },
      });
    }
    await session();
    const imported = await expectStatus(
      api(
        'POST',
        '/imports/csv',
        { displayName: 'Seed import (WP 9.4)', files },
        { timeoutMs: 120_000 },
      ),
      200,
      'POST /imports/csv',
    );
    const first = await expectStatus(
      api('GET', '/transactions?limit=200'),
      200,
      'GET /transactions',
    );
    const count = first.summary?.count;
    if (typeof count !== 'number' || count === 0)
      throw new Error(`no transactions after import: ${JSON.stringify(first.summary)}`);
    // The category override: W1 has no category API, and `categoryId` is an
    // opaque UUID with no FK at W1 — a fixed one, read back by id later.
    const target =
      first.items.find((t) => t.amount && String(t.amount.minor).startsWith('-')) ?? first.items[0];
    const overrideCategoryId = '0b9a4d1e-94a4-4c5e-8a3e-000000009401';
    await expectStatus(
      api('PATCH', `/transactions/${target.id}`, { categoryId: overrideCategoryId }),
      200,
      'PATCH /transactions/:id',
    );
    const back = await expectStatus(
      api('GET', `/transactions/${target.id}`),
      200,
      'GET /transactions/:id',
    );
    facts.W1 = {
      csvRows: rows,
      csvFiles: files.length,
      connectionId: imported.connectionId,
      transactionCount: count,
      spot: { id: target.id, amount: target.amount, date: target.postedOn ?? target.date ?? null },
      override: { transactionId: target.id, categoryId: overrideCategoryId },
      overrideReadBack: back.categoryId,
    };
    if (back.categoryId !== overrideCategoryId)
      throw new Error(`override did not read back: ${back.categoryId}`);
    saveFacts();
    return facts.W1;
  },

  /** W2: a rule (moved from W1: no rule API there), a budget, a confirmed recurring series. */
  async W2() {
    await session();
    const cats = await expectStatus(api('GET', '/categories'), 200, 'GET /categories');
    const flat = flattenCategories(cats);
    const leaf = flat.find((c) => c.key && c.id && c.parentId) ?? flat.find((c) => c.key && c.id);
    if (leaf === undefined) throw new Error('no category to budget or rule against');
    const rule = await expectStatus(
      api('POST', '/rules', {
        name: 'WP 9.4 coffee rule',
        conditions: { all: [{ type: 'payee', match: 'contains', value: 'COFFEE' }], any: [] },
        actions: [{ type: 'set_category', categoryKey: leaf.key }],
      }),
      [200, 201],
      'POST /rules',
    );
    const ruleId = rule.id ?? rule.rule?.id;
    // First, while W1's accounts are still open: recurring candidates come
    // from the worker replaying W1's ledger events into the detection
    // consumer. Poll, do not assume; a miss is recorded and W3 tries again.
    const recurring = await confirmRecurring(240_000);
    // W2's budget refuses (409 budgeting.balance_unreported) while any
    // on-budget account has no balance observation; a CSV file states none,
    // and W2 has no route that reports one for a non-manual account. W1's
    // file-import connection cannot take another file at W2 either: W2 made
    // staging durable and W1's was in memory only, so staging onto it answers
    // 409 connector.auth_required, "upload the file again" (finding F-94-7).
    // So the holder does what W2 says: the statements again, as OFX (which
    // carries balances), on a new file-import connection; then the W1 CSV
    // accounts, superseded, are closed (a closed account leaves the budget's
    // identity; its transactions stay readable). Opening the budget before
    // this would leave a budget that dead-letters the actuals consumer (F-94-5).
    const ledger = [
      {
        id: 'wp94-ofx-checking',
        kind: 'STMTRS',
        from: 'BANKACCTFROM',
        type: 'CHECKING',
        bal: '2500.00',
      },
      {
        id: 'wp94-ofx-savings',
        kind: 'STMTRS',
        from: 'BANKACCTFROM',
        type: 'SAVINGS',
        bal: '10000.00',
      },
      // A paid-off card: W2's first period opens every card line from
      // carryover 0, so a card already owing at that moment fails identity II
      // (409 budgeting.card_identity_violation, owed ≠ available + unfunded;
      // chain attempt 4). Recorded as an observation, not exercised here.
      { id: 'wp94-ofx-card', kind: 'CCSTMTRS', from: 'CCACCTFROM', type: null, bal: '0.00' },
    ];
    const asOf = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    const statements = ledger.map((a) => {
      const msg = a.kind === 'STMTRS' ? 'BANKMSGSRSV1' : 'CREDITCARDMSGSRSV1';
      const trn = a.kind === 'STMTRS' ? 'STMTTRNRS' : 'CCSTMTTRNRS';
      const acct = [
        `<${a.from}>`,
        ...(a.type === null ? [] : ['<BANKID>021000021']),
        `<ACCTID>${a.id}`,
        ...(a.type === null ? [] : [`<ACCTTYPE>${a.type}`]),
        `</${a.from}>`,
      ];
      return [
        `<${msg}>`,
        `<${trn}>`,
        '<TRNUID>1',
        '<STATUS><CODE>0<SEVERITY>INFO</STATUS>',
        `<${a.kind}>`,
        '<CURDEF>USD',
        ...acct,
        '<BANKTRANLIST>',
        `<DTSTART>${asOf}`,
        `<DTEND>${asOf}`,
        '</BANKTRANLIST>',
        '<LEDGERBAL>',
        `<BALAMT>${a.bal}`,
        `<DTASOF>${asOf}120000`,
        '</LEDGERBAL>',
        `</${a.kind}>`,
        `</${trn}>`,
        `</${msg}>`,
      ].join('\n');
    });
    const ofx = [
      'OFXHEADER:100',
      'DATA:OFXSGML',
      'VERSION:102',
      'SECURITY:NONE',
      'ENCODING:USASCII',
      'CHARSET:1252',
      'COMPRESSION:NONE',
      'OLDFILEUID:NONE',
      'NEWFILEUID:NONE',
      '',
      '<OFX>',
      ...statements,
      '</OFX>',
      '',
    ].join('\n');
    const statement = await expectStatus(
      api(
        'POST',
        '/imports/csv',
        {
          displayName: 'Statements (WP 9.4)',
          files: [{ name: 'statements.ofx', format: 'ofx', content: ofx }],
        },
        { timeoutMs: 120_000 },
      ),
      200,
      'POST /imports/csv (OFX statement balances)',
    );
    const all = await expectStatus(api('GET', '/accounts'), 200, 'GET /accounts');
    const superseded = (all.accounts ?? []).filter(
      (a) => a.connectionId === facts.W1?.connectionId && a.closedAt === null,
    );
    for (const a of superseded) {
      await expectStatus(
        api('PATCH', `/accounts/${a.id}`, { closed: true }),
        200,
        'PATCH /accounts/:id (closed)',
      );
    }
    let budget;
    const budgetDeadline = Date.now() + 120_000;
    for (;;) {
      const res = await api('GET', '/budgets/current');
      if (res.status === 200) {
        budget = res.json;
        break;
      }
      if (Date.now() > budgetDeadline)
        throw new Error(`GET /budgets/current: HTTP ${res.status} ${res.text.slice(0, 300)}`);
      await new Promise((r) => setTimeout(r, 5_000));
    }
    const line = await expectStatus(
      api('POST', '/budgets/lines', {
        periodId: budget.period.id,
        categoryId: leaf.id,
        rolloverPolicy: 'ROLLOVER',
        goalType: 'NONE',
      }),
      [200, 201],
      'POST /budgets/lines',
    );
    const lineId = line.line?.id ?? line.id;
    await expectStatus(
      api('PATCH', `/budgets/lines/${lineId}`, { assigned: { minor: '50000', currency: 'USD' } }),
      200,
      'PATCH /budgets/lines/:id',
    );
    facts.W2 = {
      balances: {
        via: 'OFX statements (LEDGERBAL) on a new file-import connection',
        connectionId: statement.connectionId,
        status: statement.status ?? null,
        accounts: ledger.map((a) => `${a.id}=${a.bal}`),
        closedW1Accounts: superseded.map((a) => a.id),
      },
      category: { id: leaf.id, key: leaf.key },
      ruleId,
      budget: {
        budgetId: budget.budgetId,
        periodId: budget.period.id,
        lineId,
        assignedMinor: '50000',
      },
      recurring,
      dismissedInsight:
        'NOT LOADABLE at W2 through its API: no route writes snapshot_grants, and POST /advisors/run needs a non-empty advisor_token_secret (finding F-94-3); loaded at W5 instead',
    };
    saveFacts();
    return facts.W2;
  },

  /** W3: a manual investment account (balance only — W3 has no holdings route), a watch-only wallet. */
  async W3() {
    await session();
    const manual = await expectStatus(
      fresh(() =>
        api('POST', '/connections', {
          provider: 'manual',
          input: {
            displayName: 'WP 9.4 brokerage',
            accounts: [
              {
                providerAccountId: 'wp94-brk-1',
                name: 'Taxable Brokerage',
                type: 'investment',
                subtype: 'brokerage',
                currency: 'USD',
                mask: '9401',
              },
            ],
          },
        }),
      ),
      201,
      'POST /connections (manual investment)',
    );
    const accountId = manual.accountIds[0];
    await expectStatus(
      fresh(() =>
        api('POST', `/accounts/${accountId}/balance`, {
          current: { minor: '1500000', currency: 'USD' },
        }),
      ),
      [200, 201],
      'POST /accounts/:id/balance',
    );
    const wallet = await expectStatus(
      fresh(() =>
        api('POST', '/connections', {
          provider: 'wallet_rpc',
          input: {
            chain: 'bitcoin',
            // The walletrpc package's own public test fixture (BIP84 vector).
            value:
              'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs',
            label: 'WP 9.4 watch-only',
          },
        }),
      ),
      201,
      'POST /connections (wallet_rpc)',
    );
    // W2 could not confirm a series within its window (recorded there): the
    // same holder action at W3, on the same W1 transactions.
    const recurring = facts.W2?.recurring?.seriesId ? undefined : await confirmRecurring(240_000);
    facts.W3 = {
      ...(recurring === undefined ? {} : { recurring }),
      investment: { connectionId: manual.connectionId, accountId, balanceMinor: '1500000' },
      wallet: { connectionId: wallet.connectionId, accountIds: wallet.accountIds },
      holdings:
        'NOT LOADABLE at W3 through its API: no route adds a holding to a manual account (finding F-94-4)',
    };
    saveFacts();
    return facts.W3;
  },

  /** W4: a plan, a goal, an assumption override, a deterministic projection. */
  async W4() {
    await session();
    const scenario = await expectStatus(
      api('POST', '/plan/scenarios', {
        kind: 'baseline',
        name: 'WP 9.4 baseline',
        profile: {
          birthDate: '1985-06-15',
          retirementAge: 65,
          planEndAge: 95,
          currency: 'USD',
          glidepath: { kind: 'age_based' },
          contributionGrowth: 'flat',
          annualSpending: { minor: '6000000', currency: 'USD' },
          withdrawalPolicy: 'constant_real',
          spendingFloor: 'none',
          taxDeferredRate: '0.22',
          socialSecurity: null,
          pensions: [],
          contributions: null,
        },
      }),
      [200, 201],
      'POST /plan/scenarios',
    );
    const scenarioId = scenario.id ?? scenario.scenario?.id;
    const goal = await expectStatus(
      api('POST', '/goals', {
        kind: 'emergency_fund',
        name: 'WP 9.4 rainy day',
        target: { minor: '2000000', currency: 'USD' },
        targetDate: '2028-01-01',
        priority: 2,
        fundedFromAccountIds: [facts.W3?.investment?.accountId].filter(Boolean),
      }),
      [200, 201],
      'POST /goals',
    );
    const goalId = goal.id ?? goal.goal?.id;
    const assumptions = await expectStatus(api('GET', '/assumptions'), 200, 'GET /assumptions');
    const path = 'capitalMarket.usEquity.expectedReturn';
    const value = '0.0555';
    await expectStatus(
      api('PUT', '/assumptions/overrides', { overrides: { [path]: value } }),
      200,
      'PUT /assumptions/overrides',
    );
    // A projection starts from a net-worth day. With no `asOf`, W4 wants a
    // SEALED day (409 planning.projection_no_balances until one exists), and
    // an install loaded today has none. W4's own answer is `asOf` = today
    // with `allowOpenDay: true` (the run records `balances_sealed = false`).
    // Today's row is written by the snapshot job the harness moved to now,
    // so poll — on the 409 or on `status: 'stale', run: null` — up to 300 s.
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: facts.W0?.displayTimezone ?? 'UTC',
    }).format(new Date());
    let projection;
    let last;
    const projDeadline = Date.now() + 300_000;
    for (;;) {
      const res = await api('POST', `/plan/scenarios/${scenarioId}/projections`, {
        method: 'deterministic',
        allowOpenDay: true,
        asOf: today,
      });
      if (res.status === 200 && res.json?.run) {
        projection = res.json;
        break;
      }
      if (res.status !== 200 && res.status !== 409)
        throw new Error(
          `POST /plan/scenarios/:id/projections: HTTP ${res.status} ${res.text.slice(0, 300)}`,
        );
      last = `HTTP ${res.status} ${res.text.slice(0, 240)}`;
      if (Date.now() > projDeadline)
        throw new Error(`no projection run for ${today} after 300 s: last ${last}`);
      await new Promise((r) => setTimeout(r, 10_000));
    }
    facts.W4 = {
      scenarioId,
      goalId,
      assumption: { path, value, version: assumptions.version },
      projection: {
        runId: projection.run.id,
        method: projection.run.method,
        status: projection.status,
        asOf: today,
        balancesSealed: projection.run.balancesSealed ?? null,
      },
    };
    saveFacts();
    return facts.W4;
  },

  /** W5: a published Brief (schedule shortened by the harness), a dismissal with a reason code. */
  async W5() {
    await session();
    const advisors = await expectStatus(api('GET', '/advisors'), 200, 'GET /advisors');
    let granted = 0;
    for (const advisor of advisors.advisors.filter((a) => a.kind === 'builtin')) {
      const scopes = await api('GET', `/advisors/${encodeURIComponent(advisor.advisorId)}/scopes`);
      // A scope that needs consent per run is refused in a standing grant
      // with perRunConsent false; W5 marks each one on its definition.
      const permitted = (scopes.json?.permitted ?? scopes.json?.scopes ?? [])
        .filter((s) => typeof s === 'string' || s.requiresPerRunConsent !== true)
        .map((s) => (typeof s === 'string' ? s : s.scope))
        .filter((s) => s && s !== 'transactions.raw' && s !== 'institutions.names');
      if (permitted.length === 0) continue;
      const res = await fresh(() =>
        api('PUT', `/advisors/${encodeURIComponent(advisor.advisorId)}/grants`, {
          scopes: permitted,
          perRunConsent: false,
        }),
      );
      if (res.status === 200) granted += 1;
    }
    const run = await expectStatus(
      fresh(() => api('POST', '/advisors/run', {}, { timeoutMs: 180_000 })),
      200,
      'POST /advisors/run',
    );
    const inserted = run.results.reduce((n, r) => n + (r.inserted ?? 0), 0);
    const list = await expectStatus(api('GET', '/insights'), 200, 'GET /insights');
    const all = [
      ...(list.dashboard ?? []),
      ...(list.list ?? []),
      ...(list.overflow ?? []),
      ...(list.belowFloor ?? []),
    ];
    const target = all.find((i) => i.status === 'pending_review') ?? all[0];
    if (target === undefined)
      throw new Error(`no insight to dismiss (advisors granted ${granted}, inserted ${inserted})`);
    await expectStatus(
      api('POST', `/insights/${target.id}/review`, {
        action: 'dismiss',
        reasonCode: 'NOT_ACTIONABLE',
        reason: null,
      }),
      200,
      'POST /insights/:id/review',
    );
    facts.W5 = {
      advisorsGranted: granted,
      insightsInserted: inserted,
      insightTotal: all.length,
      dismissed: {
        insightId: target.id,
        advisorId: target.advisorId,
        reasonCode: 'NOT_ACTIONABLE',
      },
    };
    saveFacts();
    return facts.W5;
  },
};

/**
 * Confirm one recurring candidate, polling up to `limitMs` while the worker
 * replays W1's ledger events into detection. Returns null (with the reason)
 * rather than throwing: an era whose worker has not detected a series in the
 * window is a fact to record, and the next era tries again.
 */
async function confirmRecurring(limitMs) {
  let candidates = [];
  let lastStatus = 0;
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    const res = await api('GET', '/recurring/candidates');
    lastStatus = res.status;
    candidates = res.json?.candidates ?? res.json?.items ?? [];
    if (res.status === 200 && candidates.length > 0) break;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  if (candidates.length === 0) {
    return {
      seriesId: null,
      notLoaded: `no recurring candidate within ${limitMs / 1000} s (last HTTP ${lastStatus})`,
    };
  }
  const pick = candidates[0];
  const confirmed = await expectStatus(
    api('POST', `/recurring/candidates/${pick.id ?? pick.candidateId}/confirm`, { reason: null }),
    [200, 201],
    'POST /recurring/candidates/:id/confirm',
  );
  return { seriesId: confirmed.seriesId, candidatesSeen: candidates.length };
}

/** W5's Brief, after the harness shortened the schedule: wait for it, record it. */
async function awaitBrief(limitMs) {
  await session();
  const deadline = Date.now() + limitMs;
  for (;;) {
    const res = await api('GET', '/insights/brief/current');
    if (res.status === 200) {
      const b = res.json.brief;
      facts.W5 = {
        ...(facts.W5 ?? {}),
        brief: { id: b.id, isoWeek: b.isoWeek, items: b.items.length, publishedAt: b.publishedAt },
      };
      saveFacts();
      return facts.W5.brief;
    }
    if (Date.now() > deadline)
      throw new Error(`no Brief published within ${limitMs / 1000} s (last HTTP ${res.status})`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

function flattenCategories(body) {
  const out = [];
  const walk = (node, parentId) => {
    if (Array.isArray(node)) return node.forEach((n) => walk(n, parentId));
    if (node === null || typeof node !== 'object') return;
    if (typeof node.id === 'string' && typeof node.key === 'string') {
      out.push({ id: node.id, key: node.key, parentId: node.parentId ?? parentId ?? null });
    }
    for (const k of ['categories', 'children', 'items', 'groups']) {
      if (node[k] !== undefined) walk(node[k], node.id ?? parentId);
    }
  };
  walk(body, null);
  return out;
}

/** A logged-in session for data work: a passkey login if the jar has none that works. */
async function session() {
  const s = await call('GET', '/auth/session');
  if (s.status === 200) return s.json;
  return passkeyLogin();
}

// ---------------------------------------------------------------- verify

async function verify() {
  const results = [];
  // VERIFY_FACTS=W0 limits (ii) to the facts a given backup can hold.
  const scope = (process.env.VERIFY_FACTS ?? '').split(',').filter(Boolean);
  const want = (wp) => facts[wp] !== undefined && (scope.length === 0 || scope.includes(wp));
  const check = async (name, fn) => {
    try {
      const detail = await fn();
      results.push({ check: name, ok: true, detail });
    } catch (error) {
      results.push({ check: name, ok: false, detail: error.message });
    }
  };

  // (iii) first: it is also how we get a session.
  await check('iii.unlock', async () => {
    const u = await expectStatus(call('GET', '/auth/unlock-state'), 200, 'unlock-state');
    if (u.state !== 'unlocked') throw new Error(`state ${u.state} (${u.reason ?? ''})`);
    if (facts.W0 && u.kekVersion !== facts.W0.kekVersion) {
      throw new Error(`KEK generation ${u.kekVersion}, was ${facts.W0.kekVersion} at W0`);
    }
    return `unlocked, KEK generation ${u.kekVersion} (W0: ${facts.W0?.kekVersion})`;
  });
  await check('iii.passkey', async () => {
    const s = await passkeyLogin();
    if (facts.W0 && s.userId !== facts.W0.userId) throw new Error('logged in as a different user');
    return `W0's passkey logged in (fresh session, user ${s.userId.slice(0, 8)}…)`;
  });
  await check('iii.totp', async () => {
    const saved = { ...jar };
    let code = await freshTotp();
    let res = await call('POST', '/auth/totp/verify', { token: code, trustedDevice: false });
    let waited = 0;
    if (res.status === 429) {
      // The limiter counts every verification, successful or not, and the
      // chain verifies once per hop: wait out what it says, once, then retry.
      const fromHeader = Number(res.headers?.['retry-after']);
      const fromText = Number(/in (\d+) seconds?/.exec(res.text)?.[1]);
      waited = Number.isFinite(fromHeader) && fromHeader > 0 ? fromHeader : fromText;
      if (!Number.isFinite(waited) || waited > 330)
        throw new Error(`TOTP rate-limited for ${waited} s: ${res.text.slice(0, 160)}`);
      await new Promise((r) => setTimeout(r, (waited + 2) * 1000));
      jar = { ...saved };
      code = await freshTotp();
      res = await call('POST', '/auth/totp/verify', { token: code, trustedDevice: false });
    }
    jar = saved; // keep the passkey session for the reads below
    writeSecret(P.cookies, jar);
    if (res.status !== 200)
      throw new Error(`TOTP from W0's secret: HTTP ${res.status} ${res.text.slice(0, 160)}`);
    return `a TOTP code from W0's secret verified (POST /auth/totp/verify 200)${waited ? ` after waiting out a ${waited} s rate limit` : ''}`;
  });

  if (want('W0')) {
    await check('ii.W0', async () => {
      const s = await expectStatus(call('GET', '/auth/session'), 200, 'session');
      const c = await expectStatus(call('GET', '/auth/credentials'), 200, 'credentials');
      const ids = c.credentials.map((x) => x.credentialId).sort();
      const want = facts.W0;
      const bad = [];
      if (s.displayName !== want.displayName) bad.push('displayName');
      if (s.displayTimezone !== want.displayTimezone) bad.push('displayTimezone');
      if (s.totpEnrolled !== true) bad.push('totpEnrolled');
      const expectedCodes = 10 - readJson(P.recovery, { used: [] }).used.length;
      if (s.recoveryCodesRemaining !== expectedCodes)
        bad.push(`recoveryCodesRemaining ${s.recoveryCodesRemaining}≠${expectedCodes}`);
      if (JSON.stringify(ids) !== JSON.stringify(want.credentialIds)) bad.push('credential ids');
      if (bad.length) throw new Error(`differs: ${bad.join(', ')}`);
      return `user, tz, 1 passkey (same id), TOTP enrolled, ${expectedCodes} recovery codes`;
    });
  }
  if (want('W1')) {
    await check('ii.W1', async () => {
      const f = facts.W1;
      const first = await expectStatus(api('GET', '/transactions?limit=1'), 200, 'transactions');
      if (first.summary?.count !== f.transactionCount)
        throw new Error(`count ${first.summary?.count} ≠ ${f.transactionCount}`);
      const t = await expectStatus(
        api('GET', `/transactions/${f.override.transactionId}`),
        200,
        'transaction',
      );
      if (t.categoryId !== f.override.categoryId)
        throw new Error(`override ${t.categoryId} ≠ ${f.override.categoryId}`);
      if (JSON.stringify(t.amount) !== JSON.stringify(f.spot.amount))
        throw new Error(
          `spot amount ${JSON.stringify(t.amount)} ≠ ${JSON.stringify(f.spot.amount)}`,
        );
      return `${f.transactionCount} transactions; override and spot amount on ${f.override.transactionId.slice(0, 8)}… intact`;
    });
  }
  if (want('W2')) {
    await check('ii.W2', async () => {
      const f = facts.W2;
      const rules = await expectStatus(api('GET', '/rules'), 200, 'rules');
      if (!(rules.rules ?? []).some((r) => r.id === f.ruleId))
        throw new Error(`rule ${f.ruleId} missing`);
      const b = await expectStatus(api('GET', '/budgets/current'), 200, 'budget');
      const line = (b.period?.lines ?? []).find((l) => l.id === f.budget.lineId);
      if (line === undefined)
        throw new Error(`budget line ${f.budget.lineId} missing from the current period`);
      if (String(line.assigned?.minor) !== f.budget.assignedMinor)
        throw new Error(`assigned ${line.assigned?.minor}`);
      let seriesNote = `recurring not loaded at W2 (${f.recurring?.notLoaded ?? 'unknown'})`;
      if (f.recurring?.seriesId) {
        const series = await expectStatus(api('GET', '/recurring/series'), 200, 'series');
        const s = (series.series ?? []).find((x) => x.id === f.recurring.seriesId);
        if (s === undefined || s.userConfirmed !== true)
          throw new Error(`series ${f.recurring.seriesId} missing or unconfirmed`);
        seriesNote = 'confirmed recurring series';
      }
      return `rule, budget line (assigned 500.00), ${seriesNote} intact`;
    });
  }
  if (want('W3')) {
    await check('ii.W3', async () => {
      const f = facts.W3;
      const accounts = await expectStatus(
        api('GET', '/accounts?includeClosed=true'),
        200,
        'accounts',
      );
      const inv = (accounts.accounts ?? []).find((a) => a.id === f.investment.accountId);
      if (inv === undefined) throw new Error('investment account missing');
      const conns = await expectStatus(api('GET', '/connections'), 200, 'connections');
      const w = (conns.connections ?? []).find(
        (c) => (c.id ?? c.connectionId) === f.wallet.connectionId,
      );
      if (w === undefined) throw new Error('wallet connection missing');
      const bal = inv.balance?.current?.minor ?? inv.balance?.minor ?? null;
      if (bal !== null && String(bal) !== f.investment.balanceMinor)
        throw new Error(`balance ${bal}`);
      let seriesNote = '';
      if (f.recurring?.seriesId) {
        const series = await expectStatus(api('GET', '/recurring/series'), 200, 'series');
        const s = (series.series ?? []).find((x) => x.id === f.recurring.seriesId);
        if (s === undefined || s.userConfirmed !== true)
          throw new Error(
            `series ${f.recurring.seriesId} (confirmed at W3) missing or unconfirmed`,
          );
        seriesNote = ', recurring series confirmed at W3';
      }
      return `investment account (balance ${bal ?? 'n/a'}), wallet connection${seriesNote} intact`;
    });
  }
  if (want('W4')) {
    await check('ii.W4', async () => {
      const f = facts.W4;
      const sc = await expectStatus(api('GET', '/plan/scenarios'), 200, 'scenarios');
      if (!(sc.scenarios ?? []).some((s) => s.id === f.scenarioId))
        throw new Error('scenario missing');
      await expectStatus(api('GET', `/goals/${f.goalId}`), 200, 'goal');
      const a = await expectStatus(api('GET', '/assumptions'), 200, 'assumptions');
      const o = (a.overrides ?? []).find((x) => x.path === f.assumption.path);
      if (o === undefined || String(o.value) !== f.assumption.value)
        throw new Error(`override ${JSON.stringify(o)}`);
      // GET /plan/projections/:runId answers the projection outcome,
      // `{ status, run, staleness }`, the same shape the POST returned.
      const outcome = await expectStatus(
        api('GET', `/plan/projections/${f.projection.runId}`),
        200,
        'projection',
      );
      const run = outcome.run;
      if (run?.id !== f.projection.runId || run?.method !== 'deterministic')
        throw new Error(`run ${run?.id} method ${run?.method} (outcome ${outcome.status})`);
      return `scenario, goal, assumption override, deterministic run (${outcome.status}, asOf ${run.asOfDate ?? f.projection.asOf}) intact`;
    });
  }
  if (want('W5')) {
    await check('ii.W5', async () => {
      const f = facts.W5;
      const i = await expectStatus(
        api('GET', `/insights/${f.dismissed.insightId}`),
        200,
        'insight',
      );
      const status = i.status ?? i.insight?.status;
      if (status !== 'dismissed') throw new Error(`insight status ${status}`);
      const health = await expectStatus(api('GET', '/advisors/rule-health'), 200, 'rule-health');
      const row = (health.advisors ?? []).find((a) => a.advisorId === f.dismissed.advisorId);
      if ((row?.dismissedByReason?.NOT_ACTIONABLE ?? 0) < 1)
        throw new Error('NOT_ACTIONABLE not counted');
      if (f.brief) {
        const b = await expectStatus(
          api('GET', `/insights/brief/${f.brief.isoWeek}`),
          200,
          'brief',
        );
        if (b.brief.id !== f.brief.id || b.brief.items.length !== f.brief.items)
          throw new Error('brief differs');
      }
      return `dismissal (NOT_ACTIONABLE) intact${f.brief ? `, Brief ${f.brief.isoWeek} (${f.brief.items} items) intact` : ''}`;
    });
  }
  return results;
}

// ------------------------------------------------------------------ main

const [command, arg] = process.argv.slice(2);
try {
  if (command === 'register') {
    const token = readFileSync(arg, 'utf8').trim();
    const out = await ceremony('register', { token, friendlyName: 'WP 9.4 virtual authenticator' });
    say(
      JSON.stringify({
        registered: true,
        credentialCount: out.credentialCount,
        signedIn: out.signedIn,
      }),
    );
  } else if (command === 'enrol-factors') {
    await primeCsrf();
    say(JSON.stringify(await loads.W0()));
  } else if (command === 'load') {
    await primeCsrf();
    if (loads[arg] === undefined) throw new Error(`no load for ${arg}`);
    const out = await loads[arg]();
    say(JSON.stringify(out));
  } else if (command === 'await-brief') {
    await primeCsrf();
    say(JSON.stringify(await awaitBrief(Number(arg ?? '420') * 1000)));
  } else if (command === 'verify') {
    await primeCsrf();
    const results = await verify();
    for (const r of results) say(`${r.ok ? 'pass' : 'FAIL'} ${r.check}: ${r.detail}`);
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  } else if (command === 'status') {
    const u = await call('GET', '/auth/unlock-state');
    say(JSON.stringify({ unlockState: u.status, body: u.json }));
  } else if (command === 'recovery-code') {
    await primeCsrf();
    const r = readJson(P.recovery, null);
    const code = r.codes.find((c) => !r.used.includes(c));
    const res = await call('POST', '/auth/recovery-code/verify', { code });
    if (res.status === 200) {
      r.used.push(code);
      writeSecret(P.recovery, r);
    }
    say(JSON.stringify({ status: res.status, remainingCodes: res.json?.remainingCodes }));
    process.exit(res.status === 200 ? 0 : 1);
  } else {
    warn(
      'usage: driver.mjs register|enrol-factors|load <wp>|await-brief [s]|verify|status|recovery-code',
    );
    process.exit(2);
  }
} catch (error) {
  warn(`driver: ${error.message}`);
  process.exit(1);
}
