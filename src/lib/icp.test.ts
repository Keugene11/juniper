import { test } from "node:test";
import assert from "node:assert/strict";
import { normaliseUrl } from "./icp";
import { parseKinds } from "./signals/registry";
import { isLeadOutcome, LEAD_OUTCOMES, OUTCOME_LABEL } from "./outcomes";
import { scheduleFor } from "./messaging";

// ------------------------------------------------------------ normaliseUrl

// Whatever someone pastes into the box on the home page arrives here, and the
// result is both stored as the profile and fetched during onboarding.

test("a bare domain gains a scheme", () => {
  assert.equal(normaliseUrl("acme.com"), "https://acme.com");
});

test("paths, queries and fragments are stripped", () => {
  assert.equal(normaliseUrl("https://acme.com/pricing?ref=x#top"), "https://acme.com");
});

test("surrounding whitespace is tolerated", () => {
  assert.equal(normaliseUrl("  acme.com  "), "https://acme.com");
});

test("an existing scheme is preserved, including http", () => {
  assert.equal(normaliseUrl("http://acme.com"), "http://acme.com");
  assert.equal(normaliseUrl("HTTPS://acme.com"), "https://acme.com");
});

test("subdomains and ports are kept", () => {
  assert.equal(normaliseUrl("eu.acme.com"), "https://eu.acme.com");
  assert.equal(normaliseUrl("localhost:3000"), "https://localhost:3000");
});

test("www is preserved, because it is a real host", () => {
  assert.equal(normaliseUrl("www.acme.com"), "https://www.acme.com");
});

test("garbage throws rather than producing a bogus profile", () => {
  // The route catches this and answers 400 — it must not silently succeed.
  assert.throws(() => normaliseUrl("not a url at all"));
  assert.throws(() => normaliseUrl(""));
});

// -------------------------------------------------------------- parseKinds

test("a valid list survives", () => {
  assert.deepEqual(parseKinds(["hiring_spike", "funding_round"]), [
    "hiring_spike",
    "funding_round",
  ]);
});

test("unknown kinds are dropped, known ones kept", () => {
  assert.deepEqual(parseKinds(["hiring_spike", "nonsense"]), ["hiring_spike"]);
});

test("an all-unknown list falls back to every kind rather than collecting nothing", () => {
  // undefined means "no restriction" downstream. Returning [] would silently
  // make a run collect nothing at all.
  assert.equal(parseKinds(["nonsense", "garbage"]), undefined);
  assert.equal(parseKinds([]), undefined);
});

test("non-arrays are rejected", () => {
  assert.equal(parseKinds("hiring_spike"), undefined);
  assert.equal(parseKinds(null), undefined);
  assert.equal(parseKinds(undefined), undefined);
  assert.equal(parseKinds({ kinds: ["hiring_spike"] }), undefined);
});

// ---------------------------------------------------------------- outcomes

test("every outcome has a label", () => {
  for (const o of LEAD_OUTCOMES) {
    assert.ok(OUTCOME_LABEL[o], `${o} has no label`);
  }
});

test("the outcome guard rejects anything else", () => {
  assert.ok(isLeadOutcome("replied"));
  assert.equal(isLeadOutcome("REPLIED"), false, "casing must not sneak through");
  assert.equal(isLeadOutcome(""), false);
  assert.equal(isLeadOutcome(null), false);
  assert.equal(isLeadOutcome(42), false);
});

// -------------------------------------------------------------- scheduling

test("a sequence is spaced across real days", () => {
  const from = new Date("2026-08-19T09:00:00.000Z");
  assert.equal(scheduleFor(0, from).slice(0, 10), "2026-08-19");
  assert.equal(scheduleFor(3, from).slice(0, 10), "2026-08-22");
  assert.equal(scheduleFor(7, from).slice(0, 10), "2026-08-26");
});

test("scheduling crosses a month boundary correctly", () => {
  const from = new Date("2026-08-29T09:00:00.000Z");
  assert.equal(scheduleFor(7, from).slice(0, 10), "2026-09-05");
});

test("scheduling crosses a leap day correctly", () => {
  const from = new Date("2028-02-27T09:00:00.000Z");
  assert.equal(scheduleFor(3, from).slice(0, 10), "2028-03-01");
});
