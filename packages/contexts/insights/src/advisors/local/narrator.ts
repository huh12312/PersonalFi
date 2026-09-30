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
 * No retry lives here or anywhere on the run path. One call, one reply, one
 * verdict (05 §3 WP 5.3): re-asking until the validator agrees would launder
 * the first-attempt rate the ≥95% criterion measures.
 */
import type { AdvisorRequest } from '../../contract/request.ts';
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
      return options.model.run(request, signal);
    },
  });
}
