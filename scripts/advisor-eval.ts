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
 *   Live, against the pinned model through WP 5.2's real adapter (the
 *   local-endpoint egress policy, the digest pin before every request, the
 *   byte caps). Appends one JSON line per request to `--out` and stops before
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
import { NARRATOR_REPLY_FORMAT } from '../packages/contexts/insights/src/advisors/local/format.ts';
import { evalCases } from './advisor-eval.fixtures.ts';

/** Every finding alone, then in pairs: two different prompts per finding. */
export const GROUP_SIZES = [1, 2] as const;

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
}

async function live(args: Args): Promise<void> {
  const endpoint = args.values.get('endpoint');
  const model = args.values.get('model');
  const digest = args.values.get('digest');
  const out = args.values.get('out');
  if (endpoint === undefined || model === undefined || digest === undefined || out === undefined) {
    throw new Error('--live needs --endpoint, --model, --digest and --out');
  }
  const from = Number(args.values.get('from') ?? '0');
  const budgetMs = Number(args.values.get('budget-ms') ?? '540000');
  const timeoutMs = Number(args.values.get('timeout-ms') ?? '300000');
  // Imported here, not at the top: replay mode (CI) must not need the adapter.
  const { createLocalModelAdapter } = await import('../packages/advisors/local-model/src/index.ts');
  // The adapter's own log line for the call just made: shape, sizes, token
  // counts and durations only (it never logs content). Read for timings.
  let last: Record<string, unknown>;
  const logger = {
    info: (obj: Record<string, unknown>) => {
      last = obj;
    },
    warn: (obj: Record<string, unknown>) => {
      last = obj;
    },
  };
  const adapter = createLocalModelAdapter(
    { endpoint, name: model, digest, timeoutMs, allowRemote: false },
    // The narrator's own reply format — what the composition root passes too.
    { logger, format: NARRATOR_REPLY_FORMAT },
  );
  console.log(`prompt template hash (template + format + sampling): ${adapter.promptTemplateHash}`);

  const { cases, today } = await evalCases();
  const specs = planRequests(cases, GROUP_SIZES);
  const started = Date.now();
  console.log(
    `live: ${String(cases.length)} cases, ${String(specs.length)} requests; starting at ${String(from)}; budget ${String(budgetMs)} ms`,
  );
  for (let index = from; index < specs.length; index += 1) {
    if (Date.now() - started > budgetMs) {
      console.log(`budget reached; resume with --from ${String(index)}`);
      return;
    }
    const spec = specs[index] as EvalRequestSpec;
    const request = evalRequest(spec, today);
    const t0 = Date.now();
    let body: unknown = null;
    let error: string | null = null;
    last = {};
    try {
      body = await adapter.run(request, new AbortController().signal);
    } catch (caught) {
      const code = (caught as { code?: unknown } | null)?.code;
      error = typeof code === 'string' ? code : 'error';
    }
    const wallMs = Date.now() - t0;
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
    };
    appendFileSync(out, `${JSON.stringify(line)}\n`);
    // Shape only: which step each narration reached. Never the text.
    console.log(
      `[${String(index)}/${String(specs.length)}] findings ${String(spec.findings.length)} · ${String(wallMs)} ms · ` +
        `prompt ${String(line.promptBytes ?? '?')} B / ${String(line.promptEvalCount ?? '?')} tok · eval ${String(line.evalCount ?? '?')} tok · ` +
        judged.verdicts
          .map((verdict) =>
            verdict.failure === null ? 'ok' : `${verdict.failure}:${verdict.reason ?? ''}`,
          )
          .join(' | '),
    );
  }
  console.log('live: all requests done');
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

const args = parseArgs(process.argv.slice(2));
if (args.flags.has('live')) await live(args);
else if (args.values.has('finalise')) await finalise(args);
else await replay();
