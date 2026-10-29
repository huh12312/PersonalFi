// SPDX-License-Identifier: MIT
/**
 * `--advisor` (WP 11.5d; 12 §5's rows applied to advisor mode): does a
 * session reach the outcome a correct protocol reaches — the right catalogue
 * calls, the right number of backed options, the right refusal when a step
 * steps outside its box — and what does the rubric judge score?
 *
 * The golden set (`advisor-eval-advisor.golden.json`) holds at least twenty
 * sessions (12 §3's three worked examples among them): the opening question,
 * the holder's answers, the expected outcome, and a recorded reply per model
 * step (clarify, gather, options, trade-offs, the judge, the plan). Each
 * session goes through the production pieces in production order: the
 * pre-check; the clarify request over the full listing's summaries and the
 * fixture's defaults (a goal by ref, the plan's retirement age) and its
 * validator; the answers' pre-check; the gather step (11.5c's compile request
 * and validator); the calls run **in process over 11.5b's catalogue fixture**
 * (synthetic, no holder data); the real knowledge base (every page a draft);
 * the context object; the options, trade-offs, judge and plan validators.
 * Every step is a pure function of its reply, so replaying recorded replies
 * measures exactly what a run would have done with them (CI's run, through
 * the shipped adapters over the Ollama fake, in `advisor-eval-advisor.test.ts`).
 *
 * Reported: outcomes right by kind, calls precision/recall (micro), option
 * counts right, the validators' refusal classes, and the judge's scores.
 *
 * WP 11.5e adds **pre-gathered sessions** (`kind: 'pregathered'`, one per rule
 * family): a session opened from a finding by "Talk this through". Its
 * question is the family's template over the finding's title and rule (the
 * entry's `question` must equal it); clarify is sent the finding as a quoted
 * fact; the gather step's compiler still runs, but the rule's **seeded calls
 * are always run first** (`expected.seeded`, asserted present and leading),
 * and the finding's own evidence figures join the context object as result
 * r1, each with the `source_ref` it resolved through.
 * Never a prompt or a reply on stdout; a live run's replies go to `--out`.
 *
 *     node scripts/advisor-eval.ts --advisor                    # replay the recorded replies
 *     node scripts/advisor-eval.ts --advisor --live \
 *       --endpoint http://ollama:11434 --model <name> --digest sha256:<64 hex> --out <dir>/advisor.jsonl
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../packages/platform/src/index.ts';
import {
  createLocalAdvisorAdapter,
  createLocalAskCompileAdapter,
  type AdvisorModelStep,
  type LocalModelTransport,
} from '../packages/advisors/local-model/src/index.ts';
import {
  CATALOGUE,
  catalogueDescription,
  type CatalogueFunctionName,
} from '../packages/contexts/insights/src/catalogue/catalogue.ts';
import {
  askCompileSubjectOf,
  buildAskCompileRequest,
  validateAskCompileReply,
} from '../packages/contexts/insights/src/advisors/ask/compile.ts';
import { precheckQuestion } from '../packages/contexts/insights/src/advisors/ask/precheck.ts';
import {
  askResultViewOf,
  type AskResultView,
} from '../packages/contexts/insights/src/advisors/ask/results.ts';
import {
  buildClarifyRequest,
  validateClarifyReply,
} from '../packages/contexts/insights/src/advisors/advisor/clarify.ts';
import { buildAdvisorContext } from '../packages/contexts/insights/src/advisors/advisor/context.ts';
import {
  advisorGatherQuestion,
  advisorKnowledgeFor,
  gatherRefusalOf,
} from '../packages/contexts/insights/src/advisors/advisor/gather.ts';
import {
  buildJudgeRequest,
  validateJudgeReply,
} from '../packages/contexts/insights/src/advisors/advisor/judge.ts';
import { ADVISOR_STEP_MANIFESTS } from '../packages/contexts/insights/src/advisors/advisor/manifest.ts';
import {
  buildOptionsRequest,
  validateOptionsReply,
} from '../packages/contexts/insights/src/advisors/advisor/options.ts';
import {
  buildPlanRequest,
  validatePlanReply,
} from '../packages/contexts/insights/src/advisors/advisor/plan.ts';
import { advisorRubricFor } from '../packages/contexts/insights/src/advisors/advisor/topics.ts';
import {
  findingEvidenceFigures,
  findingResultOf,
  mergeSeededCalls,
  seededCallsFor,
  talkThroughQuestion,
  talkThroughRuleById,
} from '../packages/contexts/insights/src/advisors/advisor/origin.ts';
import {
  buildTradeoffsRequest,
  validateTradeoffsReply,
} from '../packages/contexts/insights/src/advisors/advisor/tradeoffs.ts';
import { ASK_FUNCTION_PAGES } from '../packages/contexts/insights/src/advisors/ask/screens.ts';
import { knowledgeCatalogueOf } from '../packages/contexts/insights/src/knowledge/citations.ts';
import { createAdvisorKnowledgeBase } from '../apps/api/src/knowledge-base.ts';
import {
  call,
  fixtureSnapshot,
} from '../packages/contexts/insights/test/fixtures/catalogue-context.ts';

export const ADVISOR_GOLDEN_PATH = join(import.meta.dirname, 'advisor-eval-advisor.golden.json');

export type AdvisorGoldenStep = 'clarify' | 'gather' | 'options' | 'tradeoffs' | 'judge' | 'plan';

export interface AdvisorGoldenCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export interface AdvisorGoldenExpected {
  readonly outcome: 'tracked' | 'refused' | 'unanswerable' | 'precheck';
  readonly refusal?: string;
  readonly precheck?: 'out_of_scope' | 'refused';
  readonly topic?: string;
  readonly reason?: string;
  readonly calls?: readonly AdvisorGoldenCall[];
  readonly options?: number;
  /** A judge refusal the session is expected to carry as evidence (it never stops the session). */
  readonly judge?: string;
  /** WP 11.5e: a pre-gathered session's seeded calls — each must be run, ahead of the compiler's. */
  readonly seeded?: readonly AdvisorGoldenCall[];
}

/** WP 11.5e: the finding a pre-gathered session is opened from (synthetic, over 11.5b's fixture). */
export interface AdvisorGoldenOrigin {
  readonly rule_id: string;
  readonly title: string;
  readonly key: string;
  readonly evidence: readonly {
    readonly label: string;
    readonly value: string | null;
    readonly source_ref: string | null;
    readonly resolved_display: string | null;
  }[];
}

export interface AdvisorGoldenEntry {
  readonly id: string;
  readonly kind:
    'session' | 'out_of_scope' | 'injection' | 'refusal' | 'not_computable' | 'pregathered';
  readonly question: string;
  readonly answers: readonly string[];
  readonly expected: AdvisorGoldenExpected;
  readonly pick: string;
  readonly replies: Partial<Record<AdvisorGoldenStep, unknown>>;
  readonly example?: string;
  readonly note?: string;
  readonly origin?: AdvisorGoldenOrigin;
}

export interface AdvisorGolden {
  readonly format: 'personalfi.advisor-golden/1';
  readonly today: string;
  readonly catalogue_version: string;
  readonly replies_source: string;
  readonly entries: readonly AdvisorGoldenEntry[];
}

export function loadAdvisorGolden(path = ADVISOR_GOLDEN_PATH): AdvisorGolden {
  return JSON.parse(readFileSync(path, 'utf8')) as AdvisorGolden;
}

/** One step's request, as the model is sent it. */
export interface AdvisorGoldenRequest {
  readonly request_id: string;
  readonly subject: unknown;
  readonly deadline: string;
  readonly max_response_bytes: number;
}

/** Whatever answers a step: the recorded reply, or a model. */
export type AdvisorAsk = (
  entry: AdvisorGoldenEntry,
  step: AdvisorGoldenStep,
  request: AdvisorGoldenRequest,
) => Promise<unknown>;

export interface AdvisorJudged {
  readonly id: string;
  readonly kind: AdvisorGoldenEntry['kind'];
  readonly outcome: AdvisorGoldenExpected['outcome'];
  readonly refusal: string | null;
  readonly compiledCalls: readonly AdvisorGoldenCall[];
  readonly expectedCalls: readonly AdvisorGoldenCall[];
  readonly options: number | null;
  readonly dropped: number;
  readonly judgeScore: string | null;
  readonly judgeRefusal: string | null;
  readonly modelCalls: number;
  readonly correct: boolean;
  readonly optionsCorrect: boolean | null;
  /** WP 11.5e: every call the gather step ran (seeded first), and whether the seeded ones led. */
  readonly ranCalls: readonly AdvisorGoldenCall[];
  readonly seededCorrect: boolean | null;
}

function keyOf(callIn: AdvisorGoldenCall): string {
  const definition = Object.hasOwn(CATALOGUE, callIn.name)
    ? CATALOGUE[callIn.name as CatalogueFunctionName]
    : null;
  const parsed = definition?.args.safeParse(callIn.args);
  return canonicalJson({
    name: callIn.name,
    args: parsed?.success === true ? parsed.data : callIn.args,
  });
}

function listing() {
  const described = catalogueDescription();
  return {
    catalogue_version: described.catalogue_version,
    $defs: described.$defs,
    functions: described.functions,
  };
}

/** One session, end to end, through the production validators. */
export async function judgeAdvisorEntry(
  golden: Pick<AdvisorGolden, 'today'>,
  entry: AdvisorGoldenEntry,
  ask: AdvisorAsk,
): Promise<AdvisorJudged> {
  const now = new Date(`${golden.today}T12:00:00.000Z`);
  const limits = (step: keyof typeof ADVISOR_STEP_MANIFESTS) => ({
    now,
    timeoutMs: ADVISOR_STEP_MANIFESTS[step].limits.timeout_ms,
    maxResponseBytes: ADVISOR_STEP_MANIFESTS[step].limits.max_response_bytes,
  });
  const expectedCalls = entry.expected.calls ?? [];
  let modelCalls = 0;
  const result = (
    fields: Partial<AdvisorJudged> & Pick<AdvisorJudged, 'outcome'>,
  ): AdvisorJudged => {
    const judged: AdvisorJudged = {
      id: entry.id,
      kind: entry.kind,
      refusal: null,
      compiledCalls: [],
      expectedCalls,
      options: null,
      dropped: 0,
      judgeScore: null,
      judgeRefusal: null,
      modelCalls,
      correct: false,
      optionsCorrect: null,
      ranCalls: [],
      seededCorrect: null,
      ...fields,
    };
    const e = entry.expected;
    const callsRight =
      e.calls === undefined ||
      (() => {
        const want = new Set(e.calls.map(keyOf));
        const got = new Set(judged.compiledCalls.map(keyOf));
        return want.size === got.size && [...want].every((key) => got.has(key));
      })();
    const optionsCorrect = e.options === undefined ? null : judged.options === e.options;
    // WP 11.5e: the seeded calls were run, and ahead of every compiled call.
    const seededCorrect =
      e.seeded === undefined
        ? null
        : e.seeded.length <= judged.ranCalls.length &&
          e.seeded.every(
            (seed, index) =>
              keyOf(seed) === keyOf(judged.ranCalls[index] ?? { name: '', args: {} }),
          );
    const correct =
      judged.outcome === e.outcome &&
      (e.refusal === undefined || judged.refusal === e.refusal) &&
      (e.outcome !== 'precheck' ||
        judged.refusal ===
          (e.precheck === 'out_of_scope'
            ? `out_of_scope:${e.topic ?? ''}`
            : (e.refusal ?? null))) &&
      callsRight &&
      optionsCorrect !== false &&
      seededCorrect !== false &&
      (e.judge === undefined || judged.judgeRefusal === e.judge);
    return { ...judged, correct, optionsCorrect, seededCorrect };
  };

  // --- WP 11.5e: a session opened from a finding --------------------------------------
  const origin = entry.origin ?? null;
  const rule = origin === null ? null : talkThroughRuleById(origin.rule_id);
  if (origin !== null && rule === null)
    return result({ outcome: 'refused', refusal: 'origin.not_supported' });
  const question =
    origin === null || rule === null
      ? entry.question
      : talkThroughQuestion({ family: rule.family, title: origin.title, ruleName: rule.ruleName });

  // --- the pre-check ---------------------------------------------------------------
  const pre = precheckQuestion(question);
  if (pre.kind === 'refused') return result({ outcome: 'precheck', refusal: pre.refusal });
  if (pre.kind === 'out_of_scope')
    return result({ outcome: 'precheck', refusal: `out_of_scope:${pre.topic}` });

  // --- clarify -----------------------------------------------------------------------
  const snapshot = fixtureSnapshot();
  const defaults = {
    retirementAge: snapshot.plan_projection?.ages.retirement ?? null,
    goals: (snapshot.goals_list?.goals ?? []).map((goal) => ({
      goal_ref: goal.goal_ref,
      name: goal.name,
    })),
  };
  const clarifyBuilt = buildClarifyRequest({
    question: pre.question,
    listing: listing().functions,
    defaults,
    grantedScopes: ['goals.list', 'plan.projection'],
    ...(origin === null || rule === null
      ? {}
      : { about: { title: origin.title, rule: { name: rule.ruleName, text: rule.ruleText } } }),
    ...limits('clarify'),
  });
  modelCalls += 1;
  const clarified = validateClarifyReply(
    await ask(entry, 'clarify', clarifyBuilt.request),
    clarifyBuilt.check,
  );
  if (!clarified.ok) return result({ outcome: 'refused', refusal: clarified.refusal });
  const answers: { question: string; answer: string }[] = [];
  for (const [index, question] of clarified.clarification.questions.entries()) {
    const answer = (entry.answers[index] ?? '').trim();
    const checked = answer.length === 0 ? null : precheckQuestion(answer);
    if (checked !== null && checked.kind === 'refused') {
      return result({
        outcome: 'refused',
        refusal: checked.refusal.replace(/^question\./u, 'answer.'),
      });
    }
    answers.push({ question, answer });
  }

  // --- gather --------------------------------------------------------------------------
  const text = advisorGatherQuestion({ restatement: clarified.clarification.restatement, answers });
  const gatherBuilt = buildAskCompileRequest({
    subject: askCompileSubjectOf({ question: text, today: golden.today, listing: listing() }),
    ...limits('gather'),
  });
  modelCalls += 1;
  const gathered = validateAskCompileReply(
    await ask(entry, 'gather', gatherBuilt.request),
    gatherBuilt.check,
  );
  if (!gathered.ok)
    return result({ outcome: 'refused', refusal: gatherRefusalOf(gathered.refusal) });
  // WP 11.5e: the seeded calls answer the finding whatever the compiler made of the words.
  const seeded =
    origin === null ? [] : seededCallsFor(origin.rule_id, { key: origin.key, currency: 'USD' });
  if (gathered.kind === 'unanswerable' && seeded.length === 0)
    return result({ outcome: 'unanswerable', refusal: gathered.reason });
  const compiledOnly = gathered.kind === 'unanswerable' ? [] : gathered.calls;
  const compiledCalls = compiledOnly.map((entryCall) => ({
    name: entryCall.name,
    args: entryCall.args,
  }));
  const merged = mergeSeededCalls(seeded, compiledOnly).calls;
  const ranCalls = merged.map((entryCall) => ({ name: entryCall.name, args: entryCall.args }));
  const results: AskResultView[] = [];
  if (origin !== null && rule !== null) {
    const evidence = origin.evidence.map((row) => ({
      label: row.label,
      value: row.value,
      sourceRef: row.source_ref,
      resolvedDisplay: row.resolved_display,
    }));
    const { figures, dropped } = findingEvidenceFigures({ evidence, prose: [origin.title] });
    if (figures.length > 0) {
      results.push(
        findingResultOf({
          insightId: '00000000-0000-7000-8000-000000000000',
          advisorId: '',
          key: origin.key,
          ruleId: origin.rule_id,
          family: rule.family,
          title: origin.title,
          ruleName: rule.ruleName,
          ruleText: rule.ruleText,
          severity: 'notable',
          scopes: [],
          figures,
          dropped,
          evidence,
          asOf: golden.today,
        }),
      );
    }
  }
  for (const compiled of merged) {
    results.push(
      askResultViewOf(compiled.name, compiled.args, await call(compiled.name, compiled.args)),
    );
  }
  if (!results.some((view) => view.status === 'ok')) {
    return result({ outcome: 'unanswerable', refusal: 'not_computable', compiledCalls, ranCalls });
  }
  const knowledge = createAdvisorKnowledgeBase();
  const sent = advisorKnowledgeFor(knowledge, { text, results });
  const built = buildAdvisorContext({
    restatement: clarified.clarification.restatement,
    answers,
    date: golden.today,
    results,
    knowledge: sent,
    knowledgeCatalogue: knowledgeCatalogueOf(knowledge),
  });

  // --- options, trade-offs, the judge --------------------------------------------------
  const optionsBuilt = buildOptionsRequest({
    context: built.context,
    grantedScopes: [],
    ...limits('options'),
  });
  modelCalls += 1;
  const options = validateOptionsReply(
    await ask(entry, 'options', optionsBuilt.request),
    built.check,
  );
  if (!options.ok)
    return result({ outcome: 'refused', refusal: options.refusal, compiledCalls, ranCalls });
  const tradeoffsBuilt = buildTradeoffsRequest({
    context: built.context,
    options: options.options,
    grantedScopes: [],
    ...limits('tradeoffs'),
  });
  modelCalls += 1;
  const trades = validateTradeoffsReply(await ask(entry, 'tradeoffs', tradeoffsBuilt.request), {
    ...built.check,
    options: options.options.map((option) => option.id),
  });
  const counted = {
    compiledCalls,
    ranCalls,
    options: options.options.length,
    dropped: options.dropped,
  };
  if (!trades.ok) return result({ outcome: 'refused', refusal: trades.refusal, ...counted });
  const rubric = advisorRubricFor([
    ...sent.topicPages,
    ...results.flatMap((view) => {
      const page = ASK_FUNCTION_PAGES[view.function];
      return page === undefined ? [] : [page];
    }),
  ]);
  const judgeBuilt = buildJudgeRequest({
    narration: [
      { part: 'restatement', text: clarified.clarification.restatement },
      ...options.options.map((option) => ({
        part: 'option',
        text: `${option.label}. ${option.summary}`,
      })),
      ...trades.tradeoffs.map((entryTrade) => ({ part: 'tradeoff', text: entryTrade.note })),
    ],
    rubric,
    ...limits('judge'),
  });
  modelCalls += 1;
  const judged = validateJudgeReply(await ask(entry, 'judge', judgeBuilt.request), rubric);
  const judge = judged.ok
    ? { judgeScore: judged.score.score, judgeRefusal: null }
    : { judgeScore: null, judgeRefusal: judged.refusal };

  // --- the pick, the plan ----------------------------------------------------------------
  const option =
    options.options.find((entryOption) => entryOption.id === entry.pick) ?? options.options[0];
  const tradeoff = trades.tradeoffs.find((entryTrade) => entryTrade.option === option?.id);
  if (option === undefined || tradeoff === undefined)
    return result({ outcome: 'refused', refusal: 'pick.unknown', ...counted, ...judge });
  const planBuilt = buildPlanRequest({
    context: built.context,
    option,
    tradeoff,
    grantedScopes: [],
    ...limits('plan'),
  });
  modelCalls += 1;
  const planned = validatePlanReply(await ask(entry, 'plan', planBuilt.request), built.check);
  if (!planned.ok)
    return result({ outcome: 'refused', refusal: planned.refusal, ...counted, ...judge });
  return result({ outcome: 'tracked', ...counted, ...judge });
}

export interface AdvisorEvalReport {
  readonly sessions: number;
  readonly correct: number;
  readonly byKind: Readonly<Record<string, { readonly correct: number; readonly total: number }>>;
  readonly outcomes: Readonly<Record<string, number>>;
  readonly calls: {
    readonly tp: number;
    readonly fp: number;
    readonly fn: number;
    readonly precision: number | null;
    readonly recall: number | null;
  };
  readonly options: { readonly correct: number; readonly total: number; readonly dropped: number };
  /** WP 11.5e: pre-gathered sessions whose seeded calls ran first. */
  readonly seeded: { readonly correct: number; readonly total: number };
  readonly refusals: Readonly<Record<string, number>>;
  readonly judge: {
    readonly scored: number;
    readonly mean: string | null;
    readonly distribution: Readonly<Record<string, number>>;
    readonly refused: Readonly<Record<string, number>>;
  };
  readonly modelCalls: number;
  readonly answeredWithoutModel: number;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Math.round((numerator / denominator) * 10_000) / 10_000;
}

export function summariseAdvisor(judged: readonly AdvisorJudged[]): AdvisorEvalReport {
  const byKind: Record<string, { correct: number; total: number }> = {};
  const outcomes: Record<string, number> = {};
  const refusals: Record<string, number> = {};
  const distribution: Record<string, number> = {};
  const judgeRefused: Record<string, number> = {};
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let optionsCorrect = 0;
  let optionsTotal = 0;
  let seededCorrect = 0;
  let seededTotal = 0;
  let dropped = 0;
  let thousandths = 0;
  let scored = 0;
  for (const entry of judged) {
    const kind = (byKind[entry.kind] ??= { correct: 0, total: 0 });
    kind.total += 1;
    if (entry.correct) kind.correct += 1;
    outcomes[entry.outcome] = (outcomes[entry.outcome] ?? 0) + 1;
    if (entry.outcome === 'refused' && entry.refusal !== null)
      refusals[entry.refusal] = (refusals[entry.refusal] ?? 0) + 1;
    if (entry.optionsCorrect !== null) {
      optionsTotal += 1;
      if (entry.optionsCorrect) optionsCorrect += 1;
    }
    dropped += entry.dropped;
    if (entry.seededCorrect !== null) {
      seededTotal += 1;
      if (entry.seededCorrect) seededCorrect += 1;
    }
    if (entry.judgeScore !== null) {
      scored += 1;
      distribution[entry.judgeScore] = (distribution[entry.judgeScore] ?? 0) + 1;
      thousandths += Math.round(Number(entry.judgeScore) * 1000);
    }
    if (entry.judgeRefusal !== null)
      judgeRefused[entry.judgeRefusal] = (judgeRefused[entry.judgeRefusal] ?? 0) + 1;
    if (entry.expectedCalls.length === 0 && entry.compiledCalls.length === 0) continue;
    const want = new Set(entry.expectedCalls.map(keyOf));
    const got = new Set(entry.compiledCalls.map(keyOf));
    for (const key of got)
      if (want.has(key)) tp += 1;
      else fp += 1;
    for (const key of want) if (!got.has(key)) fn += 1;
  }
  const mean = scored === 0 ? null : (Math.round(thousandths / scored) / 1000).toFixed(3);
  return {
    sessions: judged.length,
    correct: judged.filter((entry) => entry.correct).length,
    byKind,
    outcomes: Object.fromEntries(Object.entries(outcomes).sort()),
    calls: { tp, fp, fn, precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn) },
    options: { correct: optionsCorrect, total: optionsTotal, dropped },
    seeded: { correct: seededCorrect, total: seededTotal },
    refusals: Object.fromEntries(Object.entries(refusals).sort()),
    judge: {
      scored,
      mean,
      distribution: Object.fromEntries(Object.entries(distribution).sort()),
      refused: Object.fromEntries(Object.entries(judgeRefused).sort()),
    },
    modelCalls: judged.reduce((sum, entry) => sum + entry.modelCalls, 0),
    answeredWithoutModel: judged.filter((entry) => entry.modelCalls === 0).length,
  };
}

/** Replay: every session against its recorded replies. What CI and the default CLI run. */
export async function replayAdvisorGolden(golden: AdvisorGolden = loadAdvisorGolden()): Promise<{
  readonly judged: readonly AdvisorJudged[];
  readonly report: AdvisorEvalReport;
}> {
  const judged: AdvisorJudged[] = [];
  for (const entry of golden.entries) {
    judged.push(
      await judgeAdvisorEntry(golden, entry, (current, step) =>
        Promise.resolve(current.replies[step] ?? null),
      ),
    );
  }
  return { judged, report: summariseAdvisor(judged) };
}

export interface AdvisorEvalModelOptions {
  readonly endpoint: string;
  readonly model: string;
  readonly digest: string;
  readonly timeoutMs: number;
  /** Tests only: the fake Ollama's transport. */
  readonly transport?: LocalModelTransport;
  /** Tests only: called before each model call (the fake answers the recorded reply). */
  readonly beforeCall?: (entry: AdvisorGoldenEntry, step: AdvisorGoldenStep) => void;
  /** Each reply is appended here, one JSON line per call (`{ id, step, reply }`), when set. */
  readonly out?: string;
}

/**
 * Through the shipped adapters (the gather step is `ask.compile`'s): CI points
 * them at the Ollama fake answering the recorded replies, which proves the
 * adapters and the replay agree; the live run points them at the pinned model.
 */
export async function advisorGoldenOverModel(
  options: AdvisorEvalModelOptions,
  golden: AdvisorGolden = loadAdvisorGolden(),
): Promise<{
  readonly judged: readonly AdvisorJudged[];
  readonly report: AdvisorEvalReport;
  readonly calls: number;
}> {
  const config = {
    endpoint: options.endpoint,
    name: options.model,
    digest: options.digest,
    timeoutMs: options.timeoutMs,
    allowRemote: true,
  };
  const deps = options.transport === undefined ? {} : { transport: options.transport };
  const steps = new Map<AdvisorModelStep, ReturnType<typeof createLocalAdvisorAdapter>>(
    (['clarify', 'options', 'tradeoffs', 'plan', 'judge'] as const).map((step) => [
      step,
      createLocalAdvisorAdapter(step, config, deps),
    ]),
  );
  const gather = createLocalAskCompileAdapter(config, deps);
  let calls = 0;
  const ask: AdvisorAsk = async (entry, step, request) => {
    options.beforeCall?.(entry, step);
    const wire = {
      ...request,
      deadline: new Date(Date.now() + options.timeoutMs + 60_000).toISOString(),
    };
    let reply: unknown;
    try {
      calls += 1;
      const adapter = step === 'gather' ? gather : steps.get(step);
      if (adapter === undefined) throw new Error(step);
      reply = (await adapter.run(wire as never, new AbortController().signal)).reply;
    } catch {
      reply = null;
    }
    if (options.out !== undefined)
      appendFileSync(options.out, `${JSON.stringify({ id: entry.id, step, reply })}\n`);
    return reply;
  };
  const judged: AdvisorJudged[] = [];
  for (const entry of golden.entries) judged.push(await judgeAdvisorEntry(golden, entry, ask));
  return { judged, report: summariseAdvisor(judged), calls };
}

const pct = (value: number | null) => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`);

/** The report as lines: counts, rates and scores only, never a reply. */
export function formatAdvisorReport(report: AdvisorEvalReport): readonly string[] {
  return [
    `sessions ${String(report.sessions)} · outcome right ${String(report.correct)}/${String(report.sessions)} · answered by the pre-check without a model ${String(report.answeredWithoutModel)} · model calls ${String(report.modelCalls)}`,
    ...Object.entries(report.byKind).map(
      ([kind, row]) => `  ${kind}: ${String(row.correct)}/${String(row.total)}`,
    ),
    `outcomes: ${Object.entries(report.outcomes)
      .map(([outcome, count]) => `${outcome} ${String(count)}`)
      .join(', ')}`,
    `calls (micro): precision ${pct(report.calls.precision)} · recall ${pct(report.calls.recall)} · tp ${String(report.calls.tp)} fp ${String(report.calls.fp)} fn ${String(report.calls.fn)}`,
    `option counts right: ${String(report.options.correct)}/${String(report.options.total)} · options dropped for want of a backing figure: ${String(report.options.dropped)}`,
    `pre-gathered sessions with their seeded calls run first: ${String(report.seeded.correct)}/${String(report.seeded.total)}`,
    `validator refusals: ${
      Object.entries(report.refusals)
        .map(([refusal, count]) => `${refusal} × ${String(count)}`)
        .join(', ') || 'none'
    }`,
    `rubric judge: ${String(report.judge.scored)} scored · mean ${report.judge.mean ?? 'n/a'} · ${Object.entries(
      report.judge.distribution,
    )
      .map(([score, count]) => `${score} × ${String(count)}`)
      .join(', ')} · refused: ${
      Object.entries(report.judge.refused)
        .map(([refusal, count]) => `${refusal} × ${String(count)}`)
        .join(', ') || 'none'
    }`,
  ];
}
