// Harness-only: headless Chromium driven over CDP (puppeteer-core), with a virtual WebAuthn authenticator.
/* global document, location -- these run in the page context via page.evaluate */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

// The one logger: stdout, no console.
export const out = (...a) => process.stdout.write(a.map(String).join(' ') + '\n');

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
  const creds = JSON.parse(fs.readFileSync(CREDS, 'utf8'));
  for (const credential of creds)
    await a.cdp.send('WebAuthn.addCredential', { authenticatorId: a.authenticatorId, credential });
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
  out(
    `--- ${tag}: ${info.url} | ${info.title}\n${info.text}\n--- interactive:\n${info.els.join('\n')}\n--- screenshot ${png}`,
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
  await page.waitForFunction(() => document.body.innerText.includes('Sign in with a passkey'), {
    timeout: 30000,
  });
  await describe(page, 'login1');
  await clickText(page, 'Sign in with a passkey');
  await sleep(5000);
  await saveCredentials(auth); // keep the signature counter current: the server refuses a counter that did not advance
}
