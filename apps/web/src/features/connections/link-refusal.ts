// SPDX-License-Identifier: MIT

/**
 * What to tell someone whose *link attempt* was refused.
 *
 * `POST /connections` answers a refused input (a private key pasted into a watch-only form, a malformed
 * address) with `connector.invalid_input`, and the API's detail for that code is the one it writes for a
 * connection that has gone wrong *after* it was linked: "The provider needs your attention (CONFIG_ERROR).
 * Reconnect the connection to continue." Nothing is connected yet, so that sends the reader looking for a
 * connection to reconnect (the Phase 4 gate's O-6). For that one code this says what happened in words of the
 * moment; every other problem keeps the API's own detail, which is already specific (the connector's refusal of
 * key-shaped input names the kind of thing it saw and never echoes the value).
 */
export function linkRefusalDetail(cause: unknown, fallback: string): string {
  if (typeof cause !== 'object' || cause === null) return fallback;
  const problem = cause as { code?: unknown; detail?: unknown };
  if (problem.code === 'connector.invalid_input') {
    return 'This could not be linked: the value was not accepted as something to watch. Check it and try again — nothing was connected.';
  }
  if (typeof problem.detail === 'string' && problem.detail !== '') return problem.detail;
  return fallback;
}
