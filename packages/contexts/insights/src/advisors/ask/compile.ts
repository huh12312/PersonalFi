// SPDX-License-Identifier: MIT
/**
 * `ask.compile`: the request (the one constructor of what the preview shows,
 * the inspector retains, `advisor_runs.input_digest` digests and the model is
 * sent) and the validator of its reply (WP 11.5c).
 *
 * ## What the compiler is sent, and nothing else
 *
 *   * the question, after the deterministic pre-check (`precheck.ts`);
 *   * today's date in the holder's zone (so "this year" can become `2026`);
 *   * the catalogue's version and **this holder's listing**: for each function
 *     the holder's grant covers (`listCatalogue`, the 11.5b gate), its name,
 *     summary, description and the JSON Schema of its parameters, with the
 *     `$defs` those parameters refer to. Result schemas are not sent: the
 *     compiler chooses calls, it never reads an answer;
 *   * the closed list of screens an unanswerable question may point at.
 *
 * No figure, row, account, institution or merchant crosses: the only holder
 * text is the question the holder typed. `granted_scopes` is therefore empty —
 * no data category is in the payload.
 *
 * ## The reply, validated before anything runs (`validateAskCompileReply`)
 *
 * Exactly `{ calls: [{ name, args }], unanswerable: { reason, nearest_screen } | null }`,
 * where `args` is an object or, as the reply format asks, a JSON object written
 * as a string (a strict hosted schema cannot describe a free-form object):
 *
 *   * `compile.schema` — anything else (a missing key, an extra key, a wrong type);
 *   * `compile.too_many_calls` — more than `ASK_MAX_CALLS`;
 *   * `compile.unknown_function` — a name the listing does not contain: a
 *     function that does not exist, **or one the holder has not granted** (it
 *     was never listed, so it cannot be compiled to);
 *   * `compile.invalid_arguments` — arguments the function's own schema (the
 *     zod definition `catalogueDescription()` is generated from) refuses;
 *   * `compile.duplicate_call` — the same function with the same arguments
 *     (after defaults) twice;
 *   * `compile.inconsistent` — calls and an `unanswerable` together, or
 *     neither;
 *   * `compile.unanswerable_invalid` — a reason outside `out_of_scope` |
 *     `not_computable`, or a screen outside the closed list.
 *
 * Pure: the compiled calls are a function of the recorded reply and the
 * listing's names alone, so a replay of the same reply compiles to the same
 * calls (the evaluation harness and the red team rely on it).
 */
import { newId } from '@core/kernel';
import { canonicalJson } from '@core/platform';
import {
  CATALOGUE,
  type CatalogueFunctionName,
  type CatalogueListing,
} from '../../catalogue/catalogue.ts';
import { canonicalRunDigest } from '../../preview.ts';
import { ASK_MAX_CALLS } from './manifest.ts';
import { ASK_NEAREST_SCREEN_PATHS, isAskNearestScreen, type AskNearestScreen } from './screens.ts';
import type { AskUnanswerableReason } from '../../../schema/index.ts';

export interface AskCompileFunction {
  readonly name: string;
  readonly summary: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

/** Structurally `@advisor/local-model`'s `AskCompileSubject`. */
export interface AskCompileSubject {
  readonly question: string;
  readonly today: string;
  readonly catalogue_version: string;
  readonly functions: readonly AskCompileFunction[];
  /** The `$defs` the parameters refer to (`#/$defs/Money`), and only those. */
  readonly defs: Record<string, unknown>;
  readonly nearest_screens: readonly string[];
  readonly max_calls: number;
}

export interface AskCompileWireRequest {
  readonly request_id: string;
  readonly subject: AskCompileSubject;
  readonly deadline: string;
  readonly max_response_bytes: number;
}

export interface AskCompilePayload {
  readonly snapshot: { readonly ask_compile: AskCompileSubject };
  readonly granted_scopes: readonly string[];
}

export interface AskCompileCheck {
  /** The names the listing carried: the only names a reply may compile to. */
  readonly allowed: readonly string[];
}

export interface BuiltAskCompileRequest {
  readonly request: AskCompileWireRequest;
  readonly payload: AskCompilePayload;
  readonly digest: string;
  readonly check: AskCompileCheck;
}

const REF = /"\$ref":"#\/\$defs\/([A-Za-z0-9_]+)"/gu;

/** The `$defs` a set of parameter schemas reaches, transitively. */
function referencedDefs(
  parameters: readonly Record<string, unknown>[],
  defs: Record<string, unknown>,
): Record<string, unknown> {
  const wanted = new Set<string>();
  const queue = parameters.map((schema) => JSON.stringify(schema));
  while (queue.length > 0) {
    const text = queue.pop() ?? '';
    for (const match of text.matchAll(REF)) {
      const id = match[1] ?? '';
      if (wanted.has(id) || !Object.hasOwn(defs, id)) continue;
      wanted.add(id);
      queue.push(JSON.stringify(defs[id]));
    }
  }
  return Object.fromEntries([...wanted].sort().map((id) => [id, defs[id]]));
}

/** The compile subject for one question over one holder's listing. Pure. */
export function askCompileSubjectOf(input: {
  readonly question: string;
  readonly today: string;
  readonly listing: Pick<CatalogueListing, 'catalogue_version' | '$defs' | 'functions'>;
}): AskCompileSubject {
  const functions = input.listing.functions.map((entry) => ({
    name: entry.name,
    summary: entry.summary,
    description: entry.description,
    parameters: entry.parameters,
  }));
  return {
    question: input.question,
    today: input.today,
    catalogue_version: input.listing.catalogue_version,
    functions,
    defs: referencedDefs(
      functions.map((entry) => entry.parameters),
      input.listing.$defs,
    ),
    nearest_screens: [...ASK_NEAREST_SCREEN_PATHS],
    max_calls: ASK_MAX_CALLS,
  };
}

function canonicalSubject(subject: AskCompileSubject): AskCompileSubject {
  return {
    question: subject.question,
    today: subject.today,
    catalogue_version: subject.catalogue_version,
    functions: subject.functions.map((entry) => ({
      name: entry.name,
      summary: entry.summary,
      description: entry.description,
      parameters: entry.parameters,
    })),
    defs: subject.defs,
    nearest_screens: [...subject.nearest_screens],
    max_calls: subject.max_calls,
  };
}

export function buildAskCompileRequest(input: {
  readonly subject: AskCompileSubject;
  readonly now: Date;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}): BuiltAskCompileRequest {
  const subject = canonicalSubject(input.subject);
  const payload: AskCompilePayload = { snapshot: { ask_compile: subject }, granted_scopes: [] };
  return {
    request: {
      request_id: newId(),
      subject,
      deadline: new Date(input.now.getTime() + input.timeoutMs).toISOString(),
      max_response_bytes: input.maxResponseBytes,
    },
    payload,
    digest: canonicalRunDigest(payload),
    check: { allowed: subject.functions.map((entry) => entry.name) },
  };
}

// ---------------------------------------------------------------------------
// The reply
// ---------------------------------------------------------------------------

export const ASK_COMPILE_REFUSAL_CLASSES = [
  'compile.schema',
  'compile.too_many_calls',
  'compile.unknown_function',
  'compile.invalid_arguments',
  'compile.duplicate_call',
  'compile.inconsistent',
  'compile.unanswerable_invalid',
] as const;
export type AskCompileRefusalClass = (typeof ASK_COMPILE_REFUSAL_CLASSES)[number];

export interface AskCompiledCall {
  readonly name: CatalogueFunctionName;
  /** The arguments as the function's schema parsed them (defaults applied). */
  readonly args: Record<string, unknown>;
}

export type AskCompileValidation =
  | { readonly ok: true; readonly kind: 'calls'; readonly calls: readonly AskCompiledCall[] }
  | {
      readonly ok: true;
      readonly kind: 'unanswerable';
      readonly reason: AskUnanswerableReason;
      readonly nearestScreen: AskNearestScreen;
    }
  | { readonly ok: false; readonly refusal: AskCompileRefusalClass; readonly detail: string };

function refused(refusal: AskCompileRefusalClass, detail: string): AskCompileValidation {
  return { ok: false, refusal, detail };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value).sort();
  const wanted = [...keys].sort();
  return own.length === wanted.length && own.every((key, index) => key === wanted[index]);
}

/**
 * A call's arguments: an object, or — the reply format's own form, because the
 * hosted vendors' strict structured outputs cannot describe a free-form object
 * — a string holding exactly one JSON object. Anything else is `null`.
 */
function argumentsOf(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== 'string' || value.length > 4_096) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Pure and total over arbitrary JSON. */
export function validateAskCompileReply(
  reply: unknown,
  check: AskCompileCheck,
): AskCompileValidation {
  if (!isRecord(reply)) return refused('compile.schema', 'the reply is not a JSON object');
  const keys = Object.keys(reply);
  if (
    !keys.includes('calls') ||
    keys.some((key) => key !== 'calls' && key !== 'unanswerable') ||
    !Array.isArray(reply['calls'])
  ) {
    return refused(
      'compile.schema',
      'the reply is not exactly { calls: [...], unanswerable: {...} | null }',
    );
  }
  const rawCalls = reply['calls'] as readonly unknown[];
  const rawUnanswerable = reply['unanswerable'] ?? null;
  const argsOf: Record<string, unknown>[] = [];
  for (const entry of rawCalls) {
    if (
      !isRecord(entry) ||
      !exactKeys(entry, ['name', 'args']) ||
      typeof entry['name'] !== 'string'
    ) {
      return refused('compile.schema', 'a call is not exactly { name: string, args: … }');
    }
    const args = argumentsOf(entry['args']);
    if (args === null) {
      return refused(
        'compile.schema',
        'a call\u2019s args is neither an object nor a JSON object as text',
      );
    }
    argsOf.push(args);
  }
  if (rawUnanswerable !== null && !isRecord(rawUnanswerable)) {
    return refused('compile.schema', 'unanswerable is neither an object nor null');
  }
  if (rawCalls.length > ASK_MAX_CALLS) {
    return refused(
      'compile.too_many_calls',
      `${String(rawCalls.length)} calls; at most ${String(ASK_MAX_CALLS)}`,
    );
  }
  const allowed = new Set(check.allowed);
  const calls: AskCompiledCall[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of (rawCalls as readonly Record<string, unknown>[]).entries()) {
    const name = entry['name'] as string;
    if (!allowed.has(name) || !Object.hasOwn(CATALOGUE, name)) {
      return refused(
        'compile.unknown_function',
        `${name.slice(0, 64)} is not a function in your listing`,
      );
    }
    const definition = CATALOGUE[name as CatalogueFunctionName];
    const parsed = definition.args.safeParse(argsOf[index]);
    if (!parsed.success) {
      return refused(
        'compile.invalid_arguments',
        `${name}: ${parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.') || '(arguments)'}: ${issue.message}`)
          .join('; ')}`,
      );
    }
    const args = parsed.data as Record<string, unknown>;
    const key = canonicalJson({ name, args });
    if (seen.has(key))
      return refused('compile.duplicate_call', `${name} twice with the same arguments`);
    seen.add(key);
    calls.push({ name: name as CatalogueFunctionName, args });
  }
  if (rawUnanswerable !== null) {
    if (calls.length > 0) {
      return refused('compile.inconsistent', 'calls and an unanswerable verdict together');
    }
    const record = rawUnanswerable as Record<string, unknown>;
    const reason = record['reason'];
    const screen = record['nearest_screen'];
    if (
      !exactKeys(record, ['reason', 'nearest_screen']) ||
      (reason !== 'out_of_scope' && reason !== 'not_computable') ||
      !isAskNearestScreen(screen)
    ) {
      return refused(
        'compile.unanswerable_invalid',
        'unanswerable is not { reason: out_of_scope | not_computable, nearest_screen: <a listed screen> }',
      );
    }
    return { ok: true, kind: 'unanswerable', reason, nearestScreen: screen };
  }
  if (calls.length === 0) {
    return refused('compile.inconsistent', 'no calls and no unanswerable verdict');
  }
  return { ok: true, kind: 'calls', calls };
}
