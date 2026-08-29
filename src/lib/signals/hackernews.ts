import { passesGate } from "./relevance";
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
 * Hacker News via the public Algolia index — the "someone posted about a pain
 * point you solve" and "company just raised / launched" half of the feed.
 *
 * Algolia ranks with loose OR matching, so every hit is re-checked locally
 * against the term's own words (see `relevance.ts`) before it is allowed
 * through. Expect this provider to be quiet for non-developer ICPs: HN simply
 * has little to say about most B2B categories, and silence is the correct
 * output.
 */
export const hackerNewsProvider: SignalProvider = {
  id: "hackernews",
  label: "Hacker News",
  description:
    "Relevance-ranked Algolia search over recent HN stories, with a local relevance gate. Best for developer-tool and infrastructure ICPs.",
  enabled: true,
  requires: [],
  kinds: [
    "negative_review",
    "pain_point_post",
    "funding_round",
    "product_launch",
    "tech_adoption",
    "media_mention",
  ],

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
    let unattributed = 0;

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

        if (!passesGate(keyword, hit.title, hit.story_text ?? "")) {
          rejected++;
          continue;
        }
        seen.add(hit.objectID);

        const domain = hostOf(hit.url);
        // A story linking to a news site or a blog host tells you nothing about
        // that publisher as a prospect: it is the subject of the article, not
        // its host, that has the pain point. These are the dangerous ones —
        // unlike a text post, a publisher hands over a plausible-looking domain,
        // so it cleared enrichment and got a sequence written to someone at the
        // New York Times. Text posts are deliberately left alone: they carry no
        // domain, so they already stop before the waterfall, and an Ask HN
        // describing a problem out loud is the strongest thing this source has.
        if (domain && isPublisher(domain)) {
          unattributed++;
          continue;
        }
        signals.push({
          provider: "hackernews",
          kind: classify(hit.title, Boolean(domain)),
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
          // The story's own timestamp, not ours — the search window reaches
          // back six months, and intent decay is the only thing separating a
          // complaint posted this morning from one posted in the spring.
          occurredAt: hit.created_at,
          dedupeKey: `hn:${hit.objectID}`,
        });
      }
    }

    const notes = [
      rejected ? `${rejected} loose keyword matches below the relevance floor` : null,
      unattributed
        ? `${unattributed} linking to a publisher rather than a prospect`
        : null,
    ].filter((n): n is string => n !== null);

    if (signals.length === 0) {
      warnings.push(
        `no relevant stories in the last ${RECENT_DAYS} days across ${terms.length} watch terms` +
          (notes.length ? ` (rejected ${notes.join("; ")})` : ""),
      );
    } else if (notes.length) {
      warnings.push(`rejected ${notes.join("; ")}`);
    }

    return { signals, warnings };
  },
};

/**
 * Maps a story to the taxonomy. `linksOut` distinguishes a submitted article
 * from a text post: an Ask HN with no URL is someone describing their own
 * problem, whereas a linked article about a company is press coverage. Both
 * used to land in `pain_point_post`, which over-scored every piece of trade
 * news by 50 points.
 */
function classify(title: string, linksOut: boolean): SignalKind {
  const t = title.toLowerCase();
  if (/\braise[sd]?\b|\bseries [a-e]\b|\bseed round\b|\bfunding\b/.test(t)) return "funding_round";
  if (/^show hn|^launch hn|\blaunch(ing|ed)?\b|\bintroducing\b/.test(t)) return "product_launch";
  // Dissatisfaction with an incumbent, which is the hottest thing HN produces:
  // the author has the problem, has tried the alternative, and is saying so in
  // public. Checked before the neutral migration pattern, since "why we left X"
  // matches both and the complaint is the more specific reading.
  if (
    /\bwhy we (left|dropped|ditched|moved off)\b|\bmoving (off|away from)\b|\bditch(ing|ed)\b|\balternatives? to\b|\bfed up with\b|\bsick of\b|\bfrustrat(ed|ing) with\b|\b(is|are) broken\b/.test(
      t,
    )
  )
    return "negative_review";
  if (/\bmigrat(e|ing|ed)\b|\bswitch(ing|ed)? (to|from)\b|\bwe moved to\b/.test(t))
    return "tech_adoption";
  if (/^ask hn|\bhow do you\b|\banyone else\b|\brecommendations?\b|\bhelp\b/.test(t) || !linksOut)
    return "pain_point_post";
  return "media_mention";
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

/**
 * Domains that host other people's writing rather than sell anything.
 *
 * A hit on one of these is press, documentation, or a personal blog post: the
 * company worth prospecting is whoever the article is *about*, which is not
 * something a hostname can tell you. Naming the host instead put publishers on
 * the lead board, which is both useless and embarrassing to send.
 *
 * Suffix-matched so subdomains are covered — `eng.company.medium.com` and
 * `gist.github.com` are the same case as their parents.
 */
function isPublisher(domain: string): boolean {
  return PUBLISHER_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

const PUBLISHER_DOMAINS = [
  // Code and content hosts
  "github.com", "gitlab.com", "gist.github.com", "sourceforge.net", "codeberg.org",
  "medium.com", "substack.com", "wordpress.com", "blogspot.com", "ghost.io",
  "dev.to", "hashnode.dev", "notion.site", "wixsite.com", "squarespace.com",
  // Aggregators, forums, and social
  "news.ycombinator.com", "reddit.com", "x.com", "twitter.com", "youtube.com",
  "youtu.be", "linkedin.com", "facebook.com", "lobste.rs", "stackoverflow.com",
  "quora.com", "producthunt.com", "archive.org", "web.archive.org",
  // Press and trade
  "nytimes.com", "wsj.com", "ft.com", "bloomberg.com", "reuters.com", "bbc.co.uk",
  "bbc.com", "theguardian.com", "washingtonpost.com", "cnbc.com", "forbes.com",
  "businessinsider.com", "techcrunch.com", "theverge.com", "wired.com", "arstechnica.com",
  "venturebeat.com", "zdnet.com", "engadget.com", "theinformation.com", "axios.com",
  "economist.com", "vice.com", "cnn.com", "npr.org", "apnews.com",
  // Reference and preprints
  "wikipedia.org", "arxiv.org", "doi.org", "acm.org", "ieee.org", "nature.com",
  "sciencedirect.com", "papers.ssrn.com", "biorxiv.org",
];
