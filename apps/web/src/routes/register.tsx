// SPDX-License-Identifier: MIT
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

import { PasskeyRegisterFlow } from '../features/auth/PasskeyRegisterFlow.tsx';

const searchSchema = z.object({
  /**
   * Accepted, but not what `just bootstrap-user` prints — see `tokenFromHash`.
   * Kept so a hand-typed or pasted `?token=` still works rather than silently
   * rendering an enrolment form that cannot enrol.
   */
  token: z.string().min(16).optional(),
});

/**
 * The one-time enrolment token printed by `just bootstrap-user`, read from the
 * URL **fragment**.
 *
 * A fragment is never sent to a server, so the token cannot land in Caddy's
 * access log, in a `Referer` header, or in a proxy cache the way a query
 * parameter would — that is why `bootstrap-user.ts` mints it as
 * `/register#token=...`. This route read only `?token=` until the second
 * security gate (gate-security-review-2.md, P0-4), so the link the bootstrap
 * path actually prints enrolled nothing.
 */
function tokenFromHash(): string | undefined {
  if (typeof globalThis.location === 'undefined') return undefined;
  const raw = globalThis.location.hash.replace(/^#/, '');
  const token = new URLSearchParams(raw).get('token');
  return token !== null && token.length >= 16 ? token : undefined;
}

export const Route = createFileRoute('/register')({
  validateSearch: searchSchema,
  component: RegisterRoute,
});

function RegisterRoute() {
  const { token } = Route.useSearch();
  return <PasskeyRegisterFlow registrationToken={tokenFromHash() ?? token} />;
}
