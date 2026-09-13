// SPDX-License-Identifier: MIT

/**
 * Turn a failed WebAuthn ceremony into something a person can read.
 *
 * `NotAllowedError` is the one name worth branching on (05-frontend-
 * architecture.md §7.1): the browser reports a *cancelled or timed out*
 * ceremony that way, and it never means "wrong credential" — WebAuthn has no
 * such error, because the authenticator either produces a signature or does
 * not. Telling someone their passkey was rejected when they merely dismissed
 * the prompt sends them off to a recovery code they did not need.
 *
 * Everything else collapses to a single message deliberately. `SecurityError`,
 * `AbortError` and a transport failure are all "it did not work, try again" to
 * someone holding a phone, and naming the `DOMException` would leak detail in a
 * surface whose whole design refuses to say why authentication failed.
 */
export interface WebauthnErrorCopy {
  /** Shown when the prompt was dismissed or timed out. Must not imply failure. */
  readonly cancelled: string;
  /** Shown for everything else. Must not name the underlying error. */
  readonly failed: string;
}

export function describeWebauthnError(cause: unknown, copy: WebauthnErrorCopy): string {
  const cancelled = cause instanceof Error && cause.name === 'NotAllowedError';
  return cancelled ? copy.cancelled : copy.failed;
}

/**
 * The two step-up surfaces — the idle-lock overlay and the lock screen — ask
 * for the same assertion and offer the same way out, so they say the same
 * thing. Keeping the pair here stops them drifting into two wordings for one
 * situation.
 */
export const STEP_UP_ERROR_COPY: WebauthnErrorCopy = {
  cancelled: 'That was cancelled. Try again, or use a recovery code from /login.',
  failed: 'Could not verify that passkey. Try again, or use a recovery code from /login.',
};
