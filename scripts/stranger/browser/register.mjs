/* global document -- used inside page.evaluate (page context) */
// The README's step 9, as a person would do it: open the whole link, enrol a passkey on "this device", enrol a second
// authenticator ("a phone or a security key") if the wizard offers one, and save whatever recovery codes it shows.
// Credentials of the virtual authenticators are saved after EVERY step to /home/pf/harness/credentials.json.
import fs from 'node:fs';
import { out, launch, describe, addAuthenticator, clickText, sleep, CREDS } from './lib.mjs';
const link = process.argv[2];
const { browser, page } = await launch();
page.on('response', (r) => {
  if (r.url().includes('/api/auth')) out('[resp]', r.status(), r.request().method(), r.url());
});
const auths = [];
const save = async () => {
  const creds = [];
  for (const a of auths) {
    const { credentials } = await a.cdp.send('WebAuthn.getCredentials', {
      authenticatorId: a.authenticatorId,
    });
    creds.push(...credentials);
  }
  fs.writeFileSync(CREDS, JSON.stringify(creds, null, 1));
  out('credentials saved:', creds.length);
};
const text = () => page.evaluate(() => document.body.innerText);
auths.push(await addAuthenticator(page, 'internal'));
await page.goto(link, { waitUntil: 'networkidle2', timeout: 60000 });
await page.waitForSelector('#friendly-name');
await sleep(3000); // let the app hydrate: a click before that is lost (seen on a cold first load)
await page.type('#friendly-name', 'Virtual passkey (this device)');
for (let attempt = 1; attempt <= 3; attempt += 1) {
  const sent = page
    .waitForResponse((r) => r.url().includes('/api/auth/register/options'), { timeout: 15000 })
    .then(
      () => true,
      () => false,
    );
  await page.click('button[type=submit]');
  if (await sent) break;
  out('[no register/options request after click, attempt ' + attempt + ']');
}
await sleep(6000);
await save();
await describe(page, 'reg-step2');
if ((await text()).includes('backup passkey')) {
  auths.push(await addAuthenticator(page, 'usb')); // "a security key"
  await page.evaluate(() => {
    document.querySelector('#friendly-name').select();
  });
  await page.keyboard.press('Backspace');
  await page.type('#friendly-name', 'Virtual security key');
  await page.click('button[type=submit]');
  await sleep(6000);
  await save();
  await describe(page, 'reg-step3');
}
// Recovery-codes step (candidate README: shown once; tick the "saved" box to continue). Only the COUNT is ever printed.
if (/recovery code/i.test(await text()) && !(await text()).includes('Continue to PersonalFi')) {
  await clickText(page, 'Create my recovery codes', 'button');
  await sleep(3000);
  await describe(page, 'reg-recovery'); // code-like tokens are masked and counted by describe
  await page.click('input[type=checkbox],[role=checkbox]');
  await sleep(500);
  await clickText(page, 'continue', 'button');
  await sleep(4000);
  await describe(page, 'reg-after-recovery');
}
if ((await text()).includes('Continue to PersonalFi')) {
  await clickText(page, 'Continue to PersonalFi');
  await sleep(4000);
  await describe(page, 'reg-step4');
}
await browser.close();
