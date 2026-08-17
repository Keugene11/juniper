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
  detectedAt: string;
  /** Stable identity so re-running ingestion never duplicates a signal. */
  dedupeKey: string;
}

export type SignalKind =
  | "hiring_spike"
  | "new_role_opened"
  | "funding_round"
  | "job_change"
  | "competitor_engagement"
  | "pain_point_post"
  | "product_launch"
  | "tech_adoption";

/**
 * Intent weight per signal type, 0-100. This is the deterministic half of
 * scoring — how strongly the event itself predicts buying, independent of
 * whether the company matches the ICP.
 */
export const SIGNAL_STRENGTH: Record<SignalKind, number> = {
  competitor_engagement: 95,
  pain_point_post: 90,
  hiring_spike: 80,
  funding_round: 75,
  job_change: 70,
  tech_adoption: 65,
  product_launch: 55,
  new_role_opened: 50,
};

export const SIGNAL_LABEL: Record<SignalKind, string> = {
  competitor_engagement: "Competitor engagement",
  pain_point_post: "Pain point mentioned",
  hiring_spike: "Hiring spike",
  funding_round: "Funding round",
  job_change: "Job change",
  tech_adoption: "Tech adoption",
  product_launch: "Product launch",
  new_role_opened: "New role opened",
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
