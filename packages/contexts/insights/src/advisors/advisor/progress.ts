// SPDX-License-Identifier: MIT
/**
 * A plan the holder picked, as the Brief reports it (WP 11.5e; 12 §2.3 step 6:
 * "the plan becomes a tracked item … and the Brief reports progress").
 * Deterministic: no model writes anything here.
 *
 *   * **The target** (`watcherTargetFor`): what "done" means for each watcher —
 *     the extra a month a goal still needs, the debts in the payoff plan, the
 *     room left this year, each down to $0.00. A watcher on any other figure
 *     has no target and never completes.
 *   * **Reached** (`targetReached`): the latest reading is at or below the
 *     target, read by decimal comparison on the watcher's own values — never a
 *     float, never the text. Only then does the follow-up check move the
 *     session to `completed` and stop its watcher.
 *   * **The wording** (`progressWording`): a fixed template per state, filled
 *     with the watcher's own figures — the baseline (what the holder saw when
 *     they picked), the latest reading and the target — and the day it was
 *     picked. **No other figure**: `progressWordingTraces` holds every numeral
 *     and number word of the sentence to exactly those texts, and a sentence
 *     that fails is never stored (a figure-free line stands instead).
 *   * **The Brief item's progress** (`briefProgressOf`): the session, the
 *     finding that opened it, when it was picked, the figures, the direction,
 *     the state and the wording — snapshotted onto the Brief item at publish.
 */
import {
  extractNumerals,
  maskLiterals,
  untraceableInFinding,
  untraceableWordFiguresInFinding,
  type FindingTraceContext,
} from '../../validate/numerals.ts';
import * as decimal from '../../validate/decimal.ts';
import type { AdvisorWatcher, AdvisorWatcherKind, WatchedValue } from './follow-up.ts';
import type { StoredAdvisorSession } from './source.ts';

export interface WatcherTarget {
  /** As the app writes it. */
  readonly text: string;
  /** Minor units (money) or the decimal: compared, never parsed from `text`. */
  readonly value: string;
}

const ZERO_DOLLARS: WatcherTarget = Object.freeze({ text: '$0.00', value: '0' });

/** What each watcher's plan aims at. `null`: no target (a generic figure), so never completed. */
export const WATCHER_TARGETS: Readonly<Record<AdvisorWatcherKind, WatcherTarget | null>> =
  Object.freeze({
    goal_pace: ZERO_DOLLARS,
    debt_balance: ZERO_DOLLARS,
    contribution_room: ZERO_DOLLARS,
    figure: null,
  });

export function watcherTargetFor(kind: AdvisorWatcherKind): WatcherTarget | null {
  return WATCHER_TARGETS[kind];
}

/** The watcher's target: the one it was created with, else its kind's (a watcher from before WP 11.5e). */
export function targetOf(watcher: AdvisorWatcher): WatcherTarget | null {
  return watcher.target === undefined ? watcherTargetFor(watcher.kind) : watcher.target;
}

/**
 * Has the latest reading reached the target? Decimal comparison of the
 * watcher's own values: at or below the target. `false` whenever there is no
 * target, no reading, or a value that is not a decimal.
 */
export function targetReached(latest: WatchedValue | null, target: WatcherTarget | null): boolean {
  if (latest === null || target === null || latest.value === null) return false;
  const value = decimal.parseDecimal(latest.value);
  const goal = decimal.parseDecimal(target.value);
  if (value === null || goal === null) return false;
  return value <= goal;
}

// ---------------------------------------------------------------------------
// The wording
// ---------------------------------------------------------------------------

export type ProgressState = 'tracking' | 'reached' | 'not_read';

/** The templates, verbatim. `{on}` is ` on <the day it was picked>` or nothing. */
export const PROGRESS_TEMPLATES: Readonly<Record<ProgressState, string>> = Object.freeze({
  tracking: '{label} was {baseline} when you picked this plan{on}. It is {latest} now: {moved}.',
  reached:
    '{label} was {baseline} when you picked this plan{on}. It is {latest} now, which reaches the plan’s target of {target}.',
  not_read: '{label} was {baseline} when you picked this plan{on}. It could not be read this time.',
});

export const PROGRESS_MOVED: Readonly<Record<'down' | 'up' | 'same', string>> = Object.freeze({
  down: 'down since then',
  up: 'up since then',
  same: 'no change since then',
});

/** What stands if a filled template ever failed its own trace: no figure at all. */
export const PROGRESS_FALLBACK = 'You are following a plan you picked in an advisor session.';

const DATE_TOKEN = /\b\d{4}-\d{2}(?:-\d{2})?\b/gu;

/** The trace a progress sentence is held to: the watcher's own figure texts, the pick date, the label. */
export function progressTraceContext(input: {
  readonly label: string;
  readonly baseline: string;
  readonly latest: string | null;
  readonly target: string | null;
  readonly pickedAt: string | null;
}): FindingTraceContext {
  const texts = [input.baseline, input.latest, input.target].filter(
    (text): text is string => text !== null,
  );
  const literals = [
    ...new Set([
      ...(input.pickedAt === null ? [] : [input.pickedAt]),
      ...texts.flatMap((text) => [...text.matchAll(DATE_TOKEN)].map((match) => match[0])),
    ]),
  ];
  const figures = new Set<string>();
  for (const text of texts) {
    for (const numeral of extractNumerals(maskLiterals(text, literals))) {
      figures.add(numeral.isPercent ? `${numeral.normalized}%` : numeral.normalized);
    }
  }
  return { figures, literals, prose: [input.label] };
}

/** Does every figure of the sentence come from the watcher? Pure. */
export function progressWordingTraces(wording: string, trace: FindingTraceContext): boolean {
  return (
    untraceableInFinding(wording, trace).length === 0 &&
    untraceableWordFiguresInFinding(wording, trace).length === 0
  );
}

function sentenceLabel(label: string): string {
  const trimmed = label.trim();
  return trimmed.length === 0
    ? 'The figure'
    : `${trimmed[0]?.toUpperCase() ?? ''}${trimmed.slice(1)}`;
}

/**
 * The sentence for a watcher's state, from the template; checked against the
 * watcher's figures before it is returned (the fallback otherwise). Pure.
 */
export function progressWording(input: {
  readonly state: ProgressState;
  readonly label: string;
  readonly baseline: string;
  readonly latest: string | null;
  readonly target: string | null;
  readonly direction: 'down' | 'up' | 'same' | null;
  readonly pickedAt: string | null;
}): string {
  const label = sentenceLabel(input.label);
  const state: ProgressState =
    input.latest === null ? 'not_read' : input.state === 'not_read' ? 'tracking' : input.state;
  if (state === 'reached' && input.target === null) return PROGRESS_FALLBACK;
  const filled = PROGRESS_TEMPLATES[state]
    .replace('{label}', label)
    .replace('{baseline}', input.baseline)
    .replace('{on}', input.pickedAt === null ? '' : ` on ${input.pickedAt}`)
    .replace('{latest}', input.latest ?? '')
    .replace('{target}', input.target ?? '')
    .replace('{moved}', PROGRESS_MOVED[input.direction ?? 'same']);
  const trace = progressTraceContext({ ...input, label });
  return progressWordingTraces(filled, trace) ? filled : PROGRESS_FALLBACK;
}

// ---------------------------------------------------------------------------
// The Brief item's progress
// ---------------------------------------------------------------------------

export interface BriefProgressOrigin {
  readonly insight_ref: string;
  readonly rule_id: string;
  readonly title: string;
  readonly brief_week: string | null;
}

/** Snapshotted onto `advisory_brief_items.progress` at publish (WP 11.5e). */
export interface BriefProgress {
  readonly version: 1;
  readonly session_id: string;
  readonly origin: BriefProgressOrigin | null;
  readonly picked_at: string | null;
  readonly kind: AdvisorWatcherKind;
  readonly label: string;
  readonly baseline: { readonly text: string; readonly as_of: string | null };
  readonly latest: { readonly text: string; readonly as_of: string | null } | null;
  readonly target: { readonly text: string } | null;
  readonly direction: 'down' | 'up' | 'same' | null;
  readonly state: ProgressState;
  readonly wording: string;
  /** The finding that opened the session, when it was still in the feed this week: shown once, as this item. */
  readonly worked_on: { readonly insight_ref: string; readonly title: string } | null;
}

/** The origin columns of a session as one value, or `null` for a typed question. */
export function sessionOriginOf(session: StoredAdvisorSession): BriefProgressOrigin | null {
  if (
    session.originInsightRef === null ||
    session.originRuleId === null ||
    session.originTitle === null
  ) {
    return null;
  }
  return {
    insight_ref: session.originInsightRef,
    rule_id: session.originRuleId,
    title: session.originTitle,
    brief_week: session.originBriefWeek,
  };
}

/** A tracked or completed session's progress, for the Brief. `null` without a watcher. Pure. */
export function briefProgressOf(session: StoredAdvisorSession): BriefProgress | null {
  const watcher = session.watcher as unknown as AdvisorWatcher | null;
  if (watcher === null || (session.status !== 'tracked' && session.status !== 'completed')) {
    return null;
  }
  const target = targetOf(watcher);
  const reached = session.status === 'completed' || watcher.status === 'reached';
  const state: ProgressState =
    watcher.latest === null ? 'not_read' : reached ? 'reached' : 'tracking';
  const pickedAt = watcher.picked_at ?? null;
  return {
    version: 1,
    session_id: session.id,
    origin: sessionOriginOf(session),
    picked_at: pickedAt,
    kind: watcher.kind,
    label: watcher.figure_label,
    baseline: { text: watcher.baseline.text, as_of: watcher.baseline.as_of },
    latest:
      watcher.latest === null ? null : { text: watcher.latest.text, as_of: watcher.latest.as_of },
    target: target === null ? null : { text: target.text },
    direction: watcher.direction,
    state,
    wording: progressWording({
      state,
      label: watcher.figure_label,
      baseline: watcher.baseline.text,
      latest: watcher.latest?.text ?? null,
      target: target?.text ?? null,
      direction: watcher.direction,
      pickedAt,
    }),
    worked_on: null,
  };
}
