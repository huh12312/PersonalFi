// SPDX-License-Identifier: MIT
import { Button } from '../../components/ui/button.tsx';
import { describeProblem } from './problem-words.ts';

export interface ProjectionProblemProps {
  /** Whatever the failed query threw — a problem document, or something that never got that far. */
  readonly error: unknown;
  /** Offered only when the refusal is one a retry can change. */
  readonly onRetry?: () => void;
  readonly className?: string;
}

/**
 * A refused plan request, in words (WP 9.7, G4-10). Replaces the spinner
 * sentence ("Projecting your plan…") an error used to hide behind: the headline
 * says what is wrong, the advice says what to do, and the code, the server's own
 * detail and its reference sit beneath for anyone who needs to quote them.
 *
 * `data-problem-words` records which branch rendered — `table` when
 * `problem-words.ts` has a sentence for the code, `fallback` when it does not —
 * so the e2e can fail on a code the table is missing without knowing the table.
 */
export function ProjectionProblem({ error, onRetry, className }: ProjectionProblemProps) {
  const problem = describeProblem(error);
  return (
    <div
      role="alert"
      data-testid="plan-problem"
      data-problem-words={problem.words}
      {...(problem.code === null ? {} : { 'data-problem-code': problem.code })}
      className={
        className ??
        'flex flex-col gap-2 rounded-md border border-status-critical bg-bg-subtle p-4 text-small text-text-primary'
      }
    >
      <p className="font-semibold">{problem.headline}</p>
      <p>{problem.advice}</p>
      {problem.detail !== null && (
        <p className="text-text-secondary">
          <span className="font-medium">Server detail:</span> {problem.detail}
        </p>
      )}
      {(problem.code !== null || problem.reference !== null) && (
        <p className="text-caption text-text-muted">
          {problem.code !== null && (
            <>
              Code <code className="font-mono">{problem.code}</code>
            </>
          )}
          {problem.code !== null && problem.reference !== null && ' · '}
          {problem.reference !== null && (
            <>
              Reference <code className="font-mono">{problem.reference}</code>
            </>
          )}
        </p>
      )}
      {problem.retryable && onRetry !== undefined && (
        <div>
          <Button type="button" size="sm" variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}
