// SPDX-License-Identifier: MIT
import { useQuery } from '@tanstack/react-query';

import { getNetWorthSeriesOptions } from '../../../api/generated/@tanstack/react-query.gen.ts';
import { pickSealedStart, type StartSource } from './sealedStart.ts';

/** Long enough to cover a few missed nightly seals; the seal itself is nightly. */
const WINDOW_DAYS = 60;

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface SealedStart {
  /** `false` until the series query has settled either way — the preview waits, so it never starts from a guess it then replaces. */
  readonly ready: boolean;
  readonly source: StartSource;
}

/** `GET /net-worth/series` over the last 60 days, reduced to the newest sealed day. */
export function useSealedStart(today: Date = new Date()): SealedStart {
  const to = isoDay(today);
  const from = isoDay(new Date(today.getTime() - WINDOW_DAYS * 86_400_000));
  const query = useQuery({
    ...getNetWorthSeriesOptions({ query: { from, to } }),
    staleTime: 60_000,
  });
  if (query.isError) return { ready: true, source: { kind: 'placeholder', reason: 'unavailable' } };
  if (query.data === undefined) {
    return { ready: false, source: { kind: 'placeholder', reason: 'unavailable' } };
  }
  return { ready: true, source: pickSealedStart(query.data) };
}
