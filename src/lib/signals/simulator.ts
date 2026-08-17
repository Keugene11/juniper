import type {
  ProviderContext,
  ProviderOutput,
  Signal,
  SignalKind,
  SignalProvider,
} from "./types";

/**
 * Deterministic signal generator. Runs fully offline and is seeded on the day,
 * so re-running ingestion is idempotent (the dedupe keys repeat) while a new
 * day produces a fresh feed.
 *
 * Its job is to cover the person-level signal types that no public API exposes
 * — competitor engagement, job changes — so the scoring, enrichment, and
 * messaging stages can be exercised end to end without a paid data provider.
 */
export const simulatorProvider: SignalProvider = {
  id: "simulator",
  label: "Simulator",
  description:
    "Seeded synthetic signals covering the person-level types (competitor engagement, job changes) that no public API exposes.",
  enabled: true,

  async fetch(ctx: ProviderContext): Promise<ProviderOutput> {
    const day = new Date().toISOString().slice(0, 10);
    const rand = mulberry32(hash(day + ctx.keywords.join(",")));
    const signals: Signal[] = [];
    const count = Math.min(ctx.limit, 12);

    for (let i = 0; i < count; i++) {
      const company = pick(rand, COMPANIES);
      const person = pick(rand, PEOPLE);
      const title = pick(rand, TITLES);
      const kind = pick(rand, KINDS);
      const keyword = ctx.keywords.length ? pick(rand, ctx.keywords) : "your category";

      signals.push({
        provider: "simulator",
        kind,
        company: company.name,
        domain: company.domain,
        personName: person,
        personTitle: title,
        headline: headlineFor(kind, company.name, person, title, keyword),
        evidence: evidenceFor(kind, company.name, person, title, keyword),
        url: `https://${company.domain}`,
        detectedAt: new Date(Date.now() - Math.floor(rand() * 72) * 3_600_000).toISOString(),
        dedupeKey: `sim:${day}:${i}:${company.domain}:${kind}`,
      });
    }

    return {
      signals,
      warnings: ["synthetic data — these companies are not real prospects"],
    };
  },
};

const KINDS: SignalKind[] = [
  "competitor_engagement",
  "job_change",
  "pain_point_post",
  "tech_adoption",
  "funding_round",
  "hiring_spike",
];

const COMPANIES = [
  { name: "Northwind Logistics", domain: "northwind-logistics.com" },
  { name: "Kestrel Health", domain: "kestrelhealth.io" },
  { name: "Brightline Retail", domain: "brightlineretail.com" },
  { name: "Auralis Software", domain: "auralis.dev" },
  { name: "Ferrous Manufacturing", domain: "ferrousmfg.com" },
  { name: "Cadence Financial", domain: "cadencefin.com" },
  { name: "Terrapin Energy", domain: "terrapinenergy.co" },
  { name: "Vellum Media", domain: "vellummedia.com" },
];

const PEOPLE = [
  "Priya Raghunathan",
  "Marcus Oyelaran",
  "Dana Whitfield",
  "Tomás Iglesias",
  "Wen Zhao",
  "Adaeze Nwosu",
  "Jonas Halvorsen",
  "Riley Okonkwo",
];

const TITLES = [
  "VP of Revenue Operations",
  "Head of Growth",
  "Director of Demand Generation",
  "Chief Revenue Officer",
  "Head of Sales Development",
  "VP of Marketing",
];

function headlineFor(
  kind: SignalKind,
  company: string,
  person: string,
  title: string,
  keyword: string,
): string {
  switch (kind) {
    case "competitor_engagement":
      return `${person} (${title}, ${company}) engaged with a competitor's post`;
    case "job_change":
      return `${person} started as ${title} at ${company}`;
    case "pain_point_post":
      return `${person} posted about ${keyword}`;
    case "tech_adoption":
      return `${company} adopted a tool adjacent to ${keyword}`;
    case "funding_round":
      return `${company} announced a new funding round`;
    default:
      return `${company} is scaling its go-to-market team`;
  }
}

function evidenceFor(
  kind: SignalKind,
  company: string,
  person: string,
  title: string,
  keyword: string,
): string {
  switch (kind) {
    case "competitor_engagement":
      return `${person} commented on a competitor's post comparing approaches to ${keyword}, asking how it handles rollout across a distributed team.`;
    case "job_change":
      return `${person} moved into the ${title} seat at ${company} within the last three weeks — a typical window for re-evaluating the existing stack.`;
    case "pain_point_post":
      return `${person} wrote that their team is "spending more time stitching together ${keyword} than actually using it" and asked for recommendations.`;
    case "tech_adoption":
      return `${company} added a tool that sits directly upstream of ${keyword}, which usually signals an active project in this area.`;
    case "funding_round":
      return `${company} announced new funding earmarked for go-to-market expansion, with ${person} named as ${title}.`;
    default:
      return `${company} opened several go-to-market roles this month, with ${person} (${title}) listed as the hiring manager.`;
  }
}

// --- deterministic PRNG -----------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const pick = <T>(rand: () => number, arr: readonly T[]): T =>
  arr[Math.floor(rand() * arr.length) % arr.length];
