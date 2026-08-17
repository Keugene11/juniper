"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Play, Loader2, AlertCircle } from "lucide-react";
import type { RunStats } from "@/lib/pipeline";

export function RunPanel({ ready }: { ready: boolean }) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<RunStats | null>(null);
  const [threshold, setThreshold] = useState(60);
  const [channel, setChannel] = useState<"email" | "linkedin">("email");

  async function run() {
    setRunning(true);
    setError(null);
    setStats(null);
    try {
      const res = await fetch("/api/pipeline/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threshold, channel, maxOutreach: 6 }),
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
    <div className="card p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="flex-1">
          <span className="text-[11px] text-muted">Score threshold</span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
            className="mt-2 w-full accent-black"
          />
          <span className="text-xs text-muted">
            Enrich and write copy at <span className="font-medium text-ink">{threshold}+</span>
          </span>
        </label>

        <label className="sm:w-36">
          <span className="text-[11px] text-muted">Channel</span>
          <select
            value={channel}
            onChange={(e) => setChannel(e.target.value as "email" | "linkedin")}
            className="press mt-1 w-full rounded-lg border border-line px-3 py-2 text-sm"
          >
            <option value="email">Email</option>
            <option value="linkedin">LinkedIn</option>
          </select>
        </label>

        <button
          onClick={run}
          disabled={running || !ready}
          className="press flex items-center justify-center gap-2 rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-paper"
        >
          {running ? <Loader2 size={15} className="spinning" /> : <Play size={15} />}
          {running ? "Running" : "Run pipeline"}
        </button>
      </div>

      {!ready && (
        <p className="mt-3 text-xs text-muted">
          Add your website on the Setup tab first — the pipeline needs an ICP to score against.
        </p>
      )}

      {error && (
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-wash p-3 text-xs leading-relaxed">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {stats && <RunSummary stats={stats} />}
    </div>
  );
}

function RunSummary({ stats }: { stats: RunStats }) {
  const rows: [string, number][] = [
    ["Signals seen", stats.signalsFound],
    ["New", stats.signalsNew],
    ["Qualified", stats.qualified],
    ["Disqualified", stats.disqualified],
    ["Emails found", stats.enriched],
    ["Sequences", stats.sequencesWritten],
  ];

  return (
    <div className="mt-4 border-t border-line pt-3">
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {rows.map(([label, value]) => (
          <div key={label}>
            <div className="text-base font-semibold tabular-nums leading-none">{value}</div>
            <div className="mt-1 text-[10px] leading-tight text-muted">{label}</div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11px] text-muted">
        Finished in {(stats.durationMs / 1000).toFixed(1)}s.
        {stats.truncated &&
          " Stopped early to stay inside the request time budget — run again to continue."}
      </p>

      {stats.providerErrors.length > 0 && (
        <ul className="mt-2 space-y-1 text-[11px] text-muted">
          {stats.providerErrors.map((e) => (
            <li key={e.provider}>
              <span className="font-medium text-ink">{e.provider}</span> failed: {e.error}
            </li>
          ))}
        </ul>
      )}
      {stats.providerWarnings.length > 0 && (
        <ul className="mt-2 space-y-1 text-[11px] text-muted">
          {stats.providerWarnings.map((w, i) => (
            <li key={i}>
              <span className="font-medium text-ink">{w.provider}</span> — {w.warning}
            </li>
          ))}
        </ul>
      )}
      {stats.outreachErrors.length > 0 && (
        <ul className="mt-2 space-y-1 text-[11px] text-muted">
          {stats.outreachErrors.map((e, i) => (
            <li key={i}>
              <span className="font-medium text-ink">{e.company}</span>: {e.error}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
