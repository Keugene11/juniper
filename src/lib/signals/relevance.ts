/**
 * Shared keyword gate for the search-driven providers.
 *
 * Both Algolia (Hacker News) and Reddit rank with loose OR semantics, so a
 * query for "CRM data hygiene" cheerfully returns anything containing "data".
 * Left unchecked that fabricates signals and spends real money scoring them,
 * so every hit is re-checked locally against the term's own words.
 */

/**
 * Share of the term's content words that appear in the haystack as whole words.
 * Deliberately crude — its only job is to reject OR-matches, not to rank.
 *
 * Short words are kept: "CRM", "API", and "MX" are exactly the words that make
 * a term specific, and dropping them is what let a story about an IAM breach
 * pass as a match for "CRM data hygiene". The floor is two characters rather
 * than three, because at three a term consisting only of a short acronym — "AI",
 * "MX", "HR" — reduced to *no* content words, and a term with no content words
 * matches everything. A single two-letter watch term used to switch the whole
 * gate off for every keyword source at once.
 *
 * Matching is on word boundaries, not substrings. `includes` made "API" match
 * "rapid", "capital" and "therapist", which is the same false-positive the gate
 * exists to stop — just harder to notice.
 */
export function relevance(term: string, haystack: string): number {
  const words = term
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
  // Only reachable for a degenerate term — all stopwords, or all single
  // characters. There is nothing to test against, so nothing is rejected.
  if (words.length === 0) return 1;

  const text = haystack.toLowerCase();
  const present = words.filter((w) => hasWord(text, w)).length;
  return present / words.length;
}

/** Whole-word containment. Words are already `[a-z0-9]+`, so `\b` is safe. */
function hasWord(text: string, word: string): boolean {
  return new RegExp(`\\b${word}\\b`).test(text);
}

/**
 * A hit passes when *all* of the term's content words appear somewhere and at
 * least one appears in the title. Body-only matches are how a long post about
 * something unrelated accumulates four common words by chance.
 */
export function passesGate(term: string, title: string, body: string): boolean {
  if (relevance(term, `${title} ${body}`) < 1) return false;
  return relevance(term, title) > 0;
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "your", "their",
  "about", "into", "using", "when", "how", "why", "are", "was",
]);
