// SPDX-License-Identifier: MIT
/**
 * The colour roles the Health screen's marks are drawn with (WP 10.12), by job — named once so `ScoreGauge.tsx`,
 * `Sparkline.tsx` and `HealthZoneChart.tsx` draw only with these and `src/styles/contrast.test.ts` can check that
 * every one of them is a measured role:
 *
 *  - the gauge's track is each tier's `--status-*-bg` wash (decorative; the fill carries the value), its fill the
 *    current tier's `--status-*-bold` (3:1 on every chart surface, WP 10.8's role pairs);
 *  - a zone is its band's `--status-*-bg` wash and its band word is the same quartet's `-text` (4.5:1 on its wash);
 *  - a single series (the score's history, a pillar's metric) is `--chart-line`, 2 px, its end/now dot ringed in
 *    the surface `--bg-primary`; tick text is `--chart-label`; recessive rules `--chart-gridline`.
 */
import type { StatusRole } from './tiers.ts';

export const HEALTH_CHART_TOKENS = {
  line: '--chart-line',
  ring: '--bg-primary',
  axisInk: '--chart-label',
  gridline: '--chart-gridline',
  nowInk: '--text-primary',
} as const;

export function healthVar(role: keyof typeof HEALTH_CHART_TOKENS): string {
  return `var(${HEALTH_CHART_TOKENS[role]})`;
}

/** A status quartet member as a CSS value: `statusVar('warning', 'bold')` → `var(--status-warning-bold)`. */
export function statusVar(status: StatusRole, member: 'bg' | 'bold' | 'text' | 'border'): string {
  return `var(--status-${status}-${member})`;
}
