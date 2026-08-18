"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, Send, X } from "lucide-react";
import type { PushOutcome } from "@/lib/outbound";

/**
 * Manual push to the configured outbound destinations.
 *
 * Deliberately a button rather than something that happens on its own: a push
 * writes into a shared CRM or a team channel, so it is an action a person takes
 * knowingly. Auto-push exists for unattended runs and is off by default.
 */
export function PushControl({
  leadId,
  configured,
  pushedAt,
  initial,
}: {
  leadId: number;
  /** False when no destination has credentials — the button explains instead. */
  configured: boolean;
  pushedAt: string | null;
  initial: PushOutcome[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<PushOutcome[]>(initial);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(Boolean(pushedAt));

  async function push() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/leads/${leadId}/push`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      setOutcomes(body.outcomes as PushOutcome[]);
      setDone(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!configured) {
    return (
      <p className="text-[11px] text-muted">
        No outbound destination configured — add a Slack webhook or a CRM token in{" "}
        <code className="rounded bg-wash px-1">.env</code> to push leads out.
      </p>
    );
  }

  return (
    <div>
      <button
        onClick={push}
        disabled={busy}
        className="press flex items-center gap-2 rounded-lg border border-ink px-3 py-1.5 text-xs font-medium"
      >
        {busy ? <Loader2 size={13} className="spinning" /> : <Send size={13} />}
        {done ? "Push again" : "Push to destinations"}
      </button>

      {/* Every target reports separately: Slack succeeding while HubSpot
          rejects a missing property is the normal case, not an edge one. */}
      {outcomes.length > 0 && (
        <ul className="mt-2 space-y-1">
          {outcomes.map((o) => (
            <li key={o.target} className="flex items-start gap-1.5 text-[11px] text-muted">
              {o.ok ? (
                <Check size={11} className="mt-0.5 shrink-0 text-ink" />
              ) : (
                <X size={11} className="mt-0.5 shrink-0" />
              )}
              <span>
                <span className="font-medium text-ink">{o.target}</span> — {o.detail}
              </span>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="mt-2 text-[11px] text-muted">{error}</p>}
    </div>
  );
}
