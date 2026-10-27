// SPDX-License-Identifier: MIT
/**
 * `GET|PUT /inbox/preferences` - the Inbox's one preference (WP 11.2b): whether to list
 * "Auto-categorised, unreviewed".
 *
 * Stored on the holder's `users` row (`inbox_show_auto_review`, migration `0058`), the same per-holder
 * preferences row the dashboard layout lives on (`routes/dashboard.ts`, 0046). Default shown: a holder who does
 * not want to review automatic placements turns the section off, and nothing else changes - the placements still
 * count, still wear their chip on the transaction list, and are still explainable.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { problems } from '../problem.ts';
import type { RouteDeps } from './deps.ts';

const preferencesWire = z
  .object({
    showAutoReview: z
      .boolean()
      .describe(
        'Whether the Inbox lists the rows an automatic tier placed that nobody has reviewed.',
      ),
  })
  .meta({ id: 'InboxPreferences' });

export const inboxPreferenceRoutes = (deps: RouteDeps): FastifyPluginAsyncZod => {
  const { guards, pool } = deps;

  async function read(userId: string): Promise<z.infer<typeof preferencesWire>> {
    const rows = await pool.query<{ inbox_show_auto_review: boolean }>(
      'SELECT inbox_show_auto_review FROM users WHERE id = $1',
      [userId],
    );
    return { showAutoReview: rows.rows[0]?.inbox_show_auto_review !== false };
  }

  return async (app) => {
    app.get(
      '/inbox/preferences',
      {
        schema: {
          operationId: 'getInboxPreferences',
          summary: 'The Inbox preferences',
          tags: ['transactions'],
          response: { 200: preferencesWire, ...problems(401, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        return read(session.userId);
      },
    );

    app.put(
      '/inbox/preferences',
      {
        schema: {
          operationId: 'putInboxPreferences',
          summary: 'Save the Inbox preferences',
          tags: ['transactions'],
          body: preferencesWire,
          response: { 200: preferencesWire, ...problems(400, 401, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        await pool.query('UPDATE users SET inbox_show_auto_review = $2 WHERE id = $1', [
          session.userId,
          request.body.showAutoReview,
        ]);
        return read(session.userId);
      },
    );
  };
};
