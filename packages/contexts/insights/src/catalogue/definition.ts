// SPDX-License-Identifier: MIT
/**
 * The shape of one catalogue function (WP 11.5b). A definition is data — its
 * name, what it says it does, what backs it, its scopes and the zod schemas of
 * its arguments and its payload — plus one `run`. `callCatalogue` runs it and
 * `catalogueDescription()` publishes it, from the same object, so the contract
 * the compiler is shown and the code that answers cannot drift.
 */
import type { Clock, DateOnly } from '@core/kernel';
import type { z } from 'zod';
import type { AdvisorScope } from '../contract/scopes.ts';
import type { AdvisorSnapshot } from '../contract/snapshot.ts';
import type { InsightsDatabase } from '../db.ts';
import type { CataloguePorts } from './ports.ts';

/** What one call may use. Built by `callCatalogue`; a function never reads a clock or a grant itself. */
export interface CatalogueCallContext {
  readonly userId: string;
  readonly clock: Clock;
  readonly correlationId: string;
  /** The holder's today, in their zone. */
  readonly today: DateOnly;
  readonly baseCurrency: string;
  readonly ports: CataloguePorts;
  readonly database: InsightsDatabase;
  /** The holder's live grant to the narrator ∩ the narrator's bound. */
  readonly ceiling: readonly AdvisorScope[];
  /** The scoped snapshot, built for exactly these scopes, under the narrator's kind. */
  snapshot(scopes: readonly AdvisorScope[]): Promise<AdvisorSnapshot>;
  /** `deriveTokenKey(secret, holder)`: what resolves a snapshot pseudonym (a `goal_ref`) back. */
  readonly tokenKey: string;
}

export type FunctionOutcome<P> =
  | { readonly status: 'ok'; readonly inputs: Record<string, unknown>; readonly result: P }
  | {
      readonly status: 'not_available';
      readonly inputs: Record<string, unknown>;
      readonly code: string;
      readonly reason: string;
    };

/**
 * `all`: visible and callable only when every declared scope is granted.
 * `any`: the function reads whatever part of its declared scopes the holder
 * granted (the snapshot itself, the Brief's list), and is invisible only when
 * none is.
 */
export type ScopeRule = 'all' | 'any';

export interface CatalogueFunction<A = unknown, P = unknown, I = A> {
  readonly name: string;
  /** One line, for the listing. */
  readonly summary: string;
  /** What it returns and what it refuses to, for the compiler. */
  readonly description: string;
  /** The engine, report, route or rule behind it. */
  readonly backing: string;
  readonly scopes: readonly AdvisorScope[];
  readonly scopeRule: ScopeRule;
  /** Parsed with defaults applied: `I` is what a caller writes, `A` what `run` receives. */
  readonly args: z.ZodType<A, I>;
  readonly result: z.ZodType<P>;
  run(
    context: CatalogueCallContext,
    args: A,
    scopes: readonly AdvisorScope[],
  ): Promise<FunctionOutcome<P>>;
}

/** Identity, for inference: `defineFunction({ ... })` keeps `A` and `P` from the schemas. */
export function defineFunction<A, P, I>(
  definition: CatalogueFunction<A, P, I>,
): CatalogueFunction<A, P, I> {
  return Object.freeze(definition);
}

export function ok<P>(inputs: Record<string, unknown>, result: P): FunctionOutcome<P> {
  return { status: 'ok', inputs, result };
}

export function notAvailable<P>(
  inputs: Record<string, unknown>,
  code: string,
  reason: string,
): FunctionOutcome<P> {
  return { status: 'not_available', inputs, code, reason };
}
