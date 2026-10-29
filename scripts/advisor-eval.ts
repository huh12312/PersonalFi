// SPDX-License-Identifier: MIT
/**
 * `scripts/advisor-eval.ts` — the narrator's first-attempt acceptance, per
 * validation step (WP 5.3; 05 §1's third exit criterion: *"≥95% of generated
 * insights pass evidence-ref validation on first attempt"*).
 *
 * Runs `local.narrator`'s request shape over a fixed set of findings — the
 * correctness seed's and WP 4.13's scale seed's (`advisor-eval.fixtures.ts`),
 * every one alone and then in pairs — and reports how far each narration got
 * through the seven steps, steps 1–5 (the criterion's "evidence-ref
 * validation") beside steps 1–7 (the one that says whether it invented
 * numbers). The counting is `@ctx/insights`' `runNarratorEval`, proven against
 * a scripted one-in-ten fabricator in `test/eval-harness.test.ts`. First
 * attempt only: one call per request, no retry.
 *
 * ## Modes
 *
 *     node --experimental-strip-types scripts/advisor-eval.ts
 *
 *   Replay (the default, and what CI does through `eval-harness.test.ts`):
 *   the recorded live replies in `scripts/advisor-eval.recorded.json`, through
 *   today's validator. No model, no network.
 *
 *     node --experimental-strip-types scripts/advisor-eval.ts --live \
 *       --endpoint http://ollama:11434 --model <name> --digest sha256:<64 hex> \
 *       --out <dir>/live.jsonl [--from <request index>] [--budget-ms 540000]
 *
 *   Live, against the pinned model **through the worker's own composition**
 *   (WP 9.5, Phase 5 gate C5-4/G5-6): the adapter is built by
 *   `apps/api/src/narrator-wiring.ts`'s `createNarratorWiring` — the function
 *   `worker.ts` calls, which takes no `format` — and wrapped by
 *   `createNarratorAdvisor`, as `insightsModule` wraps it; each request is
 *   sent with the production deadline (the narrator manifest's resolved
 *   `timeoutMs`, and the adapter's `LOCAL_MODEL_TIMEOUT_MS` default, 180 s,
 *   unless `--timeout-ms` names the value an install sets). One finding per
 *   request, the production shape since C5-2. Appends one JSON line per request to `--out` and stops before
 *   `--budget-ms` elapses, so a run can be resumed with `--from` in chunks
 *   that each fit a foreground wait. Must run where the endpoint resolves —
 *   inside the compose `llm` network (see the evidence file for the exact
 *   `docker compose run` line).
 *
 *     node --experimental-strip-types scripts/advisor-eval.ts --finalise <dir>/live.jsonl \
 *       --write scripts/advisor-eval.recorded.json --meta key=value ...
 *
 *   Summarise a completed live run and write the recorded-reply file.
 *
 *     node --experimental-strip-types scripts/advisor-eval.ts --brief --cold \
 *       --endpoint http://ollama:11434 --model <name> --digest sha256:<64 hex> --out <dir>/brief.jsonl
 *
 *   The 5-item Brief timing (C5-2), from a model `--cold` unloads first.
 *
 *     node --experimental-strip-types scripts/advisor-eval.ts --brief-week [--cold] \
 *       --endpoint http://ollama:11434 --model <name> --digest sha256:<64 hex> --out <dir>/brief-week.jsonl
 *
 *   WP 11.4: the same five items, then the Brief's own composed narration
 *   (`brief.narrate`, one call), judged by the production validator
 *   (`advisor-eval-brief-week.ts`; CI runs it over the Ollama fake).
 *
 *     node --experimental-strip-types scripts/advisor-eval.ts --ask [--live \
 *       --endpoint http://ollama:11434 --model <name> --digest sha256:<64 hex> --out <dir>/ask.jsonl]
 *
 *   WP 11.5c: Ask PersonalFi's compile golden set (`advisor-eval-ask.ts`):
 *   precision and recall per catalogue function over the recorded replies
 *   (replay, the default; CI runs it, and over the Ollama fake), or over the
 *   pinned model with `--live`.
 *
 *     node --experimental-strip-types scripts/advisor-eval.ts --advisor [--live \
 *       --endpoint http://ollama:11434 --model <name> --digest sha256:<64 hex> --out <dir>/advisor.jsonl]
 *
 *   WP 11.5d: the advisor-mode golden set (`advisor-eval-advisor.ts`): at
 *   least twenty sessions through every step's validator over 11.5b's
 *   catalogue fixture — outcomes, calls precision/recall, option counts,
 *   refusal classes and the rubric judge's scores — over the recorded replies
 *   (replay, the default; CI runs it, and over the Ollama fake), or over the
 *   pinned model with `--live`.
 *
 *     node --experimental-strip-types scripts/advisor-eval.ts --merchant-name [--live \
 *       --endpoint http://ollama:11434 --model <name> --digest sha256:<64 hex> --out <dir>/merchant-name.jsonl]
 *
 *   WP 11.6: the merchant-name golden set (`advisor-eval-merchant-name.ts`):
 *   at least forty bank descriptors, noise and not, through the noise detector
 *   and the substring-preserving validator — precision of the accepted names
 *   and the refusal rate — over the recorded replies (replay, the default; CI
 *   runs it, and over the Ollama fake), or over the pinned model with `--live`.
 *
 * ## What it prints, and what it never prints
 *
 * Counts, step names, refusal reasons, durations and token counts. **Never a
 * prompt, a reply or a snapshot byte** (03 §8.3) — the replies go to the
 * `--out` file, which holds narrations of synthetic seed data and nothing
 * else, and which is the recorded-reply fixture CI replays.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  evalRequest,
  judgeReply,
  planRequests,
  summarise,
  type EvalReport,
  type EvalRequestSpec,
  type NarrationVerdict,
} from '../packages/contexts/insights/src/advisors/local/eval.ts';
import { createNarratorAdvisor } from '../packages/contexts/insights/src/advisors/local/narrator.ts';
import { NARRATOR_MANIFEST } from '../packages/contexts/insights/src/advisors/local/manifest.ts';
import { resolveLimits } from '../packages/contexts/insights/src/contract/manifest.ts';
import type { AdvisorRequest } from '../packages/contexts/insights/src/contract/request.ts';
import { evalCases } from './advisor-eval.fixtures.ts';
import { BRIEF_CASE_TYPES, briefWeek } from './advisor-eval-brief-week.ts';
import { askGoldenOverModel, formatAskReport, replayAskGolden } from './advisor-eval-ask.ts';
import {
  formatMerchantNameReport,
  merchantNameGoldenOverModel,
  replayMerchantNameGolden,
} from './advisor-eval-merchant-name.ts';
import {
  advisorGoldenOverModel,
  formatAdvisorReport,
  replayAdvisorGolden,
} from './advisor-eval-advisor.ts';

/**
 * One finding per request — the production shape since WP 9.5 (C5-2:
 * `FINDINGS_PER_NARRATION_REQUEST`, one Brief item per job). Phase 5 measured
 * every finding alone and in pairs; a pair is a request no install sends now.
 */
export const GROUP_SIZES = [1] as const;

/** The Brief measurement's five findings (`--brief`, `--brief-week`): the case ids, in Brief order. */
export { BRIEF_CASE_TYPES };

const RECORDED = join(import.meta.dirname, 'advisor-eval.recorded.json');

interface Args {
  readonly flags: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, string>;
  readonly meta: Readonly<Record<string, string>>;
}

function parseArgs(argv: readonly string[]): Args {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const meta: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (!arg.startsWith('--')) continue;
    const name = arg.slice(2);
    const next = argv[index + 1];
    if (name === 'meta' && next !== undefined) {
      const eq = next.indexOf('=');
      if (eq > 0) meta[next.slice(0, eq)] = next.slice(eq + 1);
      index += 1;
    } else if (next !== undefined && !next.startsWith('--')) {
      values.set(name, next);
      index += 1;
    } else {
      flags.add(name);
    }
  }
  return { flags, values, meta };
}

function printReport(label: string, report: EvalReport): void {
  const pct = (rate: number | null) => (rate === null ? 'n/a' : `${(rate * 100).toFixed(1)}%`);
  console.log(`\n${label}`);
  console.log(
    `  cases ${String(report.cases)} · requests ${String(report.requests)} · narrations ${String(report.narrations)} · extras ${String(report.extras)}`,
  );
  const steps = [
    'transport',
    'schema',
    'envelope',
    'capability',
    'evidence',
    'derivations',
    'numerals',
  ];
  steps.forEach((step, index) => {
    console.log(
      `  passed steps 1–${String(index + 1)} (${step}): ${String(report.passedThrough[index + 1] ?? 0)}`,
    );
  });
  const { steps1to5, steps1to7 } = report.firstAttempt;
  console.log(
    `  FIRST ATTEMPT  steps 1–5: ${String(steps1to5.accepted)}/${String(steps1to5.total)} = ${pct(steps1to5.rate)}` +
      `   steps 1–7: ${String(steps1to7.accepted)}/${String(steps1to7.total)} = ${pct(steps1to7.rate)}`,
  );
  for (const [failure, count] of Object.entries(report.failures).sort()) {
    console.log(`    ${String(count)} × ${failure}`);
  }
}

interface LiveLine {
  readonly index: number;
  readonly spec: EvalRequestSpec;
  readonly error: string | null;
  readonly insights: unknown;
  readonly warnings: readonly string[];
  readonly verdicts: readonly NarrationVerdict[];
  readonly extras: number;
  readonly wallMs: number;
  readonly evalCount: number | null;
  readonly promptEvalCount: number | null;
  readonly promptBytes: number | null;
  readonly chatMs: number | null;
  /** C5-2: the adapter's warm-up stage — the model's state before, what was done, how long. */
  readonly modelBefore?: string | null;
  readonly warmUp?: string | null;
  readonly warmUpMs?: number | null;
  /** `/proc/loadavg`'s first three fields when the request finished (WP 9.5). */
  readonly load?: string;
  readonly at?: string;
}

interface LiveRun {
  readonly label: string;
  readonly send: (
    spec: EvalRequestSpec,
    request: AdvisorRequest,
  ) => Promise<{
    readonly body: unknown;
    readonly error: string | null;
    readonly log: Record<string, unknown>;
  }>;
}

/** Build the narrator exactly as the worker does, over `--endpoint`/`--model`/`--digest`. */
async function shippedNarrator(args: Args): Promise<LiveRun> {
  const endpoint = args.values.get('endpoint');
  const model = args.values.get('model');
  const digest = args.values.get('digest');
  if (endpoint === undefined || model === undefined || digest === undefined) {
    throw new Error('--live and --brief need --endpoint, --model and --digest');
  }
  const timeoutMs = Number(args.values.get('timeout-ms') ?? '180000');
  // Imported here, not at the top: replay mode (CI) must not need the adapter.
  const { createNarratorWiring } = await import('../apps/api/src/narrator-wiring.ts');
  // The adapter's own log line for the call just made: shape, sizes, token
  // counts and durations only (it never logs content). Read for timings.
  let last: Record<string, unknown> = {};
  const logger = {
    info: (obj: Record<string, unknown>) => {
      last = obj;
    },
    warn: (obj: Record<string, unknown>) => {
      last = obj;
    },
  };
  const wiring = createNarratorWiring(
    { endpoint, name: model, digest, timeoutMs, allowRemote: false },
    { logger },
  );
  if (wiring === undefined) throw new Error('no model configured');
  const narrator = createNarratorAdvisor({ model: wiring.narratorModel });
  const requestTimeoutMs = resolveLimits(NARRATOR_MANIFEST).timeoutMs;
  const label =
    `template hash ${wiring.localModel.promptTemplateHash} · adapter timeout ${String(timeoutMs)} ms · ` +
    `request deadline +${String(requestTimeoutMs)} ms`;
  return {
    label,
    async send(_spec, request) {
      last = {};
      // The production deadline, set at send time as `buildAdvisorRequest`
      // sets it (`generated_at + timeoutMs`). Not part of the prompt.
      const timed: AdvisorRequest = {
        ...request,
        limits: {
          ...request.limits,
          deadline: new Date(Date.now() + requestTimeoutMs).toISOString(),
        },
      };
      try {
        return {
          body: await narrator.run(timed, new AbortController().signal),
          error: null,
          log: last,
        };
      } catch (caught) {
        const code = (caught as { code?: unknown } | null)?.code;
        return { body: null, error: typeof code === 'string' ? code : 'error', log: last };
      }
    },
  };
}

/** What the runtime says about the model right now: loaded or not (`GET /api/ps`). */
async function modelState(endpoint: string): Promise<string> {
  try {
    const base = endpoint.startsWith('http') ? endpoint : `http://${endpoint}`;
    const response = await fetch(`${base}/api/ps`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return `unknown (GET /api/ps answered ${String(response.status)})`;
    const body = (await response.json()) as { models?: { name?: string; size?: number }[] };
    const models = body.models ?? [];
    return models.length === 0
      ? 'cold (no model loaded)'
      : `warm (${models.map((entry) => `${String(entry.name)} ${String(entry.size)} B`).join(', ')})`;
  } catch {
    return 'unknown';
  }
}

function loadAverage(): string {
  try {
    return readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).join(' ');
  } catch {
    return 'unknown';
  }
}

async function live(args: Args): Promise<void> {
  const out = args.values.get('out');
  if (out === undefined) throw new Error('--live needs --out');
  const from = Number(args.values.get('from') ?? '0');
  const budgetMs = Number(args.values.get('budget-ms') ?? '540000');
  const run = await shippedNarrator(args);
  console.log(`shipped composition: ${run.label}`);

  const { cases, today } = await evalCases();
  const specs = planRequests(cases, GROUP_SIZES);
  const started = Date.now();
  console.log(
    `live: ${String(cases.length)} cases, ${String(specs.length)} requests; starting at ${String(from)}; budget ${String(budgetMs)} ms; load ${loadAverage()}`,
  );
  for (let index = from; index < specs.length; index += 1) {
    if (Date.now() - started > budgetMs) {
      console.log(`budget reached; resume with --from ${String(index)}`);
      return;
    }
    const spec = specs[index] as EvalRequestSpec;
    const request = evalRequest(spec, today);
    const t0 = Date.now();
    const sent = await run.send(spec, request);
    const wallMs = Date.now() - t0;
    const { body, error, log: last } = sent;
    const judged =
      error === null
        ? judgeReply(spec, request, body)
        : {
            verdicts: spec.caseIds.map((caseId) => ({
              caseId,
              specId: spec.id,
              passedThrough: 0,
              failure: 'model_error' as const,
              reason: error,
            })),
            extras: 0,
          };
    const reply = body as { insights?: unknown; diagnostics?: { warnings?: string[] } } | null;
    const line: LiveLine = {
      index,
      spec,
      error,
      insights: reply?.insights ?? null,
      warnings: reply?.diagnostics?.warnings ?? [],
      verdicts: judged.verdicts,
      extras: judged.extras,
      wallMs,
      evalCount: typeof last['eval_count'] === 'number' ? last['eval_count'] : null,
      promptEvalCount:
        typeof last['prompt_eval_count'] === 'number' ? last['prompt_eval_count'] : null,
      promptBytes: typeof last['prompt_bytes'] === 'number' ? last['prompt_bytes'] : null,
      chatMs: typeof last['chat_ms'] === 'number' ? last['chat_ms'] : null,
      modelBefore: typeof last['model_before'] === 'string' ? last['model_before'] : null,
      warmUp: typeof last['warm_up'] === 'string' ? last['warm_up'] : null,
      warmUpMs: typeof last['warm_up_ms'] === 'number' ? last['warm_up_ms'] : null,
      load: loadAverage(),
      at: new Date().toISOString(),
    };
    appendFileSync(out, `${JSON.stringify(line)}\n`);
    // Shape only: which step each narration reached. Never the text.
    console.log(
      `[${String(index)}/${String(specs.length)}] findings ${String(spec.findings.length)} · ${String(wallMs)} ms · ` +
        `prompt ${String(line.promptBytes ?? '?')} B / ${String(line.promptEvalCount ?? '?')} tok · eval ${String(line.evalCount ?? '?')} tok · load ${line.load ?? '?'} · ` +
        judged.verdicts
          .map((verdict) =>
            verdict.failure === null ? 'ok' : `${verdict.failure}:${verdict.reason ?? ''}`,
          )
          .join(' | '),
    );
  }
  console.log('live: all requests done');
}

/**
 * `--cold` (with `--brief`): unload the model first (`POST /api/generate` with
 * `keep_alive: 0`, Ollama's documented unload) and wait until `GET /api/ps`
 * shows nothing loaded, so the Brief measurement starts from a genuinely cold
 * model however the stack was left. Sends no prompt.
 */
async function unload(endpoint: string, args: Args): Promise<string> {
  const base = endpoint.startsWith('http') ? endpoint : `http://${endpoint}`;
  const model = args.values.get('model') ?? '';
  try {
    await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, keep_alive: 0 }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    return 'unload request failed; state as found';
  }
  for (let waited = 0; waited < 60_000; waited += 1_000) {
    const state = await modelState(endpoint);
    if (state.startsWith('cold')) return `model unloaded (${state})`;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return `model still loaded after 60 s (${await modelState(endpoint)})`;
}

/**
 * `--brief`: a five-item Brief's narration on this host (Phase 5 gate C5-2's
 * "deadline sized from a measured 5-item Brief"). Five findings, one request
 * each — what the Brief now enqueues, one `insights.run_local` job per item,
 * run back to back as the lane's concurrency 1 runs them — through the
 * shipped composition and the production deadline. Records, per request, the
 * wall time against the deadline, the model's state before it (cold/warm,
 * from the runtime's own `GET /api/ps`) and the load average. Verdicts are
 * recorded too, but this is a timing, not a count: the counted run is `--live`.
 * Since WP 9.5's cold-model design each line also carries the adapter's
 * warm-up stage (`modelBefore`, `warmUp`, `warmUpMs`) apart from `chatMs`,
 * and the deadline is the request's (the narrator manifest's 300 s; the chat
 * alone is bounded by `--timeout-ms`, the adapter's, 180 s by default).
 * `--cold` unloads the model first.
 */
async function brief(args: Args): Promise<void> {
  const out = args.values.get('out');
  const endpoint = args.values.get('endpoint') ?? '';
  if (out === undefined) throw new Error('--brief needs --out');
  const run = await shippedNarrator(args);
  const { cases, today } = await evalCases();
  const picked = BRIEF_CASE_TYPES.map((type) => {
    const found = cases.find((entry) => entry.finding.type === type && entry.seed === 'drift');
    if (found === undefined) throw new Error(`the drift seed has no ${type} finding`);
    return found;
  });
  const specs = planRequests(picked, [1]);
  const deadlineMs = resolveLimits(NARRATOR_MANIFEST).timeoutMs;
  if (args.flags.has('cold')) console.log(`brief: ${await unload(endpoint, args)}`);
  console.log(`brief: ${run.label}; load ${loadAverage()}`);
  const started = Date.now();
  for (const [index, spec] of specs.entries()) {
    const state = await modelState(endpoint);
    const loadBefore = loadAverage();
    const request = evalRequest(spec, today);
    const t0 = Date.now();
    const sent = await run.send(spec, request);
    const wallMs = Date.now() - t0;
    const judged = sent.error === null ? judgeReply(spec, request, sent.body).verdicts : [];
    const line = {
      mode: 'brief',
      index,
      caseId: spec.caseIds[0],
      modelStateBefore: state,
      loadBefore,
      loadAfter: loadAverage(),
      wallMs,
      deadlineMs,
      insideDeadline: sent.error === null && wallMs < deadlineMs,
      error: sent.error,
      promptEvalCount: sent.log['prompt_eval_count'] ?? null,
      evalCount: sent.log['eval_count'] ?? null,
      chatMs: sent.log['chat_ms'] ?? null,
      // C5-2: the adapter's own account of its warm-up stage, beside the
      // runtime's (`modelStateBefore`): counted apart from the chat.
      modelBefore: sent.log['model_before'] ?? null,
      warmUp: sent.log['warm_up'] ?? null,
      warmUpMs: sent.log['warm_up_ms'] ?? null,
      chatTimeoutMs: Number(args.values.get('timeout-ms') ?? '180000'),
      verdicts: judged.map((verdict) =>
        verdict.failure === null ? 'ok' : `${verdict.failure}:${verdict.reason ?? ''}`,
      ),
      at: new Date().toISOString(),
    };
    appendFileSync(out, `${JSON.stringify(line)}\n`);
    console.log(
      `[brief ${String(index + 1)}/5] ${state} · ${String(wallMs)} ms of ${String(deadlineMs)} · ` +
        `warm-up ${String(line.warmUp)} ${String(line.warmUpMs ?? '-')} ms · chat ${String(line.chatMs ?? '-')} ms · ` +
        `load ${loadBefore} → ${line.loadAfter} · ${sent.error ?? line.verdicts.join(',')}`,
    );
  }
  console.log(`brief: five items narrated in ${String(Date.now() - started)} ms`);
}

function readLines(file: string): readonly LiveLine[] {
  const byIndex = new Map<number, LiveLine>();
  for (const text of readFileSync(file, 'utf8').split('\n')) {
    if (text.trim().length === 0) continue;
    const line = JSON.parse(text) as LiveLine;
    // First attempt only: a line for an index already recorded is ignored,
    // never preferred — resuming a chunk must not become a retry.
    if (!byIndex.has(line.index)) byIndex.set(line.index, line);
  }
  return [...byIndex.values()].sort((left, right) => left.index - right.index);
}

async function finalise(args: Args): Promise<void> {
  const file = args.values.get('finalise');
  const write = args.values.get('write');
  if (file === undefined) throw new Error('--finalise needs a file');
  const { cases, today } = await evalCases();
  const specs = planRequests(cases, GROUP_SIZES);
  const lines = readLines(file);
  if (lines.length !== specs.length) {
    throw new Error(`the live run has ${String(lines.length)} of ${String(specs.length)} requests`);
  }
  const verdicts = lines.flatMap((line) => line.verdicts);
  const extras = lines.reduce((sum, line) => sum + line.extras, 0);
  const report = summarise(cases.length, specs.length, verdicts, extras);
  printReport('live (first attempt, as recorded)', report);
  const walls = lines.map((line) => line.wallMs).sort((left, right) => left - right);
  const bySize = new Map<number, number[]>();
  for (const line of lines) {
    const list = bySize.get(line.spec.findings.length) ?? [];
    list.push(line.wallMs);
    bySize.set(line.spec.findings.length, list);
  }
  console.log(
    `  wall ms per request: min ${String(walls[0])} median ${String(walls[Math.floor(walls.length / 2)])} max ${String(walls[walls.length - 1])}`,
  );
  for (const [size, list] of [...bySize.entries()].sort()) {
    const sorted = [...list].sort((left, right) => left - right);
    console.log(
      `    ${String(size)} finding(s): n ${String(sorted.length)} median ${String(sorted[Math.floor(sorted.length / 2)])} max ${String(sorted[sorted.length - 1])}`,
    );
  }
  if (write !== undefined) {
    const recorded = {
      today,
      cases: cases.length,
      groupSizes: GROUP_SIZES,
      meta: args.meta,
      summary: report,
      requests: lines.map((line) => ({
        spec: line.spec,
        error: line.error,
        insights: line.insights,
        wallMs: line.wallMs,
        evalCount: line.evalCount,
        promptEvalCount: line.promptEvalCount,
      })),
    };
    writeFileSync(write, `${JSON.stringify(recorded, null, 2)}\n`);
    console.log(`wrote ${write}`);
  }
}

async function replay(): Promise<void> {
  if (!existsSync(RECORDED)) {
    console.log('no recorded live run (scripts/advisor-eval.recorded.json); nothing to replay');
    return;
  }
  const recorded = JSON.parse(readFileSync(RECORDED, 'utf8')) as {
    readonly today: string;
    readonly cases: number;
    readonly meta: Record<string, string>;
    readonly summary: EvalReport;
    readonly requests: readonly {
      spec: EvalRequestSpec;
      error: string | null;
      insights: unknown;
    }[];
  };
  const verdicts: NarrationVerdict[] = [];
  let extras = 0;
  for (const entry of recorded.requests) {
    const request = evalRequest(entry.spec, recorded.today);
    if (entry.error !== null) {
      verdicts.push(
        ...entry.spec.caseIds.map((caseId) => ({
          caseId,
          specId: entry.spec.id,
          passedThrough: 0,
          failure: 'model_error' as const,
          reason: entry.error,
        })),
      );
      continue;
    }
    const judged = judgeReply(entry.spec, request, {
      contract_version: request.contract_version,
      request_id: request.request_id,
      advisor_id: request.advisor_id,
      advisor_version: request.advisor_version,
      produced_at: request.generated_at,
      diagnostics: { runtime_ms: 0, model: null, warnings: [] },
      insights: entry.insights,
    });
    verdicts.push(...judged.verdicts);
    extras += judged.extras;
  }
  const report = summarise(recorded.cases, recorded.requests.length, verdicts, extras);
  console.log(
    `recorded: ${Object.entries(recorded.meta)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ')}`,
  );
  printReport("replay (recorded replies, today's validator)", report);
  const same = JSON.stringify(report) === JSON.stringify(recorded.summary);
  console.log(
    same ? '\nreplay matches the recorded summary' : '\nREPLAY DIFFERS from the recorded summary',
  );
  if (!same) process.exitCode = 1;
}

/**
 * `--brief-week` (WP 11.4): the five-item Brief and then its own composed
 * narration, through the shipped compositions (`advisor-eval-brief-week.ts`).
 */
async function briefWeekMode(args: Args): Promise<void> {
  const endpoint = args.values.get('endpoint');
  const model = args.values.get('model');
  const digest = args.values.get('digest');
  if (endpoint === undefined || model === undefined || digest === undefined) {
    throw new Error('--brief-week needs --endpoint, --model and --digest');
  }
  const out = args.values.get('out');
  if (out === undefined) throw new Error('--brief-week needs --out');
  if (args.flags.has('cold')) console.log(`brief-week: ${await unload(endpoint, args)}`);
  console.log(`brief-week: load ${loadAverage()}`);
  const report = await briefWeek({
    endpoint,
    model,
    digest,
    timeoutMs: Number(args.values.get('timeout-ms') ?? '180000'),
    out,
    log: (line) => console.log(line),
  });
  const accepted = report.items.filter((item) => item.accepted).length;
  console.log(
    `brief-week: items ${String(accepted)}/5 accepted · composition ` +
      `${report.composition.accepted ? 'accepted' : `refused (${String(report.composition.refusal ?? report.composition.error)})`} · ` +
      `${String(report.totalMs)} ms in all (each request's deadline ${String(report.deadlineMs)} ms)`,
  );
}

/** `--ask` (WP 11.5c): the compile golden set, replayed or live. */
async function askMode(args: Args): Promise<void> {
  if (!args.flags.has('live')) {
    const { report } = replayAskGolden();
    console.log("ask: replay (recorded compile replies, today's validator)");
    for (const line of formatAskReport(report)) console.log(line);
    return;
  }
  const endpoint = args.values.get('endpoint');
  const model = args.values.get('model');
  const digest = args.values.get('digest');
  if (endpoint === undefined || model === undefined || digest === undefined) {
    throw new Error('--ask --live needs --endpoint, --model and --digest');
  }
  const out = args.values.get('out');
  const { report, calls } = await askGoldenOverModel({
    endpoint,
    model,
    digest,
    timeoutMs: Number(args.values.get('timeout-ms') ?? '180000'),
    ...(out === undefined ? {} : { out }),
  });
  console.log(`ask: live (${String(calls)} compile calls, first attempt only)`);
  for (const line of formatAskReport(report)) console.log(line);
}

/** `--advisor` (WP 11.5d): the advisor-mode golden set, replayed or live. */
async function advisorMode(args: Args): Promise<void> {
  if (!args.flags.has('live')) {
    const { report } = await replayAdvisorGolden();
    console.log("advisor: replay (recorded step replies, today's validators)");
    for (const line of formatAdvisorReport(report)) console.log(line);
    return;
  }
  const endpoint = args.values.get('endpoint');
  const model = args.values.get('model');
  const digest = args.values.get('digest');
  if (endpoint === undefined || model === undefined || digest === undefined) {
    throw new Error('--advisor --live needs --endpoint, --model and --digest');
  }
  const out = args.values.get('out');
  const { report, calls } = await advisorGoldenOverModel({
    endpoint,
    model,
    digest,
    timeoutMs: Number(args.values.get('timeout-ms') ?? '180000'),
    ...(out === undefined ? {} : { out }),
  });
  console.log(`advisor: live (${String(calls)} model calls, first attempt only)`);
  for (const line of formatAdvisorReport(report)) console.log(line);
}

/** `--merchant-name` (WP 11.6): the merchant-name golden set, replayed or live. */
async function merchantNameMode(args: Args): Promise<void> {
  if (!args.flags.has('live')) {
    const { report } = replayMerchantNameGolden();
    console.log("merchant-name: replay (recorded replies, today's detector and validator)");
    for (const line of formatMerchantNameReport(report)) console.log(line);
    return;
  }
  const endpoint = args.values.get('endpoint');
  const model = args.values.get('model');
  const digest = args.values.get('digest');
  if (endpoint === undefined || model === undefined || digest === undefined) {
    throw new Error('--merchant-name --live needs --endpoint, --model and --digest');
  }
  const out = args.values.get('out');
  const { report, calls } = await merchantNameGoldenOverModel({
    endpoint,
    model,
    digest,
    timeoutMs: Number(args.values.get('timeout-ms') ?? '180000'),
    ...(out === undefined ? {} : { out }),
  });
  console.log(`merchant-name: live (${String(calls)} calls, first attempt only)`);
  for (const line of formatMerchantNameReport(report)) console.log(line);
}

const args = parseArgs(process.argv.slice(2));
if (args.flags.has('merchant-name')) await merchantNameMode(args);
else if (args.flags.has('advisor')) await advisorMode(args);
else if (args.flags.has('ask')) await askMode(args);
else if (args.flags.has('live')) await live(args);
else if (args.flags.has('brief-week')) await briefWeekMode(args);
else if (args.flags.has('brief')) await brief(args);
else if (args.values.has('finalise')) await finalise(args);
else await replay();
