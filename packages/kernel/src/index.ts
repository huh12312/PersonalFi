// SPDX-License-Identifier: MIT
/**
 * `@core/kernel` — the shared kernel.
 *
 * Owns no tables, imports no infrastructure, holds no business rules. Only the
 * types every bounded context must agree on. Adding something here is a
 * cross-cutting decision: if you are tempted to, it probably belongs in a context.
 *
 * The public surface is deliberately namespaced (`Money.add`, `DateOnly.addDays`)
 * rather than a flat spray of `add`/`compare`/`format`, because a shared kernel
 * that exports generic verbs becomes unimportable the first time two of them clash.
 */
export type { Brand } from './brand.ts';
export { KernelError, CurrencyMismatchError, InvalidValueError } from './errors.ts';
export { currency, isCurrencyCode, minorUnitScale, USD, type CurrencyCode } from './currency.ts';
export { Money, money, type MoneyJson, type RoundingMode } from './money.ts';
export {
  Quantity,
  quantity,
  ZERO_QUANTITY,
  QUANTITY_SCALE,
  QUANTITY_PRECISION,
  QUANTITY_MAX_INTEGER_DIGITS,
} from './quantity.ts';
export { DateOnly, dateOnly, parseDateOnly } from './date-only.ts';
export {
  systemClock,
  fixedClock,
  mutableClock,
  todayIn,
  type Clock,
  type MutableClock,
} from './clock.ts';
export {
  newId,
  parseId,
  isUuid,
  isUuidV7,
  timestampOfUuidV7,
  type Id,
  type UserId,
  type AccountId,
  type TransactionId,
  type ConnectionId,
  type CategoryId,
  type SecurityId,
  type InsightId,
  type EventId,
} from './ids.ts';
export {
  Stats,
  medianMinor,
  twiceMedianMinor,
  madMinor,
  medianNumber,
  madNumber,
} from './stats.ts';
export { CHART_HUES, isChartHue, hueForId, type ChartHue } from './hue.ts';
export {
  CATEGORY_DEFAULT_EMOJI,
  MAX_EMOJI_CODE_POINTS,
  defaultEmojiForKey,
  isSingleEmoji,
} from './emoji.ts';
export {
  BLOCK_CONTRACT_VERSION,
  BLOCK_KINDS,
  BLOCK_TEXT_SIZES,
  BLOCK_TEXT_WEIGHTS,
  BLOCK_TEXT_ROLES,
  BLOCK_HUES,
  BLOCK_BADGE_VARIANTS,
  BLOCK_CTA_VARIANTS,
  BLOCK_SIGN_COLOURS,
  BLOCK_METER_STATES,
  BLOCK_NET_WORTH_BUCKETINGS,
  BLOCK_NET_WORTH_SEGMENT_KINDS,
  BLOCK_NARRATION_STATUSES,
  BLOCK_NARRATION_PROVIDERS,
  BLOCK_TABLE_ALIGNS,
  BLOCK_MINOR_PATTERN,
  BLOCK_DECIMAL_PATTERN,
  BLOCK_CURRENCY_PATTERN,
  BLOCK_HREF_PATTERN,
  BLOCK_TEXT_MAX,
  BLOCK_LABEL_MAX,
  BLOCK_MAX_DEPTH,
  BLOCK_FIXTURES,
  blockDepth,
  blockRuleProblems,
  isBlockHue,
  isBlockKind,
  isInAppHref,
  type Block,
  type BlockBadgeVariant,
  type BlockDocument,
  type BlockHue,
  type BlockKind,
  type BlockLabel,
  type BlockMeterState,
  type BlockMoney,
  type BlockNarration,
  type BadgeBlock,
  type CtaBlock,
  type DividerBlock,
  type GroupBlock,
  type HorizontalBar,
  type HorizontalBarsBlock,
  type InfoBlock,
  type MeterBlock,
  type MoneyBlock,
  type NetWorthBlock,
  type NetWorthBucketWire,
  type PieBlock,
  type SparklineRowBlock,
  type StackedBarGroup,
  type StackedBarsBlock,
  type TableBlock,
  type TableCell,
  type TextBlock,
  type TransactionsListBlock,
} from './blocks.ts';
