// SPDX-License-Identifier: MIT
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

import { LoginScreen } from '../features/auth/LoginScreen.tsx';

/**
 * `redirect` is populated by the `/_app` auth guard
 * (gate-remediation-web.md M-3/M-8) when it bounces an unauthenticated
 * visitor here — `LoginScreen` reads it via `Route.useSearch()` and navigates
 * there on success instead of always landing on `/`. Validated as a plain
 * (optional) string here; `isSafeRedirectPath` (src/lib/safe-redirect.ts)
 * is what actually decides whether it's safe to navigate to, so an
 * open-redirect payload in the URL just falls back to `/` instead of being
 * rejected at the route level.
 */
export const Route = createFileRoute('/login')({
  validateSearch: z.object({ redirect: z.string().optional() }),
  component: LoginScreen,
});
