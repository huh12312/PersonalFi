// SPDX-License-Identifier: MIT
/**
 * Ports this context declares for the run path (WP 5.1). The snapshot's read
 * ports live in `snapshot/ports.ts`; these are about what a run *sends*.
 *
 * ## `PromptRenderer` — declared here, implemented by WP 5.2
 *
 * A `local_model` advisor's request becomes prompt bytes somewhere, and that
 * somewhere is `@advisor/local-model` (WP 5.2) — a package this context may
 * not import (the `insights` layer gains nothing, 05 §4 item 2: the layer's
 * comment "no LLM client" stays true). So the context owns the *interface*
 * and the composition root binds the adapter's implementation to it.
 *
 * Two callers need it, and neither may invoke a model:
 *
 *   * **The preview gate** (`preview.ts`). A query shape includes the prompt
 *     template's hash, so an edited template is a new shape that needs a new
 *     approval; and `previewRequest` shows the holder the exact prompt bytes
 *     a run would send.
 *   * **The run** (`service.ts`), which records the rendered prompt's hash and
 *     the pinned model on `advisor_runs` before the call.
 *
 * `render` must be **pure and deterministic**: no I/O, no clock, no model,
 * byte-identical output for an identical request. That is what lets the run
 * inspector re-render a retained request and get the prompt that was sent, and
 * what lets a preview promise "this is exactly what it will see".
 */
import type { AdvisorRequest } from './contract/request.ts';

export interface RenderedPrompt {
  /** The exact bytes the model receives, as UTF-8 text. */
  readonly text: string;
  /** `sha256:<64 hex>` of `text`'s UTF-8 bytes. Stored as `advisor_runs.llm_prompt_hash`. */
  readonly hash: string;
}

export interface PromptRenderer {
  /**
   * `sha256:<64 hex>` of the template — system prompt, instructions, output
   * schema, delimiters — not of any rendered prompt. Part of the query shape.
   */
  readonly templateHash: string;
  /**
   * The model a rendered prompt is sent to, pinned: `name@sha256:<digest>`
   * (`LOCAL_MODEL_NAME` and `LOCAL_MODEL_DIGEST`). Stored as
   * `advisor_runs.llm_model`.
   */
  readonly model: string;
  /**
   * WP 10.6: the provider the model is served by — `ollama` for the local
   * model, else `openai` / `openrouter` / `anthropic`. Recorded on the payload
   * approval with `model`, so an approval says what it was given for.
   * Optional: a renderer from before WP 10.6 records none.
   */
  readonly provider?: string;
  /** Render the prompt for this request. Pure; invokes nothing. */
  render(request: AdvisorRequest): RenderedPrompt;
}
