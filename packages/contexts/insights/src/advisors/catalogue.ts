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
import { CASH_RULES } from './rules-cash.ts';
import { SPENDING_RULES } from './rules-spending.ts';
import { SUBSCRIPTION_RULES } from './rules-subscriptions.ts';
import { contextOf, type BuiltinRule } from './support.ts';

/** 07 §7.4's release waves, as far as Phase 2 has rules for them. */
export type RuleWave = 'cash_and_subscriptions' | 'spending';

export interface BuiltinCatalogueEntry {
  /** The 07 §3.3 identifier this implements. `U2`, `C4`, `S10`. */
  readonly ruleId: string;
  readonly advisorId: string;
  readonly rule: BuiltinRule;
  readonly advisor: Advisor;
  readonly wave: RuleWave;
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

function entry(
  ruleId: string,
  rule: BuiltinRule,
  wave: RuleWave,
  defaultEnabled: boolean,
): BuiltinCatalogueEntry {
  return {
    ruleId,
    advisorId: rule.manifest.advisor_id,
    rule,
    advisor: advisorFor(rule),
    wave,
    defaultEnabled,
    disabledReason: defaultEnabled ? null : WAVE_TWO_REASON,
  };
}

const [duplicateService, priceIncrease, shareOfIncome] = SUBSCRIPTION_RULES;
const [emergencyFund, idleCash, largeBill, shortfall, yieldSpreadRule] = CASH_RULES;
const [annualBills, categoryCreep, duplicateCharge, fees, negativeMonth, uncategorised] =
  SPENDING_RULES;

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
  entry('U2', required(priceIncrease, 'U2'), 'cash_and_subscriptions', true),
  entry('U3', required(duplicateService, 'U3'), 'cash_and_subscriptions', true),
  entry('U7', required(shareOfIncome, 'U7'), 'cash_and_subscriptions', true),
  entry('C1', required(idleCash, 'C1'), 'cash_and_subscriptions', true),
  entry('C2', required(yieldSpreadRule, 'C2'), 'cash_and_subscriptions', true),
  entry('C3', required(shortfall, 'C3'), 'cash_and_subscriptions', true),
  entry('C4', required(emergencyFund, 'C4'), 'cash_and_subscriptions', true),
  entry('C7', required(largeBill, 'C7'), 'cash_and_subscriptions', true),
  entry('S2', required(categoryCreep, 'S2'), 'spending', false),
  entry('S3', required(uncategorised, 'S3'), 'spending', false),
  entry('S6', required(duplicateCharge, 'S6'), 'spending', false),
  entry('S7', required(fees, 'S7'), 'spending', false),
  entry('S9', required(negativeMonth, 'S9'), 'spending', false),
  entry('S10', required(annualBills, 'S10'), 'spending', false),
]);

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
      'Needs a card APR and revolving balance. `cash.summary` covers depository accounts only; ' +
      'no Phase 2 scope carries an APR, a credit limit, or a statement balance.',
  },
  {
    ruleId: 'C5',
    summary: 'Credit utilisation above 30% on a statement date.',
    reason: 'Needs a credit limit and a statement date. Neither exists in any Phase 2 scope.',
  },
  {
    ruleId: 'C6',
    summary: 'Carrying a revolving balance while holding spare cash.',
    reason:
      'Needs an APR and a revolving balance, as U8 does. The cash half is available; the debt ' +
      'half is not, and half of this rule is worse than none of it.',
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

/** Every rule id WP 2.7 was asked to cover: 02 §3's U1–U8, C1–C7, S-subset. */
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
]);

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
