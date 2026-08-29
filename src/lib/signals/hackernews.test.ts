import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { hackerNewsProvider } from "./hackernews";

// This provider is where the relevance gate earns its keep: Algolia ranks with
// OR semantics, so without the gate a watch term of two common words returns
// pages of unrelated stories, all of which then cost real money to score.

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

let calls: string[] = [];

function stubHits(hits: unknown[], status = 200) {
  calls = [];
  globalThis.fetch = (async (url: string | URL) => {
    calls.push(String(url));
    return { ok: status === 200, status, json: async () => ({ hits }) } as unknown as Response;
  }) as typeof fetch;
}

const hit = (over: Record<string, unknown> = {}) => ({
  objectID: "1",
  title: "Ask HN: best issue tracker for startups?",
  story_text: "We outgrew Jira and want something faster.",
  url: null,
  author: "someone",
  points: 42,
  created_at: hoursAgo(6),
  ...over,
});

const ctx = (keywords: string[]) => ({ watchlist: [], keywords, limit: 12 });

test("a genuine match becomes a signal", async () => {
  stubHits([hit()]);
  const out = await hackerNewsProvider.fetch(ctx(["issue tracker"]));
  assert.equal(out.signals.length, 1);
  assert.equal(out.signals[0].headline, "Ask HN: best issue tracker for startups?");
});

test("an OR-match is rejected and counted", async () => {
  stubHits([
    hit({ objectID: "2", title: "IAM breach at Acme", story_text: "lots of data involved" }),
  ]);
  const out = await hackerNewsProvider.fetch(ctx(["CRM data hygiene"]));
  assert.equal(out.signals.length, 0);
  assert.match(out.warnings.join(" "), /rejected/, "rejections must be reported, not silent");
});

test("a two-letter watch term does not let everything through", async () => {
  // The bug this guards: a term reducing to no content words scored 1 against
  // everything, so a single short term switched the gate off for the source.
  stubHits([
    hit({ objectID: "3", title: "A post about gardening", story_text: "nothing relevant" }),
    hit({ objectID: "4", title: "Chair designs of the 1970s", story_text: "said nothing" }),
  ]);
  const out = await hackerNewsProvider.fetch(ctx(["AI"]));
  assert.equal(out.signals.length, 0, "a short term must not disable the gate");
});

test("a two-letter watch term still matches its own subject", async () => {
  stubHits([hit({ objectID: "5", title: "AI agents in production", story_text: "notes" })]);
  const out = await hackerNewsProvider.fetch(ctx(["AI"]));
  assert.equal(out.signals.length, 1);
});

test("substring collisions are rejected", async () => {
  // "API" used to match "rapid" and "therapist" under substring matching.
  stubHits([
    hit({ objectID: "6", title: "Rapid prototyping with paper", story_text: "a therapist said" }),
  ]);
  const out = await hackerNewsProvider.fetch(ctx(["API"]));
  assert.equal(out.signals.length, 0);
});

test("every signal carries the story's own timestamp", async () => {
  const when = hoursAgo(72);
  stubHits([hit({ created_at: when })]);
  const out = await hackerNewsProvider.fetch(ctx(["issue tracker"]));
  assert.equal(
    out.signals[0].occurredAt,
    when,
    "using detection time would make a six-month-old post look fresh",
  );
});

test("the same story matched by two terms is only ingested once", async () => {
  stubHits([hit({ objectID: "dup" })]);
  const out = await hackerNewsProvider.fetch(ctx(["issue tracker", "tracker startups"]));
  assert.equal(out.signals.length, 1);
  assert.equal(new Set(out.signals.map((s) => s.dedupeKey)).size, 1);
});

test("a linked article and a text post classify differently", async () => {
  stubHits([hit({ objectID: "7", url: "https://acme.com/blog/launch", title: "Acme launches its issue tracker" })]);
  const linked = await hackerNewsProvider.fetch(ctx(["issue tracker"]));

  stubHits([hit({ objectID: "8", url: null, title: "Ask HN: issue tracker recommendations?" })]);
  const text = await hackerNewsProvider.fetch(ctx(["issue tracker"]));

  assert.notEqual(
    linked.signals[0].kind,
    text.signals[0].kind,
    "press coverage and someone describing their own problem are different signals",
  );
});

test("a linked story attributes the company from its domain", async () => {
  stubHits([hit({ objectID: "9", url: "https://www.acme.com/blog/x", title: "Acme issue tracker" })]);
  const out = await hackerNewsProvider.fetch(ctx(["issue tracker"]));
  assert.equal(out.signals[0].domain, "acme.com", "www. must be stripped for the waterfall");
});

test("a text post has no domain, so it skips the waterfall by design", async () => {
  stubHits([hit({ objectID: "10", url: null })]);
  const out = await hackerNewsProvider.fetch(ctx(["issue tracker"]));
  assert.equal(out.signals[0].domain, null);
});

test("no watch terms warns instead of searching for nothing", async () => {
  stubHits([]);
  const out = await hackerNewsProvider.fetch(ctx([]));
  assert.equal(out.signals.length, 0);
  assert.match(out.warnings.join(" "), /watch terms/);
  assert.equal(calls.length, 0, "it must not call Algolia with an empty query");
});

test("the search window is bounded, not unlimited", async () => {
  stubHits([hit()]);
  await hackerNewsProvider.fetch(ctx(["issue tracker"]));
  assert.match(calls[0], /created_at_i>/, "an unbounded search would return ancient stories");
});

test("only the first six terms are searched, to bound cost", async () => {
  stubHits([]);
  await hackerNewsProvider.fetch(ctx(["a1 term", "b2 term", "c3 term", "d4 term", "e5 term", "f6 term", "g7 term", "h8 term"]));
  assert.equal(calls.length, 6);
});

test("an HTTP error on one term does not abandon the rest", async () => {
  calls = [];
  let n = 0;
  globalThis.fetch = (async (url: string | URL) => {
    calls.push(String(url));
    n++;
    if (n === 1) return { ok: false, status: 503, json: async () => ({}) } as unknown as Response;
    return { ok: true, status: 200, json: async () => ({ hits: [hit()] }) } as unknown as Response;
  }) as typeof fetch;

  const out = await hackerNewsProvider.fetch(ctx(["issue tracker", "issue tracker"]));
  assert.match(out.warnings.join(" "), /503/);
  assert.equal(calls.length, 2, "the second term must still be searched");
});

test("a story with no title is skipped rather than producing an empty signal", async () => {
  stubHits([hit({ objectID: "11", title: "" })]);
  const out = await hackerNewsProvider.fetch(ctx(["issue tracker"]));
  assert.equal(out.signals.length, 0);
});

test("a link to a publisher is not a lead", async () => {
  // The host of an article is not the company with the problem. These were the
  // dangerous rejects: unlike a text post, a publisher hands over a
  // plausible-looking domain, so it cleared enrichment and a sequence was
  // written to someone at the New York Times.
  stubHits([
    hit({
      objectID: "90",
      title: "Issue tracker startups are eating Jira",
      url: "https://www.nytimes.com/2026/03/01/tech/issue-tracker.html",
    }),
  ]);
  const out = await hackerNewsProvider.fetch(ctx(["issue tracker"]));
  assert.equal(out.signals.length, 0);
  assert.match(out.warnings.join(" "), /publisher/, "the reason must be reported");
});

test("code and social hosts are publishers too, subdomains included", async () => {
  stubHits([
    hit({ objectID: "91", title: "An issue tracker in Rust", url: "https://gist.github.com/x" }),
    hit({ objectID: "92", title: "An issue tracker demo", url: "https://youtu.be/abc" }),
  ]);
  const out = await hackerNewsProvider.fetch(ctx(["issue tracker"]));
  assert.equal(out.signals.length, 0);
});

test("an ordinary company's own site still becomes a signal", async () => {
  // The filter must not swallow the case it exists to protect.
  stubHits([
    hit({
      objectID: "93",
      title: "Why our issue tracker had to change",
      url: "https://engineering.acmecorp.com/post",
    }),
  ]);
  const out = await hackerNewsProvider.fetch(ctx(["issue tracker"]));
  assert.equal(out.signals.length, 1);
  assert.equal(out.signals[0].domain, "engineering.acmecorp.com");
});
