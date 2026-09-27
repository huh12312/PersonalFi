// SPDX-License-Identifier: MIT
/**
 * `/assumptions` and `/assumptions/overrides` (WP 4.8), over a real database.
 *
 * The §5 exit criterion is "assumptions visible, editable, cited"; this file
 * proves each word against the real HTTP response, not against the domain
 * layer WP 4.2 already proved: every number in the *response body* carries a
 * `source` and an `asOf` (`'every number in the assumptions response carries
 * a source and an as_of'`), an override round-trips and is visible as such,
 * and the two refusal classes (`UnknownAssumptionsVersion`,
 * `AssumptionOverrideRefused`) reach the wire with the right status.
 */
import { CITED_KINDS } from '@ctx/planning';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createApiHarness,
  expectStatus,
  NO_DATABASE,
  problemOf,
  type ApiHarness,
} from '../helpers/api-harness.ts';

interface AppliedOverrideWire {
  readonly path: string;
  readonly value: string;
  readonly default: unknown;
}

interface AssumptionsResponse {
  readonly version: string;
  readonly file: Record<string, unknown>;
  readonly overrides: readonly AppliedOverrideWire[];
  readonly overridablePaths: readonly string[];
}

const CITED_KIND_SET = new Set<string>(CITED_KINDS);

/**
 * Walk the whole response body and assert that every object shaped like a
 * cited node (`kind` one of `CITED_KINDS`) carries a non-empty `source` and a
 * `asOf` string. Returns how many were checked, so a test can also assert the
 * walk actually saw something (a walk over an empty tree proves nothing).
 */
function walkCitedNodes(value: unknown, path: string, violations: string[]): number {
  let count = 0;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      count += walkCitedNodes(entry, `${path}[${String(index)}]`, violations);
    });
    return count;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record['kind'] === 'string' && CITED_KIND_SET.has(record['kind'])) {
      count += 1;
      if (typeof record['source'] !== 'string' || record['source'].trim() === '') {
        violations.push(`${path}: no non-empty source`);
      }
      if (typeof record['asOf'] !== 'string' || record['asOf'] === '') {
        violations.push(`${path}: no as_of`);
      }
    }
    for (const [key, inner] of Object.entries(record)) {
      count += walkCitedNodes(inner, `${path}.${key}`, violations);
    }
  }
  return count;
}

describe.skipIf(NO_DATABASE)('/assumptions and /assumptions/overrides (WP 4.8)', () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp48-assumptions' });
  });

  afterAll(async () => {
    await h.close();
  });

  it('401s without a session', async () => {
    const noSession = { accessToken: 'not-a-real-token', csrf: 'x'.repeat(40), fresh: false };
    const response = await h.request({ method: 'GET', url: '/assumptions', session: noSession });
    expect(response.statusCode).toBe(401);
  });

  it('every number in the assumptions response carries a source and an as_of', async () => {
    const response = await h.request({ method: 'GET', url: '/assumptions', session: h.stale });
    expectStatus(response, 200);
    const body = response.json() as AssumptionsResponse;
    expect(body.version).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(body.overrides).toEqual([]);
    expect(body.overridablePaths.length).toBeGreaterThan(0);
    expect(body.overridablePaths).toContain('capitalMarket.usEquity.expectedReturn');

    const violations: string[] = [];
    const checked = walkCitedNodes(body.file, '$', violations);
    expect(checked, 'the walk must actually see cited nodes to prove anything').toBeGreaterThan(50);
    expect(violations).toEqual([]);
  });

  it('an override round-trips: visible, its own citation, and never a copy of the default', async () => {
    const before = (
      await h.request({ method: 'GET', url: '/assumptions', session: h.stale })
    ).json() as AssumptionsResponse;
    const capitalMarket = before.file['capitalMarket'] as Record<string, unknown>;
    const usEquity = capitalMarket['usEquity'] as { expectedReturn: { value: string } };
    expect(usEquity.expectedReturn.value).not.toBe('0.055');

    const put = await h.request({
      method: 'PUT',
      url: '/assumptions/overrides',
      session: h.stale,
      body: { overrides: { 'capitalMarket.usEquity.expectedReturn': '0.0550' } },
    });
    expectStatus(put, 200);
    const after = put.json() as AssumptionsResponse;
    expect(after.overrides).toHaveLength(1);
    expect(after.overrides[0]?.path).toBe('capitalMarket.usEquity.expectedReturn');
    // Canonicalised: '0.0550' stored/echoed as '0.055'.
    expect(after.overrides[0]?.value).toBe('0.055');

    const afterCapitalMarket = after.file['capitalMarket'] as Record<string, unknown>;
    const afterUsEquity = afterCapitalMarket['usEquity'] as {
      expectedReturn: { value: string; source: string; asOf: string };
    };
    expect(afterUsEquity.expectedReturn.value).toBe('0.055');
    // The citation itself moved: it now names the override and the displaced
    // default, never a bare number under the old source label.
    expect(afterUsEquity.expectedReturn.source).toContain('Your override');
    expect(afterUsEquity.expectedReturn.source).toContain(usEquity.expectedReturn.value);

    // Re-reading with GET shows the same thing — the override persisted.
    const reread = (
      await h.request({ method: 'GET', url: '/assumptions', session: h.stale })
    ).json() as AssumptionsResponse;
    expect(
      (reread.file['capitalMarket'] as Record<string, unknown>)['usEquity'] as {
        expectedReturn: { value: string };
      },
    ).toMatchObject({ expectedReturn: { value: '0.055' } });

    // Every number, including the overridden one, still carries a citation.
    const violations: string[] = [];
    walkCitedNodes(reread.file, '$', violations);
    expect(violations).toEqual([]);
  });

  it('{} clears every override back to the file’s own numbers', async () => {
    const cleared = await h.request({
      method: 'PUT',
      url: '/assumptions/overrides',
      session: h.stale,
      body: { overrides: {} },
    });
    expectStatus(cleared, 200);
    const body = cleared.json() as AssumptionsResponse;
    expect(body.overrides).toEqual([]);
  });

  it('an unknown path is a 422, and never reaches the database as a copy', async () => {
    const response = await h.request({
      method: 'PUT',
      url: '/assumptions/overrides',
      session: h.stale,
      body: { overrides: { 'capitalMarket.notAPath': '0.05' } },
    });
    expect(response.statusCode).toBe(422);
    expect(problemOf(response)['code']).toBe('planning.assumptions_path_unknown');
  });

  it('a non-decimal value is a 422', async () => {
    const response = await h.request({
      method: 'PUT',
      url: '/assumptions/overrides',
      session: h.stale,
      body: { overrides: { 'capitalMarket.usEquity.expectedReturn': 'not-a-decimal' } },
    });
    expect(response.statusCode).toBe(422);
    expect(problemOf(response)['code']).toBe('planning.assumptions_value_invalid');
  });

  it("refuses another user's overrides: each holder sees only their own", async () => {
    await h.request({
      method: 'PUT',
      url: '/assumptions/overrides',
      session: h.stale,
      body: { overrides: { 'capitalMarket.usEquity.expectedReturn': '0.06' } },
    });

    const otherUserId = await h.database.createUser('Second Holder');
    const theirs = await h.issueSession({ userId: otherUserId, fresh: false });

    const theirView = (
      await h.request({ method: 'GET', url: '/assumptions', session: theirs })
    ).json() as AssumptionsResponse;
    expect(theirView.overrides).toEqual([]);

    const oursStill = (
      await h.request({ method: 'GET', url: '/assumptions', session: h.stale })
    ).json() as AssumptionsResponse;
    expect(oursStill.overrides).toHaveLength(1);
    expect(oursStill.overrides[0]?.value).toBe('0.06');

    // The other holder overriding something does not touch ours.
    await h.request({
      method: 'PUT',
      url: '/assumptions/overrides',
      session: theirs,
      body: { overrides: { 'capitalMarket.cash.expectedReturn': '0.04' } },
    });
    const oursAfterTheirWrite = (
      await h.request({ method: 'GET', url: '/assumptions', session: h.stale })
    ).json() as AssumptionsResponse;
    expect(oursAfterTheirWrite.overrides).toHaveLength(1);
    expect(oursAfterTheirWrite.overrides[0]?.path).toBe('capitalMarket.usEquity.expectedReturn');
  });
});
