// SPDX-License-Identifier: MIT
import { createFileRoute } from '@tanstack/react-router';

import { BriefScreen } from '../features/brief/BriefScreen.tsx';

export const Route = createFileRoute('/_app/brief')({
  component: BriefScreen,
});
