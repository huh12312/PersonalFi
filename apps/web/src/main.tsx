// SPDX-License-Identifier: MIT
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app/App.tsx';
import { applyPrivacy, getHideAmounts } from './lib/privacy.ts';
import { applyTheme, getThemePreference } from './lib/theme.ts';
import './styles/base.css';

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
