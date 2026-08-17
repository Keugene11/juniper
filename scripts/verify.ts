/**
 * Exercises every stage that does not require an Anthropic key, against the
 * real upstream services. Run after `node scripts/seed.ts`:
 *
 *   node scripts/verify.ts
 */
import { getProfile, listWatchlist } from "../src/lib/db";
import { enrichEmail, enrichmentProviderStatus } from "../src/lib/enrichment";
import { collectSignals, PROVIDERS } from "../src/lib/signals/registry";
import { SIGNAL_STRENGTH } from "../src/lib/signals/types";
import { scheduleFor } from "../src/lib/messaging";

const line = (s: string) => console.log(s);
const head = (s: string) => console.log(`\n=== ${s} ===`);

const profile = await getProfile();
if (!profile) {
  console.error("No profile. Run `node scripts/seed.ts` first.");
  process.exit(1);
}

head("Providers registered");
for (const p of PROVIDERS) line(`  ${p.enabled ? "on " : "off"}  ${p.id.padEnd(12)} ${p.label}`);

head("Signal ingestion (live)");
const watchlist = (await listWatchlist()).map((w) => ({
  provider: w.provider,
  handle: w.handle,
  label: w.label,
  domain: w.domain,
}));
const results = await collectSignals({
  watchlist,
  keywords: profile.icp.watchTerms,
  limit: 6,
});

let total = 0;
for (const r of results) {
  total += r.signals.length;
  line(
    `  ${r.provider.padEnd(12)} ${String(r.signals.length).padStart(3)} signals` +
      (r.error ? `  ERROR: ${r.error}` : ""),
  );
  for (const w of r.warnings) line(`               ! ${w}`);
}
line(`  ${"TOTAL".padEnd(12)} ${String(total).padStart(3)}`);

head("Sample signals");
for (const s of results.flatMap((r) => r.signals).slice(0, 5)) {
  line(`  [${s.provider}/${s.kind}] intent=${SIGNAL_STRENGTH[s.kind]}`);
  line(`    ${s.headline}`);
  line(`    ${s.evidence.slice(0, 110)}${s.evidence.length > 110 ? "..." : ""}`);
}

head("Dedupe determinism");
const second = await collectSignals(
  { watchlist, keywords: profile.icp.watchTerms, limit: 6 },
  ["simulator"],
);
const firstSim = results.find((r) => r.provider === "simulator")?.signals ?? [];
const keysA = new Set(firstSim.map((s) => s.dedupeKey));
const repeated = second[0].signals.filter((s) => keysA.has(s.dedupeKey)).length;
line(`  simulator re-run reproduced ${repeated}/${second[0].signals.length} dedupe keys (want all)`);

head("Email waterfall (live MX lookup)");
for (const p of enrichmentProviderStatus()) {
  line(`  ${p.available ? "ready  " : "no key "} ${p.id}`);
}
for (const probe of [
  { personName: "Dana Whitfield", domain: "github.com" },
  { personName: "Dana Whitfield", domain: "not-a-real-domain-xyz-9182.com" },
  { personName: null, domain: "github.com" },
]) {
  const r = await enrichEmail(probe);
  line(`  ${probe.personName ?? "(no name)"} @ ${probe.domain}`);
  line(`    -> ${r.email ?? "no address"} (${r.source}, ${r.confidence}%)`);
  for (const t of r.trail) line(`       ${t.provider}: ${t.outcome}`);
}

head("Sequence scheduling");
for (const d of [0, 3, 7]) line(`  day ${d} -> ${scheduleFor(d).slice(0, 10)}`);

head("Done");
