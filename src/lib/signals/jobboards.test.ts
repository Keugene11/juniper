import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { greenhouseProvider } from "./greenhouse";
import { leverProvider } from "./lever";
import { ashbyProvider } from "./ashby";

// The three job boards are meant to implement the same rule against three
// different APIs. Anything they disagree about shows up later as the same
// company being classified differently depending on which ATS it happens to
// use — which quietly corrupts per-trigger reply rates on the Activity tab,
// because the two triggers are not measuring the same thing.

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const epochDaysAgo = (n: number) => Date.now() - n * 86_400_000;

function stub(body: unknown, status = 200) {
  globalThis.fetch = (async () =>
    ({ ok: status === 200, status, json: async () => body }) as unknown as Response) as typeof fetch;
}

const target = (handle: string) => ({
  watchlist: [{ provider: "x", handle, label: handle, domain: `${handle}.com` }],
  keywords: [],
  limit: 12,
});

/** Each board's payload shape for n roles opened `age` days ago. */
const payloads = {
  greenhouse: (n: number, age: number) => ({
    jobs: Array.from({ length: n }, (_, i) => ({
      id: i + 1,
      title: `Engineer ${i + 1}`,
      updated_at: daysAgo(age),
      absolute_url: "https://example.com/job",
      location: { name: "Remote" },
    })),
  }),
  lever: (n: number, age: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `job-${i + 1}`,
      text: `Engineer ${i + 1}`,
      createdAt: epochDaysAgo(age),
      hostedUrl: "https://example.com/job",
      categories: { location: "Remote", team: "Eng" },
    })),
  ashby: (n: number, age: number) => ({
    jobs: Array.from({ length: n }, (_, i) => ({
      id: `job-${i + 1}`,
      title: `Engineer ${i + 1}`,
      department: "Eng",
      team: "Core",
      location: "Remote",
      publishedAt: daysAgo(age),
      isListed: true,
      jobUrl: "https://example.com/job",
    })),
  }),
};

const boards = [
  { name: "greenhouse", provider: greenhouseProvider, payload: payloads.greenhouse },
  { name: "lever", provider: leverProvider, payload: payloads.lever },
  { name: "ashby", provider: ashbyProvider, payload: payloads.ashby },
];

// ------------------------------------------------------- shared behaviour

for (const board of boards) {
  test(`${board.name}: roles outside the 45-day window are ignored`, async () => {
    stub(board.payload(8, 200));
    const out = await board.provider.fetch(target("acme"));
    assert.equal(out.signals.length, 0, "stale postings must not produce signals at all");
  });

  test(`${board.name}: every signal carries an event date`, async () => {
    stub(board.payload(3, 5));
    const out = await board.provider.fetch(target("acme"));
    assert.ok(out.signals.length > 0);
    for (const s of out.signals) {
      assert.ok(s.occurredAt, "a null date looks permanently fresh and opts out of decay");
      assert.ok(!Number.isNaN(Date.parse(s.occurredAt!)), `unparseable date: ${s.occurredAt}`);
    }
  });

  test(`${board.name}: an empty watchlist warns rather than failing silently`, async () => {
    stub(board.payload(0, 5));
    const out = await board.provider.fetch({ ...target("acme"), watchlist: [] });
    assert.equal(out.signals.length, 0);
    assert.ok(out.warnings.length > 0, "an empty watchlist must be reported");
  });

  test(`${board.name}: an HTTP error warns and keeps the run alive`, async () => {
    stub({}, 404);
    const out = await board.provider.fetch(target("acme"));
    assert.equal(out.signals.length, 0);
    assert.match(out.warnings.join(" "), /404/);
  });

  test(`${board.name}: a spike decays from its newest role`, async () => {
    // Enough roles to spike on any threshold, with one much fresher.
    const old = board.payload(6, 40) as never;
    const fresh = board.payload(1, 1) as never;
    const merged = Array.isArray(old)
      ? [...(old as unknown[]), ...(fresh as unknown[])]
      : { jobs: [...(old as { jobs: unknown[] }).jobs, ...(fresh as { jobs: unknown[] }).jobs] };
    stub(merged);

    const out = await board.provider.fetch(target("acme"));
    const spike = out.signals.find((s) => s.kind === "hiring_spike");
    assert.ok(spike, "seven recent roles must be a spike on every board");
    const age = (Date.now() - Date.parse(spike!.occurredAt!)) / 86_400_000;
    assert.ok(age < 2, `${board.name} spike dated ${age.toFixed(1)}d old, not from its newest role`);
  });

  test(`${board.name}: dedupe keys are stable per company`, async () => {
    stub(board.payload(6, 10));
    const a = await board.provider.fetch(target("acme"));
    stub(board.payload(6, 11));
    const b = await board.provider.fetch(target("acme"));
    assert.equal(a.signals[0].dedupeKey, b.signals[0].dedupeKey);

    stub(board.payload(6, 10));
    const other = await board.provider.fetch(target("beta"));
    assert.notEqual(a.signals[0].dedupeKey, other.signals[0].dedupeKey);
  });
}

// ------------------------------------------------------------- consistency

test("all three boards agree on what counts as a hiring spike", async () => {
  const verdicts: Record<string, Record<number, string>> = {};

  for (const board of boards) {
    verdicts[board.name] = {};
    for (const n of [3, 4, 5, 6]) {
      stub(board.payload(n, 10));
      const out = await board.provider.fetch(target("acme"));
      verdicts[board.name][n] = out.signals.some((s) => s.kind === "hiring_spike")
        ? "spike"
        : "individual";
    }
  }

  assert.deepEqual(
    verdicts.lever,
    verdicts.greenhouse,
    "lever and greenhouse classify the same number of roles differently",
  );
  assert.deepEqual(
    verdicts.ashby,
    verdicts.greenhouse,
    "ashby and greenhouse classify the same number of roles differently",
  );
});

// ------------------------------------------------------------ ashby-specific

test("ashby ignores unlisted postings", async () => {
  // Drafts and already-closed roles. Counting them would invent a spike out of
  // roles nobody can apply to.
  stub({
    jobs: Array.from({ length: 8 }, (_, i) => ({
      id: `job-${i}`,
      title: `Engineer ${i}`,
      department: "Eng",
      team: "Core",
      location: "Remote",
      publishedAt: daysAgo(5),
      isListed: i < 2, // only two are live
      jobUrl: "https://example.com/job",
    })),
  });

  const out = await ashbyProvider.fetch(target("acme"));
  assert.ok(
    !out.signals.some((s) => s.kind === "hiring_spike"),
    "six unlisted postings must not manufacture a spike",
  );
  assert.equal(out.signals.length, 2);
});
