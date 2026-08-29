import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { verifyCandidates, type Candidate } from "./discovery";

// Discovery is what stops the watchlist being a hardcoded list, and the
// verification half is where its value is. A proposed handle that no ATS
// answers is worse than nothing: it sits in the watchlist emitting a 404
// warning on every future run while the company it stood for is never watched.
// That is exactly how the old seeded list failed silently.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

let calls: string[] = [];

/**
 * Boards that answer, keyed by URL fragment, mapped to their open-role count.
 * Anything not listed 404s — what a wrongly-guessed handle looks like in life.
 */
function stubBoards(live: Record<string, number>) {
  calls = [];
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    calls.push(u);
    for (const [fragment, count] of Object.entries(live)) {
      if (u.includes(fragment)) {
        const jobs = Array.from({ length: count }, (_, i) => ({ id: i }));
        return {
          ok: true,
          status: 200,
          // Lever returns a bare array; Greenhouse and Ashby wrap it in `jobs`.
          json: async () => (u.includes("lever.co") ? jobs : { jobs }),
        } as unknown as Response;
      }
    }
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  }) as typeof fetch;
}

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  name: "Acme",
  domain: "acme.com",
  handle: "acme",
  why: "matches the stated industry",
  ...over,
});

test("a handle no board recognises is dropped, not stored", async () => {
  stubBoards({ "boards-api.greenhouse.io/v1/boards/realco": 7 });

  const out = await verifyCandidates([
    candidate({ name: "Real Co", domain: "realco.com", handle: "realco" }),
    candidate({ name: "Made Up", domain: "madeup.com", handle: "madeup" }),
  ]);

  assert.deepEqual(
    out.companies.map((c) => c.name),
    ["Real Co"],
    "an unverified handle must never reach the watchlist",
  );
  assert.equal(out.rejected.length, 1);
  assert.equal(out.rejected[0].name, "Made Up");
  assert.match(out.rejected[0].reason, /no Greenhouse, Lever, or Ashby board/);
});

test("the ATS is observed, not taken on the model's word", async () => {
  // The model is never asked which system a company uses, because it has no
  // reliable way to know. All three are probed and whichever answers wins.
  stubBoards({ "api.lever.co/v0/postings/leverco": 3 });

  const out = await verifyCandidates([
    candidate({ name: "Lever Co", domain: "leverco.com", handle: "leverco" }),
  ]);

  assert.equal(out.companies.length, 1);
  assert.equal(out.companies[0].provider, "lever");
  assert.equal(out.companies[0].roleCount, 3);
  assert.ok(
    calls.some((u) => u.includes("greenhouse")) && calls.some((u) => u.includes("ashby")),
    "all three boards must be tried, not just the one that happened to work",
  );
});

test("a board that answers with no open roles is treated as a miss", async () => {
  // It exists, but it cannot produce the hiring signal the watchlist is for,
  // so keeping it would pad the list with entries that never fire.
  stubBoards({ "boards-api.greenhouse.io/v1/boards/quietco": 0 });

  const out = await verifyCandidates([
    candidate({ name: "Quiet Co", domain: "quietco.com", handle: "quietco" }),
  ]);

  assert.equal(out.companies.length, 0);
  assert.equal(out.rejected.length, 1);
});

test("companies are ordered by how much they are hiring", async () => {
  stubBoards({
    "boards-api.greenhouse.io/v1/boards/small": 2,
    "boards-api.greenhouse.io/v1/boards/big": 40,
  });

  const out = await verifyCandidates([
    candidate({ name: "Small", domain: "small.com", handle: "small" }),
    candidate({ name: "Big", domain: "big.com", handle: "big" }),
  ]);

  assert.deepEqual(out.companies.map((c) => c.name), ["Big", "Small"]);
});

test("domains are stored bare, so enrichment can key on them", async () => {
  stubBoards({ "boards-api.greenhouse.io/v1/boards/acme": 5 });

  const out = await verifyCandidates([
    candidate({ domain: "https://WWW.Acme.com/careers" }),
  ]);

  assert.equal(out.companies[0].domain, "acme.com");
});

test("a handle that is not a plausible slug is rejected without a request", async () => {
  // Guards against a proposal like "acme corp (careers page)" being turned into
  // three pointless HTTP calls against a mangled URL.
  stubBoards({});

  const out = await verifyCandidates([candidate({ handle: "not a slug!" })]);

  assert.equal(out.companies.length, 0);
  assert.equal(calls.length, 0, "a malformed handle must not be dialled");
});

test("a board that times out is a miss, not a crash", async () => {
  // One unreachable board must not take the whole discovery run down with it.
  globalThis.fetch = (async () => {
    throw new Error("network unreachable");
  }) as typeof fetch;

  const out = await verifyCandidates([candidate()]);

  assert.equal(out.companies.length, 0);
  assert.equal(out.rejected.length, 1);
});

test("the same handle proposed twice is watched once", async () => {
  // `addWatchlistEntry` is keyed on (provider, handle), so a duplicate would be
  // silently collapsed by the insert and leave the reported counts lying.
  stubBoards({ "boards-api.greenhouse.io/v1/boards/acme": 4 });

  const out = await verifyCandidates([
    candidate({ name: "Acme" }),
    candidate({ name: "Acme Inc", handle: "ACME" }),
  ]);

  assert.equal(out.companies.length, 1);
});
