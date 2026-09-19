// SPDX-License-Identifier: MIT
/**
 * The `@ctx/insights` database-test harness.
 *
 * `@core/testkit` is a dev-only dependency of this context, allowed by the
 * `insights` entry in `scripts/eslint-boundaries.js` rather than by an
 * `eslint-disable` here, so the looseness lives in the policy instead of at the
 * top of a file. No file under `src/` imports it.
 *
 * ## Why the ports are fakes even in a database suite
 *
 * The boundary lint denies `@ctx/insights` → `@ctx/ledger` (and budgeting, and
 * recurring) **unconditionally**, tests included, and that is the right call —
 * a test-only exception is how a context boundary becomes advisory. So these
 * suites run `SnapshotBuilder` over the in-memory ports from `src/`, which live
 * in `src/` and not here precisely so that a reviewer re-running these proofs
 * cannot accidentally re-implement a friendlier fake.
 *
 * What that costs: these suites do not prove the real read models still satisfy
 * the ports. That check belongs at the composition root, where the adapters are
 * written; the exact lines `apps/api/src/domain.ts` needs are in
 * docs/evidence/phase-2/wp2.6-insights.md §6, and the orchestrator compiling
 * them is the check.
 *
 * What it buys: every claim these suites make — a row lands `pending_review`, a
 * re-run updates rather than inserts, a third dismissal is permanent, a
 * quarantined advisor writes nothing — is a claim about *this* context's
 * writes, with nothing else in the loop that can fail and muddy the result.
 */
import { Money, fixedClock, type Clock } from '@core/kernel';
import { ADMIN_URL, createTestDatabase, type TestDatabase } from '@core/testkit';
import type { AdvisorManifest } from '../../src/contract/manifest.ts';
import type { AdvisorRequest } from '../../src/contract/request.ts';
import type { Insight } from '../../src/contract/response.ts';
import type { InsightsContext } from '../../src/db.ts';
import { createAdvisorRegistry, type Advisor } from '../../src/registry.ts';
import type { InsightsDependencies, InsightsSettings } from '../../src/service.ts';
import type { SnapshotPorts } from '../../src/snapshot/ports.ts';
import {
  inMemoryBudgetPort,
  inMemoryLedgerPort,
  inMemoryRecurringPort,
} from '../../src/snapshot/ports.ts';
import { baseInsight, baseManifest, responseFor, stubAdvisor } from '../fixtures.ts';

export { ADMIN_URL, baseInsight, baseManifest, stubAdvisor, type TestDatabase };

/** `describe.skipIf(NO_DATABASE)` — the guard every `*-db` suite uses. */
export const NO_DATABASE = ADMIN_URL === undefined;

/** Fixed, so a failure message reads the same twice. */
export const EPOCH = '2026-09-19T09:00:00.000Z';
export const CORRELATION_ID = '01930000-0000-7000-8000-0000000000c1';
export const ZONE = 'America/New_York';
export const USD = 'USD';
/** Stable, so the snapshot is byte-identical between two runs of a suite. */
export const ACCOUNT_ID = '01930000-0000-7000-8000-0000000000a1';
/** The one scope every scenario grants. `selfCiting` cites into it. */
export const GRANTED_SCOPES = ['cash.summary'] as const;

/** The scratch database a suite gets. One per file, per the dispatch's name. */
export async function insightsDatabase(suite: string): Promise<TestDatabase> {
  return createTestDatabase(`personalfi_wp_ins_${suite}`);
}

export function clockAt(instant: string = EPOCH): Clock {
  return fixedClock(instant);
}

export function contextFor(userId: string, clock: Clock = clockAt()): InsightsContext {
  return { userId, clock, correlationId: CORRELATION_ID, causationId: null };
}

/**
 * The minimum ports that make one snapshot block exist.
 *
 * One cash account with a zero balance, no budget, no streams. Deliberately
 * minimal: a database suite that also had to produce a realistic household
 * would be testing the fixture generator as much as the writes. The zero
 * balance is not laziness either — it keeps the snapshot free of incidental
 * figures, so a suite asserting something about *persistence* never has to
 * reason about which of its own fixture numbers a numeral check happened to
 * match.
 */
export function portsFor(): SnapshotPorts {
  return {
    ledger: inMemoryLedgerPort({
      accounts: [
        {
          id: ACCOUNT_ID,
          type: 'checking',
          isCash: true,
          balance: Money.of(0n, USD),
          apy: null,
          closed: false,
        },
      ],
    }),
    budget: inMemoryBudgetPort(null),
    recurring: inMemoryRecurringPort([]),
  };
}

export interface ScenarioOptions {
  readonly manifest?: Partial<AdvisorManifest>;
  readonly settings?: Partial<InsightsSettings>;
  /** What the advisor returns. Defaults to one well-formed insight. */
  readonly respond?: (request: AdvisorRequest) => unknown;
}

export interface Scenario {
  readonly advisor: Advisor;
  readonly manifest: AdvisorManifest;
  readonly dependencies: InsightsDependencies;
}

/**
 * An advisor that echoes the request back as one valid insight.
 *
 * It builds its response *from the request it was handed*, which is what makes
 * it a legitimate advisor rather than a canned payload: `request_id` is echoed
 * because it echoes it, so a suite that breaks the echo is breaking something
 * real.
 *
 * Its default insight is `selfCiting` below, which cites `cash_summary.as_of` —
 * a block `portsFor` always produces, so long as the run's grants include
 * `cash.summary`. A suite that forgets to grant it gets a *rejected* insight
 * rather than a passing one, which is the right direction for that mistake.
 */
export function scenario(options: ScenarioOptions = {}): Scenario {
  const manifest = baseManifest(options.manifest ?? {});
  const respond =
    options.respond ?? ((request: AdvisorRequest) => responseFor(request, [selfCiting(request)]));
  const advisor = stubAdvisor(manifest, respond);
  const registry = createAdvisorRegistry([advisor]);
  return {
    advisor,
    manifest,
    dependencies: {
      registry,
      ports: portsFor(),
      settings: {
        advisorsEnabled: true,
        moduleEnabled: true,
        timeZone: ZONE,
        baseCurrency: USD,
        tokenSecret: 'test-secret',
        ...(options.settings ?? {}),
      },
    },
  };
}

/**
 * An insight whose only citation is a field the request always has.
 *
 * It carries no figures at all: no impact, no derivation, no numeral in any
 * rendered field. That keeps the persistence suites about *persistence* — the
 * anti-fabrication machinery is proved by the pure suites, over a snapshot rich
 * enough to be worth lying about.
 */
export function selfCiting(request: AdvisorRequest, overrides: Partial<Insight> = {}): Insight {
  return baseInsight({
    key: 'subscription.annual_cost.example',
    period: '2026-09',
    summary_md: 'This subscription is worth a look.',
    title: 'A subscription worth reviewing',
    impact: {
      annualized: null,
      one_time: null,
      basis: 'No figure is claimed, so none has to be traced.',
      derivation_id: null,
    },
    evidence: [
      {
        kind: 'metric',
        label: 'As of',
        value: request.today,
        source_ref: 'snapshot:cash_summary.as_of',
        url: null,
      },
    ],
    derivations: [],
    proposed_actions: [],
    ...overrides,
  });
}
