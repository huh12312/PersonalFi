// SPDX-License-Identifier: MIT
/**
 * The system taxonomy: our own two-level chart of categories.
 *
 * ## Why we author this rather than adopt Plaid's
 *
 * Decision D15 and 02 §4.4: Plaid's PFC CSV carries **no license grant** and their
 * ToS reserves all rights, so their labels and their one-line descriptions are not
 * ours to ship. Their *structure* — a small set of primaries, each with a handful
 * of detailed children and an explicit `OTHER_*` escape hatch — is a good shape and
 * is not itself copyrightable, so it is the blueprint. Every string below is
 * written here, for this app, in this app's voice.
 *
 * Risk R13 is the other half of the argument: "Plaid taxonomy changes retroactively
 * shift history". The provider's category is stored immutable on the fact row and
 * reaches a user's budget only through `PFC_TO_KEY` (`pfc-map.ts`), which is a
 * table we control. When Plaid revises PFC again, that table changes and this one
 * does not, so a budget from March still means in December what it meant in March.
 *
 * ## Shape
 *
 * Exactly two levels, always. A third level is a rabbit hole with no bottom, and
 * every report in 07 §3 groups on level one or level two. A top-level category is
 * never assigned to a transaction directly by the engine — leaves are where the
 * money lands — with the single exception of `uncategorised`, which has no
 * children because "we do not know" does not decompose.
 *
 * ## `kind`, and why a credit-card payment is a transfer
 *
 * `kind` is what every downstream aggregate switches on, and it is the reason the
 * Phase 1 exit criterion ("spend totals contain zero internal transfers") is
 * mechanical rather than a matter of remembering to filter:
 *
 *   * `expense`    — money left the household. Counts in spend totals and budgets.
 *   * `income`     — money entered the household. Counts in income totals.
 *   * `transfer`   — money moved between accounts the user owns. Counts in
 *                    **neither**. Paying a credit-card bill is this, even though
 *                    PFC files it under loan payments: the spend already happened
 *                    when the card was swiped, and counting the payment too is how
 *                    a month of card spending gets double-counted.
 *   * `investment` — money moved into a position the user still owns. Not spend;
 *                    tracked separately so "saved" and "spent" never blur.
 *   * `other`      — `uncategorised` only.
 *
 * A loan *disbursement* is a `transfer` for the same reason: cash went up and a
 * liability went up with it, and the household is no richer. Calling it income
 * would flatter every projection in Phase 4.
 */

/** What a category does to an aggregate. See the file header. */
export type CategoryKind = 'income' | 'expense' | 'transfer' | 'investment' | 'other';

export interface TaxonomyNode {
  /** Stable, forever. The mapping tables and every test key on this, not on the id. */
  readonly key: string;
  readonly label: string;
  /** One line, ours, shown under the label in the category picker. */
  readonly description: string;
  readonly kind: CategoryKind;
  /** A Lucide icon name (decision D20). Stored as a key, never as markup. */
  readonly icon: string;
  readonly children: readonly TaxonomyLeaf[];
}

export interface TaxonomyLeaf {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  /** Omitted when the leaf agrees with its parent, which is the usual case. */
  readonly kind?: CategoryKind;
}

/** The key the engine falls back to when every tier abstains. */
export const UNCATEGORISED_KEY = 'uncategorised' as const;

export const TAXONOMY: readonly TaxonomyNode[] = Object.freeze([
  {
    key: 'income',
    label: 'Income',
    description: 'Money arriving from work, benefits, or assets you own.',
    kind: 'income',
    icon: 'banknote-arrow-down',
    children: [
      { key: 'income.salary', label: 'Salary & Wages', description: 'Regular pay from an employer, after their withholding.' },
      { key: 'income.self_employment', label: 'Self-Employment', description: 'Contract, freelance, and gig work you invoiced for.' },
      { key: 'income.investment_income', label: 'Investment Income', description: 'Dividends and interest paid out to you in cash.' },
      { key: 'income.retirement_income', label: 'Retirement Income', description: 'Pension, annuity, and retirement-account distributions.' },
      { key: 'income.benefits', label: 'Benefits & Support', description: 'Unemployment, disability, child support, and similar payments.' },
      { key: 'income.rental_income', label: 'Rental Income', description: 'Rent collected on a property you own.' },
      { key: 'income.refunds_and_rebates', label: 'Refunds & Rebates', description: 'Tax refunds and money returned to you after the fact.' },
      { key: 'income.other_income', label: 'Other Income', description: 'Money in that does not fit the categories above.' },
    ],
  },
  {
    key: 'transfers',
    label: 'Transfers',
    description: 'Money moving between accounts you own. Never spending, never income.',
    kind: 'transfer',
    icon: 'arrow-left-right',
    children: [
      { key: 'transfers.between_accounts', label: 'Between My Accounts', description: 'A move from one of your accounts to another.' },
      { key: 'transfers.credit_card_payment', label: 'Credit Card Payment', description: 'Paying a card balance. The spending already counted when you swiped.' },
      { key: 'transfers.cash_withdrawal', label: 'Cash Withdrawal', description: 'Cash out of an ATM or over a counter.' },
      { key: 'transfers.cash_deposit', label: 'Cash & Cheque Deposit', description: 'Cash or a cheque paid into an account.' },
      { key: 'transfers.wire', label: 'Wire Transfer', description: 'A wire in or out, where the other side is not yet identified.' },
      { key: 'transfers.payment_apps', label: 'Payment Apps', description: 'Venmo, Cash App, Zelle and friends, before you say what it was for.' },
      { key: 'transfers.crypto', label: 'Crypto Transfer', description: 'Moving crypto between an exchange and a wallet you control.' },
      { key: 'transfers.loan_proceeds', label: 'Loan Proceeds', description: 'Borrowed money landing in an account. Cash up, debt up, no richer.' },
      { key: 'transfers.other_transfer', label: 'Other Transfer', description: 'A movement between your own accounts that fits nothing above.' },
    ],
  },
  {
    key: 'investments',
    label: 'Investing & Saving',
    description: 'Money put somewhere you still own it. Not spending.',
    kind: 'investment',
    icon: 'trending-up',
    children: [
      { key: 'investments.brokerage', label: 'Brokerage Contribution', description: 'Cash moved into a taxable investment account.' },
      { key: 'investments.retirement', label: 'Retirement Contribution', description: 'Cash moved into a 401(k), IRA, or similar.' },
      { key: 'investments.savings', label: 'Savings Contribution', description: 'Cash moved into a savings or sinking-fund account.' },
      { key: 'investments.crypto_purchase', label: 'Crypto Purchase', description: 'Buying a digital asset you continue to hold.' },
      { key: 'investments.other_investment', label: 'Other Investing', description: 'A contribution that fits none of the above.' },
    ],
  },
  {
    key: 'housing',
    label: 'Housing',
    description: 'The roof: rent, the taxes and dues that come with it, and storage.',
    kind: 'expense',
    icon: 'house',
    children: [
      { key: 'housing.rent', label: 'Rent', description: 'Rent paid to a landlord or letting agent.' },
      { key: 'housing.property_tax', label: 'Property Tax', description: 'Tax levied on a home you own.' },
      { key: 'housing.hoa_and_fees', label: 'HOA & Building Fees', description: 'Association dues, service charges, and ground rent.' },
      { key: 'housing.storage', label: 'Storage', description: 'A storage unit or off-site space you rent.' },
      { key: 'housing.other_housing', label: 'Other Housing', description: 'A housing cost that is not rent, tax, or dues.' },
    ],
  },
  {
    key: 'utilities',
    label: 'Utilities',
    description: 'The meters and the lines: power, water, waste, and connectivity.',
    kind: 'expense',
    icon: 'zap',
    children: [
      { key: 'utilities.electricity_and_gas', label: 'Electricity & Gas', description: 'Power and heating supplied to your home.' },
      { key: 'utilities.water', label: 'Water', description: 'Metered or fixed water supply.' },
      { key: 'utilities.waste', label: 'Waste & Recycling', description: 'Refuse collection, recycling, and sewerage.' },
      { key: 'utilities.internet', label: 'Internet & TV', description: 'Broadband and the cable package bundled with it.' },
      { key: 'utilities.mobile_phone', label: 'Mobile & Landline', description: 'Phone service for the household.' },
      { key: 'utilities.other_utilities', label: 'Other Utilities', description: 'A metered service that fits nothing above.' },
    ],
  },
  {
    key: 'groceries',
    label: 'Groceries',
    description: 'Food and household supplies you bring home and prepare yourself.',
    kind: 'expense',
    icon: 'shopping-basket',
    children: [
      { key: 'groceries.supermarkets', label: 'Supermarkets', description: 'The weekly shop at a full-line grocer.' },
      { key: 'groceries.convenience', label: 'Convenience Stores', description: 'Corner shops and forecourt kiosks.' },
      { key: 'groceries.specialty_food', label: 'Specialty Food', description: 'Butchers, bakeries, delis, and farmers markets.' },
      { key: 'groceries.alcohol', label: 'Beer, Wine & Spirits', description: 'Alcohol bought to take home, not drunk on the premises.' },
      { key: 'groceries.other_groceries', label: 'Other Groceries', description: 'Food shopping that fits nothing above.' },
    ],
  },
  {
    key: 'dining',
    label: 'Dining & Drinks',
    description: 'Food and drink someone else prepared for you.',
    kind: 'expense',
    icon: 'utensils',
    children: [
      { key: 'dining.restaurants', label: 'Restaurants', description: 'Sit-down meals, from the local place to the special occasion.' },
      { key: 'dining.fast_food', label: 'Fast Food', description: 'Counter service and drive-through.' },
      { key: 'dining.coffee', label: 'Coffee & Tea', description: 'Cafes, coffee shops, and the morning habit.' },
      { key: 'dining.bars', label: 'Bars & Pubs', description: 'Drinks consumed where you bought them.' },
      { key: 'dining.delivery', label: 'Delivery & Takeaway', description: 'Food ordered to your door, including the app fees.' },
      { key: 'dining.other_dining', label: 'Other Dining', description: 'Eating out that fits nothing above.' },
    ],
  },
  {
    key: 'transport',
    label: 'Transportation',
    description: 'Getting around day to day, and keeping the vehicle that does it running.',
    kind: 'expense',
    icon: 'car',
    children: [
      { key: 'transport.fuel', label: 'Fuel & Charging', description: 'Petrol, diesel, and public EV charging.' },
      { key: 'transport.public_transit', label: 'Public Transit', description: 'Bus, train, tram, and metro fares and passes.' },
      { key: 'transport.rideshare', label: 'Taxi & Rideshare', description: 'Uber, Lyft, and traditional taxis.' },
      { key: 'transport.parking', label: 'Parking', description: 'Meters, garages, and permits.' },
      { key: 'transport.tolls', label: 'Tolls', description: 'Road, bridge, and tunnel charges.' },
      { key: 'transport.auto_service', label: 'Vehicle Service', description: 'Servicing, repairs, tyres, and inspections.' },
      { key: 'transport.micromobility', label: 'Bikes & Scooters', description: 'Bike hire, scooter rentals, and their repairs.' },
      { key: 'transport.other_transport', label: 'Other Transportation', description: 'Getting around in a way that fits nothing above.' },
    ],
  },
  {
    key: 'travel',
    label: 'Travel',
    description: 'Trips away from home: the getting there and the staying there.',
    kind: 'expense',
    icon: 'plane',
    children: [
      { key: 'travel.flights', label: 'Flights', description: 'Airfare and the fees airlines attach to it.' },
      { key: 'travel.lodging', label: 'Lodging', description: 'Hotels, rentals, and anywhere else you slept.' },
      { key: 'travel.car_rental', label: 'Car Rental', description: 'Hire cars and the insurance sold with them.' },
      { key: 'travel.activities', label: 'Trips & Activities', description: 'Tours, excursions, and what you booked while away.' },
      { key: 'travel.other_travel', label: 'Other Travel', description: 'A trip cost that fits nothing above.' },
    ],
  },
  {
    key: 'shopping',
    label: 'Shopping',
    description: 'Things bought rather than services used.',
    kind: 'expense',
    icon: 'shopping-bag',
    children: [
      { key: 'shopping.clothing', label: 'Clothing & Accessories', description: 'Clothes, shoes, bags, and jewellery.' },
      { key: 'shopping.electronics', label: 'Electronics', description: 'Devices, components, and the cables you keep rebuying.' },
      { key: 'shopping.general_merchandise', label: 'General Merchandise', description: 'Department stores, discount stores, and superstores.' },
      { key: 'shopping.online_marketplaces', label: 'Online Marketplaces', description: 'Amazon, eBay, Etsy, and anything else with a mixed basket.' },
      { key: 'shopping.books_and_media', label: 'Books & Media', description: 'Books, magazines, and physical media.' },
      { key: 'shopping.gifts', label: 'Gifts', description: 'Presents, cards, and flowers bought for someone else.' },
      { key: 'shopping.hobbies', label: 'Hobbies & Sporting Goods', description: 'Kit for the things you do for fun.' },
      { key: 'shopping.office_supplies', label: 'Office Supplies', description: 'Stationery, printing, and desk consumables.' },
      { key: 'shopping.shipping', label: 'Postage & Shipping', description: 'Stamps, couriers, and returns you paid to send.' },
      { key: 'shopping.tobacco_and_vape', label: 'Tobacco & Vape', description: 'Cigarettes, vapes, and their supplies.' },
      { key: 'shopping.other_shopping', label: 'Other Shopping', description: 'A purchase that fits nothing above.' },
    ],
  },
  {
    key: 'home',
    label: 'Home & Garden',
    description: 'Improving, fixing, furnishing, and securing the place you live.',
    kind: 'expense',
    icon: 'hammer',
    children: [
      { key: 'home.furniture', label: 'Furniture & Decor', description: 'Furnishings and the things that make a room a room.' },
      { key: 'home.hardware', label: 'Hardware & DIY', description: 'Tools, timber, paint, and the trip to the hardware store.' },
      { key: 'home.repairs', label: 'Repairs & Maintenance', description: 'Trades called out to fix something.' },
      { key: 'home.security', label: 'Home Security', description: 'Alarms, cameras, and monitoring subscriptions.' },
      { key: 'home.garden', label: 'Lawn & Garden', description: 'Plants, landscaping, and grounds upkeep.' },
      { key: 'home.other_home', label: 'Other Home', description: 'A home cost that fits nothing above.' },
    ],
  },
  {
    key: 'health',
    label: 'Health & Medical',
    description: 'Care for your body, and what the pharmacy charges for it.',
    kind: 'expense',
    icon: 'stethoscope',
    children: [
      { key: 'health.primary_care', label: 'Doctor & Primary Care', description: 'GP visits, clinics, and urgent care.' },
      { key: 'health.specialists', label: 'Specialists & Hospital', description: 'Consultants, procedures, and hospital billing.' },
      { key: 'health.dental', label: 'Dental', description: 'Dentists, hygienists, and orthodontics.' },
      { key: 'health.vision', label: 'Vision', description: 'Eye tests, glasses, and contact lenses.' },
      { key: 'health.pharmacy', label: 'Pharmacy & Supplements', description: 'Prescriptions, over-the-counter medicine, and vitamins.' },
      { key: 'health.mental_health', label: 'Mental Health', description: 'Therapy, counselling, and psychiatric care.' },
      { key: 'health.nursing_care', label: 'Nursing & Long-Term Care', description: 'Home nursing, residential care, and assisted living.' },
      { key: 'health.other_health', label: 'Other Health', description: 'Care that fits nothing above.' },
    ],
  },
  {
    key: 'personal_care',
    label: 'Personal Care',
    description: 'Grooming, fitness, and the upkeep of everyday life.',
    kind: 'expense',
    icon: 'sparkles',
    children: [
      { key: 'personal_care.hair_and_beauty', label: 'Hair & Beauty', description: 'Salons, barbers, and cosmetics.' },
      { key: 'personal_care.spa', label: 'Spa & Wellness', description: 'Massage, spa visits, and treatments.' },
      { key: 'personal_care.fitness', label: 'Gym & Fitness', description: 'Gym membership, classes, and personal training.' },
      { key: 'personal_care.laundry', label: 'Laundry & Dry Cleaning', description: 'Launderettes, dry cleaners, and alterations.' },
      { key: 'personal_care.other_personal_care', label: 'Other Personal Care', description: 'Upkeep that fits nothing above.' },
    ],
  },
  {
    key: 'entertainment',
    label: 'Entertainment',
    description: 'What you do for enjoyment, and what you pay to watch or play.',
    kind: 'expense',
    icon: 'clapperboard',
    children: [
      { key: 'entertainment.streaming', label: 'Streaming Video', description: 'Netflix, Disney+, and the rest of the stack.' },
      { key: 'entertainment.music', label: 'Music & Audio', description: 'Streaming music, podcasts, and audiobooks.' },
      { key: 'entertainment.games', label: 'Games', description: 'Video games, in-game purchases, and games consoles.' },
      { key: 'entertainment.events', label: 'Events & Attractions', description: 'Concerts, cinema, sport, museums, and theme parks.' },
      { key: 'entertainment.gambling', label: 'Gambling', description: 'Betting, lotteries, and casinos.' },
      { key: 'entertainment.other_entertainment', label: 'Other Entertainment', description: 'Fun that fits nothing above.' },
    ],
  },
  {
    key: 'subscriptions',
    label: 'Subscriptions & Memberships',
    description: 'Recurring charges for software, media, and belonging to things.',
    kind: 'expense',
    icon: 'repeat',
    children: [
      { key: 'subscriptions.software', label: 'Software & Apps', description: 'Applications and services billed by the month or year.' },
      { key: 'subscriptions.cloud_storage', label: 'Cloud & Hosting', description: 'Storage, backup, domains, and hosting.' },
      { key: 'subscriptions.news', label: 'News & Publications', description: 'Newspapers, magazines, and paid newsletters.' },
      { key: 'subscriptions.memberships', label: 'Memberships & Dues', description: 'Clubs, professional bodies, and union dues.' },
      { key: 'subscriptions.other_subscriptions', label: 'Other Subscriptions', description: 'A recurring charge that fits nothing above.' },
    ],
  },
  {
    key: 'education',
    label: 'Education',
    description: 'Learning: the fees, the materials, and the courses.',
    kind: 'expense',
    icon: 'graduation-cap',
    children: [
      { key: 'education.tuition', label: 'Tuition & Fees', description: 'School, college, and university charges.' },
      { key: 'education.supplies', label: 'Books & Supplies', description: 'Textbooks, equipment, and course materials.' },
      { key: 'education.courses', label: 'Courses & Training', description: 'Short courses, certifications, and tutoring.' },
      { key: 'education.other_education', label: 'Other Education', description: 'Learning costs that fit nothing above.' },
    ],
  },
  {
    key: 'family',
    label: 'Family & Pets',
    description: 'The people and animals you look after.',
    kind: 'expense',
    icon: 'users',
    children: [
      { key: 'family.childcare', label: 'Childcare', description: 'Nursery, after-school care, and babysitting.' },
      { key: 'family.child_activities', label: 'Kids & Activities', description: 'Clubs, lessons, toys, and school trips.' },
      { key: 'family.pets', label: 'Pet Supplies', description: 'Food, toys, grooming, and boarding.' },
      { key: 'family.pet_medical', label: 'Veterinary', description: 'Vet visits, procedures, and pet medication.' },
      { key: 'family.elder_care', label: 'Elder Care', description: 'Support for a parent or relative.' },
      { key: 'family.support', label: 'Family Support', description: 'Allowance, maintenance, and money sent to family.' },
      { key: 'family.other_family', label: 'Other Family', description: 'Looking after people that fits nothing above.' },
    ],
  },
  {
    key: 'insurance',
    label: 'Insurance',
    description: 'Premiums paid to cover a risk you would rather not carry.',
    kind: 'expense',
    icon: 'shield',
    children: [
      { key: 'insurance.health', label: 'Health Insurance', description: 'Medical and dental cover premiums.' },
      { key: 'insurance.auto', label: 'Auto Insurance', description: 'Cover for a vehicle you drive.' },
      { key: 'insurance.home', label: 'Home & Contents', description: 'Buildings, contents, and renters cover.' },
      { key: 'insurance.life', label: 'Life & Disability', description: 'Life, critical illness, and income protection.' },
      { key: 'insurance.other_insurance', label: 'Other Insurance', description: 'A premium that fits nothing above.' },
    ],
  },
  {
    key: 'fees_and_services',
    label: 'Fees & Professional Services',
    description: 'What it costs to hold the accounts and hire the professionals.',
    kind: 'expense',
    icon: 'briefcase',
    children: [
      { key: 'fees_and_services.bank_fees', label: 'Bank Fees', description: 'Account fees, overdraft charges, and insufficient-funds penalties.' },
      { key: 'fees_and_services.atm_fees', label: 'ATM Fees', description: 'Charges for using someone else’s cash machine.' },
      { key: 'fees_and_services.interest_charges', label: 'Interest Charges', description: 'Interest a lender charged you, separate from the principal.' },
      { key: 'fees_and_services.foreign_fees', label: 'Foreign Transaction Fees', description: 'The surcharge for spending in another currency.' },
      { key: 'fees_and_services.advisory', label: 'Accounting & Advice', description: 'Accountants, tax preparers, and financial planners.' },
      { key: 'fees_and_services.legal', label: 'Legal & Consulting', description: 'Solicitors, consultants, and professional advice.' },
      { key: 'fees_and_services.other_fees', label: 'Other Fees & Services', description: 'A fee or professional service that fits nothing above.' },
    ],
  },
  {
    key: 'debt',
    label: 'Debt Payments',
    description: 'Principal repaid on money you borrowed. Interest is filed under fees.',
    kind: 'expense',
    icon: 'landmark',
    children: [
      { key: 'debt.mortgage', label: 'Mortgage', description: 'The monthly payment on a property loan.' },
      { key: 'debt.auto_loan', label: 'Auto Loan', description: 'Repayments on a vehicle you financed.' },
      { key: 'debt.student_loan', label: 'Student Loan', description: 'Repayments on education borrowing.' },
      { key: 'debt.personal_loan', label: 'Personal Loan', description: 'Repayments on an unsecured loan.' },
      { key: 'debt.bnpl', label: 'Buy Now, Pay Later', description: 'Instalments on a split-payment purchase.' },
      { key: 'debt.other_debt', label: 'Other Debt', description: 'A repayment that fits nothing above.' },
    ],
  },
  {
    key: 'giving_and_taxes',
    label: 'Giving & Taxes',
    description: 'Money to charities and to the state.',
    kind: 'expense',
    icon: 'heart-handshake',
    children: [
      { key: 'giving_and_taxes.donations', label: 'Charitable Donations', description: 'Gifts to charities and non-profits.' },
      { key: 'giving_and_taxes.taxes', label: 'Tax Payments', description: 'Income tax, estimated payments, and settlements.' },
      { key: 'giving_and_taxes.government_fees', label: 'Government Fees', description: 'Licences, permits, fines, and agency charges.' },
      { key: 'giving_and_taxes.other_giving', label: 'Other Giving & Taxes', description: 'A payment to a charity or the state that fits nothing above.' },
    ],
  },
  {
    key: UNCATEGORISED_KEY,
    label: 'Uncategorised',
    description: 'Not yet decided. The engine abstained rather than guess.',
    kind: 'other',
    icon: 'circle-help',
    children: [],
  },
]);

/** Every node, flattened, parents before their own children. Seeding order. */
export interface FlatCategory {
  readonly key: string;
  readonly parentKey: string | null;
  readonly label: string;
  readonly description: string;
  readonly kind: CategoryKind;
  readonly icon: string;
  readonly sort: number;
}

export const FLAT_TAXONOMY: readonly FlatCategory[] = Object.freeze(
  TAXONOMY.flatMap((node, nodeIndex): FlatCategory[] => [
    {
      key: node.key,
      parentKey: null,
      label: node.label,
      description: node.description,
      kind: node.kind,
      icon: node.icon,
      sort: (nodeIndex + 1) * 1000,
    },
    ...node.children.map((leaf, leafIndex): FlatCategory => ({
      key: leaf.key,
      parentKey: node.key,
      label: leaf.label,
      description: leaf.description,
      kind: leaf.kind ?? node.kind,
      icon: node.icon,
      sort: (nodeIndex + 1) * 1000 + (leafIndex + 1) * 10,
    })),
  ]),
);

const BY_KEY: ReadonlyMap<string, FlatCategory> = new Map(
  FLAT_TAXONOMY.map((entry) => [entry.key, entry]),
);

export function taxonomyEntry(key: string): FlatCategory | undefined {
  return BY_KEY.get(key);
}

export function isTaxonomyKey(key: string): boolean {
  return BY_KEY.has(key);
}

/** Leaves only: what the engine is allowed to assign. */
export function isAssignableKey(key: string): boolean {
  const entry = BY_KEY.get(key);
  if (entry === undefined) return false;
  return entry.parentKey !== null || key === UNCATEGORISED_KEY;
}

export function kindOf(key: string): CategoryKind | undefined {
  return BY_KEY.get(key)?.kind;
}
