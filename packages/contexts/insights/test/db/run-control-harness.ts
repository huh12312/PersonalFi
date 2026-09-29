// SPDX-License-Identifier: MIT
/**
 * Shared scaffolding for WP 5.1's run-control suites (kill ladder, local
 * lane, breaker kinds, payload preview). Not a `*.test.ts`: collected by
 * nobody, imported by those four.
 *
 * Everything that decides whether a run may continue is **real** here: the
 * `advisors` and `advisor_runs` rows, the approvals table, and the two flags,
 * read through `@core/platform`'s own `createFlagService` with `ttlMs: 0` —
 * the binding the composition root is told to use. Only the advisor (a fake
 * that blocks until aborted, or answers on cue) and the prompt renderer (a
 * pure fake of WP 5.2's port) are stand-ins.
 */
import { createFlagService, platformExecutor, type FlagService } from '@core/platform';
import { sql } from 'drizzle-orm';
import type { AdvisorManifest } from '../../src/contract/manifest.ts';
import type { AdvisorRequest } from '../../src/contract/request.ts';
import type { AdvisorKind } from '../../src/contract/scopes.ts';
import type { InsightsContext } from '../../src/db.ts';
import {
  createRunSwitches,
  MODULE_FLAG_KEY,
  KIND_FLAG_KEYS,
  type RunSwitches,
} from '../../src/policy/kill-switches.ts';
import type { PromptRenderer } from '../../src/ports.ts';
import { approvePayload, previewRequest } from '../../src/preview.ts';
import { createAdvisorRegistry, type Advisor } from '../../src/registry.ts';
import type { InsightsDependencies } from '../../src/service.ts';
import { inputDigest } from '../../src/snapshot/tokens.ts';
import { canonicalJson } from '@core/platform';
import { grantScopes, registerAdvisor } from '../../src/store.ts';
import { baseManifest, responseFor } from '../fixtures.ts';
import { portsFor, selfCiting, USD, ZONE, type TestDatabase } from './harness.ts';

export const LOCAL_ID = 'local.narrator.test';
export const BUILTIN_ID = 'builtin.lane.control';
export const LOCAL_FLAG = KIND_FLAG_KEYS.local_model ?? 'advisors.kind.local_model';

/** A `local_model` manifest the validator accepts output from. */
export function localManifest(overrides: Partial<AdvisorManifest> = {}): AdvisorManifest {
  return baseManifest({
    advisor_id: LOCAL_ID,
    kind: 'local_model',
    display_name: 'Test narrator',
    requires_scopes: ['cash.summary'],
    capabilities: {
      deterministic: false,
      produces_impact: false,
      narrates_only: false,
      max_severity: 'notable',
    },
    // Well above every in-flight kill in these suites: a run that ends by
    // this deadline instead of by the kill is a *failure*, and says so.
    limits: { timeout_ms: 20_000, max_insights: 5, max_response_bytes: 65_536 },
    ...overrides,
  });
}

export function builtinManifest(overrides: Partial<AdvisorManifest> = {}): AdvisorManifest {
  return baseManifest({
    advisor_id: BUILTIN_ID,
    requires_scopes: ['cash.summary'],
    limits: { timeout_ms: 20_000, max_insights: 5, max_response_bytes: 65_536 },
    ...overrides,
  });
}

/** The one well-formed answer both kinds give: self-citing, no figures. */
export function answerFor(request: AdvisorRequest, kind: AdvisorKind): unknown {
  return responseFor(request, [
    selfCiting(request, kind === 'builtin' ? {} : { confidence_basis: 'model', confidence: 0.5 }),
  ]);
}

/** WP 5.2's port, faked: pure, deterministic, and it invokes nothing. */
export function fakeRenderer(template = 'template-v1'): PromptRenderer & { renders: number } {
  const renderer = {
    renders: 0,
    templateHash: inputDigest({ template }),
    model: `fake-model@${inputDigest({ model: 'fake' })}`,
    render(request: AdvisorRequest) {
      renderer.renders += 1;
      const text = `${template}\n<data>\n${canonicalJson(request.snapshot)}\n</data>`;
      return { text, hash: inputDigest({ prompt: text }) };
    },
  };
  return renderer;
}

/** An uncached flag reader over the scratch database, with the two flags' coded defaults. */
export function flagsFor(database: TestDatabase): FlagService {
  return createFlagService({
    db: platformExecutor(database.db),
    defaults: [
      { key: MODULE_FLAG_KEY, defaultEnabled: true, owner: 'test', removeWhen: 'never' },
      { key: LOCAL_FLAG, defaultEnabled: false, owner: 'test', removeWhen: 'never' },
    ],
    ttlMs: 0,
  });
}

/**
 * The live switches, plus a handle on `ADVISORS_ENABLED` — config in
 * production (a restart to change), a mutable here so the refusal ladder can
 * be walked from the top.
 */
export function liveSwitches(flags: FlagService): RunSwitches & { operatorOn: boolean } {
  const inner = createRunSwitches({
    advisorsEnabled: true,
    flags,
    configuredKinds: new Set<AdvisorKind>(['builtin', 'local_model']),
  });
  const switches = {
    operatorOn: true,
    advisorsEnabled: async () => switches.operatorOn && (await inner.advisorsEnabled()),
    moduleEnabled: (userId: string) => inner.moduleEnabled(userId),
    kindEnabled: (userId: string, kind: AdvisorKind) => inner.kindEnabled(userId, kind),
  };
  return switches;
}

export interface BlockingAdvisor extends Advisor {
  /** Resolves the first time `run` is entered. */
  readonly started: Promise<void>;
  readonly calls: () => number;
  /** Let a blocked call answer. */
  readonly release: () => void;
  /** Whether the last call saw its signal abort. */
  readonly aborted: () => boolean;
}

/**
 * An advisor that blocks until aborted — or until `release()` — and then
 * answers well. Built so a kill that does not reach it is visible: without
 * an abort it waits for `release()` or the manifest's deadline.
 */
export function blockingAdvisor(manifest: AdvisorManifest): BlockingAdvisor {
  let calls = 0;
  let aborted = false;
  let markStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let releaseWaiting: (() => void) | null = null;
  let released = false;
  return {
    manifest,
    started,
    calls: () => calls,
    aborted: () => aborted,
    release: () => {
      released = true;
      releaseWaiting?.();
    },
    run: (request, signal) => {
      calls += 1;
      markStarted();
      return new Promise((resolve, reject) => {
        const answer = () => resolve(answerFor(request, manifest.kind));
        if (released) return answer();
        releaseWaiting = answer;
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
          },
          { once: true },
        );
      });
    },
  };
}

export function dependenciesFor(
  advisors: readonly Advisor[],
  switches: RunSwitches,
  renderer: PromptRenderer | undefined = fakeRenderer(),
): InsightsDependencies {
  return {
    registry: createAdvisorRegistry(advisors),
    ports: portsFor(),
    switches,
    ...(renderer === undefined ? {} : { promptRenderer: renderer }),
    settings: { timeZone: ZONE, baseCurrency: USD, tokenSecret: 'test-secret' },
  };
}

/**
 * Put one advisor in the state where every switch says yes: registered and
 * enabled, `cash.summary` granted, its kind's flag on, and — for a local
 * model — its current shape previewed and approved.
 */
export async function armAdvisor(
  database: TestDatabase,
  context: InsightsContext,
  dependencies: InsightsDependencies,
  flags: FlagService,
  manifest: AdvisorManifest,
): Promise<void> {
  await registerAdvisor(database.db, context, { manifest, enabled: true });
  await grantScopes(database.db, context, manifest.advisor_id, ['cash.summary']);
  await flags.set(platformExecutor(database.db), context.userId, MODULE_FLAG_KEY, true);
  await flags.set(platformExecutor(database.db), context.userId, LOCAL_FLAG, true);
  if (manifest.kind !== 'builtin') {
    const preview = await previewRequest(database.db, context, dependencies, manifest.advisor_id);
    await approvePayload(database.db, context, dependencies, {
      advisorId: manifest.advisor_id,
      queryShape: preview.queryShape,
    });
  }
}

export async function insightCount(database: TestDatabase): Promise<number> {
  const rows = await database.db.execute<{ n: string }>(
    sql`SELECT count(*)::text AS n FROM insights WHERE user_id = ${database.userId}::uuid`,
  );
  return Number(rows.rows[0]?.n ?? '0');
}

export async function cancelledEvents(
  database: TestDatabase,
  runId: string,
): Promise<readonly Record<string, unknown>[]> {
  const rows = await database.db.execute<{ payload: Record<string, unknown> }>(
    sql`SELECT payload FROM domain_events
         WHERE event_type = 'insights.AdvisorRunCancelled' AND aggregate_id = ${runId}::uuid`,
  );
  return rows.rows.map((row) => row.payload);
}

/** Wall time. The injected clock is fixed in these suites and never advances. */
export function wallMs(): number {
  return performance.now();
}
