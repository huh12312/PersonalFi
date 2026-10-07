// README: Manual account tab creates an account entered by hand.
import { out, launch, describe, addAuthenticator, login, clickText, sleep } from './lib.mjs';
const [name] = process.argv.slice(2);
const { browser, page } = await launch();
page.on('response', (r) => {
  if (r.url().includes('/api/') && r.request().method() !== 'GET')
    out('[resp]', r.status(), r.request().method(), r.url());
});
const auth = await addAuthenticator(page, 'internal');
await login(page, auth);
await page.goto('https://personalfi.lan/accounts/connections', {
  waitUntil: 'networkidle2',
  timeout: 60000,
});
await clickText(page, 'Add connection');
await sleep(1200);
await clickText(page, 'Manual account');
await sleep(800);
await page.type('#manual-account-name', name);
await clickText(page, 'Add account', '[role=dialog] button', true);
await sleep(4000);
await page.goto('https://personalfi.lan/accounts', { waitUntil: 'networkidle2', timeout: 60000 });
await sleep(2000);
await describe(page, 'manual1');
await browser.close();
