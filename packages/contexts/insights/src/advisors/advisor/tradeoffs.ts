// SPDX-License-Identifier: MIT
/**
 * `advisor.tradeoffs` (WP 11.5d; 12 §2.3 step 4): the request and the
 * validator — **07 §7.2's "always pair a recommendation with its cost",
 * enforced**.
 *
 * Sent: the context object and the surviving options (id, label, summary, the
 * figures backing each). The reply is exactly `{ tradeoffs: [{ option,
 * benefit, cost, note }] }`, one entry per option, each option once:
 *
 *   * `tradeoffs.schema`, `tradeoffs.coverage` (an option missing, repeated or
 *     unknown);
 *   * **`tradeoffs.cost_missing`** — an option with no cost at all. This is the
 *     rule: there is no option without a cost, so a reply that offers one is
 *     refused whole, never shown with the gap;
 *   * `tradeoffs.benefit_missing` — an option with no benefit;
 *   * `tradeoffs.ref_unresolved` — a benefit or cost that cites a figure the
 *     context object does not carry (a figure the model made up has no ref);
 *   * `tradeoffs.note.<prose>` — the note held to the context: every figure as
 *     the results wrote it, citations of what was sent, the copy linter.
 */
import { newId } from '@core/kernel';
import type { KnowledgeReadRecord } from '../../knowledge/citations.ts';
import { canonicalRunDigest } from '../../preview.ts';
import {
  checkAdvisorProse,
  exactKeys,
  isRecord,
  isStringArray,
  type AdvisorContextCheck,
  type AdvisorContextFigure,
  type AdvisorContextObject,
  type ProseRefusal,
} from './context.ts';
import { ADVISOR_MAX_REFS, ADVISOR_PROSE_MAX, ADVISOR_PROSE_MAX_SENTENCES } from './manifest.ts';
import { mergeRecords, type AdvisorOption, type BuiltContextStepRequest } from './options.ts';

export interface TradeoffsSubject {
  readonly context: AdvisorContextObject;
  readonly options: readonly {
    readonly id: string;
    readonly label: string;
    readonly summary: string;
    readonly backed_by: readonly AdvisorContextFigure[];
  }[];
}

export function buildTradeoffsRequest(input: {
  readonly context: AdvisorContextObject;
  readonly options: readonly AdvisorOption[];
  readonly grantedScopes: readonly string[];
  readonly now: Date;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}): BuiltContextStepRequest<'advisor_tradeoffs', TradeoffsSubject> {
  const subject: TradeoffsSubject = {
    context: input.context,
    options: input.options.map((option) => ({
      id: option.id,
      label: option.label,
      summary: option.summary,
      backed_by: option.backed_by.map((figure) => ({ ...figure })),
    })),
  };
  const payload = {
    snapshot: { advisor_tradeoffs: subject },
    granted_scopes: [...input.grantedScopes],
  };
  return {
    request: {
      request_id: newId(),
      subject,
      deadline: new Date(input.now.getTime() + input.timeoutMs).toISOString(),
      max_response_bytes: input.maxResponseBytes,
    },
    payload,
    digest: canonicalRunDigest(payload),
  };
}

export interface AdvisorTradeoff {
  readonly option: string;
  readonly benefit: readonly AdvisorContextFigure[];
  readonly cost: readonly AdvisorContextFigure[];
  readonly note: string;
}

export type TradeoffsRefusal =
  | 'tradeoffs.schema'
  | 'tradeoffs.coverage'
  | 'tradeoffs.cost_missing'
  | 'tradeoffs.benefit_missing'
  | 'tradeoffs.ref_unresolved'
  | `tradeoffs.note.${ProseRefusal}`;

export type TradeoffsValidation =
  | {
      readonly ok: true;
      readonly tradeoffs: readonly AdvisorTradeoff[];
      readonly record: KnowledgeReadRecord | null;
    }
  | { readonly ok: false; readonly refusal: TradeoffsRefusal; readonly detail: string };

function refused(refusal: TradeoffsRefusal, detail: string): TradeoffsValidation {
  return { ok: false, refusal, detail };
}

/** Every ref resolved, or the first that does not. */
function resolveAll(
  refs: readonly string[],
  known: ReadonlyMap<string, AdvisorContextFigure>,
): { readonly figures: readonly AdvisorContextFigure[] } | { readonly unresolved: string } {
  const figures: AdvisorContextFigure[] = [];
  for (const raw of refs) {
    const figure = known.get(raw.trim());
    if (figure === undefined) return { unresolved: raw.slice(0, 64) };
    if (!figures.includes(figure)) figures.push(figure);
  }
  return { figures };
}

/** Pure and total over arbitrary JSON. */
export function validateTradeoffsReply(
  reply: unknown,
  check: AdvisorContextCheck & { readonly options: readonly string[] },
): TradeoffsValidation {
  if (!isRecord(reply) || !exactKeys(reply, ['tradeoffs']) || !Array.isArray(reply['tradeoffs'])) {
    return refused('tradeoffs.schema', 'the reply is not exactly { tradeoffs: [...] }');
  }
  const raw = reply['tradeoffs'] as unknown[];
  for (const entry of raw) {
    if (
      !isRecord(entry) ||
      !exactKeys(entry, ['option', 'benefit', 'cost', 'note']) ||
      typeof entry['option'] !== 'string' ||
      typeof entry['note'] !== 'string' ||
      !isStringArray(entry['benefit']) ||
      !isStringArray(entry['cost']) ||
      (entry['benefit'] as readonly string[]).length > ADVISOR_MAX_REFS ||
      (entry['cost'] as readonly string[]).length > ADVISOR_MAX_REFS
    ) {
      return refused(
        'tradeoffs.schema',
        'an entry is not exactly { option, benefit: string[], cost: string[], note }',
      );
    }
  }
  const entries = raw as Record<string, unknown>[];
  const ids = entries.map((entry) => (entry['option'] as string).trim());
  const wanted = new Set(check.options);
  if (
    ids.length !== check.options.length ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !wanted.has(id))
  ) {
    return refused('tradeoffs.coverage', 'not exactly one entry for each option');
  }
  const tradeoffs: AdvisorTradeoff[] = [];
  let record: KnowledgeReadRecord | null = null;
  for (const entry of entries) {
    const option = (entry['option'] as string).trim();
    const cost = entry['cost'] as readonly string[];
    const benefit = entry['benefit'] as readonly string[];
    // The rule: every option is paired with its cost.
    if (cost.length === 0) return refused('tradeoffs.cost_missing', `option ${option} has no cost`);
    if (benefit.length === 0) {
      return refused('tradeoffs.benefit_missing', `option ${option} has no benefit`);
    }
    const costs = resolveAll(cost, check.refs);
    if ('unresolved' in costs) {
      return refused(
        'tradeoffs.ref_unresolved',
        `option ${option}'s cost cites ${costs.unresolved}, which is not in the context`,
      );
    }
    const benefits = resolveAll(benefit, check.refs);
    if ('unresolved' in benefits) {
      return refused(
        'tradeoffs.ref_unresolved',
        `option ${option}'s benefit cites ${benefits.unresolved}, which is not in the context`,
      );
    }
    const note = checkAdvisorProse(entry['note'] as string, {
      max: ADVISOR_PROSE_MAX,
      maxSentences: ADVISOR_PROSE_MAX_SENTENCES,
      field: 'summary_md',
      trace: check.trace,
      sent: check.sent,
      knowledge: check.knowledge,
    });
    if (!note.ok) return refused(`tradeoffs.note.${note.refusal}`, note.detail);
    record = mergeRecords(record, note.record);
    tradeoffs.push({
      option,
      benefit: benefits.figures,
      cost: costs.figures,
      note: (entry['note'] as string).trim(),
    });
  }
  // In the options' own order.
  const order = new Map(check.options.map((id, index) => [id, index]));
  tradeoffs.sort((left, right) => (order.get(left.option) ?? 0) - (order.get(right.option) ?? 0));
  return { ok: true, tradeoffs, record };
}
