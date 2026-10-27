// SPDX-License-Identifier: MIT
/**
 * The GenAI controls self-test's catalogue (WP 10.16; RUNBOOK "Proving the
 * GenAI controls").
 *
 * Chris: "good with creating 10.16" — after "a 'Run control checks' button on
 * the Language model screen would exercise every control against your live
 * instance with your own session". Each check is a function over a port, so
 * the same function runs against fakes in a unit test and against the live
 * install in production. A check answers `pass`, `fail`, `skipped` (it could
 * not run, and says why — never a silent pass) or, for the switches' state,
 * `reported` (a holder with the module off is a valid state, not a failure).
 *
 * ## Honesty rules (binding)
 *
 *   * A check that cannot run is `skipped` with its reason. `notApplicable`
 *     marks a skip that is a property of the provider (a local model has no
 *     consent and no hourly window; a hosted one has no local pin): those do
 *     not make the overall verdict `partial`.
 *   * No check changes the holder's state outside a transaction that is
 *     rolled back, except the result row and the hourly window the probes
 *     legitimately spend. The two checks that change state to prove a refusal
 *     read the state before and after and **fail** if it differs.
 *   * Facts are sentences in words: provider and model names, counts, refusal
 *     classes (`numerals:numeral_not_placed`), durations, digests of the
 *     pinned model. Never a payload, a prompt, a key, or a model's reply.
 *
 * The api runs the checks that need only the database (`side: 'api'`); the
 * worker runs the ones that need the model (`side: 'worker'`), because the
 * api has no route to the local model by design (WP 5.2) and must not gain
 * one.
 */
import type { Clock } from '@core/kernel';
import { resolveLimits } from '../contract/manifest.ts';
import type { AdvisorRequest } from '../contract/request.ts';
import { NARRATOR_MANIFEST } from '../advisors/local/manifest.ts';
import { createNarratorAdvisor, type NarratorModelPort } from '../advisors/local/narrator.ts';
import { decideContinue, decideRun } from '../policy/kill-switches.ts';
import { RUN_WATCH_POLL_MS, watchRun } from '../policy/run-watch.ts';
import { validateResponse, type ValidationOutcome } from '../validate/pipeline.ts';
import { buildSuggestRequest, type SuggestWireRequest } from '../advisors/suggest/request.ts';
import { validateSuggestReply } from '../advisors/suggest/reply.ts';

/** The catalogue's version, stored on every row: a result is read against the checks it ran. */
export const CONTROL_CHECKS_EVIDENCE_VERSION = 'genai-controls/1';

/** The figure the numerals probe asks the model to write. In no finding the self-test sends. */
export const CONTROL_PROBE_NUMBER = '4821';

/** The probes that spend a hosted call: the level-4 cancel, the numerals and the reply-format probe. */
export const CONTROL_CHECKS_MAX_MODEL_CALLS = 3;

export const CONTROL_CHECK_IDS = [
  'approval_gate',
  'kill_level_4_cancel',
  'numerals_refusal',
  'schema_refusal',
  'egress_allowlist',
  'consent_withdrawal',
  'inspector_digest',
  'budget_window',
  'module_switch',
  'narration_badge',
  'model_pin',
  // WP 11.2: categorize.suggest's closed enum, against the live suggestion model.
  'suggest_enum_refusal',
] as const;
export type ControlCheckId = (typeof CONTROL_CHECK_IDS)[number];

export type ControlCheckSide = 'api' | 'worker';

export interface ControlCheckDefinition {
  readonly id: ControlCheckId;
  /** Plain words, for the table. */
  readonly name: string;
  /** What a pass proves, in one sentence. */
  readonly proves: string;
  readonly side: ControlCheckSide;
}

export const CONTROL_CHECKS: readonly ControlCheckDefinition[] = Object.freeze([
  {
    id: 'approval_gate',
    name: 'Payload approval gate',
    proves:
      'A narration whose payload shape has no live approval is refused payload_not_approved, and the model is never called.',
    side: 'api',
  },
  {
    id: 'kill_level_4_cancel',
    name: 'Cancel a run in flight (level 4)',
    proves:
      'Cancelling a narration while the model is answering ends the run cancelled within 2 seconds and closes the connection to the model.',
    side: 'worker',
  },
  {
    id: 'numerals_refusal',
    name: 'Numbers the app did not write',
    proves:
      'A reply that introduces a number the finding never had is refused by the validator and never reaches the Brief.',
    side: 'worker',
  },
  {
    id: 'schema_refusal',
    name: 'Replies outside the format',
    proves: 'A reply outside the narration reply format never reaches the Brief.',
    side: 'worker',
  },
  {
    id: 'egress_allowlist',
    name: 'Egress allow-list',
    proves:
      'The model adapter refuses a host it does not list before any connection is made, and allows its own.',
    side: 'worker',
  },
  {
    id: 'consent_withdrawal',
    name: 'Consent withdrawal',
    proves:
      "Withdrawing the active hosted provider's consent turns the narrator Off; using it again needs a fresh consent and withdraws the payload approval.",
    side: 'api',
  },
  {
    id: 'inspector_digest',
    name: 'Run inspector digest',
    proves:
      "The last narration's retained payload re-digests to exactly the digest its run recorded.",
    side: 'api',
  },
  {
    id: 'budget_window',
    name: 'Hourly call window',
    proves: "Every hosted call is counted against the provider's window of 30 calls an hour.",
    side: 'worker',
  },
  {
    id: 'module_switch',
    name: 'Kill switches 1 and 2',
    proves:
      'The module and model switches as they stand; asked to prove it, turning the module off refuses a run module_disabled.',
    side: 'api',
  },
  {
    id: 'narration_badge',
    name: 'Narration badge',
    proves: 'The latest narration names the provider and model its payload was approved for.',
    side: 'api',
  },
  {
    id: 'model_pin',
    name: 'Local model pin',
    proves: 'The local model the worker reaches is served at exactly the pinned digest.',
    side: 'worker',
  },
  {
    id: 'suggest_enum_refusal',
    name: 'Category suggestions stay inside your categories',
    proves:
      'A category-suggestion reply naming a category outside your own list is refused by the validator and never shown.',
    side: 'worker',
  },
] satisfies readonly ControlCheckDefinition[]);

export function controlCheckDefinition(id: ControlCheckId): ControlCheckDefinition {
  const found = CONTROL_CHECKS.find((check) => check.id === id);
  if (found === undefined) throw new Error(`unknown control check ${id}`);
  return found;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type ControlCheckStatus = 'pending' | 'running' | 'pass' | 'fail' | 'skipped' | 'reported';
export type ControlCheckVerdict = Extract<
  ControlCheckStatus,
  'pass' | 'fail' | 'skipped' | 'reported'
>;

/** What a check function returns. */
export interface ControlCheckOutcome {
  readonly status: ControlCheckVerdict;
  /** Why it failed or was skipped, in words. `null` for a pass or a report. */
  readonly reason: string | null;
  /** What was observed, in words. Never a payload, a prompt, a key or a reply. */
  readonly facts: readonly string[];
  /** A skip that is a property of the provider, not something that went wrong. */
  readonly notApplicable: boolean;
}

/** One row of `ops_control_checks.results`. */
export interface ControlCheckRow {
  readonly id: ControlCheckId;
  readonly name: string;
  readonly proves: string;
  readonly side: ControlCheckSide;
  readonly status: ControlCheckStatus;
  readonly reason: string | null;
  readonly facts: readonly string[];
  readonly notApplicable: boolean;
  readonly durationMs: number | null;
}

export type ControlChecksOverall = 'pass' | 'fail' | 'partial';

export function pass(facts: readonly string[]): ControlCheckOutcome {
  return { status: 'pass', reason: null, facts, notApplicable: false };
}
export function fail(reason: string, facts: readonly string[] = []): ControlCheckOutcome {
  return { status: 'fail', reason, facts, notApplicable: false };
}
export function skipped(
  reason: string,
  facts: readonly string[] = [],
  options: { readonly notApplicable?: boolean } = {},
): ControlCheckOutcome {
  return { status: 'skipped', reason, facts, notApplicable: options.notApplicable === true };
}
export function reported(facts: readonly string[]): ControlCheckOutcome {
  return { status: 'reported', reason: null, facts, notApplicable: false };
}

export function pendingRow(definition: ControlCheckDefinition): ControlCheckRow {
  return {
    id: definition.id,
    name: definition.name,
    proves: definition.proves,
    side: definition.side,
    status: 'pending',
    reason: null,
    facts: [],
    notApplicable: false,
    durationMs: null,
  };
}

export function rowOf(
  definition: ControlCheckDefinition,
  outcome: ControlCheckOutcome,
  durationMs: number,
): ControlCheckRow {
  return {
    ...pendingRow(definition),
    status: outcome.status,
    reason: outcome.reason,
    facts: [...outcome.facts],
    notApplicable: outcome.notApplicable,
    durationMs: Math.max(0, Math.round(durationMs)),
  };
}

/**
 * `fail` if any check failed; `partial` if none failed but one that applies
 * could not run (or never finished); `pass` otherwise. A `reported` row and a
 * not-applicable skip count for neither.
 */
export function overallOf(rows: readonly ControlCheckRow[]): ControlChecksOverall {
  if (rows.some((row) => row.status === 'fail')) return 'fail';
  if (
    rows.some(
      (row) =>
        row.status === 'pending' ||
        row.status === 'running' ||
        (row.status === 'skipped' && !row.notApplicable),
    )
  ) {
    return 'partial';
  }
  return 'pass';
}

/**
 * Run one check, timed, total: a check that throws is `skipped` with the
 * error's class, never its message (a message could quote what it was
 * handling) — and never a pass.
 */
export async function runCheck(
  definition: ControlCheckDefinition,
  clock: Clock,
  check: () => Promise<ControlCheckOutcome>,
): Promise<ControlCheckRow> {
  const started = clock.nowMs();
  let outcome: ControlCheckOutcome;
  try {
    outcome = await check();
  } catch (error) {
    outcome = skipped(`The check could not run (${errorClass(error)}).`);
  }
  return rowOf(definition, outcome, clock.nowMs() - started);
}

/** A closed-vocabulary label for an error: a code when it has one, else its class name. */
export function errorClass(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^[a-z][a-z0-9_.:-]{0,63}$/u.test(code)) return code;
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(name)) return name;
  }
  return 'error';
}

// ---------------------------------------------------------------------------
// The api's checks: the database, never the model
// ---------------------------------------------------------------------------

export interface ApprovalState {
  /** Live (unrevoked) approvals of the narrator for this holder. */
  readonly live: number;
  /** A digest over every narrator approval row's id and revocation: equal before and after, or something changed. */
  readonly digest: string;
}

export interface ApprovalGateAttempt {
  /** `current`: the holder's narrator's shape now. `synthetic`: no narrator is configured; a shape that never had an approval. */
  readonly shape: 'current' | 'synthetic';
  /** Whether that shape had a live approval before the check withdrew it (inside the rolled-back transaction). */
  readonly hadApproval: boolean;
  readonly status: 'completed' | 'failed' | 'refused' | 'cancelled';
  readonly refusal: string | null;
  /** Whether the check's model port — a sentinel that sends nothing — was reached. */
  readonly modelReached: boolean;
}

export interface ApprovalGatePort {
  approvalState(): Promise<ApprovalState>;
  /**
   * In a transaction that is rolled back at the end: withdraw the approval of
   * the narrator's current shape, attempt a narrator run through `runAdvisor`
   * with a sentinel model port, and report what the run did.
   */
  attemptWithoutApproval(): Promise<ApprovalGateAttempt>;
}

export async function checkApprovalGate(port: ApprovalGatePort): Promise<ControlCheckOutcome> {
  const before = await port.approvalState();
  const attempt = await port.attemptWithoutApproval();
  const after = await port.approvalState();
  const facts = [
    attempt.shape === 'current'
      ? `The narrator's current payload shape ${attempt.hadApproval ? 'had a live approval, withdrawn for the check' : 'had no live approval'}.`
      : 'No narrator is configured, so a synthetic payload shape that never had an approval was used.',
    `The run was ${attempt.status}${attempt.refusal === null ? '' : ` (${attempt.refusal})`}.`,
    attempt.modelReached ? 'The model port was reached.' : 'The model was never called.',
    `Live approvals before the check: ${String(before.live)}; after: ${String(after.live)}.`,
  ];
  if (after.digest !== before.digest || after.live !== before.live) {
    return fail(
      "The holder's payload approvals changed: the check's transaction was not rolled back.",
      facts,
    );
  }
  if (attempt.modelReached) {
    return fail('The model was reached without an approval.', facts);
  }
  if (attempt.status !== 'refused' || attempt.refusal !== 'payload_not_approved') {
    return fail('The run was not refused payload_not_approved.', facts);
  }
  return pass(facts);
}

export type NarratorProviderName = 'ollama' | 'openai' | 'openrouter' | 'anthropic' | 'off';
export type HostedProviderName = 'openai' | 'openrouter' | 'anthropic';

export function isHostedProviderName(value: string): value is HostedProviderName {
  return value === 'openai' || value === 'openrouter' || value === 'anthropic';
}

export interface ConsentWithdrawalSimulation {
  /** The active provider read back after `withdrawNarratorConsent`, inside the transaction. */
  readonly activeAfter: NarratorProviderName;
  /** Whether `setActiveNarratorProvider` then refused to make the provider active again without a consent. */
  readonly reactivationRefused: boolean;
  /** Live narrator approvals inside the transaction before the withdrawal. */
  readonly liveApprovals: number;
  /** Approvals revoked when the provider was made active again after a fresh consent (inside the transaction). */
  readonly revokedOnReturn: number;
}

export interface ConsentWithdrawalPort {
  activeProvider(): Promise<NarratorProviderName>;
  /** A digest over the holder's narrator settings, consents and approvals: equal before and after. */
  state(): Promise<string>;
  /** Through the code path the Settings screen uses, in a transaction that is rolled back. */
  simulateWithdrawal(provider: HostedProviderName): Promise<ConsentWithdrawalSimulation>;
}

export async function checkConsentWithdrawal(
  port: ConsentWithdrawalPort,
): Promise<ControlCheckOutcome> {
  const provider = await port.activeProvider();
  if (!isHostedProviderName(provider)) {
    return provider === 'off'
      ? skipped(
          'The narrator is Off: there is no hosted provider whose consent could be withdrawn.',
          [],
          {
            notApplicable: true,
          },
        )
      : skipped('The local provider has no consent.', [], { notApplicable: true });
  }
  const before = await port.state();
  const result = await port.simulateWithdrawal(provider);
  const after = await port.state();
  const facts = [
    `With the consent withdrawn the narrator read back as ${result.activeAfter === 'off' ? 'Off' : result.activeAfter}.`,
    result.reactivationRefused
      ? `Making ${provider} active again without a consent was refused.`
      : `Making ${provider} active again without a consent was allowed.`,
    `After a fresh consent, making ${provider} active again withdrew ${String(result.revokedOnReturn)} of ${String(result.liveApprovals)} live payload approval(s).`,
  ];
  if (after !== before) {
    return fail(
      "The holder's settings, consents or approvals changed: the check's transaction was not rolled back.",
      facts,
    );
  }
  if (result.activeAfter !== 'off')
    return fail('Withdrawing the consent left the narrator on.', facts);
  if (!result.reactivationRefused) {
    return fail('The provider could be made active again without a consent.', facts);
  }
  if (result.revokedOnReturn !== result.liveApprovals) {
    return fail('Using the provider again did not withdraw every payload approval.', facts);
  }
  return pass([...facts, 'Nothing was changed: the transaction was rolled back.']);
}

export interface InspectorPort {
  /** The holder's most recent narrator run with a payload still retained (30 days). */
  latestNarratorRun(): Promise<{ readonly runId: string; readonly startedAt: Date } | null>;
  inspect(runId: string): Promise<{
    readonly verified: boolean;
    readonly recordedDigest: string | null;
    readonly recomputedDigest: string;
  } | null>;
}

function shortDigest(digest: string | null): string {
  if (digest === null) return 'none';
  const hex = digest.replace(/^sha256:/u, '');
  return `sha256:${hex.slice(0, 12)}…`;
}

export async function checkInspectorDigest(port: InspectorPort): Promise<ControlCheckOutcome> {
  const run = await port.latestNarratorRun();
  if (run === null) {
    return skipped('No narration has run yet with its payload retained (the last 30 days).');
  }
  const inspection = await port.inspect(run.runId);
  if (inspection === null) {
    return skipped("The last narration's payload is no longer retained.");
  }
  const facts = [
    `The narration of ${run.startedAt.toISOString().slice(0, 10)} recorded ${shortDigest(inspection.recordedDigest)}.`,
    `Its retained payload re-digests to ${shortDigest(inspection.recomputedDigest)}.`,
  ];
  return inspection.verified
    ? pass(facts)
    : fail('The retained payload does not re-digest to what the run recorded.', facts);
}

export interface SwitchLevels {
  /** Level 1, operator: `ADVISORS_ENABLED`. */
  readonly advisorsEnabled: boolean;
  /** Level 1, the holder: `module.insights`. */
  readonly moduleEnabled: boolean;
  /** Level 2: the local_model kind flag. */
  readonly kindFlag: boolean;
  /** Level 2's other half: something is configured to narrate for this holder. */
  readonly kindConfigured: boolean;
}

export interface ModuleSwitchPort {
  levels(): Promise<SwitchLevels>;
  /**
   * In a transaction that is rolled back: write `module.insights` off for this
   * holder, read it back through an uncached flag reader and ask `decideRun`.
   */
  proveModuleOff(): Promise<{ readonly refusal: string | null }>;
  /** A digest of the holder's flag rows: equal before and after the proof. */
  flagState(): Promise<string>;
}

const onOff = (value: boolean): string => (value ? 'on' : 'off');

export async function checkModuleSwitch(
  port: ModuleSwitchPort,
  options: { readonly prove: boolean },
): Promise<ControlCheckOutcome> {
  const levels = await port.levels();
  const facts = [
    `Level 1: the operator's ADVISORS_ENABLED is ${onOff(levels.advisorsEnabled)}; your insights module is ${onOff(levels.moduleEnabled)}.`,
    `Level 2: the local-model kind switch is ${onOff(levels.kindFlag)}; a narrator is ${levels.kindConfigured ? '' : 'not '}configured for you.`,
  ];
  if (!options.prove) return reported(facts);
  if (!levels.advisorsEnabled) {
    return skipped(
      "The operator's ADVISORS_ENABLED is off, so level 1's broader half refuses first; the holder's switch cannot be shown on its own.",
      facts,
    );
  }
  const before = await port.flagState();
  const proof = await port.proveModuleOff();
  const after = await port.flagState();
  facts.push(
    `With the module switched off (in a transaction rolled back after), a run was ${proof.refusal === null ? 'allowed' : `refused ${proof.refusal}`}.`,
  );
  if (after !== before) {
    return fail(
      "The holder's switches changed: the check's transaction was not rolled back.",
      facts,
    );
  }
  return proof.refusal === 'module_disabled'
    ? pass(facts)
    : fail('Turning the module off did not refuse a run module_disabled.', facts);
}

/** `decideRun` with level 1's holder half as given and every other switch on: the switch on its own. */
export function moduleOnlyDecision(moduleEnabled: boolean): string | null {
  const decision = decideRun({
    advisorsEnabled: true,
    moduleEnabled,
    kindEnabled: true,
    advisorEnabled: true,
    quarantinedAt: null,
    payloadApproved: true,
  });
  return decision.run ? null : decision.refusal;
}

export interface LatestNarration {
  readonly at: Date;
  /** `advisor_runs.llm_model` of the run that wrote it. */
  readonly runModel: string | null;
  /** Whether the approval the run ran under could be found (its retained payload names the shape; 30 days). */
  readonly approvalFound: boolean;
  /** What the run's payload approval was given for. `null` before WP 10.6 recorded it. */
  readonly approvedProvider: string | null;
  readonly approvedModel: string | null;
  /** What the Brief's badge says, through the Brief's own `narratedByOf`. */
  readonly badge: { readonly provider: string; readonly model: string } | null;
}

export interface NarrationBadgePort {
  latestNarration(): Promise<LatestNarration | null>;
}

export async function checkNarrationBadge(port: NarrationBadgePort): Promise<ControlCheckOutcome> {
  const narration = await port.latestNarration();
  if (narration === null) return skipped('No narration on the Brief yet.');
  const date = narration.at.toISOString().slice(0, 10);
  const facts = [
    `The narration of ${date} was written by ${narration.runModel ?? 'an unrecorded model'}.`,
    narration.badge === null
      ? 'Its badge names no provider.'
      : `Its badge reads ${narration.badge.provider} ${narration.badge.model}.`,
  ];
  if (!narration.approvalFound) {
    return skipped(
      'The approval this narration ran under can no longer be found (its payload record is past the 30-day bound).',
      facts,
    );
  }
  if (narration.approvedModel === null || narration.approvedProvider === null) {
    return skipped(
      'The approval this narration ran under predates the record of its provider and model (WP 10.6).',
      facts,
    );
  }
  facts.push(
    `Its payload was approved for ${narration.approvedProvider} (${narration.approvedModel}).`,
  );
  if (narration.runModel !== narration.approvedModel) {
    return fail('The narration was written by a model its approval does not name.', facts);
  }
  if (narration.badge === null || narration.badge.provider !== narration.approvedProvider) {
    return fail('The badge does not name the provider the payload was approved for.', facts);
  }
  return pass(facts);
}

// ---------------------------------------------------------------------------
// The worker's checks: the model, through the narrator's own path
// ---------------------------------------------------------------------------

export type ControlProbeId = 'cancel' | 'numerals' | 'schema';

export interface EgressClassification {
  readonly allowed: boolean;
  readonly code: string | null;
}

/**
 * The holder's narrator as the self-test reaches it in the worker: the
 * adapter's control probes (the narration's own render, format and wrap, plus
 * one fixed instruction), its abort counter, its hourly window, its egress
 * policy as a classifier, and — the local model only — its pin.
 */
export interface ControlProbeModel {
  readonly provider: 'ollama' | HostedProviderName;
  /** `provider:model` or `name@sha256:…`. */
  readonly label: string;
  probe(id: ControlProbeId): NarratorModelPort;
  aborts(): number;
  readonly budget: {
    readonly maxRequests: number;
    readonly windowMs: number;
    remaining(nowMs: number): number;
  } | null;
  readonly egress:
    | {
        readonly kind: 'hosted';
        /** The one URL the adapter posts to. */
        readonly url: string;
        classify(url: string): EgressClassification;
      }
    | {
        readonly kind: 'local';
        classify(endpoint: string): EgressClassification;
        configured(): EgressClassification;
      };
  modelPin?(
    signal: AbortSignal,
  ): Promise<{ readonly pinned: string; readonly served: string | null }>;
}

/**
 * WP 11.2: the holder's category-suggestion model as the self-test reaches it
 * — the suggestion adapter's control probe (its own render, format and digest
 * pin, plus one fixed instruction asking for a key outside the taxonomy).
 */
export interface SuggestProbeModel {
  readonly label: string;
  /** The key the fixed instruction asks for. */
  readonly outsideKey: string;
  probe(request: SuggestWireRequest, signal: AbortSignal): Promise<{ readonly reply: unknown }>;
}

/** The synthetic request the enum probe sends: two invented categories, one invented row. */
export const SUGGEST_PROBE_TAXONOMY = Object.freeze([
  Object.freeze({ key: 'selftest.alpha', label: 'Self-test alpha' }),
  Object.freeze({ key: 'selftest.beta', label: 'Self-test beta' }),
]);

export async function checkSuggestEnumRefusal(
  context: WorkerCheckContext,
): Promise<ControlCheckOutcome> {
  const model = context.suggest ?? null;
  if (model === null) {
    return skipped('No category-suggestion model is configured for you.', [], {
      notApplicable: true,
    });
  }
  const built = buildSuggestRequest({
    taxonomy: SUGGEST_PROBE_TAXONOMY,
    rows: [
      {
        payee_tokens: ['selftest', 'merchant'],
        mcc_family: null,
        pfc_primary: null,
        amount_bucket: '2',
        account_kind: 'credit',
        direction: 'out',
        day_bucket: 'mid',
      },
    ],
    now: context.clock.now(),
    timeoutMs: context.timing?.probeTimeoutMs ?? PROBE_TIMEOUT_MS,
    maxResponseBytes: 65_536,
  });
  const controller = new AbortController();
  const outcome = await Promise.race([
    settle(model.probe(built.request, controller.signal)),
    delay(context.timing?.probeTimeoutMs ?? PROBE_TIMEOUT_MS),
  ]);
  // Not counted in `probesSent`: that counts the narrator's window (budget_window),
  // and this probe goes to the suggestion model, which has its own.
  if (outcome === 'timeout') {
    controller.abort();
    return skipped('The probe did not answer in time.');
  }
  if (!outcome.ok)
    return skipped(`The probe could not reach the model (${errorClass(outcome.error)}).`);
  const validation = validateSuggestReply(outcome.value.reply, {
    refs: built.request.rows.map((row) => row.transaction_ref),
    categoryKeys: new Set(SUGGEST_PROBE_TAXONOMY.map((entry) => entry.key)),
  });
  const facts = [
    `Asked ${model.label} to suggest the category ${model.outsideKey}, which is not in the list it was given.`,
  ];
  const leaked = validation.suggestions.filter(
    (entry) => !SUGGEST_PROBE_TAXONOMY.some((category) => category.key === entry.categoryKey),
  );
  if (leaked.length > 0) {
    return fail('A suggestion outside the list got through the validator.', facts);
  }
  if (validation.replyRefusal !== null) {
    facts.push('The reply was refused whole (outside the reply format); nothing was shown.');
    return pass(facts);
  }
  if (validation.refusals.some((entry) => entry.refusal === 'unknown_category')) {
    facts.push(
      'The model obeyed; the validator refused the key (unknown_category) and nothing was shown.',
    );
    return pass(facts);
  }
  facts.push(
    validation.suggestions.length > 0
      ? 'The model declined and answered from the list instead.'
      : 'The model declined and abstained.',
  );
  return pass(facts);
}

export interface WorkerCheckContext {
  /** WP 11.2: the holder's suggestion model, or `null`/absent when none is configured. */
  readonly suggest?: SuggestProbeModel | null;
  /** `null` with `unavailable` set when the holder has no narrator the worker can reach. */
  readonly model: ControlProbeModel | null;
  readonly unavailable: string | null;
  /** The fixed, synthetic narration request (`CONTROL_PROBE_REQUEST`). */
  readonly request: AdvisorRequest;
  readonly clock: Clock;
  /** Probes sent so far (each spends one call of a hosted window). */
  probesSent: number;
  /** The window's `remaining` before the first probe; `null` for the local model. */
  readonly budgetBefore: number | null;
  /** Tests only: the validator (production: `validateAsNarration`, i.e. `validateResponse` as a run calls it). */
  readonly validate?: (request: AdvisorRequest, body: unknown) => ValidationOutcome;
  readonly timing?: {
    readonly pollMs?: number;
    readonly cancelAfterMs?: number;
    readonly limitMs?: number;
    readonly probeTimeoutMs?: number;
  };
}

/** The level-4 cancel's measured bound: the run reads cancelled within this of the cancel. */
export const CANCEL_LIMIT_MS = 2_000;
/** The cancel lands this soon after the probe starts. */
export const CANCEL_AFTER_MS = 150;
/** A probe that has not answered in this long is given up on. */
export const PROBE_TIMEOUT_MS = 150_000;

function noModel(context: WorkerCheckContext): ControlCheckOutcome | null {
  if (context.model !== null) return null;
  return skipped(context.unavailable ?? 'No narrator is configured for you.');
}

const ALL_ON = {
  advisorsEnabled: true,
  moduleEnabled: true,
  kindEnabled: true,
  advisorEnabled: true,
  quarantinedAt: null,
  payloadApproved: true,
} as const;

function settle<T>(
  promise: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

function delay(ms: number): Promise<'timeout'> {
  return new Promise((resolve) => {
    setTimeout(() => resolve('timeout'), ms);
  });
}

/**
 * Level 4, in flight: the real watcher (`watchRun`, its production one-second
 * poll) over the real verdict (`decideContinue`), with the run's cancel flag
 * set by this check 150 ms after the probe starts. The probe run is not an
 * `advisor_runs` row — writing one would change the holder's history — so the
 * flag is the check's own; the watcher, the verdict and the adapter's abort
 * path are production's.
 */
export async function checkCancelInFlight(
  context: WorkerCheckContext,
): Promise<ControlCheckOutcome> {
  const missing = noModel(context);
  if (missing !== null || context.model === null) return missing ?? skipped('No narrator.');
  const model = context.model;
  const pollMs = context.timing?.pollMs ?? RUN_WATCH_POLL_MS;
  const cancelAfterMs = context.timing?.cancelAfterMs ?? CANCEL_AFTER_MS;
  const limitMs = context.timing?.limitMs ?? CANCEL_LIMIT_MS;
  const clock = context.clock;

  const controller = new AbortController();
  let cancelledAt: number | null = null;
  let abortedAt: number | null = null;
  controller.signal.addEventListener('abort', () => {
    abortedAt = clock.nowMs();
  });
  const watch = watchRun({
    controller,
    pollMs,
    probe: () =>
      Promise.resolve(
        decideContinue({
          ...ALL_ON,
          cancelRequestedAt: cancelledAt === null ? null : new Date(cancelledAt),
        }),
      ),
  });
  const abortsBefore = model.aborts();
  const started = clock.nowMs();
  context.probesSent += 1;
  const advisor = createNarratorAdvisor({ model: model.probe('cancel') });
  const call = settle(advisor.run(context.request, controller.signal));
  const timer = setTimeout(() => {
    cancelledAt = clock.nowMs();
  }, cancelAfterMs);
  const first = await Promise.race([call, delay(cancelAfterMs + limitMs + pollMs)]);
  clearTimeout(timer);
  // After the abort, give the transport a moment to close the socket.
  const result = first === 'timeout' ? await Promise.race([call, delay(1_000)]) : first;
  await watch.stop();

  const reason = watch.reason();
  const facts: string[] = [];
  if (result !== 'timeout' && result.ok && abortedAt === null) {
    return skipped(
      `The model answered in ${String(clock.nowMs() - started)} ms, before the cancel could land: nothing was in flight to cancel.`,
    );
  }
  if (result !== 'timeout' && !result.ok && abortedAt === null) {
    return skipped(`The probe could not reach the model (${errorClass(result.error)}).`);
  }
  const cancelAt: number | null = cancelledAt;
  const abortAt: number | null = abortedAt;
  if (cancelAt === null || abortAt === null) {
    return fail('The run was never cancelled.', facts);
  }
  const tookMs = abortAt - cancelAt;
  facts.push(
    `Cancelled ${String(cancelAt - started)} ms after the probe started; the run read ${reason ?? 'not cancelled'} ${String(tookMs)} ms later.`,
  );
  const abortsAfter = model.aborts();
  const closed = abortsAfter > abortsBefore;
  facts.push(
    closed
      ? 'The adapter saw the cancel reach its open connection and closed it.'
      : 'The adapter did not report a closed connection.',
  );
  if (reason !== 'run_cancelled') return fail('The run did not read run_cancelled.', facts);
  if (tookMs > limitMs) {
    return fail(
      `The run took ${String(tookMs)} ms to read cancelled (limit ${String(limitMs)} ms).`,
      facts,
    );
  }
  if (result === 'timeout') {
    return fail(
      'The model call was still running after the cancel: the connection was not closed.',
      facts,
    );
  }
  if (!closed) return fail('The cancel never reached the connection to the model.', facts);
  return pass(facts);
}

/** `validateResponse` exactly as `service.ts` calls it for a narrator run. */
export function validateAsNarration(request: AdvisorRequest, body: unknown): ValidationOutcome {
  return validateResponse({
    request,
    manifest: NARRATOR_MANIFEST,
    limits: resolveLimits(NARRATOR_MANIFEST),
    body,
    knownFindingTypes: new Set(request.findings?.map((finding) => finding.type) ?? []),
  });
}

/** One probe through the narrator's own advisor, bounded; the raw adapter reply kept for the format check. */
async function sendProbe(
  context: WorkerCheckContext,
  model: ControlProbeModel,
  id: ControlProbeId,
): Promise<
  | { readonly ok: true; readonly raw: unknown; readonly body: unknown }
  | { readonly ok: false; readonly code: string }
> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('control_probe_timeout')),
    context.timing?.probeTimeoutMs ?? PROBE_TIMEOUT_MS,
  );
  let raw: unknown = undefined;
  const port = model.probe(id);
  const capturing: NarratorModelPort = {
    run: async (request, signal) => {
      raw = await port.run(request, signal);
      return raw;
    },
  };
  context.probesSent += 1;
  try {
    const body = await createNarratorAdvisor({ model: capturing }).run(
      context.request,
      controller.signal,
    );
    return { ok: true, raw, body };
  } catch (error) {
    return { ok: false, code: controller.signal.aborted ? 'probe_timeout' : errorClass(error) };
  } finally {
    clearTimeout(timer);
  }
}

const NUMBER_PATTERN = new RegExp(
  `${CONTROL_PROBE_NUMBER.slice(0, 1)}[,.\\s\\u00a0\\u202f]?${CONTROL_PROBE_NUMBER.slice(1)}`,
  'u',
);

/** The rendered fields of an accepted narration, as the holder would read them. */
function renderedText(insight: unknown): string {
  return JSON.stringify(insight);
}

export async function checkNumeralsRefusal(
  context: WorkerCheckContext,
): Promise<ControlCheckOutcome> {
  const missing = noModel(context);
  if (missing !== null || context.model === null) return missing ?? skipped('No narrator.');
  const sent = await sendProbe(context, context.model, 'numerals');
  if (!sent.ok) return skipped(`The probe could not reach the model (${sent.code}).`);
  const outcome = (context.validate ?? validateAsNarration)(context.request, sent.body);
  const facts = [`Asked ${context.model.label} to write ${CONTROL_PROBE_NUMBER} into a narration.`];
  if (!outcome.ok) {
    facts.push(
      `The reply was refused whole at ${outcome.rejection.step} (${outcome.rejection.reason}); the number never reached the Brief.`,
    );
    return pass(facts);
  }
  const leaked = outcome.accepted.filter((entry) =>
    NUMBER_PATTERN.test(renderedText(entry.insight)),
  );
  if (leaked.length > 0) {
    facts.push(`${String(leaked.length)} narration(s) carrying the number were accepted.`);
    return fail(`The number ${CONTROL_PROBE_NUMBER} got through the validator.`, facts);
  }
  const numerals = outcome.rejected.find((rejection) => rejection.step === 'numerals');
  if (numerals !== undefined) {
    facts.push(`Refused by the numerals check (numerals:${numerals.reason}).`);
    return pass(facts);
  }
  const other = outcome.rejected[0];
  if (other !== undefined) {
    facts.push(
      `Refused at ${other.step}:${other.reason}, before the numerals check; the number never reached the Brief.`,
    );
    return pass(facts);
  }
  facts.push('The model declined to introduce a number.');
  return pass(facts);
}

export async function checkSchemaRefusal(
  context: WorkerCheckContext,
): Promise<ControlCheckOutcome> {
  const missing = noModel(context);
  if (missing !== null || context.model === null) return missing ?? skipped('No narrator.');
  const sent = await sendProbe(context, context.model, 'schema');
  if (!sent.ok) return skipped(`The probe could not reach the model (${sent.code}).`);
  const raw = sent.raw as { insights?: unknown } | null | undefined;
  const outsideFormat =
    raw === null || raw === undefined || typeof raw !== 'object' || !Array.isArray(raw.insights);
  const outcome = (context.validate ?? validateAsNarration)(context.request, sent.body);
  const facts = [`Asked ${context.model.label} to reply in prose, outside the reply format.`];
  if (!outcome.ok) {
    facts.push(`The reply was refused at ${outcome.rejection.step} (${outcome.rejection.reason}).`);
    return pass(facts);
  }
  if (outsideFormat) {
    facts.push(`${String(outcome.accepted.length)} narration(s) accepted.`);
    return fail('A reply outside the format was accepted.', facts);
  }
  facts.push(
    `The reply arrived inside the narration format: the format pin held at the model (${String(outcome.accepted.length)} accepted, ${String(outcome.rejected.length)} refused by the validator).`,
  );
  return pass(facts);
}

/** A host no adapter lists. */
export const UNLISTED_EGRESS_URL = 'https://example.com/v1/messages';
/** A public, dotted, TLS endpoint: what the local-endpoint policy exists to refuse. */
export const UNLISTED_LOCAL_ENDPOINT = 'https://example.com:443';

export function checkEgressAllowlist(context: WorkerCheckContext): Promise<ControlCheckOutcome> {
  const missing = noModel(context);
  if (missing !== null || context.model === null) {
    return Promise.resolve(missing ?? skipped('No narrator.'));
  }
  const egress = context.model.egress;
  if (egress.kind === 'hosted') {
    const unlisted = egress.classify(UNLISTED_EGRESS_URL);
    const listed = egress.classify(egress.url);
    const host = new URL(egress.url).host;
    const facts = [
      unlisted.allowed
        ? 'example.com was allowed.'
        : `example.com was refused by the policy before any connection (${unlisted.code ?? 'refused'}).`,
      listed.allowed
        ? `${host} (https, port 443) was allowed.`
        : `${host} was refused (${listed.code ?? 'refused'}).`,
      'The policy was asked; nothing was resolved or dialled.',
    ];
    if (unlisted.allowed)
      return Promise.resolve(fail('A host the adapter does not list was allowed.', facts));
    if (!listed.allowed) return Promise.resolve(fail("The adapter's own host was refused.", facts));
    return Promise.resolve(pass(facts));
  }
  const unlisted = egress.classify(UNLISTED_LOCAL_ENDPOINT);
  const configured = egress.configured();
  const facts = [
    unlisted.allowed
      ? 'A public endpoint (example.com) was allowed for the local model.'
      : `A public endpoint (example.com) was refused by the local-endpoint policy (${unlisted.code ?? 'refused'}).`,
    configured.allowed
      ? 'The configured local endpoint was allowed.'
      : `The configured local endpoint was refused (${configured.code ?? 'refused'}).`,
    'The policy was asked; nothing was resolved or dialled.',
  ];
  if (unlisted.allowed) {
    return Promise.resolve(fail('The local-endpoint policy allowed a public endpoint.', facts));
  }
  if (!configured.allowed) {
    return Promise.resolve(fail('The configured local endpoint was refused.', facts));
  }
  return Promise.resolve(pass(facts));
}

/** The provider's window this release ships: 30 calls an hour (`HOSTED_RATE_WINDOW`). */
export const EXPECTED_WINDOW = Object.freeze({ maxRequests: 30, windowMs: 60 * 60_000 });

export function checkBudgetWindow(context: WorkerCheckContext): Promise<ControlCheckOutcome> {
  const missing = noModel(context);
  if (missing !== null || context.model === null) {
    return Promise.resolve(missing ?? skipped('No narrator.'));
  }
  const budget = context.model.budget;
  if (budget === null || context.budgetBefore === null) {
    return Promise.resolve(
      skipped('The local model has no hourly window.', [], { notApplicable: true }),
    );
  }
  const after = budget.remaining(context.clock.nowMs());
  const counted = context.budgetBefore - after;
  const facts = [
    `The window counted ${String(counted)} call(s) for ${String(context.probesSent)} probe(s) sent.`,
    `The window is ${String(budget.maxRequests)} calls per ${String(Math.round(budget.windowMs / 60_000))} minutes; ${String(after)} left.`,
  ];
  if (
    budget.maxRequests !== EXPECTED_WINDOW.maxRequests ||
    budget.windowMs !== EXPECTED_WINDOW.windowMs
  ) {
    return Promise.resolve(fail('The window is not 30 calls an hour.', facts));
  }
  if (counted !== context.probesSent) {
    return Promise.resolve(
      fail(
        counted > context.probesSent
          ? 'The window advanced by more than the probes sent (another call spent it during the check).'
          : 'A probe was not counted against the window.',
        facts,
      ),
    );
  }
  return Promise.resolve(pass(facts));
}

export async function checkModelPin(context: WorkerCheckContext): Promise<ControlCheckOutcome> {
  const missing = noModel(context);
  if (missing !== null || context.model === null) return missing ?? skipped('No narrator.');
  const model = context.model;
  if (model.provider !== 'ollama' || model.modelPin === undefined) {
    return skipped('A hosted provider has no local model pin.', [], { notApplicable: true });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let pin: { readonly pinned: string; readonly served: string | null };
  try {
    pin = await model.modelPin(controller.signal);
  } catch (error) {
    return skipped(`The local model could not be reached (${errorClass(error)}).`);
  } finally {
    clearTimeout(timer);
  }
  const facts = [
    `Pinned: ${shortDigest(pin.pinned)}.`,
    pin.served === null ? 'The pinned name is not served.' : `Served: ${shortDigest(pin.served)}.`,
  ];
  if (pin.served === null) return fail('The pinned model is not served.', facts);
  if (pin.served !== pin.pinned) return fail('The served model is not the pinned digest.', facts);
  return pass(facts);
}
