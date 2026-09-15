// SPDX-License-Identifier: MIT

/**
 * Dependency-free Plaid Link integration: Plaid's own CDN-hosted
 * `link-initialize.js`, not the `react-plaid-link` npm package (not
 * installed, and this work package may not add a dependency — see
 * docs/evidence/phase-1/wp1.6-ui.md). Plaid documents this exact script as a
 * first-class, non-React integration path: a `<script>` tag plus
 * `window.Plaid.create(...)`, versioned via the `v2/stable` CDN alias so a
 * pin lives in Plaid's own hosting rather than this repo's lockfile.
 *
 * **Wired to a live link token as of WP 1.3b.** `apps/api` now registers
 * `PlaidConnector` when Plaid secrets are configured and exposes
 * `POST /connections/plaid/link-token` / `POST /connections/{id}/plaid/update-link-token`
 * (`docs/evidence/phase-1/wp1.3b-plaid-api.md`). `PlaidConnectCard.tsx` and
 * `ReconnectDialog.tsx` call those through the generated client; this module
 * stays the client-side half — loading Plaid's script and driving
 * `window.Plaid` — and knows nothing about how a token was obtained.
 *
 * **CSP note**: loading `cdn.plaid.com` needs `script-src`/`connect-src`
 * `https://cdn.plaid.com` and `https://production.plaid.com`/
 * `https://sandbox.plaid.com` in the proxy's Content-Security-Policy header
 * (Caddy, not `apps/web` — `scripts/check-csp.ts` only checks the built HTML
 * for an inline `<script>`, not the runtime CSP header). Flagged in the
 * evidence doc for whoever owns that config.
 */

declare global {
  interface Window {
    Plaid?: {
      create(config: PlaidLinkConfig): PlaidLinkHandler;
    };
  }
}

export interface PlaidLinkConfig {
  token: string;
  onSuccess: (publicToken: string, metadata: { institution?: { name?: string } | null }) => void;
  onExit?: (error: unknown, metadata: unknown) => void;
  onEvent?: (eventName: string, metadata: unknown) => void;
}

export interface PlaidLinkHandler {
  open(): void;
  exit(options?: { force?: boolean }): void;
  destroy(): void;
}

const PLAID_LINK_SCRIPT_URL = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';

let scriptPromise: Promise<void> | null = null;

/** Injects Plaid's Link script once (idempotent across calls) and resolves once `window.Plaid` is available. */
export function loadPlaidLinkScript(): Promise<void> {
  if (typeof window !== 'undefined' && window.Plaid !== undefined) return Promise.resolve();
  if (scriptPromise !== null) return scriptPromise;

  scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = PLAID_LINK_SCRIPT_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      scriptPromise = null;
      reject(new Error('Could not load Plaid Link — check the network and the page CSP.'));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}

/** Loads the script (if needed) and opens Link with `linkToken` — the update-mode reconnect flow uses the same function with a different token (wp1.5-api.md's `reconnectFlow: 'provider_hosted'`). */
export async function openPlaidLink(config: PlaidLinkConfig): Promise<PlaidLinkHandler> {
  await loadPlaidLinkScript();
  if (window.Plaid === undefined) {
    throw new Error('Plaid Link script loaded but window.Plaid is unavailable.');
  }
  const handler = window.Plaid.create(config);
  handler.open();
  return handler;
}
