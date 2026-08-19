import { test } from "node:test";
import assert from "node:assert/strict";
import { passesGate, relevance } from "./relevance";

// The gate exists because Algolia and Reddit both match with OR semantics, so a
// query for "CRM data hygiene" returns anything containing "data". Everything
// below is a case that actually reached scoring before the gate existed.

test("all content words must be present somewhere", () => {
  assert.equal(relevance("CRM data hygiene", "our CRM data hygiene process"), 1);
  assert.ok(relevance("CRM data hygiene", "a post about data") < 1);
});

test("stopwords do not count toward the requirement", () => {
  assert.equal(relevance("the data for your team", "data team"), 1);
});

test("a term of only stopwords matches anything, by design", () => {
  assert.equal(relevance("the and for", "literally anything"), 1);
});

test("an OR-match on one common word is rejected", () => {
  assert.equal(passesGate("CRM data hygiene", "IAM breach at Acme", "lots of data here"), false);
});

test("a body-only match is rejected", () => {
  // Every word present, but none in the title: this is how a long unrelated
  // post accumulates the term's words by chance.
  assert.equal(
    passesGate("issue tracker", "Show HN: my weekend project", "an issue tracker is mentioned here"),
    false,
  );
});

test("a genuine match passes", () => {
  assert.equal(
    passesGate("issue tracker", "Ask HN: best issue tracker for startups?", "we outgrew Jira"),
    true,
  );
});

test("matching is case-insensitive", () => {
  assert.equal(passesGate("Jira migration", "JIRA MIGRATION pain", "migration notes"), true);
});

// --------------------------------------------------------- short acronyms

// The module's own comment says short words are kept because "CRM, API, and MX
// are exactly the words that make a term specific". Three-letter acronyms do
// survive the length filter; two-letter ones do not, and a term made only of
// them collapses to zero content words — which makes the gate pass everything.

test("three-letter acronyms are treated as content words", () => {
  assert.ok(relevance("CRM hygiene", "hygiene tips for teams") < 1, "CRM must be required");
});

test("a two-letter acronym does not disable the gate", () => {
  assert.equal(
    passesGate("AI", "A post about gardening", "nothing relevant at all"),
    false,
    "a short watch term must not make every hit pass",
  );
});

test("a two-letter acronym still matches its own term", () => {
  assert.equal(passesGate("AI", "AI agents in production", "notes"), true);
});

test("MX is required when the term names it", () => {
  assert.equal(passesGate("MX records", "DNS records explained", "no mail here"), false);
  assert.equal(passesGate("MX records", "MX records explained", "mail routing"), true);
});
