// SPDX-License-Identifier: MIT
import { Loader2, Send } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';

import { Button } from '../../components/ui/button.tsx';
import { cn } from '../../lib/cn.ts';

export interface QuestionFormProps {
  readonly maxLength: number;
  readonly examples: readonly string[];
  /** Questions cannot be asked (the box and the examples are disabled and say why elsewhere). */
  readonly unavailable: boolean;
  /** A question is on its way or being worked on: sending again waits. */
  readonly busy: boolean;
  readonly error: string | null;
  /** Called with the trimmed question; `clear` empties the box once the api has taken it. */
  readonly onSend: (question: string, clear: () => void) => void;
}

/**
 * The question box: a labelled textarea, a counter against the cap (the box does not cut a pasted question short;
 * it says by how much it is over and holds the button), Enter to send and Shift+Enter for a new line, and a few
 * example questions that fill the box. While a question is going the button stays focusable (`aria-disabled`,
 * `aria-busy`) so focus is not lost under the user.
 */
export function QuestionForm({
  maxLength,
  examples,
  unavailable,
  busy,
  error,
  onSend,
}: QuestionFormProps) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const inputId = `${id}-question`;
  const hintId = `${id}-hint`;
  const countId = `${id}-count`;
  const errorId = `${id}-error`;

  const length = text.length;
  const over = length - maxLength;
  const isOver = over > 0;
  const empty = text.trim() === '';
  const blocked = unavailable || empty || isOver;

  function submit(): void {
    if (blocked || busy) return;
    onSend(text.trim(), () => setText(''));
  }

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    submit();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2" data-testid="ask-form">
      <label htmlFor={inputId} className="text-small font-medium text-text-secondary">
        Your question
      </label>
      <textarea
        ref={textareaRef}
        id={inputId}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        rows={3}
        disabled={unavailable}
        aria-invalid={isOver ? 'true' : undefined}
        aria-describedby={`${hintId} ${countId}${error !== null ? ` ${errorId}` : ''}`}
        className={cn(
          'w-full rounded-md border border-border-strong bg-bg-surface p-2 text-small text-text-primary',
          'placeholder:text-text-muted focus-visible:outline-none',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'aria-[invalid=true]:border-status-danger-border',
        )}
        placeholder="For example, how much IRA contribution room is left?"
      />
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <p id={hintId} className="text-caption text-text-muted">
          Enter sends the question; Shift+Enter starts a new line.
        </p>
        <p
          id={countId}
          data-testid="ask-count"
          className={cn(
            'text-caption tabular-nums',
            isOver ? 'text-status-danger-text' : 'text-text-muted',
          )}
        >
          {String(length)} / {String(maxLength)} characters
          {isOver && ` — over by ${String(over)}`}
        </p>
      </div>
      {error !== null && (
        <p id={errorId} className="text-small text-status-danger-text" data-testid="ask-error">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          className="gap-1 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          disabled={unavailable}
          aria-disabled={blocked || busy ? 'true' : undefined}
          aria-busy={busy ? 'true' : undefined}
          data-testid="ask-submit"
        >
          {busy ? (
            <Loader2 size={14} aria-hidden="true" className="motion-safe:animate-spin" />
          ) : (
            <Send size={14} aria-hidden="true" />
          )}
          Ask
        </Button>
      </div>
      {examples.length > 0 && (
        <div data-testid="ask-examples">
          <p className="text-caption text-text-muted" id={`${id}-examples`}>
            Examples
          </p>
          <ul aria-labelledby={`${id}-examples`} className="mt-1 flex flex-wrap gap-2">
            {examples.map((example) => (
              <li key={example}>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={unavailable}
                  className="h-auto min-h-8 whitespace-normal py-1 text-left"
                  onClick={() => {
                    setText(example);
                    textareaRef.current?.focus();
                  }}
                >
                  {example}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </form>
  );
}
