/* global document -- used inside page.evaluate (page context) */
// README 'Your first data' step 1, literal: Accounts > Add account > Add connection > File import; preset ISO date;
// name the account; choose the file. (Connection name left as the README says nothing about it.)
import { out, launch, describe, addAuthenticator, login, clickText, sleep } from './lib.mjs';
const [accountName, connName] = process.argv.slice(2);
const { browser, page } = await launch();
page.on('response', async (r) => {
  if (r.url().includes('/api/') && r.request().method() !== 'GET')
    out('[resp]', r.status(), r.request().method(), r.url());
});
const auth = await addAuthenticator(page, 'internal');
await login(page, auth);
await page.goto('https://personalfi.lan/accounts', { waitUntil: 'networkidle2', timeout: 60000 });
await clickText(page, 'Add account');
await sleep(1500);
await clickText(page, 'Add connection');
await sleep(1500);
await clickText(page, 'File import');
await sleep(800);
await page.select(
  '#csv-preset',
  await page.evaluate(
    () =>
      [...document.querySelector('#csv-preset').options].find((o) =>
        o.text.startsWith('ISO date, one signed amount'),
      ).value,
  ),
);
await page.type('#csv-account-name', accountName);
if (connName) await page.type('#csv-display-name', connName);
const input = await page.$('#csv-file');
await input.uploadFile('/home/pf/personalfi/sample.csv');
await sleep(500);
out(
  'invalid before submit:',
  await page.evaluate(() =>
    [...document.querySelectorAll('input:invalid')].map((i) => i.id + ': ' + i.validationMessage),
  ),
);
await clickText(page, 'Import', '[role=dialog] button', true);
await sleep(5000);
await describe(page, 'import1');
await page.goto('https://personalfi.lan/transactions', {
  waitUntil: 'networkidle2',
  timeout: 60000,
});
await sleep(2500);
await describe(page, 'import2');
await browser.close();
