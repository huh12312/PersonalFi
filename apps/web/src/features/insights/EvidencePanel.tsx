// SPDX-License-Identifier: MIT
import type { Insight } from '../../api/generated/types.gen.ts';
import { displayValueOf, resolveEvidenceRef } from './evidence-resolver.ts';

export interface EvidencePanelProps {
  insight: Insight;
}

/**
 * The full evidence panel (02-phase-2-dispatch.md §3/§5: "every recommendation
 * renders a full evidence panel"). Every row here is one of `insight.evidence`
 * — resolved through `resolveEvidenceRef` against *this exact* insight's own
 * evidence array, never a value composed on this component's own account.
 * Doing the lookup through the resolver (rather than mapping the array
 * directly) is deliberate: it is the same code path a unit test exercises to
 * prove the panel cannot silently drift onto a number this insight never
 * cited (`evidence-resolver.test.ts`).
 *
 * Also carries the provenance strip (advisor id, confidence, confidence
 * basis, `requires_review`) and the proposed actions, none of which perform
 * a write — `proposed_actions[].kind` is one of `suggest_only` /
 * `open_url` / `create_goal_draft` / `create_rule_draft` (the response
 * schema's own four members), and none of the four is a transfer, a
 * category change, or any other mutation. `open_url` is the only kind
 * rendered as a real link; the rest are inert suggestions with their
 * rationale.
 */
export function EvidencePanel({ insight }: EvidencePanelProps) {
  // G5-9: a minor-unit leaf is money, and is printed as money in this
  // insight's own currency (`evidence-resolver.ts#displayValueOf`).
  const currency = insight.annualizedImpact?.currency ?? insight.oneTimeImpact?.currency ?? null;
  return (
    <div className="rounded-md bg-bg-subtle p-3" data-testid="evidence-panel">
      <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] gap-x-4 gap-y-1 [overflow-wrap:anywhere] text-caption text-text-muted">
        <dt>Advisor</dt>
        <dd className="text-text-secondary">{insight.advisorId}</dd>
        <dt>Confidence</dt>
        <dd className="text-text-secondary">
          {Math.round(insight.confidence * 100)}% ({insight.confidenceBasis})
        </dd>
        <dt>Needs your review</dt>
        <dd className="text-text-secondary">Yes — no advisor output ever applies itself</dd>
        {insight.impactBasis !== '' && (
          <>
            <dt>How the impact is figured</dt>
            <dd className="text-text-secondary">{insight.impactBasis}</dd>
          </>
        )}
      </dl>

      {/* h3, one level under `InsightCard`'s own h2 (the card title) — the
          panel renders inline inside the card, not in a separate document
          region, so its sub-headings continue that same chain rather than
          restarting at h2. */}
      <h3 className="mt-3 text-small font-semibold text-text-primary">Evidence</h3>
      <ul className="mt-1 flex flex-col gap-1.5">
        {insight.evidence.map((row) => {
          // `resolveEvidenceRef` re-looks-up the row by its own `sourceRef`
          // against this exact `insight.evidence` array — a no-op for a
          // valid contract today, and the load-bearing check the moment a
          // future advisor (Phase 5's local model, Phase 6's sidecar) or a
          // caching bug hands this component evidence that does not belong
          // to the insight it is rendered for.
          const resolved =
            row.sourceRef === null ? row : resolveEvidenceRef(insight.evidence, row.sourceRef);
          const display = displayValueOf(resolved, { currency });
          return (
            <li
              key={row.position}
              className="flex items-start justify-between gap-3 rounded bg-bg-surface px-2.5 py-1.5 text-small"
            >
              <div className="min-w-0">
                <p className="text-text-secondary">{row.label}</p>
                {row.sourceRef !== null && (
                  // Wrapped, not truncated (WP 11.3): an explanation keeps this panel open beneath it, and 1.4.12
                  // text spacing at 200 % zoom must not clip the source.
                  <p className="text-caption text-text-muted [overflow-wrap:anywhere]">
                    source: {row.sourceRef}
                  </p>
                )}
              </div>
              <div className="shrink-0 text-right">
                <p className="font-medium text-text-primary" data-testid="evidence-value">
                  {display}
                </p>
                {row.href !== null && (
                  // A plain anchor rather than the router's typed `Link`: this
                  // `href` is server data (`insight_evidence.href`), not one of
                  // the statically-known routes `Link`'s `to` prop is checked
                  // against, and it always points inside this SPA (never an
                  // external host — `@ctx/insights` only ever writes an
                  // in-app path here), so a same-origin navigation is safe.
                  <a href={row.href} className="text-caption text-accent-text hover:underline">
                    View transaction
                  </a>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {insight.caveats.length > 0 && (
        <>
          <h3 className="mt-3 text-small font-semibold text-text-primary">Caveats</h3>
          <ul className="mt-1 list-disc pl-5 text-small text-text-secondary">
            {insight.caveats.map((caveat) => (
              <li key={caveat}>{caveat}</li>
            ))}
          </ul>
        </>
      )}

      {insight.actions.length > 0 && (
        <>
          <h3 className="mt-3 text-small font-semibold text-text-primary">Suggested next steps</h3>
          <ul className="mt-1 flex flex-col gap-1.5">
            {insight.actions.map((action) => (
              <li key={action.position} className="rounded bg-bg-surface px-2.5 py-1.5 text-small">
                {action.kind === 'open_url' && action.url !== null ? (
                  <a
                    href={action.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-accent-text hover:underline"
                  >
                    {action.label}
                  </a>
                ) : (
                  <span className="font-medium text-text-primary">{action.label}</span>
                )}
                {action.rationaleMd !== '' && (
                  <p className="mt-0.5 text-caption text-text-muted">{action.rationaleMd}</p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="mt-3 text-caption text-text-muted">
        Educational information, not financial advice — you decide what to do with it.
      </p>
    </div>
  );
}
