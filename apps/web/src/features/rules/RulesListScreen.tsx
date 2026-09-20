// SPDX-License-Identifier: MIT
import { ListChecks, Trash2 } from 'lucide-react';

import type { Rule } from '../../api/generated/types.gen.ts';
import { EmptyState } from '../../components/patterns/EmptyState.tsx';
import { SkeletonText } from '../../components/patterns/Skeleton.tsx';
import { Button } from '../../components/ui/button.tsx';
import { Switch } from '../../components/ui/switch.tsx';
import { useDeleteRuleMutation, useRulesQuery, useUpdateRuleMutation } from './useRules.ts';

/** One line describing what a rule matches, for the settings list — not a full rule editor (out of this WP's scope; the rule builder itself is `RuleFromTransactionDialog`). */
function describeConditions(rule: Rule): string {
  const parts = rule.conditions.all.map((condition) => {
    switch (condition.type) {
      case 'payee':
        return `payee ${condition.match.replace('_', ' ')} "${condition.value}"`;
      case 'payee_regex':
        return `payee matches /${condition.pattern}/`;
      case 'amount':
        return 'amount in range';
      case 'direction':
        return condition.direction;
      case 'account':
        return `${String(condition.accountIds.length)} account(s)`;
      case 'day_of_month':
        return `day ${String(condition.from)}–${String(condition.to)}`;
      case 'provider_category':
        return 'provider category';
      case 'currency':
        return condition.currency;
      case 'is_transfer':
        return condition.value ? 'is a transfer' : 'is not a transfer';
      default:
        return 'condition';
    }
  });
  return parts.length === 0 ? 'matches everything' : parts.join(' and ');
}

function describeActions(rule: Rule): string {
  return rule.actions
    .map((action) => {
      switch (action.type) {
        case 'set_category':
          return `set category to ${action.categoryKey}`;
        case 'set_merchant_name':
          return `rename to "${action.name}"`;
        case 'set_note':
          return 'add a note';
        case 'add_tag':
          return `tag "${action.tag}"`;
        case 'exclude':
          return 'exclude from totals';
        case 'mark_transfer':
          return 'mark as transfer';
        case 'split':
          return 'split';
        case 'link_recurring':
          return 'link to a recurring series (recorded, not yet acted on)';
        case 'notify':
          return 'notify (recorded, not yet acted on)';
        default:
          return 'action';
      }
    })
    .join(', ');
}

/**
 * Rules list under Settings (WP 2.5's carry-over `/rules` surface, this WP's
 * UI for it): enable/disable and delete. Creating a rule from scratch (rather
 * than from a transaction) is out of this pass's scope — `05 §5.4`'s own
 * follow-on "manageable at `/transactions/rules`... drag-to-reorder priority"
 * screen is bigger than "enable/disable/delete" and stays a later pass; every
 * rule shown here was created via `RuleFromTransactionDialog`.
 */
export function RulesListScreen() {
  const rulesQuery = useRulesQuery();
  const updateRule = useUpdateRuleMutation();
  const deleteRule = useDeleteRuleMutation();

  if (rulesQuery.isLoading) return <SkeletonText lines={4} />;

  if (rulesQuery.isError) {
    return (
      <EmptyState
        icon={ListChecks}
        headline="Could not load rules"
        description="Something went wrong fetching your categorisation rules."
        action={{ label: 'Retry', onClick: () => void rulesQuery.refetch() }}
      />
    );
  }

  const rules = rulesQuery.data?.rules ?? [];

  if (rules.length === 0) {
    return (
      <EmptyState
        icon={ListChecks}
        headline="No rules yet"
        description={
          'Choose "Always categorize like this" on a transaction to create your first rule.'
        }
      />
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {rules.map((rule) => (
        <li
          key={rule.id}
          className="flex items-center justify-between gap-3 rounded-md border border-border-hairline bg-bg-surface p-3"
        >
          <div className="min-w-0">
            <p className="truncate text-body font-medium text-text-primary">{rule.name}</p>
            <p className="truncate text-small text-text-muted">
              When {describeConditions(rule)} → {describeActions(rule)}
            </p>
            {rule.lastAppliedAt !== null && (
              <p className="text-caption text-text-muted">
                Last applied to {rule.lastAppliedCount} transaction
                {rule.lastAppliedCount === 1 ? '' : 's'}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Switch
              aria-label={`${rule.enabled ? 'Disable' : 'Enable'} ${rule.name}`}
              checked={rule.enabled}
              onCheckedChange={(checked: boolean) =>
                updateRule.mutate({ path: { ruleId: rule.id }, body: { enabled: checked } })
              }
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Delete ${rule.name}`}
              onClick={() => deleteRule.mutate({ path: { ruleId: rule.id } })}
            >
              <Trash2 size={16} aria-hidden="true" />
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
