import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SIGNAL_HALF_LIFE_DAYS,
  SIGNAL_LABEL,
  SIGNAL_STRENGTH,
  freshness,
  freshnessLabel,
  intentFor,
  isSignalKind,
} from "./types";

const NOW = Date.parse("2026-08-19T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

test("a dated event decays by its own half-life", () => {
  // event_rsvp: peak 85, half-life 2 days.
  assert.equal(intentFor("event_rsvp", daysAgo(0), NOW), 85);
  assert.equal(intentFor("event_rsvp", daysAgo(2), NOW), 43, "one half-life halves it");
});

test("a long half-life survives a quarter", () => {
  // funding_round: peak 75, half-life 30 days. Still worth acting on later.
  assert.ok(intentFor("funding_round", daysAgo(30), NOW) > 30);
  assert.ok(intentFor("funding_round", daysAgo(90), NOW) > 8);
});

test("decay floors rather than reaching zero", () => {
  const ancient = freshness("event_rsvp", daysAgo(3650), NOW);
  assert.equal(ancient, 0.1, "an old signal is a weak reason, not a disqualification");
  assert.ok(intentFor("event_rsvp", daysAgo(3650), NOW) > 0);
});

test("an undated signal is treated as current, not penalised", () => {
  assert.equal(freshness("hiring_spike", null, NOW), 1);
  assert.equal(intentFor("hiring_spike", null, NOW), SIGNAL_STRENGTH.hiring_spike);
});

test("an unparseable date is treated the same as no date", () => {
  assert.equal(freshness("hiring_spike", "not a date", NOW), 1);
});

test("a future date does not exceed peak", () => {
  const tomorrow = new Date(NOW + 86_400_000).toISOString();
  assert.equal(freshness("event_rsvp", tomorrow, NOW), 1);
  assert.equal(intentFor("event_rsvp", tomorrow, NOW), 85);
});

test("a fresher event of the same kind always outranks an older one", () => {
  for (const kind of Object.keys(SIGNAL_STRENGTH) as (keyof typeof SIGNAL_STRENGTH)[]) {
    const fresh = intentFor(kind, daysAgo(1), NOW);
    const old = intentFor(kind, daysAgo(60), NOW);
    assert.ok(fresh >= old, `${kind}: a day-old event scored below a two-month-old one`);
  }
});

test("every signal kind has a strength, a half-life, and a label", () => {
  const kinds = Object.keys(SIGNAL_STRENGTH);
  for (const k of kinds) {
    assert.ok(SIGNAL_HALF_LIFE_DAYS[k as keyof typeof SIGNAL_HALF_LIFE_DAYS] > 0, `${k} half-life`);
    assert.ok(SIGNAL_LABEL[k as keyof typeof SIGNAL_LABEL], `${k} label`);
    assert.ok(isSignalKind(k), `${k} must be recognised by the type guard`);
  }
  assert.equal(kinds.length, Object.keys(SIGNAL_HALF_LIFE_DAYS).length);
});

test("freshness labels cover the whole decay range", () => {
  assert.equal(freshnessLabel(1), "hot");
  assert.equal(freshnessLabel(0.75), "hot");
  assert.equal(freshnessLabel(0.74), "warm");
  assert.equal(freshnessLabel(0.4), "warm");
  assert.equal(freshnessLabel(0.39), "cooling");
  assert.equal(freshnessLabel(0.15), "cooling");
  // The floor is 0.1, so "stale" must be reachable or the label is dead code.
  assert.equal(freshnessLabel(0.1), "stale");
});

test("an unknown kind is rejected by the guard", () => {
  assert.equal(isSignalKind("not_a_kind"), false);
  assert.equal(isSignalKind(undefined), false);
});
