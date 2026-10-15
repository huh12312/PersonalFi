// SPDX-License-Identifier: MIT
/**
 * The one place a model's reply becomes an `AdvisorResponse` (WP 10.6).
 *
 * Extracted from `adapter.ts` so the local model and every hosted provider
 * (`hosted.ts`) wrap a reply with **the same function**: the envelope is
 * written from the request (`contract_version`, `request_id`, `advisor_id`,
 * `advisor_version`), only the model's `insights` is taken from its reply, and
 * everything else is a warning. What comes out is `unknown` to the platform
 * and goes through `@ctx/insights`' `validateResponse` — the reply format, the
 * 1:1 narration match, the numerals check — exactly as before, whoever wrote
 * the reply. There is no hosted branch in the validator because there is no
 * hosted branch here.
 */
import { FLAG_ONLY_KINDS, type SanitiserFlag } from './sanitise.ts';
import type { LocalModelRequest } from './request.ts';

/** The `AdvisorResponse` v1 shape every adapter in this package builds. Returned as `unknown`. */
export interface NarratorReplyResponse {
  readonly contract_version: number;
  readonly request_id: string;
  readonly advisor_id: string;
  readonly advisor_version: string;
  readonly produced_at: string;
  readonly diagnostics: {
    readonly runtime_ms: number;
    readonly model: string;
    readonly warnings: readonly string[];
  };
  readonly insights: unknown;
}

/** `AdvisorResponse.diagnostics.warnings`: at most 16, each at most 240 characters. */
const MAX_WARNINGS = 16;
const MAX_WARNING_CHARS = 240;
/** `AdvisorResponse.diagnostics.model`: at most 96 characters. */
export const MAX_DIAGNOSTICS_MODEL_CHARS = 96;

/**
 * Take `insights` from a reply's text, and nothing else. A reply that is not
 * JSON, or not an object, gives `insights: null` and a warning — the validator
 * then refuses it at step 1, by name.
 */
export function insightsFromReply(content: string): {
  readonly insights: unknown;
  readonly warnings: readonly string[];
  readonly isJson: boolean;
} {
  const warnings: string[] = [];
  let insights: unknown = null;
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      insights = record['insights'] ?? null;
      const extra = Object.keys(record).filter((key) => key !== 'insights').length;
      if (extra > 0) {
        warnings.push(
          `model reply carried ${String(extra)} top-level field(s) besides insights; ignored`,
        );
      }
    } else {
      warnings.push('model reply was JSON but not an object');
    }
  } catch {
    warnings.push('model reply was not JSON');
    return { insights, warnings, isJson: false };
  }
  return { insights, warnings, isJson: true };
}

/** Build the response. The envelope is the request's; `insights` is the reply's. */
export function narratorResponse(input: {
  readonly request: LocalModelRequest;
  readonly insights: unknown;
  readonly warnings: readonly string[];
  readonly runtimeMs: number;
  readonly model: string;
  readonly producedAt: string;
}): NarratorReplyResponse {
  return {
    contract_version: input.request.contract_version,
    request_id: input.request.request_id,
    advisor_id: input.request.advisor_id,
    advisor_version: input.request.advisor_version,
    produced_at: input.producedAt,
    diagnostics: {
      runtime_ms: Math.max(0, input.runtimeMs),
      model: input.model.slice(0, MAX_DIAGNOSTICS_MODEL_CHARS),
      warnings: capWarnings(input.warnings),
    },
    insights: input.insights,
  };
}

export function sanitiserWarnings(flags: readonly SanitiserFlag[]): string[] {
  return flags.map(
    (flag) =>
      `sanitiser ${FLAG_ONLY_KINDS.has(flag.kind) ? 'flagged' : 'removed'} ${flag.kind} x${String(flag.count)} at ${flag.path}`,
  );
}

export function capWarnings(warnings: readonly string[]): string[] {
  const clipped = warnings.map((warning) =>
    warning.length > MAX_WARNING_CHARS ? `${warning.slice(0, MAX_WARNING_CHARS - 1)}…` : warning,
  );
  if (clipped.length <= MAX_WARNINGS) return clipped;
  const kept = clipped.slice(0, MAX_WARNINGS - 1);
  kept.push(`… and ${String(clipped.length - kept.length)} more warning(s)`);
  return kept;
}

/** Scope names and top-level snapshot keys: the contract's vocabulary, never its contents. */
export function requestShape(request: LocalModelRequest): Record<string, unknown> {
  return {
    kind: request.kind,
    contract_version: request.contract_version,
    granted_scopes: [...request.granted_scopes].sort(),
    snapshot_blocks: Object.keys(request.snapshot).sort(),
    findings: Array.isArray(request.findings)
      ? request.findings.length
      : request.findings === undefined
        ? 0
        : 1,
  };
}
