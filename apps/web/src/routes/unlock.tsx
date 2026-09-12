// SPDX-License-Identifier: MIT
import { createFileRoute } from '@tanstack/react-router';

import { KekUnlockScreen } from '../features/auth/KekUnlockScreen.tsx';

export const Route = createFileRoute('/unlock')({
  component: KekUnlockScreen,
});
