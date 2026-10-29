// SPDX-License-Identifier: MIT
/**
 * `advisor.follow_up` (WP 11.5d; 12 §2.3 step 6, §5 "Outcome"): **no model**.
 *
 * When the holder has picked an option and the plan is written, the session
 * becomes a tracked item with a deterministic watcher: the figure the plan was
 * about, found from the picked option's own figures —
 *
 *   * `goal_pace`         a goal's required monthly saving (`goal.required_savings`);
 *   * `debt_balance`      the balances of the debts in the payoff plan (`debt.payoff_plan`);
 *   * `contribution_room` the room left for the year (`limits.contribution_room`);
 *   * `figure`            otherwise, the first figure the option rests on, by its path.
 *
 * `evaluateAdvisorWatcher` re-runs that catalogue call (under the holder's
 * grant, deterministic) and records what it sees beside what the holder saw at
 * the pick. It then reports progress into the **Brief's own candidate path**:
 * a `builtin` insight, written through the seven-step validator
 * (`validateResponse`) against a builtin snapshot of the one scope it reads —
 * as the weekly health score reads its own (09 TRD-6) — with **wording that is
 * a fixed template** (no model, no narration), evidence that resolves into
 * that snapshot, an impact derived by the validator's own arithmetic, and the
 * cooldown ladder honoured (a Helpful / Not helpful or a dismissal on the item
 * works as it does for every other finding). The Brief ranks it with the rest.
 *
 * `contribution_room` has no snapshot field to cite — the limit is a parameter
 * and the year's contributions are summed by the catalogue — so its progress
 * is shown on the session and not written to the Brief (`not_in_snapshot`).
 */
import { newId, todayIn, type DateOnly } from '@core/kernel';
import type { AdvisorManifest } from '../../contract/manifest.ts';
import { resolveLimits } from '../../contract/manifest.ts';
import type { AdvisorRequest } from '../../contract/request.ts';
import type { AdvisorScope } from '../../contract/scopes.ts';
import type { AdvisorSnapshot } from '../../contract/snapshot.ts';
import { ADVISOR_CONTRACT_MAJOR } from '../../contract/version.ts';
import {
  callCatalogueByName,
  type CatalogueRuntimeDependencies,
} from '../../catalogue/catalogue.ts';
import { isCatalogueRefusal } from '../../catalogue/ports.ts';
import type { InsightsContext, InsightsDatabase } from '../../db.ts';
import { isSuppressed } from '../../policy/cooldown.ts';
import { narratorGrantCeiling } from '../local/grant.ts';
import { SnapshotBuilder } from '../../snapshot/builder.ts';
import { deriveTokenKey } from '../../snapshot/tokens.ts';
import {
  finishRun,
  loadSuppression,
  registerAdvisor,
  findAdvisor,
  startRun,
  upsertInsight,
} from '../../store.ts';
import { validateResponse } from '../../validate/pipeline.ts';
import * as decimal from '../../validate/decimal.ts';
import { builtinManifest } from '../manifest.ts';
import {
  annualisedAverage,
  clampImpact,
  formatMoneyJson,
  insightOf,
  metric,
  snapshotRef,
  suggest,
  sumOf,
} from '../support.ts';
import type { AskResultView } from '../ask/results.ts';
import type { AdvisorContextFigure } from './context.ts';
import { ADVISOR_DISCLAIMER, ADVISOR_FOLLOW_UP_ADVISOR_ID } from './manifest.ts';
import type { AdvisorOption } from './options.ts';
import type { AdvisorTradeoff } from './tradeoffs.ts';
import type { StoredAdvisorSession } from './source.ts';
import { transitionAdvisorSession } from './source.ts';
import { isFindingResult } from './origin.ts';
import { targetOf, targetReached, watcherTargetFor, type WatcherTarget } from './progress.ts';

export const ADVISOR_WATCHER_KINDS = [
  'goal_pace',
  'debt_balance',
  'contribution_room',
  'figure',
] as const;
export type AdvisorWatcherKind = (typeof ADVISOR_WATCHER_KINDS)[number];

export interface WatchedValue {
  /** As the app writes it. */
  readonly text: string;
  /** Minor units for money, the decimal otherwise; `null` when not numeric. */
  readonly value: string | null;
  readonly as_of: string | null;
}

export interface AdvisorWatcher {
  readonly kind: AdvisorWatcherKind;
  readonly function: string;
  readonly args: Record<string, unknown>;
  /** The figure's path in the result, or `included[].balance` (summed) for a debt plan. */
  readonly figure_key: string;
  readonly figure_label: string;
  /** A debt plan's debts, by their snapshot pseudonym (never an account id). */
  readonly liability_refs?: readonly string[];
  readonly baseline: WatchedValue;
  readonly latest: WatchedValue | null;
  readonly direction: 'down' | 'up' | 'same' | null;
  /** `reached` (WP 11.5e): the latest reading met the target; the session is `completed` and the watcher stops. */
  readonly status: 'watching' | 'not_available' | 'scope_withdrawn' | 'reached';
  readonly checked_at: string | null;
  /**
   * WP 11.5e: what the plan aims at (`progress.ts`'s `WATCHER_TARGETS`), fixed when the watcher is made;
   * `null` for a watcher with no target. Absent on a watcher made before 11.5e: its kind's target applies.
   */
  readonly target?: WatcherTarget | null;
  /** WP 11.5e: the day the holder picked the plan (the holder's zone), for the Brief's wording. */
  readonly picked_at?: string | null;
  /** WP 11.5e: when the follow-up check saw the target reached. */
  readonly reached_at?: string | null;
  /** The Brief item: its insight key, and what the last check did with it. */
  readonly brief: {
    readonly key: string;
    readonly outcome:
      'written' | 'suppressed' | 'not_in_snapshot' | 'rejected' | 'pending' | 'none';
    readonly detail: string | null;
  };
}

export const ADVISOR_FOLLOW_UP_MANIFEST: AdvisorManifest = Object.freeze({
  ...builtinManifest({
    advisorId: ADVISOR_FOLLOW_UP_ADVISOR_ID,
    displayName: 'Advisor plans you are following',
    purpose:
      'Follows the figure behind a plan you picked in an advisor session — a goal’s pace, a debt ' +
      'balance — and reports where it stands in the Brief. Fixed wording, no language model.',
    scopes: ['goals.list', 'liabilities.terms'],
    maxSeverity: 'notable',
    producesImpact: true,
    maxInsights: 1,
  }),
  // Not on the nightly schedule: the follow-up job runs it, one tracked session at a time.
  triggers: [],
}) as AdvisorManifest;

// ---------------------------------------------------------------------------
// The watcher, from the picked option (pure)
// ---------------------------------------------------------------------------

function moneyTextToMinor(text: string): string | null {
  const match = /^(-?)\$([0-9,]+)(?:\.([0-9]{2}))?(?:\s[A-Z]{3})?$/u.exec(text.trim());
  if (match === null) return null;
  const whole = (match[2] ?? '').replace(/,/gu, '');
  const cents = match[3] ?? '00';
  const minor = `${whole}${cents}`.replace(/^0+(?=\d)/u, '');
  return `${match[1] ?? ''}${minor}`;
}

function watchedOf(
  figure: { readonly text: string; readonly kind: string; readonly raw: string | null },
  asOf: string | null,
): WatchedValue {
  return {
    text: figure.text,
    value: figure.kind === 'money' ? moneyTextToMinor(figure.text) : figure.raw,
    as_of: asOf,
  };
}

const PRIORITY: readonly [string, AdvisorWatcherKind][] = [
  ['goal.required_savings', 'goal_pace'],
  ['debt.payoff_plan', 'debt_balance'],
  ['limits.contribution_room', 'contribution_room'],
];

/**
 * The watcher for a picked option: what it follows and what the holder saw.
 * Deterministic over the option, its trade-off and the gathered results.
 */
export function advisorWatcherFor(input: {
  readonly option: AdvisorOption;
  readonly tradeoff: AdvisorTradeoff;
  readonly results: readonly AskResultView[];
  readonly watcherKey: string;
  /** WP 11.5e: the day the holder picked it. */
  readonly pickedAt?: string | null;
}): AdvisorWatcher | null {
  const figures: AdvisorContextFigure[] = [
    ...input.tradeoff.cost,
    ...input.tradeoff.benefit,
    ...input.option.backed_by,
  ];
  const indexOf = (figure: AdvisorContextFigure): number => {
    const match = /^r([1-9][0-9]?):/u.exec(figure.ref);
    return match === null ? -1 : Number(match[1]) - 1;
  };
  const touched = figures
    .map((figure) => ({ figure, index: indexOf(figure) }))
    .filter((entry) => entry.index >= 0 && entry.index < input.results.length)
    // WP 11.5e: a finding's own evidence is not a catalogue call — it cannot be re-run, so it is never watched.
    .filter((entry) => {
      const result = input.results[entry.index];
      return result !== undefined && !isFindingResult(result);
    });
  if (touched.length === 0) return null;
  const pick = (() => {
    for (const [name, kind] of PRIORITY) {
      const found = touched.find((entry) => input.results[entry.index]?.function === name);
      if (found !== undefined) return { ...found, kind };
    }
    const first = touched[0];
    return first === undefined ? null : { ...first, kind: 'figure' as const };
  })();
  if (pick === null) return null;
  const result = input.results[pick.index];
  if (result === undefined) return null;
  const brief = { key: input.watcherKey, outcome: 'pending' as const, detail: null };
  const base = {
    function: result.function,
    args: { ...result.args },
    latest: null,
    direction: null,
    status: 'watching' as const,
    checked_at: null,
    brief,
    target: watcherTargetFor(pick.kind),
    picked_at: input.pickedAt ?? null,
    reached_at: null,
  };
  if (pick.kind === 'goal_pace') {
    const monthly = result.figures.find((figure) => figure.key === 'monthly');
    if (monthly === undefined) return null;
    return {
      ...base,
      kind: 'goal_pace',
      figure_key: 'monthly',
      figure_label: 'Needed per month',
      baseline: watchedOf(monthly, result.as_of),
    };
  }
  if (pick.kind === 'debt_balance') {
    const balances = result.figures.filter((figure) =>
      /^included\[\d+\]\.balance$/u.test(figure.key),
    );
    if (balances.length === 0) return null;
    let total = 0n;
    for (const figure of balances) total += BigInt(moneyTextToMinor(figure.text) ?? '0');
    const liabilityRefs = result.facts
      .filter((fact) => /^included\[\d+\]\.liability_ref$/u.test(fact.key))
      .map((fact) => fact.text);
    return {
      ...base,
      kind: 'debt_balance',
      liability_refs: liabilityRefs,
      figure_key: 'included[].balance',
      figure_label: 'Balances in the payoff plan',
      baseline: {
        text: formatMoneyJson({ minor: total.toString(), currency: 'USD' }) ?? total.toString(),
        value: total.toString(),
        as_of: result.as_of,
      },
    };
  }
  if (pick.kind === 'contribution_room') {
    const remaining = result.figures.find((figure) => figure.key === 'remaining');
    if (remaining === undefined) return null;
    return {
      ...base,
      kind: 'contribution_room',
      figure_key: 'remaining',
      figure_label: 'Room left this year',
      brief: { ...brief, outcome: 'not_in_snapshot' },
      baseline: watchedOf(remaining, result.as_of),
    };
  }
  const key = pick.figure.ref.slice(pick.figure.ref.indexOf(':') + 1);
  const figure = result.figures.find((entry) => entry.key === key);
  if (figure === undefined) return null;
  return {
    ...base,
    kind: 'figure',
    figure_key: key,
    figure_label: figure.label,
    brief: { ...brief, outcome: 'none' },
    baseline: watchedOf(figure, result.as_of),
  };
}

// ---------------------------------------------------------------------------
// The check (deterministic: the catalogue, then the Brief's candidate path)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The value at a figure path (`plans[0].total_interest`) of a result. */
function figureAt(result: unknown, path: string): Record<string, unknown> | null {
  let cursor: unknown = result;
  for (const part of path.match(/[^.[\]]+|\[\d+\]/gu) ?? []) {
    if (part.startsWith('[')) {
      const index = Number(part.slice(1, -1));
      cursor = Array.isArray(cursor) ? cursor[index] : undefined;
    } else {
      cursor = isRecord(cursor) ? cursor[part] : undefined;
    }
  }
  return isRecord(cursor) ? cursor : null;
}

function valueOfFigure(figure: Record<string, unknown> | null): WatchedValue | null {
  if (figure === null) return null;
  const money = figure['money'];
  if (
    isRecord(money) &&
    typeof money['minor'] === 'string' &&
    typeof money['currency'] === 'string'
  ) {
    const text = formatMoneyJson({ minor: money['minor'], currency: money['currency'] });
    return { text: text ?? money['minor'], value: money['minor'], as_of: null };
  }
  if (typeof figure['decimal'] === 'string') {
    return { text: figure['decimal'], value: figure['decimal'], as_of: null };
  }
  return null;
}

/**
 * A payoff plan the catalogue could not amortise because nothing is owed: every
 * liability the watcher follows is at or below $0.00 in the call's own inputs,
 * or no liability is on record at all. `null` otherwise (genuinely not
 * available: a debt lost its rate, say).
 */
function paidOffReading(
  watcher: AdvisorWatcher,
  envelope: {
    readonly not_available: { readonly code: string } | null;
    readonly inputs: Readonly<Record<string, unknown>>;
    readonly as_of: string | null;
  },
): WatchedValue | null {
  const code = envelope.not_available?.code ?? null;
  if (code !== 'no_debts' && code !== 'no_amortisable_debt') return null;
  const terms = envelope.inputs['liabilities_terms'];
  const liabilities =
    isRecord(terms) && Array.isArray(terms['liabilities'])
      ? (terms['liabilities'] as unknown[])
      : [];
  const wanted = new Set(watcher.liability_refs ?? []);
  if (wanted.size === 0 && liabilities.length > 0) return null;
  for (const entry of liabilities) {
    if (!isRecord(entry) || typeof entry['liability_ref'] !== 'string') continue;
    if (!wanted.has(entry['liability_ref'])) continue;
    const balance = entry['current_balance'];
    const minor =
      isRecord(balance) && typeof balance['minor'] === 'string' ? balance['minor'] : null;
    if (minor === null || BigInt(minor) > 0n) return null;
  }
  return {
    text: formatMoneyJson({ minor: '0', currency: 'USD' }) ?? '$0.00',
    value: '0',
    as_of: envelope.as_of,
  };
}

function directionOf(before: string | null, after: string | null): AdvisorWatcher['direction'] {
  if (before === null || after === null) return null;
  const left = decimal.parseDecimal(before);
  const right = decimal.parseDecimal(after);
  if (left === null || right === null) return null;
  return right > left ? 'up' : right < left ? 'down' : 'same';
}

const SCOPE_OF: Readonly<Partial<Record<AdvisorWatcherKind, AdvisorScope>>> = Object.freeze({
  goal_pace: 'goals.list',
  debt_balance: 'liabilities.terms',
});

/** The fixed-template finding for one watcher over its builtin snapshot. `null` when it cannot cite. */
export function followUpInsightOf(input: {
  readonly watcher: AdvisorWatcher;
  readonly snapshot: AdvisorSnapshot;
  readonly period: string;
}): ReturnType<typeof insightOf> | null {
  const { watcher, snapshot } = input;
  const key = watcher.brief.key;
  if (watcher.kind === 'goal_pace') {
    const goalRef = typeof watcher.args['goal_ref'] === 'string' ? watcher.args['goal_ref'] : null;
    const goals = snapshot.goals_list?.goals ?? [];
    const index = goals.findIndex((goal) => goal.goal_ref === goalRef);
    const goal = goals[index];
    if (goal === undefined || goal.pace === undefined) return null;
    const base = `goals_list.goals[${String(index)}]`;
    const yearly = annualisedAverage(
      snapshot,
      'follow_up_goal_year',
      [snapshotRef(`${base}.pace.required_monthly.minor`)],
      1,
      'A year of the monthly amount that reaches the goal on time.',
    );
    if (yearly === null) return null;
    const verdict = clampImpact(
      yearly.value,
      goal.pace.required_monthly.currency,
      'goal follow-up',
    );
    const required = formatMoneyJson(goal.pace.required_monthly);
    const planned = formatMoneyJson(goal.pace.planned_monthly);
    const target = formatMoneyJson(goal.target);
    if (required === null || planned === null || target === null) return null;
    const onPace = goal.pace.status === 'on_track';
    return insightOf({
      key,
      period: input.period,
      type: 'advisor.follow_up.goal_pace',
      severity: onPace ? 'info' : 'notable',
      title: onPace
        ? 'A plan you picked: the goal is on pace'
        : 'A plan you picked: the goal is behind its pace',
      summary:
        `You picked a plan for this in an advisor session. The goal “${goal.name}” ` +
        `needs about ${required} a month to reach ${target}; the contributions planned for it come ` +
        `to ${planned} a month.`,
      confidence: 1,
      horizon: 'this_period',
      annualized: verdict.kind === 'kept' ? verdict.money : null,
      basis:
        'A year of the monthly amount that reaches the goal on time, as the plan stands today.',
      derivationId: verdict.kind === 'kept' ? yearly.derivation.id : null,
      derivations: [yearly.derivation],
      evidence: [
        metric('The goal', snapshotRef(`${base}.name`), goal.name),
        metric('Its target', snapshotRef(`${base}.target`), target),
        metric('Needed per month', snapshotRef(`${base}.pace.required_monthly`), required),
        metric('Planned per month', snapshotRef(`${base}.pace.planned_monthly`), planned),
      ],
      actions: [
        suggest(
          'Open the plan you picked',
          'The advisor session lists the steps you chose, each a link to the screen where you act.',
        ),
      ],
      caveats: [ADVISOR_DISCLAIMER],
    });
  }
  if (watcher.kind === 'debt_balance') {
    const wanted = new Set(watcher.liability_refs ?? []);
    const liabilities = snapshot.liabilities_terms?.liabilities ?? [];
    const indexes = liabilities
      .map((liability, index) => ({ liability, index }))
      .filter(
        (entry) =>
          BigInt(entry.liability.current_balance.minor) > 0n &&
          (wanted.size === 0 || wanted.has(entry.liability.liability_ref)),
      )
      .slice(0, 16);
    if (indexes.length === 0) return null;
    const total = sumOf(
      snapshot,
      'follow_up_debt_total',
      indexes.map((entry) =>
        snapshotRef(`liabilities_terms.liabilities[${String(entry.index)}].current_balance.minor`),
      ),
      'The balances of the debts the payoff plan covers, added together.',
    );
    if (total === null) return null;
    const currency = indexes[0]?.liability.current_balance.currency ?? 'USD';
    const verdict = clampImpact(total.value, currency, 'debt follow-up');
    if (verdict.kind !== 'kept') return null;
    const totalText = formatMoneyJson(verdict.money);
    if (totalText === null) return null;
    return insightOf({
      key,
      period: input.period,
      type: 'advisor.follow_up.debt_balance',
      severity: 'info',
      title: 'A plan you picked: where the debts stand',
      summary:
        'You picked a plan for this in an advisor session. The debts in that payoff ' +
        `plan come to ${totalText} today.`,
      confidence: 1,
      horizon: 'this_period',
      oneTime: verdict.money,
      basis: 'The balances of the debts the payoff plan covers, as the lenders report them today.',
      derivationId: total.derivation.id,
      derivations: [total.derivation],
      evidence: indexes.map((entry) =>
        metric(
          'A balance in the plan',
          snapshotRef(`liabilities_terms.liabilities[${String(entry.index)}].current_balance`),
          formatMoneyJson(entry.liability.current_balance),
        ),
      ),
      actions: [
        suggest(
          'Open the plan you picked',
          'The advisor session lists the steps you chose, each a link to the screen where you act.',
        ),
      ],
      caveats: [ADVISOR_DISCLAIMER],
    });
  }
  return null;
}

export interface FollowUpDependencies {
  readonly catalogue: CatalogueRuntimeDependencies;
}

/** Register `advisor.follow_up`'s row (builtin, on) if it is missing. */
export async function ensureFollowUpAdvisor(
  database: InsightsDatabase,
  context: InsightsContext,
): Promise<void> {
  if ((await findAdvisor(database, context.userId, ADVISOR_FOLLOW_UP_ADVISOR_ID)) !== null) return;
  await registerAdvisor(database, context, { manifest: ADVISOR_FOLLOW_UP_MANIFEST, enabled: true });
}

/**
 * Check one tracked session's watcher: re-run its catalogue call, record what
 * it sees, and report into the Brief's candidate path. Writes the session's
 * `watcher`, and (for a goal or a debt plan) one `builtin` insight through the
 * validator. Never calls a model.
 */
export async function evaluateAdvisorWatcher(
  database: InsightsDatabase,
  context: InsightsContext,
  dependencies: FollowUpDependencies,
  session: StoredAdvisorSession,
): Promise<AdvisorWatcher | null> {
  const watcher = session.watcher as unknown as AdvisorWatcher | null;
  if (session.status !== 'tracked' || watcher === null) return null;
  const now = context.clock.now();
  const today = todayIn(context.clock, dependencies.catalogue.timeZone);
  let latest: WatchedValue | null = null;
  let status: AdvisorWatcher['status'] = 'watching';
  try {
    const envelope = await callCatalogueByName(
      dependencies.catalogue,
      { userId: context.userId, correlationId: context.correlationId },
      watcher.function,
      watcher.args,
    );
    if (envelope.status !== 'ok') {
      // WP 11.5e: a payoff plan with nothing left to amortise, because every debt it watched is at
      // $0.00 (or no liability is on record at all), reads $0.00 — not "not available".
      latest = watcher.kind === 'debt_balance' ? paidOffReading(watcher, envelope) : null;
      if (latest === null) status = 'not_available';
    } else if (watcher.kind === 'debt_balance') {
      const included = isRecord(envelope.result) ? envelope.result['included'] : null;
      let total = 0n;
      for (const entry of Array.isArray(included) ? included : []) {
        const value = valueOfFigure(isRecord(entry) ? figureAt(entry, 'balance') : null);
        total += BigInt(value?.value ?? '0');
      }
      latest = {
        text: formatMoneyJson({ minor: total.toString(), currency: 'USD' }) ?? total.toString(),
        value: total.toString(),
        as_of: envelope.as_of,
      };
    } else {
      const value = valueOfFigure(figureAt(envelope.result, watcher.figure_key));
      latest = value === null ? null : { ...value, as_of: envelope.as_of };
      if (latest === null) status = 'not_available';
    }
  } catch (error) {
    if (!isCatalogueRefusal(error)) throw error;
    status = error.code === 'catalogue.scope_not_granted' ? 'scope_withdrawn' : 'not_available';
  }

  // WP 11.5e: the target reached — the session completes and the watcher stops after this check.
  const reached = status === 'watching' && targetReached(latest, targetOf(watcher));
  if (reached) status = 'reached';

  // --- the Brief item: the candidate path, through the validator ------------
  let brief: AdvisorWatcher['brief'] = watcher.brief;
  const scope = SCOPE_OF[watcher.kind];
  if (scope !== undefined && (status === 'watching' || status === 'reached')) {
    brief = await writeFollowUpItem(database, context, dependencies, {
      watcher,
      scope,
      today,
    });
  }
  const next: AdvisorWatcher = {
    ...watcher,
    latest,
    direction: directionOf(watcher.baseline.value, latest?.value ?? null),
    status,
    checked_at: now.toISOString(),
    brief,
    target: targetOf(watcher),
    picked_at: watcher.picked_at ?? null,
    reached_at: reached ? now.toISOString() : (watcher.reached_at ?? null),
  };
  await transitionAdvisorSession(database, context, {
    sessionId: session.id,
    from: ['tracked'],
    // Only a reading at or below the target moves the session on; `completed` is final.
    ...(reached ? { to: 'completed' as const } : {}),
    fields: { watcher: next as unknown as Record<string, unknown> },
  });
  return next;
}

async function writeFollowUpItem(
  database: InsightsDatabase,
  context: InsightsContext,
  dependencies: FollowUpDependencies,
  input: {
    readonly watcher: AdvisorWatcher;
    readonly scope: AdvisorScope;
    readonly today: DateOnly;
  },
): Promise<AdvisorWatcher['brief']> {
  const { watcher } = input;
  // The scope must still be one the holder lets the advisor read.
  const ceiling = await narratorGrantCeiling(database, context.userId);
  if (!ceiling.includes(input.scope)) {
    return { ...watcher.brief, outcome: 'none', detail: 'scope_withdrawn' };
  }
  await ensureFollowUpAdvisor(database, context);
  const manifest = ADVISOR_FOLLOW_UP_MANIFEST;
  const limits = resolveLimits(manifest);
  const catalogue = dependencies.catalogue;
  const built = await new SnapshotBuilder(catalogue.ports.snapshot).build({
    userId: context.userId,
    kind: 'builtin',
    grantedScopes: [input.scope],
    today: input.today,
    baseCurrency: catalogue.baseCurrency,
    tokenKey: deriveTokenKey(catalogue.tokenSecret, context.userId),
  });
  const request: AdvisorRequest = {
    contract_version: ADVISOR_CONTRACT_MAJOR,
    request_id: newId(),
    advisor_id: manifest.advisor_id,
    advisor_version: manifest.version,
    kind: 'builtin',
    generated_at: context.clock.now().toISOString(),
    base_currency: catalogue.baseCurrency,
    time_zone: catalogue.timeZone,
    today: input.today,
    granted_scopes: [...built.grantedScopes],
    input_digest: built.inputDigest,
    limits: {
      max_insights: limits.maxInsights,
      max_response_bytes: limits.maxResponseBytes,
      deadline: new Date(context.clock.nowMs() + limits.timeoutMs).toISOString(),
    },
    snapshot: built.snapshot,
  };
  const insight = followUpInsightOf({
    watcher,
    snapshot: built.snapshot,
    period: input.today.slice(0, 7),
  });
  return database.transaction(async (tx) => {
    const run = await startRun(tx, context, {
      advisorId: manifest.advisor_id,
      advisorVersion: manifest.version,
      trigger: 'manual',
    });
    if (insight === null) {
      await finishRun(tx, context, {
        runId: run.id,
        status: 'completed',
        inputDigest: built.inputDigest,
        grantedScopes: [...built.grantedScopes],
        emittedScopes: [...built.grantedScopes],
        durationMs: 0,
      });
      return { ...watcher.brief, outcome: 'none' as const, detail: 'nothing_to_cite' };
    }
    const outcome = validateResponse({
      request,
      manifest,
      limits,
      body: {
        contract_version: ADVISOR_CONTRACT_MAJOR,
        request_id: request.request_id,
        advisor_id: manifest.advisor_id,
        advisor_version: manifest.version,
        produced_at: context.clock.now().toISOString(),
        diagnostics: { runtime_ms: 0, model: null, warnings: [] },
        insights: [insight],
      },
    });
    const accepted = outcome.ok ? outcome.accepted : [];
    const rejection = outcome.ok
      ? (outcome.rejected[0] ?? null)
      : { step: outcome.rejection.step, reason: outcome.rejection.reason };
    let result: AdvisorWatcher['brief'] = {
      ...watcher.brief,
      outcome: 'rejected',
      detail:
        rejection === null ? 'rejected' : `${rejection.step}:${rejection.reason}`.slice(0, 120),
    };
    const validated = accepted[0];
    if (validated !== undefined) {
      const suppression = await loadSuppression(
        tx,
        context.userId,
        manifest.advisor_id,
        validated.insight.key,
      );
      if (isSuppressed(suppression, context.clock.now())) {
        result = { ...watcher.brief, outcome: 'suppressed', detail: null };
      } else {
        await upsertInsight(tx, context, {
          validated,
          advisorId: manifest.advisor_id,
          advisorVersion: manifest.version,
          runId: run.id,
          inputDigest: built.inputDigest,
        });
        result = { ...watcher.brief, outcome: 'written', detail: null };
      }
    }
    await finishRun(tx, context, {
      runId: run.id,
      status: 'completed',
      inputDigest: built.inputDigest,
      grantedScopes: [...built.grantedScopes],
      emittedScopes: [...built.grantedScopes],
      proposedCount: 1,
      acceptedCount: accepted.length,
      rejectedCount: accepted.length === 0 ? 1 : 0,
      rejections:
        accepted.length === 0 && rejection !== null
          ? [{ step: rejection.step, reason: rejection.reason }]
          : [],
      durationMs: 0,
    });
    return result;
  });
}
