// SPDX-License-Identifier: MIT
/**
 * The Inbox's one-line "why" (WP 11.1), composed from a **stored** decision chain.
 *
 *     Every tier abstained: none of your 4 rules matched, merchant confirmed 1 of
 *     3 times needed, no bank category, classifier 41 % below its 60 % floor.
 *
 * This is the line 11.2 appends its suggestion to, so it has two jobs: say what
 * the deterministic tiers tried, and say it from the working that was recorded
 * when the decision was made. It takes the chain as stored in
 * `category_assignments.evidence` or `category_abstentions.evidence` and reads
 * each tier's `facts`; it never calls `decide`, never loads a rule or a model,
 * and has no way to — the only input is the chain. A chain stored before WP 11.1
 * has no `facts`, and for those the tier's own `detail` sentence is used as is.
 *
 * Pure, and defensive about its input: the chain is jsonb from the database, so
 * every field is checked rather than trusted, and an entry that is not a tier
 * outcome is skipped rather than printed.
 */

interface StoredTier {
  readonly source: string;
  readonly won: boolean;
  readonly detail: string;
  readonly facts: Readonly<Record<string, unknown>> | null;
}

function tiersOf(chain: readonly unknown[]): StoredTier[] {
  const tiers: StoredTier[] = [];
  for (const entry of chain) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record['source'] !== 'string') continue;
    const facts = record['facts'];
    tiers.push({
      source: record['source'],
      won: record['won'] === true,
      detail: typeof record['detail'] === 'string' ? record['detail'] : '',
      facts:
        typeof facts === 'object' && facts !== null && !Array.isArray(facts)
          ? (facts as Record<string, unknown>)
          : null,
    });
  }
  return tiers;
}

function num(facts: Readonly<Record<string, unknown>> | null, key: string): number | null {
  const value = facts?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** `0.41` → `41 %`. Whole percent: the line is for reading, not auditing. */
export function percentText(value: number): string {
  return `${String(Math.round(value * 100))} %`;
}

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

/** What one tier said while abstaining, from its stored facts. */
function abstentionPart(tier: StoredTier): string {
  const facts = tier.facts;
  if (facts === null) return tier.detail;
  switch (tier.source) {
    case 'rule': {
      const rules = num(facts, 'rules');
      const matched = num(facts, 'matched');
      if (matched !== null && matched > 0) {
        return `${plural(matched, 'rule', 'rules')} matched but none set a category`;
      }
      if (rules === 0) return 'no rules yet';
      return rules === null
        ? tier.detail
        : `none of your ${plural(rules, 'rule', 'rules')} matched`;
    }
    case 'merchant_default': {
      const support = num(facts, 'support');
      const needed = num(facts, 'needed');
      if (support === null || needed === null) return tier.detail;
      if (support === 0) return 'merchant never confirmed';
      return `merchant confirmed ${String(support)} of ${plural(needed, 'time', 'times')} needed`;
    }
    case 'provider':
      return facts['sent'] === true ? 'bank category not recognised' : 'no bank category';
    case 'classifier': {
      const confidence = num(facts, 'confidence');
      const floor = num(facts, 'floor');
      switch (facts['code']) {
        case 'cold':
          return 'classifier has no confirmed examples yet';
        case 'no_features':
          return 'classifier had nothing to read';
        case 'single_category':
          return 'classifier has examples for only one category so far';
        case 'under_supported': {
          const examples = num(facts, 'examples');
          const needed = num(facts, 'examplesNeeded');
          return examples === null || needed === null
            ? tier.detail
            : `classifier’s best guess has ${plural(examples, 'example', 'examples')}, ${String(needed)} needed`;
        }
        case 'too_close':
          return 'classifier too close to call between two categories';
        case 'below_floor': {
          if (confidence === null || floor === null) return tier.detail;
          const unseen =
            facts['payeeEvidence'] === false ? ' (no word of this payee seen before)' : '';
          return `classifier ${percentText(confidence)} below its ${percentText(floor)} floor${unseen}`;
        }
        default:
          return tier.detail;
      }
    }
    default:
      return tier.detail;
  }
}

const WON_PREFIX: Readonly<Record<string, string>> = {
  user: 'You chose this category',
  rule: 'Filed by a rule',
  merchant_default: 'Filed from this merchant’s history',
  provider: 'Filed from your bank’s category',
  classifier: 'Filed by the classifier',
};

/**
 * The line, from a stored chain. Empty chain → the honest "nothing recorded".
 */
export function explanationLineOf(chain: readonly unknown[]): string {
  const tiers = tiersOf(chain);
  if (tiers.length === 0) return 'No categorisation pass has recorded its working for this yet.';

  const winner = tiers.find((tier) => tier.won);
  if (winner === undefined || winner.source === 'none') {
    const parts = tiers
      .filter((tier) => tier.source !== 'user' && tier.source !== 'none' && !tier.won)
      .map(abstentionPart)
      .filter((part) => part !== '');
    return parts.length === 0
      ? 'Every tier abstained.'
      : `Every tier abstained: ${parts.join(', ')}.`;
  }

  const prefix = WON_PREFIX[winner.source] ?? `Filed by ${winner.source}`;
  if (winner.source === 'classifier' && winner.facts !== null) {
    const confidence = num(winner.facts, 'confidence');
    const floor = num(winner.facts, 'floor');
    const signals = typeof winner.facts['signals'] === 'string' ? winner.facts['signals'] : '';
    if (confidence !== null && floor !== null) {
      return (
        `${prefix} at ${percentText(confidence)} (its floor is ${percentText(floor)})` +
        (signals === '' ? '.' : `; strongest signals ${signals.split(' ').join(', ')}.`)
      );
    }
  }
  if (winner.source === 'user') return `${prefix}.`;
  const detail = winner.detail.trim();
  return detail === '' ? `${prefix}.` : `${prefix}: ${detail}`;
}
