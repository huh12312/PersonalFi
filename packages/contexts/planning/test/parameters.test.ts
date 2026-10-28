// SPDX-License-Identifier: MIT
/**
 * WP 11.5a — parameter citations: every cited node of the assumptions file has
 * one stable key, the key resolves back to `{ value, source, asOf }` as wire
 * data (no `bigint`, no float), and a key for a tax year the file does not hold
 * is refused exactly as `taxYear(a, 2027)` is — never substituted.
 *
 * The node count is taken by an independent walk of the **raw** data modules,
 * the WP 4.2 test's way, so the catalogue is checked against the file rather
 * than against itself.
 */
import { describe, expect, it } from 'vitest';
import { ASSUMPTIONS_FILE } from '../data/assumptions.ts';
import {
  AssumptionsYearUnavailable,
  CITED_KINDS,
  assumptionsVersion,
  loadAssumptions,
  taxYear,
} from '../src/assumptions.ts';
import {
  PARAMETER_KEY_PATTERN,
  UnknownParameterKey,
  isParameterRefusal,
  parameterByKey,
  parameterCatalogue,
  snakeSegment,
} from '../src/parameters.ts';

const CITED = new Set<string>(CITED_KINDS);

function countCitedNodes(node: unknown): number {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return 0;
  const record = node as Record<string, unknown>;
  if (
    typeof record['kind'] === 'string' &&
    CITED.has(record['kind']) &&
    typeof record['source'] === 'string'
  )
    return 1;
  return Object.values(record).reduce<number>((sum, inner) => sum + countCitedNodes(inner), 0);
}

function thrown(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('WP 11.5a — a key per cited node', () => {
  it('every cited node in the raw file has exactly one key, and every key is well formed', () => {
    const catalogue = parameterCatalogue();
    expect(catalogue.size).toBe(countCitedNodes(ASSUMPTIONS_FILE));
    expect(catalogue.size).toBe(93);
    for (const key of catalogue.keys()) expect(key).toMatch(PARAMETER_KEY_PATTERN);
    expect(new Set([...catalogue.values()].map((citation) => citation.key)).size).toBe(
      catalogue.size,
    );
  });

  it('the segment mapping is the snake_case of the property path', () => {
    expect(snakeSegment('electiveDeferral')).toBe('elective_deferral');
    expect(snakeSegment('catchUpAge60To63')).toBe('catch_up_age_60_to_63');
    expect(snakeSegment('form1099Da')).toBe('form_1099_da');
    expect(snakeSegment('treasuryBill3Month')).toBe('treasury_bill_3_month');
    expect(snakeSegment('mfj')).toBe('mfj');
  });

  it('a key resolves to the node: value, source and as-of, and the file version it was read from', () => {
    const node = taxYear(loadAssumptions(), 2026).retirement.electiveDeferral;
    const citation = parameterByKey('tax.us.2026.retirement.elective_deferral');
    expect(citation).toEqual({
      key: 'tax.us.2026.retirement.elective_deferral', // gitleaks:allow — a parameter key, not a secret
      kind: 'money',
      value: { minor: '2450000', currency: 'USD' },
      source: node.source,
      asOf: '2026-01-01',
      parametersVersion: assumptionsVersion(),
    });
    expect(citation.source).toContain('Notice 2025-67');
    expect(parameterByKey('assumptions.withdrawal_policy.guardrail_reference_rate')).toMatchObject({
      kind: 'rate',
      value: '0.045',
      asOf: '2026-09-10',
    });
    expect(
      parameterByKey('tax.us.2026.social_security.delayed_retirement_credit_ends_at_age'),
    ).toMatchObject({
      kind: 'integer',
      value: '70',
      unit: 'age_years',
    });
  });

  it('every value is wire data: JSON-serialisable, no bigint, no number for a magnitude', () => {
    for (const citation of parameterCatalogue().values()) {
      const text = JSON.stringify(citation);
      expect(JSON.parse(text)).toEqual(citation);
      const walk = (value: unknown): void => {
        expect(typeof value).not.toBe('bigint');
        expect(typeof value, citation.key).not.toBe('number');
        if (value !== null && typeof value === 'object') Object.values(value).forEach(walk);
      };
      walk(citation.value);
    }
  });

  it('a 2027 key is refused naming the years held, never answered from 2026', () => {
    const error = thrown(() => parameterByKey('tax.us.2027.retirement.elective_deferral'));
    expect(error).toBeInstanceOf(AssumptionsYearUnavailable);
    expect(error).toMatchObject({
      code: 'planning.assumptions_year_unavailable',
      year: 2027,
      available: ['2026'],
    });
    expect(isParameterRefusal(error)).toBe(true);
    expect(parameterCatalogue().has('tax.us.2027.retirement.elective_deferral')).toBe(false);
  });

  it('an unknown or malformed key is refused: planning.parameter_unknown', () => {
    for (const key of [
      'tax.us.2026.retirement.nothing',
      'assumptions.macro',
      'electiveDeferral',
      '',
    ]) {
      const error = thrown(() => parameterByKey(key));
      expect(error, key).toBeInstanceOf(UnknownParameterKey);
      expect(isParameterRefusal(error)).toBe(true);
    }
  });
});
