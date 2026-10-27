// SPDX-License-Identifier: MIT
/**
 * WP 11.2b — the ledger's projection of the automatic tiers (`transactions.auto_*`) is DERIVED: the export omits it,
 * and the import re-derives it from the `category_assignments` the bundle already carries - with the categorisation
 * pass's own mapping (`autoChangeOf`), so the two cannot disagree.
 */
import { newId } from '@core/kernel';
import { createTestDatabase, type TestDatabase } from '@core/testkit';
import { categoryIdsByKey, createRule } from '@ctx/categorization';
import { setAutoCategories } from '@ctx/ledger';
import { systemClock } from '@core/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildExportBundle,
  parseAndVerifyBundle,
  serialiseBundle,
} from '../../src/reports/export/bundle.ts';
import { importBundle } from '../../src/reports/export/import.ts';
import { DERIVED_COLUMNS } from '../../src/reports/export/registry.ts';
import {
  createApiHarness,
  expectStatus,
  linkManual,
  NO_DATABASE,
  type ApiHarness,
} from '../helpers/api-harness.ts';

interface AutoRow {
  readonly name: string;
  readonly category_id: string | null;
  readonly tier: string | null;
  readonly confidence: string | null;
  readonly assignment: string | null;
  readonly superseded: boolean;
}

const AUTO_SQL = `
  SELECT p.name, t.auto_category_id AS category_id, t.auto_tier AS tier, t.auto_confidence::text AS confidence,
         t.auto_assignment_id AS assignment, t.auto_superseded_at IS NOT NULL AS superseded
    FROM transactions t JOIN transactions_provider p ON p.id = t.current_fact_id
   ORDER BY p.name`;

describe.skipIf(NO_DATABASE)(
  'WP 11.2b — the export omits the projection and the import re-derives it',
  () => {
    let h: ApiHarness;
    let clean: TestDatabase;

    beforeAll(async () => {
      h = await createApiHarness({ suite: 'wp112b_export' });
      const ids = await categoryIdsByKey(h.database.db, h.userId);
      const link = await linkManual(h, {
        providerConnectionId: 'wp112b-export',
        displayName: 'Export Checking',
        accounts: [
          { providerAccountId: 'checking', name: 'Checking', type: 'depository', currency: 'USD' },
        ],
      });
      const accountId = link.accountIds[0] as string;
      const posted = await h.request({
        method: 'POST',
        url: `/accounts/${accountId}/transactions`,
        session: h.fresh,
        body: {
          transactions: ['Auto Classifier', 'Auto Provider', 'By Rule', 'Picked After'].map(
            (name) => ({
              amount: { minor: '-1500', currency: 'USD' },
              postedDate: '2025-05-02',
              name,
            }),
          ),
        },
      });
      expectStatus(posted, 201);
      const [classifier, provider, rule, picked] = (
        posted.json() as { addedTransactionIds: string[] }
      ).addedTransactionIds as [string, string, string, string];

      const assign = async (
        transactionId: string,
        key: string,
        source: string,
        confidence: string,
        ruleId: string | null = null,
      ): Promise<string> => {
        const id = newId();
        await h.database.pool.query(
          `INSERT INTO category_assignments (id, user_id, transaction_id, category_id, source, confidence, rule_id, evidence, decided_at, version, is_current)
         VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, '{"chain":[]}'::jsonb, '2025-05-02T10:00:00Z', 1, TRUE)`,
          [id, h.userId, transactionId, ids.get(key), source, confidence, ruleId],
        );
        return id;
      };
      const stored = await createRule(h.database.db, {
        userId: h.userId,
        name: 'Pets',
        conditions: { all: [{ type: 'payee', match: 'contains', value: 'BY RULE' }], any: [] },
        actions: [{ type: 'set_category', categoryKey: 'family.pets' }],
      });
      // The assignments are what the categorisation pass stored; the projection is what it wrote beside them.
      const a1 = await assign(classifier, 'dining.coffee', 'classifier', '0.9234');
      const a2 = await assign(provider, 'groceries.supermarkets', 'provider', '0.8500');
      await assign(rule, 'family.pets', 'rule', '1.0000', stored.id);
      const a4 = await assign(picked, 'dining.coffee', 'merchant_default', '0.7500');
      await h.database.db.transaction(async (tx) =>
        setAutoCategories(
          tx,
          {
            userId: h.userId,
            changes: [
              {
                transactionId: classifier,
                placement: {
                  assignmentId: a1,
                  categoryId: ids.get('dining.coffee') as string,
                  tier: 'classifier',
                  confidence: 0.9234,
                  decidedAt: new Date('2025-05-02T10:00:00Z'),
                },
              },
              {
                transactionId: provider,
                placement: {
                  assignmentId: a2,
                  categoryId: ids.get('groceries.supermarkets') as string,
                  tier: 'provider',
                  confidence: 0.85,
                  decidedAt: new Date('2025-05-02T10:00:00Z'),
                },
              },
              {
                transactionId: picked,
                placement: {
                  assignmentId: a4,
                  categoryId: ids.get('dining.coffee') as string,
                  tier: 'merchant_default',
                  confidence: 0.75,
                  decidedAt: new Date('2025-05-02T10:00:00Z'),
                },
              },
            ],
          },
          { clock: systemClock },
        ),
      );
      // The holder picks on one of them afterwards (the placement is superseded, kept as history).
      expectStatus(
        await h.request({
          method: 'PATCH',
          url: `/transactions/${picked}`,
          session: h.stale,
          body: { categoryId: ids.get('dining.coffee') },
        }),
        200,
      );
    }, 120_000);

    afterAll(async () => {
      await h.close();
      if (clean !== undefined) await clean.drop();
    }, 60_000);

    it('the bundle carries the assignments and none of the derived columns', async () => {
      const bundle = await buildExportBundle(h.database.pool, {
        userId: h.userId,
        appVersion: 'test',
        now: new Date('2025-06-01T00:00:00Z'),
      });
      const text = serialiseBundle(bundle);
      for (const column of DERIVED_COLUMNS.get('transactions') ?? []) {
        expect(text).not.toContain(`"${column}"`);
      }
      expect(bundle.manifest.streams.find((s) => s.table === 'category_assignments')?.count).toBe(
        4,
      );
    });

    it('the import re-derives the same projection from the loaded assignments', async () => {
      const bundle = await buildExportBundle(h.database.pool, {
        userId: h.userId,
        appVersion: 'test',
        now: new Date('2025-06-01T00:00:00Z'),
      });
      const parsed = parseAndVerifyBundle(serialiseBundle(bundle));
      clean = await createTestDatabase(
        `personalfi_wp112b_export_clean_${newId().replaceAll('-', '')}`,
      );
      const result = await importBundle(clean.pool, parsed, clean.userId);
      expect(result.autoCategoriesReprojected).toBe(3);

      const source = (await h.database.pool.query<AutoRow>(AUTO_SQL)).rows;
      const imported = (await clean.pool.query<AutoRow>(AUTO_SQL)).rows;
      // Same placements: category, tier, the stored confidence, the assignment each mirrors.
      expect(imported).toEqual(source);
      const byName = new Map(imported.map((row) => [row.name, row] as const));
      expect(byName.get('Auto Classifier')).toMatchObject({
        tier: 'classifier',
        confidence: '0.9234',
        superseded: false,
      });
      expect(byName.get('Auto Provider')).toMatchObject({ tier: 'provider', confidence: '0.8500' });
      // A rule's row carries no placement; a picked row keeps it, superseded.
      expect(byName.get('By Rule')).toMatchObject({ category_id: null, tier: null });
      expect(byName.get('Picked After')).toMatchObject({
        tier: 'merchant_default',
        superseded: true,
      });
    });
  },
);
