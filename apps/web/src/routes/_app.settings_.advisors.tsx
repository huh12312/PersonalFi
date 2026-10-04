// SPDX-License-Identifier: MIT
import { createFileRoute } from '@tanstack/react-router';

import { AdvisorManagementScreen } from '../features/advisors/AdvisorManagementScreen.tsx';

/**
 * `/settings/advisors` (`docs/plan/05-phase-5-dispatch.md` §3 WP 5.12).
 *
 * **Filename choice, recorded because the previous snapshot probed this
 * exact question and left it open.** TanStack Router's file-based routing
 * treats a dot between two segments as nesting the child inside the
 * parent's own route tree (rendered through the parent's `<Outlet/>`) —
 * `_app.settings.advisors.tsx` would be a *child* of `routes/_app.settings.tsx`
 * in the component tree, not only in the URL. `routes/_app.settings.tsx`
 * (WP 2.11's file, Base UI `Tabs` switching panels by client-side state, not
 * by route) renders no `<Outlet/>` and never has, so a route nested that way
 * would match `/settings/advisors` and render nothing — the parent's
 * component owns the whole page and never defers to a child.
 *
 * The trailing underscore on `settings_` is TanStack Router's documented
 * "non-nested route" escape: the URL still reads `/settings/advisors` (the
 * underscore is not part of the path), but the route is **not** nested
 * inside `_app/settings`'s component tree — it renders directly inside
 * `_app.tsx`'s own `<Outlet/>`, the same level every other top-level screen
 * (`_app.insights.tsx`, `_app.budget.tsx`, …) renders at. That is the form
 * that actually displays something, so it is the one this file uses; the
 * dispatch's "child of the settings layout" is true of the URL and the
 * sitemap (05 §4.1's tree lists it under `/settings/*`, and
 * `_app.settings.tsx`'s own one new link line is how a holder reaches it),
 * not of the React component tree, which has no settings layout to be a
 * child of today.
 */
export const Route = createFileRoute('/_app/settings_/advisors')({
  component: AdvisorManagementScreen,
});
