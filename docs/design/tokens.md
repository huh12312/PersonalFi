<!-- SPDX-License-Identifier: MIT -->

# Design tokens: where they live and how to pick one

PersonalFi's colours come from one source and are generated into the two forms the app reads
(WP 10.8, `docs/evidence/phase-10/wp10.8-visual-tokens.md`).

## Where they live

| File                                         | Edit it?        | What it is                                                                                                                                                                                                    |
| -------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/styles/tokens/radix-colors.ts` | No (regenerate) | Radix Colors 3.0.0 (MIT), vendored: `sand` and thirteen hue scales, light and dark, steps 1–12. `node scripts/gen-tokens.ts --refresh-radix <dir>` re-vendors it from an unpacked `@radix-ui/colors` package. |
| `apps/web/src/styles/tokens/roles.ts`        | **Yes**         | Every semantic role, per theme: a scale step (`'sand-2'`) or an off-scale house value with `why`. Also the legacy names (`ALIASES`).                                                                          |
| `apps/web/src/styles/tokens/fills.ts`        | **Yes**         | The thirteen chart fills: their order, their step per theme, the event-role steps.                                                                                                                            |
| `apps/web/src/styles/tokens.css`             | No (generated)  | What the browser reads. Imported by `base.css` before `theme.css`.                                                                                                                                            |
| `apps/web/src/styles/tokens.ts`              | No (generated)  | The same values as `TOKENS[theme]['--name']`, for canvas/SVG code and tests.                                                                                                                                  |
| `apps/web/src/styles/theme.css`              | Yes             | The Tailwind `@theme` map from utility names to roles, plus type, spacing, radii and motion.                                                                                                                  |

After editing a source file run `node scripts/gen-tokens.ts`. `src/styles/tokens.test.ts` fails if
`tokens.css` or `tokens.ts` differs from a regeneration, if the CSS and the TS object disagree, or if
the fills stop passing the dataviz checks; `src/styles/contrast.test.ts` fails if any role pair
drops under its WCAG floor.

## How to pick a role

Pick by **job**, never by how a colour looks.

- **A surface:** `--bg-page` (behind everything), `--bg-primary` (cards, rows, the chart surface),
  `--bg-secondary` (chips, a quiet panel), `--bg-overlay` (popovers, dialogs, a chart readout).
  `--bg-tertiary` and `--bg-inset` are fills for tracks, pressed states and skeleton bases; **text
  never sits on them**.
- **Text:** `--text-primary`, `--text-secondary`, `--text-tertiary`, `--text-muted` — all 4.5:1 on
  every text surface. `--text-disabled` is for inactive controls only. `--text-on-brand` on the accent.
- **A border:** `--border-primary` for a control's boundary (3:1); `--border-secondary` and
  `--border-divider` are decorative.
- **A state:** `--status-{success,danger,warning,info}-{bg,border,text,bold}` — always with an icon
  and a label, never colour alone. (The older `--status-good|warning|serious|critical` still drive
  `Badge` until V4 moves it.)
- **A chart:** `--chart-line` for a single series; `--chart-income` / `--chart-expenses` for money
  in and out (the CVD-safe teal/vermilion pair, never green/red); `--chart-axis` for an axis or
  baseline line, `--chart-label` for tick text, `--chart-gridline` for recessive grid;
  `--chart-negative-area` for a below-zero wash.
- **An entity in a chart** (a category, an account type, the *n*th series): its hue's
  `--chart-fill-<hue>`, through `apps/web/src/components/finance/chart-hue.ts` —
  `categoryHue(id, persisted)`, `accountTypeHue(kind)`, `seriesHue(i)`. Uncategorised and "Other"
  are `--chart-fill-neutral`. A marker on a timeline uses the four `--chart-event-{bg,border,dot,fg}-<hue>`
  roles of the same hue.

Never write a hex value in a component: ESLint refuses a six-digit hex literal in any `.tsx` under
`apps/web/src/features`, and `contrast.test.ts` refuses one anywhere under `src/` outside the token
sources. Text wears a text role, never a series colour.

## A hue is assigned once

A category's hue is chosen the first time the server reads it (`hueForId(id)` from `@core/kernel`, a
hash spread evenly over the thirteen hues), **stored** on the category row (`categories.hue`), and
never derived again: a re-read returns the stored value, an export carries it, an import restores it,
and only the user (`PATCH /categories/{id}`) changes it. The web computes the same `hueForId` only to
paint a category it has not yet seen the stored value for, which is by construction what the server
stores. Never re-hash a category that has a hue, and never pick a category's colour by its position
in a list: colour follows the entity, not its rank.

Positional series (donut slices, a second currency) take the fills in `CHART_FILL_ORDER`, the order
whose neighbours pass the CVD and normal-vision floors, and are never cycled: past the thirteenth they
fold into the neutral fill.

## Fixing a failing pair

Move the **step** (lighter or darker within the same scale) and regenerate. Never hand-pick a hex
that is not on a scale; an off-scale value is a house decision and needs its `why` in `roles.ts`.
