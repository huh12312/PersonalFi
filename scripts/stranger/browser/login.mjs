import { out, launch, describe, addAuthenticator, login } from './lib.mjs';
const { browser, page } = await launch();
page.on('response', (r) => {
  if (r.url().includes('/api/auth')) out('[resp]', r.status(), r.request().method(), r.url());
});
const auth = await addAuthenticator(page, 'internal');
await login(page, auth);
await describe(page, 'login2');
await browser.close();
