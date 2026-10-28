// SPDX-License-Identifier: MIT
/**
 * Parameter citations: a stable key per cited node of the assumptions file
 * (WP 11.5a; 12 §2.2, "retrieved by key and quoted verbatim").
 *
 * WP 4.2 put every limit, rate and default in one cited, hashed file
 * (`./assumptions.ts`). Code reads it by structure (`taxYear(a, 2026).hsa.family`).
 * A narration, and a playbook page, cannot: they are text, and text can only
 * cite something by name. This module gives every cited node a name and
 * resolves the name back to the node, `{ value, source, asOf }`, so that a
 * sentence resting on a limit can carry the key it rests on and a validator
 * can check the key resolves and the figure is the node's.
 *
 * ## The key
 *
 *   * A tax-year node: `tax.us.<year>.<path>` — `tax.us.2026.retirement.elective_deferral`.
 *   * Any other node: `assumptions.<path>` — `assumptions.capital_market.us_equity.expected_return`.
 *
 * `<path>` is the node's property path with each segment written in
 * snake_case, letters and digits split (`catchUpAge60To63` →
 * `catch_up_age_60_to_63`). The mapping is derived from the file, never
 * maintained by hand, and a test proves it is one-to-one.
 *
 * ## A year the file does not hold is refused, never substituted
 *
 * `tax.us.2027.retirement.elective_deferral` throws
 * `AssumptionsYearUnavailable` — the same refusal `taxYear(a, 2027)` gives,
 * naming the years the file holds. There is no "latest year" alias: a page or
 * a narration names its year, and when the store gains 2027 a page moves to it
 * by an edit and a version bump, never silently.
 *
 * ## What is returned
 *
 * The node as wire data — every `bigint` as a decimal string, `Money` as
 * `{ minor, currency }` (08 §6.5: no `number` at a money boundary) — with its
 * citation fields and the file version it was read from. Rendering a value
 * into prose is the reader's job (`@ctx/insights`' knowledge base).
 */
import type { MoneyJson } from '@core/kernel';
import {
  AssumptionsYearUnavailable,
  CITED_KINDS,
  loadAssumptions,
  type Assumptions,
  type CitedKind,
} from './assumptions.ts';

/** `tax.us.2026.retirement.elective_deferral`, `assumptions.macro.cpi_urban_index`. */
export const PARAMETER_KEY_PATTERN =
  /^(?:tax\.us\.\d{4}|assumptions)(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$/;

const TAX_KEY = /^tax\.us\.(\d{4})\./;

export interface MoneyRangeJson {
  readonly from: MoneyJson;
  readonly to: MoneyJson;
}

/** The node's value as wire data. Every magnitude is a string. */
export type ParameterValue =
  | { readonly kind: 'money'; readonly value: MoneyJson }
  | { readonly kind: 'moneyRange'; readonly value: MoneyRangeJson }
  | { readonly kind: 'rate'; readonly value: string }
  | { readonly kind: 'rateRange'; readonly value: { readonly from: string; readonly to: string } }
  | { readonly kind: 'integer'; readonly value: string }
  | {
      readonly kind: 'fraction';
      readonly value: { readonly numerator: string; readonly denominator: string };
    }
  | { readonly kind: 'index'; readonly value: string }
  | { readonly kind: 'fact'; readonly value: string }
  | {
      readonly kind: 'brackets';
      readonly value: readonly { readonly over: MoneyJson; readonly rate: string }[];
    }
  | {
      readonly kind: 'ageSchedule';
      readonly value: readonly {
        readonly bornFrom: string;
        readonly bornThrough: string | null;
        readonly age: string;
      }[];
    }
  | {
      readonly kind: 'correlation';
      readonly value: {
        readonly assets: readonly string[];
        readonly matrix: readonly (readonly string[])[];
      };
    };

/** One cited node, by key. */
export type ParameterCitation = ParameterValue & {
  readonly key: string;
  readonly source: string;
  readonly asOf: string;
  readonly note?: string;
  readonly attribution?: string;
  /** A fact's effective date, when it has one. */
  readonly effective?: string;
  /** An integer's unit (`age_years`, `calendar_year`, …). */
  readonly unit?: string;
  /** A rate's basis (`nominal`, `inflation_adjusted`), when it has one. */
  readonly basis?: string;
  /** The assumptions file version the node was read from (`sha256:…`). */
  readonly parametersVersion: string;
};

/** A key that names no cited node in the file. 422, `domain`. */
export class UnknownParameterKey extends Error {
  override readonly name = 'UnknownParameterKey';
  readonly code = 'planning.parameter_unknown';
  readonly key: string;

  constructor(key: string) {
    super(
      PARAMETER_KEY_PATTERN.test(key)
        ? `no cited node in the assumptions file has the key ${key}`
        : `${key} is not a parameter key (tax.us.<year>.<path> or assumptions.<path>, snake_case)`,
    );
    this.key = key;
  }
}

/** `UnknownParameterKey` or a year the file does not hold. A predicate, as `isAssumptionsRefusal`. */
export function isParameterRefusal(
  error: unknown,
): error is UnknownParameterKey | AssumptionsYearUnavailable {
  if (!(error instanceof Error)) return false;
  const code: unknown = (error as Error & { code?: unknown }).code;
  return code === 'planning.parameter_unknown' || code === 'planning.assumptions_year_unavailable';
}

/** `catchUpAge60To63` → `catch_up_age_60_to_63`; `form1099Da` → `form_1099_da`. */
export function snakeSegment(segment: string): string {
  let out = segment;
  for (;;) {
    const next = out
      .replace(/([a-z])([A-Z0-9])/g, '$1_$2')
      .replace(/([0-9])([A-Za-z])/g, '$1_$2')
      .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2');
    if (next === out) break;
    out = next;
  }
  return out.toLowerCase();
}

const CITED = new Set<string>(CITED_KINDS);

function isCitedNode(node: unknown): node is Record<string, unknown> & { kind: CitedKind } {
  return (
    node !== null &&
    typeof node === 'object' &&
    !Array.isArray(node) &&
    typeof (node as { kind?: unknown }).kind === 'string' &&
    CITED.has((node as { kind: string }).kind) &&
    typeof (node as { source?: unknown }).source === 'string'
  );
}

/** `bigint` → string, recursively; everything else as it is. Never a `number` for a magnitude. */
function wire(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(wire);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, inner]) => [name, wire(inner)]));
  }
  return value;
}

function citationOf(
  key: string,
  node: Record<string, unknown>,
  version: string,
): ParameterCitation {
  const optional = (name: string): Record<string, string> =>
    typeof node[name] === 'string' ? { [name]: node[name] } : {};
  return Object.freeze({
    key,
    kind: node['kind'],
    value: wire(node['value']),
    source: node['source'],
    asOf: node['asOf'],
    ...optional('note'),
    ...optional('attribution'),
    ...optional('effective'),
    ...optional('unit'),
    ...optional('basis'),
    parametersVersion: version,
  } as ParameterCitation);
}

function walk(
  node: unknown,
  prefix: string,
  version: string,
  into: Map<string, ParameterCitation>,
): void {
  if (isCitedNode(node)) {
    if (into.has(prefix)) throw new Error(`two cited nodes map to the parameter key ${prefix}`);
    into.set(prefix, citationOf(prefix, node, version));
    return;
  }
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
  for (const [name, inner] of Object.entries(node))
    walk(inner, `${prefix}.${snakeSegment(name)}`, version, into);
}

const catalogues = new WeakMap<Assumptions, ReadonlyMap<string, ParameterCitation>>();

/**
 * Every cited node of `assumptions`, by key, in file order. Built once per
 * loaded file and frozen. The tax tables come first, by year.
 */
export function parameterCatalogue(
  assumptions: Assumptions = loadAssumptions(),
): ReadonlyMap<string, ParameterCitation> {
  const cached = catalogues.get(assumptions);
  if (cached !== undefined) return cached;
  const into = new Map<string, ParameterCitation>();
  const { taxYears, ...rest } = assumptions.file;
  for (const year of Object.keys(taxYears).sort()) {
    walk(taxYears[year], `tax.us.${year}`, assumptions.version, into);
  }
  walk(rest, 'assumptions', assumptions.version, into);
  for (const key of into.keys()) {
    if (!PARAMETER_KEY_PATTERN.test(key))
      throw new Error(`derived parameter key ${key} is malformed`);
  }
  catalogues.set(assumptions, into);
  return into;
}

/**
 * The cited node `key` names.
 *
 * @throws {AssumptionsYearUnavailable} a `tax.us.<year>` key for a year the file does not hold.
 * @throws {UnknownParameterKey} any other key that names no node.
 */
export function parameterByKey(
  key: string,
  assumptions: Assumptions = loadAssumptions(),
): ParameterCitation {
  const year = TAX_KEY.exec(key)?.[1];
  if (year !== undefined && assumptions.file.taxYears[year] === undefined) {
    throw new AssumptionsYearUnavailable(
      Number(year),
      Object.keys(assumptions.file.taxYears).sort(),
    );
  }
  const found = parameterCatalogue(assumptions).get(key);
  if (found === undefined) throw new UnknownParameterKey(key);
  return found;
}
