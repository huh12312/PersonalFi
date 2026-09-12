// SPDX-License-Identifier: MIT
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

import { PasskeyRegisterFlow } from '../features/auth/PasskeyRegisterFlow.tsx';

const searchSchema = z.object({
  /** The one-time enrolment token printed by `just bootstrap-user` (first run). */
  token: z.string().min(16).optional(),
});

export const Route = createFileRoute('/register')({
  validateSearch: searchSchema,
  component: RegisterRoute,
});

function RegisterRoute() {
  const { token } = Route.useSearch();
  return <PasskeyRegisterFlow registrationToken={token} />;
}
