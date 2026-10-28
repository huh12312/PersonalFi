// SPDX-License-Identifier: MIT
import { cn } from '../../lib/cn.ts';
import { formatAskTime, statusWords, type AskSession } from './ask-words.ts';

export interface AskHistoryProps {
  readonly sessions: readonly AskSession[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
}

/**
 * The holder's own questions, newest first: the question, its outcome in words and when it was asked. Picking one
 * shows it above. The state is always a word, never a colour alone.
 */
export function AskHistory({ sessions, selectedId, onSelect }: AskHistoryProps) {
  return (
    <section aria-labelledby="ask-history-heading" data-testid="ask-history">
      <h3 id="ask-history-heading" className="mb-2 text-h3 text-text-primary">
        Earlier questions
      </h3>
      {sessions.length === 0 ? (
        <p className="text-small text-text-muted" data-testid="ask-history-empty">
          No questions yet. The ones you ask will be listed here.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {sessions.map((session) => {
            const selected = session.id === selectedId;
            return (
              <li key={session.id}>
                <button
                  type="button"
                  aria-current={selected ? 'true' : undefined}
                  onClick={() => onSelect(session.id)}
                  data-testid="ask-history-item"
                  className={cn(
                    'flex min-h-10 w-full flex-col gap-0.5 rounded-md border px-3 py-2 text-left hover:bg-bg-subtle',
                    selected
                      ? 'border-accent bg-accent-wash'
                      : 'border-border-hairline bg-bg-surface',
                  )}
                >
                  <span className="text-small font-medium text-text-primary [overflow-wrap:anywhere]">
                    {session.question}
                  </span>
                  <span className="text-caption text-text-secondary">
                    {statusWords(session.status)} · {formatAskTime(session.createdAt)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
