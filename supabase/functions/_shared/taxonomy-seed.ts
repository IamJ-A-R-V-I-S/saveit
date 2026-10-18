/**
 * Seed taxonomy.
 *
 * Derived from the 147 real categories in the sample statement so a new user
 * importing that file starts with a sensible product list instead of making the
 * model invent 147 products from scratch. The model manages the taxonomy after
 * this; these are just the opening moves.
 *
 * Dual-use names ("Gifts" is both given and received; "Lending, renting" is
 * money out when the user lends and money in when repaid) are seeded ONCE under
 * their plain name. Suffixing them into two products was tried and rejected:
 * the source data says "Gifts", so a product named "Gifts (given)" never
 * matches and 24 rows fell through to the model for no reason.
 *
 * Instead, direction disambiguates: a credit is always reported as income, so
 * the product only has to answer "what was it for". v_monthly_sector_spend
 * filters direction='debit' and income is reported separately through
 * v_monthly_coverage.total_income, so one product in one sector is sufficient.
 *
 * "Charges, Fees" is deliberately left to `uncategorized`: in the sample it
 * covers exam fees (education), brokerage (housing), a maid (housing) and
 * paying a freelancer (loans_transfers). One product cannot hold all four --
 * the categorizer must read the note and decide. This is the "what is it" vs
 * "what is it for" problem from docs/DATA-PROFILE.md made concrete.
 */

export const SECTOR_PRODUCTS: Record<string, string[]> = {
  groceries: [
    'Grocery', 'Milk', 'Eggs', 'Vegetables', 'Biscuits', 'Bread', 'Oil', 'Sugar',
    'Salt', 'Black salt', 'Coffee powder', 'Daliah', 'Maggi', 'Chanachur', 'Chips',
    'Chocolate', 'Cake', 'Satty', 'Muri packet', 'Cucumber', 'Colgate', 'Banana',
    'Guava', 'Mango', 'Apple', 'Orange', 'Grapes', 'Fruit',
  ],
  food_out: [
    'Cha', 'Coffee', 'Coca-Cola', 'Thumbs-up', 'Lassi', 'Sugarcane juice', 'Fruit Juice',
    'Drinks', 'Water', 'Aam pora', 'Glucose', 'Jeera', 'Chicken Biryani', 'Allu biryani',
    'Biryani', 'Rice-chicken', 'Rice-egg', 'Rice-fish', 'Rice-curry', 'Ruti-tarka',
    'Ruti-curry', 'Ruti', 'Roti-curry', 'Rutu-curry-egg', 'Kachori paratha',
    'Kachori paratha egg', 'Tiffin', 'Breakfast', 'Lunch', 'Dinner', 'Curd', 'Chop',
    'Muri', 'Sweets', 'Ice cream', 'Fuchka', 'Momo', 'Samosa', 'Egg roll', 'Patties',
    'Chowmin', 'Fastfood', 'Bread sandwich', 'Bread toast', 'Dhosa', 'Idli-sambar',
    'Pastry', 'Food and drinks',
  ],
  transport: [
    'Auto', 'Metro', 'Bus', 'Local train', 'Toto', 'Ferry', 'Uber', 'Taxi',
    'Radhikapur express', 'Kulik express', 'Long distance', 'Public transport',
    'Transportation',
  ],
  housing: ['Rent', 'Housing', 'Maintenance, repairs', 'Services'],
  utilities: ['Energy, utilities', 'GitHub Subscription'],
  telecom: ['Mobile recharge', 'Wifi', 'Internet'],
  shopping: [
    'Clothes & shoes', 'Jewels, accessories', 'Electronics, accessories', 'Electronics',
    'Home, garden', 'Shopping', 'Stationery, tools', 'Vehicles, chattels',
    'Phone repair', 'Laptop repair', 'Phone, Laptop', 'Trousers', 'Shirt',
  ],
  health: [
    'Medicine', 'Health care, doctor', 'Wellness, beauty', 'Saloon', 'Laundry',
    'Active sport, fitness', 'Gym memberships',
  ],
  education: ['College', 'Course', 'Admission form', 'Education', 'Books', 'Print out', 'Xerox'],
  entertainment: ['Cinema', 'Culture, sport events', 'Life & Entertainment', 'Holiday, trips, hotels'],
  loans_transfers: ['Loan, interests'],
  gifts_social: ['Charity, gifts', 'Life events', 'Kids', 'Gifts, joy', 'Gifts'],
  income: [
    'Tuition', 'Freelancing', 'Internship', 'Salary', 'Child Support', 'Dues & grants',
    'Interests, dividends', 'Refunds (tax, purchase)', 'Lending, renting',
  ],
  // 'Unknown' is the landing spot for emoji-only or otherwise nameless source
  // categories. Seeding it keeps those rows visible in the review queue instead
  // of letting the model invent a new junk product per file.
  uncategorized: ['Charges, Fees', 'Misc', 'Unknown'],
};

/**
 * Keyword priors for descriptions the seed does not know.
 *
 * These give the categorizer a cheap deterministic hint and let a brand-new user
 * with a different bank's vocabulary still get reasonable first-pass results.
 * Checked in order; first match wins.
 */
export const KEYWORD_SECTOR_RULES: Array<{ sector: string; keywords: string[] }> = [
  { sector: 'income', keywords: ['salary', 'payroll', 'credit interest', 'refund', 'reversal', 'dividend', 'cashback', 'neft cr', 'imps cr', 'upi cr'] },
  { sector: 'transport', keywords: ['uber', 'ola', 'rapido', 'metro', 'irctc', 'railway', 'train', 'bus', 'fuel', 'petrol', 'diesel', 'parking', 'toll', 'fastag', 'auto'] },
  { sector: 'telecom', keywords: ['airtel', 'jio', 'vi ', 'vodafone', 'bsnl', 'recharge', 'broadband', 'act fiber', 'tata play'] },
  { sector: 'utilities', keywords: ['electricity', 'cesc', 'wbSEDCL', 'water bill', 'gas', 'igl', 'power'] },
  { sector: 'housing', keywords: ['rent', 'landlord', 'society', 'maintenance', 'brokerage'] },
  { sector: 'health', keywords: ['pharmacy', 'apollo', 'medplus', 'hospital', 'clinic', 'doctor', 'diagnostic', 'lab'] },
  { sector: 'groceries', keywords: ['blinkit', 'zepto', 'swiggy instamart', 'bigbasket', 'dmart', 'more supermarket', 'grocery', 'kirana'] },
  { sector: 'food_out', keywords: ['restaurant', 'cafe', 'coffee', 'biryani', 'dominos', 'kfc', 'mcdonalds', 'zomato', 'swiggy', 'canteen', 'tea'] },
  { sector: 'entertainment', keywords: ['cinema', 'pvr', 'inox', 'movie', 'bookmyshow', 'netflix', 'spotify', 'prime video', 'concert'] },
  { sector: 'education', keywords: ['course', 'udemy', 'coursera', 'tuition fee', 'exam fee', 'university', 'college', 'book'] },
  { sector: 'shopping', keywords: ['amazon', 'flipkart', 'myntra', 'ajio', 'nykaa', 'meesho', 'zudio', 'vmart', 'decathlon'] },
  { sector: 'loans_transfers', keywords: ['emi', 'loan', 'interest debit', 'credit card payment'] },
];

/** A sector guess from a raw description, using the keyword priors. */
export function guessSectorFromKeywords(description: string): string | null {
  const d = description.toLowerCase();
  for (const rule of KEYWORD_SECTOR_RULES) {
    if (rule.keywords.some((k) => d.includes(k.toLowerCase()))) return rule.sector;
  }
  return null;
}

/**
 * Canonical display name for a product.
 *
 * EVERY name in this map must already be canonical -- i.e.
 * canonicalProductName(name) === name. Two entries that canonicalize to the
 * same string ('Idli sambar' and 'Idli-sambar' both fold to 'idlisambar')
 * would collide on the unique (user_id, normalized_name) index and break the
 * whole seed insert. scripts/test-taxonomy.mjs enforces this.
 *
 * The source data is inconsistent: `guava` (lowercase), `Eggs 🥚` (emoji),
 * `Chanachur0` (typo), `Idli sambar` vs `Idli-sambar`. Normalizing on the way in
 * is what stops the taxonomy sprouting five spellings of one thing.
 */
export function canonicalProductName(raw: string): string {
  let name = raw.trim();
  if (!name) return '';

  // Strip emoji and other non-letter pictographs.
  name = name.replace(
    /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F000}-\u{1F0FF}]/gu,
    '',
  );

  // The source data contains emoji-ONLY categories ("👖", "👕"). Stripping the
  // emoji leaves an empty string, which would create a nameless product and
  // silently swallow the row. Send it to 'Unknown' instead so it surfaces in the
  // review queue where a human can name it.
  if (!name.replace(/[^a-z0-9]/gi, '').trim()) return 'Unknown';

  // Known typos in the source data.
  const TYPO_FIXES: Record<string, string> = {
    chanachur0: 'Chanachur',
    'idli sambar': 'Idli-sambar',
    'roti curry': 'Ruti-curry',
    'ruti curry': 'Ruti-curry',
    'rice curry': 'Rice-curry',
    breakfast: 'Breakfast',
    lunch: 'Lunch',
    dinner: 'Dinner',
  };
  const typoKey = name.toLowerCase().trim();
  if (TYPO_FIXES[typoKey]) name = TYPO_FIXES[typoKey];

  // Sentence-case, collapse whitespace.
  name = name.replace(/\s+/g, ' ').trim();
  if (/^[a-z]/.test(name) && !name.includes(',')) {
    name = name[0].toUpperCase() + name.slice(1);
  }
  return name;
}

/** Fold a name for uniqueness/duplicate detection (case- and punctuation-blind). */
export function normalizeProductName(raw: string): string {
  return canonicalProductName(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}
