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
import { createNarratorAdvisor, type NarratorModelPort } from '../src/advisors/local/narrator.ts';
import { resolveLimits } from '../src/contract/manifest.ts';
import type { AdvisorRequest, NarratedFinding } from '../src/contract/request.ts';
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

// ---------------------------------------------------------------------------
// WP 5.3b — closing the red-team leaks (wp5.4-redteam.md §4, F-1..F-5, F-8)
// ---------------------------------------------------------------------------
//
// One case per finding, named for it, against a hand-built `NarratedFinding`
// rather than a real built-in: the point of each case is the *shape* of the
// figure (an identifier's digits, a non-ASCII digit, a spelled-out number, a
// bidi override outside `summary_md`, a relabelled ref), not which rule
// produced it — `apps/api/test/redteam.test.ts` is where the real builders,
// the real adapter and the corpus prove the fix against production text.

function syntheticFinding(overrides: Partial<NarratedFinding> = {}): NarratedFinding {
  return {
    key: 'investing.concentration.C98', // gitleaks:allow — the synthetic C98 symbol (F-1), a finding key not a credential
    period: '2026-09',
    type: 'investing.concentration',
    severity: 'urgent',
    title: 'One position is a large share of the portfolio',
    summary_md: 'C98 is 33.05% of investable assets — $2,500.00 of $3,734.00.',
    evidence: [
      {
        label: 'What this position is worth',
        value: '$2,500.00',
        source_ref: 'snapshot:holdings_aggregate.top_positions[0].value',
      },
      {
        label: 'Investable assets',
        value: '$3,734.00',
        source_ref: 'snapshot:holdings_aggregate.investable_total',
      },
    ],
    derived: [],
    impact: { annualized: null, one_time: null, basis: '' },
    ...overrides,
  };
}

describe('WP 5.3b — closing the red-team leaks', () => {
  it('F-1: a digit run inside a quoted identifier (a key, a symbol, a slug) is never a licensed figure', async () => {
    const snapshot = await seedSnapshot('drift');
    const finding = syntheticFinding();

    // The finding's title/summary quote the symbol `C98` and the category
    // slug never appears at all — neither is a figure the finding rendered,
    // so `98` stays untraceable however it is spelled into a narration.
    const laundered = narrationOf(finding, [0, 1], {
      summary_md:
        'C98 is 33.05% of investable assets. A bad year could cost you $98 on this holding alone.',
    });
    expect(verdictOf(narrate(snapshot, [finding], [laundered]))).toEqual([
      'numerals:numeral_not_in_finding',
    ]);

    // The control: the finding's own evidence-backed figures, verbatim, pass.
    const faithful = narrationOf(finding, [0, 1], {
      summary_md: 'This position is worth $2,500.00 of $3,734.00 in investable assets.',
    });
    expect(verdictOf(narrate(snapshot, [finding], [faithful]))).toEqual(['accepted']);
  });

  it('F-2: a fabricated figure in fullwidth or Arabic-Indic digits is refused after folding to ASCII', async () => {
    const snapshot = await seedSnapshot('drift');
    const finding = syntheticFinding();

    // Fullwidth (NFKC-foldable): the finding never rendered $4,200.00 in any form.
    const fullwidth = narrationOf(finding, [0], {
      summary_md: 'About ＄４，２００．００ more this year.',
    });
    expect(verdictOf(narrate(snapshot, [finding], [fullwidth]))).toEqual([
      'numerals:numeral_not_in_finding',
    ]);

    // Arabic-Indic (NFKC leaves these alone; only the codepoint-block fold
    // catches them) — the same fabricated value, ٤٢٠٠.
    const arabicIndic = narrationOf(finding, [0], {
      summary_md: 'About $٤٢٠٠ more this year.',
    });
    expect(verdictOf(narrate(snapshot, [finding], [arabicIndic]))).toEqual([
      'numerals:numeral_not_in_finding',
    ]);

    // The same digits, genuinely the finding's own figure ($2,500.00) in
    // Arabic-Indic, still pass — folding is not a stricter check, only a
    // digit-script-blind one.
    const ownFigureFolded = narrationOf(finding, [0], {
      summary_md: 'Worth about $٢٥٠٠.٠٠ today.',
    });
    expect(verdictOf(narrate(snapshot, [finding], [ownFigureFolded]))).toEqual(['accepted']);
  });

  it('F-3: a markdown link or a bare URL in summary_md is refused against the allow-list (empty for a narrator)', async () => {
    const snapshot = await seedSnapshot('drift');
    const finding = syntheticFinding();

    const markdownLink = narrationOf(finding, [0], {
      summary_md: 'Worth $2,500.00. [Read more](https://evil.example/claim)',
    });
    expect(verdictOf(narrate(snapshot, [finding], [markdownLink]))).toEqual([
      'evidence:link_host_not_allowed',
    ]);

    const bareUrl = narrationOf(finding, [0], {
      summary_md: 'Worth $2,500.00. Details: https://evil.example/claim',
    });
    expect(verdictOf(narrate(snapshot, [finding], [bareUrl]))).toEqual([
      'evidence:link_host_not_allowed',
    ]);
  });

  it('F-4: a figure spelled out in words, with a currency or scale word beside it, is refused — a bare "three months" is not', async () => {
    const snapshot = await seedSnapshot('drift');
    const finding = syntheticFinding();

    const spelled = narrationOf(finding, [0], {
      summary_md: 'Worth about four thousand two hundred dollars today.',
    });
    expect(verdictOf(narrate(snapshot, [finding], [spelled]))).toEqual([
      'numerals:numeral_not_in_finding',
    ]);

    // The false-positive guard: a small number word with no currency or
    // scale word beside it is never a figure claim — template prose like
    // "worth checking again in three months" must still be quotable.
    const noClaim = narrationOf(finding, [0], {
      summary_md: 'Worth $2,500.00 today — worth checking again in three months.',
    });
    expect(verdictOf(narrate(snapshot, [finding], [noClaim]))).toEqual(['accepted']);

    // A spelled figure that renders to the finding's own value is allowed.
    const spelledOwn = narrationOf(finding, [1], {
      summary_md:
        'Investable assets come to about three thousand seven hundred and thirty-four dollars.',
    });
    expect(verdictOf(narrate(snapshot, [finding], [spelledOwn]))).toEqual(['accepted']);
  });

  it('F-5: a bidi override is refused in every free-text field, not only summary_md', async () => {
    const snapshot = await seedSnapshot('drift');
    const finding = syntheticFinding();
    const rlo = String.fromCodePoint(0x202e);
    const pdf = String.fromCodePoint(0x202c);

    const inTitle = narrationOf(finding, [0], { title: `Worth ${rlo}$2,500.00${pdf} today` });
    expect(verdictOf(narrate(snapshot, [finding], [inTitle]))).toEqual([
      'numerals:markdown_control_character',
    ]);

    // The contrast: summary_md was already checked before F-5 (unaffected).
    const inSummary = narrationOf(finding, [0], {
      summary_md: `Worth ${rlo}$2,500.00${pdf} today`,
    });
    expect(verdictOf(narrate(snapshot, [finding], [inSummary]))).toEqual([
      'numerals:markdown_control_character',
    ]);
  });

  it("F-8: a real figure under a label the finding's own ref does not carry is refused", async () => {
    const snapshot = await seedSnapshot('drift');
    const finding = syntheticFinding();

    // The value ($2,500.00) is genuinely evidence[0]'s own value; the label
    // is not evidence[0]'s own label ("What this position is worth").
    const relabelled = narrationOf(finding, [], {
      evidence: [
        {
          kind: 'metric',
          label: 'Investable assets',
          value: '$2,500.00',
          source_ref: finding.evidence[0]?.source_ref ?? null,
          url: null,
        },
      ],
    });
    expect(verdictOf(narrate(snapshot, [finding], [relabelled]))).toEqual([
      'evidence:narration_label_disagrees',
    ]);

    // The control: the finding's own label, verbatim, passes.
    const ownLabel = narrationOf(finding, [0]);
    expect(verdictOf(narrate(snapshot, [finding], [ownLabel]))).toEqual(['accepted']);
  });
});

// ---------------------------------------------------------------------------
// WP 9.5 — Narrator v2 (the Phase 5 gate's C5-4 / R-1 option A; R-2 option B)
// ---------------------------------------------------------------------------

/** A model port that answers every request with `items` as its reply's `insights`. */
function scriptedModel(items: (request: AdvisorRequest) => readonly unknown[]): NarratorModelPort {
  return {
    run: (request) =>
      Promise.resolve({
        contract_version: request.contract_version,
        request_id: request.request_id,
        advisor_id: request.advisor_id,
        advisor_version: request.advisor_version,
        produced_at: request.generated_at,
        diagnostics: { runtime_ms: 0, model: 'scripted', warnings: [] },
        insights: items(request),
      }),
  };
}

/** The production request shape: the envelope and an empty snapshot. */
function productionRequest(findings: readonly NarratedFinding[]): AdvisorRequest {
  return { ...requestFor(NARRATOR_MANIFEST, {}), findings: [...findings] };
}

/** `validateResponse` exactly as `service.ts` calls it for a narrator run. */
function asService(request: AdvisorRequest, body: unknown): ValidationOutcome {
  return validateResponse({
    request,
    manifest: NARRATOR_MANIFEST,
    limits: resolveLimits(NARRATOR_MANIFEST),
    body,
    knownFindingTypes: new Set(request.findings?.map((finding) => finding.type) ?? []),
  });
}

async function throughNarrator(
  request: AdvisorRequest,
  items: readonly unknown[],
): Promise<ValidationOutcome> {
  const narrator = createNarratorAdvisor({ model: scriptedModel(() => items) });
  return asService(request, await narrator.run(request, new AbortController().signal));
}

function acceptedIdentities(outcome: ValidationOutcome): readonly string[] {
  return outcome.ok
    ? outcome.accepted.map((entry) => `${entry.insight.key}|${entry.insight.type}`)
    : [];
}

describe('WP 9.5 — Narrator v2', () => {
  it("a narration's key and type are the request's: a reply naming another finding cannot attach to it", async () => {
    const snapshot = await seedSnapshot('drift');
    const { finding: rise } = await builtinFinding(PRICE_RISE, snapshot);
    const { finding: debt } = await builtinFinding('builtin.debt.minimum_only', snapshot);
    expect(debt.key).not.toBe(rise.key);
    const named = (finding: NarratedFinding) => ({
      key: finding.key,
      type: finding.type,
      period: finding.period,
    });

    // One finding per request (production since C5-2). The reply names the
    // *other* finding — a real one, which the built-ins did make — and words
    // the asked one faithfully. It is the asked finding's narration: the app
    // wrote its identity, so there was nothing for the model to get wrong.
    const single = productionRequest([rise]);
    const wordsRise = narrationOf(rise, [0, 1], {
      summary_md: 'This subscription went from $15.99 to $18.99 on 2026-06-01.',
      ...named(debt),
    });
    const attached = await throughNarrator(single, [wordsRise]);
    expect(verdictOf(attached)).toEqual(['accepted']);
    expect(acceptedIdentities(attached)).toEqual([`${rise.key}|${rise.type}`]);

    // The same reply naming the other finding and carrying *its* figure: it
    // still cannot attach to that finding — it is judged as the asked one's
    // narration, and the other finding's $145.00 is not the asked one's.
    const debtFigure = debt.evidence.find((row) => row.value === '$145.00')?.value;
    expect(debtFigure, 'the minimum-payment finding states $145.00').toBe('$145.00');
    const wordsDebt = narrationOf(rise, [1], {
      summary_md: 'The minimum payment is $145.00.',
      ...named(debt),
    });
    const refused = await throughNarrator(single, [wordsDebt]);
    expect(verdictOf(refused)).toEqual(['numerals:numeral_not_in_finding']);
    expect(acceptedIdentities(refused)).toEqual([]);

    // A request that numbers its findings: `finding: n` decides, never the
    // key the model wrote; a number outside the envelope has no identity and
    // is refused at step 2 rather than guessed at.
    const pair = productionRequest([rise, debt]);
    const byNumber = await throughNarrator(pair, [{ ...wordsRise, finding: 1 }]);
    expect(acceptedIdentities(byNumber)).toEqual([`${rise.key}|${rise.type}`]);
    const outOfRange = await throughNarrator(pair, [{ ...wordsRise, finding: 3 }]);
    expect(verdictOf(outOfRange)).toEqual(['response:schema:schema_violation']);
  });

  it('an evidence row the panel shows as a percent reaches the envelope with that display value', async () => {
    const snapshot = await seedSnapshot('drift');
    const entry = BUILTIN_CATALOGUE.find((item) => item.advisorId === 'builtin.debt.minimum_only');
    if (entry === undefined) throw new Error('no builtin.debt.minimum_only');
    const request = requestFor(entry.advisor.manifest, snapshot);
    const body = await entry.advisor.run(request, new AbortController().signal);
    const outcome = validateResponse({
      request,
      manifest: entry.advisor.manifest,
      limits: resolveLimits(entry.advisor.manifest),
      body,
    });
    if (!outcome.ok) throw new Error(outcome.rejection.reason);
    const validated = outcome.accepted[0];
    if (validated === undefined) throw new Error('no minimum-only finding on the drift seed');

    // The built-in states the rate in its prose and leaves the row's value
    // null; the evidence panel shows the validator's resolved display.
    const position = validated.insight.evidence.findIndex((row) => row.label === 'The rate');
    expect(position).toBeGreaterThanOrEqual(0);
    expect(validated.insight.evidence[position]?.value).toBeNull();
    expect(validated.evidence[position]?.resolvedDisplay).toBe('0.2399');
    expect(validated.insight.summary_md).toContain('23.99%');

    // The envelope now carries what the holder is shown for that row.
    const finding = narratedFindingOf(findingSourceOf(validated));
    expect(finding.evidence[position]?.value).toBe('23.99%');

    // So the finding's own percent, cited and stated, is accepted — the
    // Phase 5 gate's eight step-5 and four step-7 refusals in one case …
    const own = narrationOf(finding, [position], {
      summary_md: 'This card is being paid at the minimum while it charges 23.99%.',
    });
    expect(own.evidence[0]?.value).toBe('23.99%');
    expect(verdictOf(narrate(snapshot, [finding], [own]))).toEqual(['accepted']);

    // … and nothing is widened: a different percent is still not a figure of
    // this finding, in the prose or in the row.
    const otherProse = narrationOf(finding, [position], {
      summary_md: 'This card charges 24%.',
    });
    expect(verdictOf(narrate(snapshot, [finding], [otherProse]))).toEqual([
      'numerals:numeral_not_in_finding',
    ]);
    const otherRow = narrationOf(finding, [], {
      evidence: [
        {
          kind: 'metric',
          label: 'The rate',
          value: '24%',
          source_ref: finding.evidence[position]?.source_ref ?? null,
          url: null,
        },
      ],
    });
    expect(verdictOf(narrate(snapshot, [finding], [otherRow]))).toEqual([
      'evidence:narration_value_disagrees',
    ]);
  });
});
