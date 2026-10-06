// SPDX-License-Identifier: MIT
/**
 * F-94-6 (docs/evidence/phase-9/wp9.4-upgrade.md §5, §9 item 5; fixed by
 * migration 0040). `pg_restore` runs every COPY under an empty `search_path`.
 * A CHECK constraint stores the function it calls by OID, so the constraint
 * itself survives that — but a SQL-language function's *body* is parsed when
 * the planner inlines it (or when it is called), under whatever `search_path`
 * is in force at that moment. 0022's `plan_scenario_levers_are_well_formed`
 * called `plan_amount_json_is_well_formed` unqualified, so from 0022 through
 * 0036 a backup holding one `plan_scenarios` row could not be restored:
 * `function plan_amount_json_is_well_formed(jsonb) does not exist`. WP 9.4's
 * chain found it at the HEAD hop's restore drill (check iv); the monthly
 * drill never had because the drill database held no plan.
 *
 * Two tests: the rule (every function in `public` names the `public`
 * functions it calls schema-qualified), and the reproduction (a baseline and
 * a fork insert under an empty `search_path`, the way a restore COPY runs).
 * Both were red against 0001–0036 before 0040 was written.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/migrate.ts';
import { installTypeParsers } from '../src/types.ts';

const ADMIN_URL = process.env['DATABASE_URL'];
const describeWithDb = ADMIN_URL === undefined ? describe.skip : describe;
const silent = { info: () => undefined, warn: () => undefined };

const USER_ID = '01920000-0000-7000-8000-00000000f946';
const BASELINE_ID = '01920000-0000-7000-8000-00000000f947';
const FORK_ID = '01920000-0000-7000-8000-00000000f948';

describeWithDb('functions survive an empty search_path, as pg_restore runs them (F-94-6)', () => {
  const databaseName = 'personalfi_restore_search_path_test';
  let url: string;
  let client: pg.Client;

  beforeAll(async () => {
    installTypeParsers();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    await admin.end();
    const u = new URL(ADMIN_URL as string);
    u.pathname = `/${databaseName}`;
    url = u.toString();
    await runMigrations({ databaseUrl: url, logger: silent });
    client = new pg.Client({ connectionString: url });
    await client.connect();
  }, 60_000);

  afterAll(async () => {
    await client?.end();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.end();
  }, 30_000);

  it('every public function names the public functions it calls schema-qualified', async () => {
    const { rows } = await client.query<{ name: string; def: string }>(
      `SELECT p.proname AS name, pg_get_functiondef(p.oid) AS def
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
        ORDER BY p.proname`,
    );
    expect(rows.length).toBeGreaterThan(10);
    const names = [...new Set(rows.map((row) => row.name))];
    const offences: string[] = [];
    for (const { name, def } of rows) {
      // The header names the function itself, schema-qualified by pg_get_functiondef.
      const body = def.replace(/^CREATE OR REPLACE FUNCTION [^\n]*\n/, '');
      for (const callee of names) {
        if (callee === name) continue;
        // A call is the bare name followed by `(`, not preceded by `public.`
        // (or any identifier character — `my_func_name(` is a different name).
        const unqualified = new RegExp(`(?<![\\w.])${callee}\\s*\\(`);
        if (unqualified.test(body)) offences.push(`${name} calls ${callee} unqualified`);
      }
    }
    expect(offences).toEqual([]);
  });

  it('a plan_scenarios baseline and fork insert under an empty search_path, as a restore COPY runs', async () => {
    await client.query('INSERT INTO users (id, display_name) VALUES ($1, $2)', [USER_ID, 'Chris']);
    await client.query('BEGIN');
    try {
      await client.query("SET LOCAL search_path = ''");
      // The DDL's CHECKs: a birthDate string and no JSON number anywhere.
      await client.query(
        `INSERT INTO public.plan_scenarios (id, user_id, kind, baseline_id, name, profile, levers, seed)
         VALUES ($1, $2, 'baseline', NULL, 'F-94-6 baseline', $3::jsonb, NULL, 1)`,
        [BASELINE_ID, USER_ID, JSON.stringify({ birthDate: '1986-03-15' })],
      );
      await client.query(
        `INSERT INTO public.plan_scenarios (id, user_id, kind, baseline_id, name, profile, levers, seed)
         VALUES ($1, $2, 'fork', $3, 'F-94-6 fork', NULL, $4::jsonb, NULL)`,
        [
          FORK_ID,
          USER_ID,
          BASELINE_ID,
          JSON.stringify({
            retire_age: '62',
            annual_spending: { minor: '5000000', currency: 'USD' },
          }),
        ],
      );
      const { rows } = await client.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM public.plan_scenarios WHERE user_id = $1',
        [USER_ID],
      );
      expect(rows[0]?.n).toBe(2);
    } finally {
      await client.query('ROLLBACK');
    }
  }, 30_000);
});
