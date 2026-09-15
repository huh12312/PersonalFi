// SPDX-License-Identifier: MIT
import { useEffect, useState } from 'react';

import { client } from '../api/generated/client.gen.ts';
import type { StreamEvent } from '../api/generated/core/serverSentEvents.gen.ts';

export type SseConnectionState = 'connecting' | 'open' | 'error';

/**
 * The envelope every domain event arrives in on both streams
 * (wp1.5-api.md §3): `{ type, aggregateId, occurredAt, correlationId, payload
 * }`. `payload` is left `unknown` deliberately — its shape per event `type`
 * is not part of the OpenAPI contract (the SSE body is `text/event-stream`,
 * typed in the generated client as an opaque `string`), so this hook treats
 * a frame as "something changed, of this kind" and lets callers refetch the
 * REST resource that actually describes the new state, rather than trusting
 * an unspecified wire shape for anything that matters (a sync count, a
 * balance).
 */
export interface DomainSseEvent {
  readonly type: string;
  readonly aggregateId: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly payload: unknown;
}

export interface UseEventStreamOptions {
  /** `?from=<seq>` — a client-managed resume point (wp1.5-api.md §3). Omit to start at the server's current high-water mark. */
  readonly from?: string;
  /** Set false to tear the connection down without unmounting (e.g. a closed panel). Default true. */
  readonly enabled?: boolean;
}

export interface UseEventStreamResult {
  /** The most recent *named* event. Heartbeat comment frames never reach here (see below). */
  readonly lastEvent: DomainSseEvent | null;
  readonly state: SseConnectionState;
}

/**
 * Subscribes to one of the two `text/event-stream` routes
 * (`/sync/stream`, `/connections/{id}/events`) through the generated
 * client's fetch-based SSE reader (`core/serverSentEvents.gen.ts`) rather
 * than a hand-rolled `EventSource`. That reader already does everything
 * wp1.5-api.md §3 promises a client:
 *
 * - **Resume**: it tracks the last `id:` line internally and sends it back as
 *   `Last-Event-ID` on every reconnect attempt, matching the server's
 *   `seq > cursor` comparison.
 * - **Heartbeat tolerance**: the server's `: heartbeat\n\n` comment carries no
 *   `data:` line, so it reaches `onSseEvent` with `data: undefined` — this
 *   hook treats that as a liveness signal (`state` → `'open'`) and explicitly
 *   does *not* overwrite `lastEvent` with it, which is the whole point of
 *   "tolerant": fifteen seconds of silence must not read as fifteen seconds
 *   of the last real event going stale.
 * - **Reconnect with backoff** on a dropped connection, automatically.
 *
 * Reusing it — instead of a second, parallel `EventSource`-based
 * implementation — is what "use the generated client for all new calls"
 * means for a streaming route, and it means this hook is testable the same
 * way as every other query in this app: by stubbing `fetch` to return a
 * `ReadableStream` body, not by shimming a global `EventSource` happy-dom
 * does not provide.
 */
export function useEventStream(
  url: string,
  options: UseEventStreamOptions = {},
): UseEventStreamResult {
  const { from, enabled = true } = options;
  const [lastEvent, setLastEvent] = useState<DomainSseEvent | null>(null);
  const [state, setState] = useState<SseConnectionState>('connecting');

  useEffect(() => {
    if (!enabled) return undefined;

    const controller = new AbortController();
    let cancelled = false;
    // Resets the connection-state flag every time this effect (re)subscribes
    // — an unavoidable `setState` in an effect since "starting a new
    // subscription to an external system" has no other lifecycle hook to run
    // in; react-hooks/set-state-in-effect flags every direct call regardless.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState('connecting');

    async function run(): Promise<void> {
      try {
        const { stream } = await client.sse.get<DomainSseEvent>({
          url,
          ...(from !== undefined ? { query: { from } } : {}),
          signal: controller.signal,
          onSseEvent: (event: StreamEvent<DomainSseEvent>) => {
            if (cancelled) return;
            setState('open');
            // Heartbeat comment frames carry no `data:` line at all — ignored
            // rather than surfaced, per this function's own doc above.
            if (event.data === undefined) return;
            setLastEvent(event.data);
          },
          onSseError: () => {
            if (!cancelled) setState('error');
          },
        });
        // Iterating drives the generator; state updates happen in onSseEvent
        // above, not from the yielded values themselves.
        for await (const _event of stream) {
          // no-op
        }
      } catch {
        if (!cancelled) setState('error');
      }
    }

    void run();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [url, from, enabled]);

  return { lastEvent, state };
}
