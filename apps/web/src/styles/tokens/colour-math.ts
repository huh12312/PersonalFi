// SPDX-License-Identifier: MIT
/**
 * The measurable half of the dataviz method, in TypeScript, so the unit suite enforces what the skill's
 * `validate_palette.js` reports (WP 10.8). Same formulas, same constants: OKLab ΔE ×100, protan/deutan simulated
 * with Machado–Oliveira–Fernandes 2009 at severity 1.0 in linear RGB, OKLCH lightness bands and chroma floor,
 * WCAG 2.x relative-luminance contrast. The evidence tables are produced by the skill's own script; the test
 * suite (`tokens.test.ts`) re-measures with this module and must agree with them.
 *
 * Inputs are `#rrggbb` only — every value in `tokens.css` is one.
 */

export const LIGHTNESS_BAND = { light: [0.43, 0.77], dark: [0.48, 0.67] } as const;
export const CHROMA_FLOOR = 0.1;
export const CVD_TARGET = 8;
export const CVD_FLOOR = 6;
export const NORMAL_FLOOR = 15;

type Vec3 = readonly [number, number, number];

const MACHADO = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
} as const;

export type CvdKind = keyof typeof MACHADO;

function srgb(hex: string): Vec3 {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (match?.[1] === undefined) throw new Error(`not a #rrggbb colour: ${hex}`);
  const h = match[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as unknown as Vec3;
}

const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function linear(hex: string): Vec3 {
  const [r, g, b] = srgb(hex);
  return [toLinear(r), toLinear(g), toLinear(b)];
}

function oklabOfLinear([r, g, b]: Vec3): Vec3 {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function simulate(hex: string, kind: CvdKind): Vec3 {
  const [r, g, b] = linear(hex);
  const m = MACHADO[kind];
  const clamp = (c: number): number => Math.max(0, Math.min(1, c));
  return [
    clamp(m[0][0] * r + m[0][1] * g + m[0][2] * b),
    clamp(m[1][0] * r + m[1][1] * g + m[1][2] * b),
    clamp(m[2][0] * r + m[2][1] * g + m[2][2] * b),
  ];
}

/** OKLCH lightness and chroma. */
export function oklch(hex: string): { readonly l: number; readonly c: number } {
  const [l, a, b] = oklabOfLinear(linear(hex));
  return { l, c: Math.hypot(a, b) };
}

/** Euclidean OKLab distance ×100; with `kind`, both colours are simulated first. */
export function deltaE(a: string, b: string, kind?: CvdKind): number {
  const x = oklabOfLinear(kind === undefined ? linear(a) : simulate(a, kind));
  const y = oklabOfLinear(kind === undefined ? linear(b) : simulate(b, kind));
  return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

/** min(protan, deutan) ΔE — the CVD separation the skill gates on. */
export function cvdDeltaE(a: string, b: string): number {
  return Math.min(deltaE(a, b, 'protan'), deltaE(a, b, 'deutan'));
}

function luminance(hex: string): number {
  const [r, g, b] = linear(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
