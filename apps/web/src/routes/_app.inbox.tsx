// SPDX-License-Identifier: MIT
import { createFileRoute } from '@tanstack/react-router';

import { InboxScreen } from '../features/inbox/InboxScreen.tsx';

export const Route = createFileRoute('/_app/inbox')({
  component: InboxScreen,
});
