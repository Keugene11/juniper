/**
 * Outreach outcomes, in pipeline order.
 *
 * Kept in its own leaf module because the client components that render the
 * control need these values, and importing them from `pipeline.ts` would drag
 * the database client into the browser bundle.
 *
 * `none` means nothing has been recorded. Every lead starts there: Juniper
 * drafts sequences but never sends them, so the send is something a human does
 * elsewhere and reports back — and without that report there is no way to know
 * which triggers actually convert.
 */
export const LEAD_OUTCOMES = ["none", "contacted", "replied", "meeting", "lost"] as const;
export type LeadOutcome = (typeof LEAD_OUTCOMES)[number];

export const OUTCOME_LABEL: Record<LeadOutcome, string> = {
  none: "Not sent",
  contacted: "Contacted",
  replied: "Replied",
  meeting: "Meeting booked",
  lost: "No / lost",
};

export function isLeadOutcome(v: unknown): v is LeadOutcome {
  return typeof v === "string" && (LEAD_OUTCOMES as readonly string[]).includes(v);
}
