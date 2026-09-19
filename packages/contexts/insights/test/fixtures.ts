// SPDX-License-Identifier: MIT
/**
 * The shared fixture: one snapshot, one manifest, one well-formed insight.
 *
 * Every suite in this package starts from the same *valid* payload and then
 * breaks exactly one thing. That is deliberate: a test that builds its own
 * almost-valid payload proves that the payload was almost valid, not that the
 * check under test fired. `insightWith({ … })` produces the base insight with
 * one field replaced, so a red test names the field it broke and nothing else
 * differs.
 *
 * ## The worked example the fixture encodes
 *
 * A $18.99/month subscription. The snapshot carries `1899` minor units; the
 * body says *"$18.99 a month is $227.88 a year"*; the annual figure is nowhere
 * in the snapshot and is legitimate anyway, because the insight declares the
 * arithmetic (`$0 * 12`) and the validator re-computes it. That single example
 * exercises the whole anti-fabrication mechanism:
 *
 *   * `18.99` traces to `1899` under the ÷100 rendering;
 *   * `227.88` traces to the derivation's computed `22788`, under the same one;
 *   * change either number and there is nothing left to trace it to.
 */
import { newId } from '@core/kernel';
import type { AdvisorManifest } from '../src/contract/manifest.ts';
import type { AdvisorRequest } from '../src/contract/request.ts';
import type { AdvisorResponse, Insight } from '../src/contract/response.ts';
import type { AdvisorSnapshot } from '../src/contract/snapshot.ts';
import type { Advisor } from '../src/registry.ts';

export const TODAY = '2026-09-19';
export const NOW = '2026-09-19T09:00:00.000Z';
export const USD = 'USD';

/** `MERCHANT_<12 hex>` — the shape `createTokeniser` mints. */
export const MERCHANT_REF = 'MERCHANT_a7f31c9d0e42';

/**
 * A snapshot with two blocks: `cash.summary` and `recurring.list`.
 *
 * Two rather than one because several proofs need a path that resolves *and* a
 * plausible path that does not. `snapshot:budgets_status.…` is well-formed, is
 * something a real advisor would write, and is absent — which is exactly the
 * case `'an insight citing a path we did not send is rejected'` is about.
 */
export function baseSnapshot(): AdvisorSnapshot {
  return {
    cash_summary: {
      as_of: TODAY,
      total: { minor: '412350', currency: USD },
      account_count: 2,
      blended_apy: 0.0125,
      emergency_fund_months: null,
      accounts: [
        {
          account_ref: '01930000-0000-7000-8000-0000000000a1',
          type: 'checking',
          balance: { minor: '212350', currency: USD },
          apy: 0,
        },
        {
          account_ref: '01930000-0000-7000-8000-0000000000a2',
          type: 'savings',
          balance: { minor: '200000', currency: USD },
          apy: 0.0425,
        },
      ],
    },
    recurring_list: {
      as_of: TODAY,
      currency: USD,
      streams: [
        {
          series_ref: '01930000-0000-7000-8000-0000000000b1',
          merchant_ref: MERCHANT_REF,
          cadence: 'MONTHLY',
          type: 'SUBSCRIPTION',
          status: 'ACTIVE',
          user_confirmed: true,
          confidence: 0.94,
          typical_amount: { minor: '1899', currency: USD },
          observed_min: { minor: '1899', currency: USD },
          observed_max: { minor: '1899', currency: USD },
          next_due_date: '2026-10-01',
          first_seen: '2025-10-01',
          last_seen: '2026-09-01',
          periods_per_year: 12,
          eligible_for_impact: true,
          price_changes: [],
        },
      ],
    },
  };
}

export function baseManifest(overrides: Partial<AdvisorManifest> = {}): AdvisorManifest {
  return {
    advisor_id: 'builtin.subscriptions.annualised_cost',
    version: '1.0.0',
    contract_version: 1,
    kind: 'builtin',
    display_name: 'Subscription annual cost',
    purpose: 'Shows what a monthly subscription costs over a year.',
    requires_scopes: ['cash.summary', 'recurring.list'],
    triggers: [{ type: 'schedule', cron: '15 4 * * *' }],
    capabilities: {
      deterministic: true,
      produces_impact: true,
      narrates_only: false,
      max_severity: 'warning',
    },
    limits: { timeout_ms: 30_000, max_insights: 20, max_response_bytes: 131_072 },
    egress_allowlist: [],
    ...overrides,
  };
}

/**
 * The valid insight. `$18.99 a month is $227.88 a year.`
 *
 * Every numeral in it is traceable and every ref resolves — which is what makes
 * it useful as a base for breaking one thing at a time.
 */
export function baseInsight(overrides: Partial<Insight> = {}): Insight {
  return {
    key: 'subscription.annual_cost.MERCHANT_a7f31c9d0e42',
    period: '2026-09',
    type: 'subscription.annual_cost',
    severity: 'notable',
    title: 'A monthly subscription adds up',
    summary_md: 'At $18.99 a month, this subscription costs $227.88 a year.',
    confidence: 1,
    confidence_basis: 'deterministic',
    horizon: 'this_year',
    requires_review: true,
    impact: {
      annualized: { minor: '22788', currency: USD },
      one_time: null,
      basis: 'The monthly charge, multiplied by the periods in a year.',
      derivation_id: 'annualised',
    },
    evidence: [
      {
        kind: 'series',
        label: 'Monthly charge',
        value: '$18.99',
        source_ref: 'snapshot:recurring_list.streams[0].typical_amount',
        url: null,
      },
    ],
    derivations: [
      {
        id: 'annualised',
        expression: '$0 * 12',
        inputs: ['snapshot:recurring_list.streams[0].typical_amount.minor'],
        value: '22788',
        note: 'Minor units, times the twelve monthly periods in a year.',
      },
    ],
    proposed_actions: [
      {
        kind: 'suggest_only',
        label: 'Review this subscription',
        rationale_md: 'Worth a look if you no longer use it.',
        url: null,
      },
    ],
    caveats: [],
    expires_at: null,
    ...overrides,
  };
}

export interface FixtureBundle {
  readonly request: AdvisorRequest;
  readonly manifest: AdvisorManifest;
  readonly response: AdvisorResponse;
}

export function baseRequest(
  manifest: AdvisorManifest = baseManifest(),
  snapshot: AdvisorSnapshot = baseSnapshot(),
): AdvisorRequest {
  return {
    contract_version: 1,
    request_id: newId(),
    advisor_id: manifest.advisor_id,
    advisor_version: manifest.version,
    kind: manifest.kind,
    generated_at: NOW,
    base_currency: USD,
    time_zone: 'America/New_York',
    today: TODAY,
    granted_scopes: [...manifest.requires_scopes],
    // Any well-formed digest: the validator checks the *shape* of this field
    // and resolves refs against `snapshot`, never against the digest.
    input_digest: `sha256:${'a'.repeat(64)}`,
    limits: { max_insights: 20, max_response_bytes: 131_072, deadline: NOW },
    snapshot,
  };
}

export function responseFor(
  request: AdvisorRequest,
  insights: readonly Insight[],
): AdvisorResponse {
  return {
    contract_version: 1,
    request_id: request.request_id,
    advisor_id: request.advisor_id,
    advisor_version: request.advisor_version,
    produced_at: NOW,
    diagnostics: { runtime_ms: 3, model: null, warnings: [] },
    insights: [...insights],
  };
}

/** Everything a pipeline test needs, already agreeing with itself. */
export function fixture(
  overrides: {
    readonly insight?: Partial<Insight>;
    readonly manifest?: Partial<AdvisorManifest>;
  } = {},
): FixtureBundle {
  const manifest = baseManifest(overrides.manifest ?? {});
  const request = baseRequest(manifest);
  return {
    request,
    manifest,
    response: responseFor(request, [baseInsight(overrides.insight ?? {})]),
  };
}

/**
 * A registrable advisor that returns whatever it is given.
 *
 * `run` ignores the request, which is the honest shape for a test double here:
 * every suite that uses it is asserting something about *validation* or
 * *persistence*, and an advisor that recomputed its answer from the snapshot
 * would make those suites also depend on the recomputation being right.
 */
export function stubAdvisor(
  manifest: AdvisorManifest,
  respond: (request: AdvisorRequest) => unknown,
): Advisor {
  return { manifest, run: (request) => Promise.resolve(respond(request)) };
}
