import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { outboundConfigured, outboundTargetStatus, pushLead } from "./outbound";
import type { LeadView } from "./pipeline";

// The waterfall stops at the first success because it only wants *an* address.
// This fans out instead, because Slack and a CRM are not alternatives to each
// other — so one target failing must never stop the rest, and every target has
// to report its own outcome or a partial push looks like a total one.

const realFetch = globalThis.fetch;
const saved = { ...process.env };
const KEYS = [
  "SLACK_WEBHOOK_URL",
  "JUNIPER_WEBHOOK_URL",
  "JUNIPER_WEBHOOK_SECRET",
  "HUBSPOT_ACCESS_TOKEN",
  "PIPEDRIVE_API_TOKEN",
];

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const clearAll = () => KEYS.forEach((k) => delete process.env[k]);

const lead = {
  id: 1,
  company: "Auralis Software",
  domain: "auralis.dev",
  personName: "Tomás Iglesias",
  personTitle: "Director of Demand Generation",
  fitScore: 30,
  intentScore: 70,
  totalScore: 47,
  rationale: "Marketing leader at a newly funded company.",
  disqualified: false,
  email: "tomas.iglesias@auralis.dev",
  emailSource: "pattern+mx",
  emailConfidence: 55,
  status: "sequenced",
  contactKey: "email:tomas.iglesias@auralis.dev",
  skipReason: null,
  outcome: "none",
  outcomeAt: null,
  pushedAt: null,
  pushResult: [],
  createdAt: new Date().toISOString(),
  signal: {
    kind: "funding_round",
    provider: "simulator",
    headline: "Auralis Software announced new funding",
    evidence: "Earmarked for go-to-market expansion.",
    url: "https://example.com/news",
    detectedAt: new Date().toISOString(),
    occurredAt: new Date().toISOString(),
    freshness: 1,
  },
  messages: [],
} as unknown as LeadView;

test("with nothing configured, pushing is not offered", () => {
  clearAll();
  assert.equal(outboundConfigured(), false);
});

test("one configured target is enough to offer pushing", () => {
  clearAll();
  process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.com/services/x";
  assert.equal(outboundConfigured(), true);
});

test("an unconfigured target reports skipped, and names what it wants", async () => {
  clearAll();
  const outcomes = await pushLead(lead, null);
  assert.ok(outcomes.length >= 4, "every target must report, configured or not");
  for (const o of outcomes) {
    assert.equal(o.ok, false);
    assert.match(o.detail, /skipped/);
  }
  const slack = outcomes.find((o) => o.target === "slack")!;
  assert.match(slack.detail, /SLACK_WEBHOOK_URL/, "the missing variable must be named");
});

test("a failing target does not stop the others", async () => {
  clearAll();
  process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.com/services/x";
  process.env.JUNIPER_WEBHOOK_URL = "https://example.com/hook";

  globalThis.fetch = (async (url: string | URL) => {
    // Slack rejects; the generic webhook accepts. This is the normal case, not
    // an edge case: a missing CRM property fails one target routinely.
    if (String(url).includes("slack")) throw new Error("connect ECONNREFUSED");
    return { ok: true, status: 200, text: async () => "ok", json: async () => ({}) } as unknown as Response;
  }) as typeof fetch;

  const outcomes = await pushLead(lead, null);
  const slack = outcomes.find((o) => o.target === "slack")!;
  const hook = outcomes.find((o) => o.target === "webhook")!;

  assert.equal(slack.ok, false, "slack should have failed");
  assert.equal(hook.ok, true, "the webhook must still have been attempted and succeeded");
});

test("a target that throws is caught rather than failing the run", async () => {
  clearAll();
  process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.com/services/x";
  globalThis.fetch = (async () => {
    throw new Error("boom");
  }) as typeof fetch;

  const outcomes = await pushLead(lead, null);
  const slack = outcomes.find((o) => o.target === "slack")!;
  assert.equal(slack.ok, false);
  assert.match(slack.detail, /boom/, "the reason must reach the lead card");
});

test("an HTTP error from a target is reported, not swallowed as success", async () => {
  clearAll();
  process.env.JUNIPER_WEBHOOK_URL = "https://example.com/hook";
  globalThis.fetch = (async () =>
    ({ ok: false, status: 422, text: async () => "bad property", json: async () => ({}) }) as unknown as Response) as typeof fetch;

  const outcomes = await pushLead(lead, null);
  const hook = outcomes.find((o) => o.target === "webhook")!;
  assert.equal(hook.ok, false);
  assert.match(hook.detail, /422/);
});

test("every target reports exactly once", async () => {
  clearAll();
  const outcomes = await pushLead(lead, null);
  const ids = outcomes.map((o) => o.target);
  assert.equal(new Set(ids).size, ids.length, "a duplicated target would double-count a push");
});

test("target status names every missing variable", () => {
  clearAll();
  for (const t of outboundTargetStatus()) {
    assert.equal(t.available, false);
    assert.ok(t.missing.length > 0, `${t.id} is unavailable but names nothing to set`);
    assert.ok(t.label, `${t.id} has no label`);
  }
});
