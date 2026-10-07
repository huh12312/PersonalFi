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
await page.type('#friendly-name', 'Virtual passkey (this device)');
await page.click('button[type=submit]');
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
if ((await text()).includes('Continue to PersonalFi')) {
  await clickText(page, 'Continue to PersonalFi');
  await sleep(4000);
  await describe(page, 'reg-step4');
}
await browser.close();
