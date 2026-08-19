"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Play, Loader2, AlertCircle } from "lucide-react";
import type { RunStats } from "@/lib/pipeline";

/**
 * One button, sensible defaults.
 *
 * The full control panel still exists on the Signals tab, where the knobs sit
 * next to the diagnostics that tell you which way to turn them. Here they would
 * be thirteen decisions asked before you have seen a single result, which is
 * the wrong order: run it, look at what came back, *then* tune.
 */
export function RunButton({ ready }: { ready: boolean }) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<RunStats | null>(null);

  async function run() {
    setRunning(true);
    setError(null);
    setStats(null);
    try {
      const res = await fetch("/api/pipeline/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threshold: 60, maxOutreach: 6, channel: "email" }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      setStats(body.stats as RunStats);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div>
      <button
        onClick={run}
        disabled={running || !ready}
        className="press flex items-center justify-center gap-2 btn-primary px-4 py-2.5 text-sm disabled:opacity-40"
      >
        {running ? <Loader2 size={15} className="spinning" /> : <Play size={15} />}
        {running ? "Running" : "Run"}
      </button>

      {running && (
        <p className="mt-2 text-xs leading-relaxed text-muted">
          Pulling sources, scoring against your ICP, then writing copy. Up to a minute.
        </p>
      )}

      {error && (
        <div className="mt-2 flex items-start gap-2 rounded-lg bg-wash p-3 text-xs leading-relaxed">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {stats && (
        <p className="mt-2 text-xs leading-relaxed text-muted">
          {stats.signalsNew} new {stats.signalsNew === 1 ? "signal" : "signals"} ·{" "}
          {stats.qualified} fit your ICP · {stats.sequencesWritten} written.{" "}
          {stats.truncated && "Stopped early to stay inside the time budget — run again to continue. "}
          <Link href="/signals" className="press underline">
            See everything found
          </Link>
        </p>
      )}
    </div>
  );
}
