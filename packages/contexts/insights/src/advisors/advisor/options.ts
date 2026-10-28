// SPDX-License-Identifier: MIT
/**
 * `advisor.options` (WP 11.5d; 12 §2.3 step 3): the request and the validator.
 *
 * Sent: the context object (the clarified question, the answers, the results'
 * figures with their refs, the knowledge sent) and the bounds. Nothing else.
 *
 * The reply is exactly `{ options: [{ label, backed_by, summary }] }`, two to
 * four of them. **Every option must be backed**: `backed_by` lists figure
 * refs, and only a ref the context object carries resolves (`r1:…`,
 * `context.ts`). An option none of whose refs resolves is **dropped before
 * anything is shown**, and a reply left with fewer than two options is refused
 * (`options.unbacked`). The surviving options' labels and summaries are then
 * held to the context: every figure as the results wrote it, a citation only
 * of what was sent, the copy linter (`options.label.*`, `options.summary.*`).
 *
 * Refusal classes: `options.schema`, `options.count`, `options.unbacked`,
 * `options.label.<prose>`, `options.summary.<prose>`.
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
import type { AdvisorPayload, AdvisorWireRequest } from './clarify.ts';
import {
  ADVISOR_MAX_OPTIONS,
  ADVISOR_MAX_REFS,
  ADVISOR_MIN_OPTIONS,
  ADVISOR_OPTION_LABEL_MAX,
  ADVISOR_PROSE_MAX,
  ADVISOR_PROSE_MAX_SENTENCES,
} from './manifest.ts';

export interface OptionsSubject {
  readonly context: AdvisorContextObject;
  readonly min_options: number;
  readonly max_options: number;
}

export interface BuiltContextStepRequest<Key extends string, Subject> {
  readonly request: AdvisorWireRequest<Subject>;
  readonly payload: AdvisorPayload<Key, Subject>;
  readonly digest: string;
}

export function buildOptionsRequest(input: {
  readonly context: AdvisorContextObject;
  readonly grantedScopes: readonly string[];
  readonly now: Date;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}): BuiltContextStepRequest<'advisor_options', OptionsSubject> {
  const subject: OptionsSubject = {
    context: input.context,
    min_options: ADVISOR_MIN_OPTIONS,
    max_options: ADVISOR_MAX_OPTIONS,
  };
  const payload = {
    snapshot: { advisor_options: subject },
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

export interface AdvisorOption {
  /** `o1`…`o4`: the app's id, in the surviving order. */
  readonly id: string;
  readonly label: string;
  readonly summary: string;
  /** The refs that resolved, with the figures they resolved to. */
  readonly backed_by: readonly AdvisorContextFigure[];
}

export type OptionsRefusal =
  | 'options.schema'
  | 'options.count'
  | 'options.unbacked'
  | `options.label.${ProseRefusal}`
  | `options.summary.${ProseRefusal}`;

export type OptionsValidation =
  | {
      readonly ok: true;
      readonly options: readonly AdvisorOption[];
      /** How many options were dropped for want of a backing figure. */
      readonly dropped: number;
      readonly record: KnowledgeReadRecord | null;
    }
  | { readonly ok: false; readonly refusal: OptionsRefusal; readonly detail: string };

function refused(refusal: OptionsRefusal, detail: string): OptionsValidation {
  return { ok: false, refusal, detail };
}

/** The refs of `wanted` that the context carries, deduplicated, in order. */
export function resolveRefs(
  wanted: readonly string[],
  refs: ReadonlyMap<string, AdvisorContextFigure>,
): readonly AdvisorContextFigure[] {
  const out: AdvisorContextFigure[] = [];
  for (const ref of wanted) {
    const figure = refs.get(ref.trim());
    if (figure !== undefined && !out.includes(figure)) out.push(figure);
  }
  return out;
}

/** Pure and total over arbitrary JSON. */
export function validateOptionsReply(
  reply: unknown,
  check: AdvisorContextCheck,
): OptionsValidation {
  if (!isRecord(reply) || !exactKeys(reply, ['options']) || !Array.isArray(reply['options'])) {
    return refused('options.schema', 'the reply is not exactly { options: [...] }');
  }
  const raw = reply['options'] as unknown[];
  for (const entry of raw) {
    if (
      !isRecord(entry) ||
      !exactKeys(entry, ['label', 'backed_by', 'summary']) ||
      typeof entry['label'] !== 'string' ||
      typeof entry['summary'] !== 'string' ||
      !isStringArray(entry['backed_by']) ||
      (entry['backed_by'] as readonly string[]).length > ADVISOR_MAX_REFS
    ) {
      return refused(
        'options.schema',
        'an option is not exactly { label, backed_by: string[], summary }',
      );
    }
  }
  if (raw.length < ADVISOR_MIN_OPTIONS || raw.length > ADVISOR_MAX_OPTIONS) {
    return refused(
      'options.count',
      `${String(raw.length)} options; between ${String(ADVISOR_MIN_OPTIONS)} and ${String(ADVISOR_MAX_OPTIONS)}`,
    );
  }
  // An option with no backing result figure is dropped before narration.
  const backed = (raw as Record<string, unknown>[])
    .map((entry) => ({
      label: (entry['label'] as string).trim(),
      summary: (entry['summary'] as string).trim(),
      backing: resolveRefs(entry['backed_by'] as readonly string[], check.refs),
    }))
    .filter((entry) => entry.backing.length > 0);
  const dropped = raw.length - backed.length;
  if (backed.length < ADVISOR_MIN_OPTIONS) {
    return refused(
      'options.unbacked',
      `${String(backed.length)} option(s) backed by a result figure; at least ${String(ADVISOR_MIN_OPTIONS)}`,
    );
  }
  let record: KnowledgeReadRecord | null = null;
  const options: AdvisorOption[] = [];
  for (const [index, entry] of backed.entries()) {
    const label = checkAdvisorProse(entry.label, {
      max: ADVISOR_OPTION_LABEL_MAX,
      maxSentences: 1,
      field: 'title',
      trace: check.trace,
      sent: check.sent,
      knowledge: check.knowledge,
    });
    if (!label.ok) return refused(`options.label.${label.refusal}`, label.detail);
    const summary = checkAdvisorProse(entry.summary, {
      max: ADVISOR_PROSE_MAX,
      maxSentences: ADVISOR_PROSE_MAX_SENTENCES,
      field: 'summary_md',
      trace: check.trace,
      sent: check.sent,
      knowledge: check.knowledge,
    });
    if (!summary.ok) return refused(`options.summary.${summary.refusal}`, summary.detail);
    record = mergeRecords(record, summary.record);
    options.push({
      id: `o${String(index + 1)}`,
      label: entry.label,
      summary: entry.summary,
      backed_by: entry.backing,
    });
  }
  return { ok: true, options, dropped, record };
}

/** The union of what two sentences cited (the pages and parameters sent are the same). */
export function mergeRecords(
  left: KnowledgeReadRecord | null,
  right: KnowledgeReadRecord | null,
): KnowledgeReadRecord | null {
  if (left === null) return right;
  if (right === null) return left;
  return {
    ...left,
    cited: {
      pages: [...new Set([...left.cited.pages, ...right.cited.pages])].sort(),
      params: [...new Set([...left.cited.params, ...right.cited.params])].sort(),
    },
  };
}
