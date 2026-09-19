// SPDX-License-Identifier: MIT
/**
 * `/rules` — the categorisation power feature, as HTTP.
 *
 * ## Why this route did not exist until now
 *
 * `@ctx/categorization` has shipped `applyRule`, `createRuleFromTransaction` and
 * the whole rule language (`src/rules/schema.ts`) since WP 1.4, and none of it
 * had a route: wp1.4 evidence §9, "No REST surface for rules (create/list/
 * enable/disable). The wiring test above inserts a rule with raw SQL for
 * exactly this reason." This file, `POST /transactions/{id}/rule`
 * (`transactions.ts`) and the D2-5 taxonomy work close that — the last named
 * carry-over from Phase 1 that lands in Phase 2 dispatch §2.
 *
 * ## Step-up (decision D21) does not apply here
 *
 * `connections.ts`'s step-up gate protects *attaching or destroying a
 * credential* — the class of attack is a stolen session cookie linking a new
 * institution or ripping one out. A rule is user data, not a credential: the
 * same shape of write as `PATCH /transactions/{id}` (the overlay) or the new
 * `POST /categories`, both of which take only a session. Every route below
 * does the same. `POST /rules/{id}/apply` is the one genuinely destructive
 * action here — a retroactive apply can recategorise thousands of rows — and
 * its safety net is `POST /rules/preview` (same code path, `dryRun`), not a
 * WebAuthn assertion: the risk is "I did not mean to do that to my own data",
 * which a preview answers, not "someone else is acting as me", which step-up
 * answers.
 *
 * ## `POST /rules/{id}/apply` is not named in the Phase 2 dispatch bullet
 *
 * The dispatch text names only `POST /rules/preview` "over the existing
 * `applyRule({preview})`". `applyRule` is one function with a boolean, and
 * `rules-routes.test.ts`'s own exit test — `'preview count equals the later
 * apply count'` — has no meaning without a second call that actually applies.
 * This route is that second call: `applyRule({preview: false})`, over the same
 * function, at the same auth policy, in the same file. Recorded here as a
 * deliberate, narrow addition beyond the letter of the bullet, not a scope
 * creep — see `docs/evidence/phase-2/wp2.5-rules-api.md`.
 */
import {
  actionsSchema,
  applyRule,
  conditionsSchema,
  createRule,
  deleteRule,
  listRuleRecords,
  updateRule,
  type ApplyRuleResult,
  type RuleRecord,
} from '@ctx/categorization';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { createCategorizationLedgerPort } from '../domain.ts';
import { problems } from '../problem.ts';
import { instantOrNull, isoInstant } from '../wire.ts';
import { mapDomainErrors } from './domain-errors.ts';
import type { RouteDeps } from './deps.ts';

/**
 * Exported so `routes/transactions.ts`'s `POST /transactions/{id}/rule` can
 * return exactly this shape — the same "the rule this call just created,
 * fully formed" response `POST /rules` gives — rather than a second,
 * structurally identical schema `.meta({ id: 'Rule' })` would collide with.
 */
export const ruleRecordSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    priority: z.int(),
    enabled: z.boolean(),
    conditions: conditionsSchema,
    actions: actionsSchema,
    runOnSync: z.boolean(),
    stopProcessing: z.boolean(),
    createdFromTransactionId: z
      .uuid()
      .nullable()
      .describe('Set when this rule was created from "always categorise X as Y".'),
    lastAppliedAt: isoInstant.nullable(),
    lastAppliedCount: z.int().nonnegative(),
    createdAt: isoInstant,
    updatedAt: isoInstant,
  })
  .meta({ id: 'Rule' });

export function serialiseRule(rule: RuleRecord): z.infer<typeof ruleRecordSchema> {
  return {
    id: rule.id,
    name: rule.name,
    priority: rule.priority,
    enabled: rule.enabled,
    conditions: rule.conditions,
    actions: rule.actions,
    runOnSync: rule.runOnSync,
    stopProcessing: rule.stopProcessing,
    createdFromTransactionId: rule.createdFromTransactionId,
    lastAppliedAt: instantOrNull(rule.lastAppliedAt),
    lastAppliedCount: rule.lastAppliedCount,
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
  };
}

const ruleWriteBody = z.object({
  name: z.string().min(1).max(120),
  priority: z.int().min(0).max(10_000).optional(),
  enabled: z.boolean().optional(),
  conditions: conditionsSchema,
  actions: actionsSchema,
  runOnSync: z.boolean().optional(),
  stopProcessing: z.boolean().optional(),
});

const applyResultSchema = z
  .object({
    ruleId: z.uuid(),
    runId: z.uuid(),
    preview: z.boolean(),
    matchedCount: z.int().nonnegative(),
    changedCount: z.int().nonnegative(),
    sample: z.array(z.object({ transactionId: z.uuid(), payee: z.string() })),
    actionsRecorded: z
      .array(z.string())
      .describe(
        'Non-`set_category` actions on this rule that are validated but inert today ' +
          '(`link_recurring`, `notify`) — recorded, not yet acted on. Always empty for a preview.',
      ),
  })
  .meta({ id: 'RuleApplyResult' });

/**
 * `ApplyRuleResult`'s `sample`/`actionsRecorded` are `readonly` — correct for a
 * context's own return type — but the zod-inferred response type is mutable,
 * so a plain `return applyRule(...)` does not typecheck. Spreading into new
 * arrays here is cheap (a preview's sample is capped, per `service.ts`) and
 * keeps the readonly-ness everywhere else in the context intact.
 */
function serialiseApplyResult(result: ApplyRuleResult): z.infer<typeof applyResultSchema> {
  return {
    ruleId: result.ruleId,
    runId: result.runId,
    preview: result.preview,
    matchedCount: result.matchedCount,
    changedCount: result.changedCount,
    sample: result.sample.map((row) => ({ transactionId: row.transactionId, payee: row.payee })),
    actionsRecorded: [...result.actionsRecorded],
  };
}

export const ruleRoutes = (deps: RouteDeps): FastifyPluginAsyncZod => {
  const { guards, database, clock } = deps;

  function port(): ReturnType<typeof createCategorizationLedgerPort> {
    return createCategorizationLedgerPort(database, clock);
  }

  return async (app) => {
    app.get(
      '/rules',
      {
        schema: {
          operationId: 'listRules',
          summary: "This user's categorisation rules, by ascending priority",
          tags: ['rules'],
          response: {
            200: z.object({ rules: z.array(ruleRecordSchema) }),
            ...problems(401, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const rules = await listRuleRecords(database, session.userId);
        return { rules: rules.map(serialiseRule) };
      },
    );

    app.post(
      '/rules',
      {
        schema: {
          operationId: 'createRule',
          summary: 'Create a rule',
          description:
            'Validated the same way a stored rule is re-validated on read (`rules/schema.ts`): ' +
            'a `set_category` action must name a leaf category that belongs to this user — a ' +
            "custom category (`POST /categories`) or a system one, never another user's.",
          tags: ['rules'],
          body: ruleWriteBody,
          response: {
            201: z.object({ rule: ruleRecordSchema }),
            ...problems(400, 401, 404, 422, 503),
          },
        },
      },
      async (request, reply) => {
        const session = await guards.requireSession(request);
        const body = request.body;
        const rule = await mapDomainErrors(() =>
          createRule(database, {
            userId: session.userId,
            name: body.name,
            conditions: body.conditions,
            actions: body.actions,
            ...(body.priority === undefined ? {} : { priority: body.priority }),
            ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
            ...(body.runOnSync === undefined ? {} : { runOnSync: body.runOnSync }),
            ...(body.stopProcessing === undefined ? {} : { stopProcessing: body.stopProcessing }),
          }),
        );
        return reply.code(201).send({ rule: serialiseRule(rule) });
      },
    );

    app.patch(
      '/rules/:ruleId',
      {
        schema: {
          operationId: 'updateRule',
          summary: 'Update a rule',
          description: 'Partial: an omitted field keeps its stored value.',
          tags: ['rules'],
          params: z.object({ ruleId: z.uuid() }),
          body: ruleWriteBody
            .partial()
            .refine(
              (body) => Object.values(body).some((value) => value !== undefined),
              'a PATCH with no fields changes nothing; say what to change',
            ),
          response: {
            200: z.object({ rule: ruleRecordSchema }),
            ...problems(400, 401, 404, 422, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const body = request.body;
        const rule = await mapDomainErrors(() =>
          updateRule(database, {
            userId: session.userId,
            ruleId: request.params.ruleId,
            ...(body.name === undefined ? {} : { name: body.name }),
            ...(body.conditions === undefined ? {} : { conditions: body.conditions }),
            ...(body.actions === undefined ? {} : { actions: body.actions }),
            ...(body.priority === undefined ? {} : { priority: body.priority }),
            ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
            ...(body.runOnSync === undefined ? {} : { runOnSync: body.runOnSync }),
            ...(body.stopProcessing === undefined ? {} : { stopProcessing: body.stopProcessing }),
          }),
        );
        return { rule: serialiseRule(rule) };
      },
    );

    app.delete(
      '/rules/:ruleId',
      {
        schema: {
          operationId: 'deleteRule',
          summary: 'Delete a rule',
          description:
            'A hard delete — `rule_runs` cascades with it (migration 0006). Unlike a category, ' +
            'a rule carries no history another row points back at, so there is nothing an ' +
            'archive would preserve.',
          tags: ['rules'],
          params: z.object({ ruleId: z.uuid() }),
          response: {
            200: z.object({ deleted: z.boolean() }),
            ...problems(401, 404, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        return deleteRule(database, { userId: session.userId, ruleId: request.params.ruleId });
      },
    );

    app.post(
      '/rules/preview',
      {
        schema: {
          operationId: 'previewRule',
          summary: 'Preview what applying a rule retroactively would change',
          description:
            'Writes nothing, emits no event: "this will change 912 transactions" shown before ' +
            'the fact is what turns a retroactive apply from a trap into a tool. Runs the exact ' +
            'code path `POST /rules/{id}/apply` runs, so the count it shows is the count that ' +
            'will actually happen.',
          tags: ['rules'],
          body: z.object({
            ruleId: z.uuid(),
            retroactive: z
              .boolean()
              .optional()
              .describe('Without this, only transactions with no user category are matched.'),
          }),
          response: {
            200: applyResultSchema,
            ...problems(400, 401, 404, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const result = await mapDomainErrors(() =>
          applyRule(
            database,
            port(),
            {
              ruleId: request.body.ruleId,
              preview: true,
              ...(request.body.retroactive === undefined
                ? {}
                : { retroactive: request.body.retroactive }),
            },
            { userId: session.userId, clock, correlationId: String(request.id) },
          ),
        );
        return serialiseApplyResult(result);
      },
    );

    app.post(
      '/rules/:ruleId/apply',
      {
        schema: {
          operationId: 'applyRule',
          summary: 'Apply a rule retroactively',
          description:
            "The non-preview half of `POST /rules/preview` — see this file's module comment " +
            'for why it exists here. Emits `categorization.RuleApplied`.',
          tags: ['rules'],
          params: z.object({ ruleId: z.uuid() }),
          body: z.object({ retroactive: z.boolean().optional() }),
          response: {
            200: applyResultSchema,
            ...problems(400, 401, 404, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const result = await mapDomainErrors(() =>
          applyRule(
            database,
            port(),
            {
              ruleId: request.params.ruleId,
              preview: false,
              ...(request.body.retroactive === undefined
                ? {}
                : { retroactive: request.body.retroactive }),
            },
            { userId: session.userId, clock, correlationId: String(request.id) },
          ),
        );
        return serialiseApplyResult(result);
      },
    );
  };
};
