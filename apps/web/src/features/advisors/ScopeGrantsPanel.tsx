// SPDX-License-Identifier: MIT
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import {
  getAdvisorScopesOptions,
  getAdvisorScopesQueryKey,
  listAdvisorGrantEventsQueryKey,
  listAdvisorsQueryKey,
  putAdvisorGrantsMutation,
} from '../../api/generated/@tanstack/react-query.gen.ts';
import type { AdvisorScopeDefinition, Problem } from '../../api/generated/types.gen.ts';
import { Badge } from '../../components/ui/badge.tsx';
import { Button } from '../../components/ui/button.tsx';
import { SkeletonText } from '../../components/patterns/Skeleton.tsx';
import { useStepUpRetry } from '../../lib/step-up.ts';
import { GrantHistory } from './GrantHistory.tsx';

export interface ScopeGrantsPanelProps {
  advisorId: string;
}

function problemDetail(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const problem = error as Partial<Problem>;
    return `${problem.title ?? 'Request failed'} (${String(problem.code)})${
      problem.detail !== undefined ? ` — ${problem.detail}` : ''
    }`;
  }
  return null;
}

/**
 * The scope grant surface over WP 4.8's consent route
 * (`PUT /advisors/{id}/grants`), 05-phase-5-dispatch.md §3 WP 5.12: "each
 * scope showing what it yields and what it drops, in sensitivity order,
 * before the step-up". `getAdvisorScopesOptions` is fetched and rendered
 * unconditionally on mount — the yields/drops text is on screen long
 * before any grant action exists to trigger a step-up, which is the
 * property the dispatch's sabotage ("yields/drops hidden before step-up")
 * checks for.
 *
 * A `requiresPerRunConsent` scope (G4-22,
 * `docs/evidence/phase-4/gate-security-review.md` C-12) is never offered as
 * a plain standing grant: its own checkbox carries the explanation that a
 * standing grant only records consent — the data still does not cross
 * into any one run unless that run is separately consented to — and
 * selecting it sets `perRunConsent: true` on the request, which is what the
 * route's 422 `insights.per_run_consent_required` demands before it will
 * store such a grant at all (wp5.1-run-control.md §8 G4-22).
 *
 * **What the advisor actually asks for (G5-3, WP 9.6).** Each scope says
 * whether this advisor's manifest requests it. The gate found the narrator's
 * panel offering 18 scopes for 13 asked, so "grant" was being said of data the
 * advisor would never receive. For a local-model or external advisor a scope it
 * does not request cannot be newly granted (the route refuses it, 422
 * `insights.scope_not_requested`), so its box is disabled and says why; a
 * scope already granted stays revocable. For a built-in the box stays usable,
 * the row says "not requested", and a save that granted such a scope says so
 * in the result line.
 *
 * **The history (O-9).** Below the list, every grant, revoke and re-grant this
 * advisor has had, with the sign-in session that authorised it.
 */
export function ScopeGrantsPanel({ advisorId }: ScopeGrantsPanelProps) {
  const scopesQuery = useQuery(getAdvisorScopesOptions({ path: { advisorId } }));
  const queryClient = useQueryClient();
  const stepUp = useStepUpRetry();
  const grantMutation = useMutation(putAdvisorGrantsMutation());
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<{
    granted: readonly string[];
    revoked: readonly string[];
    notRequested: readonly string[];
  } | null>(null);

  const scopes: readonly AdvisorScopeDefinition[] = scopesQuery.data?.scopes ?? [];
  const advisorKind = scopesQuery.data?.kind;
  const requestedCount = scopes.filter((scope) => scope.requested).length;

  /** A local-model or external advisor is never newly granted a scope it does not request (the route's 422). */
  function isLocked(scope: AdvisorScopeDefinition): boolean {
    return advisorKind !== 'builtin' && !scope.requested && !scope.granted;
  }
  // Sensitivity order, least sensitive first — the order the dispatch
  // names explicitly. The route already returns them in this order
  // (`getAdvisorScopesOptions`'s own doc comment); sorting again is
  // defensive, not a correction.
  const orderedScopes = [...scopes].sort((a, b) => a.sensitivity - b.sensitivity);

  // The checked state of a scope not yet explicitly toggled this session is
  // its own `granted` value — computed at render time, not synchronised
  // into `selected` by an effect (which only ever recomputed this exact
  // fallback one render late, and set state from inside an effect for no
  // external system to synchronise with — `react-hooks/set-state-in-effect`).
  // `selected` holds only the scopes a click has touched; everything else
  // reads straight from the fetched data.
  function isChecked(scope: AdvisorScopeDefinition): boolean {
    return scope.scope in selected ? selected[scope.scope]! : scope.granted;
  }

  function invalidate(): void {
    void queryClient.invalidateQueries({
      queryKey: getAdvisorScopesQueryKey({ path: { advisorId } }),
    });
    void queryClient.invalidateQueries({
      queryKey: listAdvisorGrantEventsQueryKey({ path: { advisorId } }),
    });
    void queryClient.invalidateQueries({ queryKey: listAdvisorsQueryKey() });
  }

  async function handleSave(): Promise<void> {
    setSaveError(null);
    const chosen = orderedScopes.filter((scope) => isChecked(scope));
    const needsPerRunConsent = chosen.some((scope) => scope.requiresPerRunConsent);
    try {
      const result = await stepUp.run(() =>
        grantMutation.mutateAsync({
          path: { advisorId },
          body: {
            scopes: chosen.map((scope) => scope.scope),
            ...(needsPerRunConsent ? { perRunConsent: true } : {}),
          },
        }),
      );
      setLastResult({
        granted: result.granted,
        revoked: result.revoked,
        notRequested: result.notRequested,
      });
      invalidate();
    } catch (cause) {
      const detail = problemDetail(cause);
      setSaveError(detail ?? 'The grant could not be saved.');
    }
  }

  if (scopesQuery.isLoading) return <SkeletonText lines={4} />;

  if (scopesQuery.isError) {
    return (
      <p className="text-small text-status-critical">
        {problemDetail(scopesQuery.error) ?? 'Scopes could not be loaded.'}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="scope-grants-panel">
      <p className="text-small text-text-muted">
        Each scope below names exactly what it hands this advisor and what it leaves out, in order
        from least to most sensitive. Checking a box only changes what is <em>stored as granted</em>
        ; the step-up prompt appears when you save.
      </p>
      <p className="text-small text-text-muted" data-testid="requested-summary">
        This advisor requests {String(requestedCount)} of the {String(scopes.length)} scopes listed.
        A scope it does not request is never read, whatever is granted.
      </p>
      <ul className="flex flex-col gap-2">
        {orderedScopes.map((scope) => (
          <li
            key={scope.scope}
            className="rounded-md border border-border-hairline bg-bg-surface p-3"
            data-testid="scope-row"
          >
            <div className="flex items-start justify-between gap-3">
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={isChecked(scope)}
                  onChange={(event) =>
                    setSelected((prev) => ({ ...prev, [scope.scope]: event.target.checked }))
                  }
                  disabled={isLocked(scope)}
                  aria-label={`Grant ${scope.scope}`}
                />
                <span>
                  <span className="font-mono text-small text-text-primary">{scope.scope}</span>
                  {scope.granted && (
                    <Badge variant="good" className="ml-2">
                      Currently granted
                    </Badge>
                  )}
                </span>
              </label>
              <Badge variant="neutral">Sensitivity {scope.sensitivity}</Badge>
            </div>
            <p
              className="mt-1 text-caption text-text-secondary"
              data-testid="scope-requested"
              data-requested={scope.requested ? 'true' : 'false'}
            >
              {scope.requested
                ? 'Requested by this advisor.'
                : isLocked(scope)
                  ? 'Not requested by this advisor, so it cannot be granted: it would never receive this data.'
                  : 'Not requested by this advisor: it never reads this scope, whatever is granted.'}
            </p>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-small">
              <dt className="text-text-muted">Yields</dt>
              <dd className="text-text-secondary">{scope.yields}</dd>
              <dt className="text-text-muted">Drops</dt>
              <dd className="text-text-secondary">{scope.drops}</dd>
            </dl>
            {scope.requiresPerRunConsent && (
              <p className="mt-2 rounded-md bg-bg-subtle p-2 text-caption text-text-secondary">
                Consented per run only: a standing grant records that you understand this scope
                exists, but its data still does not reach this advisor on any one run unless that
                run is separately consented to. Checking the box above sends{' '}
                <code>perRunConsent: true</code> with the save.
              </p>
            )}
          </li>
        ))}
      </ul>

      {saveError !== null && <p className="text-small text-status-critical">{saveError}</p>}
      {stepUp.error !== null && <p className="text-small text-status-critical">{stepUp.error}</p>}
      {lastResult !== null && (
        <p className="text-small text-text-secondary" role="status">
          Granted: {lastResult.granted.length === 0 ? 'none' : lastResult.granted.join(', ')}.
          Revoked: {lastResult.revoked.length === 0 ? 'none' : lastResult.revoked.join(', ')}.
          {lastResult.notRequested.length > 0 && (
            <>
              {' '}
              <span data-testid="not-requested-flag">
                Granted, but this advisor does not request {lastResult.notRequested.join(', ')}, so
                it will never read {lastResult.notRequested.length === 1 ? 'it' : 'them'}.
              </span>
            </>
          )}
        </p>
      )}

      <div>
        <Button onClick={() => void handleSave()} disabled={stepUp.busy || grantMutation.isPending}>
          {stepUp.busy || grantMutation.isPending ? 'Saving…' : 'Save grants'}
        </Button>
      </div>

      <GrantHistory advisorId={advisorId} />
    </div>
  );
}
