/**
 * A buying signal is an *event*, not a row in a static list. Every provider
 * normalises whatever it scrapes into this shape so the rest of the pipeline
 * (scoring, enrichment, message generation) never knows where it came from.
 */
export interface Signal {
  provider: string;
  /** Signal taxonomy. `strength` below is derived from this. */
  kind: SignalKind;
  company: string;
  domain: string | null;
  personName: string | null;
  personTitle: string | null;
  /** One-line human summary shown in the feed. */
  headline: string;
  /** The specific quote/fact the outreach message will reference. */
  evidence: string;
  url: string | null;
  /**
   * When *we* saw it. Only ever moves forward, and says nothing about how hot
   * the event is — a job board scraped today can be advertising a role opened
   * eight months ago.
   */
  detectedAt: string;
  /**
   * When the event itself happened, as reported by the source. This is the one
   * that drives intent decay, so providers must map their own timestamp here
   * rather than reusing `detectedAt`. Null only when the source publishes no
   * date at all, in which case scoring falls back to `detectedAt`.
   */
  occurredAt: string | null;
  /** Stable identity so re-running ingestion never duplicates a signal. */
  dedupeKey: string;
}

export type SignalKind =
  | "hiring_spike"
  | "new_role_opened"
  | "funding_round"
  | "job_change"
  | "competitor_engagement"
  | "negative_review"
  | "event_rsvp"
  | "pain_point_post"
  | "product_launch"
  | "media_mention"
  | "tech_adoption";

export const SIGNAL_KINDS: SignalKind[] = [
  "negative_review",
  "competitor_engagement",
  "pain_point_post",
  "event_rsvp",
  "hiring_spike",
  "funding_round",
  "job_change",
  "tech_adoption",
  "product_launch",
  "new_role_opened",
  "media_mention",
];

export function isSignalKind(v: unknown): v is SignalKind {
  return typeof v === "string" && (SIGNAL_KINDS as string[]).includes(v);
}

/**
 * Peak intent weight per signal type, 0-100 — what the event is worth on the
 * day it happens. This is the deterministic half of scoring: how strongly the
 * event predicts buying, independent of whether the company fits the ICP.
 *
 * The ordering is the whole thesis of the category. Someone publicly
 * complaining about the incumbent is worth more than a funding round, because
 * the first is a person with the problem and the second is only a company with
 * budget.
 */
export const SIGNAL_STRENGTH: Record<SignalKind, number> = {
  negative_review: 96,
  competitor_engagement: 95,
  pain_point_post: 90,
  event_rsvp: 85,
  hiring_spike: 80,
  funding_round: 75,
  job_change: 70,
  tech_adoption: 65,
  product_launch: 55,
  new_role_opened: 50,
  media_mention: 40,
};

/**
 * How fast each signal type goes cold, as a half-life in days.
 *
 * A signal is a window, not a fact: a webinar RSVP is worth acting on the same
 * afternoon and worthless in a fortnight, whereas a Series B still funds
 * purchases a quarter later. Without this, a six-month-old forum post outranks
 * a complaint posted this morning purely because the older one used more of the
 * right words — which is how signal-based prospecting quietly degrades back
 * into list-buying.
 */
export const SIGNAL_HALF_LIFE_DAYS: Record<SignalKind, number> = {
  event_rsvp: 2,
  competitor_engagement: 5,
  negative_review: 7,
  pain_point_post: 10,
  media_mention: 14,
  product_launch: 21,
  new_role_opened: 21,
  job_change: 30,
  funding_round: 30,
  hiring_spike: 30,
  tech_adoption: 45,
};

/**
 * Decay never reaches zero. An old signal is a weak reason to reach out, not a
 * disqualification — below this floor the ranking would be pure ICP fit, which
 * throws away the only information the event carried.
 */
const STALE_FLOOR = 0.1;

/** Remaining share of an event's peak strength, 0.1-1. */
export function freshness(kind: SignalKind, occurredAt: string | null, at = Date.now()): number {
  const t = occurredAt ? Date.parse(occurredAt) : NaN;
  // An undated source is treated as current rather than penalised for the
  // source's omission; `detectedAt` is passed here in that case.
  if (Number.isNaN(t)) return 1;
  const ageDays = Math.max(0, (at - t) / 86_400_000);
  const decayed = Math.pow(2, -ageDays / SIGNAL_HALF_LIFE_DAYS[kind]);
  return Math.max(STALE_FLOOR, Math.min(1, decayed));
}

/** Peak strength for the kind, decayed by how long ago the event happened. */
export function intentFor(kind: SignalKind, occurredAt: string | null, at = Date.now()): number {
  return Math.round(SIGNAL_STRENGTH[kind] * freshness(kind, occurredAt, at));
}

/** Plain-language freshness band, for the feed. */
export function freshnessLabel(f: number): "hot" | "warm" | "cooling" | "stale" {
  if (f >= 0.75) return "hot";
  if (f >= 0.4) return "warm";
  if (f >= 0.15) return "cooling";
  return "stale";
}

export const SIGNAL_LABEL: Record<SignalKind, string> = {
  negative_review: "Competitor complaint",
  competitor_engagement: "Competitor engagement",
  pain_point_post: "Pain point mentioned",
  event_rsvp: "Event attendance",
  hiring_spike: "Hiring spike",
  funding_round: "Funding round",
  job_change: "Job change",
  tech_adoption: "Tech stack change",
  product_launch: "Product launch",
  new_role_opened: "New role opened",
  media_mention: "Media mention",
};

export interface WatchTarget {
  provider: string;
  handle: string;
  label: string;
  domain: string | null;
}

export interface ProviderContext {
  /** Already scoped to the receiving provider — see `collectSignals`. */
  watchlist: WatchTarget[];
  /** Keywords derived from the ICP, used by the search-based providers. */
  keywords: string[];
  limit: number;
}

export interface ProviderOutput {
  signals: Signal[];
  /**
   * Per-target problems that did not stop the run — a moved job board, a rate
   * limit, a blocked host. These are surfaced rather than swallowed so an empty
   * feed is never mistaken for "there was nothing to find".
   */
  warnings: string[];
}

export interface SignalProvider {
  id: string;
  label: string;
  description: string;
  /** `false` means the provider is documented but deliberately not implemented. */
  enabled: boolean;
  /**
   * Environment variables this provider cannot run without. An empty list means
   * it needs no account at all.
   *
   * Providers read `process.env` themselves, the same way the enrichment
   * waterfall does; this list exists so the registry can skip an unconfigured
   * provider *and say which key is missing* rather than letting it fail at the
   * first request or quietly disappear from the Setup tab.
   */
  requires: string[];
  /** Signal kinds this provider can actually emit, for the run-config picker. */
  kinds: SignalKind[];
  fetch(ctx: ProviderContext): Promise<ProviderOutput>;
}

/** Turns a thrown fetch error into something worth showing a human. */
export function describeFetchError(err: unknown): string {
  const cause = (err as { cause?: { code?: string } })?.cause?.code;
  if (cause === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || cause === "SELF_SIGNED_CERT_IN_CHAIN")
    return "TLS certificate could not be verified (a proxy is likely intercepting HTTPS) — start Node with --use-system-ca";
  if (cause === "ENOTFOUND" || cause === "EAI_AGAIN") return "DNS lookup failed";
  if (cause === "ECONNREFUSED") return "connection refused";
  if (err instanceof Error && err.name === "TimeoutError") return "request timed out";
  if (err instanceof Error) return err.message;
  return String(err);
}

export class ProviderDisabledError extends Error {}
