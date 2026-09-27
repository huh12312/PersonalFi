// SPDX-License-Identifier: MIT
/**
 * `/goals`, `/goals/{id}/contributions` and `/risk-profile` — WP 4.1's domain,
 * as HTTP.
 *
 * WP 4.8. Session-only throughout: every write here edits the holder's own
 * plan (a goal, a contribution plan, a risk-profile answering), never a
 * credential, so D21's step-up gate does not apply — the same reasoning
 * `budgets.ts`'s header gives for `/budgets/*`.
 *
 * ## Money and rates never cross as a `number`
 *
 * `target`, contribution `amount` and the required-savings `monthly` are
 * `{ minor, currency }`; `escalationPct` is the decimal string
 * `@ctx/planning`'s own `parseEscalationPct` already refuses a `number` for.
 * Nothing in this file calls `Number()` on a domain amount.
 *
 * ## Cross-user scoping (dispatch §5 item 8)
 *
 * `@ctx/planning`'s stores (`goals-store.ts`) never join, and every statement
 * carries exactly one `user_id = $caller` predicate (WP 4.1's own sabotage log
 * proved each one independently). At this layer the caller's id comes from
 * exactly one place — `guards.requireSession(request).userId` — and is
 * threaded to every domain call; there is no second id anywhere in a request
 * a route could substitute. The one route with **two** scoping reads —
 * `DELETE /goals/{id}/contributions/{contributionId}`, which checks the goal
 * belongs to the caller *and* that the contribution belongs to that goal —
 * is where `docs/evidence/phase-4/wp4.8-routes.md` walks both predicates
 * dropped individually and together.
 *
 * ## The risk-profile questionnaire is read-only about its score
 *
 * `GET /risk-profile` returns the instrument (so the client can render the
 * same two framings this WP's evidence tables show) and the holder's current
 * answering, if any. `PUT /risk-profile` is the only way to move the score:
 * it derives, bands and stores a **new** row (the table is append-only by
 * design — re-answering is a new fact, never an edit of the old one) and
 * returns the derivation's `explanation` verbatim, so the "the score moved
 * because you said X but did Y" sentence is never re-typed in this file.
 */
import {
  addContribution,
  answerRiskProfile,
  CONTRIBUTION_CADENCES,
  createGoal,
  currentRegistry,
  currentRiskProfile,
  deleteGoal,
  FILING_STATUSES,
  getGoal,
  GOAL_KINDS,
  GOAL_STATUSES,
  LIQUIDITY_NEEDS,
  listContributions,
  listGoals,
  removeContribution,
  resolveForUser,
  RISK_DISPOSITIONS,
  RISK_FRAMINGS,
  RISK_INSTRUMENT,
  RISK_INSTRUMENT_VERSION,
  RISK_TOLERANCES,
  taxYear,
  updateGoal,
  type BracketSchedule,
  type Goal,
  type RiskAnswers,
  type StoredRiskProfile,
  type ToleranceDerivation,
} from '@ctx/planning';
import { Money, todayIn, type DateOnly } from '@core/kernel';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { planningPortsFor } from '../domain.ts';
import { mapDomainErrors } from './domain-errors.ts';
import { AppError, problems } from '../problem.ts';
import { dateOnly, money, moneySchema } from '../wire.ts';
import type { RouteDeps } from './deps.ts';

/** D6: one account holder, and their zone is what "today" and "the past" mean. */
async function timezoneOf(deps: RouteDeps): Promise<string> {
  const rows = await deps.pool.query<{ display_timezone: string }>(
    `SELECT display_timezone FROM users ORDER BY created_at, id LIMIT 1`,
  );
  return rows.rows[0]?.display_timezone ?? 'UTC';
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

const goalSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(GOAL_KINDS),
    name: z.string(),
    target: moneySchema,
    targetDate: dateOnly,
    priority: z.int().min(1).max(5),
    fundedFromAccountIds: z.array(z.uuid()),
    status: z.enum(GOAL_STATUSES),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: 'Goal' });

function serialiseGoal(goal: Goal): z.infer<typeof goalSchema> {
  return {
    id: goal.id,
    kind: goal.kind,
    name: goal.name,
    target: money(goal.target),
    targetDate: goal.targetDate,
    priority: goal.priority,
    fundedFromAccountIds: [...goal.fundedFromAccountIds],
    status: goal.status,
    createdAt: goal.createdAt.toISOString(),
    updatedAt: goal.updatedAt.toISOString(),
  };
}

const contributionSchema = z
  .object({
    id: z.uuid(),
    goalId: z.uuid(),
    cadence: z.enum(CONTRIBUTION_CADENCES),
    amount: moneySchema,
    /** A decimal string, e.g. `'3.25'` — 3.25% a year. Never a JSON number. */
    escalationPct: z.string(),
    startsOn: dateOnly,
    endsOn: dateOnly.nullable(),
    source: z.enum(['DERIVED', 'USER']),
    derivedAsOf: dateOnly.nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: 'GoalContribution' });

function serialiseContribution(
  contribution: Awaited<ReturnType<typeof addContribution>>,
): z.infer<typeof contributionSchema> {
  return {
    id: contribution.id,
    goalId: contribution.goalId,
    cadence: contribution.cadence,
    amount: money(contribution.amount),
    escalationPct: contribution.escalationPct,
    startsOn: contribution.startsOn,
    endsOn: contribution.endsOn,
    source: contribution.source,
    derivedAsOf: contribution.derivedAsOf,
    createdAt: contribution.createdAt.toISOString(),
    updatedAt: contribution.updatedAt.toISOString(),
  };
}

const riskOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  points: z
    .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)])
    .nullable(),
});

const riskItemSchema = z
  .object({
    id: z.string(),
    disposition: z.enum(RISK_DISPOSITIONS),
    framing: z.enum(RISK_FRAMINGS),
    prompt: z.string(),
    options: z.array(riskOptionSchema),
  })
  .meta({ id: 'RiskItem' });

const dispositionScoreSchema = z.object({
  disposition: z.enum(RISK_DISPOSITIONS),
  statedOption: z.string(),
  revealedOption: z.string(),
  stated: z.int(),
  revealed: z.int(),
  revealedWasNoEvidence: z.boolean(),
  unpenalised: z.int(),
  credited: z.int(),
  penalty: z.int(),
});

const toleranceDerivationSchema = z
  .object({
    instrument: z.literal(RISK_INSTRUMENT_VERSION),
    tolerance: z.enum(RISK_TOLERANCES),
    compositeScore: z.int(),
    unpenalisedScore: z.int(),
    consistencyPenalty: z.int(),
    toleranceIfAveraged: z.enum(RISK_TOLERANCES),
    dispositions: z.array(dispositionScoreSchema),
    explanation: z.array(z.string()),
  })
  .meta({ id: 'RiskToleranceDerivation' });

function serialiseDerivation(
  derivation: ToleranceDerivation,
): z.infer<typeof toleranceDerivationSchema> {
  return {
    instrument: derivation.instrument,
    tolerance: derivation.tolerance,
    compositeScore: derivation.compositeScore,
    unpenalisedScore: derivation.unpenalisedScore,
    consistencyPenalty: derivation.consistencyPenalty,
    toleranceIfAveraged: derivation.toleranceIfAveraged,
    dispositions: derivation.dispositions.map((row) => ({ ...row })),
    explanation: [...derivation.explanation],
  };
}

const riskProfileSchema = z
  .object({
    id: z.uuid(),
    tolerance: z.enum(RISK_TOLERANCES),
    compositeScore: z.int(),
    unpenalisedScore: z.int(),
    consistencyPenalty: z.int(),
    horizonYears: z.int(),
    /** `'22-32'` — a band, never the income that produced it (08 §4.2). */
    taxBracketBand: z.string().nullable(),
    liquidityNeed: z.enum(LIQUIDITY_NEEDS),
    answeredAt: z.string(),
  })
  .meta({ id: 'RiskProfile' });

function serialiseRiskProfile(profile: StoredRiskProfile): z.infer<typeof riskProfileSchema> {
  return {
    id: profile.id,
    tolerance: profile.tolerance,
    compositeScore: profile.compositeScore,
    unpenalisedScore: profile.unpenalisedScore,
    consistencyPenalty: profile.consistencyPenalty,
    horizonYears: profile.horizonYears,
    taxBracketBand: profile.taxBracketBand,
    liquidityNeed: profile.liquidityNeed,
    answeredAt: profile.answeredAt.toISOString(),
  };
}

function notFound(code: string, detail: string): AppError {
  return new AppError({ status: 404, code, title: 'Not Found', detail, family: 'user' });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const goalRoutes = (deps: RouteDeps): FastifyPluginAsyncZod => {
  const { guards, database, clock } = deps;

  async function requireOwnGoal(userId: string, goalId: string): Promise<Goal> {
    return mapDomainErrors(() => getGoal(database, userId, goalId));
  }

  return async (app) => {
    // -------------------------------------------------------------------
    // Goals
    // -------------------------------------------------------------------

    app.get(
      '/goals',
      {
        schema: {
          operationId: 'listGoals',
          summary: 'Every goal of the caller, oldest first',
          tags: ['planning'],
          response: { 200: z.object({ goals: z.array(goalSchema) }), ...problems(401, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const goals = await listGoals(database, session.userId);
        return { goals: goals.map(serialiseGoal) };
      },
    );

    app.get(
      '/goals/:goalId',
      {
        schema: {
          operationId: 'getGoal',
          summary: 'One goal',
          tags: ['planning'],
          params: z.object({ goalId: z.uuid() }),
          response: { 200: goalSchema, ...problems(401, 404, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const goal = await requireOwnGoal(session.userId, request.params.goalId);
        return serialiseGoal(goal);
      },
    );

    app.post(
      '/goals',
      {
        schema: {
          operationId: 'createGoal',
          summary: 'Create a goal',
          description:
            'A target date already in the past, or a funding account that does not exist or is ' +
            'closed, is a 422 domain refusal — never clamped to today and never dropped from the ' +
            'list (`packages/contexts/planning/src/goals.ts`’s own header).',
          tags: ['planning'],
          body: z.object({
            kind: z.enum(GOAL_KINDS),
            name: z.string().min(1).max(96),
            target: moneySchema,
            targetDate: dateOnly,
            priority: z.int().min(1).max(5).optional(),
            fundedFromAccountIds: z.array(z.uuid()).max(32).optional(),
          }),
          response: { 201: goalSchema, ...problems(400, 401, 409, 422, 503) },
        },
      },
      async (request, reply) => {
        const session = await guards.requireSession(request);
        const timeZone = await timezoneOf(deps);
        const goal = await mapDomainErrors(() =>
          database.transaction((tx) =>
            createGoal(
              tx,
              {
                accounts: planningPortsFor(tx, { userId: session.userId, timeZone, clock })
                  .balances,
              },
              {
                userId: session.userId,
                clock,
                timeZone,
                correlationId: String(request.id),
              },
              {
                kind: request.body.kind,
                name: request.body.name,
                target: Money.fromJSON(request.body.target),
                targetDate: request.body.targetDate,
                ...(request.body.priority === undefined ? {} : { priority: request.body.priority }),
                ...(request.body.fundedFromAccountIds === undefined
                  ? {}
                  : { fundedFromAccountIds: request.body.fundedFromAccountIds }),
              },
            ),
          ),
        );
        return reply.code(201).send(serialiseGoal(goal));
      },
    );

    app.patch(
      '/goals/:goalId',
      {
        schema: {
          operationId: 'updateGoal',
          summary: 'Edit a goal',
          description: 'Each field present is re-validated by the same rule creation uses.',
          tags: ['planning'],
          params: z.object({ goalId: z.uuid() }),
          body: z
            .object({
              name: z.string().min(1).max(96).optional(),
              target: moneySchema.optional(),
              targetDate: dateOnly.optional(),
              priority: z.int().min(1).max(5).optional(),
              fundedFromAccountIds: z.array(z.uuid()).max(32).optional(),
              status: z.enum(GOAL_STATUSES).optional(),
            })
            .refine(
              (body) => Object.values(body).some((value) => value !== undefined),
              'a PATCH with no fields changes nothing; say what to change',
            ),
          response: { 200: goalSchema, ...problems(400, 401, 404, 409, 422, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const timeZone = await timezoneOf(deps);
        const goal = await mapDomainErrors(() =>
          database.transaction((tx) =>
            updateGoal(
              tx,
              {
                accounts: planningPortsFor(tx, { userId: session.userId, timeZone, clock })
                  .balances,
              },
              { userId: session.userId, clock, timeZone, correlationId: String(request.id) },
              request.params.goalId,
              {
                ...(request.body.name === undefined ? {} : { name: request.body.name }),
                ...(request.body.target === undefined
                  ? {}
                  : { target: Money.fromJSON(request.body.target) }),
                ...(request.body.targetDate === undefined
                  ? {}
                  : { targetDate: request.body.targetDate }),
                ...(request.body.priority === undefined ? {} : { priority: request.body.priority }),
                ...(request.body.fundedFromAccountIds === undefined
                  ? {}
                  : { fundedFromAccountIds: request.body.fundedFromAccountIds }),
                ...(request.body.status === undefined ? {} : { status: request.body.status }),
              },
            ),
          ),
        );
        return serialiseGoal(goal);
      },
    );

    app.delete(
      '/goals/:goalId',
      {
        schema: {
          operationId: 'deleteGoal',
          summary: 'Delete a goal (its contribution plans and earmarks go with it, by cascade)',
          tags: ['planning'],
          params: z.object({ goalId: z.uuid() }),
          response: { 200: z.object({ deleted: z.boolean() }), ...problems(401, 404, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        await mapDomainErrors(() => deleteGoal(database, session.userId, request.params.goalId));
        return { deleted: true };
      },
    );

    // -------------------------------------------------------------------
    // Contribution plans
    // -------------------------------------------------------------------

    app.get(
      '/goals/:goalId/contributions',
      {
        schema: {
          operationId: 'listGoalContributions',
          summary: "One goal's contribution plans",
          tags: ['planning'],
          params: z.object({ goalId: z.uuid() }),
          response: {
            200: z.object({ contributions: z.array(contributionSchema) }),
            ...problems(401, 404, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const contributions = await mapDomainErrors(() =>
          listContributions(database, session.userId, request.params.goalId),
        );
        return { contributions: contributions.map(serialiseContribution) };
      },
    );

    app.post(
      '/goals/:goalId/contributions',
      {
        schema: {
          operationId: 'createGoalContribution',
          summary: 'Add a contribution plan to a goal',
          description:
            'The amount must be in the goal’s own currency (a mismatch is a 409 domain ' +
            'refusal, never a silent conversion); `escalationPct` is a decimal string and a ' +
            'number is refused rather than converted (D3).',
          tags: ['planning'],
          params: z.object({ goalId: z.uuid() }),
          body: z.object({
            cadence: z.enum(CONTRIBUTION_CADENCES),
            amount: moneySchema,
            escalationPct: z.string().optional(),
            startsOn: dateOnly,
            endsOn: dateOnly.nullable().optional(),
            source: z.enum(['DERIVED', 'USER']),
            derivedAsOf: dateOnly.nullable().optional(),
          }),
          response: { 201: contributionSchema, ...problems(400, 401, 404, 409, 422, 503) },
        },
      },
      async (request, reply) => {
        const session = await guards.requireSession(request);
        const contribution = await mapDomainErrors(() =>
          database.transaction((tx) =>
            addContribution(tx, { userId: session.userId, clock }, request.params.goalId, {
              cadence: request.body.cadence,
              amount: Money.fromJSON(request.body.amount),
              escalationPct: request.body.escalationPct,
              startsOn: request.body.startsOn,
              endsOn: request.body.endsOn ?? null,
              source: request.body.source,
              derivedAsOf: request.body.derivedAsOf ?? null,
            }),
          ),
        );
        return reply.code(201).send(serialiseContribution(contribution));
      },
    );

    app.delete(
      '/goals/:goalId/contributions/:contributionId',
      {
        schema: {
          operationId: 'deleteGoalContribution',
          summary: 'Remove a contribution plan',
          description:
            'Two scoping predicates, both load-bearing and genuinely independent: (1) the goal ' +
            'named in the URL must be the caller’s — enforced by `listContributions`’s own ' +
            '`getGoal` call, so a stray `goalId` refuses before this route reads a single ' +
            'contribution row; (2) the contribution named in the URL must actually belong to ' +
            '*that* goal, not merely to the caller — a caller who owns both the named goal and ' +
            'the named contribution, but under *different* goals, is refused by the second ' +
            'check even though the first is satisfied. (An earlier draft of this route also ' +
            'called `getGoal` directly before this line, as a distinct "predicate 1" — removed ' +
            'once the sabotage matrix showed it was never independently load-bearing: dropping ' +
            'it left the route exactly as secure, because `listContributions` already re-derives ' +
            'the same fact. Recorded in `docs/evidence/phase-4/wp4.8-routes.md` as the finding it ' +
            'is, in the spirit of WP 3.9’s S1 — a predicate that "passes when dropped" is telling ' +
            'you something, and the answer here was "this check was redundant", not "insecure".)',
          tags: ['planning'],
          params: z.object({ goalId: z.uuid(), contributionId: z.uuid() }),
          response: { 200: z.object({ deleted: z.boolean() }), ...problems(401, 404, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        // Predicate 1 (goal ownership): `listContributions` calls `getGoal`
        // first and throws `planning.goal_not_found` for another holder's
        // goal — mapped to 404 below, never reaching predicate 2.
        // Predicate 2 (this contribution belongs to this goal): the goal's
        // own contribution list is checked for the named id.
        const owned = (
          await mapDomainErrors(() =>
            listContributions(database, session.userId, request.params.goalId),
          )
        ).some((plan) => plan.id === request.params.contributionId);
        if (!owned) {
          throw notFound(
            'planning.contribution_not_found',
            `no contribution plan ${request.params.contributionId} on goal ${request.params.goalId}`,
          );
        }
        await mapDomainErrors(() =>
          removeContribution(database, session.userId, request.params.contributionId),
        );
        return { deleted: true };
      },
    );

    // -------------------------------------------------------------------
    // Risk profile
    // -------------------------------------------------------------------

    app.get(
      '/risk-profile',
      {
        schema: {
          operationId: 'getRiskProfile',
          summary:
            "The consistency-penalty questionnaire's instrument, and the caller's current score",
          description:
            'The score is read-only here: it is derived from the answers and cannot be set ' +
            'directly (`PUT /risk-profile` is the only way to move it, and it always answers the ' +
            'whole questionnaire again).',
          tags: ['planning'],
          response: {
            200: z.object({
              instrument: z.literal(RISK_INSTRUMENT_VERSION),
              items: z.array(riskItemSchema),
              current: riskProfileSchema.nullable(),
            }),
            ...problems(401, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const current = await currentRiskProfile(database, session.userId);
        return {
          instrument: RISK_INSTRUMENT_VERSION,
          items: RISK_INSTRUMENT.map((item) => ({
            id: item.id,
            disposition: item.disposition,
            framing: item.framing,
            prompt: item.prompt,
            options: item.options.map((option) => ({ ...option })),
          })),
          current: current === null ? null : serialiseRiskProfile(current),
        };
      },
    );

    app.put(
      '/risk-profile',
      {
        schema: {
          operationId: 'answerRiskProfile',
          summary: 'Answer the questionnaire; derive, band and store a new score',
          description:
            'When the two framings of a disposition disagree, the score moves to the more ' +
            'conservative one, never to the mean; the `explanation` array is the sentence the ' +
            'holder sees, one per disposition and then the total. Declining `income` leaves ' +
            '`taxBracketBand: null` rather than inventing one; the income itself never reaches ' +
            'the stored row (08 §4.2).',
          tags: ['planning'],
          body: z.object({
            answers: z.record(z.string(), z.string()),
            horizonYears: z.int().min(0).max(100),
            liquidityNeed: z.enum(LIQUIDITY_NEEDS),
            income: z
              .object({
                taxableIncome: moneySchema,
                filingStatus: z.enum(FILING_STATUSES),
                taxYear: z.int().optional(),
              })
              .nullable()
              .optional(),
          }),
          response: {
            200: z.object({ profile: riskProfileSchema, derivation: toleranceDerivationSchema }),
            ...problems(400, 401, 422, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const timeZone = await timezoneOf(deps);
        const answers: RiskAnswers = {
          instrument: RISK_INSTRUMENT_VERSION,
          items: request.body.answers as RiskAnswers['items'],
        };
        const income = request.body.income;
        const bracketIncome = await mapDomainErrors(async () => {
          if (income === undefined || income === null) return null;
          const today = todayIn(clock, timeZone);
          const year = income.taxYear ?? dateOnlyYear(today);
          const resolved = await resolveForUser(
            database,
            { userId: session.userId, timeZone },
            currentRegistry(),
          );
          const table = taxYear(resolved, year);
          const brackets = table.incomeTax.brackets[income.filingStatus];
          const schedule: BracketSchedule = {
            taxYear: year,
            filingStatus: income.filingStatus,
            brackets: brackets.value,
            source: brackets.source,
            asOf: brackets.asOf,
          };
          return { taxableIncome: Money.fromJSON(income.taxableIncome), schedule };
        });
        const { profile, derivation } = await mapDomainErrors(() =>
          answerRiskProfile(
            database,
            { userId: session.userId, clock, correlationId: String(request.id) },
            {
              answers,
              horizonYears: request.body.horizonYears,
              liquidityNeed: request.body.liquidityNeed,
              income: bracketIncome,
            },
          ),
        );
        return {
          profile: serialiseRiskProfile(profile),
          derivation: serialiseDerivation(derivation),
        };
      },
    );
  };
};

/** `DateOnly` is `YYYY-MM-DD`; the year is the first four characters. */
function dateOnlyYear(date: DateOnly): number {
  return Number.parseInt(date.slice(0, 4), 10);
}
