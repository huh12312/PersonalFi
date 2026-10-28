// SPDX-License-Identifier: MIT
import { createFileRoute } from '@tanstack/react-router';

import { AskScreen } from '../features/ask/AskScreen.tsx';

export const Route = createFileRoute('/_app/ask')({
  component: AskScreen,
});
