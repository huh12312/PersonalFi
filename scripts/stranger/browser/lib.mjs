// Harness-only: headless Chromium driven over CDP (puppeteer-core), with a virtual WebAuthn authenticator.
/* global document, location -- these run in the page context via page.evaluate */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

// The one logger: stdout, no console.
export const out = (...a) => process.stdout.write(a.map(String).join(' ') + '\n');

// Recovery codes must never reach a log: mask code-like tokens (hyphenated groups, or long tokens with a digit) and count them.
export const codeCount = { n: 0 };
export const mask = (t) =>
  String(t).replace(
    /\b[A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+\b|\b(?=[A-Za-z0-9-]*\d)[A-Za-z0-9]{3,}(?:-[A-Za-z0-9]{3,})+\b|\b(?=[A-Za-z]*\d)[A-Za-z0-9]{8,}\b/g,
    () => {
      codeCount.n += 1;
      return '<code>';
    },
  );

export const CREDS = '/home/pf/harness/credentials.json';
export const SHOTS = '/home/pf/harness/shots';
fs.mkdirSync(SHOTS, { recursive: true });

export async function launch() {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1280,1000'],
    defaultViewport: { width: 1280, height: 1000 },
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => out('[pageerror]', String(e).slice(0, 300)));
  page.on('console', (m) => {
    if (['error', 'warning'].includes(m.type()))
      out('[console.' + m.type() + ']', m.text().slice(0, 300));
  });
  return { browser, page };
}

// A CTAP2 platform-like authenticator that auto-approves presence and user verification.
export async function addAuthenticator(page, transport = 'internal') {
  const cdp = await page.createCDPSession();
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport,
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, authenticatorId };
}

export async function saveCredentials(a) {
  const { credentials } = await a.cdp.send('WebAuthn.getCredentials', {
    authenticatorId: a.authenticatorId,
  });
  fs.writeFileSync(CREDS, JSON.stringify(credentials, null, 1));
  return credentials.length;
}

export async function restoreCredentials(a) {
  // One virtual authenticator = the passkey 'on this device' (the first enrolled); the second authenticator is not restored.
  const creds = JSON.parse(fs.readFileSync(CREDS, 'utf8')).slice(0, 1);
  // The server refuses a signature counter that did not advance. A time-based counter always advances, even if an
  // earlier session's final counter was never saved (the app may also sign in by itself via conditional mediation).
  const signCount = Math.floor(Date.now() / 1000);
  for (const credential of creds)
    await a.cdp.send('WebAuthn.addCredential', {
      authenticatorId: a.authenticatorId,
      credential: { ...credential, signCount },
    });
  return creds.length;
}

export async function describe(page, tag) {
  const png = `${SHOTS}/${tag}.png`;
  await page.screenshot({ path: png, fullPage: true });
  const info = await page.evaluate(() => {
    const vis = (e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const els = [
      ...document.querySelectorAll(
        'a,button,input,select,textarea,[role=tab],[role=button],[role=dialog]',
      ),
    ]
      .filter(vis)
      .map(
        (e) =>
          `${e.tagName.toLowerCase()}${e.type ? '[' + e.type + ']' : ''}${e.getAttribute('role') ? '{' + e.getAttribute('role') + '}' : ''} name=${e.name || ''} id=${e.id || ''} aria=${e.getAttribute('aria-label') || ''} text=${(e.innerText || e.value || '').trim().slice(0, 60).replace(/\s+/g, ' ')}`,
      );
    return {
      url: location.href,
      title: document.title,
      text: document.body.innerText.slice(0, 1800),
      els,
    };
  });
  codeCount.n = 0;
  const text = mask(info.text);
  const els = mask(info.els.join('\n'));
  out(
    `--- ${tag}: ${info.url} | ${info.title}\n${text}\n--- interactive:\n${els}\n--- screenshot ${png}` +
      (codeCount.n ? `\n--- [${codeCount.n} code-like tokens masked on this page]` : ''),
  );
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function clickText(
  page,
  text,
  sel = 'button,a,[role=tab],[role=button]',
  exact = false,
) {
  const h = await page.evaluateHandle(
    (text, sel, exact) =>
      [...document.querySelectorAll(sel)].find((e) => {
        const t = (e.innerText || '').trim().toLowerCase();
        return (
          (exact ? t === text.toLowerCase() : t.includes(text.toLowerCase())) &&
          e.getBoundingClientRect().width > 0
        );
      }),
    text,
    sel,
    exact,
  );
  const el = h.asElement();
  if (!el) throw new Error('no element with text: ' + text);
  await el.click();
}

export async function login(page, auth) {
  await restoreCredentials(auth);
  await page.goto('https://personalfi.lan/', { waitUntil: 'networkidle2', timeout: 60000 });
  // Either the sign-in page, or the app has already signed in by itself (conditional mediation).
  await page.waitForFunction(
    () =>
      document.body.innerText.includes('Sign in with a passkey') ||
      document.body.innerText.includes('OVERVIEW'),
    { timeout: 30000 },
  );
  await describe(page, 'login1');
  if ((await page.evaluate(() => document.body.innerText)).includes('Sign in with a passkey')) {
    try {
      await clickText(page, 'Sign in with a passkey');
    } catch {
      // the app signed in by itself while we were clicking; the wait below settles it
    }
  }
  await page.waitForFunction(() => document.body.innerText.includes('OVERVIEW'), {
    timeout: 30000,
  });
  await sleep(1000);
  await saveCredentials(auth);
}
