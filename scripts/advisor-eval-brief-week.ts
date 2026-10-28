// SPDX-License-Identifier: MIT
/**
 * `--brief-week` (WP 11.4): the 5-item Brief measurement WP 9.5 §2c made
 * (`--brief`), now **with the composed narration**: the five drift-seed
 * findings narrated one request each through the worker's own narrator
 * composition (`createNarratorWiring`, as `--brief`), then the Brief's own
 * composition (`brief.narrate`) through the shipped brief-narrate adapter,
 * judged by the production validator (`validateBriefNarrateReply`). One call
 * for the composition, first attempt only, no retry.
 *
 * The composition is built as the worker builds it with the production
 * default `NARRATION_TEXT_SHOWN=false`: each item's wording is the built-in
 * summary (an item narration the holder cannot read is never relayed). The
 * week's figures are a fixed overview (week, counts, a score line, last
 * week's counts). Prints counts, verdicts and durations — never a prompt or a
 * reply; the replies go to `--out` only (synthetic seed data).
 *
 * Exported as a function so CI runs it over the Ollama fake
 * (`advisor-eval-brief-week.test.ts`); the live run is the orchestrator's:
 *
 *     node --experimental-strip-types scripts/advisor-eval.ts --brief-week [--cold] \
 *       --endpoint http://ollama:11434 --model <name> --digest sha256:<64 hex> --out <dir>/brief-week.jsonl
 */
import { appendFileSync } from 'node:fs';
import {
  createLocalBriefNarrateAdapter,
  type LocalModelTransport,
} from '../packages/advisors/local-model/src/index.ts';
import {
  judgeReply,
  evalRequest,
  planRequests,
} from '../packages/contexts/insights/src/advisors/local/eval.ts';
import { createNarratorAdvisor } from '../packages/contexts/insights/src/advisors/local/narrator.ts';
import { NARRATOR_MANIFEST } from '../packages/contexts/insights/src/advisors/local/manifest.ts';
import { BRIEF_NARRATE_MANIFEST } from '../packages/contexts/insights/src/advisors/brief-narrate/manifest.ts';
import {
  briefNarrateTargetOf,
  buildBriefNarrateRequest,
  type BriefNarrateSubject,
} from '../packages/contexts/insights/src/advisors/brief-narrate/request.ts';
import { validateBriefNarrateReply } from '../packages/contexts/insights/src/advisors/brief-narrate/reply.ts';
import { NARRATOR_SCOPES } from '../packages/contexts/insights/src/advisors/local/manifest.ts';
import { resolveLimits } from '../packages/contexts/insights/src/contract/manifest.ts';
import type { AdvisorRequest } from '../packages/contexts/insights/src/contract/request.ts';
import { evalCases } from './advisor-eval.fixtures.ts';

/** The Brief measurement's five findings: the case types, as `--brief` picks them. */
export const BRIEF_CASE_TYPES = [
  'subscription.price_increase',
  'cash.yield_spread',
  'debt.minimum_only',
  'spending.category_creep',
  'investing.concentration',
] as const;

export interface BriefWeekOptions {
  readonly endpoint: string;
  readonly model: string;
  readonly digest: string;
  /** The adapter's chat timeout (LOCAL_MODEL_TIMEOUT_MS), 180 s by default. */
  readonly timeoutMs?: number;
  /** Tests only: the fake Ollama's transport. */
  readonly transport?: LocalModelTransport;
  /** Append one JSON line per request here (replies included: synthetic seed data). */
  readonly out?: string;
  /** Tests only: told before each phase, the composition's subject included. */
  readonly onPhase?: (phase: 'items' | 'compose', subject: BriefNarrateSubject | null) => void;
  readonly log?: (line: string) => void;
}

export interface BriefWeekReport {
  readonly items: readonly {
    readonly caseId: string;
    readonly wallMs: number;
    readonly error: string | null;
    readonly accepted: boolean;
  }[];
  readonly composition: {
    readonly wallMs: number;
    readonly error: string | null;
    readonly accepted: boolean;
    readonly refusal: string | null;
    readonly field: string | null;
    readonly titlesSent: readonly string[];
  };
  readonly totalMs: number;
  readonly deadlineMs: number;
}

/** `$1,234.56` → minor units as a string; `null` for anything else. */
function minorOf(display: string | null): string | null {
  if (display === null) return null;
  const match = /^-?\$([0-9,]+)\.([0-9]{2})$/u.exec(display.trim());
  if (match === null) return null;
  return `${(match[1] ?? '').replaceAll(',', '')}${match[2] ?? ''}`.replace(/^0+(?=\d)/u, '');
}

export async function briefWeek(options: BriefWeekOptions): Promise<BriefWeekReport> {
  const log = options.log ?? (() => undefined);
  const timeoutMs = options.timeoutMs ?? 180_000;
  const config = {
    endpoint: options.endpoint,
    name: options.model,
    digest: options.digest,
    timeoutMs,
    allowRemote: false,
  };
  const deps = options.transport === undefined ? {} : { transport: options.transport };
  const { createNarratorWiring } = await import('../apps/api/src/narrator-wiring.ts');
  const wiring = createNarratorWiring(config, deps);
  if (wiring === undefined) throw new Error('no model configured');
  const narrator = createNarratorAdvisor({ model: wiring.narratorModel });
  const deadlineMs = resolveLimits(NARRATOR_MANIFEST).timeoutMs;

  const { cases, today } = await evalCases();
  const picked = BRIEF_CASE_TYPES.map((type) => {
    const found = cases.find((entry) => entry.finding.type === type && entry.seed === 'drift');
    if (found === undefined) throw new Error(`the drift seed has no ${type} finding`);
    return found;
  });
  const started = Date.now();

  // --- 1. the five item narrations, one request each (what the Brief enqueues) ---
  options.onPhase?.('items', null);
  const items: BriefWeekReport['items'][number][] = [];
  for (const [index, spec] of planRequests(picked, [1]).entries()) {
    const request = evalRequest(spec, today);
    const timed: AdvisorRequest = {
      ...request,
      limits: { ...request.limits, deadline: new Date(Date.now() + deadlineMs).toISOString() },
    };
    const t0 = Date.now();
    let error: string | null = null;
    let accepted = false;
    try {
      const body = await narrator.run(timed, new AbortController().signal);
      accepted = judgeReply(spec, request, body).verdicts.every(
        (verdict) => verdict.failure === null,
      );
    } catch (caught) {
      const code = (caught as { code?: unknown } | null)?.code;
      error = typeof code === 'string' ? code : 'error';
    }
    const wallMs = Date.now() - t0;
    items.push({ caseId: spec.caseIds[0] ?? '', wallMs, error, accepted });
    if (options.out !== undefined) {
      appendFileSync(
        options.out,
        `${JSON.stringify({ mode: 'brief-week', phase: 'item', index, caseId: spec.caseIds[0], wallMs, error, accepted })}\n`,
      );
    }
    log(
      `[item ${String(index + 1)}/5] ${String(wallMs)} ms · ${error ?? (accepted ? 'accepted' : 'refused')}`,
    );
  }

  // --- 2. the Brief's own composition, one call ---------------------------------
  const ranked = picked
    .map((entry) => {
      const annual = minorOf(entry.finding.impact.annualized);
      const once = minorOf(entry.finding.impact.one_time);
      return {
        title: entry.finding.title,
        summaryMd: entry.finding.summary_md,
        narrationText: null,
        annualizedImpact: annual === null ? null : { minor: annual, currency: 'USD' },
        oneTimeImpact: annual === null && once !== null ? { minor: once, currency: 'USD' } : null,
        carried: false,
        evidence: [],
        scopes: ['cash.summary'],
        order: BigInt(annual ?? once ?? '0'),
      };
    })
    .sort((left, right) => (right.order > left.order ? 1 : right.order < left.order ? -1 : 0));
  const target = briefNarrateTargetOf({
    briefId: 'eval',
    isoWeek: '2026-W43',
    week: {
      week: '2026-W43',
      rankedCount: String(ranked.length),
      attentionCount: '0',
      healthScore: '72.5 / 100',
      milestones: [],
    },
    ranked,
    lastWeek: { accepted: 1, dismissed: 1, carried: 0 },
    allowedScopes: [...NARRATOR_SCOPES],
    foreignTitles: cases
      .filter((entry) => entry.seed === 'drift' && !picked.includes(entry))
      .map((entry) => entry.finding.title),
  });
  const built = buildBriefNarrateRequest({
    target,
    now: new Date(),
    timeoutMs: BRIEF_NARRATE_MANIFEST.limits.timeout_ms,
    maxResponseBytes: BRIEF_NARRATE_MANIFEST.limits.max_response_bytes,
  });
  options.onPhase?.('compose', built.request.subject);
  const adapter = createLocalBriefNarrateAdapter(config, deps);
  const t0 = Date.now();
  let composition: BriefWeekReport['composition'];
  try {
    const reply = await adapter.run(built.request, new AbortController().signal);
    const verdict = validateBriefNarrateReply(reply.reply, built.check);
    composition = {
      wallMs: Date.now() - t0,
      error: null,
      accepted: verdict.ok,
      refusal: verdict.ok ? null : verdict.refusal,
      field: verdict.ok ? null : verdict.field,
      titlesSent: built.check.chosenTitles,
    };
    if (options.out !== undefined) {
      appendFileSync(
        options.out,
        `${JSON.stringify({ mode: 'brief-week', phase: 'composition', ...composition, reply: reply.reply })}\n`,
      );
    }
  } catch (caught) {
    const code = (caught as { code?: unknown } | null)?.code;
    composition = {
      wallMs: Date.now() - t0,
      error: typeof code === 'string' ? code : 'error',
      accepted: false,
      refusal: null,
      field: null,
      titlesSent: built.check.chosenTitles,
    };
  }
  log(
    `[composition] ${String(composition.wallMs)} ms · ` +
      `${composition.error ?? (composition.accepted ? 'accepted' : `refused (${String(composition.refusal)}, ${String(composition.field)})`)}`,
  );
  return { items, composition, totalMs: Date.now() - started, deadlineMs };
}
