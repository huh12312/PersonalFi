// SPDX-License-Identifier: MIT
import { createFileRoute } from '@tanstack/react-router';

import { AdvisorScreen } from '../features/advisor/AdvisorScreen.tsx';

export const Route = createFileRoute('/_app/advisor')({
  component: AdvisorScreen,
});
