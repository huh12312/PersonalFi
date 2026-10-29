// SPDX-License-Identifier: MIT
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

import { AdvisorScreen } from '../features/advisor/AdvisorScreen.tsx';

/**
 * WP 11.5e: `?finding=<insight id>` (with `week=<YYYY-Www>` when the link came from a Brief) starts one session about
 * that finding; `?session=<id>` opens an existing one. Anything else is ignored.
 */
const searchSchema = z.object({
  finding: z.string().optional().catch(undefined),
  week: z.string().optional().catch(undefined),
  session: z.string().optional().catch(undefined),
});

export const Route = createFileRoute('/_app/advisor')({
  validateSearch: searchSchema,
  component: AdvisorScreen,
});
