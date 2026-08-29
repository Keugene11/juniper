import { test } from "node:test";
import assert from "node:assert/strict";
import { targetHost, toPositional } from "./db";

// Every call site in the codebase writes `?` placeholders; Postgres wants $1.
// One mistake here silently misbinds parameters across ~50 statements, so the
// awkward cases get pinned down rather than assumed.

test("placeholders are numbered in order", () => {
  assert.equal(
    toPositional("INSERT INTO t (a, b, c) VALUES (?, ?, ?)"),
    "INSERT INTO t (a, b, c) VALUES ($1, $2, $3)",
  );
});

test("a statement with no placeholders is unchanged", () => {
  assert.equal(toPositional("SELECT * FROM profile WHERE id = 1"), "SELECT * FROM profile WHERE id = 1");
});

test("a ? inside a string literal is left alone", () => {
  assert.equal(
    toPositional("SELECT 'why?' AS q WHERE x = ?"),
    "SELECT 'why?' AS q WHERE x = $1",
  );
});

test("escaped quotes do not break string tracking", () => {
  // Postgres escapes a quote by doubling it; toggling twice lands in the same
  // state, so the ? after it must still be numbered.
  assert.equal(
    toPositional("SELECT 'it''s a ? here' AS q WHERE x = ?"),
    "SELECT 'it''s a ? here' AS q WHERE x = $1",
  );
});

test("a ? inside a line comment is left alone", () => {
  const sql = "SELECT ?\n-- is this ? a placeholder\nWHERE y = ?";
  assert.equal(sql.match(/\?/g)?.length, 3);
  const out = toPositional(sql);
  assert.ok(out.includes("$1"));
  assert.ok(out.includes("$2"));
  assert.ok(!out.includes("$3"), "the comment's ? must not consume a parameter slot");
  assert.ok(out.includes("-- is this ? a placeholder"));
});

test("a line comment ends at the newline", () => {
  const out = toPositional("SELECT 1 -- note\nWHERE a = ? AND b = ?");
  assert.ok(out.includes("$1") && out.includes("$2"));
});

test("the real multi-line insert numbers all thirteen columns", () => {
  const sql = `INSERT INTO signals
       (provider, kind, company, domain, person_name, person_title,
        headline, evidence, url, strength, detected_at, occurred_at, dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (dedupe_key) DO NOTHING`;
  const out = toPositional(sql);
  assert.ok(out.includes("$13"), "last column must be $13");
  assert.ok(!out.includes("$14"));
  assert.ok(!out.includes("?"));
});

test("the backfill's quoted prefixes survive translation", () => {
  // This statement is all string literals and no parameters — if the tracker
  // mishandled quotes it would start renumbering inside them.
  const sql = "UPDATE leads SET contact_key = 'email:' || lower(trim(email)) WHERE x = ?";
  assert.equal(
    toPositional(sql),
    "UPDATE leads SET contact_key = 'email:' || lower(trim(email)) WHERE x = $1",
  );
});

test("a ? inside a block comment is left alone", () => {
  // db.ts's own schema carries /* */ comments, so this is a real shape.
  const sql = "SELECT a /* what? */ FROM t WHERE b = ?";
  const out = toPositional(sql);
  assert.ok(out.includes("$1"));
  assert.ok(!out.includes("$2"), "a block comment's ? must not consume a slot");
});

// Rows are tagged with this so a lead board only shows the leads collected for
// the company currently being sold. If it is not stable across the ways the
// same site can be written, a target silently orphans its own rows on the next
// save and the board goes empty for no visible reason.

test("the target key ignores scheme, www, path, and case", () => {
  const expected = "wisprflow.ai";
  for (const input of [
    "https://wisprflow.ai",
    "http://wisprflow.ai",
    "https://www.wisprflow.ai",
    "https://WisprFlow.ai/",
    "https://wisprflow.ai/pricing",
    "wisprflow.ai",
    "www.wisprflow.ai",
    "  WISPRFLOW.AI  ",
  ]) {
    assert.equal(targetHost(input), expected, `${input} produced a different target`);
  }
});

test("different companies get different targets", () => {
  assert.notEqual(targetHost("https://wisprflow.ai"), targetHost("https://ramp.com"));
});

test("a port is part of the identity, since it is a different host", () => {
  assert.equal(targetHost("http://localhost:3000"), "localhost:3000");
});
