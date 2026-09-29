// SPDX-License-Identifier: MIT
/**
 * Why a local-model run did not produce a reply, as a closed list a caller
 * can switch on and a run row can store. The message carries the code and a
 * structural detail (a status, a byte count, a digest) — **never** a prompt,
 * a reply, a snapshot byte or Ollama's own error text, because an error
 * message is the most likely thing in this package to end up in a log line
 * somebody else writes.
 */
export const LOCAL_MODEL_ERROR_CODES = [
  /** The served model's digest is not `LOCAL_MODEL_DIGEST`, or the model is not served. No prompt was sent. */
  'model_digest_mismatch',
  /** The rendered prompt would not fit `num_ctx`; Ollama would silently drop its front — the system region. */
  'prompt_too_large',
  /** The reply passed the byte cap while it arrived and the socket was closed. */
  'model_reply_too_large',
  /** The deadline — ours, never the model's — passed. */
  'model_timeout',
  /** The caller's signal fired: a kill at some level. The socket was closed. */
  'aborted',
  /** The endpoint could not be reached, resolved, or answered with a server error. */
  'model_unavailable',
  /** The endpoint policy refused the destination (a public or non-local address, a redirect). */
  'endpoint_refused',
  /** Ollama answered, but not with the stream shape it documents. */
  'model_protocol_error',
] as const;
export type LocalModelErrorCode = (typeof LOCAL_MODEL_ERROR_CODES)[number];

export class LocalModelError extends Error {
  readonly code: LocalModelErrorCode;
  constructor(code: LocalModelErrorCode, detail: string, options?: { cause?: unknown }) {
    super(`local model (${code}): ${detail}`, options);
    this.name = 'LocalModelError';
    this.code = code;
  }
}

export function isLocalModelError(error: unknown): error is LocalModelError {
  return error instanceof LocalModelError;
}
