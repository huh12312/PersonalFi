// SPDX-License-Identifier: MIT
/**
 * Category emoji (WP 10.14, docs/research/10-visual-design-notes.md §1.4 "Transactions" and §3 V7 —
 * Monarch's equivalent).
 *
 * Two things live here because the server and the web must agree on them byte for byte, as with `hueForId`:
 *
 *  - **`isSingleEmoji`**, the one rule for what `categories.emoji` may hold (migration 0050): exactly one extended
 *    grapheme cluster (`Intl.Segmenter`), every code point of it an emoji code point, at least one of them
 *    pictographic (or a flag / keycap), and at most `MAX_EMOJI_CODE_POINTS` code points (the column's CHECK).
 *    `@ctx/categorization` refuses anything else before the write; the category editor refuses it before the
 *    request.
 *  - **`CATEGORY_DEFAULT_EMOJI`**, the display fallback for the shipped taxonomy, keyed by the stable category key.
 *    It is **never written**: a NULL `emoji` stays NULL, and the web draws the default only when there is no stored
 *    value. A custom category has no key here and keeps its two-letter initials.
 */

/** `char_length(emoji) <= 8` in 0050: one grapheme can be several code points (ZWJ sequences, skin tones, tags). */
export const MAX_EMOJI_CODE_POINTS = 8;

/**
 * The code points an emoji grapheme may be built from: pictographs, skin-tone modifiers, the emoji components
 * (regional indicators, keycap bases and U+20E3, tag characters, hair components), ZWJ and VS16. A letter, a
 * combining accent or a space is none of these.
 */
const EMOJI_CODE_POINTS =
  /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Emoji_Component}|‍|️)+$/u;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const FLAG = /^\p{Regional_Indicator}{2}$/u;
const KEYCAP = /^[0-9#*]️?⃣$/u;

let segmenter: Intl.Segmenter | null = null;

function graphemeCount(value: string): number {
  segmenter ??= new Intl.Segmenter('en', { granularity: 'grapheme' });
  let count = 0;
  for (const _segment of segmenter.segment(value)) count += 1;
  return count;
}

/**
 * True when `value` is exactly one emoji: one extended grapheme cluster, made only of emoji code points, carrying a
 * pictograph (or being a flag or a keycap), and no longer than the column allows. `"1"`, `"ab"`, `"🛒🛒"`, `""` and
 * `" 🛒"` are all false; `"🛒"`, `"🍽️"`, `"👩🏽‍💻"`, `"👨‍👩‍👧‍👦"`, `"🇨🇦"` and `"1️⃣"` are true.
 */
export function isSingleEmoji(value: string): boolean {
  if (value.length === 0) return false;
  if ([...value].length > MAX_EMOJI_CODE_POINTS) return false;
  if (!EMOJI_CODE_POINTS.test(value)) return false;
  if (!(PICTOGRAPHIC.test(value) || FLAG.test(value) || KEYCAP.test(value))) return false;
  return graphemeCount(value) === 1;
}

/**
 * The default emoji per shipped category key (`packages/contexts/categorization/src/taxonomy.ts`). Every key of the
 * taxonomy has one — `@ctx/categorization`'s `taxonomy.test.ts` asserts it, and that each value passes
 * `isSingleEmoji`. A display fallback only; recorded in `docs/evidence/phase-10/wp10.14-category-detail.md` §1.
 */
export const CATEGORY_DEFAULT_EMOJI: Readonly<Record<string, string>> = Object.freeze({
  income: '💰',
  'income.salary': '💰',
  'income.self_employment': '💼',
  'income.investment_income': '📈',
  'income.retirement_income': '🏖️',
  'income.benefits': '🤝',
  'income.rental_income': '🏘️',
  'income.refunds_and_rebates': '↩️',
  'income.other_income': '💵',

  transfers: '🔁',
  'transfers.between_accounts': '🔁',
  'transfers.credit_card_payment': '💳',
  'transfers.cash_withdrawal': '🏧',
  'transfers.cash_deposit': '🏦',
  'transfers.wire': '🌐',
  'transfers.payment_apps': '📲',
  'transfers.crypto': '🪙',
  'transfers.loan_proceeds': '📥',
  'transfers.other_transfer': '🔀',

  investments: '📈',
  'investments.brokerage': '📊',
  'investments.retirement': '🧓',
  'investments.savings': '🐷',
  'investments.crypto_purchase': '🪙',
  'investments.other_investment': '💹',

  housing: '🏠',
  'housing.rent': '🏠',
  'housing.property_tax': '🏛️',
  'housing.hoa_and_fees': '🏢',
  'housing.storage': '📦',
  'housing.other_housing': '🏡',

  utilities: '💡',
  'utilities.electricity_and_gas': '💡',
  'utilities.water': '🚰',
  'utilities.waste': '♻️',
  'utilities.internet': '📡',
  'utilities.mobile_phone': '📱',
  'utilities.other_utilities': '🔌',

  groceries: '🛒',
  'groceries.supermarkets': '🛒',
  'groceries.convenience': '🏪',
  'groceries.specialty_food': '🧀',
  'groceries.alcohol': '🍷',
  'groceries.other_groceries': '🥕',

  dining: '🍽️',
  'dining.restaurants': '🍽️',
  'dining.fast_food': '🍔',
  'dining.coffee': '☕',
  'dining.bars': '🍺',
  'dining.delivery': '🥡',
  'dining.other_dining': '🍴',

  transport: '🚗',
  'transport.fuel': '⛽',
  'transport.public_transit': '🚆',
  'transport.rideshare': '🚕',
  'transport.parking': '🅿️',
  'transport.tolls': '🛣️',
  'transport.auto_service': '🔧',
  'transport.micromobility': '🚲',
  'transport.other_transport': '🚙',

  travel: '✈️',
  'travel.flights': '✈️',
  'travel.lodging': '🏨',
  'travel.car_rental': '🚘',
  'travel.activities': '🗺️',
  'travel.other_travel': '🧳',

  shopping: '🛍️',
  'shopping.clothing': '👕',
  'shopping.electronics': '💻',
  'shopping.general_merchandise': '🛍️',
  'shopping.online_marketplaces': '📦',
  'shopping.books_and_media': '📚',
  'shopping.gifts': '🎁',
  'shopping.hobbies': '⚽',
  'shopping.office_supplies': '📎',
  'shopping.shipping': '📮',
  'shopping.tobacco_and_vape': '🚬',
  'shopping.other_shopping': '🏷️',

  home: '🪴',
  'home.furniture': '🛋️',
  'home.hardware': '🔨',
  'home.repairs': '🧰',
  'home.security': '🔒',
  'home.garden': '🌱',
  'home.other_home': '🪴',

  health: '🩺',
  'health.primary_care': '🩺',
  'health.specialists': '🏥',
  'health.dental': '🦷',
  'health.vision': '👓',
  'health.pharmacy': '💊',
  'health.mental_health': '🧠',
  'health.nursing_care': '🛏️',
  'health.other_health': '❤️‍🩹',

  personal_care: '🧴',
  'personal_care.hair_and_beauty': '💇',
  'personal_care.spa': '🧖',
  'personal_care.fitness': '🏋️',
  'personal_care.laundry': '🧺',
  'personal_care.other_personal_care': '🧴',

  entertainment: '🎬',
  'entertainment.streaming': '📺',
  'entertainment.music': '🎵',
  'entertainment.games': '🎮',
  'entertainment.events': '🎟️',
  'entertainment.gambling': '🎰',
  'entertainment.other_entertainment': '🎭',

  subscriptions: '📺',
  'subscriptions.software': '💾',
  'subscriptions.cloud_storage': '☁️',
  'subscriptions.news': '📰',
  'subscriptions.memberships': '🪪',
  'subscriptions.other_subscriptions': '🔄',

  education: '🎓',
  'education.tuition': '🎓',
  'education.supplies': '✏️',
  'education.courses': '🧑‍🏫',
  'education.other_education': '📖',

  family: '👪',
  'family.childcare': '🧸',
  'family.child_activities': '🎨',
  'family.pets': '🐾',
  'family.pet_medical': '🐕',
  'family.elder_care': '👵',
  'family.support': '🫶',
  'family.other_family': '👪',

  insurance: '🛡️',
  'insurance.health': '🛡️',
  'insurance.auto': '🚗',
  'insurance.home': '🏠',
  'insurance.life': '🛟',
  'insurance.other_insurance': '🛡️',

  fees_and_services: '🧾',
  'fees_and_services.bank_fees': '🧾',
  'fees_and_services.atm_fees': '🏧',
  'fees_and_services.interest_charges': '💸',
  'fees_and_services.foreign_fees': '💱',
  'fees_and_services.advisory': '🧮',
  'fees_and_services.legal': '⚖️',
  'fees_and_services.other_fees': '🧾',

  debt: '💳',
  'debt.mortgage': '🏠',
  'debt.auto_loan': '🚗',
  'debt.student_loan': '🎓',
  'debt.personal_loan': '🤝',
  'debt.bnpl': '🗓️',
  'debt.other_debt': '💳',

  giving_and_taxes: '🎗️',
  'giving_and_taxes.donations': '💝',
  'giving_and_taxes.taxes': '🏛️',
  'giving_and_taxes.government_fees': '📜',
  'giving_and_taxes.other_giving': '🎗️',

  uncategorised: '❔',
});

/** The default emoji for a shipped category key, or null for a custom category (it keeps its initials). */
export function defaultEmojiForKey(key: string): string | null {
  return Object.hasOwn(CATEGORY_DEFAULT_EMOJI, key) ? (CATEGORY_DEFAULT_EMOJI[key] ?? null) : null;
}
