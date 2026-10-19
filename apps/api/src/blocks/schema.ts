// SPDX-License-Identifier: MIT
/**
 * The block vocabulary as a Zod schema, on the wire (WP 10.15, V8; docs/design/blocks.md).
 *
 * Built from `@core/kernel`'s `blocks.ts` — the kinds, the enumerations and the patterns — so this schema and the
 * web's (`apps/web/src/components/blocks/schema.ts`) are made of the same parts, and both run the kernel's
 * `BLOCK_FIXTURES` in their tests. `.meta({ id: 'Block' })` hoists it into the OpenAPI document's components, so
 * the generated client's `Block` type is this schema.
 *
 * **Strict objects**: an unknown field is refused, so a block cannot smuggle a `colour: '#…'` beside its hue.
 * **Every block is parsed before it leaves** (`blockDocument` in each builder's caller): a builder that produced a
 * hex, an external href or an unknown kind fails the request (500) rather than sending it.
 */
import {
  BLOCK_BADGE_VARIANTS,
  BLOCK_CONTRACT_VERSION,
  BLOCK_CTA_VARIANTS,
  BLOCK_CURRENCY_PATTERN,
  BLOCK_DECIMAL_PATTERN,
  BLOCK_HREF_PATTERN,
  BLOCK_HUES,
  BLOCK_LABEL_MAX,
  BLOCK_MAX_DEPTH,
  BLOCK_METER_STATES,
  BLOCK_MINOR_PATTERN,
  BLOCK_NARRATION_PROVIDERS,
  BLOCK_NARRATION_STATUSES,
  BLOCK_NET_WORTH_BUCKETINGS,
  BLOCK_NET_WORTH_SEGMENT_KINDS,
  BLOCK_SIGN_COLOURS,
  BLOCK_TABLE_ALIGNS,
  BLOCK_TEXT_MAX,
  BLOCK_TEXT_ROLES,
  BLOCK_TEXT_SIZES,
  BLOCK_TEXT_WEIGHTS,
  blockDepth,
  blockRuleProblems,
  type Block,
} from '@core/kernel';
import { z } from 'zod';

const label = z.string().min(1).max(BLOCK_LABEL_MAX);
const longText = z.string().max(BLOCK_TEXT_MAX);
const minor = z.string().regex(BLOCK_MINOR_PATTERN, 'integer minor units, as a string');
const decimal = z.string().regex(BLOCK_DECIMAL_PATTERN, 'a decimal, as a string');
const currency = z.string().regex(BLOCK_CURRENCY_PATTERN, 'an ISO 4217 code');
const href = z.string().max(2048).regex(BLOCK_HREF_PATTERN, 'an in-app path');
const hue = z.enum(BLOCK_HUES);
const blockId = z.string().min(1).max(120).optional();
const percent = z.number().min(0).max(100);

const blockMoney = z
  .strictObject({ amountMinor: minor, currency })
  .meta({ id: 'BlockMoney', description: 'Money inside a block: integer minor units + currency.' });

const blockLabel = z
  .union([label, blockMoney])
  .meta({ id: 'BlockLabel', description: 'Words, or money (never pre-formatted).' });

const badgeVariant = z.enum(BLOCK_BADGE_VARIANTS);

const textBlock = z.strictObject({
  kind: z.literal('text'),
  id: blockId,
  content: longText,
  size: z.enum(BLOCK_TEXT_SIZES),
  weight: z.enum(BLOCK_TEXT_WEIGHTS).optional(),
  role: z.enum(BLOCK_TEXT_ROLES).optional(),
  narration: z
    .strictObject({
      status: z.enum(BLOCK_NARRATION_STATUSES),
      narratedBy: z
        .strictObject({ provider: z.enum(BLOCK_NARRATION_PROVIDERS), model: label })
        .nullable(),
      templateContent: longText,
    })
    .optional(),
});

const infoBlock = z.strictObject({
  kind: z.literal('info'),
  id: blockId,
  label,
  value: blockLabel.nullable(),
  hint: longText.optional(),
  withheld: longText.min(1).optional(),
});

const moneyBlock = z.strictObject({
  kind: z.literal('money'),
  id: blockId,
  label,
  amountMinor: minor.nullable(),
  currency,
  signColour: z.enum(BLOCK_SIGN_COLOURS).optional(),
  hint: longText.optional(),
  withheld: longText.min(1).optional(),
});

const horizontalBarsBlock = z.strictObject({
  kind: z.literal('horizontal-bars'),
  id: blockId,
  title: label.optional(),
  topRightLabel: blockLabel.optional(),
  bars: z.array(
    z.strictObject({
      label,
      hue,
      barPercent: percent,
      leftLabel: blockLabel.optional(),
      rightLabel: blockLabel,
      href: href.optional(),
    }),
  ),
  smallBarStyle: z.boolean().optional(),
});

const pieBlock = z.strictObject({
  kind: z.literal('pie'),
  id: blockId,
  title: label.optional(),
  currency: currency.nullable(),
  slices: z.array(z.strictObject({ label, value: minor, hue })),
});

const stackedBarsBlock = z.strictObject({
  kind: z.literal('stacked-bars'),
  id: blockId,
  title: label.optional(),
  currency: currency.nullable(),
  data: z.array(
    z.strictObject({
      x: label,
      total: minor,
      groups: z.array(
        z.strictObject({
          key: label,
          label,
          value: minor,
          hue,
          href: href.optional(),
          labelHref: href.optional(),
          count: z.int().nonnegative().optional(),
        }),
      ),
    }),
  ),
});

const sparklineRowBlock = z.strictObject({
  kind: z.literal('sparkline-row'),
  id: blockId,
  label,
  rightLabel: blockLabel.optional(),
  hue: hue.optional(),
  values: z.array(decimal),
  currency: currency.optional(),
  hideValueChange: z.boolean().optional(),
  title: label.optional(),
  largeStyle: z.boolean().optional(),
});

const meterBlock = z.strictObject({
  kind: z.literal('meter'),
  id: blockId,
  label,
  spentMinor: minor,
  budgetedMinor: minor,
  currency,
  tickPercent: percent.optional(),
  state: z.enum(BLOCK_METER_STATES),
});

const wireMoney = z.strictObject({ minor, currency });

const netWorthBlock = z.strictObject({
  kind: z.literal('net-worth'),
  id: blockId,
  title: label.optional(),
  currency,
  bucketing: z.enum(BLOCK_NET_WORTH_BUCKETINGS),
  buckets: z.array(
    z.strictObject({
      start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
      end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
      asOfDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/u)
        .nullable(),
      netWorth: wireMoney.nullable(),
      segments: z.array(
        z.strictObject({
          kind: z.enum(BLOCK_NET_WORTH_SEGMENT_KINDS),
          amount: wireMoney,
          accounts: z.int().nonnegative(),
        }),
      ),
      sealed: z.boolean(),
      source: z.string().nullable(),
    }),
  ),
});

const transactionsListBlock = z.strictObject({
  kind: z.literal('transactions-list'),
  id: blockId,
  title: label.optional(),
  transactionIds: z.array(z.uuid()).max(200),
});

const tableBlock = z.strictObject({
  kind: z.literal('table'),
  id: blockId,
  caption: label,
  columns: z
    .array(z.strictObject({ key: label, label, align: z.enum(BLOCK_TABLE_ALIGNS).optional() }))
    .min(1),
  rows: z.array(
    z.strictObject({
      key: label,
      cells: z.array(
        z.strictObject({
          value: blockLabel.nullable(),
          href: href.optional(),
          hrefLabel: label.optional(),
          badges: z.array(z.strictObject({ label, variant: badgeVariant })).optional(),
        }),
      ),
    }),
  ),
});

const badgeBlock = z.strictObject({
  kind: z.literal('badge'),
  id: blockId,
  label,
  variant: badgeVariant,
});

const ctaBlock = z.strictObject({
  kind: z.literal('cta'),
  id: blockId,
  label,
  href,
  variant: z.enum(BLOCK_CTA_VARIANTS),
});

const dividerBlock = z.strictObject({ kind: z.literal('divider'), id: blockId });

/**
 * `group` is the one recursive kind; Zod 4's getter defers the reference until the union exists. The depth cap and
 * the cross-field rules are one `superRefine` over the whole union (kernel `blockRuleProblems`).
 */
const groupBlock = z.strictObject({
  kind: z.literal('group'),
  id: blockId,
  title: label.optional(),
  get blocks(): z.ZodArray<typeof blockSchema> {
    return z.array(blockSchema);
  },
});

export const blockSchema: z.ZodType<Block> = z
  .discriminatedUnion('kind', [
    textBlock,
    infoBlock,
    moneyBlock,
    horizontalBarsBlock,
    pieBlock,
    stackedBarsBlock,
    sparklineRowBlock,
    meterBlock,
    netWorthBlock,
    transactionsListBlock,
    tableBlock,
    badgeBlock,
    ctaBlock,
    dividerBlock,
    groupBlock,
  ])
  .superRefine((block, context) => {
    for (const problem of blockRuleProblems(block as Block)) {
      context.addIssue({ code: 'custom', message: problem });
    }
    if (block.kind === 'group' && blockDepth(block as Block) > BLOCK_MAX_DEPTH) {
      context.addIssue({
        code: 'custom',
        message: `groups nest at most ${String(BLOCK_MAX_DEPTH)} deep`,
      });
    }
  })
  .meta({
    id: 'Block',
    description:
      'One server-built block (docs/design/blocks.md). Money is minor units + currency; colours are hue or ' +
      'role names; hrefs are in-app paths; a withheld figure carries its reason.',
  }) as unknown as z.ZodType<Block>;

export const blockDocumentSchema = z
  .strictObject({
    contractVersion: z.literal(BLOCK_CONTRACT_VERSION),
    blocks: z.array(blockSchema),
  })
  .meta({ id: 'BlockDocument', description: 'A versioned list of blocks (`contractVersion` 1).' });

/**
 * Wrap a builder's blocks for the wire, parsing every one: a builder bug (a hex, an external href, a stacked total
 * that is not its sum) is a 500 here, never a block on the screen.
 */
export type BlockDocumentWire = z.infer<typeof blockDocumentSchema>;

export function blockDocument(blocks: readonly Block[]): BlockDocumentWire {
  return blockDocumentSchema.parse({ contractVersion: BLOCK_CONTRACT_VERSION, blocks });
}
