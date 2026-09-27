// SPDX-License-Identifier: MIT
/**
 * `/assumptions` and `/assumptions/overrides` — WP 4.2's cited file, as HTTP.
 *
 * The §5 exit criterion is *"assumptions visible, editable, cited"*, and this
 * file is where that becomes three routes' worth of behaviour rather than a
 * screenshot:
 *
 *   * **Visible** — `GET /assumptions` serves the whole resolved file, every
 *     number still inside its cited node (`kind`, `value`, `source`, `asOf`
 *     and, where present, `note`/`attribution`), so the UI never has to go
 *     looking for a citation the response did not carry.
 *   * **Editable** — `PUT /assumptions/overrides` takes the holder's desired
 *     values for whichever paths they want to state an opinion about;
 *     `OVERRIDABLE_PATHS` is on the `GET` response so the client knows which
 *     seventeen those are before it ever tries.
 *   * **Cited** — the same node shape survives an override:
 *     `applyOverrides` replaces a value *and* its citation with `"Your
 *     override (the default is …)"`, dated the day it was set, never a bare
 *     number with the old source label still attached to it.
 *
 * `resolveForUser` is `@ctx/planning`'s own read: no override, no row, the
 * checked-in file's own defaults. `toWire` below is this file's only real
 * piece of logic — a generic recursive walk that turns every embedded `Money`
 * literal into `{ minor: string, currency }` and touches nothing else, so the
 * cited-node shape (`kind`/`source`/`asOf`/`note`/`attribution`) reaches the
 * wire byte-for-byte from the domain layer.
 *
 * Session-only: reading and editing one's own stated opinions about future
 * returns is not a credential (D21 does not apply), the same reasoning
 * `budgets.ts` and `goals.ts` give for their own writes.
 */
import {
  currentRegistry,
  loadAssumptions,
  OVERRIDABLE_PATHS,
  resolveForUser,
  saveOverrides,
  type ResolvedAssumptions,
} from '@ctx/planning';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { mapDomainErrors } from './domain-errors.ts';
import { problems } from '../problem.ts';
import type { RouteDeps } from './deps.ts';

/** D6: one account holder, and their zone is what an override's `asOf` means. */
async function timezoneOf(deps: RouteDeps): Promise<string> {
  const rows = await deps.pool.query<{ display_timezone: string }>(
    `SELECT display_timezone FROM users ORDER BY created_at, id LIMIT 1`,
  );
  return rows.rows[0]?.display_timezone ?? 'UTC';
}

/**
 * Turn the one non-JSON-safe leaf — an embedded `Money` literal
 * (`{ minor: bigint, currency: string }`) — into the wire shape, recursively,
 * and touch nothing else: strings (decimal rates, dates, sources), arrays
 * (bracket tables, the correlation matrix) and every other object key pass
 * through unchanged. This is the *only* transform between the domain file and
 * the wire; the cited-node shape itself is never restated here.
 */
function toWire(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toWire);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (
      keys.length === 2 &&
      typeof record['minor'] === 'bigint' &&
      typeof record['currency'] === 'string'
    ) {
      return { minor: (record['minor'] as bigint).toString(), currency: record['currency'] };
    }
    return Object.fromEntries(Object.entries(record).map(([key, inner]) => [key, toWire(inner)]));
  }
  return value;
}

/**
 * Deliberately opaque at the zod level (`z.record`): the file is a large,
 * versioned document whose shape is WP 4.2's to change, and modelling every
 * cited-node kind here would be a second copy of `assumptionsFileSchema` that
 * could drift from it. The contract this route actually keeps —
 * "every number carries a `source` and an `asOf`" — is proven by
 * `assumptions-routes.test.ts`'s structural walk over the real response, not
 * by this schema.
 */
const assumptionsFileWire = z.record(z.string(), z.unknown()).meta({
  id: 'AssumptionsFile',
  description: "The whole cited assumptions file, WP 4.2's shape.",
});

const appliedOverrideWire = z
  .object({ path: z.string(), value: z.string(), default: z.unknown() })
  .meta({ id: 'AssumptionsAppliedOverride' });

const resolvedAssumptionsResponse = z.object({
  version: z.string(),
  file: assumptionsFileWire,
  overrides: z.array(appliedOverrideWire),
  overridablePaths: z.array(z.string()),
});

function serialiseResolved(
  resolved: ResolvedAssumptions,
): z.infer<typeof resolvedAssumptionsResponse> {
  return {
    version: resolved.version,
    file: toWire(resolved.file) as Record<string, unknown>,
    overrides: resolved.overrides.map((override) => ({
      path: override.path,
      value: override.value,
      default: toWire(override.default),
    })),
    overridablePaths: [...OVERRIDABLE_PATHS],
  };
}

export const assumptionsRoutes = (deps: RouteDeps): FastifyPluginAsyncZod => {
  const { guards, database } = deps;

  return async (app) => {
    app.get(
      '/assumptions',
      {
        schema: {
          operationId: 'getAssumptions',
          summary: "The cited assumptions file, resolved against the caller's overrides",
          description:
            'Every number in the file lives in a cited node — `kind`, `value`, `source`, `asOf` ' +
            'and, where present, `note`/`attribution` — and this response carries the file whole, ' +
            'not a subset. An overridden path keeps the shape: its `source` reads ' +
            '"Your override (the default is …)" and its `asOf` is the day it was set.',
          tags: ['planning'],
          response: { 200: resolvedAssumptionsResponse, ...problems(401, 409, 422, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const timeZone = await timezoneOf(deps);
        const resolved = await mapDomainErrors(() =>
          resolveForUser(database, { userId: session.userId, timeZone }, currentRegistry()),
        );
        return serialiseResolved(resolved);
      },
    );

    app.put(
      '/assumptions/overrides',
      {
        schema: {
          operationId: 'putAssumptionsOverrides',
          summary: "Replace the caller's overrides (full desired-value semantics)",
          description:
            'Only the seventeen capital-market paths in `overridablePaths` may be overridden; an ' +
            'unknown path or a non-decimal value is a 422. A value that equals the current ' +
            'default is dropped — an override never pins a stale default — and `{}` clears every ' +
            "override back to the file's own numbers.",
          tags: ['planning'],
          body: z.object({
            overrides: z.record(z.string(), z.string()),
          }),
          response: { 200: resolvedAssumptionsResponse, ...problems(400, 401, 409, 422, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const timeZone = await timezoneOf(deps);
        const assumptions = loadAssumptions();
        await mapDomainErrors(() =>
          database.transaction((tx) =>
            saveOverrides(
              tx,
              {
                userId: session.userId,
                desired: request.body.overrides,
                clock: deps.clock,
                correlationId: String(request.id),
              },
              assumptions,
            ),
          ),
        );
        const resolved = await mapDomainErrors(() =>
          resolveForUser(database, { userId: session.userId, timeZone }, currentRegistry()),
        );
        return serialiseResolved(resolved);
      },
    );
  };
};
