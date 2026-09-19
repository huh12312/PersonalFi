// SPDX-License-Identifier: MIT
/**
 * The rule condition language.
 *
 * Deliberately not a language. `notification_rules.conditions` is a JSON object
 * of field → predicate, every predicate is one of seven total operators, and
 * there is no expression, no function call and no path traversal. A rule engine
 * with an `eval` in it would be a second egress surface — the first being the
 * channel — and a rule engine with dotted paths would be a way to read parts of
 * a payload a rule was never meant to see.
 *
 * ```json
 * { "threshold": { "in": ["PCT_100", "OVERSPENT_CASH"] } }
 * { "annualImpactMinor": { "gteMinor": "1200" } }
 * { "status": { "eq": "failed" } }
 * ```
 *
 * An unknown field is a non-match, not an error: payloads gain fields between
 * versions, and a rule that silently stops firing is better than a consumer
 * that throws on every event for a rule somebody wrote a typo into. An unknown
 * *operator* is an error, because that is a rule that was never going to work
 * and the user should be told at write time.
 *
 * `gteMinor` compares **minor units carried as strings** — the repo's wire rule
 * (docs/CONVENTIONS.md, "On the wire") — through `BigInt`, never through
 * `Number`. `recurring.PriceChangeDetected.annualImpactMinor` is the field this
 * exists for, and comparing it as a float is how "alert me above $10,000"
 * silently becomes "above $10,000.000000000001".
 */
export type ConditionOperator =
  'eq' | 'neq' | 'in' | 'notIn' | 'isTrue' | 'gteMinor' | 'gteAbsMinor';

export type Conditions = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

export class ConditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConditionError';
  }
}

const OPERATORS = new Set<string>([
  'eq',
  'neq',
  'in',
  'notIn',
  'isTrue',
  'gteMinor',
  'gteAbsMinor',
]);

/**
 * Does this payload satisfy every predicate?
 *
 * Conjunctive, with no `or`. A user who wants a disjunction writes two rules,
 * which is also the shape that lets them route the two halves to different
 * channels — and it keeps the outbox's coalescing key derivable from the rule
 * rather than from which branch happened to match.
 */
export function matchesConditions(payload: unknown, conditions: Conditions): boolean {
  if (payload === null || typeof payload !== 'object') return false;
  const record = payload as Record<string, unknown>;

  for (const [field, predicate] of Object.entries(conditions)) {
    if (predicate === null || typeof predicate !== 'object') {
      throw new ConditionError(`${field}: a condition must be an object of operators`);
    }
    for (const [operator, operand] of Object.entries(predicate)) {
      if (!OPERATORS.has(operator)) {
        throw new ConditionError(
          `${field}.${operator}: unknown operator; expected one of ${[...OPERATORS].join(', ')}`,
        );
      }
      if (!evaluate(record[field], operator as ConditionOperator, operand)) return false;
    }
  }
  return true;
}

function evaluate(value: unknown, operator: ConditionOperator, operand: unknown): boolean {
  switch (operator) {
    case 'eq':
      return value === operand;
    case 'neq':
      return value !== operand;
    case 'in':
      return Array.isArray(operand) && operand.includes(value);
    case 'notIn':
      return Array.isArray(operand) && !operand.includes(value);
    case 'isTrue':
      return (value === true) === (operand === true);
    case 'gteMinor': {
      const left = toMinor(value);
      const right = toMinor(operand);
      return left !== null && right !== null && left >= right;
    }
    case 'gteAbsMinor': {
      const left = toMinor(value);
      const right = toMinor(operand);
      if (left === null || right === null) return false;
      return (left < 0n ? -left : left) >= (right < 0n ? -right : right);
    }
    default:
      return false;
  }
}

/** Minor units as a string, through `BigInt`. Never through `Number`. */
function toMinor(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) return null;
  return BigInt(value);
}

/** Validate a condition object at write time, so a bad rule fails at the door. */
export function assertConditionsValid(conditions: Conditions): void {
  matchesConditions({}, conditions);
}
