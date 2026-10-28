// SPDX-License-Identifier: MIT
/**
 * The `brief.narrate` request: the one constructor of what is shown in the
 * payload preview, retained for the run inspector, digested into
 * `advisor_runs.input_digest`, and sent to the model.
 *
 * ## What a Brief composition is sent, and nothing else
 *
 *   * **The week's figures the Brief already carries** — its overview blocks
 *     as `GET /insights/brief/*` serves them (`apps/api/src/blocks/brief.ts`):
 *     the week label, the count of ranked actions and of items needing
 *     attention, the health score line ("72.5 / 100", or none), and the
 *     newest three net-worth milestones (label, round value, date). The
 *     composition root reads them **from the blocks**, so every figure here is
 *     one a block shows.
 *   * **The ranked items, in the Brief's order** (by the dollar impact the
 *     Brief computed, the largest first; at most five): each item's title, its
 *     wording — the per-item narration the narrator already wrote and the
 *     validator already passed, when the deployment shows narration text, else
 *     the built-in's deterministic summary — its headline figure as the card
 *     prints it ("$840.00 a year", "$1,200.00 one-time", or none) and whether
 *     the Brief carried it from last week. Goal names lose their digits
 *     exactly as the narrator's envelope loses them (`redactFreeText`).
 *   * **Last week's outcomes, as counts**: of the previous Brief's items, how
 *     many the holder accepted, how many dismissed, and how many this Brief
 *     carried. Never a previous item's title — a composition may name only
 *     the items this Brief chose (G5-15).
 *
 * No id (no insight, Brief or account id), no evidence row, no severity, no
 * score factor, no account or institution name. `granted_scopes` is the
 * union of the items' own source runs' `emitted_scopes`, catalogue order.
 *
 * ## The figures a reply may use
 *
 * `briefNarrateTraceContext` is the narrow trace (`validate/numerals.ts`'s
 * `FindingTraceContext`) over **the union of the Brief's figures and the
 * item figures — nothing else**: the counts, the score line, the milestone
 * values, each item's headline figure, last week's counts. The week label and
 * the milestone dates are quoted whole, never mined for a figure. Item titles
 * and wordings are prose a reply may quote whole (clause by clause), never a
 * source of a figure (F-1): a figure that appears only inside a summary is
 * not a figure this composition may state.
 */
import { newId, type MoneyJson } from '@core/kernel';
import { ADVISOR_SCOPES, type AdvisorScope } from '../../contract/scopes.ts';
import { canonicalRunDigest } from '../../preview.ts';
import {
  extractNumerals,
  maskLiterals,
  stripUrls,
  type FindingTraceContext,
} from '../../validate/numerals.ts';
import { redactFreeText, type FindingSource } from '../local/findings.ts';
import { formatMoneyJson } from '../support.ts';
import {
  BRIEF_NARRATE_MAX_ITEMS,
  BRIEF_NARRATE_MAX_MILESTONES,
  BRIEF_NARRATE_SCOPES,
} from './manifest.ts';

export interface BriefNarrateItem {
  readonly title: string;
  readonly wording: string;
  readonly figure: string | null;
  readonly carried: boolean;
}

export interface BriefNarrateMilestone {
  readonly label: string;
  readonly value: string;
  readonly on: string;
}

export interface BriefNarrateLastWeek {
  readonly accepted: string;
  readonly dismissed: string;
  readonly carried: string;
}

/** Structurally `@advisor/local-model`'s `BriefNarrateSubject`. */
export interface BriefNarrateSubject {
  readonly week: string;
  readonly ranked_count: string;
  readonly attention_count: string;
  readonly health_score: string | null;
  readonly milestones: readonly BriefNarrateMilestone[];
  readonly items: readonly BriefNarrateItem[];
  readonly last_week: BriefNarrateLastWeek | null;
}

/** The wire request the brief-narrate adapter renders (structurally its `BriefNarrateRequest`). */
export interface BriefNarrateWireRequest {
  readonly request_id: string;
  readonly subject: BriefNarrateSubject;
  readonly deadline: string;
  readonly max_response_bytes: number;
}

/** What the run inspector retains and re-digests. */
export interface BriefNarratePayload {
  readonly snapshot: { readonly brief: BriefNarrateSubject };
  readonly granted_scopes: readonly string[];
}

/** The overview's figures, as the composition root read them from the Brief's blocks. */
export interface BriefWeekFigures {
  readonly week: string;
  readonly rankedCount: string;
  readonly attentionCount: string;
  /** The health card's value as the block writes it ("72.5 / 100"), or `null` when withheld. */
  readonly healthScore: string | null;
  readonly milestones: readonly BriefNarrateMilestone[];
}

/** One ranked Brief item as stored and served, with its source run's scopes. */
export interface BriefNarrateItemSource {
  readonly title: string;
  readonly summaryMd: string;
  /** The per-item narration's text, when one is live and the deployment shows narration text; else `null`. */
  readonly narrationText: string | null;
  readonly annualizedImpact: MoneyJson | null;
  readonly oneTimeImpact: MoneyJson | null;
  readonly carried: boolean;
  /** The item's stored evidence (for the goal-name redaction only; never sent). */
  readonly evidence: readonly {
    readonly label: string;
    readonly value: string | null;
    readonly sourceRef: string | null;
    readonly resolvedDisplay: string | null;
  }[];
  /** The item's source run's `emitted_scopes`, or `null` when no source run is on record (left out, fail closed). */
  readonly scopes: readonly string[] | null;
}

export interface BriefOutcomeCounts {
  readonly accepted: number;
  readonly dismissed: number;
  readonly carried: number;
}

/** One Brief, ready to narrate: its subject, its scopes and what the validator checks against. */
export interface BriefNarrateTarget {
  /** Never sent to a model. */
  readonly briefId: string;
  readonly isoWeek: string;
  readonly subject: BriefNarrateSubject;
  /** The union of the included items' source-run scopes, catalogue order. */
  readonly scopes: readonly AdvisorScope[];
  /** Titles of the holder's other live findings the Brief did not choose. Never sent; the G5-15 check. */
  readonly foreignTitles: readonly string[];
  /** Ranked items left out because their scopes were outside the ceiling (or unknown). */
  readonly omitted: number;
}

/** What `validateBriefNarrateReply` checks a reply against. */
export interface BriefNarrateCheck {
  readonly trace: FindingTraceContext;
  /** The titles sent, in the Brief's order. */
  readonly chosenTitles: readonly string[];
  /** Titles a reply may never name (G5-15). */
  readonly foreignTitles: readonly string[];
}

export interface BuiltBriefNarrateRequest {
  readonly request: BriefNarrateWireRequest;
  readonly payload: BriefNarratePayload;
  /** `canonicalRunDigest(payload)`: `advisor_runs.input_digest` and `brief_narrations.input_digest`. */
  readonly digest: string;
  readonly check: BriefNarrateCheck;
}

/** A card's headline figure in words: the yearly figure when it claims one, else the one-time, else none. */
export function briefItemFigureOf(item: {
  readonly annualizedImpact: MoneyJson | null;
  readonly oneTimeImpact: MoneyJson | null;
}): string | null {
  if (item.annualizedImpact !== null) {
    const money = formatMoneyJson(absolute(item.annualizedImpact));
    return money === null ? null : `${money} a year`;
  }
  if (item.oneTimeImpact !== null) {
    const money = formatMoneyJson(absolute(item.oneTimeImpact));
    return money === null ? null : `${money} one-time`;
  }
  return null;
}

/** A money figure as the Brief prints it (`$100,000.00`): a milestone's value, an item's headline figure. */
export function briefMoneyText(money: MoneyJson): string | null {
  return formatMoneyJson(absolute(money));
}

function absolute(money: MoneyJson): MoneyJson {
  return money.minor.startsWith('-') ? { ...money, minor: money.minor.slice(1) } : money;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/**
 * The Brief's deterministic opening — what the "This week's Brief" header
 * says whatever any model says, and what stands when a composition is
 * refused or unavailable (07 §7.5 rule 1). Built from the served Brief only:
 * the counts and the first ranked item's title and headline figure. No model,
 * no figure the Brief does not already print.
 */
export function briefOpeningOf(input: {
  readonly nothingMaterial: boolean;
  readonly ranked: readonly {
    readonly title: string;
    readonly annualizedImpact: MoneyJson | null;
    readonly oneTimeImpact: MoneyJson | null;
  }[];
  readonly attentionCount: number;
}): string {
  const ranked = input.ranked.slice(0, BRIEF_NARRATE_MAX_ITEMS);
  const attention =
    input.attentionCount === 0
      ? ''
      : ` ${String(input.attentionCount)} ${plural(input.attentionCount, 'item needs', 'items need')} attention.`;
  const top = ranked[0];
  if (input.nothingMaterial || top === undefined) {
    return `No ranked actions this week.${attention}`;
  }
  const figure = briefItemFigureOf(top);
  return (
    `${String(ranked.length)} ranked ${plural(ranked.length, 'action', 'actions')} this week, ` +
    `in order of dollar impact. ${ranked.length === 1 ? 'It is' : 'The largest is'} “${top.title}”` +
    `${figure === null ? '' : `, ${figure}`}.${attention}`
  );
}

/** Catalogue order, and only scopes the contract knows. */
function catalogueOrder(scopes: Iterable<string>): AdvisorScope[] {
  const wanted = new Set(scopes);
  return ADVISOR_SCOPES.filter((scope) => wanted.has(scope));
}

/** The item through the narrator's own goal-name redaction (a goal name's digits never reach a model). */
function redactedItem(source: BriefNarrateItemSource): { title: string; wording: string } {
  const finding: FindingSource = {
    key: '',
    period: '',
    type: '',
    severity: 'info',
    title: source.title,
    summaryMd: source.narrationText ?? source.summaryMd,
    evidence: source.evidence.map((row) => ({
      label: row.label,
      value: row.value,
      sourceRef: row.sourceRef,
      resolvedDisplay: row.resolvedDisplay,
    })),
    derived: [],
    impact: { annualized: null, oneTime: null, basis: '' },
  };
  const redacted = redactFreeText(finding, 'local_model');
  return { title: redacted.title, wording: redacted.summaryMd };
}

/**
 * Build the target. `allowedScopes` is the ceiling the composition root
 * computed (the narrator's live grant ∩ `BRIEF_NARRATE_SCOPES`): an item whose
 * source scopes are unknown or not all inside it is left out — it could never
 * be sent — and counted in `omitted`.
 */
export function briefNarrateTargetOf(input: {
  readonly briefId: string;
  readonly isoWeek: string;
  readonly week: BriefWeekFigures;
  /** The Brief's ranked items, in its order. */
  readonly ranked: readonly BriefNarrateItemSource[];
  readonly lastWeek: BriefOutcomeCounts | null;
  readonly allowedScopes: readonly string[];
  readonly foreignTitles: readonly string[];
}): BriefNarrateTarget {
  const allowed = new Set(input.allowedScopes);
  const bound = new Set<string>(BRIEF_NARRATE_SCOPES);
  const scopes = new Set<string>();
  const items: BriefNarrateItem[] = [];
  let omitted = 0;
  for (const source of input.ranked.slice(0, BRIEF_NARRATE_MAX_ITEMS)) {
    const own = source.scopes;
    if (own === null || own.some((scope) => !allowed.has(scope) || !bound.has(scope))) {
      omitted += 1;
      continue;
    }
    for (const scope of own) scopes.add(scope);
    const words = redactedItem(source);
    items.push({
      title: words.title,
      wording: words.wording,
      figure: briefItemFigureOf(source),
      carried: source.carried,
    });
  }
  // A foreign title the sent text already contains (a chosen title or wording
  // quoting it) cannot be told apart from a quotation of what was sent: it is
  // not a G5-15 signal, so it is not held against a reply.
  const sent = items.flatMap((item) => [normaliseTitle(item.title), normaliseTitle(item.wording)]);
  const chosen = new Set(items.map((item) => normaliseTitle(item.title)));
  return {
    briefId: input.briefId,
    isoWeek: input.isoWeek,
    subject: {
      week: input.week.week,
      ranked_count: input.week.rankedCount,
      attention_count: input.week.attentionCount,
      health_score: input.week.healthScore,
      milestones: input.week.milestones.slice(0, BRIEF_NARRATE_MAX_MILESTONES).map((row) => ({
        label: row.label,
        value: row.value,
        on: row.on,
      })),
      items,
      last_week:
        input.lastWeek === null
          ? null
          : {
              accepted: String(input.lastWeek.accepted),
              dismissed: String(input.lastWeek.dismissed),
              carried: String(input.lastWeek.carried),
            },
    },
    scopes: catalogueOrder(scopes),
    foreignTitles: [
      ...new Set(
        input.foreignTitles.filter(
          (title) =>
            title.trim().length >= 3 &&
            !chosen.has(normaliseTitle(title)) &&
            !sent.some((text) => text.includes(normaliseTitle(title))),
        ),
      ),
    ],
    omitted,
  };
}

/** Case and whitespace folded; the form a title is matched in. */
export function normaliseTitle(title: string): string {
  return title.replace(/\s+/gu, ' ').trim().toLowerCase();
}

/** A fresh subject with only the declared fields: a property a caller adds cannot ride along. */
function canonicalSubject(subject: BriefNarrateSubject): BriefNarrateSubject {
  return {
    week: subject.week,
    ranked_count: subject.ranked_count,
    attention_count: subject.attention_count,
    health_score: subject.health_score,
    milestones: subject.milestones.map((row) => ({
      label: row.label,
      value: row.value,
      on: row.on,
    })),
    items: subject.items.map((item) => ({
      title: item.title,
      wording: item.wording,
      figure: item.figure,
      carried: item.carried,
    })),
    last_week:
      subject.last_week === null
        ? null
        : {
            accepted: subject.last_week.accepted,
            dismissed: subject.last_week.dismissed,
            carried: subject.last_week.carried,
          },
  };
}

export function buildBriefNarrateRequest(input: {
  readonly target: BriefNarrateTarget;
  readonly now: Date;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}): BuiltBriefNarrateRequest {
  const subject = canonicalSubject(input.target.subject);
  const payload: BriefNarratePayload = {
    snapshot: { brief: subject },
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
    check: {
      trace: briefNarrateTraceContext(subject),
      chosenTitles: subject.items.map((item) => item.title),
      foreignTitles: [...input.target.foreignTitles],
    },
  };
}

/** Dates and `MERCHANT_…`-style pseudonyms are quoted whole, never mined for figures. */
const DATE_TOKEN = /\b\d{4}-\d{2}(?:-\d{2})?\b/g;
const PSEUDONYM_TOKEN = /\b[A-Z]{2,}_[0-9A-Za-z]{6,}\b/g;

/**
 * The narrow trace over one Brief composition: the figures a reply may write
 * (the Brief's and the items' headline figures, as written), the literals
 * masked whole first (the week label, the milestone dates and labels), and the
 * prose a reply may quote whole (titles and wordings — never mined).
 */
export function briefNarrateTraceContext(subject: BriefNarrateSubject): FindingTraceContext {
  const figureTexts: string[] = [subject.ranked_count, subject.attention_count];
  if (subject.health_score !== null) figureTexts.push(subject.health_score);
  const literals = new Set<string>([subject.week]);
  for (const row of subject.milestones) {
    figureTexts.push(row.value);
    literals.add(row.on);
    literals.add(row.label);
  }
  for (const item of subject.items) {
    if (item.figure !== null) figureTexts.push(item.figure);
  }
  if (subject.last_week !== null) {
    figureTexts.push(
      subject.last_week.accepted,
      subject.last_week.dismissed,
      subject.last_week.carried,
    );
  }
  const prose = subject.items
    .flatMap((item) => [item.title, item.wording])
    .filter((text) => text.length >= 3);
  const tokens = new Set<string>();
  for (const text of [...figureTexts, ...prose, ...literals]) {
    for (const match of text.matchAll(DATE_TOKEN)) tokens.add(match[0]);
    for (const match of text.matchAll(PSEUDONYM_TOKEN)) tokens.add(match[0]);
  }
  const tokenList = [...tokens, subject.week].sort((left, right) => right.length - left.length);
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
    prose,
  };
}
