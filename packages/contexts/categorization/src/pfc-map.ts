// SPDX-License-Identifier: MIT
/**
 * Plaid PFC v2 → our taxonomy.
 *
 * ## What is and is not in this file
 *
 * **Codes only.** A PFC code is an identifier a wire protocol uses to name a
 * thing; it is not Plaid's prose. Their taxonomy CSV also carries a one-line
 * description for every row, and none of that text is here, paraphrased or
 * otherwise: 02 §4.4 found no license grant on that document and their ToS
 * reserves all rights. The right-hand side of every pair below is one of *our*
 * keys from `taxonomy.ts`, whose labels and descriptions we wrote.
 *
 * The code list was checked against the primary source
 * (`plaid.com/documents/pfc-taxonomy-all.csv`) on 2026-09-13 and matches what
 * 01 §5.4 verified on 2026-09-10: **18 primary, 127 detailed**. `taxonomy.test.ts`
 * asserts those two counts and asserts every value resolves to an assignable
 * leaf, so a hand edit that drops a code fails the suite rather than silently
 * routing a category to `uncategorised`.
 *
 * ## Judgement calls worth arguing with
 *
 * Three mappings deliberately disagree with Plaid's filing, because the product
 * question and the enrichment question have different right answers:
 *
 *   * `LOAN_PAYMENTS_CREDIT_CARD_PAYMENT` → `transfers.credit_card_payment`.
 *     Plaid files it as a loan payment. Counting it as spend double-counts every
 *     card purchase, which is precisely the Phase 1 exit criterion ("spend totals
 *     contain zero internal transfers").
 *   * `LOAN_DISBURSEMENTS_*` → `transfers.loan_proceeds`. Borrowed cash is not
 *     income; cash went up and a liability went up with it. Filing it as income
 *     would flatter every projection Phase 4 builds on it.
 *   * `TRANSFER_OUT_SAVINGS` and `TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS`
 *     → `investments.*`. Money you still own is not money you spent, and a user
 *     who sees "saving" filed under "transfers" cannot tell the two apart in a
 *     report.
 *
 * The provider tier is the fourth of six in the decision order, so a user rule or
 * a learned merchant default overrides any of these without an argument.
 */

/** The 18 PFC v2 primaries, for when `detailed` is absent or unrecognised. */
export const PFC_PRIMARY_TO_KEY: ReadonlyMap<string, string> = new Map([
  ['INCOME', 'income.other_income'],
  ['LOAN_DISBURSEMENTS', 'transfers.loan_proceeds'],
  ['LOAN_PAYMENTS', 'debt.other_debt'],
  ['TRANSFER_IN', 'transfers.other_transfer'],
  ['TRANSFER_OUT', 'transfers.other_transfer'],
  ['BANK_FEES', 'fees_and_services.other_fees'],
  ['ENTERTAINMENT', 'entertainment.other_entertainment'],
  ['FOOD_AND_DRINK', 'dining.other_dining'],
  ['GENERAL_MERCHANDISE', 'shopping.other_shopping'],
  ['HOME_IMPROVEMENT', 'home.other_home'],
  ['MEDICAL', 'health.other_health'],
  ['PERSONAL_CARE', 'personal_care.other_personal_care'],
  ['GENERAL_SERVICES', 'fees_and_services.other_fees'],
  ['GOVERNMENT_AND_NON_PROFIT', 'giving_and_taxes.other_giving'],
  ['TRANSPORTATION', 'transport.other_transport'],
  ['TRAVEL', 'travel.other_travel'],
  ['RENT_AND_UTILITIES', 'utilities.other_utilities'],
  ['OTHER', 'uncategorised'],
]);

/**
 * All 127 PFC v2 detailed codes, grouped by primary in the source's own order so
 * a future revision diffs cleanly against a fresh download.
 */
export const PFC_DETAILED_TO_KEY: ReadonlyMap<string, string> = new Map([
  // INCOME
  ['INCOME_CHILD_SUPPORT', 'income.benefits'],
  ['INCOME_CONTRACTOR', 'income.self_employment'],
  ['INCOME_DIVIDENDS', 'income.investment_income'],
  ['INCOME_GIG_ECONOMY', 'income.self_employment'],
  ['INCOME_INTEREST_EARNED', 'income.investment_income'],
  ['INCOME_LONG_TERM_DISABILITY', 'income.benefits'],
  ['INCOME_MILITARY', 'income.salary'],
  ['INCOME_RENTAL', 'income.rental_income'],
  ['INCOME_RETIREMENT_PENSION', 'income.retirement_income'],
  ['INCOME_SALARY', 'income.salary'],
  ['INCOME_TAX_REFUND', 'income.refunds_and_rebates'],
  ['INCOME_UNEMPLOYMENT', 'income.benefits'],
  ['INCOME_OTHER', 'income.other_income'],
  // LOAN_DISBURSEMENTS
  ['LOAN_DISBURSEMENTS_AUTO', 'transfers.loan_proceeds'],
  ['LOAN_DISBURSEMENTS_CASH_ADVANCES', 'transfers.loan_proceeds'],
  ['LOAN_DISBURSEMENTS_EWA', 'transfers.loan_proceeds'],
  ['LOAN_DISBURSEMENTS_MORTGAGE', 'transfers.loan_proceeds'],
  ['LOAN_DISBURSEMENTS_PERSONAL', 'transfers.loan_proceeds'],
  ['LOAN_DISBURSEMENTS_STUDENT', 'transfers.loan_proceeds'],
  ['LOAN_DISBURSEMENTS_OTHER_DISBURSEMENT', 'transfers.loan_proceeds'],
  // LOAN_PAYMENTS
  ['LOAN_PAYMENTS_BNPL', 'debt.bnpl'],
  ['LOAN_PAYMENTS_CAR_PAYMENT', 'debt.auto_loan'],
  ['LOAN_PAYMENTS_CASH_ADVANCES', 'debt.other_debt'],
  ['LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'transfers.credit_card_payment'],
  ['LOAN_PAYMENTS_EWA', 'debt.other_debt'],
  ['LOAN_PAYMENTS_MORTGAGE_PAYMENT', 'debt.mortgage'],
  ['LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT', 'debt.personal_loan'],
  ['LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT', 'debt.student_loan'],
  ['LOAN_PAYMENTS_OTHER_PAYMENT', 'debt.other_debt'],
  // TRANSFER_IN
  ['TRANSFER_IN_ACCOUNT_TRANSFER', 'transfers.between_accounts'],
  ['TRANSFER_IN_DEPOSIT', 'transfers.cash_deposit'],
  ['TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS', 'transfers.between_accounts'],
  ['TRANSFER_IN_SAVINGS', 'transfers.between_accounts'],
  ['TRANSFER_IN_TRANSFER_IN_FROM_APPS', 'transfers.payment_apps'],
  ['TRANSFER_IN_WIRE', 'transfers.wire'],
  ['TRANSFER_IN_OTHER_TRANSFER_IN', 'transfers.other_transfer'],
  // TRANSFER_OUT
  ['TRANSFER_OUT_ACCOUNT_TRANSFER', 'transfers.between_accounts'],
  ['TRANSFER_OUT_CRYPTO', 'transfers.crypto'],
  ['TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS', 'investments.retirement'],
  ['TRANSFER_OUT_SAVINGS', 'investments.savings'],
  ['TRANSFER_OUT_TRANSFER_OUT_FROM_APPS', 'transfers.payment_apps'],
  ['TRANSFER_OUT_WIRE', 'transfers.wire'],
  ['TRANSFER_OUT_WITHDRAWAL', 'transfers.cash_withdrawal'],
  ['TRANSFER_OUT_OTHER_TRANSFER_OUT', 'transfers.other_transfer'],
  // BANK_FEES
  ['BANK_FEES_ATM_FEES', 'fees_and_services.atm_fees'],
  ['BANK_FEES_INSUFFICIENT_FUNDS', 'fees_and_services.bank_fees'],
  ['BANK_FEES_INTEREST_CHARGE', 'fees_and_services.interest_charges'],
  ['BANK_FEES_FOREIGN_TRANSACTION_FEES', 'fees_and_services.foreign_fees'],
  ['BANK_FEES_OVERDRAFT_FEES', 'fees_and_services.bank_fees'],
  ['BANK_FEES_LATE_FEES', 'fees_and_services.bank_fees'],
  ['BANK_FEES_CASH_ADVANCE', 'fees_and_services.bank_fees'],
  ['BANK_FEES_OTHER_BANK_FEES', 'fees_and_services.other_fees'],
  // ENTERTAINMENT
  ['ENTERTAINMENT_CASINOS_AND_GAMBLING', 'entertainment.gambling'],
  ['ENTERTAINMENT_MUSIC_AND_AUDIO', 'entertainment.music'],
  ['ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS', 'entertainment.events'],
  ['ENTERTAINMENT_TV_AND_MOVIES', 'entertainment.streaming'],
  ['ENTERTAINMENT_VIDEO_GAMES', 'entertainment.games'],
  ['ENTERTAINMENT_OTHER_ENTERTAINMENT', 'entertainment.other_entertainment'],
  // FOOD_AND_DRINK
  ['FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR', 'groceries.alcohol'],
  ['FOOD_AND_DRINK_COFFEE', 'dining.coffee'],
  ['FOOD_AND_DRINK_FAST_FOOD', 'dining.fast_food'],
  ['FOOD_AND_DRINK_GROCERIES', 'groceries.supermarkets'],
  ['FOOD_AND_DRINK_RESTAURANT', 'dining.restaurants'],
  ['FOOD_AND_DRINK_VENDING_MACHINES', 'dining.other_dining'],
  ['FOOD_AND_DRINK_OTHER_FOOD_AND_DRINK', 'dining.other_dining'],
  // GENERAL_MERCHANDISE
  ['GENERAL_MERCHANDISE_BOOKSTORES_AND_NEWSSTANDS', 'shopping.books_and_media'],
  ['GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES', 'shopping.clothing'],
  ['GENERAL_MERCHANDISE_CONVENIENCE_STORES', 'groceries.convenience'],
  ['GENERAL_MERCHANDISE_DEPARTMENT_STORES', 'shopping.general_merchandise'],
  ['GENERAL_MERCHANDISE_DISCOUNT_STORES', 'shopping.general_merchandise'],
  ['GENERAL_MERCHANDISE_ELECTRONICS', 'shopping.electronics'],
  ['GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES', 'shopping.gifts'],
  ['GENERAL_MERCHANDISE_OFFICE_SUPPLIES', 'shopping.office_supplies'],
  ['GENERAL_MERCHANDISE_ONLINE_MARKETPLACES', 'shopping.online_marketplaces'],
  ['GENERAL_MERCHANDISE_PET_SUPPLIES', 'family.pets'],
  ['GENERAL_MERCHANDISE_SPORTING_GOODS', 'shopping.hobbies'],
  ['GENERAL_MERCHANDISE_SUPERSTORES', 'shopping.general_merchandise'],
  ['GENERAL_MERCHANDISE_TOBACCO_AND_VAPE', 'shopping.tobacco_and_vape'],
  ['GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE', 'shopping.other_shopping'],
  // HOME_IMPROVEMENT
  ['HOME_IMPROVEMENT_FURNITURE', 'home.furniture'],
  ['HOME_IMPROVEMENT_HARDWARE', 'home.hardware'],
  ['HOME_IMPROVEMENT_REPAIR_AND_MAINTENANCE', 'home.repairs'],
  ['HOME_IMPROVEMENT_SECURITY', 'home.security'],
  ['HOME_IMPROVEMENT_OTHER_HOME_IMPROVEMENT', 'home.other_home'],
  // MEDICAL
  ['MEDICAL_DENTAL_CARE', 'health.dental'],
  ['MEDICAL_EYE_CARE', 'health.vision'],
  ['MEDICAL_NURSING_CARE', 'health.nursing_care'],
  ['MEDICAL_PHARMACIES_AND_SUPPLEMENTS', 'health.pharmacy'],
  ['MEDICAL_PRIMARY_CARE', 'health.primary_care'],
  ['MEDICAL_VETERINARY_SERVICES', 'family.pet_medical'],
  ['MEDICAL_OTHER_MEDICAL', 'health.other_health'],
  // PERSONAL_CARE
  ['PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS', 'personal_care.fitness'],
  ['PERSONAL_CARE_HAIR_AND_BEAUTY', 'personal_care.hair_and_beauty'],
  ['PERSONAL_CARE_LAUNDRY_AND_DRY_CLEANING', 'personal_care.laundry'],
  ['PERSONAL_CARE_OTHER_PERSONAL_CARE', 'personal_care.other_personal_care'],
  // GENERAL_SERVICES
  ['GENERAL_SERVICES_ACCOUNTING_AND_FINANCIAL_PLANNING', 'fees_and_services.advisory'],
  ['GENERAL_SERVICES_AUTOMOTIVE', 'transport.auto_service'],
  ['GENERAL_SERVICES_CHILDCARE', 'family.childcare'],
  ['GENERAL_SERVICES_CONSULTING_AND_LEGAL', 'fees_and_services.legal'],
  ['GENERAL_SERVICES_EDUCATION', 'education.tuition'],
  ['GENERAL_SERVICES_INSURANCE', 'insurance.other_insurance'],
  ['GENERAL_SERVICES_POSTAGE_AND_SHIPPING', 'shopping.shipping'],
  ['GENERAL_SERVICES_STORAGE', 'housing.storage'],
  ['GENERAL_SERVICES_OTHER_GENERAL_SERVICES', 'fees_and_services.other_fees'],
  // GOVERNMENT_AND_NON_PROFIT
  ['GOVERNMENT_AND_NON_PROFIT_DONATIONS', 'giving_and_taxes.donations'],
  [
    'GOVERNMENT_AND_NON_PROFIT_GOVERNMENT_DEPARTMENTS_AND_AGENCIES',
    'giving_and_taxes.government_fees',
  ],
  ['GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT', 'giving_and_taxes.taxes'],
  ['GOVERNMENT_AND_NON_PROFIT_OTHER_GOVERNMENT_AND_NON_PROFIT', 'giving_and_taxes.other_giving'],
  // TRANSPORTATION
  ['TRANSPORTATION_BIKES_AND_SCOOTERS', 'transport.micromobility'],
  ['TRANSPORTATION_GAS', 'transport.fuel'],
  ['TRANSPORTATION_PARKING', 'transport.parking'],
  ['TRANSPORTATION_PUBLIC_TRANSIT', 'transport.public_transit'],
  ['TRANSPORTATION_TAXIS_AND_RIDE_SHARES', 'transport.rideshare'],
  ['TRANSPORTATION_TOLLS', 'transport.tolls'],
  ['TRANSPORTATION_OTHER_TRANSPORTATION', 'transport.other_transport'],
  // TRAVEL
  ['TRAVEL_FLIGHTS', 'travel.flights'],
  ['TRAVEL_LODGING', 'travel.lodging'],
  ['TRAVEL_RENTAL_CARS', 'travel.car_rental'],
  ['TRAVEL_OTHER_TRAVEL', 'travel.other_travel'],
  // RENT_AND_UTILITIES
  ['RENT_AND_UTILITIES_GAS_AND_ELECTRICITY', 'utilities.electricity_and_gas'],
  ['RENT_AND_UTILITIES_INTERNET_AND_CABLE', 'utilities.internet'],
  ['RENT_AND_UTILITIES_RENT', 'housing.rent'],
  ['RENT_AND_UTILITIES_SEWAGE_AND_WASTE_MANAGEMENT', 'utilities.waste'],
  ['RENT_AND_UTILITIES_TELEPHONE', 'utilities.mobile_phone'],
  ['RENT_AND_UTILITIES_WATER', 'utilities.water'],
  ['RENT_AND_UTILITIES_OTHER_UTILITIES', 'utilities.other_utilities'],
  // OTHER
  ['OTHER_OTHER', 'uncategorised'],
]);

/** How many codes this file claims to cover. Asserted by a test, not assumed. */
export const PFC_PRIMARY_COUNT = 18;
export const PFC_DETAILED_COUNT = 127;

/**
 * The provider category as it reaches us on `transactions_provider.provider_category`.
 *
 * Deliberately tolerant: the column is `jsonb` holding whatever the adapter wrote,
 * and a shape assertion that throws on the read path would turn one odd row from a
 * provider into a failed sync page.
 */
export interface ProviderCategoryHint {
  readonly primary: string | null;
  readonly detailed: string | null;
  readonly confidenceLevel: string | null;
}

const CONFIDENCE_BY_LEVEL: ReadonlyMap<string, number> = new Map([
  ['VERY_HIGH', 0.95],
  ['HIGH', 0.85],
  ['MEDIUM', 0.7],
  ['LOW', 0.55],
  ['UNKNOWN', 0.5],
]);

/** Read the jsonb blob without trusting it. Returns nulls rather than throwing. */
export function readProviderCategory(raw: unknown): ProviderCategoryHint | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const primary = typeof record['primary'] === 'string' ? record['primary'] : null;
  const detailed = typeof record['detailed'] === 'string' ? record['detailed'] : null;
  const snake = record['confidence_level'];
  const camel = record['confidenceLevel'];
  const level = typeof snake === 'string' ? snake : typeof camel === 'string' ? camel : null;
  if (primary === null && detailed === null) return null;
  return { primary, detailed, confidenceLevel: level };
}

export interface ProviderMatch {
  readonly categoryKey: string;
  /** Which code actually decided it, for the evidence trail. */
  readonly matchedCode: string;
  readonly matchedOn: 'detailed' | 'primary';
  readonly confidence: number;
}

/**
 * Resolve a provider hint to one of our keys.
 *
 * Detailed first, primary as the fallback, `null` when neither is a code we know —
 * which is the honest answer, and lets the classifier tier have its turn instead
 * of the engine inventing a category from a string it does not recognise.
 *
 * Plaid's own `confidence_level` is carried through and then capped: a
 * primary-only match never scores above 0.6 however sure the provider claims to
 * be, because "this is food and drink" is a weaker statement than "this is a
 * coffee shop", and a number a budget shows should say so.
 */
export function matchProviderCategory(hint: ProviderCategoryHint | null): ProviderMatch | null {
  if (hint === null) return null;
  const level = hint.confidenceLevel?.toUpperCase() ?? 'UNKNOWN';
  const base = CONFIDENCE_BY_LEVEL.get(level) ?? 0.5;

  if (hint.detailed !== null) {
    const key = PFC_DETAILED_TO_KEY.get(hint.detailed.toUpperCase());
    if (key !== undefined) {
      return {
        categoryKey: key,
        matchedCode: hint.detailed.toUpperCase(),
        matchedOn: 'detailed',
        confidence: base,
      };
    }
  }
  if (hint.primary !== null) {
    const key = PFC_PRIMARY_TO_KEY.get(hint.primary.toUpperCase());
    if (key !== undefined) {
      return {
        categoryKey: key,
        matchedCode: hint.primary.toUpperCase(),
        matchedOn: 'primary',
        confidence: Math.min(base, 0.6),
      };
    }
  }
  return null;
}
