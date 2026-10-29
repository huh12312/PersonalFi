// SPDX-License-Identifier: MIT
/**
 * "Talk this through" (WP 11.5e; 12 §6 row 11.5e): an advisor session opened
 * from a finding, **pre-gathered** on it. Deterministic throughout: no model
 * writes anything here.
 *
 *   * **The question** is built from the finding by a template per rule family
 *     (`TALK_THROUGH_QUESTIONS`): the finding's title, quoted, and its rule's
 *     name. Never model text. It then goes through the same pre-check as a
 *     typed question (an instruction smuggled into a title — a goal name, say —
 *     is refused before any model is asked).
 *   * **The seeded calls** (`seededCallsFor`): the catalogue functions that
 *     answer the finding's rule (`TALK_THROUGH_RULES`), parsed through each
 *     function's own schema exactly as a compiled call is. The gather step's
 *     compiler still runs; the seeded calls are always included
 *     (`mergeSeededCalls`), and a compiled call identical to a seeded one is
 *     not run twice.
 *   * **The finding's own figures** join the context object as a result
 *     (`findingResultOf`, function `finding.evidence`): each an evidence row the
 *     validator resolved when the built-in wrote it (`insight_evidence.
 *     resolved_display`), its `source_ref` kept beside it, its text the app's
 *     own rendering of that value. A row that is not a figure (a name, a goal,
 *     a date range in words), whose ref is not a snapshot path, or that did not
 *     resolve, never enters (`findingEvidenceFigures`, with the reason).
 *   * **The quoted fact** the clarify step receives: the title and the rule's
 *     words, which a restatement may quote whole and is never mined for a
 *     figure (`clarify.ts`).
 */
import { and, eq } from 'drizzle-orm';
import { advisorRuns, insightEvidence, insights } from '../../../schema/index.ts';
import { CATALOGUE, type CatalogueFunctionName } from '../../catalogue/catalogue.ts';
import { ADVISOR_SCOPES as CONTRACT_SCOPES, type AdvisorScope } from '../../contract/scopes.ts';
import type { Severity } from '../../contract/response.ts';
import type { MoneyJson } from '../../contract/snapshot.ts';
import type { InsightsExecutor } from '../../db.ts';
import { BUILTIN_CATALOGUE } from '../catalogue.ts';
import type { AskCompiledCall } from '../ask/compile.ts';
import type { AskFigure, AskResultView } from '../ask/results.ts';
import { envelopeValueOf, redactFreeText, type FindingSource } from '../local/findings.ts';
import { NARRATOR_SCOPES } from '../local/manifest.ts';
import { ASK_MAX_CALLS } from '../ask/manifest.ts';
import { ADVISOR_QUESTION_MAX } from './manifest.ts';

// ---------------------------------------------------------------------------
// The table: rule family → question template → seeded calls
// ---------------------------------------------------------------------------

export const TALK_THROUGH_FAMILIES = [
  'cash',
  'debt',
  'investing',
  'subscriptions',
  'retirement',
  'goals',
] as const;
export type TalkThroughFamily = (typeof TALK_THROUGH_FAMILIES)[number];

/**
 * One question template per rule family. `{title}` is the finding's title as
 * the holder saw it; `{rule}` the rule's display name. Plain words, no figure
 * of their own, nothing the pre-check reads as an instruction or as out of
 * scope.
 */
export const TALK_THROUGH_QUESTIONS: Readonly<Record<TalkThroughFamily, string>> = Object.freeze({
  cash: 'My Brief flagged “{title}” ({rule}). What could I do about my cash cushion, and what would each choice cost?',
  debt: 'My Brief flagged “{title}” ({rule}). What are my options for these debts, and what would each choice cost?',
  investing:
    'My Brief flagged “{title}” ({rule}). What are my options for my investments here, and what would each choice cost?',
  subscriptions:
    'My Brief flagged “{title}” ({rule}). What are my options for these recurring charges, and what would each choice cost?',
  retirement:
    'My Brief flagged “{title}” ({rule}). What are my options for my retirement plan, and what would each choice cost?',
  goals:
    'My Brief flagged “{title}” ({rule}). What are my options for reaching this goal, and what would each choice cost?',
});

/** What a seeded call's arguments may depend on: the finding's key and the holder's currency. */
export interface SeedContext {
  readonly key: string;
  readonly currency: string;
}

export interface SeedSpec {
  readonly name: CatalogueFunctionName;
  /** The raw arguments; `null` when the finding does not carry what the call needs. */
  readonly args: (context: SeedContext) => Record<string, unknown> | null;
}

export interface TalkThroughRule {
  readonly family: TalkThroughFamily;
  readonly seeds: readonly SeedSpec[];
}

const NONE = (): Record<string, unknown> => ({});
const EMERGENCY_FUND: SeedSpec = {
  name: 'cash.emergency_fund',
  args: () => ({ target_months: 3 }),
};
const PAYOFF: SeedSpec = {
  name: 'debt.payoff_plan',
  // Both orders come back side by side; the extra is nothing, so the plan is the minimums as they stand.
  args: ({ currency }) => ({ order: 'avalanche', extra_monthly: { minor: '0', currency } }),
};
const GOAL_REF = /^retirement\.goal_pace\.(GOAL_[0-9A-Za-z]{4,})$/u;

/**
 * 07 §3.3 rule → its family and the catalogue calls that answer it
 * (11.5b's table: C4 → `cash.emergency_fund`, the D rules → `debt.payoff_plan`,
 * R4 → `retirement.claiming`, the I rules → `investing.*`, the U rules →
 * `recurring.waste`, a goal → `goal.required_savings`). A rule absent here
 * (the spending rules, crypto, anomalies, the rule suggester) has no catalogue
 * function that answers it in `catalogue/1`, so it offers no "Talk this
 * through".
 */
export const TALK_THROUGH_RULES: Readonly<Record<string, TalkThroughRule>> = Object.freeze({
  C1: { family: 'cash', seeds: [EMERGENCY_FUND] },
  C2: { family: 'cash', seeds: [EMERGENCY_FUND] },
  C3: { family: 'cash', seeds: [EMERGENCY_FUND] },
  C4: { family: 'cash', seeds: [EMERGENCY_FUND] },
  C7: { family: 'cash', seeds: [EMERGENCY_FUND] },
  D1: { family: 'debt', seeds: [PAYOFF] },
  D2: { family: 'debt', seeds: [PAYOFF] },
  D3: { family: 'debt', seeds: [PAYOFF] },
  D4: { family: 'debt', seeds: [PAYOFF] },
  D5: { family: 'debt', seeds: [PAYOFF] },
  D6: { family: 'debt', seeds: [PAYOFF] },
  I1: { family: 'investing', seeds: [{ name: 'investing.drift', args: NONE }] },
  I2: { family: 'investing', seeds: [{ name: 'investing.costs', args: NONE }] },
  I3: { family: 'investing', seeds: [{ name: 'investing.allocation', args: NONE }] },
  I4: { family: 'investing', seeds: [{ name: 'investing.concentration', args: NONE }] },
  I5: { family: 'investing', seeds: [{ name: 'investing.concentration', args: NONE }] },
  I6: { family: 'investing', seeds: [{ name: 'investing.allocation', args: NONE }] },
  U2: { family: 'subscriptions', seeds: [{ name: 'recurring.waste', args: NONE }] },
  U3: { family: 'subscriptions', seeds: [{ name: 'recurring.waste', args: NONE }] },
  U7: { family: 'subscriptions', seeds: [{ name: 'recurring.waste', args: NONE }] },
  R1: { family: 'retirement', seeds: [{ name: 'plan.project', args: NONE }] },
  R2: { family: 'retirement', seeds: [{ name: 'plan.levers', args: NONE }] },
  R3: { family: 'retirement', seeds: [{ name: 'retirement.rmd_window', args: NONE }] },
  R4: {
    family: 'retirement',
    seeds: [{ name: 'retirement.claiming', args: () => ({ ages: [62, 67, 70] }) }],
  },
  R6: {
    family: 'goals',
    seeds: [
      {
        name: 'goal.required_savings',
        args: ({ key }) => {
          const match = GOAL_REF.exec(key);
          return match === null ? null : { goal_ref: match[1] };
        },
      },
    ],
  },
  R7: { family: 'retirement', seeds: [{ name: 'retirement.guardrail', args: NONE }] },
});

const NARRATOR_SCOPE_SET: ReadonlySet<string> = new Set(NARRATOR_SCOPES);

export interface TalkThroughRuleOf {
  readonly ruleId: string;
  readonly family: TalkThroughFamily;
  readonly ruleName: string;
  readonly ruleText: string;
}

/**
 * Does this advisor's finding offer "Talk this through"? Only a built-in rule
 * in the table whose manifest reads nothing outside what the narrator may ever
 * be granted (so a rule over `transactions.raw` — U3 — never does). Pure.
 */
export function talkThroughRuleOf(advisorId: string): TalkThroughRuleOf | null {
  const entry = BUILTIN_CATALOGUE.find((item) => item.advisorId === advisorId);
  if (entry === undefined) return null;
  const rule = TALK_THROUGH_RULES[entry.ruleId];
  if (rule === undefined) return null;
  if (!entry.advisor.manifest.requires_scopes.every((scope) => NARRATOR_SCOPE_SET.has(scope))) {
    return null;
  }
  return {
    ruleId: entry.ruleId,
    family: rule.family,
    ruleName: entry.advisor.manifest.display_name,
    ruleText: entry.advisor.manifest.purpose,
  };
}

/** The rule's words by its 07 identifier (the first built-in carrying it). */
export function talkThroughRuleById(ruleId: string): TalkThroughRuleOf | null {
  const entry = BUILTIN_CATALOGUE.find((item) => item.ruleId === ruleId);
  return entry === undefined ? null : talkThroughRuleOf(entry.advisorId);
}

const TITLE_MAX = 200;

function clipped(text: string, max: number): string {
  const chars = [...text.replace(/\s+/gu, ' ').trim()];
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('')}…`;
}

/** The session's opening question, from the family's template. Pure; never over the question cap. */
export function talkThroughQuestion(input: {
  readonly family: TalkThroughFamily;
  readonly title: string;
  readonly ruleName: string;
}): string {
  const template = TALK_THROUGH_QUESTIONS[input.family];
  const fill = (title: string) =>
    template.replace('{rule}', clipped(input.ruleName, 80)).replace('{title}', title);
  let title = clipped(input.title, TITLE_MAX);
  let question = fill(title);
  while ([...question].length > ADVISOR_QUESTION_MAX && title.length > 1) {
    title = clipped(title, [...title].length - 10);
    question = fill(title);
  }
  return question;
}

/**
 * The seeded calls for a finding, parsed through each function's own schema
 * (defaults applied) exactly as a compiled call's arguments are. A seed whose
 * arguments the finding cannot supply (a goal finding whose key carries no
 * goal ref) is left out, never guessed.
 */
export function seededCallsFor(ruleId: string, context: SeedContext): readonly AskCompiledCall[] {
  const rule = TALK_THROUGH_RULES[ruleId];
  if (rule === undefined) return [];
  const calls: AskCompiledCall[] = [];
  for (const seed of rule.seeds) {
    const raw = seed.args(context);
    if (raw === null) continue;
    const parsed = CATALOGUE[seed.name].args.safeParse(raw);
    if (!parsed.success) continue;
    calls.push({ name: seed.name, args: parsed.data as Record<string, unknown> });
  }
  return calls;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The calls the gather step runs: **every seeded call first, always**, then
 * the compiler's calls that are not the same call again, up to the step's
 * cap. A compiled call past the cap is dropped and counted.
 */
export function mergeSeededCalls(
  seeded: readonly AskCompiledCall[],
  compiled: readonly AskCompiledCall[],
): { readonly calls: readonly AskCompiledCall[]; readonly droppedCompiled: number } {
  const calls: AskCompiledCall[] = [...seeded];
  const seen = new Set(seeded.map((call) => `${call.name}\u0000${canonical(call.args)}`));
  let dropped = 0;
  for (const call of compiled) {
    const key = `${call.name}\u0000${canonical(call.args)}`;
    if (seen.has(key)) continue;
    if (calls.length >= Math.max(ASK_MAX_CALLS, seeded.length)) {
      dropped += 1;
      continue;
    }
    seen.add(key);
    calls.push(call);
  }
  return { calls, droppedCompiled: dropped };
}

// ---------------------------------------------------------------------------
// The finding's own figures
// ---------------------------------------------------------------------------

/** The pseudo-function a finding's evidence result is filed under in the context object. */
export const FINDING_RESULT_FUNCTION = 'finding.evidence';

/** A snapshot path the validator can resolve: `snapshot:cash_summary.total.minor`, `snapshot:goals_list.goals[0].pace`. */
const SNAPSHOT_REF = /^snapshot:[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*|\[\d{1,4}\])+$/u;
/** A figure as the app writes one, and nothing else: money, a percent, a plain number, a count of months/years/days, an age, a date. */
const FIGURE_TEXT =
  /^(?:-?\$\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|-?\$\d+(?:\.\d{1,2})?|-?\d+(?:\.\d+)?%|-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?|\d+(?:\.\d+)? (?:months?|years?|days?)|age \d{1,3}|\d{4}-\d{2}(?:-\d{2})?)$/u;
/** Labels are the rule's own words: no pseudonym, no markup, no run of digits that could be an account number. */
const LABEL_FORBIDDEN = /MERCHANT_|GOAL_|LIABILITY_|ACCOUNT_|[<>{}]|\d{3,}/iu;
/** Where a ref names a holder's or a provider's word, never a figure. */
const IDENTITY_FIELD =
  /\.(?:name|merchant_ref|liability_ref|goal_ref|account_ref|payee|description|memo|institution)$/u;

export const FINDING_FIGURES_MAX = 12;

export type FindingFigureDrop =
  | 'no_source_ref'
  | 'source_ref_not_a_snapshot_path'
  | 'did_not_resolve'
  | 'identity_field'
  | 'not_a_figure'
  | 'label_refused';

export interface FindingEvidenceRow {
  readonly label: string;
  readonly value: string | null;
  readonly sourceRef: string | null;
  readonly resolvedDisplay: string | null;
}

/**
 * The finding's evidence rows that may enter the context object as figures,
 * and why each other row did not. Pure.
 *
 * A row enters only when **its `source_ref` resolves**: a snapshot path that
 * the validator resolved when the built-in proposed it (`resolved_display`
 * recorded) — and its text is what the evidence panel shows for it
 * (`envelopeValueOf`), shaped as a figure. Never a name.
 */
export function findingEvidenceFigures(input: {
  readonly evidence: readonly FindingEvidenceRow[];
  readonly prose: readonly string[];
}): {
  readonly figures: readonly AskFigure[];
  readonly dropped: readonly { readonly position: number; readonly reason: FindingFigureDrop }[];
} {
  const figures: AskFigure[] = [];
  const dropped: { position: number; reason: FindingFigureDrop }[] = [];
  const words = input.evidence
    .map((row) => (row.value ?? '').trim())
    .filter((text) => text.length >= 3 && !FIGURE_TEXT.test(text));
  input.evidence.forEach((row, position) => {
    const ref = row.sourceRef;
    if (ref === null) return dropped.push({ position, reason: 'no_source_ref' });
    if (!SNAPSHOT_REF.test(ref)) {
      return dropped.push({ position, reason: 'source_ref_not_a_snapshot_path' });
    }
    if (IDENTITY_FIELD.test(ref)) return dropped.push({ position, reason: 'identity_field' });
    const resolved = row.resolvedDisplay;
    if (resolved === null || resolved === 'null' || resolved.trim().length === 0) {
      return dropped.push({ position, reason: 'did_not_resolve' });
    }
    const text = (envelopeValueOf(row, input.prose) ?? '').trim();
    if (!FIGURE_TEXT.test(text)) return dropped.push({ position, reason: 'not_a_figure' });
    const label = row.label.replace(/\s+/gu, ' ').trim();
    if (
      label.length === 0 ||
      [...label].length > 80 ||
      LABEL_FORBIDDEN.test(label) ||
      words.some((word) => label.includes(word))
    ) {
      return dropped.push({ position, reason: 'label_refused' });
    }
    if (figures.length >= FINDING_FIGURES_MAX) return undefined;
    const isDate = /^\d{4}-\d{2}(?:-\d{2})?$/u.test(text);
    const isMoney = text.includes('$');
    const raw = isDate || isMoney ? null : text.replace(/[%,]/gu, '').replace(/ .*$/u, '');
    figures.push({
      key: `evidence[${String(position)}]`,
      label,
      text,
      kind: isDate ? 'date' : isMoney ? 'money' : 'decimal',
      raw: raw !== null && /^-?\d+(?:\.\d+)?$/u.test(raw) && !text.endsWith('%') ? raw : null,
      source_refs: [ref],
    });
    return undefined;
  });
  return { figures, dropped };
}

/** The finding a session was opened from, as the gather step needs it. */
export interface TalkThroughFinding {
  readonly insightId: string;
  readonly advisorId: string;
  readonly key: string;
  readonly ruleId: string;
  readonly family: TalkThroughFamily;
  /** The title as a free-text reader is shown it (a goal name's digits redacted). */
  readonly title: string;
  readonly ruleName: string;
  readonly ruleText: string;
  readonly severity: Severity;
  /** The finding's source run's emitted scopes, catalogue order. */
  readonly scopes: readonly AdvisorScope[];
  readonly figures: readonly AskFigure[];
  readonly dropped: readonly { readonly position: number; readonly reason: FindingFigureDrop }[];
  /** The evidence rows as read (a goal name's digits redacted): what `findingFiguresResolve` checks against. */
  readonly evidence: readonly FindingEvidenceRow[];
  readonly asOf: string | null;
}

export type TalkThroughFindingOutcome =
  | { readonly status: 'found'; readonly finding: TalkThroughFinding }
  | {
      readonly status: 'not_found' | 'not_supported' | 'narration' | 'source_run_unknown';
    };

function catalogueOrder(scopes: readonly string[]): AdvisorScope[] {
  const wanted = new Set(scopes);
  return CONTRACT_SCOPES.filter((scope) => wanted.has(scope));
}

/**
 * Read the finding behind a "Talk this through": its row, its evidence and its
 * source run (whose emitted scopes say what it was built from), the way 11.3's
 * Explain-this reads a subject. Read-only.
 */
export async function loadTalkThroughFinding(
  executor: InsightsExecutor,
  userId: string,
  insightId: string,
): Promise<TalkThroughFindingOutcome> {
  const rows = await executor
    .select()
    .from(insights)
    .where(and(eq(insights.userId, userId), eq(insights.id, insightId)));
  const row = rows[0];
  if (row === undefined) return { status: 'not_found' };
  if (row.narratesInsightId !== null) return { status: 'narration' };
  const rule = talkThroughRuleOf(row.advisorId);
  if (rule === null) return { status: 'not_supported' };
  if (row.runId === null) return { status: 'source_run_unknown' };
  const runs = await executor
    .select({ emittedScopes: advisorRuns.emittedScopes })
    .from(advisorRuns)
    .where(and(eq(advisorRuns.userId, userId), eq(advisorRuns.id, row.runId)));
  const run = runs[0];
  if (run === undefined) return { status: 'source_run_unknown' };
  const evidence = (
    await executor
      .select()
      .from(insightEvidence)
      .where(and(eq(insightEvidence.userId, userId), eq(insightEvidence.insightId, insightId)))
  ).sort((left, right) => left.position - right.position);
  const currency = row.impactCurrency;
  const money = (minor: bigint | null): MoneyJson | null =>
    minor === null || currency === null ? null : { minor: minor.toString(), currency };
  const source: FindingSource = redactFreeText(
    {
      key: row.key,
      period: row.period,
      type: row.type,
      severity: row.severity as Severity,
      title: row.title,
      summaryMd: row.summaryMd,
      evidence: evidence.map((entry) => ({
        label: entry.label,
        value: entry.value,
        sourceRef: entry.sourceRef,
        resolvedDisplay: entry.resolvedDisplay,
      })),
      derived: [],
      impact: {
        annualized: money(row.impactAnnualizedMinor),
        oneTime: money(row.impactOneTimeMinor),
        basis: row.impactBasis,
      },
    },
    'local_model',
  );
  const { figures, dropped } = findingEvidenceFigures({
    evidence: source.evidence,
    prose: [source.title, source.summaryMd],
  });
  return {
    status: 'found',
    finding: {
      insightId: row.id,
      advisorId: row.advisorId,
      key: row.key,
      ruleId: rule.ruleId,
      family: rule.family,
      title: clipped(source.title, TITLE_MAX),
      ruleName: rule.ruleName,
      ruleText: rule.ruleText,
      severity: source.severity,
      scopes: catalogueOrder(run.emittedScopes),
      figures,
      dropped,
      evidence: source.evidence,
      asOf: row.lastProposedAt.toISOString().slice(0, 10),
    },
  };
}

/**
 * The finding's figures as one result of the context object: `finding.evidence`,
 * labelled with the title, its figures each carrying the evidence row's
 * `source_ref`. Its scopes are the finding's own. Pure.
 */
export function findingResultOf(finding: TalkThroughFinding): AskResultView {
  return {
    // A pseudo-function: the result is the finding's own evidence, not a catalogue call.
    function: FINDING_RESULT_FUNCTION as CatalogueFunctionName,
    label: `the finding “${finding.title}”`,
    args: {},
    status: 'ok',
    as_of: finding.asOf,
    scopes: [...finding.scopes],
    input_digest: null,
    result_digest: null,
    not_available: null,
    refused: null,
    figures: finding.figures,
    figures_total: finding.figures.length,
    facts: [],
    parameter_keys: [],
    screen: '/brief',
  };
}

/** Is this context result the finding's own evidence (never a catalogue call: never re-run, never watched)? */
export function isFindingResult(result: Pick<AskResultView, 'function'>): boolean {
  return (result.function as string) === FINDING_RESULT_FUNCTION;
}

/**
 * Every figure of a finding result resolves: it carries exactly one
 * `source_ref`, a snapshot path, that is the ref of one of the finding's
 * evidence rows the validator resolved. The check the gather step makes before
 * the result joins the context object. Pure.
 */
export function findingFiguresResolve(
  result: AskResultView,
  evidence: readonly FindingEvidenceRow[],
): boolean {
  const resolved = new Set(
    evidence.flatMap((row) =>
      row.sourceRef !== null &&
      row.resolvedDisplay !== null &&
      row.resolvedDisplay !== 'null' &&
      row.resolvedDisplay.trim().length > 0
        ? [row.sourceRef]
        : [],
    ),
  );
  return result.figures.every(
    (figure) =>
      figure.source_refs.length === 1 &&
      SNAPSHOT_REF.test(figure.source_refs[0] ?? '') &&
      resolved.has(figure.source_refs[0] ?? ''),
  );
}
