import { test } from "node:test";
import assert from "node:assert/strict";
import { decideContacts, type PriorContact } from "./pipeline";
import { contactKey, normaliseSuppression, type Suppression } from "./contacts";
import { totalScoreFor } from "./scoring";
import type { ScoredSignal } from "./scoring";

// The gate is the most consequential logic in the pipeline: it is what stops one
// company firing two signals from becoming two emails to the same inbox. Until
// the decision was split out from its queries, none of it was reachable without
// a database and a run's worth of model calls.

const NOW = Date.parse("2026-08-19T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

let seq = 0;
function candidate(over: {
  company?: string;
  domain?: string | null;
  personName?: string | null;
  totalScore?: number;
}): ScoredSignal {
  seq++;
  const company = over.company ?? `Company ${seq}`;
  return {
    signal: {
      provider: "simulator",
      kind: "hiring_spike",
      company,
      domain: over.domain === undefined ? "acme.com" : over.domain,
      personName: over.personName === undefined ? null : over.personName,
      personTitle: null,
      headline: `${company} is hiring`,
      evidence: "evidence",
      url: null,
      detectedAt: daysAgo(0),
      occurredAt: daysAgo(0),
      dedupeKey: `key-${seq}`,
    },
    fitScore: 70,
    intentScore: 80,
    totalScore: over.totalScore ?? 75,
    freshness: 1,
    disqualified: false,
    rationale: "fits",
  } as unknown as ScoredSignal;
}

const sup = (kind: Suppression["kind"], value: string, reason = ""): Suppression => ({
  id: 1,
  kind,
  value: normaliseSuppression(kind, value),
  reason,
  createdAt: daysAgo(90),
});

const prior = (over: Partial<PriorContact> = {}): PriorContact => ({
  leadId: 7,
  outcome: "none",
  contactedAt: null,
  ...over,
});

/** History keyed the way contactHistory would key it. */
function historyFor(
  identity: { domain?: string | null; personName?: string | null },
  p: PriorContact,
): Map<string, PriorContact> {
  const key = contactKey({
    email: null,
    domain: identity.domain ?? null,
    personName: identity.personName ?? null,
  })!;
  return new Map([[key, p]]);
}

const empty = new Map<string, PriorContact>();

// ------------------------------------------------------------- happy path

test("a clean candidate is allowed", () => {
  const c = candidate({});
  const out = decideContacts([c], [], empty, 30, NOW);
  assert.equal(out.allowed.length, 1);
  assert.equal(out.skipped.length, 0);
});

test("nothing to gate returns an empty result rather than throwing", () => {
  const out = decideContacts([], [], empty, 30, NOW);
  assert.deepEqual(out.allowed, []);
  assert.equal(out.deduped + out.suppressed + out.cooledDown, 0);
});

// ----------------------------------------------------------------- dedupe

test("two company-level signals for one company collapse to one", () => {
  const a = candidate({ company: "Acme", domain: "acme.com", totalScore: 80 });
  const b = candidate({ company: "Acme", domain: "acme.com", totalScore: 60 });

  const out = decideContacts([a, b], [], empty, 30, NOW);
  assert.equal(out.allowed.length, 1, "one company must not produce two sequences");
  assert.equal(out.deduped, 1);
});

test("the strongest reason to reach out is the one that survives", () => {
  const weak = candidate({ company: "Acme", domain: "acme.com", totalScore: 40 });
  const strong = candidate({ company: "Acme", domain: "acme.com", totalScore: 90 });

  // Candidates arrive sorted descending, as scoreSignals produces them.
  const out = decideContacts([strong, weak], [], empty, 30, NOW);
  assert.equal(out.allowed[0].totalScore, 90);
});

test("two different people at one company both get worked", () => {
  const a = candidate({ company: "Acme", domain: "acme.com", personName: "Dana Whitfield" });
  const b = candidate({ company: "Acme", domain: "acme.com", personName: "Sam Okafor" });

  const out = decideContacts([a, b], [], empty, 30, NOW);
  assert.equal(out.allowed.length, 2, "colleagues are separate contacts, not duplicates");
  assert.equal(out.deduped, 0);
});

test("the same person seen twice collapses", () => {
  const a = candidate({ domain: "acme.com", personName: "Dana Whitfield", totalScore: 80 });
  const b = candidate({ domain: "acme.com", personName: "dana whitfield", totalScore: 70 });

  const out = decideContacts([a, b], [], empty, 30, NOW);
  assert.equal(out.allowed.length, 1, "casing must not create a second person");
  assert.equal(out.deduped, 1);
});

test("an unidentifiable lead is let through rather than dropped", () => {
  const a = candidate({ domain: null, personName: null });
  const b = candidate({ domain: null, personName: null });

  const out = decideContacts([a, b], [], empty, 30, NOW);
  assert.equal(out.allowed.length, 2, "no keys means nothing to collide with");
});

// ------------------------------------------------------------ suppression

test("a suppressed domain blocks the lead and says which entry did it", () => {
  const c = candidate({ domain: "acme.com" });
  const out = decideContacts([c], [sup("domain", "acme.com", "existing customer")], empty, 30, NOW);

  assert.equal(out.allowed.length, 0);
  assert.equal(out.suppressed, 1);
  assert.match(out.skipped[0][1], /suppressed/);
  assert.match(out.skipped[0][1], /acme\.com/);
  assert.match(out.skipped[0][1], /existing customer/, "the reason must reach the card");
});

test("a suppressed domain covers subdomains", () => {
  const c = candidate({ domain: "eu.acme.com" });
  const out = decideContacts([c], [sup("domain", "acme.com")], empty, 30, NOW);
  assert.equal(out.suppressed, 1);
});

test("a suppressed person blocks them wherever they work", () => {
  const c = candidate({ domain: "other.com", personName: "Dana Whitfield" });
  const out = decideContacts([c], [sup("person", "dana whitfield")], empty, 30, NOW);
  assert.equal(out.suppressed, 1);
});

test("suppression outranks everything, and does not claim the contact", () => {
  // If a suppressed candidate claimed the key, a later legitimate candidate for
  // a different person at that company would be reported as a duplicate.
  const blocked = candidate({ domain: "acme.com", personName: "Dana Whitfield", totalScore: 90 });
  const fine = candidate({ domain: "acme.com", personName: "Sam Okafor", totalScore: 50 });

  const out = decideContacts([blocked, fine], [sup("person", "dana whitfield")], empty, 30, NOW);
  assert.equal(out.suppressed, 1);
  assert.equal(out.deduped, 0, "a suppressed lead must not shadow a colleague");
  assert.equal(out.allowed.length, 1);
});

// --------------------------------------------------------------- cooldown

test("a contact reached inside the cooldown waits", () => {
  const c = candidate({ domain: "acme.com" });
  const history = historyFor({ domain: "acme.com" }, prior({ contactedAt: daysAgo(10) }));

  const out = decideContacts([c], [], history, 30, NOW);
  assert.equal(out.cooledDown, 1);
  assert.match(out.skipped[0][1], /cooldown/);
  assert.match(out.skipped[0][1], /lead #7/, "the earlier lead must be identified");
});

test("a contact reached before the cooldown expired is allowed again", () => {
  const c = candidate({ domain: "acme.com" });
  const history = historyFor({ domain: "acme.com" }, prior({ contactedAt: daysAgo(45) }));

  const out = decideContacts([c], [], history, 30, NOW);
  assert.equal(out.allowed.length, 1);
  assert.equal(out.cooledDown, 0);
});

test("the cooldown window is configurable", () => {
  const history = historyFor({ domain: "acme.com" }, prior({ contactedAt: daysAgo(45) }));
  assert.equal(decideContacts([candidate({})], [], history, 60, NOW).cooledDown, 1);
  assert.equal(decideContacts([candidate({})], [], history, 30, NOW).allowed.length, 1);
});

test("a prior lead that was never actually contacted starts no cooldown", () => {
  // Scored, then abandoned because the run hit its budget. Nobody was reached,
  // so nothing should be held back.
  const c = candidate({ domain: "acme.com" });
  const history = historyFor({ domain: "acme.com" }, prior({ contactedAt: null }));

  const out = decideContacts([c], [], history, 30, NOW);
  assert.equal(out.allowed.length, 1);
});

// -------------------------------------------------------- terminal outcome

test("a lead marked lost is never re-approached, however old", () => {
  const c = candidate({ domain: "acme.com" });
  const history = historyFor(
    { domain: "acme.com" },
    prior({ outcome: "lost", contactedAt: daysAgo(900) }),
  );

  const out = decideContacts([c], [], history, 30, NOW);
  assert.equal(out.allowed.length, 0);
  assert.equal(out.suppressed, 1, "a terminal outcome is a suppression, not a cooldown");
  assert.equal(out.cooledDown, 0);
  assert.match(out.skipped[0][1], /lost/);
});

test("a booked meeting stops cold outreach permanently", () => {
  const c = candidate({ domain: "acme.com" });
  const history = historyFor(
    { domain: "acme.com" },
    prior({ outcome: "meeting", contactedAt: daysAgo(900) }),
  );

  const out = decideContacts([c], [], history, 30, NOW);
  assert.equal(out.suppressed, 1);
  assert.match(out.skipped[0][1], /meeting/);
});

test("a reply that is not terminal only starts a cooldown", () => {
  const c = candidate({ domain: "acme.com" });
  const recent = historyFor(
    { domain: "acme.com" },
    prior({ outcome: "replied", contactedAt: daysAgo(5) }),
  );
  assert.equal(decideContacts([c], [], recent, 30, NOW).cooledDown, 1);

  const old = historyFor(
    { domain: "acme.com" },
    prior({ outcome: "replied", contactedAt: daysAgo(200) }),
  );
  assert.equal(decideContacts([candidate({})], [], old, 30, NOW).allowed.length, 1);
});

// -------------------------------------------------------------- precedence

test("precedence is suppression, then duplicate, then history", () => {
  // One candidate tripping all three must report the strongest reason, because
  // the reason is what the card shows and what the counters attribute.
  const first = candidate({ domain: "acme.com", totalScore: 90 });
  const second = candidate({ domain: "acme.com", totalScore: 80 });
  const history = historyFor({ domain: "acme.com" }, prior({ contactedAt: daysAgo(1) }));

  const bothBlocked = decideContacts(
    [first, second],
    [sup("domain", "acme.com")],
    history,
    30,
    NOW,
  );
  assert.equal(bothBlocked.suppressed, 2, "suppression must win over cooldown and dedupe");
  assert.equal(bothBlocked.cooledDown, 0);
  assert.equal(bothBlocked.deduped, 0);
});

test("every skipped lead is recorded with a reason, none silently dropped", () => {
  const a = candidate({ domain: "acme.com", totalScore: 90 });
  const b = candidate({ domain: "acme.com", totalScore: 80 });
  const c = candidate({ domain: "blocked.com", totalScore: 70 });

  const out = decideContacts([a, b, c], [sup("domain", "blocked.com")], empty, 30, NOW);
  const accounted = out.allowed.length + out.skipped.length;
  assert.equal(accounted, 3, "a lead that neither ran nor was explained is a bug");
  for (const [key, reason] of out.skipped) {
    assert.ok(key, "a skip must name the signal it belongs to");
    assert.ok(reason.length > 10, "a skip reason must actually explain itself");
  }
});

test("counters sum to the number of skipped leads", () => {
  const a = candidate({ domain: "acme.com", totalScore: 90 });
  const b = candidate({ domain: "acme.com", totalScore: 80 });
  const c = candidate({ domain: "gone.com", totalScore: 70 });
  const history = historyFor({ domain: "gone.com" }, prior({ contactedAt: daysAgo(2) }));

  const out = decideContacts([a, b, c], [], history, 30, NOW);
  assert.equal(out.deduped + out.suppressed + out.cooledDown, out.skipped.length);
});

// ---------------------------------------------------- score recombination

test("carried-forward leads recombine with the original weights", () => {
  // A lead reconsidered later reuses its stored fit and recomputes intent, so
  // the recombination has to match how it was scored the first time.
  assert.equal(totalScoreFor(70, 80), Math.round(70 * 0.6 + 80 * 0.4));
  assert.equal(totalScoreFor(0, 0), 0);
  assert.equal(totalScoreFor(100, 100), 100);
});

test("a decayed intent lowers the recombined total", () => {
  const fresh = totalScoreFor(70, 80);
  const stale = totalScoreFor(70, 8);
  assert.ok(stale < fresh, "a lead that went cold must be able to fall below the threshold");
});

test("fit is clamped so a bad model verdict cannot exceed the scale", () => {
  assert.ok(totalScoreFor(1000, 100) <= 100);
  assert.ok(totalScoreFor(-50, 0) >= 0);
});
