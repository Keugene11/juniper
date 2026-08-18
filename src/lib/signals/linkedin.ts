import { ProviderDisabledError, type SignalProvider } from "./types";

/**
 * Deliberately not implemented.
 *
 * LinkedIn is where the commercial tools in this category source most of their
 * signals (post engagement, promotions, connection-graph activity), and it is
 * the single highest-value source for this pipeline. It is left as a stub
 * because collecting it means scraping:
 *
 *   - It violates the LinkedIn User Agreement (§8.2 prohibits automated
 *     scraping, and the automated sending of connection requests / messages).
 *   - Sending sequences from a personal account risks permanent restriction of
 *     that account, which is the user's own professional identity.
 *   - There is no public API that exposes these events; the official Marketing
 *     and Sales Navigator APIs are partner-gated and do not expose post-level
 *     engagement for arbitrary third parties.
 *
 * If you have partner API access, implement `fetch` against that and flip
 * `enabled` to true — the rest of the pipeline needs no changes, because every
 * provider normalises to the same `Signal` shape.
 */
export const linkedInProvider: SignalProvider = {
  id: "linkedin",
  label: "LinkedIn",
  description:
    "Not implemented. Requires scraping (ToS violation, account-restriction risk) or partner API access.",
  enabled: false,
  requires: [],
  kinds: ["competitor_engagement", "job_change", "event_rsvp", "pain_point_post"],

  async fetch(): Promise<never> {
    throw new ProviderDisabledError(
      "The LinkedIn provider is a documented stub. Enable it only with partner API credentials.",
    );
  },
};
