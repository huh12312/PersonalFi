// SPDX-License-Identifier: MIT
import { CHART_HUES } from '@core/kernel';

/** The Radix Colors scales PersonalFi vendors (WP 10.8): `sand` for neutrals and the thirteen chart hues. */
export const RADIX_SCALE_NAMES = ['sand', ...CHART_HUES] as const;

export type ScaleName = (typeof RADIX_SCALE_NAMES)[number];
