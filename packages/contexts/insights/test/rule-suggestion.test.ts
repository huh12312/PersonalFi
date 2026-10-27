// SPDX-License-Identifier: MIT
/**
 * WP 11.1 — `categorization.rule_candidates` and `builtin.spending.rule_suggestion`.
 *
 * Two halves, each through the production path rather than a literal: the
 * block is built by the real `SnapshotBuilder` over an in-memory
 * `CategorizationPort`, and every insight is judged by the real
 * `validateResponse` pipeline and the real copy linter. The thresholds are
 * pinned at their boundaries — three confirmations fires, two does not — and
 * each skip has a case of its own with a partner that does fire, so a rule
 * that fired on nothing would fail as surely as one that fired on everything.
 *
 * **Sabotage record (WP 11.1).** `RULE_SUGGESTION_MIN_CONFIRMATIONS` lowered
 * to 2: `'refuses a merchant confirmed twice'` went red. The `covered_by_rule`
 * skip removed: `'refuses a merchant a rule already files'` went red. Both
 * restored byte-for-byte.
 */
import { DateOnly } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import { lintInsightCopy } from '../src/advisors/copy-lint.ts';
import { BUILTIN_CATALOGUE } from '../src/advisors/catalogue.ts';
import { applyCatalogueBudget, rankBuiltin } from '../src/advisors/ranking.ts';
import {
  RULE_SUGGESTION_ADVISOR_ID,
  RULE_SUGGESTION_MIN_CONFIRMATIONS,
  spendingRuleSuggestion,
} from '../src/advisors/builtin/rule-suggestion/index.ts';
import { contextOf, moneyOf } from '../src/advisors/support.ts';
import { resolveLimits } from '../src/contract/manifest.ts';
import type { Insight } from '../src/contract/response.ts';
import { scopeDefinition, scopesPermittedForKind } from '../src/contract/scopes.ts';
import { AdvisorSnapshotSchema, type AdvisorSnapshot } from '../src/contract/snapshot.ts';
import { mentionCandidatesOf } from '../src/mentions.ts';
import { afterDismissal, cooldownKey, isSuppressed } from '../src/policy/cooldown.ts';
import { SnapshotBuilder } from '../src/snapshot/builder.ts';
import {
  emptyPorts,
  inMemoryCategorizationPort,
  type InsightsRuleCandidate,
} from '../src/snapshot/ports.ts';
import { deriveTokenKey } from '../src/snapshot/tokens.ts';
import { resolveSourceRef } from '../src/validate/evidence.ts';
import { traceContext } from '../src/validate/numerals.ts';
import { validateResponse } from '../src/validate/pipeline.ts';
import { TODAY, USD, requestFor, seedSnapshot } from './advisors/seed.ts';

const USER_ID = '01930000-0000-7000-8000-0000000011a1';
const TOKEN_KEY = deriveTokenKey('wp-11-1', USER_ID);
const SCOPE = 'categorization.rule_candidates' as const;

const PET_STORE = '01930000-0000-7000-8000-00000000a001';
const BAKERY = '01930000-0000-7000-8000-00000000a002';
const PETS = '01930000-0000-7000-8000-00000000c001';
const BREAD = '01930000-0000-7000-8000-00000000c002';

function txn(merchant: number, index: number): string {
  return `01930000-0000-7000-8000-0000${String(merchant).padStart(4, '0')}${String(index).padStart(4, '0')}`;
}

function candidate(overrides: Partial<InsightsRuleCandidate> = {}): InsightsRuleCandidate {
  // A literal, not the constant: a sabotaged threshold must not move the fixture.
  const confirmations = overrides.confirmations ?? 3;
  return {
    merchantId: PET_STORE,
    categoryId: PETS,
    categorySlug: 'shopping.pets',
    confirmations,
    transactionIds: Array.from({ length: Math.min(confirmations, 12) }, (_, index) =>
      txn(1, confirmations - index),
    ),
    coveredByRule: false,
    lockedDefault: false,
    ...overrides,
  };
}

async function build(
  candidates: readonly InsightsRuleCandidate[] | undefined,
  kind: 'builtin' | 'local_model' | 'external' = 'builtin',
  grantedScopes: readonly (typeof SCOPE | 'cash.summary')[] = [SCOPE],
) {
  return new SnapshotBuilder({
    ...emptyPorts(),
    ...(candidates === undefined ? {} : { categorization: inMemoryCategorizationPort(candidates) }),
  }).build({
    userId: USER_ID,
    kind,
    grantedScopes,
    today: DateOnly.parse(TODAY),
    baseCurrency: USD,
    tokenKey: TOKEN_KEY,
  });
}

async function suggestionsFor(candidates: readonly InsightsRuleCandidate[]) {
  const built = await build(candidates);
  const request = requestFor(spendingRuleSuggestion.manifest, built.snapshot);
  return {
    snapshot: built.snapshot,
    request,
    insights: spendingRuleSuggestion.evaluate(contextOf(request)).insights,
  };
}

// ---------------------------------------------------------------------------
// The scope and its block
// ---------------------------------------------------------------------------

describe('categorization.rule_candidates', () => {
  it('an ungranted scope yields no key, and the same data granted does', async () => {
    // Both halves, or a builder that emitted nothing at all would pass.
    const ungranted = await build([candidate()], 'builtin', ['cash.summary']);
    expect(ungranted.snapshot).not.toHaveProperty('rule_candidates');
    expect(ungranted.emittedScopes).not.toContain(SCOPE);

    const granted = await build([candidate()]);
    expect(granted.snapshot.rule_candidates?.merchants).toHaveLength(1);
    expect(granted.emittedScopes).toEqual([SCOPE]);
  });

  it('is never emitted to an external advisor, whatever the grant says', async () => {
    expect(scopeDefinition(SCOPE).externalAllowed).toBe(false);
    expect(scopesPermittedForKind('external')).not.toContain(SCOPE);
    const external = await build([candidate()], 'external');
    expect(external.snapshot).not.toHaveProperty('rule_candidates');
    // Refused at the ceiling, so the request does not even list it as granted.
    expect(external.grantedScopes).not.toContain(SCOPE);
  });

  it('emits no key with no port behind it, or nothing confirmed', async () => {
    expect((await build(undefined)).snapshot).not.toHaveProperty('rule_candidates');
    expect((await build([])).snapshot).not.toHaveProperty('rule_candidates');
  });

  it('tokenises the merchant for every kind and carries uuids in-process', async () => {
    for (const kind of ['builtin', 'local_model'] as const) {
      const block = (await build([candidate()], kind)).snapshot.rule_candidates;
      const row = block?.merchants[0];
      expect(row?.merchant_ref, kind).toMatch(/^MERCHANT_[0-9a-f]{12}$/);
      expect(JSON.stringify(block), kind).not.toContain(PET_STORE);
      expect(row?.category_ref, kind).toBe(PETS);
      expect(row?.transactions[0]?.transaction_ref, kind).toBe(txn(1, 3));
    }
  });

  it('caps the transactions at eight, newest first, and validates against the schema', async () => {
    const built = await build([
      candidate({ confirmations: 12 }),
      candidate({ merchantId: BAKERY, categoryId: BREAD, categorySlug: 'food.bakery' }),
    ]);
    const parsed = AdvisorSnapshotSchema.safeParse(built.snapshot);
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
    const [first] = built.snapshot.rule_candidates?.merchants ?? [];
    expect(first?.confirmations).toBe(12);
    expect(first?.transactions).toHaveLength(8);
    expect(first?.transactions[0]?.transaction_ref).toBe(txn(1, 12));
    // The count is the count, not the length of the capped list.
    expect(first?.confirmations).not.toBe(first?.transactions.length);
  });

  it('carries no amount, date or name — only counts, flags and refs', async () => {
    const row = (await build([candidate()])).snapshot.rule_candidates?.merchants[0];
    expect(Object.keys(row ?? {}).sort()).toEqual(
      [
        'category_ref',
        'category_slug',
        'confirmations',
        'covered_by_rule',
        'locked_default',
        'merchant_ref',
        'transactions',
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// The advisor
// ---------------------------------------------------------------------------

describe('builtin.spending.rule_suggestion', () => {
  it('suggests a rule at exactly three confirmations', async () => {
    expect(RULE_SUGGESTION_MIN_CONFIRMATIONS).toBe(3);
    const { insights, snapshot } = await suggestionsFor([candidate({ confirmations: 3 })]);
    expect(insights).toHaveLength(1);
    const [insight] = insights;
    const merchant = snapshot.rule_candidates?.merchants[0]?.merchant_ref ?? '';
    expect(insight?.key).toBe(`spending.rule_suggestion.${merchant}`);
    expect(insight?.period).toBe('all_time');
    expect(insight?.type).toBe('spending.rule_suggestion');
    expect(insight?.severity).toBe('info');
    expect(insight?.confidence).toBe(1);
    expect(insight?.confidence_basis).toBe('deterministic');
    expect(insight?.impact.annualized).toBeNull();
    expect(insight?.impact.one_time).toBeNull();
    expect(insight?.title).toBe('A merchant you keep filing the same way');
    expect(insight?.summary_md).toBe(
      'You have filed this merchant under shopping.pets 3 times by hand. A rule would file it ' +
        'there automatically from now on — nothing changes until you save one.',
    );
    expect(insight?.proposed_actions.map((action) => action.kind)).toEqual(['create_rule_draft']);
    expect(insight?.proposed_actions[0]?.label).toBe('Create rule');
  });

  it('refuses a merchant confirmed twice', async () => {
    // The reader reports pairs from two up on purpose; this is the threshold
    // under test, seen refusing a pair that really is in the snapshot.
    const { insights, snapshot } = await suggestionsFor([candidate({ confirmations: 2 })]);
    expect(snapshot.rule_candidates?.merchants[0]?.confirmations).toBe(2);
    expect(insights).toEqual([]);
  });

  it('refuses a merchant a rule already files', async () => {
    const covered = await suggestionsFor([candidate({ confirmations: 5, coveredByRule: true })]);
    expect(covered.snapshot.rule_candidates?.merchants[0]?.covered_by_rule).toBe(true);
    expect(covered.insights).toEqual([]);
    // The partner: the same merchant, no rule, fires.
    expect((await suggestionsFor([candidate({ confirmations: 5 })])).insights).toHaveLength(1);
  });

  it('refuses a merchant whose category is locked', async () => {
    const locked = await suggestionsFor([candidate({ confirmations: 5, lockedDefault: true })]);
    expect(locked.snapshot.rule_candidates?.merchants[0]?.locked_default).toBe(true);
    expect(locked.insights).toEqual([]);
  });

  it('refuses a merchant the holder files two ways', async () => {
    const twoWays = await suggestionsFor([
      candidate({ confirmations: 4 }),
      candidate({ confirmations: 3, categoryId: BREAD, categorySlug: 'food.bakery' }),
    ]);
    expect(twoWays.snapshot.rule_candidates?.merchants).toHaveLength(2);
    expect(twoWays.insights).toEqual([]);
  });

  it('emits one insight per merchant, keyed by the merchant alone', async () => {
    const { insights, snapshot } = await suggestionsFor([
      candidate({ confirmations: 6 }),
      candidate({
        merchantId: BAKERY,
        categoryId: BREAD,
        categorySlug: 'food.bakery',
        confirmations: 3,
        transactionIds: [txn(2, 3), txn(2, 2), txn(2, 1)],
      }),
    ]);
    const merchants = snapshot.rule_candidates?.merchants ?? [];
    expect(insights.map((insight) => insight.key)).toEqual(
      merchants.map((row) => `spending.rule_suggestion.${row.merchant_ref}`),
    );
    expect(new Set(insights.map((insight) => insight.key)).size).toBe(2);
  });

  it('cites the count, the category and every confirmation, and they all resolve', async () => {
    const { insights, snapshot } = await suggestionsFor([candidate({ confirmations: 4 })]);
    const [insight] = insights;
    expect(insight).toBeDefined();
    if (insight === undefined) return;

    expect(insight.evidence.map((row) => row.source_ref)).toEqual([
      'snapshot:rule_candidates.merchants[0].confirmations',
      'snapshot:rule_candidates.merchants[0].category_ref',
      'snapshot:rule_candidates.merchants[0].transactions[0].transaction_ref',
      'snapshot:rule_candidates.merchants[0].transactions[1].transaction_ref',
      'snapshot:rule_candidates.merchants[0].transactions[2].transaction_ref',
      'snapshot:rule_candidates.merchants[0].transactions[3].transaction_ref',
    ]);
    expect(insight.evidence.map((row) => row.value)).toEqual([
      '4',
      PETS,
      txn(1, 4),
      txn(1, 3),
      txn(1, 2),
      txn(1, 1),
    ]);
    for (const row of insight.evidence) {
      const resolution = resolveSourceRef(snapshot, row.source_ref ?? '');
      expect(resolution.ok, row.source_ref ?? '').toBe(true);
    }

    // What the web prefills the rule editor from: the category the
    // `category_ref` row names and the transaction the first
    // `transaction_ref` row names, each resolved to an entity by its leaf.
    const mentions = mentionCandidatesOf(
      insight.evidence.map((row, position) => ({
        position,
        label: row.label,
        value: row.value,
        sourceRef: row.source_ref,
        resolvedDisplay: null,
      })),
    );
    expect(mentions.find((mention) => mention.entityType === 'category')?.entityId).toBe(PETS);
    expect(mentions.find((mention) => mention.entityType === 'transaction')?.entityId).toBe(
      txn(1, 4),
    );
  });

  it('passes the real validation pipeline and the copy linter unchanged', async () => {
    const { request, snapshot } = await suggestionsFor([
      candidate({ confirmations: 7 }),
      candidate({ merchantId: BAKERY, categoryId: BREAD, categorySlug: 'food.bakery' }),
    ]);
    const entry = BUILTIN_CATALOGUE.find((item) => item.advisorId === RULE_SUGGESTION_ADVISOR_ID);
    expect(entry?.defaultEnabled).toBe(true);
    if (entry === undefined) return;

    const body = await entry.advisor.run(request, new AbortController().signal);
    const outcome = validateResponse({
      request,
      manifest: entry.rule.manifest,
      limits: resolveLimits(entry.rule.manifest),
      body,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.rejected).toEqual([]);
    expect(outcome.accepted).toHaveLength(2);
    for (const row of outcome.accepted) {
      expect(row.status).toBe('pending_review');
      expect(row.severityClamped).toBe(false);
      expect(lintInsightCopy(row.insight, traceContext({ snapshot, derived: [] }))).toEqual([]);
    }
  });

  it('ranks after every insight that claims a figure', async () => {
    const snapshot: AdvisorSnapshot = await seedSnapshot('drift');
    const rows: { readonly advisorId: string; readonly insight: Insight }[] =
      BUILTIN_CATALOGUE.flatMap((entry) =>
        entry.rule
          .evaluate(contextOf(requestFor(entry.rule.manifest, snapshot)))
          .insights.map((insight) => ({ advisorId: entry.advisorId, insight })),
      );
    const project = (row: (typeof rows)[number]) => ({
      key: row.insight.key,
      severity: row.insight.severity,
      confidence: row.insight.confidence,
      annualizedImpact: moneyOf(row.insight.impact.annualized),
      oneTimeImpact: moneyOf(row.insight.impact.one_time),
      horizon: row.insight.horizon,
      actionKinds: row.insight.proposed_actions.map((action) => action.kind),
    });

    const suggestion = rows.find((row) => row.advisorId === RULE_SUGGESTION_ADVISOR_ID);
    expect(suggestion).toBeDefined();
    if (suggestion === undefined) return;
    const withImpact = rows.filter(
      (row) => row.insight.impact.annualized !== null || row.insight.impact.one_time !== null,
    );
    expect(withImpact.length).toBeGreaterThan(5);
    for (const row of withImpact) {
      expect(rankBuiltin(project(row)), row.insight.key).toBeGreaterThan(
        rankBuiltin(project(suggestion)),
      );
    }

    // And in the budgeted feed itself: not floored (it claims no figure, so
    // the $50 floor's no-impact exception keeps it), and last of the lot.
    const feed = applyCatalogueBudget(rows, project, USD);
    const ordered = [...feed.list, ...feed.overflow];
    expect(feed.belowFloor).not.toContain(suggestion);
    expect(ordered.at(-1)?.advisorId).toBe(RULE_SUGGESTION_ADVISOR_ID);
  });

  it('a dismissal silences that merchant only, and the key is stable across runs', async () => {
    const candidates = [
      candidate({ confirmations: 4 }),
      candidate({
        merchantId: BAKERY,
        categoryId: BREAD,
        categorySlug: 'food.bakery',
        transactionIds: [txn(2, 3), txn(2, 2), txn(2, 1)],
      }),
    ];
    const first = await suggestionsFor(candidates);
    const second = await suggestionsFor(candidates);
    // Same merchant, same token, same key: a re-run is an upsert, and the
    // ladder keyed on (advisor_id, key) follows the merchant.
    expect(second.insights.map((insight) => insight.key)).toEqual(
      first.insights.map((insight) => insight.key),
    );

    const [pets, bakery] = first.insights;
    expect(pets).toBeDefined();
    expect(bakery).toBeDefined();
    if (pets === undefined || bakery === undefined) return;
    const now = new Date(`${TODAY}T12:00:00.000Z`);
    const ladder = new Map([
      [cooldownKey(RULE_SUGGESTION_ADVISOR_ID, pets.key), afterDismissal(null, now)],
    ]);
    const suppressed = (insight: Insight) =>
      isSuppressed(ladder.get(cooldownKey(RULE_SUGGESTION_ADVISOR_ID, insight.key)) ?? null, now);
    expect(second.insights.filter(suppressed).map((insight) => insight.key)).toEqual([pets.key]);
    expect(second.insights.filter((insight) => !suppressed(insight))).toEqual([bakery]);
  });
});
