import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { greenhouseProvider } from "./greenhouse";

// The spike threshold decides whether a company reads as "growing and has
// budget" or as a handful of unrelated openings, and it is the highest-value
// free signal in the tool. None of it was covered.

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

function stubJobs(jobs: unknown[], status = 200) {
  globalThis.fetch = (async () =>
    ({
      ok: status === 200,
      status,
      json: async () => ({ jobs }),
    }) as unknown as Response) as typeof fetch;
}

const job = (id: number, title: string, ageDays: number) => ({
  id,
  title,
  updated_at: daysAgo(ageDays),
  absolute_url: `https://boards.greenhouse.io/acme/jobs/${id}`,
  location: { name: "Remote" },
});

const ctx = {
  watchlist: [{ provider: "greenhouse", handle: "acme", label: "Acme", domain: "acme.com" }],
  keywords: [],
  limit: 12,
};

test("five recent roles is a spike", async () => {
  stubJobs([1, 2, 3, 4, 5].map((n) => job(n, `Engineer ${n}`, 10)));
  const out = await greenhouseProvider.fetch(ctx);
  assert.equal(out.signals.length, 1);
  assert.equal(out.signals[0].kind, "hiring_spike");
  assert.match(out.signals[0].headline, /opened 5 roles/);
});

test("four recent roles are individual signals, not a spike", async () => {
  stubJobs([1, 2, 3, 4].map((n) => job(n, `Engineer ${n}`, 10)));
  const out = await greenhouseProvider.fetch(ctx);
  assert.equal(out.signals.length, 4);
  assert.ok(out.signals.every((s) => s.kind === "new_role_opened"));
});

test("roles outside the window do not count toward a spike", async () => {
  // Three recent, three ancient. Six total, but not a spike.
  stubJobs([
    ...[1, 2, 3].map((n) => job(n, `Engineer ${n}`, 5)),
    ...[4, 5, 6].map((n) => job(n, `Engineer ${n}`, 200)),
  ]);
  const out = await greenhouseProvider.fetch(ctx);
  assert.equal(out.signals.length, 3, "the stale roles must be excluded entirely");
  assert.ok(out.signals.every((s) => s.kind === "new_role_opened"));
});

test("a spike carries the date of its most recent opening", async () => {
  stubJobs([
    job(1, "Engineer 1", 40),
    job(2, "Engineer 2", 30),
    job(3, "Engineer 3", 2), // freshest
    job(4, "Engineer 4", 20),
    job(5, "Engineer 5", 35),
  ]);
  const out = await greenhouseProvider.fetch(ctx);
  const occurred = Date.parse(out.signals[0].occurredAt!);
  const twoDaysAgo = Date.parse(daysAgo(2));
  assert.ok(
    Math.abs(occurred - twoDaysAgo) < 60_000,
    "a spike must decay from its newest role, not its oldest",
  );
});

test("every signal carries an event date, so decay applies", async () => {
  stubJobs([1, 2, 3].map((n) => job(n, `Engineer ${n}`, 5)));
  const out = await greenhouseProvider.fetch(ctx);
  assert.ok(out.signals.every((s) => s.occurredAt), "a null date looks permanently fresh");
});

test("an empty board produces nothing and no error", async () => {
  stubJobs([]);
  const out = await greenhouseProvider.fetch(ctx);
  assert.equal(out.signals.length, 0);
  assert.equal(out.warnings.length, 0);
});

test("a 404 warns with the handle rather than failing the run", async () => {
  stubJobs([], 404);
  const out = await greenhouseProvider.fetch(ctx);
  assert.equal(out.signals.length, 0);
  assert.match(out.warnings[0], /404/);
  assert.match(out.warnings[0], /check the handle/);
});

test("an empty watchlist says so instead of silently returning nothing", async () => {
  stubJobs([]);
  const out = await greenhouseProvider.fetch({ ...ctx, watchlist: [] });
  assert.equal(out.signals.length, 0);
  assert.match(out.warnings[0], /no watchlisted companies/);
});

test("spike dedupe keys are stable within a month but not across companies", async () => {
  stubJobs([1, 2, 3, 4, 5].map((n) => job(n, `Engineer ${n}`, 10)));
  const a = await greenhouseProvider.fetch(ctx);

  stubJobs([1, 2, 3, 4, 5].map((n) => job(n, `Engineer ${n}`, 11)));
  const again = await greenhouseProvider.fetch(ctx);
  assert.equal(
    a.signals[0].dedupeKey,
    again.signals[0].dedupeKey,
    "the same spike re-ingested in the same month would double-count",
  );

  stubJobs([1, 2, 3, 4, 5].map((n) => job(n, `Engineer ${n}`, 10)));
  const other = await greenhouseProvider.fetch({
    ...ctx,
    watchlist: [{ provider: "greenhouse", handle: "beta", label: "Beta", domain: "beta.com" }],
  });
  assert.notEqual(a.signals[0].dedupeKey, other.signals[0].dedupeKey);
});

test("individual roles are capped by the run limit", async () => {
  // Four roles is under the spike threshold; the limit still applies.
  stubJobs([1, 2, 3, 4].map((n) => job(n, `Engineer ${n}`, 10)));
  const out = await greenhouseProvider.fetch({ ...ctx, limit: 2 });
  assert.equal(out.signals.length, 2);
});
