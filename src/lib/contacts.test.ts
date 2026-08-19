import { test } from "node:test";
import assert from "node:assert/strict";
import {
  contactKey,
  contactKeys,
  matchSuppression,
  normaliseSuppression,
  type Suppression,
} from "./contacts";

const sup = (kind: Suppression["kind"], value: string): Suppression => ({
  id: 1,
  kind,
  value: normaliseSuppression(kind, value),
  reason: "",
  createdAt: "2026-01-01T00:00:00.000Z",
});

// ------------------------------------------------------------- contactKey

test("email wins over every weaker identifier", () => {
  assert.equal(
    contactKey({ email: "Dana@Acme.com", domain: "acme.com", personName: "Dana Whitfield" }),
    "email:dana@acme.com",
  );
});

test("two people at one company are two contacts", () => {
  const a = contactKey({ email: null, domain: "acme.com", personName: "Dana Whitfield" });
  const b = contactKey({ email: null, domain: "acme.com", personName: "Sam Okafor" });
  assert.notEqual(a, b);
});

test("company-level signals collapse to one contact", () => {
  const spike = contactKey({ email: null, domain: "acme.com", personName: null });
  const funding = contactKey({ email: null, domain: "www.acme.com", personName: null });
  assert.equal(spike, "company:acme.com");
  assert.equal(spike, funding, "www. must not create a second identity");
});

test("a person with no employer still keys", () => {
  assert.equal(
    contactKey({ email: null, domain: null, personName: "u/tester" }),
    "person::u/tester",
  );
});

test("nothing identifying returns null rather than a bogus key", () => {
  assert.equal(contactKey({ email: null, domain: null, personName: null }), null);
  assert.equal(contactKey({ email: "  ", domain: "", personName: "   " }), null);
});

// ------------------------------------------------------------ contactKeys

test("enrichment arriving late still matches the earlier identity", () => {
  // Stored last week under the person key, seen today with an address.
  const stored = contactKey({ email: null, domain: "acme.com", personName: "Dana Whitfield" });
  const today = contactKeys({
    email: "dana@acme.com",
    domain: "acme.com",
    personName: "Dana Whitfield",
  });
  assert.ok(stored !== null && today.includes(stored), "history lookup would miss the same human");
});

test("keys are ordered strongest first", () => {
  const keys = contactKeys({ email: "d@acme.com", domain: "acme.com", personName: "Dana" });
  assert.equal(keys[0], "email:d@acme.com");
});

// ----------------------------------------------------- normaliseSuppression

test("a pasted URL reduces to its host", () => {
  assert.equal(normaliseSuppression("domain", "https://www.Acme.com/careers"), "acme.com");
  assert.equal(normaliseSuppression("domain", "@acme.com"), "acme.com");
  assert.equal(normaliseSuppression("domain", "  ACME.COM  "), "acme.com");
});

test("emails and names are lowercased and trimmed", () => {
  assert.equal(normaliseSuppression("email", "  Dana@Acme.com "), "dana@acme.com");
  assert.equal(normaliseSuppression("person", " Dana Whitfield "), "dana whitfield");
});

// ------------------------------------------------------- matchSuppression

test("a suppressed domain covers its subdomains", () => {
  const list = [sup("domain", "acme.com")];
  assert.ok(matchSuppression({ email: null, domain: "eu.acme.com", personName: null }, list));
  assert.ok(matchSuppression({ email: null, domain: "www.acme.com", personName: null }, list));
});

test("a suppressed domain covers addresses at that domain", () => {
  const list = [sup("domain", "acme.com")];
  assert.ok(matchSuppression({ email: "dana@acme.com", domain: null, personName: null }, list));
  assert.ok(matchSuppression({ email: "dana@eu.acme.com", domain: null, personName: null }, list));
});

test("a lookalike domain is not suppressed", () => {
  const list = [sup("domain", "acme.com")];
  assert.equal(
    matchSuppression({ email: null, domain: "notacme.com", personName: null }, list),
    null,
  );
  assert.equal(
    matchSuppression({ email: null, domain: "acme.com.evil.co", personName: null }, list),
    null,
  );
});

test("email and person suppressions match exactly, case-insensitively", () => {
  assert.ok(
    matchSuppression({ email: "Dana@Acme.com", domain: null, personName: null }, [
      sup("email", "dana@acme.com"),
    ]),
  );
  assert.ok(
    matchSuppression({ email: null, domain: null, personName: "DANA WHITFIELD" }, [
      sup("person", "Dana Whitfield"),
    ]),
  );
});

test("an empty suppression list suppresses nothing", () => {
  assert.equal(
    matchSuppression({ email: "d@acme.com", domain: "acme.com", personName: "Dana" }, []),
    null,
  );
});
