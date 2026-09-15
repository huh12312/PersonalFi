// SPDX-License-Identifier: MIT
// Must be the first import — see that module's header for why "first
// statement of this file" (which the previous version of this fix tried)
// isn't early enough.
import './lib/zod-jitless.ts';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app/App.tsx';
import { client } from './api/generated/client.gen.ts';
import { Sdk } from './api/generated/index.ts';
import { registerCsrfInterceptor } from './api/client-runtime-config.ts';
import { applyPrivacy, getHideAmounts } from './lib/privacy.ts';
import { applyTheme, getThemePreference } from './lib/theme.ts';
import './styles/base.css';

// Wires the CSRF header (client-runtime-config.ts's `registerCsrfInterceptor`
// — the generated client has no CSRF awareness of its own) and constructs the
// default `Sdk` instance every generated React Query hook resolves through
// (`Sdk.__registry.get()` in `generated/@tanstack/react-query.gen.ts` throws
// "No SDK client found" until one exists). Both must run before the first
// route mounts and fires a query, so — like the theme/privacy calls below —
// this happens here rather than inside a component.
registerCsrfInterceptor(client);
new Sdk();

// Applied before the first `render()` call below — see base.css's
// `html:not([data-theme-ready]) body { visibility: hidden }` rule and
// docs/research/05-frontend-architecture.md §2.7. Under a strict CSP there is
// no blocking inline <script> to do this in <head>, so "the first statements
// of the entry module, before mount" is the earliest available hook; it
// still runs well before first paint because the browser can't render a
// hidden-by-default body until this module executes regardless.
applyTheme(getThemePreference());
applyPrivacy(getHideAmounts());

const container = document.getElementById('root');
if (container === null) {
  throw new Error('#root element missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  void import('./lib/service-worker.ts').then(({ registerServiceWorker }) =>
    registerServiceWorker(),
  );
}
