// SPDX-License-Identifier: MIT
/**
 * A catalogue result as Ask PersonalFi keeps it, shows it and sends it to the
 * narrator (WP 11.5c) — and the two deterministic renderings the app owns:
 * the "I looked at: …" line and the arithmetic shown when there is no prose.
 *
 * Every figure is read from the envelope `callCatalogue` returned, which
 * `checkCatalogueResult` already held to its inputs (11.5b): a figure is an
 * object with `source_refs` and exactly one of `money`, `decimal` (+ `unit`)
 * or `date`. The text a figure is shown as is the app's formatting of that
 * value — `$1,234.56`, `0.41%`, `4.84 months`, `2027-04` — and the narration's
 * numerals check is held to exactly those texts (and the raw decimals). A
 * model never writes a figure the holder sees here.
 *
 * Non-figure strings (an order's name, an asset class, a finding's title) are
 * kept as **facts**: prose a narration may quote whole, never mined for a
 * figure.
 */
import { configHash } from '@core/platform';
import type { CatalogueFunctionName } from '../../catalogue/catalogue.ts';
import type { CatalogueResult } from '../../catalogue/figures.ts';
import * as decimal from '../../validate/decimal.ts';
import { formatMoneyJson } from '../support.ts';
import { ASK_STORED_FIGURES_PER_CALL } from './manifest.ts';
import { ASK_FUNCTION_LABELS, ASK_FUNCTION_SCREENS, type AskNearestScreen } from './screens.ts';

export interface AskFigure {
  /** The figure's path inside the result (`plans[0].total_interest`). */
  readonly key: string;
  /** The app's words for it (`Plans · avalanche · total interest`). */
  readonly label: string;
  /** The value as the app writes it. */
  readonly text: string;
  readonly kind: 'money' | 'decimal' | 'date';
  /** The decimal as the catalogue wrote it (decimal figures only): `0.0041`. */
  readonly raw: string | null;
  readonly source_refs: readonly string[];
}

export interface AskFact {
  readonly key: string;
  readonly text: string;
}

export type AskResultStatus = 'ok' | 'not_available' | 'refused';

/** One compiled call, run: what the session row keeps and the screen shows. */
export interface AskResultView {
  readonly function: CatalogueFunctionName;
  /** "emergency-fund cover (target 3 months)": the app's words, never a model's. */
  readonly label: string;
  readonly args: Record<string, unknown>;
  readonly status: AskResultStatus;
  readonly as_of: string | null;
  readonly scopes: readonly string[];
  /** The envelope's own `input_digest` (sha256 over its inputs). */
  readonly input_digest: string | null;
  /** `sha256:` over the whole envelope as `callCatalogue` returned it. */
  readonly result_digest: string | null;
  readonly not_available: { readonly code: string; readonly reason: string } | null;
  /** A call the catalogue refused at run time (`catalogue.goal_unknown`, …). */
  readonly refused: { readonly code: string; readonly message: string } | null;
  /** Top-level figures first, then nested, in document order; at most `ASK_STORED_FIGURES_PER_CALL`. */
  readonly figures: readonly AskFigure[];
  readonly figures_total: number;
  readonly facts: readonly AskFact[];
  /** The WP 4.2 parameter keys the call read (`inputs.parameters[].key`): what a narration may cite. */
  readonly parameter_keys: readonly string[];
  readonly screen: AskNearestScreen;
}

const HUNDRED = decimal.parseDecimal('100') as decimal.Decimal;

function trimmed(rendered: string): string {
  if (!rendered.includes('.')) return rendered;
  const out = rendered.replace(/0+$/u, '').replace(/\.$/u, '');
  return out === '-0' ? '0' : out;
}

/** `0.0041` → `0.41%`. */
export function percentText(raw: string): string | null {
  const parsed = decimal.parseDecimal(raw);
  if (parsed === null) return null;
  const scaled = decimal.multiply(parsed, HUNDRED);
  if (scaled === null) return null;
  const rendered = decimal.render(scaled, 2);
  return rendered === null ? null : `${trimmed(rendered)}%`;
}

function plural(raw: string, one: string, many: string): string {
  return raw === '1' ? one : many;
}

/** A decimal figure as the app writes it, by unit. */
export function decimalFigureText(raw: string, unit: string): string {
  switch (unit) {
    case 'ratio':
    case 'probability':
      return percentText(raw) ?? raw;
    case 'months':
      return `${raw} ${plural(raw, 'month', 'months')}`;
    case 'years':
      return `${raw} ${plural(raw, 'year', 'years')}`;
    case 'days':
      return `${raw} ${plural(raw, 'day', 'days')}`;
    case 'age':
      return `age ${raw}`;
    case 'factor':
      return `${raw}×`;
    default:
      return raw;
  }
}

function moneyText(money: { readonly minor: string; readonly currency: string }): string {
  const text = formatMoneyJson(money) ?? `${money.minor} minor units`;
  const prefixed = money.currency === 'USD' ? text : `${text} ${money.currency}`;
  return money.minor.startsWith('-') ? `-${prefixed}` : prefixed;
}

const IDENTIFYING_FIELDS = [
  'order',
  'asset_class',
  'class',
  'account_kind',
  'lever',
  'kind',
  'label',
  'name',
  'title',
  'scenario',
];

const ACRONYMS: Readonly<Record<string, string>> = Object.freeze({
  apr: 'APR',
  apy: 'APY',
  ira: 'IRA',
  hsa: 'HSA',
  rmd: 'RMD',
  us: 'US',
});

function words(segment: string): string {
  return segment
    .split('_')
    .map((word) => ACRONYMS[word] ?? word)
    .join(' ');
}

function capitalised(text: string): string {
  return text.length === 0 ? text : `${text[0]?.toUpperCase() ?? ''}${text.slice(1)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

interface Found {
  readonly depth: number;
  readonly order: number;
  readonly figure: AskFigure;
}

function figureOf(record: Record<string, unknown>, key: string, label: string): AskFigure | null {
  const refs = Array.isArray(record['source_refs'])
    ? (record['source_refs'] as unknown[]).filter((ref): ref is string => typeof ref === 'string')
    : [];
  const money = record['money'];
  if (
    isRecord(money) &&
    typeof money['minor'] === 'string' &&
    typeof money['currency'] === 'string'
  ) {
    return {
      key,
      label,
      text: moneyText({ minor: money['minor'], currency: money['currency'] }),
      kind: 'money',
      raw: null,
      source_refs: refs,
    };
  }
  if (typeof record['decimal'] === 'string') {
    const unit = typeof record['unit'] === 'string' ? record['unit'] : 'count';
    return {
      key,
      label,
      text: decimalFigureText(record['decimal'], unit),
      kind: 'decimal',
      raw: record['decimal'],
      source_refs: refs,
    };
  }
  if (typeof record['date'] === 'string') {
    return { key, label, text: record['date'], kind: 'date', raw: null, source_refs: refs };
  }
  return null;
}

/** Walk one result payload for its figures and facts. */
export function figuresAndFactsOf(result: unknown): {
  readonly figures: readonly AskFigure[];
  readonly facts: readonly AskFact[];
} {
  const found: Found[] = [];
  const facts: AskFact[] = [];
  let order = 0;
  const walk = (value: unknown, path: string, labels: readonly string[], depth: number): void => {
    if (typeof value === 'string') {
      if (path.length > 0 && value.length > 0 && value.length <= 160) {
        facts.push({ key: path, text: value });
      }
      return;
    }
    if (Array.isArray(value)) {
      const identities = value.map((inner) =>
        isRecord(inner)
          ? IDENTIFYING_FIELDS.map((field) => inner[field]).find(
              (candidate): candidate is string =>
                typeof candidate === 'string' && candidate.length <= 48,
            )
          : undefined,
      );
      // Two elements with the same identity (two credit cards) keep their position too.
      const repeated = new Set(
        identities.filter(
          (identity, index) => identity !== undefined && identities.indexOf(identity) !== index,
        ),
      );
      value.forEach((inner, index) => {
        const identity = identities[index];
        const label =
          identity === undefined
            ? String(index + 1)
            : repeated.has(identity)
              ? `${words(identity)} ${String(index + 1)}`
              : words(identity);
        walk(inner, `${path}[${String(index)}]`, [...labels, label], depth + 1);
      });
      return;
    }
    if (!isRecord(value)) return;
    if ('source_refs' in value) {
      const figure = figureOf(value, path, capitalised(labels.join(' · ')));
      if (figure !== null) found.push({ depth, order: (order += 1), figure });
      return;
    }
    for (const [key, inner] of Object.entries(value)) {
      walk(inner, path.length === 0 ? key : `${path}.${key}`, [...labels, words(key)], depth + 1);
    }
  };
  walk(result, '', [], 0);
  found.sort((left, right) => left.depth - right.depth || left.order - right.order);
  return { figures: found.map((entry) => entry.figure), facts };
}

function argText(name: string, args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    if (key === 'goal_ref' || key === 'insight_id' || key === 'custom_order') continue;
    if (
      isRecord(value) &&
      typeof value['minor'] === 'string' &&
      typeof value['currency'] === 'string'
    ) {
      const money = moneyText({ minor: value['minor'], currency: value['currency'] });
      parts.push(key === 'extra_monthly' ? `${money} extra a month` : `${words(key)} ${money}`);
      continue;
    }
    if (Array.isArray(value)) {
      parts.push(`${words(key)} ${value.map(String).join(', ')}`);
      continue;
    }
    if (key === 'target_months') {
      parts.push(`target ${String(value)} ${value === 1 ? 'month' : 'months'}`);
      continue;
    }
    if (key === 'account_kind' && typeof value === 'string') {
      parts.push(
        words(value)
          .replace(/\bira\b/u, 'IRA')
          .replace(/\bhsa\b/u, 'HSA'),
      );
      continue;
    }
    if (name === 'plan.project' && key === 'scenario' && value === 'baseline') {
      parts.push('your baseline plan');
      continue;
    }
    if (typeof value === 'string' || typeof value === 'number') parts.push(String(value));
  }
  return parts.join(', ');
}

/** "emergency-fund cover (target 3 months)". */
export function askCallLabel(name: CatalogueFunctionName, args: Record<string, unknown>): string {
  // `?? name`: a context result that is not a catalogue call (WP 11.5e's `finding.evidence`) has no label here.
  const base = ASK_FUNCTION_LABELS[name] ?? String(name);
  const detail = argText(name, args);
  return detail.length === 0 ? base : `${base} (${detail})`;
}

/** The view of one call that answered (ok or not available). */
export function askResultViewOf(
  name: CatalogueFunctionName,
  args: Record<string, unknown>,
  envelope: CatalogueResult,
): AskResultView {
  const { figures, facts } =
    envelope.status === 'ok' ? figuresAndFactsOf(envelope.result) : { figures: [], facts: [] };
  return {
    function: name,
    label: askCallLabel(name, args),
    args,
    status: envelope.status,
    as_of: envelope.as_of,
    scopes: [...envelope.scopes],
    input_digest: envelope.input_digest,
    result_digest: `sha256:${configHash(envelope as unknown as Record<string, unknown>)}`,
    not_available: envelope.not_available,
    refused: null,
    figures: figures.slice(0, ASK_STORED_FIGURES_PER_CALL),
    figures_total: figures.length,
    facts: facts.slice(0, 64),
    parameter_keys: parameterKeysOf(envelope.inputs),
    screen: ASK_FUNCTION_SCREENS[name],
  };
}

function parameterKeysOf(inputs: Readonly<Record<string, unknown>>): readonly string[] {
  const list = inputs['parameters'];
  if (!Array.isArray(list)) return [];
  return [
    ...new Set(
      list.flatMap((entry) =>
        isRecord(entry) && typeof entry['key'] === 'string' ? [entry['key']] : [],
      ),
    ),
  ];
}

/** The view of a call the catalogue refused when it ran (an unknown goal, a tax year not held). */
export function askRefusedViewOf(
  name: CatalogueFunctionName,
  args: Record<string, unknown>,
  refusal: { readonly code: string; readonly message: string },
): AskResultView {
  return {
    function: name,
    label: askCallLabel(name, args),
    args,
    status: 'refused',
    as_of: null,
    scopes: [],
    input_digest: null,
    result_digest: null,
    not_available: null,
    refused: { code: refusal.code, message: refusal.message.slice(0, 300) },
    figures: [],
    figures_total: 0,
    facts: [],
    parameter_keys: [],
    screen: ASK_FUNCTION_SCREENS[name],
  };
}

/**
 * "I looked at: emergency-fund cover (target 3 months), debt payoff plan
 * (avalanche, $400.00 extra a month), as of 2026-10-28." Built by the app from
 * the calls it ran; a model never writes it.
 */
export function askLookedAtLine(results: readonly AskResultView[]): string {
  if (results.length === 0) return 'I looked at nothing: no calculation answered this question.';
  const asOf = results.find((result) => result.as_of !== null)?.as_of ?? null;
  return `I looked at: ${results.map((result) => result.label).join('; ')}${
    asOf === null ? '' : `, as of ${asOf}`
  }.`;
}

/**
 * The arithmetic without the prose (12 §4: "the draft didn't pass the checks;
 * here is the arithmetic without the prose") — one block per call, its figures
 * as label/value rows. What stands whenever a narration is refused, failed or
 * withheld: never nothing.
 */
export function askFallbackRendering(results: readonly AskResultView[]): readonly {
  readonly heading: string;
  readonly rows: readonly { readonly label: string; readonly value: string }[];
  readonly note: string | null;
}[] {
  return results.map((result) => ({
    heading: capitalised(result.label),
    rows: result.figures.map((figure) => ({ label: figure.label, value: figure.text })),
    note:
      result.status === 'not_available'
        ? (result.not_available?.reason ?? 'Not available.')
        : result.status === 'refused'
          ? 'This calculation could not run for what was asked.'
          : result.figures_total > result.figures.length
            ? `${String(result.figures_total - result.figures.length)} more figures are on the screen this comes from.`
            : null,
  }));
}
