// SPDX-License-Identifier: MIT
import { createFileRoute } from '@tanstack/react-router';

import { LockScreen } from '../features/auth/LockScreen.tsx';

export const Route = createFileRoute('/lock')({
  component: LockScreen,
});
