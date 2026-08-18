import { passesGate } from "./relevance";
import {
  describeFetchError,
  type ProviderContext,
  type ProviderOutput,
  type Signal,
  type SignalKind,
  type SignalProvider,
} from "./types";

/**
 * Reddit via the official OAuth Data API — the best public source for the
 * competitor-complaint signal, which is the highest-weighted trigger in the
 * taxonomy (96). People describe what their current vendor cannot do, in their
 * own words, with the thread itself as the evidence to open with.
 *
 * ## Why OAuth and not the .json endpoints
 *
 * `www.reddit.com/robots.txt` is `Disallow: /` for every user-agent, and the
 * unauthenticated `search.json` view answers HTTP 403 from most hosts. That
 * wall governs *crawling the website*. The OAuth Data API is a different,
 * sanctioned door: it answers 401 for bad credentials rather than 403, because
 * it expects you to have registered.
 *
 * ## The licensing constraint — read before enabling
 *
 * The free tier (100 queries/minute per OAuth client) is scoped to
 * **non-commercial use**: personal projects, research, moderator tooling.
 * Commercial use requires Reddit's written approval and a paid agreement, which
 * at the time of writing starts far above what a tool this size can justify.
 *
 * This provider is therefore configuration-gated rather than disabled: adding
 * REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET is a deliberate act by an operator
 * who knows which side of that line they are on. If Juniper is being sold,
 * leave them unset.
 *
 * Register a **script** app at https://www.reddit.com/prefs/apps to get them.
 */

interface RedditPost {
  id: string;
  title: string;
  selftext: string;
  subreddit: string;
  permalink: string;
  url: string;
  author: string;
  created_utc: number;
  num_comments: number;
  score: number;
  is_self: boolean;
  over_18: boolean;
  removed_by_category?: string | null;
}

/** Matches the shortest half-life among the kinds this provider emits. */
const WINDOW = "month";
/**
 * Reddit rate-limits generic user agents hard and asks that clients identify
 * themselves. Override to include your own contact, which is what their
 * platform rules ask for.
 */
const USER_AGENT = process.env.REDDIT_USER_AGENT ?? "juniper/0.1 (signal-based prospecting)";

export const redditProvider: SignalProvider = {
  id: "reddit",
  label: "Reddit",
  description:
    "Official OAuth Data API search over your watch terms. Best source for competitor complaints. Free tier is non-commercial use only.",
  enabled: true,
  requires: ["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET"],
  kinds: ["negative_review", "pain_point_post", "tech_adoption", "product_launch"],

  async fetch(ctx: ProviderContext): Promise<ProviderOutput> {
    const signals: Signal[] = [];
    const warnings: string[] = [];
    const seen = new Set<string>();

    if (ctx.keywords.length === 0) {
      warnings.push("no watch terms on the profile — re-run website analysis on the Setup tab");
      return { signals, warnings };
    }

    let token: string;
    try {
      token = await accessToken();
    } catch (err) {
      // A token failure is the whole provider, not one target, so it is an
      // error rather than a warning — the run summary should say the source
      // produced nothing because it could not authenticate.
      throw new Error(`Reddit authentication failed: ${describeFetchError(err)}`);
    }

    const terms = ctx.keywords.slice(0, 6);
    let rejected = 0;

    for (const keyword of terms) {
      let posts: RedditPost[];
      try {
        const url =
          `https://oauth.reddit.com/search?q=${encodeURIComponent(keyword)}` +
          `&sort=relevance&t=${WINDOW}&type=link&include_over_18=off` +
          `&limit=${Math.min(ctx.limit * 2, 50)}`;
        const res = await fetch(url, {
          headers: {
            authorization: `Bearer ${token}`,
            "user-agent": USER_AGENT,
            accept: "application/json",
          },
          signal: AbortSignal.timeout(12_000),
        });
        if (!res.ok) {
          warnings.push(
            `"${keyword}": search returned HTTP ${res.status}` +
              (res.status === 429 ? " — rate limited, try fewer watch terms" : ""),
          );
          continue;
        }
        const body = (await res.json()) as {
          data?: { children?: { data?: RedditPost }[] };
        };
        posts = (body.data?.children ?? [])
          .map((c) => c.data)
          .filter((p): p is RedditPost => Boolean(p?.id));
      } catch (err) {
        warnings.push(`"${keyword}": ${describeFetchError(err)}`);
        continue;
      }

      for (const post of posts) {
        if (seen.has(post.id)) continue;
        // Removed posts still appear in search with their title intact but no
        // body, which would produce a signal whose evidence cannot be read.
        if (post.over_18 || post.removed_by_category) continue;
        if (post.selftext === "[removed]" || post.selftext === "[deleted]") continue;

        if (!passesGate(keyword, post.title, post.selftext)) {
          rejected++;
          continue;
        }
        seen.add(post.id);

        const kind = classify(post);
        signals.push({
          provider: "reddit",
          kind,
          // Reddit almost never identifies the poster's employer, so the author
          // stands in for the company. These are person-level signals: the
          // opening move is a reply or a DM in the thread, not a cold email —
          // which is also why `domain` is null and enrichment will skip them.
          company: `u/${post.author}`,
          domain: null,
          personName: `u/${post.author}`,
          personTitle: null,
          headline: post.title,
          evidence:
            `Posted to r/${post.subreddit} on ` +
            `${new Date(post.created_utc * 1000).toISOString().slice(0, 10)}, matching your ` +
            `"${keyword}" watch term (${post.score} points, ${post.num_comments} comments). ` +
            (post.selftext ? collapse(post.selftext).slice(0, 280) : post.title),
          url: `https://www.reddit.com${post.permalink}`,
          detectedAt: new Date().toISOString(),
          occurredAt: new Date(post.created_utc * 1000).toISOString(),
          dedupeKey: `reddit:${post.id}`,
        });
      }
    }

    if (signals.length === 0) {
      warnings.push(
        `no relevant threads in the last ${WINDOW} across ${terms.length} watch terms` +
          (rejected ? ` (${rejected} loose keyword matches rejected)` : ""),
      );
    } else {
      if (rejected) warnings.push(`rejected ${rejected} loose keyword matches`);
      warnings.push(
        "Reddit signals carry no company domain, so the email waterfall will skip them — " +
          "reply in the thread or DM the author instead",
      );
    }

    return { signals, warnings };
  },
};

// --------------------------------------------------------------------- auth

let cached: { token: string; expiresAt: number } | null = null;

/**
 * App-only ("userless") bearer token via the client_credentials grant. Reddit
 * issues these for an hour; caching in module scope means one token per warm
 * serverless instance rather than one per run.
 */
async function accessToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const id = process.env.REDDIT_CLIENT_ID;
  const secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) throw new Error("REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET are not set");

  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": USER_AGENT,
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(12_000),
  });

  if (!res.ok) {
    throw new Error(
      res.status === 401
        ? "HTTP 401 — check the client id/secret, and that the app type is 'script'"
        : `HTTP ${res.status}`,
    );
  }

  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error("no access_token in the response");

  // Expire a minute early so a token never dies mid-run.
  cached = {
    token: body.access_token,
    expiresAt: Date.now() + ((body.expires_in ?? 3600) - 60) * 1000,
  };
  return cached.token;
}

// ----------------------------------------------------------------- classify

/**
 * Reddit-specific, not shared with the Hacker News classifier: the vocabulary
 * of complaint differs by venue. HN writes "why we left X"; Reddit writes
 * "anyone else fed up with X" and "X alternatives that don't suck". Forcing one
 * regex set across both mislabels most of each.
 */
function classify(post: RedditPost): SignalKind {
  const t = `${post.title} ${post.selftext}`.toLowerCase();

  if (
    /\balternatives?\s+to\b|\bfed up\b|\bsick of\b|\bfrustrat/.test(t) ||
    /\b(hate|awful|terrible|useless|garbage|nightmare)\b/.test(t) ||
    /\b(is|are|has been)\s+(broken|down|unusable)\b/.test(t) ||
    /\bwhy (we|i) (left|dropped|ditched|cancell?ed)\b/.test(t) ||
    /\bcancel(l?ing|l?ed)? (our|my) subscription\b/.test(t)
  )
    return "negative_review";

  if (/\bmigrat(e|ing|ed)\b|\bswitch(ing|ed) (to|from)\b|\bmoving (to|off)\b/.test(t))
    return "tech_adoption";

  if (/\b(i|we) (just )?(built|launched|shipped|released)\b|\bintroducing\b/.test(t))
    return "product_launch";

  return "pain_point_post";
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
