// SPDX-License-Identifier: MIT
/**
 * What several catalogue functions share: reading a parameter into the
 * inputs, running the built-in rules a function is "over" and reporting
 * what they found, and the shapes those two produce.
 */
import { z } from 'zod';
import { BUILTIN_CATALOGUE } from '../../advisors/catalogue.ts';
import type { Insight } from '../../contract/response.ts';
import { SEVERITIES } from '../../contract/response.ts';
import type { AdvisorScope } from '../../contract/scopes.ts';
import type { AdvisorSnapshot } from '../../contract/snapshot.ts';
import type { ParameterCitation } from '../../knowledge/params.ts';
import type { CatalogueCallContext } from '../definition.ts';
import {
  CATALOGUE_SCHEMA_REGISTRY,
  MoneyFigureSchema,
  moneyFigure,
  type MoneyFigure,
} from '../figures.ts';
import { CatalogueRefusal } from '../ports.ts';

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

/** One parameter as it sits in a result's `inputs.parameters[]`: the store's node, verbatim. */
export interface ParameterInput {
  readonly key: string;
  readonly kind: string;
  readonly value: unknown;
  readonly source: string;
  readonly as_of: string;
  readonly parameters_version: string;
}

function inputOf(citation: ParameterCitation): ParameterInput {
  return {
    key: citation.key,
    kind: citation.kind,
    value: citation.value,
    source: citation.source,
    as_of: citation.asOf,
    parameters_version: citation.parametersVersion,
  };
}

/**
 * A parameter from WP 4.2's store, by key, or `null` when the key names no node.
 * A `tax.us.<year>` key for a year the store does not hold is **refused**
 * (`catalogue.year_unavailable`), never answered from another year.
 */
export function readParameter(context: CatalogueCallContext, key: string): ParameterInput | null {
  const lookup = context.ports.parameters.get(key);
  if (lookup.found) return inputOf(lookup.citation);
  if (lookup.reason === 'year_unavailable') {
    throw new CatalogueRefusal('catalogue.year_unavailable', 422, lookup.detail);
  }
  return null;
}

// ---------------------------------------------------------------------------
// The built-in rules a function is over
// ---------------------------------------------------------------------------

export const FindingSchema = z.strictObject({
  /** 07 §3.3's id: `I1`, `U2`, `R7`. */
  rule_id: z.string(),
  advisor_id: z.string(),
  key: z.string(),
  title: z.string(),
  severity: z.enum(SEVERITIES),
  /** The rule's own annualised impact, with the refs its derivation read. */
  annual_impact: MoneyFigureSchema.nullable(),
  one_time_impact: MoneyFigureSchema.nullable(),
});
CATALOGUE_SCHEMA_REGISTRY.add(FindingSchema, { id: 'Finding' });
export type Finding = z.infer<typeof FindingSchema>;

function entryFor(ruleId: string) {
  const entry = BUILTIN_CATALOGUE.find((candidate) => candidate.ruleId === ruleId);
  if (entry === undefined) throw new Error(`no built-in rule ${ruleId}`);
  return entry;
}

/** The scopes the named rules declare, in catalogue order — what a function "over" them must ask for. */
export function scopesOfRules(ruleIds: readonly string[]): readonly AdvisorScope[] {
  const scopes = new Set<AdvisorScope>();
  for (const ruleId of ruleIds) {
    for (const scope of entryFor(ruleId).rule.manifest.requires_scopes) scopes.add(scope);
  }
  return [...scopes];
}

/** The snapshot refs an insight's figure rests on: its impact derivation's inputs, else its evidence. */
function refsOf(insight: Insight): readonly string[] {
  const derivation =
    insight.impact.derivation_id === null
      ? undefined
      : insight.derivations.find((candidate) => candidate.id === insight.impact.derivation_id);
  const refs =
    derivation !== undefined
      ? derivation.inputs
      : insight.evidence.flatMap((row) => (row.source_ref === null ? [] : [row.source_ref]));
  return refs.filter((entry) => entry.startsWith('snapshot:'));
}

function impactFigure(
  money: Insight['impact']['annualized'],
  refs: readonly string[],
): MoneyFigure | null {
  if (money === null || refs.length === 0) return null;
  return moneyFigure(money, refs);
}

/**
 * Run the named built-in rules over the snapshot this call built and report
 * what each found. The rules are the same objects the nightly run evaluates;
 * nothing is persisted and nothing is re-ranked.
 */
export function findingsOf(
  ruleIds: readonly string[],
  snapshot: AdvisorSnapshot,
  context: Pick<CatalogueCallContext, 'today' | 'baseCurrency'>,
): Finding[] {
  const out: Finding[] = [];
  for (const ruleId of ruleIds) {
    const entry = entryFor(ruleId);
    const output = entry.rule.evaluate({
      snapshot,
      today: context.today,
      period: context.today.slice(0, 7),
      baseCurrency: context.baseCurrency,
    });
    for (const insight of output.insights) {
      const refs = refsOf(insight);
      out.push({
        rule_id: ruleId,
        advisor_id: entry.advisorId,
        key: insight.key,
        title: insight.title,
        severity: insight.severity,
        annual_impact: impactFigure(insight.impact.annualized, refs),
        one_time_impact: impactFigure(insight.impact.one_time, refs),
      });
    }
  }
  return out;
}
