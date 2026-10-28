// SPDX-License-Identifier: MIT
/**
 * `--ask` (WP 11.5c; 12 §5's "Compilation" row): does the question map to the
 * right catalogue calls? The golden set (`advisor-eval-ask.golden.json`) holds
 * each question, the outcome a correct compiler reaches — calls with their
 * arguments, an unanswerable verdict with its screen, or the deterministic
 * pre-check's verdict — and a recorded compile reply.
 *
 * Each entry goes through the production pieces in production order: the
 * pre-check (`precheckQuestion`), then — for a question it passes — the
 * compile request over the full catalogue description and the reply through
 * the production validator (`validateAskCompileReply`). The compiler is a
 * pure function of the reply, so replaying recorded replies measures exactly
 * what a run would have done with them (CI's run, over the Ollama fake, in
 * `advisor-eval-ask.test.ts`).
 *
 * Reported: precision and recall **per catalogue function** (a compiled call
 * counts only when its name and its arguments, after the function's own
 * defaults, equal an expected call), micro totals, the share of entries whose
 * whole outcome was right (by kind), the unanswerable verdicts' screens, and
 * the validator's refusal classes. Never a prompt or a reply on stdout; the
 * live run's replies go to `--out` (the golden questions are synthetic).
 *
 *     node scripts/advisor-eval.ts --ask                     # replay the recorded replies
 *     node scripts/advisor-eval.ts --ask --live \
 *       --endpoint http://ollama:11434 --model <name> --digest sha256:<64 hex> --out <dir>/ask.jsonl
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../packages/platform/src/index.ts';
import {
  createLocalAskCompileAdapter,
  type LocalModelTransport,
} from '../packages/advisors/local-model/src/index.ts';
import {
  CATALOGUE,
  CATALOGUE_FUNCTION_NAMES,
  catalogueDescription,
  type CatalogueFunctionName,
} from '../packages/contexts/insights/src/catalogue/catalogue.ts';
import {
  askCompileSubjectOf,
  buildAskCompileRequest,
  validateAskCompileReply,
  type AskCompileValidation,
  type AskCompileWireRequest,
} from '../packages/contexts/insights/src/advisors/ask/compile.ts';
import { ASK_COMPILE_MANIFEST } from '../packages/contexts/insights/src/advisors/ask/manifest.ts';
import {
  precheckQuestion,
  type AskPrecheck,
} from '../packages/contexts/insights/src/advisors/ask/precheck.ts';

export const ASK_GOLDEN_PATH = join(import.meta.dirname, 'advisor-eval-ask.golden.json');

export interface AskGoldenCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export type AskGoldenExpected =
  | { readonly calls: readonly AskGoldenCall[] }
  | { readonly unanswerable: { readonly reason: string; readonly nearest_screen: string } }
  | { readonly precheck: 'out_of_scope'; readonly topic: string; readonly nearest_screen: string }
  | { readonly precheck: 'refused'; readonly refusal: string }
  | { readonly refused: string };

export interface AskGoldenEntry {
  readonly id: string;
  readonly kind: 'calls' | 'not_computable' | 'out_of_scope' | 'injection';
  readonly question: string;
  readonly expected: AskGoldenExpected;
  /** The recorded compile reply; absent when the pre-check answers without a model. */
  readonly reply?: unknown;
  readonly note?: string;
}

export interface AskGolden {
  readonly format: 'personalfi.ask-golden/1';
  readonly today: string;
  readonly catalogue_version: string;
  readonly replies_source: string;
  readonly entries: readonly AskGoldenEntry[];
}

export function loadAskGolden(path = ASK_GOLDEN_PATH): AskGolden {
  return JSON.parse(readFileSync(path, 'utf8')) as AskGolden;
}

/** The compile request a golden question is sent: the full catalogue, every function granted. */
export function askGoldenRequest(golden: Pick<AskGolden, 'today'>, question: string) {
  const described = catalogueDescription();
  return buildAskCompileRequest({
    subject: askCompileSubjectOf({
      question,
      today: golden.today,
      listing: {
        catalogue_version: described.catalogue_version,
        $defs: described.$defs,
        functions: described.functions,
      },
    }),
    now: new Date(`${golden.today}T12:00:00.000Z`),
    timeoutMs: ASK_COMPILE_MANIFEST.limits.timeout_ms,
    maxResponseBytes: ASK_COMPILE_MANIFEST.limits.max_response_bytes,
  });
}

/** A call keyed by name and its arguments after the function's own defaults. */
function keyOf(call: AskGoldenCall): string {
  const definition = Object.hasOwn(CATALOGUE, call.name)
    ? CATALOGUE[call.name as CatalogueFunctionName]
    : null;
  const parsed = definition?.args.safeParse(call.args);
  return canonicalJson({
    name: call.name,
    args: parsed?.success === true ? parsed.data : call.args,
  });
}

export interface AskJudged {
  readonly id: string;
  readonly kind: AskGoldenEntry['kind'];
  readonly precheck: AskPrecheck['kind'];
  readonly verdict: AskCompileValidation | null;
  readonly expectedCalls: readonly AskGoldenCall[];
  readonly compiledCalls: readonly AskGoldenCall[];
  /** The whole outcome was the expected one. */
  readonly correct: boolean;
  /** For an expected unanswerable verdict: the screen named was the expected one. */
  readonly screenCorrect: boolean | null;
}

/** Judge one entry against a reply (the recorded one, or a live model's). Pure. */
export function judgeAskEntry(
  golden: Pick<AskGolden, 'today'>,
  entry: AskGoldenEntry,
  reply: unknown,
): AskJudged {
  const pre = precheckQuestion(entry.question);
  const expected = entry.expected;
  const expectedCalls = 'calls' in expected ? expected.calls : [];
  const base = { id: entry.id, kind: entry.kind, precheck: pre.kind, expectedCalls } as const;
  if (pre.kind !== 'ok') {
    const correct =
      'precheck' in expected &&
      (pre.kind === 'out_of_scope'
        ? expected.precheck === 'out_of_scope' && expected.topic === pre.topic
        : expected.precheck === 'refused' && expected.refusal === pre.refusal);
    return { ...base, verdict: null, compiledCalls: [], correct, screenCorrect: null };
  }
  const built = askGoldenRequest(golden, entry.question);
  const verdict = validateAskCompileReply(reply, built.check);
  const compiledCalls: AskGoldenCall[] =
    verdict.ok && verdict.kind === 'calls'
      ? verdict.calls.map((call) => ({ name: call.name, args: call.args }))
      : [];
  let correct = false;
  let screenCorrect: boolean | null = null;
  if ('calls' in expected) {
    const want = new Set(expected.calls.map(keyOf));
    const got = new Set(compiledCalls.map(keyOf));
    correct = verdict.ok && want.size === got.size && [...want].every((key) => got.has(key));
  } else if ('unanswerable' in expected) {
    correct =
      verdict.ok &&
      verdict.kind === 'unanswerable' &&
      verdict.reason === expected.unanswerable.reason;
    screenCorrect =
      verdict.ok && verdict.kind === 'unanswerable'
        ? verdict.nearestScreen === expected.unanswerable.nearest_screen
        : false;
  } else if ('refused' in expected) {
    correct = !verdict.ok && verdict.refusal === expected.refused;
  }
  return { ...base, verdict, compiledCalls, correct, screenCorrect };
}

export interface AskFunctionScore {
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  /** `null` when nothing was compiled to it (no denominator). */
  readonly precision: number | null;
  readonly recall: number | null;
}

export interface AskEvalReport {
  readonly entries: number;
  readonly byKind: Readonly<Record<string, { readonly correct: number; readonly total: number }>>;
  readonly correct: number;
  readonly perFunction: Readonly<Record<string, AskFunctionScore>>;
  readonly micro: AskFunctionScore;
  /** Unanswerable verdicts expected: how many named the expected screen. */
  readonly screens: { readonly correct: number; readonly total: number };
  /** The validator's refusals over the replies, by class. */
  readonly refusals: Readonly<Record<string, number>>;
  /** Questions the pre-check answered without a model. */
  readonly answeredWithoutModel: number;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Math.round((numerator / denominator) * 10_000) / 10_000;
}

export function summariseAsk(judged: readonly AskJudged[]): AskEvalReport {
  const counts = new Map<string, { tp: number; fp: number; fn: number }>(
    CATALOGUE_FUNCTION_NAMES.map((name) => [name, { tp: 0, fp: 0, fn: 0 }]),
  );
  const byKind: Record<string, { correct: number; total: number }> = {};
  const refusals: Record<string, number> = {};
  let screensCorrect = 0;
  let screensTotal = 0;
  for (const entry of judged) {
    const kind = (byKind[entry.kind] ??= { correct: 0, total: 0 });
    kind.total += 1;
    if (entry.correct) kind.correct += 1;
    if (entry.screenCorrect !== null) {
      screensTotal += 1;
      if (entry.screenCorrect) screensCorrect += 1;
    }
    if (entry.verdict !== null && !entry.verdict.ok) {
      refusals[entry.verdict.refusal] = (refusals[entry.verdict.refusal] ?? 0) + 1;
    }
    if (entry.precheck !== 'ok') continue;
    const want = new Map(entry.expectedCalls.map((call) => [keyOf(call), call.name]));
    const got = new Map(entry.compiledCalls.map((call) => [keyOf(call), call.name]));
    for (const [key, name] of got) {
      const row = counts.get(name);
      if (row === undefined) continue;
      if (want.has(key)) row.tp += 1;
      else row.fp += 1;
    }
    for (const [key, name] of want) {
      if (!got.has(key)) {
        const row = counts.get(name);
        if (row !== undefined) row.fn += 1;
      }
    }
  }
  const perFunction: Record<string, AskFunctionScore> = {};
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const [name, row] of counts) {
    perFunction[name] = {
      ...row,
      precision: ratio(row.tp, row.tp + row.fp),
      recall: ratio(row.tp, row.tp + row.fn),
    };
    tp += row.tp;
    fp += row.fp;
    fn += row.fn;
  }
  return {
    entries: judged.length,
    byKind,
    correct: judged.filter((entry) => entry.correct).length,
    perFunction,
    micro: { tp, fp, fn, precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn) },
    screens: { correct: screensCorrect, total: screensTotal },
    refusals: Object.fromEntries(Object.entries(refusals).sort()),
    answeredWithoutModel: judged.filter((entry) => entry.precheck !== 'ok').length,
  };
}

/** Replay: every entry against its recorded reply. Pure; what CI and the default CLI run. */
export function replayAskGolden(golden: AskGolden = loadAskGolden()): {
  readonly judged: readonly AskJudged[];
  readonly report: AskEvalReport;
} {
  const judged = golden.entries.map((entry) => judgeAskEntry(golden, entry, entry.reply ?? null));
  return { judged, report: summariseAsk(judged) };
}

export interface AskEvalModelOptions {
  readonly endpoint: string;
  readonly model: string;
  readonly digest: string;
  readonly timeoutMs: number;
  /** Tests only: the fake Ollama's transport. */
  readonly transport?: LocalModelTransport;
  /** Each reply is appended here, one JSON line per entry (`{ id, reply }`), when set. */
  readonly out?: string;
}

/**
 * Through the shipped compile adapter: one call per entry the pre-check
 * passes, first attempt only. CI points it at the Ollama fake answering the
 * recorded replies, which proves the adapter and the replay agree; the live
 * run points it at the pinned model.
 */
export async function askGoldenOverModel(
  options: AskEvalModelOptions,
  golden: AskGolden = loadAskGolden(),
): Promise<{
  readonly judged: readonly AskJudged[];
  readonly report: AskEvalReport;
  readonly calls: number;
}> {
  const adapter = createLocalAskCompileAdapter(
    {
      endpoint: options.endpoint,
      name: options.model,
      digest: options.digest,
      timeoutMs: options.timeoutMs,
      allowRemote: true,
    },
    options.transport === undefined ? {} : { transport: options.transport },
  );
  const judged: AskJudged[] = [];
  let calls = 0;
  for (const entry of golden.entries) {
    if (precheckQuestion(entry.question).kind !== 'ok') {
      judged.push(judgeAskEntry(golden, entry, null));
      continue;
    }
    const request: AskCompileWireRequest = {
      ...askGoldenRequest(golden, entry.question).request,
      deadline: new Date(Date.now() + options.timeoutMs + 60_000).toISOString(),
    };
    let reply: unknown;
    try {
      calls += 1;
      reply = (await adapter.run(request, new AbortController().signal)).reply;
    } catch {
      reply = null;
    }
    if (options.out !== undefined)
      appendFileSync(options.out, `${JSON.stringify({ id: entry.id, reply })}\n`);
    judged.push(judgeAskEntry(golden, entry, reply));
  }
  return { judged, report: summariseAsk(judged), calls };
}

const pct = (value: number | null) => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`);

/** The report as lines: counts and rates only, never a question's reply. */
export function formatAskReport(report: AskEvalReport): readonly string[] {
  const lines = [
    `entries ${String(report.entries)} · outcome right ${String(report.correct)}/${String(report.entries)} · answered by the pre-check without a model ${String(report.answeredWithoutModel)}`,
    ...Object.entries(report.byKind).map(
      ([kind, row]) => `  ${kind}: ${String(row.correct)}/${String(row.total)}`,
    ),
    `calls (micro): precision ${pct(report.micro.precision)} · recall ${pct(report.micro.recall)} · tp ${String(report.micro.tp)} fp ${String(report.micro.fp)} fn ${String(report.micro.fn)}`,
    `unanswerable screens named right: ${String(report.screens.correct)}/${String(report.screens.total)}`,
    'per function: precision / recall (tp fp fn)',
    ...Object.entries(report.perFunction).map(
      ([name, row]) =>
        `  ${name.padEnd(26)} ${pct(row.precision).padStart(6)} / ${pct(row.recall).padStart(6)}  (${String(row.tp)} ${String(row.fp)} ${String(row.fn)})`,
    ),
    `validator refusals: ${
      Object.entries(report.refusals)
        .map(([refusal, count]) => `${refusal} × ${String(count)}`)
        .join(', ') || 'none'
    }`,
  ];
  return lines;
}
