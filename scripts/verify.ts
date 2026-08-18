/**
 * Exercises every stage that does not require an Anthropic key, against the
 * real upstream services. Run after `node scripts/seed.ts`:
 *
 *   node scripts/verify.ts
 */
import { getProfile, listWatchlist } from "../src/lib/db";
import { enrichEmail, enrichmentProviderStatus } from "../src/lib/enrichment";
import { collectSignals, providerStatus } from "../src/lib/signals/registry";
import { outboundTargetStatus } from "../src/lib/outbound";
import {
  freshness,
  intentFor,
  SIGNAL_HALF_LIFE_DAYS,
  SIGNAL_STRENGTH,
  type SignalKind,
} from "../src/lib/signals/types";
import { scheduleFor } from "../src/lib/messaging";

const line = (s: string) => console.log(s);
const head = (s: string) => console.log(`\n=== ${s} ===`);

const profile = await getProfile();
if (!profile) {
  console.error("No profile. Run `node scripts/seed.ts` first.");
  process.exit(1);
}

head("Providers registered");
for (const p of providerStatus()) {
  const state = !p.enabled ? "off " : p.configured ? "on  " : "keys";
  line(
    `  ${state} ${p.id.padEnd(12)} ${p.label}` +
      (p.enabled && !p.configured ? `  — needs ${p.missing.join(", ")}` : ""),
  );
}

head("Outbound destinations");
for (const t of outboundTargetStatus()) {
  line(`  ${t.available ? "ready  " : "not set"} ${t.id.padEnd(10)} ${t.missing.join(", ")}`);
}

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
  const at = s.occurredAt ?? s.detectedAt;
  line(
    `  [${s.provider}/${s.kind}] peak=${SIGNAL_STRENGTH[s.kind]} ` +
      `now=${intentFor(s.kind, at)} (${Math.round(freshness(s.kind, at) * 100)}% fresh, ` +
      `event ${at.slice(0, 10)})`,
  );
  line(`    ${s.headline}`);
  line(`    ${s.evidence.slice(0, 110)}${s.evidence.length > 110 ? "..." : ""}`);
}

head("Event dating");
// A provider that leaves occurredAt null makes its signals look permanently
// fresh, which quietly disables decay for that whole source.
for (const r of results) {
  const dated = r.signals.filter((s) => s.occurredAt !== null).length;
  if (r.signals.length === 0) continue;
  line(`  ${r.provider.padEnd(12)} ${dated}/${r.signals.length} signals carry an event date`);
}

head("Intent decay curve");
for (const kind of ["event_rsvp", "pain_point_post", "funding_round"] as SignalKind[]) {
  const at = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  const points = [0, 1, 7, 30, 180]
    .map((d) => `${d}d=${intentFor(kind, at(d))}`)
    .join("  ");
  line(`  ${kind.padEnd(18)} half-life ${String(SIGNAL_HALF_LIFE_DAYS[kind]).padStart(2)}d   ${points}`);
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
