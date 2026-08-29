import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { collectableKinds, providerStatus, runnableProviders } from "./registry";
import { SIGNAL_KINDS } from "./types";

// The Setup tab is built from this. Its stated contract is that an
// unconfigured source stays visible and names what it wants, because
// "found nothing" and "never ran" are indistinguishable otherwise.

const saved = { ...process.env };
afterEach(() => {
  for (const k of ["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET", "CRUNCHBASE_API_KEY", "UNIPILE_DSN", "UNIPILE_API_KEY", "JUNIPER_ENABLE_SIMULATOR"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const byId = (id: string) => providerStatus().find((p) => p.id === id)!;

test("a credential-gated source stays listed when unconfigured", () => {
  delete process.env.CRUNCHBASE_API_KEY;
  const cb = byId("crunchbase");
  assert.ok(cb, "crunchbase vanished from the list entirely");
  assert.equal(cb.configured, false);
  assert.deepEqual(cb.missing, ["CRUNCHBASE_API_KEY"]);
});

test("an unconfigured source names every variable it needs", () => {
  delete process.env.REDDIT_CLIENT_ID;
  delete process.env.REDDIT_CLIENT_SECRET;
  assert.deepEqual(byId("reddit").missing, ["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET"]);
});

test("a partially configured source still reports the missing half", () => {
  process.env.UNIPILE_DSN = "https://api1.unipile.com:13111";
  delete process.env.UNIPILE_API_KEY;
  const u = byId("unipile");
  assert.equal(u.configured, false);
  assert.deepEqual(u.missing, ["UNIPILE_API_KEY"], "the half that is set must not be re-reported");
});

test("configuring a source makes it runnable", () => {
  delete process.env.CRUNCHBASE_API_KEY;
  assert.ok(!runnableProviders().some((p) => p.id === "crunchbase"));

  process.env.CRUNCHBASE_API_KEY = "test";
  assert.ok(runnableProviders().some((p) => p.id === "crunchbase"));
  assert.equal(byId("crunchbase").configured, true);
  assert.deepEqual(byId("crunchbase").missing, []);
});

test("the free sources need no credentials", () => {
  for (const id of ["greenhouse", "lever", "ashby", "hackernews"]) {
    const p = byId(id);
    assert.equal(p.configured, true, `${id} should need no credentials`);
    assert.deepEqual(p.missing, [], `${id} reported missing secrets`);
  }
});

test("the simulator is off unless explicitly switched on", () => {
  // It invents companies and people. Left runnable by default it was the
  // largest producer in a run, and nothing on the dashboard distinguished
  // "Auralis Software" from a real prospect.
  delete process.env.JUNIPER_ENABLE_SIMULATOR;
  const sim = byId("simulator");
  assert.ok(sim, "it must stay listed, so demo data is visibly available");
  assert.equal(sim.configured, false);
  assert.deepEqual(sim.missing, ["JUNIPER_ENABLE_SIMULATOR"]);
  assert.ok(
    !runnableProviders().some((p) => p.id === "simulator"),
    "a default run must not be able to fabricate companies",
  );

  process.env.JUNIPER_ENABLE_SIMULATOR = "1";
  assert.ok(runnableProviders().some((p) => p.id === "simulator"));
});

test("the linkedin stub is listed but disabled", () => {
  const li = byId("linkedin");
  assert.equal(li.enabled, false, "the refusal must be visible, not hidden");
});

test("the trigger picker only offers kinds a run could actually produce", () => {
  delete process.env.REDDIT_CLIENT_ID;
  delete process.env.REDDIT_CLIENT_SECRET;
  delete process.env.UNIPILE_DSN;
  delete process.env.UNIPILE_API_KEY;

  const kinds = collectableKinds();
  const reachable = new Set(runnableProviders().flatMap((p) => p.kinds));
  for (const k of kinds) {
    assert.ok(reachable.has(k), `${k} is offered but no runnable source produces it`);
  }
  assert.ok(kinds.length > 0);
});

test("the picker is ordered by the taxonomy, strongest intent first", () => {
  const kinds = collectableKinds();
  const order = kinds.map((k) => SIGNAL_KINDS.indexOf(k));
  const sorted = [...order].sort((a, b) => a - b);
  assert.deepEqual(order, sorted, "the picker must not follow provider registration order");
});

test("every listed provider has a label and a description", () => {
  for (const p of providerStatus()) {
    assert.ok(p.label, `${p.id} has no label`);
    assert.ok(p.description, `${p.id} has no description`);
  }
});
