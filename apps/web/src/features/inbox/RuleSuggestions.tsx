// SPDX-License-Identifier: MIT
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';

import {
  getTransactionOptions,
  listInsightsFeedOptions,
  listInsightsFeedQueryKey,
  reviewInsightMutation,
} from '../../api/generated/@tanstack/react-query.gen.ts';
import type { Insight } from '../../api/generated/types.gen.ts';
import { CategoryIcon } from '../../components/finance/CategoryIcon.tsx';
import { Skeleton } from '../../components/patterns/Skeleton.tsx';
import { Button } from '../../components/ui/button.tsx';
import { useCategories } from '../categories/useCategories.ts';
import { CreateRuleFromInsight, neighbourFocusTarget } from '../insights/CreateRuleFromInsight.tsx';
import { DismissReasonDialog } from '../insights/DismissReasonDialog.tsx';
import { RULE_SUGGESTION_TYPE, ruleDraftOf, type RuleDraft } from '../insights/rule-draft.ts';

export interface RuleSuggestion {
  readonly insight: Insight;
  readonly draft: RuleDraft;
}

/**
 * WP 11.1: the pending `spending.rule_suggestion` insights ("a merchant you always file the same way"), read from
 * the same `GET /insights?statuses=pending_review` query the Insights screen uses (one cache entry for both; the feed
 * has no type filter, so the type is picked here). Every slice of the feed is read — a suggestion claims no dollar
 * impact, so where the alert budget files it is not a reason to hide it from the Inbox — and one whose evidence does
 * not resolve a draft (`rule-draft.ts`) is not offered.
 */
export function useRuleSuggestions(): readonly RuleSuggestion[] {
  const feed = useQuery(listInsightsFeedOptions({ query: { statuses: ['pending_review'] } }));
  return useMemo(() => {
    const data = feed.data;
    if (data === undefined) return [];
    const seen = new Set<string>();
    const out: RuleSuggestion[] = [];
    for (const insight of [...data.list, ...data.overflow, ...data.belowFloor]) {
      if (seen.has(insight.id)) continue;
      seen.add(insight.id);
      if (insight.type !== RULE_SUGGESTION_TYPE || insight.status !== 'pending_review') continue;
      const draft = ruleDraftOf(insight);
      if (draft !== null) out.push({ insight, draft });
    }
    return out;
  }, [feed.data]);
}

/**
 * Once a rule is saved this suggestion leaves the list: focus moves to the next suggestion's "Create rule", or the
 * one before it, or — the last one gone — back to the review queue's current row.
 */
function focusAfterAccept(trigger: HTMLButtonElement | null): HTMLElement | null {
  const next = neighbourFocusTarget(trigger);
  if (next !== null && next.id !== 'main-content') return next;
  return (
    document.querySelector<HTMLElement>('ul[aria-label="Review inbox"] > li[tabindex="0"]') ?? next
  );
}

/** The Inbox's "Rule suggestions" section; renders nothing when there are none. */
export function RuleSuggestionsSection() {
  const suggestions = useRuleSuggestions();
  if (suggestions.length === 0) return null;
  return (
    <section
      aria-labelledby="inbox-rule-suggestions-heading"
      className="mt-2"
      data-inbox-section="rule-suggestions"
    >
      <h2 id="inbox-rule-suggestions-heading" className="text-small font-semibold text-text-muted">
        Rule suggestions
      </h2>
      <p className="mt-1 text-caption text-text-muted">
        Merchants you always file the same way. Nothing changes until you save a rule.
      </p>
      <ul aria-label="Rule suggestions" className="mt-2 flex flex-col gap-2">
        {suggestions.map((suggestion) => (
          <RuleSuggestionRow key={suggestion.insight.id} suggestion={suggestion} />
        ))}
      </ul>
    </section>
  );
}

function RuleSuggestionRow({ suggestion }: { readonly suggestion: RuleSuggestion }) {
  const { insight, draft } = suggestion;
  const id = useId();
  const merchantId = `${id}-merchant`;
  const detailId = `${id}-detail`;
  const { byId } = useCategories();
  const category = byId.get(draft.categoryId);
  const transaction = useQuery(
    getTransactionOptions({ path: { transactionId: draft.transactionId } }),
  );
  const merchant =
    transaction.data === undefined
      ? null
      : (transaction.data.merchantName ?? transaction.data.name);

  const [dismissing, setDismissing] = useState(false);
  const queryClient = useQueryClient();
  const review = useMutation({
    ...reviewInsightMutation(),
    onSuccess: () => {
      setDismissing(false);
      void queryClient.invalidateQueries({ queryKey: listInsightsFeedQueryKey() });
    },
  });

  const categoryLabel = category?.label ?? 'one category';
  return (
    <li
      className="rounded-md border border-border-hairline bg-bg-surface p-3"
      data-testid="rule-suggestion"
      data-insight-id={insight.id}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 basis-60 items-center gap-3">
          <CategoryIcon
            category={
              category ?? { id: null, key: 'uncategorised', label: 'Uncategorized', isSystem: true }
            }
            size="sm"
          />
          <div className="min-w-0">
            <div
              id={merchantId}
              className="text-body font-medium text-text-primary [overflow-wrap:anywhere]"
              data-testid="rule-suggestion-merchant"
            >
              {merchant ?? (transaction.isError ? 'This merchant' : <Skeleton width={128} />)}
            </div>
            <p id={detailId} className="text-small text-text-muted">
              {draft.confirmations === null ? (
                <>
                  You always file it under{' '}
                  <span className="text-text-secondary">{categoryLabel}</span>.
                </>
              ) : (
                <>
                  Filed under <span className="text-text-secondary">{categoryLabel}</span>{' '}
                  <span data-testid="rule-suggestion-count">{draft.confirmations}</span> times by
                  hand.
                </>
              )}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <CreateRuleFromInsight
            insightId={insight.id}
            draft={draft}
            describedBy={`${merchantId} ${detailId}`}
            focusAfterAccept={focusAfterAccept}
          />
          <Button
            variant="ghost"
            size="sm"
            aria-describedby={`${merchantId} ${detailId}`}
            disabled={review.isPending}
            onClick={() => setDismissing(true)}
          >
            Not now
          </Button>
        </div>
      </div>
      <DismissReasonDialog
        open={dismissing}
        onOpenChange={setDismissing}
        busy={review.isPending}
        onDismiss={({ reasonCode, note }) =>
          review.mutate({
            path: { insightId: insight.id },
            body: { action: 'dismiss', reasonCode, reason: note },
          })
        }
      />
    </li>
  );
}
