// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import { describeProblem, PROBLEM_WORDS } from './problem-words.ts';

/**
 * The API's own typed tables, read as text (`?raw`) — the OpenAPI document does not enumerate problem
 * codes, so these are the contract (`problem-words.ts`'s header). A code added to any of them without a
 * sentence in `PROBLEM_WORDS` fails the first test below; a sentence for a code the API no longer has
 * fails the second.
 */
const SOURCES = import.meta.glob(
  [
    '../../../../../packages/contexts/planning/src/projection-store.ts',
    '../../../../../packages/contexts/planning/src/engine/boundary.ts',
    '../../../../../packages/contexts/planning/src/engine/worker-host.ts',
    '../../../../../packages/contexts/planning/src/errors.ts',
    '../../../../../apps/api/src/routes/domain-errors.ts',
  ],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

function source(suffix: string): string {
  const entry = Object.entries(SOURCES).find(([path]) => path.endsWith(suffix));
  if (entry === undefined) throw new Error(`${suffix} was not found — the glob is stale`);
  return entry[1];
}

function unionCodes(text: string, name: string): string[] {
  const body = new RegExp(`export type ${name} =([^;]+);`).exec(text)?.[1];
  if (body === undefined) throw new Error(`type ${name} not found — the extractor is stale`);
  return [...body.matchAll(/'(planning\.[a-z_]+)'/g)].map((m) => m[1] as string);
}

function projectionProblemCodes(): string[] {
  const store = source('planning/src/projection-store.ts');
  const boundary = source('planning/src/engine/boundary.ts');
  const host = source('planning/src/engine/worker-host.ts');
  const domainErrors = source('routes/domain-errors.ts');
  const planning = source('planning/src/errors.ts');
  return [
    ...new Set([
      // Goals, contributions and the questionnaire. Earmarks have no route (wp4.8) and no screen.
      ...unionCodes(planning, 'PlanningErrorCode').filter((code) => !code.includes('earmark')),
      ...unionCodes(store, 'ProjectionRefusalCodeWp46'),
      ...unionCodes(boundary, 'ProjectionRefusalCode'),
      ...unionCodes(host, 'MonteCarloRefusalCode'),
      ...[...host.matchAll(/readonly code = '(planning\.[a-z_]+)'/g)].map((m) => m[1] as string),
      ...[...domainErrors.matchAll(/'(planning\.assumptions_[a-z_]+)': \{ status/g)].map(
        (m) => m[1] as string,
      ),
    ]),
  ];
}

describe('PROBLEM_WORDS', () => {
  it('has a sentence for every code the plan, goal and questionnaire routes can answer with', () => {
    const codes = projectionProblemCodes();
    // The extractor must see the whole class, or this test would pass over an empty list.
    expect(codes.length).toBeGreaterThanOrEqual(40);
    expect(codes).toContain('planning.projection_no_balances');
    const missing = codes.filter((code) => PROBLEM_WORDS[code] === undefined);
    expect(missing).toEqual([]);
  });

  it('has no sentence for a code the API no longer answers with', () => {
    const codes = new Set(projectionProblemCodes());
    const orphaned = Object.keys(PROBLEM_WORDS).filter((code) => !codes.has(code));
    expect(orphaned).toEqual([]);
  });

  it('writes every entry as a sentence of its own, never a bare code', () => {
    for (const [code, words] of Object.entries(PROBLEM_WORDS)) {
      expect(words.headline.split(/\s+/).length, code).toBeGreaterThanOrEqual(4);
      expect(words.advice.split(/\s+/).length, code).toBeGreaterThanOrEqual(3);
      expect(words.headline, code).not.toContain('planning.');
      expect(words.headline.endsWith('.'), code).toBe(true);
      expect(words.advice.endsWith('.'), code).toBe(true);
    }
  });
});

describe('describeProblem', () => {
  it('words a known code from the table and keeps the server detail and reference apart from it', () => {
    const described = describeProblem({
      code: 'planning.projection_no_balances',
      status: 409,
      detail: 'no sealed net-worth day exists yet',
      correlationId: 'corr-1',
    });
    expect(described.words).toBe('table');
    expect(described.headline).toBe(PROBLEM_WORDS['planning.projection_no_balances']?.headline);
    expect(described.detail).toBe('no sealed net-worth day exists yet');
    expect(described.reference).toBe('corr-1');
  });

  it('still words a code it does not know, by status, and says it is the fallback', () => {
    const described = describeProblem({ code: 'planning.something_new', status: 409 });
    expect(described.words).toBe('fallback');
    expect(described.headline).not.toBe('');
    expect(described.code).toBe('planning.something_new');
  });

  it('offers a retry for a server fault and not for a refusal', () => {
    expect(describeProblem({ code: 'x.y', status: 503 }).retryable).toBe(true);
    expect(
      describeProblem({ code: 'planning.projection_no_balances', status: 409 }).retryable,
    ).toBe(false);
    expect(describeProblem({ code: 'planning.montecarlo_timeout', status: 503 }).retryable).toBe(
      true,
    );
  });

  it('words something that was never a problem document (a dropped connection) as unreachable', () => {
    for (const thrown of [new TypeError('Failed to fetch'), 'boom', null, undefined]) {
      const described = describeProblem(thrown);
      expect(described.words).toBe('fallback');
      expect(described.headline).toMatch(/could not be reached/i);
      expect(described.retryable).toBe(true);
    }
  });

  it('words a 401 as a session problem rather than a plan problem', () => {
    expect(describeProblem({ code: 'unauthenticated', status: 401 }).headline).toMatch(/session/i);
  });
});
