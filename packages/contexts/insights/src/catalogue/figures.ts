// SPDX-License-Identifier: MIT
/**
 * A catalogue figure, the envelope every function returns, and the check that
 * every figure in it traces to the call's own inputs (WP 11.5b; 12 §2.1:
 * "every return carries `source_ref`s").
 *
 * ## A figure is a value and the refs it came from
 *
 * Three shapes, and nothing else may carry a number a human will read:
 *
 *   * `{ money: { minor, currency }, source_refs }` — integer minor units in a
 *     string, never a float (docs/CONVENTIONS.md, "Money");
 *   * `{ decimal: '0.2399', unit, source_refs }` — a ratio, a probability, a
 *     count of months or years, an age: a decimal **string**;
 *   * `{ date: '2027-04' | '2027-04-01', source_refs }` — a month or a day.
 *
 * `source_refs` uses the advisor contract's own form (`SourceRefSchema`,
 * `snapshot:<path>`) and is resolved by the contract's own resolver
 * (`resolveSourceRef`) — against the call's **inputs**, which are part of the
 * result. The inputs are the scoped snapshot blocks the function read
 * (decimalised: a snapshot ratio crosses as a decimal string here), the
 * arguments it was given (`args`), and any further read it made (`parameters`
 * from the WP 4.2 store, `projection`, `contributions`, `brief`, …). A ref that
 * does not resolve is a fabrication, exactly as 08 §4.3 says of an insight.
 *
 * ## The check (`checkCatalogueResult`)
 *
 * Walked over the whole envelope before a result leaves `callCatalogue`:
 *
 *   1. every figure has at least one ref, and every ref resolves into
 *      `inputs`;
 *   2. no money object and no decimal-looking string sits in the result
 *      **outside** a figure — a figure without refs is refused, and so is a
 *      bare one;
 *   3. no non-integer JSON number appears anywhere, inputs included: a float
 *      that reached a result is refused, whatever field it hid in.
 *
 * A result that fails is never returned (`CatalogueResultRejected`, an
 * internal error): the catalogue fails closed.
 */
import { configHash } from '@core/platform';
import { z } from 'zod';
import { SourceRefSchema } from '../contract/response.ts';
import { MoneyJsonSchema, type AdvisorSnapshot, type MoneyJson } from '../contract/snapshot.ts';
import * as decimal from '../validate/decimal.ts';
import { resolveSourceRef } from '../validate/evidence.ts';
import { CATALOGUE_VERSION } from './version.ts';

/** A plain decimal string. Never a JSON number, never an exponent. */
export const DecimalStringSchema = z
  .string()
  .regex(/^-?\d{1,25}(\.\d{1,12})?$/, 'a decimal string, never a JSON number');

export const DateFigureValueSchema = z
  .string()
  .regex(/^\d{4}-\d{2}(-\d{2})?$/, 'YYYY-MM or YYYY-MM-DD');

/** What a decimal figure counts. Named so a narration can say "months" without guessing. */
export const FIGURE_UNITS = [
  'ratio',
  'probability',
  'months',
  'years',
  'age',
  'days',
  'year',
  'count',
  'factor',
] as const;
export type FigureUnit = (typeof FIGURE_UNITS)[number];

/**
 * The named shapes the published description defines once, under `$defs`, and
 * refers to everywhere else — so the document the compiler is shown states a
 * figure's shape once rather than three hundred times.
 */
export const CATALOGUE_SCHEMA_REGISTRY = z.registry<{ readonly id: string }>();

export const SourceRefsSchema = z
  .array(SourceRefSchema)
  .min(1)
  .max(64)
  .describe('Where the figure came from: `snapshot:<path>` refs into this result’s own `inputs`.');

export const MoneyFigureSchema = z.strictObject({
  money: MoneyJsonSchema,
  source_refs: SourceRefsSchema,
});
export const DecimalFigureSchema = z.strictObject({
  decimal: DecimalStringSchema,
  unit: z.enum(FIGURE_UNITS),
  source_refs: SourceRefsSchema,
});
export const DateFigureSchema = z.strictObject({
  date: DateFigureValueSchema,
  source_refs: SourceRefsSchema,
});

CATALOGUE_SCHEMA_REGISTRY.add(SourceRefsSchema, { id: 'SourceRefs' });
CATALOGUE_SCHEMA_REGISTRY.add(MoneyFigureSchema, { id: 'MoneyFigure' });
CATALOGUE_SCHEMA_REGISTRY.add(DecimalFigureSchema, { id: 'DecimalFigure' });
CATALOGUE_SCHEMA_REGISTRY.add(DateFigureSchema, { id: 'DateFigure' });
CATALOGUE_SCHEMA_REGISTRY.add(MoneyJsonSchema, { id: 'Money' });

export type MoneyFigure = z.infer<typeof MoneyFigureSchema>;
export type DecimalFigure = z.infer<typeof DecimalFigureSchema>;
export type DateFigure = z.infer<typeof DateFigureSchema>;

/** `snapshot:<path>` — the one ref form a catalogue figure uses. */
export function ref(path: string): string {
  return `snapshot:${path}`;
}

export function moneyFigure(money: MoneyJson, refs: readonly string[]): MoneyFigure {
  return { money: { minor: money.minor, currency: money.currency }, source_refs: [...refs] };
}

export function decimalFigure(
  text: string,
  unit: FigureUnit,
  refs: readonly string[],
): DecimalFigure {
  return { decimal: text, unit, source_refs: [...refs] };
}

export function dateFigure(text: string, refs: readonly string[]): DateFigure {
  return { date: text, source_refs: [...refs] };
}

// ---------------------------------------------------------------------------
// Decimals, exactly
// ---------------------------------------------------------------------------

/** A scale-6 decimal (`validate/decimal.ts`) rendered with its trailing zeros dropped. */
export function decimalText(value: decimal.Decimal, places = decimal.DECIMAL_SCALE): string {
  const rendered = decimal.render(value, places);
  if (rendered === null) throw new Error('a catalogue decimal out of range');
  if (!rendered.includes('.')) return rendered;
  const trimmed = rendered.replace(/0+$/u, '').replace(/\.$/u, '');
  return trimmed === '-0' ? '0' : trimmed;
}

/** A decimal string → scale-6, or a throw: catalogue inputs are already checked. */
export function parseDecimalOrThrow(text: string): decimal.Decimal {
  const parsed = decimal.parseDecimal(text);
  if (parsed === null) throw new Error(`not a decimal: ${JSON.stringify(text)}`);
  return parsed;
}

/** `numerator ÷ denominator` (both integers), half-even to `places`, as a decimal string. */
export function ratioText(numerator: bigint, denominator: bigint, places: number): string {
  if (denominator === 0n) throw new Error('a ratio over zero');
  const quotient = decimal.divide(numerator * 1_000_000n, denominator * 1_000_000n);
  if (quotient === null) throw new Error('a ratio out of range');
  return decimalText(quotient, places);
}

// ---------------------------------------------------------------------------
// Decimalising a snapshot: the inputs carry no float
// ---------------------------------------------------------------------------

/**
 * A copy of `value` with every non-integer number rendered as a decimal string
 * through the validator's own conversion (`decimal.fromNumber`, `toFixed(6)`),
 * so a ref into a ratio resolves to `'0.2399'`, never to `0.2399`. Integers
 * (counts, ages, years, day counts) stay numbers. Paths are unchanged: a ref
 * that resolves into the snapshot resolves into its decimalised copy.
 */
export function decimalised(value: unknown): unknown {
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return value;
    const parsed = decimal.fromNumber(value);
    if (parsed === null) throw new Error('a snapshot number the catalogue cannot carry');
    return decimalText(parsed);
  }
  if (Array.isArray(value)) return value.map(decimalised);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, inner]) => [
        key,
        decimalised(inner),
      ]),
    );
  }
  return value;
}

/** The snapshot blocks a call read, decimalised, as the start of its inputs. */
export function snapshotInputs(snapshot: AdvisorSnapshot): Record<string, unknown> {
  return decimalised(snapshot) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// The envelope
// ---------------------------------------------------------------------------

export const NotAvailableSchema = z.strictObject({
  code: z.string().regex(/^[a-z_]+$/),
  reason: z.string().min(1).max(600),
});

/**
 * One call's result. `result` is the function's own payload when `status` is
 * `ok` and `null` when it is `not_available` (the function exists and was
 * granted, but the data or the engine to answer it does not — said, never
 * invented).
 */
export function resultEnvelopeSchema<T extends z.ZodType>(name: string, payload: T) {
  return z.strictObject({
    catalogue_version: z.literal(CATALOGUE_VERSION),
    function: z.literal(name),
    status: z.enum(['ok', 'not_available']),
    /** The holder's today (`YYYY-MM-DD`, their zone): what "now" meant for this call. */
    as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    /** The scopes this call read: its declared scopes, or (for an `any` function) the granted ones. */
    scopes: z.array(z.string()),
    inputs: z.record(z.string(), z.unknown()),
    /** `sha256:` over the canonical JSON of `inputs`. */
    input_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    result: payload.nullable(),
    not_available: NotAvailableSchema.nullable(),
  });
}

/** The envelope as the description states it once: `result` is each function's own `result` schema. */
export const ResultEnvelopeDescriptionSchema = resultEnvelopeSchema('<function name>', z.unknown())
  .extend({ function: z.string() })
  .describe(
    'Every call answers with this envelope. `result` is the function’s own result schema when ' +
      '`status` is ok, and null when it is not_available (then `not_available` says why).',
  );

export interface CatalogueResult<P = unknown> {
  readonly catalogue_version: typeof CATALOGUE_VERSION;
  readonly function: string;
  readonly status: 'ok' | 'not_available';
  readonly as_of: string;
  readonly scopes: readonly string[];
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly input_digest: string;
  readonly result: P | null;
  readonly not_available: { readonly code: string; readonly reason: string } | null;
}

export function inputDigestOf(inputs: Readonly<Record<string, unknown>>): string {
  return `sha256:${configHash(inputs as Record<string, unknown>)}`;
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

export type CatalogueResultProblem =
  | { readonly kind: 'figure_without_source_ref'; readonly path: string }
  | { readonly kind: 'unresolved_source_ref'; readonly path: string; readonly ref: string }
  | { readonly kind: 'bare_money'; readonly path: string }
  | { readonly kind: 'bare_decimal'; readonly path: string }
  | { readonly kind: 'float'; readonly path: string }
  | { readonly kind: 'shape'; readonly path: string };

const DECIMAL_LOOKING = /^-?\d+(\.\d+)?$/;

function isFigure(value: Record<string, unknown>): boolean {
  return 'source_refs' in value;
}

function isMoneyShaped(value: Record<string, unknown>): boolean {
  return typeof value['minor'] === 'string' && typeof value['currency'] === 'string';
}

function walkFloats(value: unknown, path: string, out: CatalogueResultProblem[]): void {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) out.push({ kind: 'float', path });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((inner, index) => walkFloats(inner, `${path}[${String(index)}]`, out));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      walkFloats(inner, `${path}.${key}`, out);
    }
  }
}

function walkFigures(
  value: unknown,
  path: string,
  inputs: AdvisorSnapshot,
  out: CatalogueResultProblem[],
): void {
  if (typeof value === 'string') {
    if (DECIMAL_LOOKING.test(value)) out.push({ kind: 'bare_decimal', path });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((inner, index) => walkFigures(inner, `${path}[${String(index)}]`, inputs, out));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (isFigure(record)) {
    const refs = record['source_refs'];
    if (!Array.isArray(refs) || refs.length === 0) {
      out.push({ kind: 'figure_without_source_ref', path });
      return;
    }
    for (const entry of refs) {
      const text = typeof entry === 'string' ? entry : '';
      if (!resolveSourceRef(inputs, text).ok) {
        out.push({ kind: 'unresolved_source_ref', path, ref: text });
      }
    }
    return;
  }
  if (isMoneyShaped(record)) {
    out.push({ kind: 'bare_money', path });
    return;
  }
  for (const [key, inner] of Object.entries(record)) {
    walkFigures(inner, `${path}.${key}`, inputs, out);
  }
}

/**
 * Every problem with a result, empty when it may be returned. Total over
 * arbitrary JSON: a malformed result is a list of problems, never a throw.
 */
export function checkCatalogueResult(result: {
  readonly inputs: unknown;
  readonly result: unknown;
}): readonly CatalogueResultProblem[] {
  const out: CatalogueResultProblem[] = [];
  walkFloats(result, 'result', out);
  const inputs =
    result.inputs !== null && typeof result.inputs === 'object' && !Array.isArray(result.inputs)
      ? (result.inputs as AdvisorSnapshot)
      : ({} as AdvisorSnapshot);
  walkFigures(result.result, 'result.result', inputs, out);
  return out;
}

/** A result that failed `checkCatalogueResult`. Internal: the catalogue's own bug, never returned. */
export class CatalogueResultRejected extends Error {
  readonly code = 'catalogue.result_rejected';
  readonly problems: readonly CatalogueResultProblem[];
  constructor(name: string, problems: readonly CatalogueResultProblem[]) {
    super(
      `catalogue function ${name} produced a result that does not trace to its inputs: ` +
        problems
          .slice(0, 5)
          .map((problem) => `${problem.kind} at ${problem.path}`)
          .join('; '),
    );
    this.name = 'CatalogueResultRejected';
    this.problems = problems;
  }
}
