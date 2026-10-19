/**
 * Near-duplicate detection for the merge queue.
 *
 * Pure and dependency-free on purpose: the taxonomy page feeds it rows from
 * Postgres and scripts/test-merge-candidates.mjs feeds it fixtures, so the rule
 * that decides "are these the same food?" is testable without a database.
 *
 * PRECISION OVER RECALL. A wrong suggestion is worse than a missing one: Merge
 * repoints every transaction from one product to the other, so a false positive
 * a user accepts silently rewrites months of spending. The original
 * "one normalized name is a prefix of the other" rule was dropped for exactly
 * that reason. In this vocabulary a shared head noun means shared *ingredients*,
 * not a shared product:
 *
 *     Ruti            vs  Ruti-tarka              two different dishes
 *     Ruti            vs  Ruti-curry              two different dishes
 *     Kachori paratha vs  Kachori paratha egg     two different dishes
 *     Rice            vs  Rice-chicken            two different dishes
 *
 * and the seed taxonomy ships every one of those pairs as a distinct product,
 * so the rule guaranteed false positives on day one.
 *
 * What survives are three signals that describe *spelling* variance, never
 * vocabulary variance:
 *
 *   1. same name once case and punctuation are folded
 *      "Idli sambar" / "Idli-sambar"
 *   2. one character apart (names of 4+ characters)
 *      "Chanachur0" / "Chanachur"
 *   3. a trailing qualifier word — a time of day, "misc", "extra"
 *      "Cha" / "Cha (evening)"
 *
 * Two curated seed products are never offered as a pair: the seed list is fixed
 * and deliberately contains look-alikes (Ruti and Ruti-tarka are both seeded),
 * so an overlap between two seed names is a coincidence of words, not a
 * duplicate the user introduced.
 */

export interface CandidateProduct {
  id: string;
  sector_id: string;
  name: string;
  normalized_name: string;
  use_count: number;
  is_seeded: boolean;
}

export interface MergeCandidate<P extends CandidateProduct> {
  keep: P;
  drop: P;
  reason: string;
}

/**
 * Words that qualify *when* or *how much* something was bought, never *what*.
 *
 * "Cha (evening)" is Cha at a different hour. "Kachori paratha egg" is not
 * Kachori paratha at a different hour — `egg` is an ingredient, so it is
 * deliberately absent here. Extending this list with food nouns is how the
 * prefix false positive would come back.
 */
const QUALIFIER_WORDS = new Set([
  "morning",
  "afternoon",
  "evening",
  "night",
  "late",
  "early",
  "misc",
  "other",
  "others",
  "extra",
]);

/** Lowercase, split on anything that is not a letter or digit. */
function words(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Lowercase, drop everything that is not a letter or digit. */
export function foldName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * True when `longer` is `shorter` plus one or more trailing qualifier words.
 *
 * Token-position based rather than string-prefix based, so punctuation and
 * parentheses do not matter: "Cha (evening)" and "Cha - evening" both reduce to
 * ['cha', 'evening'].
 */
function isQualifierExtension(longer: string, shorter: string): boolean {
  const long = words(longer);
  const short = words(shorter);
  if (long.length <= short.length) return false;
  for (let i = 0; i < short.length; i++) {
    if (long[i] !== short[i]) return false;
  }
  return long.slice(short.length).every((w) => QUALIFIER_WORDS.has(w));
}

/**
 * Edit distance, short-circuited at 2.
 *
 * Only ever called on product names, so the O(n*m) table is trivial. Returning
 * early when lengths differ by more than one keeps it honest: a distance-2
 * answer is indistinguishable from "definitely not close", which is all the
 * caller asks.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 1) return 2;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev.splice(0, prev.length, ...curr);
  }
  return prev[b.length];
}

/**
 * Why two products might be the same thing, or null when they are distinct.
 *
 * Reason strings are user-facing: they sit in a badge next to the pair, so they
 * have to say what evidence produced the suggestion.
 */
export function duplicateReason(
  a: Pick<CandidateProduct, "name" | "normalized_name" | "is_seeded">,
  b: Pick<CandidateProduct, "name" | "normalized_name" | "is_seeded">,
): string | null {
  // Curated, fixed, and intentionally full of near-misses. Never second-guess
  // the seed list against itself.
  if (a.is_seeded && b.is_seeded) return null;

  // 1. Same name once case and punctuation are folded. The unique index on
  //    (user_id, normalized_name) normally makes this impossible among active
  //    rows, so this is a safety net for rows written by an older canonicalizer
  //    rather than the main signal.
  if (foldName(a.name) === foldName(b.name)) {
    return "same name, different punctuation";
  }

  // 2. A trailing qualifier, in either direction: "Cha" / "Cha (evening)".
  if (isQualifierExtension(a.name, b.name) || isQualifierExtension(b.name, a.name)) {
    return "same name plus a qualifier";
  }

  // 3. A single typo. Three-letter names are excluded: at that length one
  //    character is routinely a different food, and "Ruti" / "Roti" is close
  //    enough to be a spelling of the same dish but far too short to prove it
  //    from the name alone.
  const na = a.normalized_name;
  const nb = b.normalized_name;
  if (na.length > 3 && nb.length > 3 && levenshtein(na, nb) <= 1) {
    return "one character apart";
  }

  return null;
}

/**
 * Canonical ordering for a product pair.
 *
 * UUIDs compare the same way as text once they are lowercase and hyphenated —
 * the separators sit at fixed positions and hex digits sort in numeric order —
 * so this agrees with the `product_a_id < product_b_id` check in migration 0010.
 */
export function orderedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/** Order-independent key for a product pair, stable across server and client. */
export function pairKey(a: string, b: string): string {
  const [first, second] = orderedPair(a, b);
  return `${first}:${second}`;
}

/**
 * All near-duplicate candidates, most impactful first.
 *
 * Only compares products inside the same sector: `Coffee` (a drink) and
 * `Coffee powder` (a grocery) are different products by construction, and
 * sector-scoping is what keeps that from ever being questioned.
 */
export function findMergeCandidates<P extends CandidateProduct>(
  products: readonly P[],
): MergeCandidate<P>[] {
  const bySector = new Map<string, P[]>();
  for (const p of products) {
    const bucket = bySector.get(p.sector_id);
    if (bucket) bucket.push(p);
    else bySector.set(p.sector_id, [p]);
  }

  const out: MergeCandidate<P>[] = [];

  for (const group of bySector.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const reason = duplicateReason(a, b);
        if (!reason) continue;

        // The more-used product survives; it carries the aliases and the
        // history. Ties break on name so the panel does not reshuffle between
        // renders. `merge_products` enforces the same direction in the database.
        const [keep, drop] =
          a.use_count > b.use_count || (a.use_count === b.use_count && a.name <= b.name)
            ? [a, b]
            : [b, a];
        out.push({ keep, drop, reason });
      }
    }
  }

  // Highest-impact first: a pair covering 400+400 transactions matters more
  // than a pair covering 2+2.
  return out.sort(
    (x, y) =>
      y.keep.use_count + y.drop.use_count - (x.keep.use_count + x.drop.use_count) ||
      x.keep.name.localeCompare(y.keep.name) ||
      x.drop.name.localeCompare(y.drop.name),
  );
}
