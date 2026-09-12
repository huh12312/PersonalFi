// SPDX-License-Identifier: MIT
import { createFileRoute } from '@tanstack/react-router';

import { LoginScreen } from '../features/auth/LoginScreen.tsx';

export const Route = createFileRoute('/login')({
  component: LoginScreen,
});
