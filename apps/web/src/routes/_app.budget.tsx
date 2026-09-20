// SPDX-License-Identifier: MIT
import { createFileRoute } from '@tanstack/react-router';

import { BudgetScreen } from '../features/budget/BudgetScreen.tsx';

export const Route = createFileRoute('/_app/budget')({
  component: BudgetScreen,
});
