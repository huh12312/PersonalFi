// SPDX-License-Identifier: MIT
/**
 * WP 11.8 — the soak report's Brief row says why there are no Briefs when the
 * reason is the install, not the holder.
 *
 * The W43 and W44 reports read criterion 9 "not started" for three weeks while
 * production's worker had never registered `module.insights` (an empty
 * `advisor_token_secret` placeholder). The row now reads "insights module not
 * registered on the worker" in that case, from the mounted secrets by the
 * config loader's own presence rule — never from the database.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BRIEF_BLOCKED_UNREGISTERED,
  CRITERIA,
  evaluateCriteria,
  insightsRegisteredIn,
  renderSoakReport,
  SOAK_QUERIES,
  type SoakQueryResult,
} from './report.ts';

const AS_OF = new Date('2026-11-09T12:00:00.000Z');

/** The real query manifest, every result empty except the Brief count. */
function results(briefCount: number): SoakQueryResult[] {
  return SOAK_QUERIES.map((query) => ({
    query,
    columns: query.name === 'brief_first_four' ? ['brief_count'] : [],
    rows: query.name === 'brief_first_four' ? [{ brief_count: BigInt(briefCount) }] : [],
  }));
}

const BRIEF_ROW = new RegExp(
  `^\\| 9 \\| ${CRITERIA.find((c) => c.id === 9)?.name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') ?? ''} \\| (.*) \\|$`,
  'mu',
);

function briefRow(markdown: string): string | undefined {
  return BRIEF_ROW.exec(markdown)?.[1];
}

describe('the Brief criterion when the worker has no insights module (WP 11.8)', () => {
  it('no Briefs and the module not registered: the row names the reason, not "not started"', () => {
    const states = evaluateCriteria({
      results: results(0),
      clockRows: [],
      asOfDate: AS_OF,
      insightsRegistered: false,
    });
    expect(states[9]).toEqual({ kind: 'blocked', why: BRIEF_BLOCKED_UNREGISTERED });

    const markdown = renderSoakReport({
      results: results(0),
      clockRows: [],
      asOfDate: AS_OF,
      assumptionsAsOfDates: null,
      insightsRegistered: false,
    });
    expect(briefRow(markdown)).toBe(
      'insights module not registered on the worker (advisor_token_secret absent)',
    );
  });

  it('no Briefs with the module registered, or the registration unknown: "not started", as before', () => {
    for (const insightsRegistered of [true, undefined]) {
      const markdown = renderSoakReport({
        results: results(0),
        clockRows: [],
        asOfDate: AS_OF,
        assumptionsAsOfDates: null,
        ...(insightsRegistered === undefined ? {} : { insightsRegistered }),
      });
      expect(briefRow(markdown)).toBe('not started');
    }
  });

  it('Briefs exist: the registration does not change the row', () => {
    const states = evaluateCriteria({
      results: results(2),
      clockRows: [],
      asOfDate: AS_OF,
      insightsRegistered: false,
    });
    expect(states[9]?.kind).toBe('observing_since');
  });
});

describe('insightsRegisteredIn: the mounted secrets, by the config loader’s rule', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const secretsDir = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), 'wp118-soak-'));
    dirs.push(dir);
    for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, name), value);
    return dir;
  };

  it('a non-empty file is registered; an empty placeholder or no file is not', async () => {
    expect(await insightsRegisteredIn(secretsDir({ advisor_token_secret: 'x'.repeat(64) }))).toBe(
      true,
    );
    expect(await insightsRegisteredIn(secretsDir({ advisor_token_secret: '' }))).toBe(false);
    expect(await insightsRegisteredIn(secretsDir({ advisor_token_secret: '\n  \n' }))).toBe(false);
    expect(await insightsRegisteredIn(secretsDir({ database_url: 'postgres://x' }))).toBe(false);
  });

  it('no secrets directory at all (a checkout run): unknown, never a claim', async () => {
    expect(await insightsRegisteredIn(join(tmpdir(), 'wp118-soak-no-such-dir'))).toBeUndefined();
  });
});
