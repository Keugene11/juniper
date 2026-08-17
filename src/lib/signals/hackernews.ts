import {
  describeFetchError,
  type ProviderContext,
  type ProviderOutput,
  type Signal,
  type SignalKind,
  type SignalProvider,
} from "./types";

interface HnHit {
  objectID: string;
  title: string | null;
  url: string | null;
  author: string;
  points: number | null;
  created_at: string;
  story_text: string | null;
}

const RECENT_DAYS = 180;
/**
 * Fraction of a watch term's content words that must actually appear. A watch
 * term is a phrase, so anything below 1.0 lets partial matches through — and a
 * partial match on "CRM data hygiene" is a story about "data", which is noise.
 */
const RELEVANCE_FLOOR = 1;

/**
 * Hacker News via the public Algolia index — the "someone posted about a pain
 * point you solve" and "company just raised / launched" half of the feed.
 *
 * Algolia ranks with loose OR matching, so a query like "CRM data hygiene"
 * happily returns a story that merely contains "data". Left unchecked that
 * feeds fabricated signals into scoring, so every hit is re-checked locally
 * against the term's own words before it is allowed through. Expect this
 * provider to be quiet for non-developer ICPs: HN simply has little to say
 * about most B2B categories, and silence is the correct output.
 */
export const hackerNewsProvider: SignalProvider = {
  id: "hackernews",
  label: "Hacker News",
  description:
    "Relevance-ranked Algolia search over recent HN stories, with a local relevance gate. Best for developer-tool and infrastructure ICPs.",
  enabled: true,

  async fetch(ctx: ProviderContext): Promise<ProviderOutput> {
    const signals: Signal[] = [];
    const warnings: string[] = [];
    const seen = new Set<string>();

    if (ctx.keywords.length === 0) {
      warnings.push("no watch terms on the profile — re-run website analysis on the Setup tab");
      return { signals, warnings };
    }

    const since = Math.floor(Date.now() / 1000) - RECENT_DAYS * 86_400;
    const terms = ctx.keywords.slice(0, 6);
    let rejected = 0;

    for (const keyword of terms) {
      let hits: HnHit[];
      try {
        const url =
          `https://hn.algolia.com/api/v1/search?tags=story` +
          `&query=${encodeURIComponent(keyword)}` +
          `&numericFilters=created_at_i>${since}` +
          `&hitsPerPage=${Math.min(ctx.limit, 20)}`;
        const res = await fetch(url, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(12_000),
        });
        if (!res.ok) {
          warnings.push(`"${keyword}": search returned HTTP ${res.status}`);
          continue;
        }
        hits = ((await res.json()) as { hits?: HnHit[] }).hits ?? [];
      } catch (err) {
        warnings.push(`"${keyword}": ${describeFetchError(err)}`);
        continue;
      }

      for (const hit of hits) {
        if (!hit.title || seen.has(hit.objectID)) continue;

        // Every content word must appear somewhere, and at least one must
        // appear in the title. Body-only matches are how a long post about
        // something unrelated accumulates four common words by chance.
        const fullMatch =
          relevance(keyword, `${hit.title} ${hit.story_text ?? ""}`) >= RELEVANCE_FLOOR;
        if (!fullMatch || relevance(keyword, hit.title) === 0) {
          rejected++;
          continue;
        }
        seen.add(hit.objectID);

        const domain = hostOf(hit.url);
        signals.push({
          provider: "hackernews",
          kind: classify(hit.title),
          company: domain ? prettyCompany(domain) : hit.author,
          domain,
          personName: null,
          personTitle: null,
          headline: hit.title,
          evidence:
            `Posted to Hacker News on ${hit.created_at.slice(0, 10)}, matching your ` +
            `"${keyword}" watch term${hit.points ? ` (${hit.points} points)` : ""}. ` +
            (hit.story_text ? stripTags(hit.story_text).slice(0, 240) : hit.title),
          url: hit.url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`,
          detectedAt: new Date().toISOString(),
          dedupeKey: `hn:${hit.objectID}`,
        });
      }
    }

    if (signals.length === 0) {
      warnings.push(
        `no relevant stories in the last ${RECENT_DAYS} days across ${terms.length} watch terms` +
          (rejected ? ` (${rejected} loose keyword matches rejected)` : ""),
      );
    } else if (rejected) {
      warnings.push(`rejected ${rejected} loose keyword matches below the relevance floor`);
    }

    return { signals, warnings };
  },
};

/**
 * Share of the term's content words that literally appear in the story.
 * Deliberately crude — its only job is to reject OR-matches, not to rank.
 *
 * Short words are kept: "CRM", "API", and "MX" are exactly the words that make
 * a term specific, and dropping them is what let a story about an IAM breach
 * pass as a match for "CRM data hygiene".
 */
function relevance(term: string, haystack: string): number {
  const words = term
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  if (words.length === 0) return 1;

  const text = haystack.toLowerCase();
  const present = words.filter((w) => text.includes(w)).length;
  return present / words.length;
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "your", "their",
  "about", "into", "using", "when", "how", "why", "are", "was",
]);

function classify(title: string): SignalKind {
  const t = title.toLowerCase();
  if (/\braise[sd]?\b|\bseries [a-e]\b|\bseed round\b|\bfunding\b/.test(t)) return "funding_round";
  if (/^show hn|^launch hn|\blaunch(ing|ed)?\b|\bintroducing\b/.test(t)) return "product_launch";
  if (/\bmigrat(e|ing|ed)\b|\bswitch(ing|ed)? (to|from)\b|\bwe moved to\b/.test(t))
    return "tech_adoption";
  return "pain_point_post";
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function prettyCompany(domain: string): string {
  const base = domain.split(".")[0];
  return base.charAt(0).toUpperCase() + base.slice(1);
}

const stripTags = (s: string) => s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
