// SPDX-License-Identifier: MIT
import { createFileRoute } from '@tanstack/react-router';

import { HealthPillarScreen } from '../features/health/HealthPillarScreen.tsx';

/** `/health/{pillar}` (WP 10.12): one pillar against its health zones. An unknown slug says so. */
export const Route = createFileRoute('/_app/health/$pillar')({
  component: RouteComponent,
});

function RouteComponent() {
  const { pillar } = Route.useParams();
  return <HealthPillarScreen slug={pillar} />;
}
