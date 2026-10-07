// harness recon: login, open a path, click the given texts in order, describing the page after each.
import { launch, describe, addAuthenticator, login, clickText, sleep } from './lib.mjs';
const [path, ...clicks] = process.argv.slice(2);
const { browser, page } = await launch();
const auth = await addAuthenticator(page, 'internal');
await login(page, auth);
await page.goto('https://personalfi.lan' + path, { waitUntil: 'networkidle2', timeout: 60000 });
await sleep(1500);
await describe(page, 'nav0');
let i = 0;
for (const c of clicks) {
  await clickText(page, c);
  await sleep(1500);
  await describe(page, 'nav' + ++i);
}
await browser.close();
