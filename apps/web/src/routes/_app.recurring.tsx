// SPDX-License-Identifier: MIT
import { createFileRoute } from '@tanstack/react-router';

import { RecurringScreen } from '../features/recurring/RecurringScreen.tsx';

export const Route = createFileRoute('/_app/recurring')({
  component: RecurringScreen,
});
