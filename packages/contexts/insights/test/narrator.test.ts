// SPDX-License-Identifier: MIT
/**
 * WP 5.3 — the narrator may say only what its finding said.
 *
 * Every case here builds the narrated finding the way production does: a real
 * built-in rule runs over the `drift` seed's real snapshot (`SnapshotBuilder`
 * through the in-memory ports), its output goes through `validateResponse`, and
 * the accepted insight becomes the envelope entry (`findingSourceOf` →
 * `narratedFindingOf`). The narrator's request then carries **the full drift
 * snapshot**, not the empty one production sends: the validator must refuse a
 * misattributed figure because of the narrow trace, not because the snapshot
 * that would have let it through happened to be absent.
 *
 * The first case is 05 §1's riskiest item, reproduced red first against the
 * snapshot-wide trace (the evidence file's §3 records the red run): a real
 * snapshot figure — the holder's August income, `$5,400.00` — quoted as the
 * annual cost of a price rise. Snapshot-wide it traces (`540000 ÷ 100`); under
 * the narrow trace it is not one of the finding's own figures, and it fails.
 */
import { describe, expect, it } from 'vitest';
import { BUILTIN_CATALOGUE } from '../src/advisors/catalogue.ts';
import {
  findingSourceOf,
  launderFindings,
  narratedFindingOf,
  type FindingSource,
} from '../src/advisors/local/findings.ts';
import { NARRATOR_MANIFEST, NARRATOR_SCOPES } from '../src/advisors/local/manifest.ts';
import { resolveLimits } from '../src/contract/manifest.ts';
import type { NarratedFinding } from '../src/contract/request.ts';
import type { Insight } from '../src/contract/response.ts';
import type { AdvisorSnapshot } from '../src/contract/snapshot.ts';
import { validateResponse, type ValidationOutcome } from '../src/validate/pipeline.ts';
import { requestFor, seedSnapshot } from './advisors/seed.ts';

async function builtinFinding(
  advisorId: string,
  snapshot: AdvisorSnapshot,
): Promise<{ readonly source: FindingSource; readonly finding: NarratedFinding }> {
  const entry = BUILTIN_CATALOGUE.find((item) => item.advisorId === advisorId);
  if (entry === undefined) throw new Error(`no advisor ${advisorId}`);
  const { manifest } = entry.advisor;
  const request = requestFor(manifest, snapshot);
  const body = await entry.advisor.run(request, new AbortController().signal);
  const outcome = validateResponse({ request, manifest, limits: resolveLimits(manifest), body });
  if (!outcome.ok) throw new Error(`builtin refused: ${outcome.rejection.reason}`);
  const validated = outcome.accepted[0];
  if (validated === undefined) throw new Error(`${advisorId} made no finding on this seed`);
  const source = findingSourceOf(validated);
  return { source, finding: narratedFindingOf(source) };
}

function narrate(
  snapshot: AdvisorSnapshot,
  findings: readonly NarratedFinding[],
  narrations: readonly Insight[],
): ValidationOutcome {
  const request = { ...requestFor(NARRATOR_MANIFEST, snapshot), findings: [...findings] };
  return validateResponse({
    request,
    manifest: NARRATOR_MANIFEST,
    limits: resolveLimits(NARRATOR_MANIFEST),
    body: {
      contract_version: 1,
      request_id: request.request_id,
      advisor_id: NARRATOR_MANIFEST.advisor_id,
      advisor_version: NARRATOR_MANIFEST.version,
      produced_at: '2026-09-19T08:16:00.000Z',
      diagnostics: { runtime_ms: 0, model: null, warnings: [] },
      insights: narrations,
    },
    // What `service.ts` now supplies: the types of the findings it sent.
    knownFindingTypes: new Set(findings.map((finding) => finding.type)),
  });
}

/** A narration of `finding` citing its evidence rows `cite` (by position), with `overrides`. */
function narrationOf(
  finding: NarratedFinding,
  cite: readonly number[],
  overrides: Partial<Insight> = {},
): Insight {
  return {
    key: finding.key,
    period: finding.period,
    type: finding.type,
    severity: finding.severity,
    title: 'Plain wording of a finding',
    summary_md: 'Plain wording.',
    confidence: 0.6,
    confidence_basis: 'model',
    horizon: 'this_period',
    requires_review: true,
    impact: { annualized: null, one_time: null, basis: '', derivation_id: null },
    evidence: cite.map((position) => {
      const row = finding.evidence[position];
      if (row === undefined) throw new Error(`no evidence row ${String(position)}`);
      return {
        kind: 'metric',
        label: row.label,
        value: row.value,
        source_ref: row.source_ref,
        url: null,
      };
    }),
    derivations: [],
    proposed_actions: [],
    caveats: [],
    expires_at: null,
    ...overrides,
  };
}

function verdictOf(outcome: ValidationOutcome): readonly string[] {
  if (!outcome.ok) return [`response:${outcome.rejection.step}:${outcome.rejection.reason}`];
  return [
    ...outcome.accepted.map(() => 'accepted'),
    ...outcome.rejected.map((rejection) => `${rejection.step}:${rejection.reason}`),
  ];
}

const PRICE_RISE = 'builtin.subscriptions.price_increase';

describe('the narrator (WP 5.3)', () => {
  it('a narration may use only the figures of the finding it narrates: a real snapshot value from elsewhere is rejected', async () => {
    const snapshot = await seedSnapshot('drift');
    const { finding } = await builtinFinding(PRICE_RISE, snapshot);
    // The finding's own figures, as it rendered them: $15.99, $18.99, the
    // date, and the $36.00 a year of its summary.
    expect(finding.summary_md).toContain('$36.00');

    // The control: faithful wording, the finding's own figures verbatim.
    const faithful = narrationOf(finding, [0, 1], {
      title: 'A subscription now costs more',
      summary_md: 'This subscription went from $15.99 to $18.99 on 2026-06-01.',
    });
    expect(verdictOf(narrate(snapshot, [finding], [faithful]))).toEqual(['accepted']);

    // The §1 finding. `$5,400.00` is real — it is August's income, in the
    // snapshot as `cashflow_monthly.months[14].income.minor = 540000` — and
    // it is attached to the wrong claim.
    const incomeCents = JSON.stringify(snapshot).includes('"540000"');
    expect(incomeCents, 'the misattributed figure is genuinely in the snapshot').toBe(true);
    const misattributed = narrationOf(finding, [0, 1], {
      title: 'A subscription now costs more',
      summary_md:
        'This subscription went from $15.99 to $18.99 on 2026-06-01, about $5,400.00 more a year.',
    });
    const outcome = narrate(snapshot, [finding], [misattributed]);
    expect(verdictOf(outcome)).toEqual(['numerals:numeral_not_in_finding']);

    // And a figure the finding *did* render, reformatted: rounding is not
    // quoting. `$36` is not `$36.00`.
    const rounded = narrationOf(finding, [0, 1], {
      summary_md: 'This subscription went from $15.99 to $18.99, about $36 more a year.',
    });
    expect(verdictOf(narrate(snapshot, [finding], [rounded]))).toEqual([
      'numerals:numeral_not_in_finding',
    ]);
  });

  it('a narration of a finding the builtins did not make is rejected', async () => {
    const snapshot = await seedSnapshot('drift');
    const { finding } = await builtinFinding(PRICE_RISE, snapshot);

    // A type nobody found.
    const newType = narrationOf(finding, [1], { type: 'subscription.cancel_now' });
    expect(verdictOf(narrate(snapshot, [finding], [newType]))).toEqual([
      'capability:narrator_introduced_finding',
    ]);

    // A known type under a key the built-ins never used: the 1:1 check, not
    // the type check, is what refuses it. It cites the real finding's refs
    // and quotes only the real finding's figures, so nothing later would.
    const newKey = narrationOf(finding, [1], {
      key: `${finding.key}.second`,
      summary_md: 'A second subscription rose to $18.99.',
    });
    expect(verdictOf(narrate(snapshot, [finding], [newKey]))).toEqual([
      'capability:narration_finding_mismatch',
    ]);

    // Its own period, not another: the identity is (key, period).
    const otherPeriod = narrationOf(finding, [1], { period: '2026-08' });
    expect(verdictOf(narrate(snapshot, [finding], [otherPeriod]))).toEqual([
      'capability:narration_finding_mismatch',
    ]);

    // A ref the finding never cited, though it resolves in the snapshot.
    const offFinding = narrationOf(finding, [1], {
      evidence: [
        {
          kind: 'metric',
          label: 'Income last month',
          value: '$5,400.00',
          source_ref: 'snapshot:cashflow_monthly.months[14].income',
          url: null,
        },
      ],
    });
    expect(verdictOf(narrate(snapshot, [finding], [offFinding]))).toEqual([
      'evidence:narration_ref_not_in_finding',
    ]);

    // No envelope at all: a narrator with nothing to narrate narrates nothing.
    const request = requestFor(NARRATOR_MANIFEST, snapshot);
    const bare = validateResponse({
      request,
      manifest: NARRATOR_MANIFEST,
      limits: resolveLimits(NARRATOR_MANIFEST),
      body: {
        contract_version: 1,
        request_id: request.request_id,
        advisor_id: NARRATOR_MANIFEST.advisor_id,
        advisor_version: NARRATOR_MANIFEST.version,
        produced_at: '2026-09-19T08:16:00.000Z',
        diagnostics: { runtime_ms: 0, model: null, warnings: [] },
        insights: [narrationOf(finding, [1])],
      },
      knownFindingTypes: new Set([finding.type]),
    });
    expect(verdictOf(bare)).toEqual(['capability:narration_finding_mismatch']);
  });

  it("a narrator cannot claim deterministic, carry impact, propose an action or rise above its finding's severity", async () => {
    const snapshot = await seedSnapshot('drift');
    const { finding } = await builtinFinding(PRICE_RISE, snapshot);
    expect(finding.severity).toBe('notable');

    const cases: readonly [string, Partial<Insight>][] = [
      ['capability:deterministic_not_claimed', { confidence_basis: 'deterministic' }],
      ['capability:narration_basis_not_model', { confidence_basis: 'heuristic' }],
      [
        'capability:impact_not_claimed',
        {
          impact: {
            annualized: { minor: '3600', currency: 'USD' },
            one_time: null,
            basis: 'The difference across a year.',
            derivation_id: null,
          },
        },
      ],
      [
        'capability:narrator_proposed_action',
        {
          proposed_actions: [
            { kind: 'suggest_only', label: 'Review it', rationale_md: 'Worth a look.', url: null },
          ],
        },
      ],
      [
        'capability:narrator_declared_derivation',
        {
          derivations: [
            {
              id: 'annual',
              expression: '$0 * 12',
              inputs: ['snapshot:recurring_list.streams[0].typical_amount.minor'],
              value: '22788',
              note: null,
            },
          ],
        },
      ],
      ['capability:narration_above_finding_severity', { severity: 'warning' }],
      ['capability:narration_above_finding_severity', { severity: 'urgent' }],
    ];
    for (const [expected, overrides] of cases) {
      const outcome = narrate(snapshot, [finding], [narrationOf(finding, [1], overrides)]);
      expect(verdictOf(outcome), expected).toEqual([expected]);
    }

    // At or below is fine: quieter wording of the same finding.
    const quieter = narrationOf(finding, [1], { severity: 'info' });
    expect(verdictOf(narrate(snapshot, [finding], [quieter]))).toEqual(['accepted']);
  });

  it('a finding whose source scopes the narrator was not granted never enters its request', async () => {
    const snapshot = await seedSnapshot('drift');
    const cash = await builtinFinding('builtin.cash.yield_spread', snapshot);
    const holdings = await builtinFinding('builtin.investing.expense_ratio', snapshot);
    const candidates = [
      { source: cash.source, sourceScopes: ['cash.summary', 'market.rates'] },
      { source: holdings.source, sourceScopes: ['holdings.detail'] },
      // A finding whose source run was pruned: no provable scopes, so out.
      { source: { ...cash.source, key: 'cash.orphaned' }, sourceScopes: null },
    ];

    // A narrator granted cash.summary and market.rates: the cash finding
    // enters, the holdings.detail one never does, the orphan never does.
    const cashOnly = launderFindings(candidates, ['cash.summary', 'market.rates']);
    expect(cashOnly.admitted.map((candidate) => candidate.source.key)).toEqual([cash.source.key]);
    expect(cashOnly.excluded).toEqual([
      { key: holdings.source.key, ungranted: ['holdings.detail'], reason: 'scope_not_granted' },
      { key: 'cash.orphaned', ungranted: [], reason: 'source_run_unknown' },
    ]);

    // Subset, not overlap: cash.summary alone does not admit a finding that
    // also read market.rates.
    expect(launderFindings(candidates, ['cash.summary']).admitted).toEqual([]);

    // The manifest's full bound admits both — and never transactions.raw,
    // which the narrator does not even ask for.
    expect(NARRATOR_SCOPES).not.toContain('transactions.raw');
    const full = launderFindings(
      [...candidates, { source: cash.source, sourceScopes: ['transactions.raw'] }],
      NARRATOR_SCOPES,
    );
    expect(full.admitted.map((candidate) => candidate.source.key)).toEqual([
      cash.source.key,
      holdings.source.key,
    ]);
  });
});
