// SPDX-License-Identifier: MIT
/**
 * The advisory catalogue (WP 11.5b; 12 §2.1): the typed, versioned, scoped
 * list of deterministic advisory functions the Ask PersonalFi compiler (11.5c)
 * and the advisor protocol (11.5d) call, and the one runtime that calls them.
 *
 * ## The rules, and where each is enforced
 *
 *   * **Every function declares its scopes, and a call is gated by the
 *     holder's grants exactly as the query types are**: `narratorGrantCeiling`
 *     (`advisors/local/grant.ts`) — the function `insight.explain` and
 *     `brief.narrate` read — is the only source of what a holder has granted.
 *   * **A function the holder has not granted is invisible**: `listCatalogue`
 *     filters by the same gate before it describes anything, and
 *     `callCatalogue` refuses one that is not visible.
 *   * **Scope minimisation**: a function's snapshot is built for exactly its
 *     declared scopes (an `any` function: the granted part of them), never the
 *     holder's whole grant, and no function declares `transactions.raw` —
 *     `test/catalogue.test.ts` asserts both over the real definitions.
 *   * **Every figure carries `source_ref`s that resolve into the result's own
 *     inputs, and no float reaches a result**: `checkCatalogueResult` runs on
 *     every result before it is returned; one that fails is never returned.
 *   * **Versioned, with a description generated from the same definitions**:
 *     `catalogueDescription()`, pinned by `test/catalogue-pin.test.ts` against
 *     `packages/contracts/advisor/catalogue/` and `CATALOGUE_DESCRIPTION_DIGEST`.
 *   * **Deterministic**: no clock but the injected one, no randomness but the
 *     seeded engines; nothing here reads or writes a model.
 */
import { todayIn, type Clock } from '@core/kernel';
import { configHash } from '@core/platform';
import { z } from 'zod';
import { NARRATOR_MANIFEST } from '../advisors/local/manifest.ts';
import { narratorGrantCeiling } from '../advisors/local/grant.ts';
import type { AdvisorScope } from '../contract/scopes.ts';
import type { AdvisorSnapshot } from '../contract/snapshot.ts';
import type { InsightsDatabase } from '../db.ts';
import { SnapshotBuilder } from '../snapshot/builder.ts';
import { deriveTokenKey } from '../snapshot/tokens.ts';
import type { CatalogueCallContext, CatalogueFunction } from './definition.ts';
import {
  CATALOGUE_SCHEMA_REGISTRY,
  CatalogueResultRejected,
  ResultEnvelopeDescriptionSchema,
  checkCatalogueResult,
  inputDigestOf,
  resultEnvelopeSchema,
  type CatalogueResult,
} from './figures.ts';
import { situationSnapshot, cashEmergencyFund, debtPayoffPlan } from './functions/cash-debt.ts';
import {
  goalRequiredSavings,
  planCompare,
  planLevers,
  planProject,
  retirementClaiming,
  retirementGuardrail,
  retirementRmdWindow,
} from './functions/plan-retirement.ts';
import {
  investingAllocation,
  investingConcentration,
  investingCosts,
  investingDrift,
  investingTaxLocation,
  limitsContributionRoom,
  recurringWaste,
} from './functions/holdings-limits.ts';
import { insightsCurrent, insightsExplain } from './functions/brief-explain.ts';
import { CatalogueRefusal, type CataloguePorts } from './ports.ts';
import { CATALOGUE_VERSION } from './version.ts';

/** Every function, in 12 §2.1's order. Frozen: a function added at runtime would be a scope added at runtime. */
export const CATALOGUE = Object.freeze({
  'situation.snapshot': situationSnapshot,
  'cash.emergency_fund': cashEmergencyFund,
  'debt.payoff_plan': debtPayoffPlan,
  'goal.required_savings': goalRequiredSavings,
  'plan.project': planProject,
  'plan.compare': planCompare,
  'plan.levers': planLevers,
  'retirement.claiming': retirementClaiming,
  'retirement.guardrail': retirementGuardrail,
  'retirement.rmd_window': retirementRmdWindow,
  'investing.allocation': investingAllocation,
  'investing.drift': investingDrift,
  'investing.concentration': investingConcentration,
  'investing.costs': investingCosts,
  'investing.tax_location': investingTaxLocation,
  'limits.contribution_room': limitsContributionRoom,
  'recurring.waste': recurringWaste,
  'insights.current': insightsCurrent,
  'insights.explain': insightsExplain,
});

export type CatalogueFunctionName = keyof typeof CATALOGUE;
type FunctionOf<N extends CatalogueFunctionName> = (typeof CATALOGUE)[N];
/** What a caller passes (defaults applied by the runtime). */
export type CatalogueArgs<N extends CatalogueFunctionName> =
  FunctionOf<N> extends CatalogueFunction<unknown, unknown, infer I> ? I : never;
/** What `result` holds when `status` is `ok`. */
export type CataloguePayload<N extends CatalogueFunctionName> =
  FunctionOf<N> extends CatalogueFunction<unknown, infer P, unknown> ? P : never;

export const CATALOGUE_FUNCTION_NAMES: readonly CatalogueFunctionName[] = Object.freeze(
  Object.keys(CATALOGUE) as CatalogueFunctionName[],
);

function definitionOf(name: string): CatalogueFunction<unknown, unknown, unknown> | null {
  if (!Object.hasOwn(CATALOGUE, name)) return null;
  return CATALOGUE[name as CatalogueFunctionName] as unknown as CatalogueFunction<
    unknown,
    unknown,
    unknown
  >;
}

// ---------------------------------------------------------------------------
// The description: what the compiler is shown
// ---------------------------------------------------------------------------

export interface CatalogueFunctionDescription {
  readonly name: string;
  readonly summary: string;
  readonly description: string;
  readonly backing: string;
  readonly scopes: readonly string[];
  readonly scope_rule: 'all' | 'any';
  /** JSON Schema (draft 2020-12) of the arguments, as the caller writes them. */
  readonly parameters: Record<string, unknown>;
  /** JSON Schema of the envelope's `result` when `status` is ok. `$ref`s point at the document's `$defs`. */
  readonly result: Record<string, unknown>;
}

export interface CatalogueDescription {
  readonly catalogue_version: typeof CATALOGUE_VERSION;
  readonly title: string;
  readonly description: string;
  /** The envelope every call answers with. */
  readonly envelope: Record<string, unknown>;
  /** The shapes stated once (`MoneyFigure`, `DecimalFigure`, `DateFigure`, `Finding`, …). */
  readonly $defs: Record<string, unknown>;
  readonly functions: readonly CatalogueFunctionDescription[];
}

/** One schema as JSON Schema, its named shapes lifted into `defs` (checked identical on every reuse). */
function jsonSchemaOf(
  schema: z.ZodType,
  io: 'input' | 'output',
  defs: Map<string, string>,
  collected: Record<string, unknown>,
): Record<string, unknown> {
  const {
    $schema: _schema,
    $defs: lifted,
    ...rest
  } = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    reused: 'inline',
    io,
    metadata: CATALOGUE_SCHEMA_REGISTRY,
  }) as Record<string, unknown>;
  if (lifted !== undefined && lifted !== null && typeof lifted === 'object') {
    for (const [id, definition] of Object.entries(lifted as Record<string, unknown>)) {
      const text = JSON.stringify(definition);
      const seen = defs.get(id);
      if (seen !== undefined && seen !== text) {
        throw new Error(`catalogue schema ${id} is stated two different ways`);
      }
      defs.set(id, text);
      collected[id] = definition;
    }
  }
  return rest;
}

/** The whole catalogue, described from the definitions the runtime runs. */
export function catalogueDescription(): CatalogueDescription {
  const defs = new Map<string, string>();
  const collected: Record<string, unknown> = {};
  const envelope = jsonSchemaOf(ResultEnvelopeDescriptionSchema, 'output', defs, collected);
  const functions = CATALOGUE_FUNCTION_NAMES.map((name) => {
    const definition = definitionOf(name);
    if (definition === null) throw new Error(`catalogue function ${name} is not defined`);
    return {
      name: definition.name,
      summary: definition.summary,
      description: definition.description,
      backing: definition.backing,
      scopes: [...definition.scopes],
      scope_rule: definition.scopeRule,
      parameters: jsonSchemaOf(definition.args, 'input', defs, collected),
      result: jsonSchemaOf(definition.result, 'output', defs, collected),
    };
  });
  return {
    catalogue_version: CATALOGUE_VERSION,
    title: 'PersonalFi advisory catalogue',
    description:
      'Deterministic advisory functions over the holder’s own data. Every figure in a result is ' +
      'money, a decimal string or a date, and carries source_refs into the result’s own inputs. ' +
      'A function the holder has not granted is not listed. No function moves money, and none ' +
      'asks a model.',
    envelope,
    $defs: Object.fromEntries(
      Object.keys(collected)
        .sort()
        .map((id) => [id, collected[id]]),
    ),
    functions,
  };
}

/** Stable serialisation, like every published JSON here: two spaces and a trailing newline. */
export function serialiseCatalogueDescription(description: CatalogueDescription): string {
  return `${JSON.stringify(description, null, 2)}\n`;
}

export function catalogueDescriptionDigest(description: CatalogueDescription): string {
  return `sha256:${configHash(description as unknown as Record<string, unknown>)}`;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/** The scopes a call to `definition` reads under `ceiling`, or `null` when it is not granted. */
export function grantedScopesFor(
  definition: Pick<CatalogueFunction, 'scopes' | 'scopeRule'>,
  ceiling: readonly AdvisorScope[],
): readonly AdvisorScope[] | null {
  const granted = new Set(ceiling);
  if (definition.scopeRule === 'all') {
    return definition.scopes.every((scope) => granted.has(scope)) ? [...definition.scopes] : null;
  }
  const inside = definition.scopes.filter((scope) => granted.has(scope));
  return inside.length > 0 ? inside : null;
}

// ---------------------------------------------------------------------------
// The runtime
// ---------------------------------------------------------------------------

export interface CatalogueRuntimeDependencies {
  readonly database: InsightsDatabase;
  readonly ports: CataloguePorts;
  readonly clock: Clock;
  /** The holder's IANA zone: what "today" is. */
  readonly timeZone: string;
  readonly baseCurrency: string;
  /** The deployment's advisor token secret, from which each holder's pseudonym key is derived. */
  readonly tokenSecret: string;
}

export interface CatalogueHolder {
  readonly userId: string;
  readonly correlationId: string;
}

export interface CatalogueListing {
  readonly catalogue_version: typeof CATALOGUE_VERSION;
  readonly envelope: Record<string, unknown>;
  readonly $defs: Record<string, unknown>;
  /** What this holder may call: the published descriptions of the functions their grant covers. */
  readonly functions: readonly CatalogueFunctionDescription[];
}

/** What this holder can call, and nothing else. A function their grant does not cover is not listed. */
export async function listCatalogue(
  dependencies: Pick<CatalogueRuntimeDependencies, 'database'>,
  holder: Pick<CatalogueHolder, 'userId'>,
): Promise<CatalogueListing> {
  const ceiling = await narratorGrantCeiling(dependencies.database, holder.userId);
  const described = catalogueDescription();
  return {
    catalogue_version: CATALOGUE_VERSION,
    envelope: described.envelope,
    $defs: described.$defs,
    functions: described.functions.filter((entry) => {
      const definition = definitionOf(entry.name);
      return definition !== null && grantedScopesFor(definition, ceiling) !== null;
    }),
  };
}

function issuesOf(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => `${issue.path.join('.') || '(arguments)'}: ${issue.message}`)
    .join('; ');
}

/**
 * Call one function for one holder. Typed for 11.5c/11.5d; the route calls
 * `callCatalogueByName` with whatever the body held.
 *
 * @throws {CatalogueRefusal} the function is unknown (404), not granted (403),
 *   its arguments are invalid (400) or name something that is not there
 *   (404/422).
 * @throws {CatalogueResultRejected} the result did not trace to its inputs —
 *   the catalogue's own bug; nothing is returned.
 */
export async function callCatalogue<N extends CatalogueFunctionName>(
  dependencies: CatalogueRuntimeDependencies,
  holder: CatalogueHolder,
  name: N,
  args: CatalogueArgs<N>,
): Promise<CatalogueResult<CataloguePayload<N>>> {
  return (await callCatalogueByName(dependencies, holder, name, args)) as CatalogueResult<
    CataloguePayload<N>
  >;
}

export async function callCatalogueByName(
  dependencies: CatalogueRuntimeDependencies,
  holder: CatalogueHolder,
  name: string,
  rawArgs: unknown,
): Promise<CatalogueResult> {
  const definition = definitionOf(name);
  if (definition === null) {
    throw new CatalogueRefusal('catalogue.unknown_function', 404, `no catalogue function ${name}`);
  }
  const ceiling = await narratorGrantCeiling(dependencies.database, holder.userId);
  const scopes = grantedScopesFor(definition, ceiling);
  if (scopes === null) {
    const missing = definition.scopes.filter((scope) => !ceiling.includes(scope));
    throw new CatalogueRefusal(
      'catalogue.scope_not_granted',
      403,
      `${name} needs ${definition.scopeRule === 'all' ? 'every one' : 'one'} of these scopes ` +
        `granted to the narrator: ${missing.join(', ')}`,
    );
  }
  const today = todayIn(dependencies.clock, dependencies.timeZone);
  const tokenKey = deriveTokenKey(dependencies.tokenSecret, holder.userId);
  const allowed = new Set<AdvisorScope>(scopes);
  const context: CatalogueCallContext = {
    userId: holder.userId,
    clock: dependencies.clock,
    correlationId: holder.correlationId,
    today,
    baseCurrency: dependencies.baseCurrency,
    ports: dependencies.ports,
    database: dependencies.database,
    ceiling,
    tokenKey,
    async snapshot(requested: readonly AdvisorScope[]): Promise<AdvisorSnapshot> {
      // A function may only ever build its snapshot from the scopes its call was granted.
      const outside = requested.filter((scope) => !allowed.has(scope));
      if (outside.length > 0) {
        throw new Error(`${name} asked for scopes outside its grant: ${outside.join(', ')}`);
      }
      const built = await new SnapshotBuilder(dependencies.ports.snapshot).build({
        userId: holder.userId,
        kind: NARRATOR_MANIFEST.kind,
        grantedScopes: requested,
        today,
        baseCurrency: dependencies.baseCurrency,
        tokenKey,
      });
      return built.snapshot;
    },
  };
  return evaluateCatalogueFunction(name, context, rawArgs, scopes);
}

/**
 * Parse the arguments, run one function in an already-gated context, wrap its
 * outcome in the envelope and check it. `callCatalogueByName` is the only
 * production caller; the gate is its job, not this function's.
 */
export async function evaluateCatalogueFunction(
  name: string,
  context: CatalogueCallContext,
  rawArgs: unknown,
  scopes: readonly AdvisorScope[],
): Promise<CatalogueResult> {
  const definition = definitionOf(name);
  if (definition === null) {
    throw new CatalogueRefusal('catalogue.unknown_function', 404, `no catalogue function ${name}`);
  }
  const parsed = definition.args.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    throw new CatalogueRefusal('catalogue.invalid_arguments', 400, issuesOf(parsed.error));
  }
  const outcome = await definition.run(context, parsed.data, scopes);
  const envelope: CatalogueResult = {
    catalogue_version: CATALOGUE_VERSION,
    function: definition.name,
    status: outcome.status,
    as_of: context.today,
    scopes: [...scopes],
    inputs: outcome.inputs,
    input_digest: inputDigestOf(outcome.inputs),
    result: outcome.status === 'ok' ? outcome.result : null,
    not_available: outcome.status === 'ok' ? null : { code: outcome.code, reason: outcome.reason },
  };
  assertCatalogueResult(definition, envelope);
  return envelope;
}

/** The shape (strict zod) and the trace (`checkCatalogueResult`), or a rejection. */
export function assertCatalogueResult(
  definition: Pick<CatalogueFunction, 'name' | 'result'>,
  envelope: CatalogueResult,
): void {
  const shape = resultEnvelopeSchema(definition.name, definition.result).safeParse(envelope);
  if (!shape.success) {
    throw new CatalogueResultRejected(
      definition.name,
      shape.error.issues.slice(0, 8).map((issue) => ({
        kind: 'shape' as const,
        path: `${issue.path.join('.')}: ${issue.message}`,
      })),
    );
  }
  const problems = checkCatalogueResult(envelope);
  if (problems.length > 0) throw new CatalogueResultRejected(definition.name, problems);
}
