import { launch, describe } from './lib.mjs';
const [url, tag] = process.argv.slice(2);
const { browser, page } = await launch();
await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
await describe(page, tag);
await browser.close();
