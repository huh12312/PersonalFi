// SPDX-License-Identifier: MIT
import { createFileRoute } from '@tanstack/react-router';

import { GoalsScreen } from '../features/goals/GoalsScreen.tsx';

/** `/goals` (WP 9.7, C-10): goals and their contributions, and the risk questionnaire. */
export const Route = createFileRoute('/_app/goals')({
  component: GoalsScreen,
});
