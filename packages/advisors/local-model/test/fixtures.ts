// SPDX-License-Identifier: MIT
/**
 * A request in the shape `@ctx/insights`' shared fixture builds
 * (`packages/contexts/insights/test/fixtures.ts` → `baseRequest`), restated
 * here because this layer may not import `@ctx/insights`. Same worked
 * example — the $18.99/month subscription, the two cash accounts — plus a
 * `goals_list` block, because a goal name is the holder's own free text and
 * the most direct way their words reach a prompt.
 */
import type { LocalModelRequest } from '../src/request.ts';

export const TODAY = '2026-09-19';
export const NOW = '2026-09-19T09:00:00.000Z';
export const FAR_DEADLINE = '2099-01-01T00:00:00.000Z';
export const MERCHANT_REF = 'MERCHANT_a7f31c9d0e42';

/** Ollama's `/api/tags` form (no prefix) and the config's (`sha256:`). */
export const SERVED_DIGEST_HEX = '845dbda0ea48ed749caafd9e6037047aa19acfcfd82e704d7ca97d631a0b697e';
export const PINNED_DIGEST = `sha256:${SERVED_DIGEST_HEX}`;
export const MODEL_NAME = 'qwen2.5:7b-instruct-q4_K_M';

export function baseSnapshot(goalName = 'House deposit'): Record<string, unknown> {
  return {
    cash_summary: {
      as_of: TODAY,
      total: { minor: '412350', currency: 'USD' },
      account_count: 2,
      blended_apy: 0.0125,
      emergency_fund_months: null,
      accounts: [
        {
          account_ref: '01930000-0000-7000-8000-0000000000a1',
          type: 'checking',
          balance: { minor: '212350', currency: 'USD' },
          apy: 0,
        },
        {
          account_ref: '01930000-0000-7000-8000-0000000000a2',
          type: 'savings',
          balance: { minor: '200000', currency: 'USD' },
          apy: 0.0425,
        },
      ],
    },
    recurring_list: {
      as_of: TODAY,
      currency: 'USD',
      streams: [
        {
          series_ref: '01930000-0000-7000-8000-0000000000b1',
          merchant_ref: MERCHANT_REF,
          cadence: 'MONTHLY',
          type: 'SUBSCRIPTION',
          status: 'ACTIVE',
          user_confirmed: true,
          confidence: 0.94,
          typical_amount: { minor: '1899', currency: 'USD' },
          observed_min: { minor: '1899', currency: 'USD' },
          observed_max: { minor: '1899', currency: 'USD' },
          next_due_date: '2026-10-01',
          first_seen: '2025-10-01',
          last_seen: '2026-09-01',
          periods_per_year: 12,
          eligible_for_impact: true,
          price_changes: [],
        },
      ],
    },
    goals_list: {
      goals: [
        {
          goal_ref: 'GOAL_3c9e51d07a2b',
          name: goalName,
          target: { minor: '2500000', currency: 'USD' },
          horizon_months: 30,
          progress: 0.32,
        },
      ],
    },
  };
}

export function baseRequest(overrides: Partial<LocalModelRequest> = {}): LocalModelRequest {
  return {
    contract_version: 1,
    request_id: '01930000-0000-7000-8000-00000000f001',
    advisor_id: 'local.narrator',
    advisor_version: '1.0.0',
    kind: 'local_model',
    base_currency: 'USD',
    time_zone: 'America/New_York',
    today: TODAY,
    granted_scopes: ['cash.summary', 'recurring.list', 'goals.list'],
    input_digest: `sha256:${'a'.repeat(64)}`,
    limits: { max_insights: 5, max_response_bytes: 131_072, deadline: FAR_DEADLINE },
    snapshot: baseSnapshot(),
    ...overrides,
  };
}

/** Every string anywhere in a JSON value. */
export function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  return Object.entries(value).flatMap(([key, item]) => [key, ...stringsIn(item)]);
}
