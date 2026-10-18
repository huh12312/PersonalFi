// SPDX-License-Identifier: MIT
/**
 * `GET|PUT|DELETE /dashboard/layout` — the order and visibility of the dashboard's widgets, per holder (WP 10.9;
 * Monarch's Customize screen, docs/research/10-visual-design-notes.md §1.4).
 *
 * Stored on the holder's `users` row (`dashboard_layout`, migration `0046_dashboard_layout`), the one per-holder
 * preferences row this schema has. The database holds the shape (an array of at most 32 entries); this file holds
 * the vocabulary: `DASHBOARD_WIDGETS` is every widget the product draws, in its default order, and every read is
 * **normalised against it** — a stored id the product no longer draws is dropped, a widget the stored array does
 * not name (one added by a later release) is appended, shown — so an old layout never hides a new widget and a
 * hand-edited row never names a widget that does not exist. NULL is the default layout; `DELETE` restores it.
 *
 * A layout is a preference, not a credential: a session is enough (no step-up, decision D21's list is for
 * credential and export writes).
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { problems } from '../problem.ts';
import type { RouteDeps } from './deps.ts';

/** Every widget, in the default order. The web's registry (`features/dashboard/widgets/registry.ts`) matches it. */
export const DASHBOARD_WIDGETS = [
  'net-worth',
  'spending-pace',
  'budgets',
  'upcoming',
  'to-review',
  'goals',
  'investments',
  'top-insights',
  // WP 10.12: the health gauge, after Top insights.
  'financial-health',
] as const;

export type DashboardWidgetId = (typeof DASHBOARD_WIDGETS)[number];

export interface LayoutEntry {
  readonly id: DashboardWidgetId;
  readonly visible: boolean;
}

const KNOWN = new Set<string>(DASHBOARD_WIDGETS);

const entrySchema = z
  .object({ id: z.enum(DASHBOARD_WIDGETS), visible: z.boolean() })
  .meta({ id: 'DashboardLayoutEntry' });

const layoutWire = z
  .object({
    widgets: z.array(entrySchema),
    customised: z
      .boolean()
      .describe('false when this is the default layout (nothing stored, or after a reset).'),
  })
  .meta({ id: 'DashboardLayout' });

export function defaultLayout(): LayoutEntry[] {
  return DASHBOARD_WIDGETS.map((id) => ({ id, visible: true }));
}

/** A stored value → the layout to draw: unknown or repeated ids dropped, unnamed widgets appended, shown. */
export function normaliseLayout(stored: unknown): LayoutEntry[] {
  if (!Array.isArray(stored)) return defaultLayout();
  const seen = new Set<string>();
  const out: LayoutEntry[] = [];
  for (const entry of stored as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { id, visible } = entry as { id?: unknown; visible?: unknown };
    if (typeof id !== 'string' || !KNOWN.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id: id as DashboardWidgetId, visible: visible !== false });
  }
  for (const id of DASHBOARD_WIDGETS) if (!seen.has(id)) out.push({ id, visible: true });
  return out;
}

export const dashboardRoutes = (deps: RouteDeps): FastifyPluginAsyncZod => {
  const { guards, pool } = deps;

  async function read(userId: string): Promise<z.infer<typeof layoutWire>> {
    const rows = await pool.query<{ dashboard_layout: unknown }>(
      'SELECT dashboard_layout FROM users WHERE id = $1',
      [userId],
    );
    const stored = rows.rows[0]?.dashboard_layout ?? null;
    return { widgets: normaliseLayout(stored), customised: stored !== null };
  }

  return async (app) => {
    app.get(
      '/dashboard/layout',
      {
        schema: {
          operationId: 'getDashboardLayout',
          summary: "The dashboard's widget order and which widgets are shown",
          description:
            'Every widget the product draws, in display order, each shown or hidden. A widget the stored ' +
            'layout does not name (added by a later release) is appended, shown.',
          tags: ['dashboard'],
          response: { 200: layoutWire, ...problems(401, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        return read(session.userId);
      },
    );

    app.put(
      '/dashboard/layout',
      {
        schema: {
          operationId: 'putDashboardLayout',
          summary: "Save the dashboard's widget order and visibility",
          description:
            'The widgets in display order. Each id at most once (400 otherwise); a widget left out is ' +
            'appended, shown, on the next read.',
          tags: ['dashboard'],
          body: z.object({
            widgets: z
              .array(entrySchema)
              .max(DASHBOARD_WIDGETS.length)
              .refine(
                (widgets) => new Set(widgets.map((entry) => entry.id)).size === widgets.length,
                'each widget at most once',
              ),
          }),
          response: { 200: layoutWire, ...problems(400, 401, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const widgets = request.body.widgets.map((entry) => ({
          id: entry.id,
          visible: entry.visible,
        }));
        await pool.query('UPDATE users SET dashboard_layout = $2::jsonb WHERE id = $1', [
          session.userId,
          JSON.stringify(widgets),
        ]);
        return read(session.userId);
      },
    );

    app.delete(
      '/dashboard/layout',
      {
        schema: {
          operationId: 'resetDashboardLayout',
          summary: 'Restore the default dashboard layout',
          tags: ['dashboard'],
          response: { 200: layoutWire, ...problems(401, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        await pool.query('UPDATE users SET dashboard_layout = NULL WHERE id = $1', [
          session.userId,
        ]);
        return read(session.userId);
      },
    );
  };
};
