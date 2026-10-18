// SPDX-License-Identifier: MIT
import { createFileRoute } from '@tanstack/react-router';

import { HealthScreen } from '../features/health/HealthScreen.tsx';

/** `/health` (WP 10.12): the financial health score as a gauge, its pillars and its history. */
export const Route = createFileRoute('/_app/health/')({
  component: HealthScreen,
});
