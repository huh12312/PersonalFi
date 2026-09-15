# Design tokens

The source of truth is `src/styles/theme.css` — this file documents it for
humans (and the `/dev/kitchen-sink` route renders every swatch live, in both
themes). Never hard-code a hex value in a component; reference the token
through its Tailwind utility (`bg-page`, `text-money-neg-text`, ...) or the raw
CSS variable (`var(--accent)`) when a library needs a literal colour (visx
`fill`/`stroke`).

Per 05-frontend-architecture.md §2: exactly one accent colour, money never
rendered in red/green (CVD-safe teal/vermilion instead — ~8% of men have some
form of red-green colour vision deficiency), and every categorical/status
colour pairs with a non-colour signal (`+`/`−`, a glyph, a label).

## Surfaces & text

| Token                 | Light               | Dark                   | Use                                                 |
| --------------------- | ------------------- | ---------------------- | --------------------------------------------------- |
| `--bg-page`           | `#f7f7f5`           | `#0e1012`              | App background                                      |
| `--bg-surface`        | `#ffffff`           | `#16181a`              | Cards, rows                                         |
| `--bg-surface-raised` | `#ffffff`           | `#1c1f22`              | Popovers, dialogs                                   |
| `--bg-subtle`         | `#f1f1ee`           | `#202326`              | Chips, empty-state icon circle, skeleton base       |
| `--bg-inset`          | `#eaeae6`           | `#0a0c0d`              | Track backgrounds (switch, progress ring)           |
| `--border-hairline`   | `rgba(11,11,11,.1)` | `rgba(255,255,255,.1)` | 1px dividers                                        |
| `--border-strong`     | `#d6d6d0`           | `#33373b`              | Input borders                                       |
| `--text-primary`      | `#0b0b0b`           | `#ffffff`              | Body text, ≥4.5:1 on `--bg-page` and `--bg-surface` |
| `--text-secondary`    | `#52514e`           | `#c3c2b7`              | Labels, secondary lines                             |
| `--text-muted`        | `#6b6a64`           | `#9a9a92`              | Captions, placeholders                              |
| `--focus-ring`        | `#1f5fb0`           | `#6da7ec`              | `:focus-visible` outline, ≥3:1 non-text contrast    |

## Accent (exactly one)

| Token               | Light     | Dark      |
| ------------------- | --------- | --------- |
| `--accent`          | `#2563eb` | `#3987e5` |
| `--accent-text`     | `#1f5fb0` | `#3987e5` |
| `--accent-contrast` | `#ffffff` | `#0b0b0b` |
| `--accent-wash`     | `#eaf2fd` | `#132537` |

## Money semantics — never red/green

| Token                              | Light                 | Dark                  | Meaning                 |
| ---------------------------------- | --------------------- | --------------------- | ----------------------- |
| `--money-pos` / `--money-pos-text` | `#0f8a68` / `#0a6f54` | `#1ba277` / `#3ec49a` | Inflow, positive delta  |
| `--money-neg` / `--money-neg-text` | `#d2452f` / `#b8391f` | `#e8604a` / `#ff8a6e` | Outflow, negative delta |
| `--money-neutral`                  | `#6b6a64`             | `#9a9a92`             | Zero                    |

Every `<Money>`/`<Percent>` render also carries an explicit `+`/`−` sign
(`signDisplay`) — colour is a reinforcement, never the only signal (WCAG 1.4.1).

## Status (fixed, never themed — except `--status-good`, see below)

| Token               | Value                            | Meaning                                   |
| ------------------- | -------------------------------- | ----------------------------------------- |
| `--status-good`     | `#0c7a0c` light / `#0ca30c` dark | On track                                  |
| `--status-warning`  | `#fab219`                        | Approaching a limit, needs attention soon |
| `--status-serious`  | `#ec835a`                        | Needs action (reconnect, over budget)     |
| `--status-critical` | `#d03b3b`                        | Failure, destructive confirmation         |

`--status-good` is the one status colour with a light/dark split: axe
(`apps/web/e2e/app-walkthrough.spec.ts`) found the original `#0ca30c` at
2.96:1 against light mode's `--bg-subtle` (`#f1f1ee`) — under WCAG AA's
4.5:1 — while it clears 4.71:1 against dark mode's `--bg-subtle`
(`#202326`), so one fixed value can't serve both. `--status-warning` and
`--status-serious` are visibly light colours that likely have the same
problem against `--bg-subtle`/`--bg-page` and have not been audited or
fixed here — left for a broader contrast pass (docs/evidence/phase-1/wp1.6-ui.md).

Every status carries a glyph (Lucide icon) alongside the colour — see `Badge`
and `SyncStatusPill`.

## Categorical series (fixed order, never cycled)

`--series-1` … `--series-8` — used for category legends and stacked charts, in
this exact order so a given category's colour never shifts between screens.
Validated for deuteranopia/protanopia/tritanopia simulation; see §3.5 of the
research memo for the reproducible check.

## Sequential ramp

`--seq-1` (lightest) … `--seq-13` (darkest) — heatmaps and Monte Carlo
confidence bands. `--diverging-mid` is the neutral midpoint for
month-over-month change maps.

## Chart chrome

| Token              | Use                               |
| ------------------ | --------------------------------- |
| `--chart-gridline` | Axis gridlines, tooltip crosshair |
| `--chart-axis-ink` | Axis tick labels                  |

## Typography scale

| Token                | Size / line-height | Weight | Use                                          |
| -------------------- | ------------------ | ------ | -------------------------------------------- |
| `--text-hero`        | 48 / 52            | 600    | Dashboard net worth                          |
| `--text-display`     | 34 / 40            | 600    | Screen-level hero stat                       |
| `--text-h1`          | 24 / 32            | 600    | Page title                                   |
| `--text-h2`          | 19 / 28            | 600    | Card title                                   |
| `--text-h3`          | 16 / 24            | 600    | Empty-state headline, insight headline       |
| `--text-body`        | 15 / 22            | 400    | Body                                         |
| `--text-body-strong` | 15 / 22            | 550    | Row primary line (merchant name)             |
| `--text-small`       | 13 / 18            | 400    | Secondary line, captions-that-need-more-room |
| `--text-caption`     | 12 / 16            | 400    | Badges, chart ticks                          |

Numeric alignment: any element showing money or a count gets `.tabular-nums`
(`font-variant-numeric: tabular-nums slashed-zero`) so columns of figures
align and a `0` is never mistaken for an `O`.

Font: self-hosted **Inter Variable** (`public/fonts/inter-variable-latin.woff2`,
OFL-1.1), weight range 100–900, no CDN.

## Spacing (4px base)

`--spacing-0` (0) through `--spacing-20` (80px) in the scale
0/4/8/12/16/20/24/28/32/40/48/64/80.

## Radii

| Token           | Value  | Use                             |
| --------------- | ------ | ------------------------------- |
| `--radius-sm`   | 6px    | Focus ring corner, inline chips |
| `--radius-md`   | 10px   | Buttons, inputs                 |
| `--radius-lg`   | 14px   | Cards (mobile)                  |
| `--radius-xl`   | 20px   | Cards (`md:` and up)            |
| `--radius-2xl`  | 28px   | Dialogs, bottom sheets          |
| `--radius-full` | 9999px | Pills, avatars, switch          |

## Elevation

Light mode uses real shadows (`--shadow-elev-1..3`, barely-there). Dark mode
expresses elevation through surface colour + hairline instead — all three
shadow tokens collapse to `none` except `--shadow-elev-3` (dialogs), which
still needs real separation from the page behind a backdrop.

## Motion

| Token           | Value | Use                                             |
| --------------- | ----- | ----------------------------------------------- |
| `--dur-instant` | 100ms | Micro-feedback (checkbox tick)                  |
| `--dur-fast`    | 160ms | Hover, toggle                                   |
| `--dur-base`    | 220ms | Dialog/sheet transitions, insight card collapse |
| `--dur-slow`    | 320ms | Larger layout shifts                            |

All four collapse to `0ms` under `prefers-reduced-motion: reduce`, globally,
once — see `base.css`. A manual "Reduce motion" toggle (future
`/settings/appearance`) will override the OS setting in both directions.

## Breakpoints (shell decisions only)

| Name                       | Min width | Shell                                     |
| -------------------------- | --------- | ----------------------------------------- |
| `xs` (default, unprefixed) | 0         | Single column, bottom tabs, sheets        |
| `sm`                       | 480px     | Wider cards, 2-up stat tiles              |
| `md`                       | 768px     | Icon-rail sidebar, dialogs replace sheets |
| `lg`                       | 1024px    | Full sidebar, multi-col dashboard grid    |
| `xl`                       | 1440px    | Max content width, centred                |

Everything **below** the shell uses Tailwind v4's `@container` queries, not
viewport breakpoints — see `StatTile`'s `@sm:text-hero` for the pattern.
