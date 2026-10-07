import { launch, describe, addAuthenticator, login, sleep } from './lib.mjs';
const [path, tag] = process.argv.slice(2);
const { browser, page } = await launch();
const auth = await addAuthenticator(page, 'internal');
await login(page, auth);
await page.goto('https://personalfi.lan' + path, { waitUntil: 'networkidle2', timeout: 60000 });
await sleep(1500);
await describe(page, tag);
await browser.close();
