<!-- SPDX-License-Identifier: MIT -->

# Blocks: the vocabulary the Brief and Reports are drawn in

WP 10.15 (V8 of the visual programme, `docs/research/10-visual-design-notes.md` §3) gave the
Brief and Reports one renderer instead of one bespoke component each. The server builds a list of
**blocks**; the web draws them with `apps/web/src/components/blocks/BlockRenderer.tsx`. Evidence:
`docs/evidence/phase-10/wp10.15-block-kit.md`.

## Where it lives

| File                                          | What it is                                                                                                                                                                                               |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/kernel/src/blocks.ts`               | The vocabulary: kinds, enumerations, patterns, the TypeScript shape, the cross-field rules (`blockRuleProblems`), and `BLOCK_FIXTURES` (one valid block per kind and a refusal corpus).                  |
| `apps/api/src/blocks/schema.ts`               | The server's Zod schema, published as `Block` and `BlockDocument` in the OpenAPI document. `blockDocument(blocks)` parses every block before it leaves; a builder bug is a 500, never a block on screen. |
| `apps/api/src/blocks/{reports,brief}.ts`      | The builders. Pure functions of a route's own wire output.                                                                                                                                               |
| `apps/web/src/components/blocks/schema.ts`    | The web's Zod schema, built from the same kernel parts and typed against the generated `Block`. `parseBlock` sorts an unknown kind from an invalid one.                                                  |
| `apps/web/src/components/blocks/*View.tsx`    | One component per kind.                                                                                                                                                                                  |
| `apps/web/src/test-support/block-fixtures.ts` | A copy of the builders for the web's unit tests and the Playwright mocks. `apps/api/test/block-contract.test.ts` fails if a function in it differs from the server's.                                    |

Zod is not one of the kernel's dependencies, so the two schemas are two files made of the same parts.
Both run `BLOCK_FIXTURES`, so an accept/reject difference between them fails a test on each side.

## The vocabulary (`contractVersion: 1`)

A document is `{ contractVersion: 1, blocks: Block[] }`. Every block has a `kind` and an optional `id`.

| Kind                | Fields                                                                                                               | Drawn by (wrapping)                                                                          |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `text`              | `content`, `size` (body, heading, eyebrow, caption), `weight?`, `role?`, `narration?`                                | text roles; `role: 'narration'` through `NarratedSummary`, so the provider/model badge stays |
| `info`              | `label`, `value` (words or money, or `null` with `withheld`), `hint?`                                                | a label/value pair                                                                           |
| `money`             | `label`, `amountMinor` (or `null` with `withheld`), `currency`, `signColour?`, `hint?`                               | `Money`                                                                                      |
| `horizontal-bars`   | `title?`, `topRightLabel?`, `bars[{label, hue, barPercent, leftLabel?, rightLabel, href?}]`, `smallBarStyle?`        | the Cash Flow hub's bar row (`HorizontalBarRow`), plus a table                               |
| `pie`               | `title?`, `currency` (or `null` for counts), `slices[{label, value, hue}]`                                           | a small donut with a legend and a table                                                      |
| `stacked-bars`      | `title?`, `currency` (or `null`), `data[{x, total, groups[{key, label, value, hue, href?, labelHref?, count?}]}]`    | a visx stacked bar, segments linked, plus a table                                            |
| `sparkline-row`     | `label`, `rightLabel?`, `hue?`, `values` (decimal strings), `currency?`, `hideValueChange?`, `title?`, `largeStyle?` | the Health sparkline's mark spec, plus a table                                               |
| `meter`             | `label`, `spentMinor`, `budgetedMinor`, `currency`, `tickPercent?`, `state`                                          | `BudgetMeterRow`                                                                             |
| `net-worth`         | `title?`, `currency`, `bucketing`, `buckets` (V6's `NetWorthBucket`)                                                 | `NetWorthStackedChart`                                                                       |
| `transactions-list` | `title?`, `transactionIds`                                                                                           | each id read through `GET /transactions/{id}`; a row opens the transaction sheet             |
| `table`             | `caption`, `columns[{key, label, align?}]`, `rows[{key, cells[{value, href?, hrefLabel?, badges?}]}]`                | a real table, the first cell the row header                                                  |
| `badge`             | `label`, `variant`                                                                                                   | `Badge`                                                                                      |
| `cta`               | `label`, `href`, `variant` (primary, secondary, link)                                                                | an in-app link                                                                               |
| `divider`           | nothing                                                                                                              | a rule                                                                                       |
| `group`             | `title?`, `blocks`                                                                                                   | a titled group; groups nest at most four deep                                                |

## The rules

The schemas enforce every one of these. None is a review convention.

- **Money is integer minor units plus a currency**, as a string (`"-12345"`). It is never a float and
  never formatted on the server. A label that is money is `{ amountMinor, currency }`.
- **A colour is a name.** It is one of the thirteen hues or `neutral` for a mark, or a role name for
  a badge or a button. Every colour field is an enumeration, and every object is strict. A hex value
  has nowhere to go, and an unknown field such as `colour: '#…'` is refused.
- **An href is an in-app path**: one leading `/`, never `//`, a scheme or a backslash. The web
  refuses to draw anything else as a link.
- **A withheld figure carries its reason.** `amountMinor: null` (or `value: null`) is valid only with
  `withheld`, and the web shows the reason in words, never a zero. A meter with a budget of `"0"` must
  be `no_budget`, which draws "no amount set" and no bar.
- **A block never carries a figure its source does not expose.** A builder takes the source route's
  own wire output, and the source route and the block route call one function. A stacked bar's
  `total` must equal the sum of its own segments, so it cannot carry a figure of its own. Bar
  lengths (`barPercent`) are geometry and are never printed.
- **Every chart block has its table** ("View as table"), an accessible name, and tabular figures.
  Motion respects reduced motion.
- **Unknown kinds are never dropped silently.** The server refuses them. The web draws "Unsupported
  block (kind)" for a kind it does not know, and "Invalid block (kind)" for a known kind that breaks
  a rule.
- **Blocks are deterministic server code, never model output, and never model input.** The narrator's
  request is assembled from `insights` rows (`@ctx/insights` `advisors/local/findings.ts`) and never
  reads a block. A narration enters a block only as text the Brief route already serves, under its
  badge. `validate/numerals.ts` still governs that text at the narrator's gate.

## Adding a kind

1. Add the kind to `BLOCK_KINDS`, its interface to the `Block` union, and any cross-field rule to
   `blockRuleProblems` (`packages/kernel/src/blocks.ts`). Add one valid fixture and a refusal for
   each new rule to `BLOCK_FIXTURES`.
2. Add it to both Zod schemas (`apps/api/src/blocks/schema.ts`, `apps/web/src/components/blocks/schema.ts`)
   as a strict object. Every colour field must be an enumeration, every money field minor units, and
   every href `BLOCK_HREF_PATTERN`.
3. Run `just openapi`, then `pnpm --filter @app/web gen`.
4. Write `XBlockView.tsx`. Wrap the existing component if there is one. If it is a chart, read the
   dataviz skill first and give it a `ChartDataTable`. Add it to `BlockRenderer`'s switch and to the
   kitchen-sink gallery (`components/dev/BlocksGallery.tsx`).
5. A breaking change to an existing kind bumps `BLOCK_CONTRACT_VERSION`. The web draws a document of
   another version as unsupported, in words.
