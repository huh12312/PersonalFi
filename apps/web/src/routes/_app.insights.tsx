// SPDX-License-Identifier: MIT
import { createFileRoute } from '@tanstack/react-router';

import { InsightsScreen } from '../features/insights/InsightsScreen.tsx';

export const Route = createFileRoute('/_app/insights')({
  component: InsightsScreen,
});
