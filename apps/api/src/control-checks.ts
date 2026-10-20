// SPDX-License-Identifier: MIT
/**
 * The GenAI controls self-test, composed (WP 10.16; RUNBOOK "Proving the GenAI
 * controls").
 *
 * `@ctx/insights`' catalogue is pure over ports; this file binds the api's
 * half of those ports to this install — the database, the preview-mode
 * narrator runtime (it renders and resolves, it never calls), the flag
 * service, the consent text, the Brief's own badge reading — and the hand-off
 * that gives the worker its half (`insights.control_checks` through the job
 * queue). The route (`routes/narrator-control-checks.ts`) and the operator's
 * `just genai-selftest` (`bin/genai-selftest.ts`) both run it, so the button
 * and the recipe prove the same thing the same way.
 *
 * The worker's half is bound in `worker.ts` / `modules.ts`: its probe model
 * is the run-mode runtime's own adapter for the holder (`controlProbeModelOf`
 * below), so the probes go out with the narration's key, window, egress
 * policy and format.
 */
import { newId } from '@core/kernel';
import type { Database } from '@core/db';
import {
  cancelJob,
  createFlagService,
  enqueueJob,
  featureFlags,
  PLATFORM_FLAGS,
  platformExecutor,
} from '@core/platform';
import {
  CONTROL_CHECKS_JOB_KIND,
  createRunSwitches,
  decideRun,
  holderCheckPorts,
  isHostedProviderName,
  KIND_FLAG_KEYS,
  MODULE_FLAG_KEY,
  rolledBack,
  type ApiCheckPorts,
  type ControlCheckRun,
  type InsightsContext,
  type ModuleSwitchPort,
  type WorkerHandoff,
} from '@ctx/insights';
import { asc, eq } from 'drizzle-orm';
import { narratorConsentSha256, NARRATOR_CONSENT_VERSION } from './narrator-consent.ts';
import type { NarratorRuntime } from './narrator-wiring.ts';
import { ADVISOR_KIND_FLAGS, MODULE_FLAGS } from './platform.ts';
import type { PreviewModel } from './modules.ts';
import { previewDependenciesOf, timezoneOf } from './routes/advisor-runs.ts';
import { narratedByOf } from './routes/brief.ts';
import type { RouteDeps } from './routes/deps.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** A correlation id the job queue accepts (a uuid), from a request id that may not be one. */
export function correlationIdOf(value: unknown): string {
  return typeof value === 'string' && UUID.test(value) ? value : newId();
}

export interface ControlCheckComposition extends Pick<
  RouteDeps,
  'database' | 'pool' | 'clock' | 'config'
> {
  /** The preview-mode runtime: resolves the holder's narrator, renders, never calls. */
  readonly runtime: Pick<NarratorRuntime, 'resolve' | 'forUser'>;
  readonly preview: PreviewModel | undefined;
}

function flagsOver(database: Parameters<typeof platformExecutor>[0]) {
  return createFlagService({
    db: platformExecutor(database),
    defaults: [...PLATFORM_FLAGS, ...MODULE_FLAGS, ...ADVISOR_KIND_FLAGS],
    ttlMs: 0,
  });
}

/** Kill levels 1 and 2, read as they stand; the module switch proved in a rolled-back transaction. */
export function moduleSwitchPort(input: {
  readonly database: Database;
  readonly userId: string;
  readonly advisorsEnabled: boolean;
  readonly configured: () => Promise<boolean>;
}): ModuleSwitchPort {
  const { database, userId } = input;
  const kindKey = KIND_FLAG_KEYS.local_model ?? 'advisors.kind.local_model';
  return {
    async levels() {
      const flags = flagsOver(database);
      const [moduleEnabled, kindFlag, kindConfigured] = await Promise.all([
        flags.isEnabled(userId, MODULE_FLAG_KEY),
        flags.isEnabled(userId, kindKey),
        input.configured(),
      ]);
      return { advisorsEnabled: input.advisorsEnabled, moduleEnabled, kindFlag, kindConfigured };
    },
    async flagState() {
      const rows = await database
        .select({ key: featureFlags.key, enabled: featureFlags.enabled })
        .from(featureFlags)
        .where(eq(featureFlags.userId, userId))
        .orderBy(asc(featureFlags.key));
      return JSON.stringify(rows);
    },
    proveModuleOff: () =>
      rolledBack(database, async (tx) => {
        const flags = flagsOver(tx);
        await flags.set(platformExecutor(tx), userId, MODULE_FLAG_KEY, false);
        // The ladder's own reader (`createRunSwitches`, uncached) over this
        // transaction, and the ladder's own verdict, every other level on.
        const switches = createRunSwitches({
          advisorsEnabled: true,
          flags,
          configuredKinds: new Set(['builtin', 'local_model']),
        });
        const decision = decideRun({
          advisorsEnabled: await switches.advisorsEnabled(),
          moduleEnabled: await switches.moduleEnabled(userId),
          kindEnabled: true,
          advisorEnabled: true,
          quarantinedAt: null,
          payloadApproved: true,
        });
        return { refusal: decision.run ? null : decision.refusal };
      }),
  };
}

/** The api's half of the ports, for one holder. */
export async function apiCheckPorts(
  composition: ControlCheckComposition,
  context: InsightsContext,
): Promise<ApiCheckPorts> {
  const { database, config } = composition;
  const timeZone = await timezoneOf(composition);
  const dependencies = await previewDependenciesOf(
    { database, clock: composition.clock, config },
    context.userId,
    timeZone,
    composition.preview,
  );
  const narrator = await composition.runtime.forUser(context.userId);
  const holder = holderCheckPorts({
    database,
    context,
    dependencies,
    narrator,
    consent: {
      version: NARRATOR_CONSENT_VERSION,
      sha256: (provider) => narratorConsentSha256(provider),
    },
    badgeOf: (llmModel) => narratedByOf(llmModel),
  });
  return {
    ...holder,
    moduleSwitch: moduleSwitchPort({
      database,
      userId: context.userId,
      advisorsEnabled: config.env.ADVISORS_ENABLED,
      configured: async () => (await composition.runtime.forUser(context.userId)) !== null,
    }),
  };
}

/** The production hand-off: the job queue. The worker claims `insights.control_checks`. */
export function queueHandoff(database: Database, context: InsightsContext): WorkerHandoff {
  const executor = platformExecutor(database);
  return {
    async enqueue(runId) {
      const queued = await enqueueJob(executor, {
        kind: CONTROL_CHECKS_JOB_KIND,
        userId: context.userId,
        payload: { runId },
        dedupeKey: `${CONTROL_CHECKS_JOB_KIND}:${runId}`,
        priority: 10,
        maxAttempts: 1,
        correlationId: correlationIdOf(context.correlationId),
      });
      return queued.id;
    },
    cancel: (jobId) => cancelJob(executor, jobId),
  };
}

/** What the cost line says before a press, per provider. */
export function controlChecksCost(
  provider: string,
  displayName: string,
): { readonly modelCalls: number; readonly hosted: boolean; readonly message: string } {
  if (isHostedProviderName(provider)) {
    return {
      modelCalls: 3,
      hosted: true,
      message: `This sends up to 3 calls to ${displayName} with your key, from this install's hourly window of 30.`,
    };
  }
  if (provider === 'ollama') {
    return {
      modelCalls: 3,
      hosted: false,
      message:
        'This runs up to 3 short probes on the local model through the worker; it can take a few minutes. Nothing leaves this machine.',
    };
  }
  return {
    modelCalls: 0,
    hosted: false,
    message:
      'The narrator is Off: the checks that need a model will be skipped, and nothing is sent anywhere.',
  };
}

/** A run as text: what `just genai-selftest` prints — the same table the Settings screen shows. */
export function formatControlCheckRun(run: ControlCheckRun): string {
  const verdict: Readonly<Record<string, string>> = {
    pass: 'PASS',
    fail: 'FAIL',
    skipped: 'SKIPPED',
    reported: 'REPORTED',
    pending: 'PENDING',
    running: 'RUNNING',
  };
  const lines: string[] = [
    `GenAI controls self-test ${run.evidenceVersion}`,
    `started   ${run.startedAt.toISOString()}`,
    `finished  ${run.finishedAt?.toISOString() ?? '(not finished)'}`,
    `narrator  ${run.provider === 'off' ? 'Off' : (run.model ?? run.provider)}`,
    `overall   ${(run.overall ?? 'running').toUpperCase()}`,
    '',
  ];
  const width = Math.max(...run.results.map((row) => row.name.length), 5);
  lines.push(`${'CHECK'.padEnd(width)}  ${'RESULT'.padEnd(14)}  DURATION`);
  for (const row of run.results) {
    const result =
      row.status === 'skipped' && row.notApplicable ? 'N/A' : (verdict[row.status] ?? row.status);
    const duration = row.durationMs === null ? '-' : `${String(row.durationMs)} ms`;
    lines.push(`${row.name.padEnd(width)}  ${result.padEnd(14)}  ${duration}`);
    if (row.reason !== null) lines.push(`${' '.repeat(width + 2)}why: ${row.reason}`);
    for (const fact of row.facts) lines.push(`${' '.repeat(width + 2)}- ${fact}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Exit status for the recipe: 0 pass, 2 partial (something could not run), 1 fail. */
export function exitCodeOf(overall: ControlCheckRun['overall']): number {
  return overall === 'pass' ? 0 : overall === 'partial' ? 2 : 1;
}
