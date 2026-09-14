// SPDX-License-Identifier: MIT
/**
 * The rule matcher. Pure, total, and deliberately boring.
 *
 * Every predicate returns a `boolean` and none of them throws: a rule that
 * cannot be evaluated does not match, and says why. That asymmetry is the whole
 * design. Categorisation runs inside a sync consumer, and an exception raised by
 * one badly-formed rule out of forty must not stop the other thirty-nine or
 * dead-letter the consumer — the user's punishment for a bad rule should be that
 * it does nothing, visibly, not that their sync stops.
 */
import { DateOnly } from '@core/kernel';
import { foldUpper } from '../normalize/fold.ts';
import { MAX_SUBJECT_LENGTH, type Rule, type RuleCondition } from './schema.ts';

/** Everything a condition is allowed to look at. */
export interface MatchSubject {
  /** The resolved payee: user name, else provider merchant name, else descriptor. */
  readonly payee: string;
  /** The cleaned descriptor, so `contains` finds a name the noise was hiding. */
  readonly cleanedPayee: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly accountId: string;
  readonly date: DateOnly;
  /** PFC codes seen on this transaction: primary, detailed, or both. */
  readonly providerCodes: readonly string[];
  readonly isTransfer: boolean;
}

export interface ConditionOutcome {
  readonly condition: RuleCondition;
  readonly matched: boolean;
  /** Populated only when a condition could not be evaluated at all. */
  readonly error?: string;
}

export interface RuleMatch {
  readonly ruleId: string;
  readonly matched: boolean;
  readonly outcomes: readonly ConditionOutcome[];
}

/**
 * A compiled regex cache.
 *
 * Rules are re-evaluated for every transaction in a sync page, so compiling the
 * same pattern five hundred times is pure waste. Keyed on the pattern text and
 * bounded, because an unbounded cache keyed on user input is a memory leak with
 * extra steps.
 */
const REGEX_CACHE = new Map<string, RegExp | null>();
const REGEX_CACHE_LIMIT = 256;

function compile(pattern: string): RegExp | null {
  const cached = REGEX_CACHE.get(pattern);
  if (cached !== undefined) return cached;
  let compiled: RegExp | null;
  try {
    compiled = new RegExp(pattern, 'iu');
  } catch {
    compiled = null;
  }
  if (REGEX_CACHE.size >= REGEX_CACHE_LIMIT) REGEX_CACHE.clear();
  REGEX_CACHE.set(pattern, compiled);
  return compiled;
}

function matchesPayee(condition: Extract<RuleCondition, { type: 'payee' }>, subject: MatchSubject): boolean {
  const needle = foldUpper(condition.value);
  // Both forms are searched: a user who typed "wholefds" is thinking of the raw
  // descriptor, and a user who typed "Whole Foods" is thinking of the clean name.
  // Matching either is what makes a rule written from the detail drawer work on
  // the rows in the list.
  const haystacks = [foldUpper(subject.payee), foldUpper(subject.cleanedPayee)];

  switch (condition.match) {
    case 'contains':
      return haystacks.some((value) => value.includes(needle));
    case 'not_contains':
      return haystacks.every((value) => !value.includes(needle));
    case 'starts_with':
      return haystacks.some((value) => value.startsWith(needle));
    case 'ends_with':
      return haystacks.some((value) => value.endsWith(needle));
    case 'equals':
      return haystacks.some((value) => value === needle);
  }
}

export function evaluateCondition(condition: RuleCondition, subject: MatchSubject): ConditionOutcome {
  switch (condition.type) {
    case 'payee':
      return { condition, matched: matchesPayee(condition, subject) };

    case 'payee_regex': {
      const compiled = compile(condition.pattern);
      if (compiled === null) {
        return { condition, matched: false, error: 'pattern did not compile' };
      }
      // Truncated, not rejected: a very long descriptor is still a descriptor,
      // and the first 512 characters contain the payee in every real case.
      const subjectText = subject.payee.slice(0, MAX_SUBJECT_LENGTH);
      return { condition, matched: compiled.test(subjectText) };
    }

    case 'amount': {
      const value = condition.absolute
        ? (subject.amountMinor < 0n ? -subject.amountMinor : subject.amountMinor)
        : subject.amountMinor;
      if (condition.minMinor !== null && value < BigInt(condition.minMinor)) {
        return { condition, matched: false };
      }
      if (condition.maxMinor !== null && value > BigInt(condition.maxMinor)) {
        return { condition, matched: false };
      }
      return { condition, matched: true };
    }

    case 'direction':
      return {
        condition,
        matched:
          condition.direction === 'outflow' ? subject.amountMinor < 0n : subject.amountMinor > 0n,
      };

    case 'account':
      return { condition, matched: condition.accountIds.includes(subject.accountId) };

    case 'day_of_month': {
      const day = Number(subject.date.slice(8, 10));
      // A wrapped range (`from: 28, to: 3`) means "around the turn of the month",
      // which is exactly when rent and payroll land. Treating it as an empty
      // range instead would silently break the most useful case.
      const matched =
        condition.from <= condition.to
          ? day >= condition.from && day <= condition.to
          : day >= condition.from || day <= condition.to;
      return { condition, matched };
    }

    case 'provider_category': {
      const wanted = new Set(condition.codes.map((code) => code.toUpperCase()));
      return { condition, matched: subject.providerCodes.some((code) => wanted.has(code.toUpperCase())) };
    }

    case 'currency':
      return { condition, matched: subject.currency.trim().toUpperCase() === condition.currency.toUpperCase() };

    case 'is_transfer':
      return { condition, matched: subject.isTransfer === condition.value };
  }
}

/**
 * Does this rule match?
 *
 * `all` must all hold; `any` needs one. When both lists are populated the rule
 * needs both halves, which is the reading a user expects from a form that has an
 * "all of these" section and an "any of these" section. `conditionsSchema`
 * guarantees at least one condition exists, so this can never return a vacuous
 * true.
 *
 * Every condition is evaluated even once the answer is decided, because the
 * outcomes are the evidence `explainAssignment` shows: "matched, because payee
 * contains CHEWY **and** amount is under $200" is a useful sentence, and
 * short-circuiting would leave half of it blank.
 */
export function matchRule(rule: Rule, subject: MatchSubject): RuleMatch {
  const allOutcomes = rule.conditions.all.map((condition) => evaluateCondition(condition, subject));
  const anyOutcomes = rule.conditions.any.map((condition) => evaluateCondition(condition, subject));

  const allHold = allOutcomes.every((outcome) => outcome.matched);
  const anyHolds = anyOutcomes.length === 0 || anyOutcomes.some((outcome) => outcome.matched);

  return {
    ruleId: rule.id,
    matched: allHold && anyHolds,
    outcomes: [...allOutcomes, ...anyOutcomes],
  };
}

/**
 * Rules in evaluation order: enabled first, then by ascending priority, then by
 * id.
 *
 * The id tiebreak is not decoration. Two rules at the same priority that both
 * match must produce the same winner on every run and on every machine, or the
 * same transaction categorises differently on a re-run and the idempotence
 * property that makes re-categorisation safe (04 §5.2) is gone. Ids are UUIDv7,
 * so the tiebreak is "whichever was created first", which is also the answer a
 * user would predict.
 */
export function orderRules(rules: readonly Rule[]): readonly Rule[] {
  return [...rules]
    .filter((rule) => rule.enabled)
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}
