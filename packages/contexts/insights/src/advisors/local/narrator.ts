// SPDX-License-Identifier: MIT
/**
 * `createNarratorAdvisor` — `local.narrator` as an `Advisor`, over whatever
 * produces its replies.
 *
 * `@ctx/insights` does not import `@advisor/local-model` (the boundary rule;
 * the layer's own comment, "no LLM client", stays true). The factory takes the
 * model as a port shaped like `Advisor['run']`, and the composition root binds
 * WP 5.2's adapter to it:
 *
 * ```ts
 * createNarratorAdvisor({ model: localModel })   // localModel = createLocalModelAdapter(...)
 * ```
 *
 * The adapter already writes the reply's envelope from the request (so a model
 * cannot forge `request_id` or `advisor_id`), and what it returns is `unknown`
 * to the platform: it goes through `validateResponse` like any other advisor's
 * output, with the narrator's checks (`validate/pipeline.ts`'s header). This
 * factory adds exactly one thing: **a request with no findings never reaches
 * the model** — there is nothing to narrate, so it answers an empty,
 * well-formed response itself rather than spend a model call on a prompt whose
 * every possible reply the validator would refuse. The service short-circuits
 * the same case earlier; this is the second line, for any other caller.
 *
 * **WP 9.5 option A(a): the narration's identity is the app's, not the
 * model's.** A narration's `key`, `type` and `period` are written here from
 * the request, the way the adapter already writes `request_id` and
 * `advisor_id`, so a model cannot forge them and has nothing to copy. The
 * Phase 5 gate's re-judgement found 26 of 38 refusals were the pinned model
 * failing to echo an opaque key (17 invented keys, 9 prose in the `key`
 * field); none was a misattributed figure. The reply format no longer asks
 * for them (`format.ts`). The rule, per reply item:
 *
 *   * a request carrying **one finding** (every production request since
 *     C5-2, `FINDINGS_PER_NARRATION_REQUEST`): the item is that finding's
 *     narration, whatever key it wrote;
 *   * a request carrying several: the item names its finding by number,
 *     `finding: n` (1-based, the envelope's order), and an `n` outside the
 *     envelope leaves the item with **no** identity, so it is refused at step 2;
 *   * a request carrying several and an item with no number (a reply in the
 *     pre-9.5 shape — no production path sends such a request): the item is
 *     passed as written and the validator's 1:1 key/type/period match decides,
 *     fail-closed, exactly as before.
 *
 * Every other field is passed through untouched for the validator to judge:
 * a model that claims `deterministic`, an impact, an action or a higher
 * severity is still refused at step 4 by name, never silently corrected.
 *
 * No retry lives here or anywhere on the run path. One call, one reply, one
 * verdict (05 §3 WP 5.3): re-asking until the validator agrees would launder
 * the first-attempt rate the ≥95% criterion measures.
 */
import type { AdvisorRequest, NarratedFinding } from '../../contract/request.ts';
import type { Advisor } from '../../registry.ts';
import { NARRATOR_MANIFEST } from './manifest.ts';

/** WP 5.2's `LocalModelAdapter` satisfies this structurally; so does a recorded-reply fake. */
export interface NarratorModelPort {
  run(request: AdvisorRequest, signal: AbortSignal): Promise<unknown>;
}

export interface NarratorOptions {
  readonly model: NarratorModelPort;
}

export function createNarratorAdvisor(options: NarratorOptions): Advisor {
  return Object.freeze({
    manifest: NARRATOR_MANIFEST,
    async run(request: AdvisorRequest, signal: AbortSignal): Promise<unknown> {
      if (request.findings === undefined || request.findings.length === 0) {
        return {
          contract_version: request.contract_version,
          request_id: request.request_id,
          advisor_id: request.advisor_id,
          advisor_version: request.advisor_version,
          produced_at: request.generated_at,
          diagnostics: { runtime_ms: 0, model: null, warnings: ['no findings to narrate'] },
          insights: [],
        };
      }
      return withIdentityFromRequest(
        await options.model.run(request, signal),
        request.findings ?? [],
      );
    },
  });
}

/**
 * Option A(a), pure: each reply item's `key`, `type` and `period` from the
 * finding it narrates (see the header for the rule). Anything that is not a
 * reply object with an `insights` array is returned untouched — the validator
 * refuses it at step 1 or 2, by name.
 */
export function withIdentityFromRequest(
  reply: unknown,
  findings: readonly NarratedFinding[],
): unknown {
  if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) return reply;
  const record = reply as Record<string, unknown>;
  const items = record['insights'];
  if (!Array.isArray(items)) return reply;
  const only = findings.length === 1 ? findings[0] : undefined;
  return {
    ...record,
    insights: items.map((item: unknown) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
      const { finding: number, ...rest } = item as Record<string, unknown>;
      let finding: NarratedFinding | undefined = only;
      if (only === undefined) {
        if (number === undefined) return rest; // the pre-9.5 shape: the 1:1 check decides
        finding =
          typeof number === 'number' && Number.isInteger(number) && number >= 1
            ? findings[number - 1]
            : undefined;
        // A number naming no finding in the envelope: no identity at all, so
        // step 2 refuses it rather than this guessing.
        if (finding === undefined) return { ...rest, key: null, type: null, period: null };
      }
      return { ...rest, key: finding?.key, type: finding?.type, period: finding?.period };
    }),
  };
}
