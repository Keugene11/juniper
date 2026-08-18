/**
 * Shared keyword gate for the search-driven providers.
 *
 * Both Algolia (Hacker News) and Reddit rank with loose OR semantics, so a
 * query for "CRM data hygiene" cheerfully returns anything containing "data".
 * Left unchecked that fabricates signals and spends real money scoring them,
 * so every hit is re-checked locally against the term's own words.
 */

/**
 * Share of the term's content words that literally appear in the haystack.
 * Deliberately crude — its only job is to reject OR-matches, not to rank.
 *
 * Short words are kept: "CRM", "API", and "MX" are exactly the words that make
 * a term specific, and dropping them is what let a story about an IAM breach
 * pass as a match for "CRM data hygiene".
 */
export function relevance(term: string, haystack: string): number {
  const words = term
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  if (words.length === 0) return 1;

  const text = haystack.toLowerCase();
  const present = words.filter((w) => text.includes(w)).length;
  return present / words.length;
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
