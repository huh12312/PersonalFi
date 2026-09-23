// SPDX-License-Identifier: MIT
/**
 * The built-in catalogue: which 07 §3.3 rules ship, which are off, and which
 * cannot be written yet — each with the reason, as data.
 *
 * ## Three states, not two
 *
 * A rule is **enabled**, **registered but off**, or **unavailable**, and the
 * difference between the last two is the whole point of this file:
 *
 *   * *Registered but off* is a wave decision. 02-phase-2-dispatch.md §6 Q4:
 *     "rules released in waves (cash + subscriptions first) so the first run is
 *     not a wall of red". The spending rules are built, tested, and proven on the
 *     seed; they are simply not switched on for the first run. Turning one on is
 *     a single `advisors.enabled` update — kill switch 2 in reverse — and needs
 *     no deploy.
 *   * *Unavailable* is a data statement. U4 needs a vendor price table; C5 needs
 *     a card's credit limit; S1 needs an exact transaction amount that 03 §8.3
 *     deliberately replaces with a band. Each is listed in `CATALOGUE_GAPS` with
 *     the field it would need, so "we forgot U5" and "U5 cannot be written from
 *     Phase 2 data" are distinguishable a year from now.
 *
 * `catalog.test.ts` asserts that every rule id in WP 2.7's declared scope — U1–U8,
 * C1–C7, and the S-subset 02 §3 names — appears in exactly one of the two lists.
 * That is what stops the catalogue quietly shrinking.
 *
 * ## Registration is not enablement
 *
 * Every implemented rule is **registered** with the `AdvisorRegistry` regardless
 * of its wave: registration is the manifest review (scopes, kind, egress), and
 * an unregistered advisor cannot be turned on at all. Enablement is a column
 * (`advisors.enabled`, default `FALSE` — WP 2.6's kill switch 2), and
 * `defaultEnabled` below is what a composition root passes to `registerAdvisor`
 * the first time it writes the row. A restart never re-enables a rule the user
 * switched off: `registerAdvisor`'s conflict branch deliberately does not touch
 * `enabled`.
 */
import type { AdvisorRequest } from '../contract/request.ts';
import { ADVISOR_CONTRACT_MAJOR } from '../contract/version.ts';
import { AdvisorRegistry, type Advisor } from '../registry.ts';
import { CRYPTO_RULES } from './builtin/crypto/index.ts';
import { DEBT_RULES } from './builtin/debt/index.ts';
import { INVESTING_RULES } from './builtin/investing/index.ts';
import { CASH_RULES } from './rules-cash.ts';
import { SPENDING_RULES } from './rules-spending.ts';
import { SUBSCRIPTION_RULES } from './rules-subscriptions.ts';
import { contextOf, type BuiltinRule } from './support.ts';

/**
 * 07 §7.4's release waves.
 *
 * *"release rules in waves (week 1: cash + subscriptions; week 2: debt; week 3:
 * investing; week 4: retirement) so the first run isn't overwhelming."* WP 3.10
 * adds the middle three; retirement waits for Phase 4's planning context.
 * Crypto is its own wave rather than folded into investing, because a
 * deployment with no crypto has nothing to release and one with crypto gets
 * X1 — a P0 — which should not be queued behind six investing rules.
 */
export type RuleWave = 'cash_and_subscriptions' | 'spending' | 'debt' | 'investing' | 'crypto';

/**
 * 07 §3.3's priority column, carried as data.
 *
 * Recorded per rule so "which of these is P0" is a field rather than a
 * re-reading of a research document, and so the evidence table and the alert
 * budget can be checked against the same source. **`priority` is 07's; the
 * emitted `severity` is this catalogue's**, and where they disagree the
 * evidence doc says which and why — 07 counts eighteen P0s and says in the same
 * breath that eighteen is too many to show at once.
 */
export type RulePriority = 'P0' | 'P1' | 'P2' | 'P3';

export interface BuiltinCatalogueEntry {
  /** The 07 §3.3 identifier this implements. `U2`, `C4`, `S10`, `I4`, `X1`. */
  readonly ruleId: string;
  readonly advisorId: string;
  readonly rule: BuiltinRule;
  readonly advisor: Advisor;
  readonly wave: RuleWave;
  /** 07 §3.3's own priority for this rule. Not the severity it emits. */
  readonly priority: RulePriority;
  /** What a composition root passes to `registerAdvisor` on first write. */
  readonly defaultEnabled: boolean;
  /** Why it is off, when it is. `null` when it ships on. */
  readonly disabledReason: string | null;
}

export interface CatalogueGap {
  readonly ruleId: string;
  readonly summary: string;
  /** The field or source that would have to exist first. */
  readonly reason: string;
}

const WAVE_TWO_REASON =
  'Wave two. 07 §7.4 releases cash and subscriptions first so a first run is not a wall of red; ' +
  'this rule is built and proven on the seed and needs only its enable flag.';

/**
 * Why the three WP 3.10 waves ship off.
 *
 * Two reasons, and the second is the load-bearing one. 07 §7.4's schedule puts
 * debt in week two and investing in week three, which is reason enough on its
 * own. But these rules also read four scopes that **no reader fills yet** —
 * `holdings.aggregate`, `holdings.detail`, `liabilities.terms` and
 * `market.rates` all carry `sourcedInPhase2: false`, so `SnapshotBuilder`
 * emits no block for them and every rule here would return nothing. Shipping
 * them enabled would be shipping a wave of silence and calling it a release.
 * Turning one on is a single `advisors.enabled` update once §7 of the evidence
 * doc's builder additions land.
 */
const WAVE_THREE_REASON =
  'Wave three. 07 §7.4 releases debt, then investing; and the scopes these rules read have no ' +
  'reader behind them until the SnapshotBuilder additions land, so an enabled rule would ' +
  'return nothing rather than something.';

function reasonFor(wave: RuleWave, defaultEnabled: boolean): string | null {
  if (defaultEnabled) return null;
  return wave === 'spending' ? WAVE_TWO_REASON : WAVE_THREE_REASON;
}

function entry(
  ruleId: string,
  rule: BuiltinRule,
  wave: RuleWave,
  priority: RulePriority,
  defaultEnabled: boolean,
): BuiltinCatalogueEntry {
  return {
    ruleId,
    advisorId: rule.manifest.advisor_id,
    rule,
    advisor: advisorFor(rule),
    wave,
    priority,
    defaultEnabled,
    disabledReason: reasonFor(wave, defaultEnabled),
  };
}

const [duplicateService, priceIncrease, shareOfIncome] = SUBSCRIPTION_RULES;
const [emergencyFund, idleCash, largeBill, shortfall, yieldSpreadRule] = CASH_RULES;
const [annualBills, categoryCreep, duplicateCharge, fees, negativeMonth, uncategorised] =
  SPENDING_RULES;
// Each family exports in 07 §3.3 order; see the `index.ts` beside each.
const [drift, expenseRatio, brokerageCash, concentration, employerStock, lossLot] = INVESTING_RULES;
const [payoffOrder, rateAboveMarket, minimumOnly, promoEnding, principalAgainst, missedPayment] =
  DEBT_RULES;
const [cryptoShare, cryptoCustody, idleStablecoins, cryptoLoss, cryptoBasis] = CRYPTO_RULES;

function required(rule: BuiltinRule | undefined, id: string): BuiltinRule {
  if (rule === undefined) throw new Error(`catalogue is missing the rule for ${id}`);
  return rule;
}

/**
 * Every implemented rule, in 07 order within each family.
 *
 * Wave one — cash and subscriptions — ships enabled. Wave two — spending —
 * ships registered and off.
 */
export const BUILTIN_CATALOGUE: readonly BuiltinCatalogueEntry[] = Object.freeze([
  entry('U2', required(priceIncrease, 'U2'), 'cash_and_subscriptions', 'P1', true),
  entry('U3', required(duplicateService, 'U3'), 'cash_and_subscriptions', 'P1', true),
  entry('U7', required(shareOfIncome, 'U7'), 'cash_and_subscriptions', 'P2', true),
  entry('C1', required(idleCash, 'C1'), 'cash_and_subscriptions', 'P0', true),
  entry('C2', required(yieldSpreadRule, 'C2'), 'cash_and_subscriptions', 'P1', true),
  entry('C3', required(shortfall, 'C3'), 'cash_and_subscriptions', 'P0', true),
  entry('C4', required(emergencyFund, 'C4'), 'cash_and_subscriptions', 'P1', true),
  entry('C7', required(largeBill, 'C7'), 'cash_and_subscriptions', 'P1', true),
  entry('S2', required(categoryCreep, 'S2'), 'spending', 'P2', false),
  entry('S3', required(uncategorised, 'S3'), 'spending', 'P1', false),
  entry('S6', required(duplicateCharge, 'S6'), 'spending', 'P0', false),
  entry('S7', required(fees, 'S7'), 'spending', 'P1', false),
  entry('S9', required(negativeMonth, 'S9'), 'spending', 'P1', false),
  entry('S10', required(annualBills, 'S10'), 'spending', 'P1', false),
  // --- WP 3.10, debt (07 §7.4's week two) --------------------------------
  entry('D1', required(payoffOrder, 'D1'), 'debt', 'P0', false),
  entry('D2', required(rateAboveMarket, 'D2'), 'debt', 'P1', false),
  entry('D3', required(minimumOnly, 'D3'), 'debt', 'P0', false),
  entry('D4', required(promoEnding, 'D4'), 'debt', 'P0', false),
  entry('D5', required(principalAgainst, 'D5'), 'debt', 'P2', false),
  entry('D6', required(missedPayment, 'D6'), 'debt', 'P0', false),
  // --- WP 3.10, investing (week three) -----------------------------------
  entry('I1', required(drift, 'I1'), 'investing', 'P1', false),
  entry('I2', required(expenseRatio, 'I2'), 'investing', 'P0', false),
  entry('I3', required(brokerageCash, 'I3'), 'investing', 'P1', false),
  entry('I4', required(concentration, 'I4'), 'investing', 'P0', false),
  entry('I5', required(employerStock, 'I5'), 'investing', 'P0', false),
  entry('I6', required(lossLot, 'I6'), 'investing', 'P0', false),
  // --- WP 3.10, crypto ---------------------------------------------------
  entry('X1', required(cryptoShare, 'X1'), 'crypto', 'P0', false),
  entry('X2', required(cryptoCustody, 'X2'), 'crypto', 'P1', false),
  entry('X3', required(idleStablecoins, 'X3'), 'crypto', 'P1', false),
  entry('X5', required(cryptoLoss, 'X5'), 'crypto', 'P1', false),
  entry('X6', required(cryptoBasis, 'X6'), 'crypto', 'P1', false),
]);

/**
 * The rules this work package emits at `urgent`, the severity that means P0 on
 * the wire.
 *
 * 03-phase-3-dispatch.md §3: *"I4, I5, I10 and X1 are P0."* Three of those four
 * ship and are here; **I10 is a gap** — an HSA headroom rule needs an HDHP
 * enrolment flag and contributions to date, and no scope in this work package's
 * brief carries either. That conflict is recorded rather than papered over.
 *
 * The narrower list is also the reason D1, D3, D4, D6, I2 and I6 emit below
 * `urgent` despite 07 §3.3 marking them P0: 07 itself counts eighteen P0s and
 * says in the same paragraph that eighteen is a wall of red. The dispatch
 * picked four; this catalogue ships the three of them that exist and records
 * the rest as P0-in-07, shipped lower, in the evidence doc.
 */
export const WP_3_10_P0_RULE_IDS: readonly string[] = Object.freeze(['I4', 'I5', 'X1']);

/**
 * The rules in WP 2.7's scope that Phase 2 data cannot support, and why.
 *
 * Every reason names a *field*, not an effort. That is the difference between a
 * gap somebody can close and a gap somebody has to rediscover: each of these
 * becomes writable the moment its named source exists, and none of them becomes
 * writable by trying harder.
 */
export const CATALOGUE_GAPS: readonly CatalogueGap[] = Object.freeze([
  {
    ruleId: 'U1',
    summary: 'A subscription the user has marked unused.',
    reason:
      'Needs a user declaration. `recurring.list` carries `status` and `user_confirmed`, and ' +
      'neither means "unused" — a dormant stream is one that stopped charging, which is the ' +
      'opposite case. 07 §2.10 is explicit that usage cannot be inferred from bank data.',
  },
  {
    ruleId: 'U4',
    summary: 'An annual plan cheaper than twelve monthly charges.',
    reason:
      'Needs a vendor price table. D22 tokenises every merchant, so there is no vendor name to ' +
      'look a plan up by, and no plan catalogue exists in any Phase 2 source.',
  },
  {
    ruleId: 'U5',
    summary: 'A free trial converting within three days.',
    reason:
      'Needs trial-watch state (07 §2.7). No Phase 2 scope carries a trial start, a trial end, ' +
      'or a zero-amount first charge marked as one.',
  },
  {
    ruleId: 'U6',
    summary: 'A charge after the user marked a subscription cancelled.',
    reason:
      'Needs a user "cancelling" flag on a stream. `recurring.list` has no such field, and ' +
      'inferring it from a dormancy status would be inventing an intention.',
  },
  {
    ruleId: 'U8',
    summary: 'Subscriptions charged to a card that carries a balance.',
    reason:
      'Unblocked by WP 3.10 and not yet written. `liabilities.terms` now carries the APR and ' +
      'the revolving balance this needed; what remains is joining a recurring stream to the ' +
      'card it is charged to, which no scope expresses — `recurring.list` has no account side.',
  },
  {
    ruleId: 'C5',
    summary: 'Credit utilisation above 30% on a statement date.',
    reason:
      'Unblocked by WP 3.10 and not yet written. `liabilities.terms` carries `credit_limit` ' +
      'and `statement_balance`, which is the whole of what this needed; it is a cash-family ' +
      'rule and WP 3.10’s brief was the investing, debt and crypto families.',
  },
  {
    ruleId: 'C6',
    summary: 'Carrying a revolving balance while holding spare cash.',
    reason:
      'Unblocked by WP 3.10 and not yet written. Both halves now exist — `cash.summary` for ' +
      'the cash and `liabilities.terms` for the APR and balance. D5 covers the adjacent case ' +
      '(a comfortable cushion against a loan rate); C6 is the revolving one and is owed.',
  },
  // --- WP 3.10's own gaps. Each names a field, never an effort. -----------
  {
    ruleId: 'I7',
    summary: 'A purchase that may wash out a loss realised nearby in time.',
    reason:
      'Needs disposals — a sale, its date and the loss it realised — which no scope carries, ' +
      'and needs them across *every* account including IRAs. 07 §4.4 calls that cross-account ' +
      'scan "the trap most software misses"; a rule seeing some accounts would produce ' +
      'confident false negatives, which is worse than the gap.',
  },
  {
    ruleId: 'I8',
    summary: 'A 401(k) deferral pace that will miss the employer match.',
    reason:
      'Needs year-to-date payroll deferrals and the plan’s match formula. No scope carries a ' +
      'contribution, and a match threshold is a term of a document nobody has given this app.',
  },
  {
    ruleId: 'I9',
    summary: 'IRA contribution room left with the window still open.',
    reason:
      'Needs contributions to date against the annual limit, and a MAGI test to know whether ' +
      'the contribution is even permitted. No scope carries either, and the limit itself is a ' +
      'statutory constant that would be an untraceable numeral if printed.',
  },
  {
    ruleId: 'I10',
    summary: 'HSA contribution room left, with an HDHP in force.',
    reason:
      'Needs an HDHP enrolment flag and contributions to date. Neither exists in any scope in ' +
      'WP 3.10’s brief. **The dispatch marks I10 P0**; it is recorded here as a gap rather ' +
      'than written over data that is not there, and the conflict is stated in the evidence.',
  },
  {
    ruleId: 'X4',
    summary: 'Staking receipts with no income basis recorded against them.',
    reason:
      'Needs an inflow *event* — a receipt, its date, and its value at receipt. Every scope in ' +
      'this brief describes a position rather than a movement: `holdings.detail` can say a lot ' +
      'exists and cannot say it arrived as a reward rather than a purchase, which is the rule.',
  },
  {
    ruleId: 'S1',
    summary: 'A transaction far above the category’s usual size.',
    reason:
      'Needs an exact transaction amount and a per-category distribution. `transactions.raw` ' +
      'carries a band (03 §8.3), so neither σ nor "${amt}" can be computed or printed.',
  },
  {
    ruleId: 'S5',
    summary: 'A first-time charge above $250 at a new merchant.',
    reason:
      'Needs an exact amount and a merchant-first-seen date. The amount is banded and no scope ' +
      'says when a merchant was first seen.',
  },
]);

/**
 * Every rule id this repository has been asked to cover so far.
 *
 * WP 2.7's 02 §3 set — U1–U8, C1–C7, the S-subset — plus WP 3.10's: the debt
 * family D1–D6, investing I1–I10 and crypto X1–X6 from 03-phase-3-dispatch.md
 * §3. `catalog.test.ts` asserts every id here is in exactly one of
 * `BUILTIN_CATALOGUE` and `CATALOGUE_GAPS`, which is what stops the catalogue
 * quietly shrinking — and what makes a gap a decision rather than an omission.
 */
export const CATALOGUE_SCOPE: readonly string[] = Object.freeze([
  'U1',
  'U2',
  'U3',
  'U4',
  'U5',
  'U6',
  'U7',
  'U8',
  'C1',
  'C2',
  'C3',
  'C4',
  'C5',
  'C6',
  'C7',
  'S1',
  'S2',
  'S3',
  'S5',
  'S6',
  'S7',
  'S9',
  'S10',
  'D1',
  'D2',
  'D3',
  'D4',
  'D5',
  'D6',
  'I1',
  'I2',
  'I3',
  'I4',
  'I5',
  'I6',
  'I7',
  'I8',
  'I9',
  'I10',
  'X1',
  'X2',
  'X3',
  'X4',
  'X5',
  'X6',
]);

/** The rule ids WP 3.10 was asked for: the whole of the I, D and X families. */
export const WP_3_10_SCOPE: readonly string[] = Object.freeze([
  'I1',
  'I2',
  'I3',
  'I4',
  'I5',
  'I6',
  'I7',
  'I8',
  'I9',
  'I10',
  'D1',
  'D2',
  'D3',
  'D4',
  'D5',
  'D6',
  'X1',
  'X2',
  'X3',
  'X4',
  'X5',
  'X6',
]);

/** The WP 3.10 waves, so a test or an evidence table can select them. */
export const WP_3_10_WAVES: readonly RuleWave[] = Object.freeze(['debt', 'investing', 'crypto']);

/** Every entry this work package added, in catalogue order. */
export function wp310Catalogue(): readonly BuiltinCatalogueEntry[] {
  return BUILTIN_CATALOGUE.filter((item) => WP_3_10_WAVES.includes(item.wave));
}

export function builtinRules(): readonly BuiltinRule[] {
  return BUILTIN_CATALOGUE.map((item) => item.rule);
}

export function builtinAdvisors(): readonly Advisor[] {
  return BUILTIN_CATALOGUE.map((item) => item.advisor);
}

/**
 * A registry holding the whole catalogue.
 *
 * `assertRegistered` rather than `register`: a built-in whose manifest is
 * malformed is a bug in this repository, not a third party's outage, and it
 * should stop a test rather than silently shrink the catalogue. A composition
 * root that would rather start with thirteen of fourteen can call `register`
 * itself — the registry returns a verdict for exactly that reason.
 */
export function createBuiltinRegistry(): AdvisorRegistry {
  const registry = new AdvisorRegistry();
  for (const advisor of builtinAdvisors()) registry.assertRegistered(advisor);
  return registry;
}

/** The most warnings one response carries. The schema's own cap. */
const MAX_WARNINGS = 16;
const MAX_WARNING_LENGTH = 240;

/**
 * Wrap a pure rule as an `Advisor`.
 *
 * Three envelope decisions, each of which is a rule about what a built-in may
 * know:
 *
 *   * **`produced_at` echoes `generated_at`.** A built-in runs in-process while
 *     the request is being handled, and 08 §4.1 says an advisor does not read a
 *     clock. Reporting the request's own instant is both true and deterministic,
 *     which is what lets `advisor-determinism.test.ts` compare two whole
 *     responses rather than just their insights.
 *   * **`runtime_ms` is zero.** `service.ts` times the call from outside; a rule
 *     timing itself would be reporting a second clock's opinion of the same
 *     interval.
 *   * **The insight list is cut to the request's own limit** rather than left to
 *     fail step 3. A response over the limit is rejected *whole* — twenty good
 *     insights lost because a twenty-first existed — and for a rule we wrote,
 *     truncating deterministically (the rule's own order) is strictly better
 *     than losing the run.
 */
export function advisorFor(rule: BuiltinRule): Advisor {
  return {
    manifest: rule.manifest,
    run(request: AdvisorRequest): Promise<unknown> {
      const output = rule.evaluate(contextOf(request));
      return Promise.resolve({
        contract_version: ADVISOR_CONTRACT_MAJOR,
        request_id: request.request_id,
        advisor_id: request.advisor_id,
        advisor_version: request.advisor_version,
        produced_at: request.generated_at,
        diagnostics: {
          runtime_ms: 0,
          model: null,
          warnings: output.warnings
            .slice(0, MAX_WARNINGS)
            .map((warning) => warning.slice(0, MAX_WARNING_LENGTH)),
        },
        insights: output.insights.slice(0, request.limits.max_insights),
      });
    },
  };
}
