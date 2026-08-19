"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { LEAD_OUTCOMES, OUTCOME_LABEL, type LeadOutcome } from "@/lib/outcomes";

/**
 * Records what happened after a sequence was sent by hand.
 *
 * This is the only place a human closes the loop, and it is what turns the
 * Activity tab from a list of counters into a measurement of which trigger
 * events actually produce replies.
 */
export function OutcomeControl({
  leadId,
  initial,
}: {
  leadId: number;
  initial: LeadOutcome;
}) {
  const router = useRouter();
  const [outcome, setOutcome] = useState<LeadOutcome>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function set(next: LeadOutcome) {
    // Tapping the current state clears it, so a mis-tap is one tap to undo.
    const value = next === outcome ? "none" : next;
    const previous = outcome;
    setOutcome(value);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/leads/${leadId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ outcome: value }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      router.refresh();
    } catch (err) {
      setOutcome(previous);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted">Outcome</span>
        {busy && <Loader2 size={11} className="spinning text-muted" />}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {LEAD_OUTCOMES.filter((o) => o !== "none").map((o) => (
          <button
            key={o}
            onClick={() => set(o)}
            disabled={busy}
            aria-pressed={outcome === o}
            className={`press rounded-full border px-2.5 py-1 text-xs font-medium ${
              outcome === o ? "border-ink bg-ink text-paper" : "border-line text-muted"
            }`}
          >
            {OUTCOME_LABEL[o]}
          </button>
        ))}
      </div>
      {error && <p className="mt-2 text-xs text-muted">{error}</p>}
    </div>
  );
}
