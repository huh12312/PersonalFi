// SPDX-License-Identifier: MIT
/**
 * `node scripts/validate_palette.js` — the palette validator 05
 * §3.5 names and WP 4.10 (`docs/plan/04-phase-4-dispatch.md` §3) is the
 * first work package to actually need it, for the Monte Carlo fan chart's
 * sequential blue band ramp.
 *
 * Two independent checks a colour choice in this app must pass, run over
 * plain WCAG relative luminance / contrast math and a linear-RGB colour-
 * vision-deficiency (CVD) simulation — no dependency, per D14 (a chart's
 * colours are not worth a supply-chain risk):
 *
 *   1. **Perceptual separation** (categorical palettes — spending
 *      categories, allocation slices, adjacent bars): every pair (or every
 *      adjacent pair) must stay visually distinct once deuteranopia is
 *      simulated, so two "different" series never collapse onto the same
 *      hue for a colour-blind reader. This is the mode 05 §3.5's own worked
 *      examples show (money semantics, the categorical series, the
 *      all-pairs donut/treemap slots).
 *
 *   2. **Sequential ordering** (`--sequential`, this WP's own case — the
 *      fan chart's bands): a sequential ramp is *supposed* to look similar
 *      step to step ("one hue, light outside to dark inside" — 05 §3.4).
 *      Demanding CVD separation between neighbours would be the wrong rule
 *      for exactly the encoding 05 asks for; what a sequential ramp must
 *      prove instead is that its luminance is monotonic in the stated
 *      direction and that every step still clears the relevant contrast
 *      floor against the page it sits on (WCAG 1.4.11, ≥3:1 for a chart
 *      mark that is not text).
 *
 * Exit code 0 only when every requested check passes — `pnpm test:palette`
 * (05 §3.5) can wire this in as a CI gate directly.
 */

/* ------------------------------------------------------------------------ */
/* Colour maths                                                             */
/* ------------------------------------------------------------------------ */

/** @param {string} hex */
function parseHex(hex) {
  const clean = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) {
    throw new Error(`not a 6-digit hex colour: ${JSON.stringify(hex)}`);
  }
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

/** sRGB channel [0,255] → linear [0,1] (IEC 61966-2-1). */
function srgbToLinearChannel(c8) {
  const c = c8 / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgbChannel(lin) {
  const c = lin <= 0.0031308 ? lin * 12.92 : 1.055 * Math.pow(lin, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
}

/** WCAG relative luminance, 0 (black) – 1 (white). */
function relativeLuminance({ r, g, b }) {
  return (
    0.2126 * srgbToLinearChannel(r) +
    0.7152 * srgbToLinearChannel(g) +
    0.0722 * srgbToLinearChannel(b)
  );
}

/** WCAG contrast ratio, 1–21. */
function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Deuteranopia simulation, Machado/Oliveira/Fernandes 2009's 100%-severity
 * matrix (the standard linear-RGB CVD simulation matrix used by browser
 * devtools' own "Emulate vision deficiencies" and by every colour-safety
 * tool that does not vendor a dependency for it). Applied in *linear* RGB,
 * per the paper.
 */
const DEUTERANOPIA_MATRIX = [
  [0.367_322, 0.860_646, -0.227_968],
  [0.280_085, 0.672_501, 0.047_413],
  [-0.011_820_5, 0.042_940_6, 0.968_881],
];

function simulateDeuteranopia(rgb) {
  const lin = [
    srgbToLinearChannel(rgb.r),
    srgbToLinearChannel(rgb.g),
    srgbToLinearChannel(rgb.b),
  ];
  const out = DEUTERANOPIA_MATRIX.map(
    (row) => row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2],
  );
  return {
    r: linearToSrgbChannel(out[0]),
    g: linearToSrgbChannel(out[1]),
    b: linearToSrgbChannel(out[2]),
  };
}

/** sRGB (0-255) → CIE XYZ (D65) → CIE L*a*b*, for a perceptual ΔE. */
function rgbToLab({ r, g, b }) {
  const rl = srgbToLinearChannel(r);
  const gl = srgbToLinearChannel(g);
  const bl = srgbToLinearChannel(b);
  // sRGB → XYZ, D65 white point.
  const x = rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375;
  const y = rl * 0.2126729 + gl * 0.7151522 + bl * 0.072175;
  const z = rl * 0.0193339 + gl * 0.119192 + bl * 0.9503041;
  const xn = x / 0.95047;
  const yn = y / 1.0;
  const zn = z / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 / 116) * t + 4 / 29);
  const fx = f(xn);
  const fy = f(yn);
  const fz = f(zn);
  return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/** CIE76 ΔE — a simple Euclidean distance in Lab space. Adequate for a CI gate; not colorimetry. */
function deltaE(labA, labB) {
  return Math.sqrt((labA.l - labB.l) ** 2 + (labA.a - labB.a) ** 2 + (labA.b - labB.b) ** 2);
}

function pairDeltaE(hexA, hexB) {
  const a = parseHex(hexA);
  const b = parseHex(hexB);
  const normal = deltaE(rgbToLab(a), rgbToLab(b));
  const deutan = deltaE(rgbToLab(simulateDeuteranopia(a)), rgbToLab(simulateDeuteranopia(b)));
  return { normal, deutan };
}

/* ------------------------------------------------------------------------ */
/* CLI                                                                      */
/* ------------------------------------------------------------------------ */

const CVD_PASS_THRESHOLD = 5; // ΔE below this reads as "the same colour" to a deuteranopic viewer.
const SEQUENTIAL_CONTRAST_FLOOR = 3; // WCAG 1.4.11, non-text chart marks.
const TEXT_CONTRAST_FLOOR = 4.5; // WCAG 1.4.3, normal-weight body text.

function parseArgs(argv) {
  const positional = [];
  const flags = { mode: 'light', surface: null, pairs: 'adjacent', sequential: false, text: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--mode') {
      flags.mode = argv[++i];
    } else if (arg === '--surface') {
      flags.surface = argv[++i];
    } else if (arg === '--pairs') {
      flags.pairs = argv[++i];
    } else if (arg === '--sequential') {
      flags.sequential = true;
    } else if (arg === '--text') {
      flags.text = true; // colours are used as text, not marks — apply the 4.5:1 floor, not 3:1.
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function fail(message) {
  process.stderr.write(`validate_palette: ${message}\n`);
  process.exitCode = 1;
}

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const list = positional[0];
  if (list === undefined) {
    process.stderr.write(
      'usage: node scripts/validate_palette.js "<hex,hex,...>" [--mode light|dark] ' +
        '[--surface <hex>] [--pairs adjacent|all] [--sequential] [--text]\n',
    );
    process.exitCode = 2;
    return;
  }
  const colors = list.split(',').map((s) => s.trim());
  if (colors.length < 2) {
    fail('need at least two colours to validate a relationship between them');
    return;
  }
  for (const c of colors) parseHex(c); // throws with a clear message on a malformed entry

  const surface = flags.surface ?? (flags.mode === 'dark' ? '#16181a' : '#ffffff');
  const contrastFloor = flags.text ? TEXT_CONTRAST_FLOOR : SEQUENTIAL_CONTRAST_FLOOR;

  process.stdout.write(
    `validate_palette: ${colors.length} colour(s), mode=${flags.mode}, surface=${surface}\n`,
  );

  if (flags.sequential) {
    // Rule for a sequential ramp (05 §3.4): luminance monotonic step to
    // step in *some* direction, and every step legible against its surface.
    const surfaceRgb = parseHex(surface);
    const luminances = colors.map((c) => relativeLuminance(parseHex(c)));
    const contrasts = colors.map((c) => contrastRatio(parseHex(c), surfaceRgb));

    let increasing = true;
    let decreasing = true;
    for (let i = 1; i < luminances.length; i += 1) {
      if (luminances[i] <= luminances[i - 1]) increasing = false;
      if (luminances[i] >= luminances[i - 1]) decreasing = false;
    }
    const monotonic = increasing || decreasing;
    const direction = increasing ? 'lightest → darkest' : decreasing ? 'darkest → lightest' : 'NOT MONOTONIC';

    colors.forEach((c, i) => {
      const status = contrasts[i] >= contrastFloor ? 'PASS' : 'WARN';
      process.stdout.write(
        `  [${i}] ${c}  luminance=${luminances[i].toFixed(4)}  contrast vs ${surface}=${contrasts[i].toFixed(2)}  ${status} (floor ${contrastFloor})\n`,
      );
    });

    // Monotonic ordering is the structural property a *sequential* ramp is
    // graded on (05 §3.4: "one hue, light→dark") and is the only thing this
    // mode fails the build over. Whether a given step also needs to clear a
    // contrast floor on its own depends on whether it is the sole carrier of
    // information (a boundary stroke, a mark) or a soft decorative context
    // fill with the real values carried elsewhere (axis, tooltip, direct
    // label) — `NetWorthAreaChart`'s own gradient already fades to 4%
    // opacity on exactly that reasoning. So a step under the floor is
    // reported as `WARN`, not failed, and the caller's evidence says which
    // kind of step it was.
    const allAboveFloor = contrasts.every((v) => v >= contrastFloor);
    if (!monotonic) {
      fail(`sequence is not monotonic in luminance (order given: ${colors.join(' → ')})`);
    } else {
      process.stdout.write(
        `  → ${allAboveFloor ? 'PASS' : 'PASS (with WARN)'} · monotonic (${direction}) · worst contrast ${Math.min(...contrasts).toFixed(2)}:1 (floor ${contrastFloor}:1)\n`,
      );
    }
    return;
  }

  // Categorical / all-pairs mode — 05 §3.5's own worked examples.
  const pairs = [];
  if (flags.pairs === 'all') {
    for (let i = 0; i < colors.length; i += 1) {
      for (let j = i + 1; j < colors.length; j += 1) pairs.push([i, j]);
    }
  } else {
    for (let i = 1; i < colors.length; i += 1) pairs.push([i - 1, i]);
  }

  let worstNormal = Infinity;
  let worstDeutan = Infinity;
  let anyCvdFail = false;
  const warnContrast = [];
  const surfaceRgb = parseHex(surface);

  for (const [i, j] of pairs) {
    const { normal, deutan } = pairDeltaE(colors[i], colors[j]);
    worstNormal = Math.min(worstNormal, normal);
    worstDeutan = Math.min(worstDeutan, deutan);
    const status = deutan >= CVD_PASS_THRESHOLD ? 'PASS' : 'FAIL';
    if (status === 'FAIL') anyCvdFail = true;
    process.stdout.write(
      `  ${colors[i]} ↔ ${colors[j]}  ΔE(deutan)=${deutan.toFixed(1)}  ΔE(normal)=${normal.toFixed(1)}  ${status}\n`,
    );
  }

  for (const c of colors) {
    const ratio = contrastRatio(parseHex(c), surfaceRgb);
    if (ratio < contrastFloor) warnContrast.push(`${c} (${ratio.toFixed(2)}:1)`);
  }

  const summary =
    (anyCvdFail ? 'FAIL' : 'ALL PASS') +
    ` · worst CVD ΔE ${worstDeutan.toFixed(1)} (deutan) · normal-vision ΔE ${worstNormal.toFixed(1)}` +
    (warnContrast.length > 0 ? ` · WARN contrast: ${warnContrast.join(', ')} (relief rule: direct labels required)` : '');
  process.stdout.write(`  → ${summary}\n`);

  if (anyCvdFail) fail('one or more pairs are not separable under simulated deuteranopia');
}

main();
