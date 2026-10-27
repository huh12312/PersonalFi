// SPDX-License-Identifier: MIT
/**
 * The `insight.explain` request: the one constructor of what is shown in the
 * payload preview, retained for the run inspector, digested into the cache
 * key, and sent to the model.
 *
 * ## An insight: the narrator's own envelope, quoted
 *
 * The subject is built from the narrator's `FindingSource` through the
 * narrator's own minimisation — `redactFreeText` (a goal name's digits never
 * reach a model) and `narratedFindingOf(…, 'quoted')` (every evidence value
 * printed exactly as the evidence panel shows it, the impact as the card
 * prints it) — then re-shaped through an explicit field list: the rule's
 * catalogue name and plain-English purpose, the title, the summary, the
 * figures (per year, one time, the basis in words) and the evidence rows
 * (label, value, source ref). Nothing else: no insight id, no key, no
 * severity, no derivation, no account or institution name (no snapshot block
 * a built-in reads carries one), and a property a caller adds to an object
 * cannot ride along. `granted_scopes` is the insight's own source run's
 * `emitted_scopes` — never the manifest's list.
 *
 * ## A health pillar: what its card and detail already show
 *
 * The pillar's name and meaning, its figure, its score out of 100, its band,
 * the scoring ladder in words (worst first, from `HEALTH_BAND_THRESHOLDS`,
 * the words `/health/:pillar` prints), the next band and its edge, and the
 * "Built from" inputs with their values. The inputs are `pillars.ts`'s, whose
 * labels are fixed strings (no account name, no institution name). The scopes
 * are the snapshot blocks the pillar's score reads (`PILLAR_SCOPES`).
 *
 * ## The figures a reply may use
 *
 * `explainTraceContext` is the narrow trace (`validate/numerals.ts`'s
 * `FindingTraceContext`) over **this subject only**: a figure in the reply is
 * accepted only when it is, as written, one of the evidence values or the
 * entity's own figures (an insight's per-year and one-time impact; a pillar's
 * figure, score, ladder edges and inputs). The subject's prose — the rule
 * text, the title, the summary, the impact basis, a pillar's meaning and
 * ladder lines — may be quoted whole, never mined for a figure (F-1).
 */
import { newId, type MoneyJson } from '@core/kernel';
import type { AdvisorScope } from '../../contract/scopes.ts';
import { canonicalRunDigest } from '../../preview.ts';
import {
  extractNumerals,
  maskLiterals,
  stripUrls,
  type FindingTraceContext,
} from '../../validate/numerals.ts';
import { narratedFindingOf, redactFreeText, type FindingSource } from '../local/findings.ts';
import { formatMoneyJson } from '../support.ts';
import {
  HEALTH_BAND_THRESHOLDS,
  type HealthBand,
  type HealthComponentId,
} from '../../health/thresholds.ts';
import type { HealthPillar, PillarInput } from '../../health/pillars.ts';

/** At most this many evidence rows and pillar inputs are sent (the adapter refuses more). */
export const EXPLAIN_MAX_EVIDENCE_ROWS = 32;
export const EXPLAIN_MAX_PILLAR_INPUTS = 16;

export type ExplainEntityKind = 'insight' | 'health_pillar';

export interface ExplainEvidenceRow {
  readonly label: string;
  readonly value: string | null;
  readonly source_ref: string | null;
}

export interface ExplainInsightSubject {
  readonly entity_kind: 'insight';
  readonly rule: { readonly name: string; readonly text: string };
  readonly title: string;
  readonly summary: string;
  readonly figures: {
    readonly per_year: string | null;
    readonly one_time: string | null;
    readonly basis: string;
  };
  readonly evidence: readonly ExplainEvidenceRow[];
}

export interface ExplainPillarDatum {
  readonly label: string;
  readonly value: string;
}

export interface ExplainPillarSubject {
  readonly entity_kind: 'health_pillar';
  readonly pillar: { readonly name: string; readonly meaning: string };
  readonly value: string;
  readonly score: string;
  readonly band: string;
  readonly ladder: readonly string[];
  readonly next_band: { readonly band: string; readonly edge: string } | null;
  readonly built_from: readonly ExplainPillarDatum[];
}

export type ExplainSubject = ExplainInsightSubject | ExplainPillarSubject;

/** The wire request `@advisor/local-model`'s explain adapter renders (structurally its `ExplainRequest`). */
export interface ExplainWireRequest {
  readonly request_id: string;
  readonly subject: ExplainSubject;
  readonly deadline: string;
  readonly max_response_bytes: number;
}

/** What the run inspector retains and re-digests, and what the cache is keyed by. */
export interface ExplainPayload {
  readonly snapshot: { readonly explain: ExplainSubject };
  readonly granted_scopes: readonly string[];
}

/** One entity, ready to explain: its subject, its scopes and the figures a reply may use. */
export interface ExplainTarget {
  readonly entityKind: ExplainEntityKind;
  /** The insight's id, or the pillar's component id. Never sent to a model. */
  readonly entityId: string;
  readonly subject: ExplainSubject;
  /** Exactly the scopes the entity was built from, catalogue order. */
  readonly scopes: readonly AdvisorScope[];
}

export interface BuiltExplainRequest {
  readonly request: ExplainWireRequest;
  readonly payload: ExplainPayload;
  /** `canonicalRunDigest(payload)`: `advisor_runs.input_digest` and the cache's evidence digest. */
  readonly digest: string;
  readonly trace: FindingTraceContext;
}

// ---------------------------------------------------------------------------
// An insight
// ---------------------------------------------------------------------------

/** The catalogue's plain words for the rule that made the insight. */
export interface RuleText {
  readonly name: string;
  readonly text: string;
}

/** The insight subject, through the narrator's own minimisation, then an explicit field list. */
export function insightSubjectOf(source: FindingSource, rule: RuleText): ExplainInsightSubject {
  const finding = narratedFindingOf(redactFreeText(source, 'local_model'), 'quoted');
  return {
    entity_kind: 'insight',
    rule: { name: String(rule.name), text: String(rule.text) },
    title: finding.title,
    summary: finding.summary_md,
    figures: {
      per_year: finding.impact.annualized,
      one_time: finding.impact.one_time,
      basis: finding.impact.basis,
    },
    evidence: finding.evidence.slice(0, EXPLAIN_MAX_EVIDENCE_ROWS).map((row) => ({
      label: row.label,
      value: row.value,
      source_ref: row.source_ref,
    })),
  };
}

// ---------------------------------------------------------------------------
// A health pillar
// ---------------------------------------------------------------------------

export const PILLAR_NAMES: Readonly<Record<HealthComponentId, string>> = Object.freeze({
  emergency_fund_months: 'Emergency fund',
  savings_rate: 'Savings rate',
  debt_to_income: 'Debt-to-income',
  subscription_load: 'Subscription load',
  diversification: 'Diversification',
  fee_drag: 'Fee drag',
});

/** The one-line meaning each pillar card prints (the web's `PILLAR_MEANING`, same words). */
export const PILLAR_MEANINGS: Readonly<Record<HealthComponentId, string>> = Object.freeze({
  emergency_fund_months: 'How many months your cash would cover your spending.',
  savings_rate: 'The share of your income you keep.',
  debt_to_income: 'Minimum debt payments as a share of your monthly income.',
  subscription_load: 'What subscriptions cost a year, as a share of take-home pay.',
  diversification: 'How much of your investments sits in your largest single holding.',
  fee_drag: 'Avoidable fees and fund costs over a year.',
});

/** The snapshot blocks each pillar's score and inputs read (`health/score.ts`, `health/pillars.ts`). */
export const PILLAR_SCOPES: Readonly<Record<HealthComponentId, readonly AdvisorScope[]>> =
  Object.freeze({
    emergency_fund_months: ['cash.summary', 'cashflow.monthly'],
    savings_rate: ['cashflow.monthly', 'plan.projection'],
    debt_to_income: ['cashflow.monthly', 'liabilities.terms'],
    subscription_load: ['cashflow.monthly', 'recurring.list'],
    diversification: ['holdings.aggregate'],
    fee_drag: ['fees.summary'],
  });

const BAND_LABEL: Readonly<Record<HealthBand, string>> = Object.freeze({
  poor: 'Poor',
  fair: 'Fair',
  good: 'Good',
  excellent: 'Excellent',
});

const BANDS_UP: readonly HealthBand[] = ['poor', 'fair', 'good', 'excellent'];

function moneyText(value: MoneyJson): string {
  return formatMoneyJson(value) ?? `${value.minor} minor units`;
}

/** `'0.125'` → `'12.5%'` (one decimal, as the pillar card prints a ratio). */
function ratioText(value: string): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${(parsed * 100).toFixed(1)}%` : value;
}

function monthsText(value: string): string {
  return `${value} ${value === '1' ? 'month' : 'months'}`;
}

/** An edge in the metric's unit, as `/health/:pillar`'s ladder prints it: `'0.15'` → `'15%'`. */
function edgeText(component: HealthComponentId, edge: string): string {
  const unit = HEALTH_BAND_THRESHOLDS[component].unit;
  if (unit === 'usd_per_year') {
    // Dollars as the rule states them, by string: `'50.00'` → `$50`, `'25.5'` → `$25.50`.
    const [whole = '0', fraction = ''] = edge.split('.');
    const dollars = /^0*$/u.test(fraction)
      ? `$${whole}`
      : `$${whole}.${fraction.padEnd(2, '0').slice(0, 2)}`;
    return `${dollars} a year`;
  }
  const value = Number(edge);
  if (unit === 'months') return `${String(value)} month${value === 1 ? '' : 's'}`;
  return `${String(Math.round(value * 1000) / 10)}%`;
}

function pillarValueText(component: HealthComponentId, value: string | MoneyJson): string {
  if (typeof value === 'object') return `${moneyText(value)} a year`;
  return HEALTH_BAND_THRESHOLDS[component].unit === 'months' ? monthsText(value) : ratioText(value);
}

function inputText(input: PillarInput): string {
  if (typeof input.value === 'object') return moneyText(input.value);
  switch (input.kind) {
    case 'months':
      return monthsText(input.value);
    case 'ratio':
      return ratioText(input.value);
    default:
      return String(input.value);
  }
}

/** The ladder in words, worst band first: "Poor: under 1 month", "Fair: 1 month to under 3 months", … */
export function pillarLadder(component: HealthComponentId): readonly string[] {
  const definition = HEALTH_BAND_THRESHOLDS[component];
  const [b1, b2, b3] = definition.boundaries.map((boundary) => edgeText(component, boundary.value));
  const ranges = [
    `under ${String(b1)}`,
    `${String(b1)} to under ${String(b2)}`,
    `${String(b2)} to under ${String(b3)}`,
    `${String(b3)} or more`,
  ];
  // Ascending by value: higher-is-better reads poor→excellent, lower-is-better excellent→poor.
  const ascending = definition.higherIsBetter ? BANDS_UP : [...BANDS_UP].reverse();
  const steps = ascending.map((band, index) => `${BAND_LABEL[band]}: ${ranges[index] ?? ''}`);
  return definition.higherIsBetter ? steps : [...steps].reverse();
}

/** The next better band and the edge that separates it from this one; `null` at excellent. */
export function nextBandOf(
  component: HealthComponentId,
  band: HealthBand,
): { readonly band: string; readonly edge: string } | null {
  if (band === 'excellent') return null;
  const definition = HEALTH_BAND_THRESHOLDS[component];
  const [b1, b2, b3] = definition.boundaries.map((boundary) => boundary.value);
  const edge = definition.higherIsBetter
    ? { poor: b1, fair: b2, good: b3 }[band]
    : { poor: b3, fair: b2, good: b1 }[band];
  const next = BANDS_UP[BANDS_UP.indexOf(band) + 1] ?? 'excellent';
  return { band: BAND_LABEL[next], edge: edgeText(component, edge ?? '0') };
}

/** A scored pillar's subject. A withheld pillar has nothing to explain: it says why on its card. */
export function pillarSubjectOf(
  pillar: Extract<HealthPillar, { status: 'scored' }>,
): ExplainPillarSubject {
  const component = pillar.component;
  return {
    entity_kind: 'health_pillar',
    pillar: { name: PILLAR_NAMES[component], meaning: PILLAR_MEANINGS[component] },
    value: pillarValueText(component, pillar.value),
    score: `${String(pillar.score)} out of 100`,
    band: BAND_LABEL[pillar.band],
    ladder: pillarLadder(component),
    next_band: nextBandOf(component, pillar.band),
    built_from: pillar.inputs.slice(0, EXPLAIN_MAX_PILLAR_INPUTS).map((input) => ({
      label: String(input.label),
      value: inputText(input),
    })),
  };
}

// ---------------------------------------------------------------------------
// The request, its digest, and the figures a reply may use
// ---------------------------------------------------------------------------

/** Field-listed again here, so a subject object carrying more than its type cannot ride along. */
function canonicalSubject(subject: ExplainSubject): ExplainSubject {
  if (subject.entity_kind === 'insight') {
    return {
      entity_kind: 'insight',
      rule: { name: subject.rule.name, text: subject.rule.text },
      title: subject.title,
      summary: subject.summary,
      figures: {
        per_year: subject.figures.per_year,
        one_time: subject.figures.one_time,
        basis: subject.figures.basis,
      },
      evidence: subject.evidence.map((row) => ({
        label: row.label,
        value: row.value,
        source_ref: row.source_ref,
      })),
    };
  }
  return {
    entity_kind: 'health_pillar',
    pillar: { name: subject.pillar.name, meaning: subject.pillar.meaning },
    value: subject.value,
    score: subject.score,
    band: subject.band,
    ladder: [...subject.ladder],
    next_band:
      subject.next_band === null
        ? null
        : { band: subject.next_band.band, edge: subject.next_band.edge },
    built_from: subject.built_from.map((row) => ({ label: row.label, value: row.value })),
  };
}

export function buildExplainRequest(input: {
  readonly target: ExplainTarget;
  readonly now: Date;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}): BuiltExplainRequest {
  const subject = canonicalSubject(input.target.subject);
  const payload: ExplainPayload = {
    snapshot: { explain: subject },
    granted_scopes: [...input.target.scopes],
  };
  return {
    request: {
      request_id: newId(),
      subject,
      deadline: new Date(input.now.getTime() + input.timeoutMs).toISOString(),
      max_response_bytes: input.maxResponseBytes,
    },
    payload,
    digest: canonicalRunDigest(payload),
    trace: explainTraceContext(subject),
  };
}

/** Dates, months and `MERCHANT_…`-style pseudonyms are quoted whole, never mined for figures. */
const DATE_TOKEN = /\b\d{4}-\d{2}(?:-\d{2})?\b/g;
const PSEUDONYM_TOKEN = /\b[A-Z]{2,}_[0-9A-Za-z]{6,}\b/g;

/**
 * The narrow trace over one subject: the figures a reply may write (as
 * written), the literals masked whole first, and the prose a reply may quote
 * whole. Pure; the validator, the red team and the self-test all use it.
 */
export function explainTraceContext(subject: ExplainSubject): FindingTraceContext {
  const figureTexts: string[] = [];
  const prose: string[] = [];
  const literals = new Set<string>();
  if (subject.entity_kind === 'insight') {
    for (const row of subject.evidence) {
      if (row.value !== null) figureTexts.push(row.value);
      literals.add(row.label);
      if (row.source_ref !== null) literals.add(row.source_ref);
    }
    if (subject.figures.per_year !== null) figureTexts.push(subject.figures.per_year);
    if (subject.figures.one_time !== null) figureTexts.push(subject.figures.one_time);
    prose.push(
      subject.rule.name,
      subject.rule.text,
      subject.title,
      subject.summary,
      subject.figures.basis,
    );
  } else {
    figureTexts.push(subject.value, subject.score, ...subject.ladder);
    if (subject.next_band !== null) figureTexts.push(subject.next_band.edge);
    for (const row of subject.built_from) {
      figureTexts.push(row.value);
      literals.add(row.label);
    }
    prose.push(subject.pillar.name, subject.pillar.meaning, ...subject.ladder);
  }
  const quotable = prose.filter((text) => text.length >= 3);
  const tokens = new Set<string>();
  for (const text of [...figureTexts, ...quotable]) {
    for (const match of text.matchAll(DATE_TOKEN)) tokens.add(match[0]);
    for (const match of text.matchAll(PSEUDONYM_TOKEN)) tokens.add(match[0]);
  }
  const tokenList = [...tokens].sort((left, right) => right.length - left.length);
  const figures = new Set<string>();
  for (const text of figureTexts) {
    const masked = maskLiterals(stripUrls(text), tokenList);
    for (const numeral of extractNumerals(masked)) {
      figures.add(numeral.isPercent ? `${numeral.normalized}%` : numeral.normalized);
    }
  }
  for (const token of tokenList) literals.add(token);
  return {
    figures,
    literals: [...literals]
      .filter((literal) => literal.length > 0)
      .sort((left, right) => right.length - left.length)
      .slice(0, 512),
    prose: quotable,
  };
}
