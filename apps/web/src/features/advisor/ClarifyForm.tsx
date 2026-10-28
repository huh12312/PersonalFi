// SPDX-License-Identifier: MIT
import { useId, useState } from 'react';
import type { FormEvent } from 'react';

import { Button } from '../../components/ui/button.tsx';
import type { AdvisorSession } from './advisor-words.ts';

export interface ClarifyFormProps {
  readonly clarification: NonNullable<AdvisorSession['clarification']>;
  readonly maxAnswerLength: number;
  readonly busy: boolean;
  /** Called with one answer per question, in order (an empty list when there were no questions). */
  readonly onContinue: (answers: string[]) => void;
}

/**
 * The clarify step as a short form: the advisor's restatement of the question, at most two questions each with its
 * own labelled box, and the defaults it will assume where nothing is said. Continue sends the answers in order.
 */
export function ClarifyForm({
  clarification,
  maxAnswerLength,
  busy,
  onContinue,
}: ClarifyFormProps) {
  const id = useId();
  const [answers, setAnswers] = useState<string[]>(() => clarification.questions.map(() => ''));

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    if (busy) return;
    onContinue(clarification.questions.map((_, index) => (answers[index] ?? '').trim()));
  }

  return (
    <form
      onSubmit={onSubmit}
      className="mt-3 flex flex-col gap-3"
      data-testid="advisor-clarify"
      aria-label="Clarifying questions"
    >
      <p className="text-small text-text-primary" data-testid="advisor-restatement">
        {clarification.restatement}
      </p>
      {clarification.questions.length > 0 && (
        <div className="flex flex-col gap-3">
          {clarification.questions.map((question, index) => {
            const inputId = `${id}-answer-${String(index)}`;
            return (
              <div key={question} className="flex flex-col gap-1">
                <label htmlFor={inputId} className="text-small font-medium text-text-secondary">
                  {question}
                </label>
                <input
                  id={inputId}
                  type="text"
                  value={answers[index] ?? ''}
                  maxLength={maxAnswerLength}
                  onChange={(event) =>
                    setAnswers((previous) =>
                      previous.map((answer, at) => (at === index ? event.target.value : answer)),
                    )
                  }
                  aria-describedby={`${id}-hint`}
                  className="h-10 w-full rounded-md border border-border-strong bg-bg-surface px-2 text-small text-text-primary placeholder:text-text-muted focus-visible:outline-none"
                  data-testid="advisor-answer"
                />
              </div>
            );
          })}
          <p id={`${id}-hint`} className="text-caption text-text-muted">
            Up to {String(maxAnswerLength)} characters each. An answer can be left empty.
          </p>
        </div>
      )}
      {clarification.assumed.length > 0 && (
        <ul className="flex flex-col gap-1" data-testid="advisor-assumed">
          {clarification.assumed.map((assumption) => (
            <li
              key={assumption.valueRef}
              className="text-small text-text-secondary [overflow-wrap:anywhere]"
            >
              Assumed: {assumption.about} — {assumption.value}
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button
          type="submit"
          className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          aria-disabled={busy ? 'true' : undefined}
          aria-busy={busy ? 'true' : undefined}
          data-testid="advisor-continue"
        >
          Continue
        </Button>
      </div>
    </form>
  );
}
