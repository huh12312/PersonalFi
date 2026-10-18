// SPDX-License-Identifier: MIT
import { Sparkles } from 'lucide-react';
import { useEffect, useRef } from 'react';

import type { CategoryVariability } from '../../api/generated/types.gen.ts';
import { cn } from '../../lib/cn.ts';
import { useClassifyCategoryMutation } from './api.ts';
import { VARIABILITY_LABELS, type VariabilityKey } from './variability.ts';

const CHOICES: readonly CategoryVariability[] = ['fixed', 'flexible', 'non_monthly'];

/**
 * One-click classify (WP 10.11): a small segmented control — three toggle buttons in a labelled group, each a Tab
 * stop operated by Enter or Space (`aria-pressed` says which is current). Toggle buttons rather than a radio group on
 * purpose: arrowing through radios *selects* as it moves, and every selection here is a write.
 *
 * A **suggestion** (an active recurring stream lands in this category) is a "Suggested: Fixed" chip and nothing
 * more — no button is pressed, nothing is written — until the holder presses one.
 */
export function ClassifyControl({
  categoryId,
  categoryLabel,
  current,
  suggested,
  onClassified,
  focusPressed = false,
  onFocused,
  onChoose,
}: {
  readonly categoryId: string;
  readonly categoryLabel: string;
  readonly current: VariabilityKey;
  readonly suggested: boolean;
  /** Called after the write lands: the row is about to move to its new section and remount. */
  readonly onClassified?: (categoryId: string) => void;
  /**
   * Set on the remounted control of the row just classified: focus goes to its pressed choice, so a keyboard user
   * who classified a row is not dropped at the top of the document when the row moves section (2.4.3).
   */
  readonly focusPressed?: boolean;
  readonly onFocused?: () => void;
  /**
   * WP 10.14, the category editor: a form value, not a write. When given, a press calls this instead of `PATCH`
   * (the editor saves every field in one request), and pressing the pressed choice returns it to unclassified.
   */
  readonly onChoose?: (choice: CategoryVariability | null) => void;
}) {
  const classify = useClassifyCategoryMutation();
  const pressedRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!focusPressed || pressedRef.current === null) return;
    pressedRef.current.focus();
    onFocused?.();
  }, [focusPressed, onFocused, current]);
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2">
      <div
        role="group"
        aria-label={`Classify ${categoryLabel}`}
        className="inline-flex overflow-hidden rounded-md border border-border-primary"
      >
        {CHOICES.map((choice, index) => {
          const pressed = current === choice;
          return (
            <button
              key={choice}
              ref={pressed ? pressedRef : undefined}
              type="button"
              aria-pressed={pressed}
              // Not `disabled` while saving: disabling the focused button would drop focus to the document.
              aria-disabled={classify.isPending || undefined}
              onClick={() => {
                if (onChoose !== undefined) {
                  onChoose(pressed ? null : choice);
                  return;
                }
                if (pressed || classify.isPending) return;
                classify.mutate(
                  { path: { categoryId }, body: { variability: choice } },
                  { onSuccess: () => onClassified?.(categoryId) },
                );
              }}
              className={cn(
                'min-h-7 px-2.5 text-caption font-medium focus-visible:relative focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring',
                index > 0 && 'border-l border-border-primary',
                pressed
                  ? 'bg-accent text-text-on-brand'
                  : 'bg-bg-primary text-text-secondary hover:bg-bg-secondary',
              )}
            >
              {VARIABILITY_LABELS[choice]}
            </button>
          );
        })}
      </div>
      {suggested && current === 'unclassified' && (
        <span
          data-testid="variability-suggested"
          className="inline-flex items-center gap-1 rounded-full border border-status-info-border bg-status-info-bg px-2 py-0.5 text-caption font-medium text-status-info-text"
        >
          <Sparkles size={12} aria-hidden="true" />
          Suggested: Fixed
          <span className="sr-only"> — a recurring charge lands in this category</span>
        </span>
      )}
      {classify.isError && (
        <p role="alert" className="text-caption text-status-danger-text">
          Couldn't save that. Try again.
        </p>
      )}
    </div>
  );
}
