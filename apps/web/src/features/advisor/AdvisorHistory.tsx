// SPDX-License-Identifier: MIT
import { cn } from '../../lib/cn.ts';
import { formatAdvisorTime, statusWords, type AdvisorSession } from './advisor-words.ts';

export interface AdvisorHistoryProps {
  readonly sessions: readonly AdvisorSession[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
}

/**
 * The holder's own sessions, newest first: the question, where it stands in words and when it was started. Picking
 * one shows it above. The state is always a word, never a colour alone.
 */
export function AdvisorHistory({ sessions, selectedId, onSelect }: AdvisorHistoryProps) {
  return (
    <section aria-labelledby="advisor-history-heading" data-testid="advisor-history">
      <h3 id="advisor-history-heading" className="mb-2 text-h3 text-text-primary">
        Earlier sessions
      </h3>
      {sessions.length === 0 ? (
        <p className="text-small text-text-muted" data-testid="advisor-history-empty">
          No sessions yet. The ones you start will be listed here.
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
                  data-testid="advisor-history-item"
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
                    {statusWords(session)} · {formatAdvisorTime(session.createdAt)}
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
