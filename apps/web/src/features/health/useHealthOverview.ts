// SPDX-License-Identifier: MIT
import { useQuery } from '@tanstack/react-query';

import { getHealthOverviewOptions } from '../../api/generated/@tanstack/react-query.gen.ts';
import type { Problem } from '../../api/generated/types.gen.ts';

/** `GET /insights/health` — the Health screen, its pillar detail and the dashboard widget share one query. */
export function useHealthOverview() {
  const query = useQuery(getHealthOverviewOptions());
  const problem = query.error as Problem | null;
  return {
    query,
    health: query.data?.health,
    /** No snapshot exists and none could be computed (404 `insights.health_not_computed`). */
    notComputed: problem?.code === 'insights.health_not_computed',
  };
}
