// SPDX-License-Identifier: MIT
/**
 * `@advisor/local-model` — the Ollama adapter for the `local_model` advisor
 * kind (05-phase-5-dispatch.md §3 WP 5.2 part 2).
 *
 * A package per model runtime, the `@connector/*` shape. Its layer
 * (`scripts/eslint-boundaries.js`, `advisor-local-model`) allows
 * `@core/kernel`, `@core/platform` and `@core/contracts` and **no node
 * builtin**; `eslint.config.js` bans the `fetch` and `WebSocket` globals here;
 * `test/structure.test.ts` is the third line. The only network path is
 * `@core/platform`'s local-endpoint transport.
 *
 * What the composition root uses:
 *
 *   * `createLocalModelAdapter(config.localModel, { logger, clock })` — in
 *     `apps/api/src/worker.ts`, only when `config.localModel` is defined
 *     (W-C). Its `run(request, signal)` is the `Advisor.run` WP 5.3's narrator
 *     wraps with its manifest.
 *   * `renderPrompt` — the `PromptRenderer` port WP 5.1 declares, for the
 *     payload preview: the exact bytes, without invoking anything.
 *   * `PROMPT_TEMPLATE_HASH` — for WP 5.1's query shape.
 */
export const PACKAGE_NAME = '@advisor/local-model';

export {
  createLocalModelAdapter,
  type LocalModelAdapter,
  type LocalModelAdapterConfig,
  type LocalModelAdapterDeps,
  type LocalModelLogger,
  type LocalModelResponse,
  MIN_WARM_UP_MS,
  type WarmUpOutcome,
} from './adapter.ts';
export {
  LocalModelError,
  isLocalModelError,
  LOCAL_MODEL_ERROR_CODES,
  type LocalModelErrorCode,
} from './errors.ts';
export { NARRATION_FORMAT } from './format.ts';
export {
  createOllamaClient,
  DEFAULT_GENERATION_OPTIONS,
  normaliseDigest,
  type ChatRequest,
  type ChatResult,
  type GenerationOptions,
  type LocalModelTransport,
  type OllamaClient,
  type PinnedModel,
  type WarmUpRequest,
} from './ollama-client.ts';
export {
  escapeForBlock,
  FENCE_CLOSE,
  FENCE_OPEN,
  PROMPT_TEMPLATE_HASH,
  PROMPT_TEMPLATE_VERSION,
  placedView,
  renderPrompt,
  SYSTEM_PROMPT,
  USER_TRAILER,
  WARM_UP_MESSAGES,
  WARM_UP_USER,
  type PromptMessage,
  type RenderedPrompt,
} from './prompt.ts';
export type { LocalModelRequest } from './request.ts';
export {
  CODE_POINT_CLASSES,
  CONFUSABLES,
  confusableSkeleton,
  countFlags,
  FLAG_ONLY_KINDS,
  INJECTION_PATTERNS,
  SANITISER_FLAG_KINDS,
  sanitiseString,
  sanitiseTree,
  type SanitiserFlag,
  type SanitiserFlagKind,
} from './sanitise.ts';
export { capFor, DEFAULT_STRING_CAP, FREE_TEXT_CAPS, RECORD_KEY_CAP } from './caps.ts';
