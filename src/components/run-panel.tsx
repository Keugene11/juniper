"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Play, Loader2, AlertCircle } from "lucide-react";
import type { RunStats } from "@/lib/pipeline";
import { SIGNAL_LABEL, SIGNAL_STRENGTH, type SignalKind } from "@/lib/signals/types";

/**
 * Run configuration. The trigger picker is the important control: narrowing to
 * the two or three event types that actually convert for you is what keeps
 * scoring cheap, and it is the same choice the commercial tools put behind
 * "pick your intent signals".
 */
export function RunPanel({ ready, kinds }: { ready: boolean; kinds: SignalKind[] }) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<RunStats | null>(null);
  const [threshold, setThreshold] = useState(60);
  const [channel, setChannel] = useState<"email" | "linkedin">("email");
  const [selected, setSelected] = useState<SignalKind[]>(kinds);

  const allSelected = selected.length === kinds.length;

  function toggle(kind: SignalKind) {
    setSelected((prev) =>
      prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind],
    );
  }

  async function run() {
    setRunning(true);
    setError(null);
    setStats(null);
    try {
      const res = await fetch("/api/pipeline/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threshold,
          channel,
          maxOutreach: 6,
          // Omitted when everything is on, so the server keeps its own default
          // rather than being pinned to whatever the client happened to know about.
          kinds: allSelected ? undefined : selected,
        }),
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
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-muted">Trigger events to watch</span>
        <button
          onClick={() => setSelected(allSelected ? [] : kinds)}
          className="press text-xs underline"
        >
          {allSelected ? "Clear all" : "Select all"}
        </button>
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {kinds.map((kind) => {
          const on = selected.includes(kind);
          return (
            <button
              key={kind}
              onClick={() => toggle(kind)}
              aria-pressed={on}
              title={`Peak intent weight ${SIGNAL_STRENGTH[kind]}`}
              className={`press rounded-full border px-2.5 py-1 text-xs font-medium ${
                on ? "border-ink bg-ink text-paper" : "border-line text-muted"
              }`}
            >
              {SIGNAL_LABEL[kind]}
            </button>
          );
        })}
      </div>

      <div className="mt-4 flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-end">
        <label className="flex-1">
          <span className="text-xs text-muted">Score threshold</span>
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
          <span className="text-xs text-muted">Channel</span>
          <select
            value={channel}
            onChange={(e) => setChannel(e.target.value as "email" | "linkedin")}
            className="press mt-1 w-full rounded-xl border border-line px-3 py-2 text-sm"
          >
            <option value="email">Email</option>
            <option value="linkedin">LinkedIn</option>
          </select>
        </label>

        <button
          onClick={run}
          disabled={running || !ready || selected.length === 0}
          className="press flex items-center justify-center gap-2 btn-primary px-4 py-2.5 text-sm"
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

      {ready && selected.length === 0 && (
        <p className="mt-3 text-xs text-muted">
          Select at least one trigger event. With none selected there is nothing to collect.
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

const gateTotal = (s: RunStats) => s.deduped + s.suppressed + s.cooledDown;

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
            <div className="mt-1 text-xs leading-tight text-muted">{label}</div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-muted">
        Finished in {(stats.durationMs / 1000).toFixed(1)}s.
        {stats.signalsFiltered > 0 &&
          ` ${stats.signalsFiltered} dropped by the trigger filter before scoring.`}
        {stats.carriedForward > 0 &&
          ` ${stats.carriedForward} lead${stats.carriedForward === 1 ? "" : "s"} carried forward from earlier runs.`}
        {stats.pushed > 0 && ` ${stats.pushed} pushed to outbound destinations.`}
        {stats.truncated &&
          " Stopped early to stay inside the request time budget — run again to continue."}
      </p>

      {/* The gate is invisible when it works, so it reports itself: a run that
          finds twenty signals and writes three sequences should say why. */}
      {gateTotal(stats) > 0 && (
        <p className="mt-2 text-xs leading-relaxed text-muted">
          Contact gate held back{" "}
          {[
            stats.deduped > 0 &&
              `${stats.deduped} duplicate contact${stats.deduped === 1 ? "" : "s"}`,
            stats.cooledDown > 0 && `${stats.cooledDown} inside the cooldown`,
            stats.suppressed > 0 && `${stats.suppressed} suppressed`,
          ]
            .filter(Boolean)
            .join(", ")}
          . Each one is on the Leads tab with the reason.
        </p>
      )}

      {stats.noAddress > 0 && (
        <p className="mt-2 text-xs leading-relaxed text-muted">
          {stats.noAddress} lead{stats.noAddress === 1 ? "" : "s"} cleared the gate but no
          email address could be found, so no copy was written. Company-level triggers
          (hiring spikes, funding) name no person, and the pattern waterfall needs one.
          Switch the channel to LinkedIn, or set HUNTER_API_KEY / APOLLO_API_KEY. They stay
          eligible either way — the next run picks them up.
        </p>
      )}

      {stats.providerErrors.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs text-muted">
          {stats.providerErrors.map((e) => (
            <li key={e.provider}>
              <span className="font-medium text-ink">{e.provider}</span> failed: {e.error}
            </li>
          ))}
        </ul>
      )}
      {stats.providerWarnings.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs text-muted">
          {stats.providerWarnings.map((w, i) => (
            <li key={i}>
              <span className="font-medium text-ink">{w.provider}</span> — {w.warning}
            </li>
          ))}
        </ul>
      )}
      {stats.outreachErrors.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs text-muted">
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
