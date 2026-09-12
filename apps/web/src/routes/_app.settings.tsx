// SPDX-License-Identifier: MIT
import { createFileRoute } from '@tanstack/react-router';
import { Settings } from 'lucide-react';

import { PlaceholderRoute } from '../components/patterns/PlaceholderRoute.tsx';

export const Route = createFileRoute('/_app/settings')({
  component: () => (
    <PlaceholderRoute
      icon={Settings}
      headline="Settings"
      description="Profile, security & passkeys, connections, categories, data, and appearance land in a later work package."
    />
  ),
});
